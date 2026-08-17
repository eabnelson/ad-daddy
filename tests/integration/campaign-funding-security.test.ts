import assert from "node:assert/strict";
import test from "node:test";

import { CampaignService, MemoryBrandVerificationRepository, MemoryCampaignRepository, type CampaignApproval, type CampaignDraft } from "@ad-daddy/cli/campaign";
import { createDepositHandler } from "../../app/api/v1/payments/deposits/route.ts";
import { OperatorEventEnvelopeService } from "../../lib/auth/operator-event-envelope.ts";
import { FixedWindowRateLimiter } from "../../lib/http/rate-limit.ts";
import { CampaignBudgetService } from "../../lib/marketplace/budget.ts";
import { DepositService } from "../../lib/payments/deposits.ts";
import { InMemoryLedgerRepository, LedgerService } from "../../lib/payments/ledger.ts";
import { TEMPO_MODERATO_ALPHA_USD, TEMPO_MODERATO_CHAIN_ID, type TempoTransferEvent } from "../../lib/payments/tempo-client.ts";

const TREASURY = `0x${"1".repeat(40)}`;
const SENDER = `0x${"2".repeat(40)}`;
const NOW = new Date("2026-08-15T16:00:00.000Z");
const policy = {
  environment: "test" as const, policyVersion: "funding-test/v1",
  chainId: TEMPO_MODERATO_CHAIN_ID, tokenAddress: TEMPO_MODERATO_ALPHA_USD,
  allowlistedChainId: TEMPO_MODERATO_CHAIN_ID, allowlistedTokenAddress: TEMPO_MODERATO_ALPHA_USD,
  productionFundsEnabled: false,
  approvals: { legal: false, custody: false, dataProtection: false, designPartners: false },
};

test("forged operator headers cannot credit deposits and funding requires an exact credited unreorged transfer", async () => {
  const ledger = new LedgerService(new InMemoryLedgerRepository());
  const deposits = new DepositService(ledger, policy, TREASURY);
  const operatorEvents = new OperatorEventEnvelopeService("payment-event-test-secret-that-is-private");
  const brands = verifiedBrands();
  const budgets = new CampaignBudgetService();
  const campaigns = new CampaignService(new MemoryCampaignRepository(), budgets, brands, deposits);
  await campaigns.prepare(draft());

  await assert.rejects(campaigns.fund("campaign_secure", approval(), NOW), /credited, unreorged deposit/i);
  await assert.rejects(campaigns.activate("campaign_secure", approval(), NOW), /credited, unreorged deposit/i);
  await assert.rejects(campaigns.reserveBid("campaign_secure", "unfunded_bid", 100, NOW), /active status is required/i);
  assert.throws(() => budgets.snapshot("campaign_secure"), /unknown campaign budget/i);

  const handler = createDepositHandler({
    deposits, operatorEvents, memoSalt: "funding-route-test-salt",
    policy, rateLimit: new FixedWindowRateLimiter({ limit: 100, windowMs: 60_000, maxRetryAfterSeconds: 60 }),
  } as never, { campaigns } as never);
  const prepared = await handler(request({ action: "prepare", campaignId: "campaign_secure", amountMinor: 10_000, expectedSender: SENDER }, { "x-ad-daddy-verified-account-id": "acct_advertiser" }));
  assert.equal(prepared.status, 201);
  const preparedBody = await prepared.json() as { commitment: { memo: string } };
  const event = transfer(preparedBody.commitment.memo);

  const forged = await handler(request({ action: "observe_finalized_event", event }, { "oai-operator-scope": "payment-events" }));
  assert.equal(forged.status, 403);
  const forgedEnvelope = { event, ...capability("forged-event-proof"), signature: "x".repeat(43) };
  const forgedSignature = await handler(request({ action: "observe_finalized_event", envelope: forgedEnvelope }));
  assert.equal(forgedSignature.status, 403);
  await assert.rejects(campaigns.fund("campaign_secure", approval(), NOW), /credited, unreorged deposit/i);

  const envelope = operatorEvents.sign(event, capability("trusted-finalized-event"));
  const credited = await handler(request({ action: "observe_finalized_event", envelope }));
  assert.equal(credited.status, 200);
  const replay = await handler(request({ action: "observe_finalized_event", envelope }));
  assert.equal(replay.status, 403);
  await assert.rejects(deposits.requireCreditedCampaignDeposit({ campaignId: "campaign_secure", advertiserAccountId: "other_account", amountMinor: 10_000 }), /credited, unreorged deposit/i);
  await assert.rejects(deposits.requireCreditedCampaignDeposit({ campaignId: "campaign_secure", advertiserAccountId: "acct_advertiser", amountMinor: 9_999 }), /credited, unreorged deposit/i);
  await campaigns.fund("campaign_secure", approval(), NOW);
  await campaigns.activate("campaign_secure", approval(), NOW);

  const reorgEnvelope = operatorEvents.sign({ ...event, status: "reorged" }, capability("trusted-reorg-event"));
  const reorged = await handler(request({ action: "observe_finalized_event", envelope: reorgEnvelope }));
  assert.equal(reorged.status, 200);
  await assert.rejects(campaigns.search("campaign_secure", [], NOW), /credited, unreorged deposit/i);
  await assert.rejects(campaigns.reserveBid("campaign_secure", "reorged_bid", 100, NOW), /credited, unreorged deposit/i);
});

test("brand ownership is loaded from a server record bound to the same account and domain", async () => {
  const brands = verifiedBrands();
  brands.verify({ verificationId: "brand_other", accountId: "other_account", verifiedDomain: "other.example", status: "active", verifiedAt: NOW.toISOString() });
  const funding = {
    requireCreditedCampaignDeposit: async () => ({ depositId: "deposit" }),
    withCreditedCampaignDeposit: async <T>(_input: unknown, action: () => Promise<T>) => action(),
  };
  const campaigns = new CampaignService(new MemoryCampaignRepository(), new CampaignBudgetService(), brands, funding);

  await assert.rejects(campaigns.prepare({ ...draft(), brand: { name: "Other", verifiedDomain: "other.example", verificationId: "brand_other" }, destinationUrl: "https://other.example", allowlistedDestinationHosts: ["other.example"] }), /server-verified brand ownership/i);
  await assert.rejects(campaigns.prepare({ ...draft(), brand: { name: "Neon", verifiedDomain: "other.example", verificationId: "brand_neon" }, destinationUrl: "https://other.example", allowlistedDestinationHosts: ["other.example"] }), /server-verified brand ownership/i);
  await assert.rejects(campaigns.prepare({ ...draft(), brand: { name: "Neon", verifiedDomain: "neon.tech", ownershipVerified: true } } as unknown as CampaignDraft), /campaign brand is invalid/i);
  await campaigns.prepare(draft());
  brands.verify({ verificationId: "brand_neon", accountId: "acct_advertiser", verifiedDomain: "neon.tech", status: "revoked", verifiedAt: NOW.toISOString() });
  await campaigns.fund("campaign_secure", approval(), NOW);
  await assert.rejects(campaigns.activate("campaign_secure", approval(), NOW), /server-verified brand ownership/i);
});

function verifiedBrands() {
  const brands = new MemoryBrandVerificationRepository();
  brands.verify({ verificationId: "brand_neon", accountId: "acct_advertiser", verifiedDomain: "neon.tech", status: "active", verifiedAt: NOW.toISOString() });
  return brands;
}

function draft(): CampaignDraft {
  return {
    campaignId: "campaign_secure", accountId: "acct_advertiser", advertiserTermsVersion: "advertiser-terms/1",
    brand: { name: "Neon", verifiedDomain: "neon.tech", verificationId: "brand_neon" }, destinationUrl: "https://neon.tech/ad-daddy",
    allowlistedDestinationHosts: ["neon.tech"], schedule: { startsAt: "2026-08-15T15:00:00.000Z", endsAt: "2026-08-15T18:00:00.000Z" },
    categories: ["database"], regions: ["US Northeast"], hosts: ["codex"], rewardTypes: ["stablecoin"],
    creative: { headline: "Postgres", body: "Create a branch." }, maximumSpendMinor: 10_000, maximumBidMinor: 500,
    dailyCapMinor: 2_000, guaranteedPlacementMinor: 200, conversionTerms: "Verified database creation", perUserFrequencyLimit: 1,
  };
}

function approval(): CampaignApproval {
  return {
    accountId: "acct_advertiser", approvedAt: "2026-08-15T15:59:00.000Z", expiresAt: "2026-08-15T18:00:00.000Z",
    purposes: ["advertiser_verify", "terms_accept", "campaign_fund", "production_activate"], approvedCampaignId: "campaign_secure",
    approvedMaximumSpendMinor: 10_000, approvedDestinationUrl: "https://neon.tech/ad-daddy", approvedConversionTerms: "Verified database creation",
  };
}

function transfer(memo: string): TempoTransferEvent {
  return {
    chainId: TEMPO_MODERATO_CHAIN_ID, tokenAddress: TEMPO_MODERATO_ALPHA_USD, transactionHash: `0x${"a".repeat(64)}`,
    logIndex: 0, blockNumber: 100, from: SENDER, to: TREASURY, amountMinor: 10_000, memo, status: "finalized",
  };
}

function capability(nonce: string) {
  const now = Date.now();
  return { nonce, issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://ad.daddy/api/v1/payments/deposits", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
