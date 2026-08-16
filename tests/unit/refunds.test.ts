import assert from "node:assert/strict";
import test from "node:test";

import { CampaignBudgetService } from "../../lib/marketplace/budget.ts";
import { D1CampaignBudgetService } from "../../lib/marketplace/d1-campaign.ts";
import { InMemoryLedgerRepository, LedgerService } from "../../lib/payments/ledger.ts";
import {
  InMemoryRefundApprovalRepository,
  RefundApprovalRegistry,
  RefundHumanProofStore,
  RefundService,
} from "../../lib/payments/refunds.ts";
import { SyntheticTempoClient, TEMPO_MODERATO_ALPHA_USD, TEMPO_MODERATO_CHAIN_ID } from "../../lib/payments/tempo-client.ts";
import { InMemoryPaymentStateRepository, type DurableRefundRecord, type PaymentStateRepository } from "../../lib/payments/repository.ts";
import { createMigratedD1 } from "../helpers/sqlite-d1.ts";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const ADDRESS = `0x${"3".repeat(40)}`;
const EVIL_ADDRESS = `0x${"4".repeat(40)}`;
const policy = {
  environment: "test" as const, policyVersion: "payments-test/v1", chainId: TEMPO_MODERATO_CHAIN_ID,
  tokenAddress: TEMPO_MODERATO_ALPHA_USD, allowlistedChainId: TEMPO_MODERATO_CHAIN_ID,
  allowlistedTokenAddress: TEMPO_MODERATO_ALPHA_USD, productionFundsEnabled: false,
  approvals: { legal: false, custody: false, dataProtection: false, designPartners: false },
};

test("closed campaign refund debits the live budget once and transfer retries stay idempotent", async () => {
  const budgets = new CampaignBudgetService();
  budgets.open({ campaignId: "campaign_1", fundedMinor: 12_500, dailyCapMinor: 12_500 });
  await budgets.reserve("campaign_1", "reservation_1", 2_000, NOW);
  await budgets.hold("campaign_1", "hold_1", 500);
  assert.equal((await budgets.close("campaign_1")).withdrawableMinor, 10_000);

  const tempo = new SyntheticTempoClient();
  const repository = new InMemoryLedgerRepository();
  const { proofs, approvals, refunds } = setup(budgets, tempo, repository);
  const approvalId = (await approve(proofs, approvals, "proof_1", "nonce_1", { amountMinor: 10_000 })).approvalId;
  const input = refundInput("refund_1", approvalId);
  const prepared = await refunds.prepare(input);
  assert.equal(budgets.snapshot("campaign_1").refundedMinor, 10_000);
  assert.equal(budgets.snapshot("campaign_1").withdrawableMinor, 0);
  assert.deepEqual(await refunds.prepare(input), prepared);
  assert.equal(budgets.snapshot("campaign_1").refundedMinor, 10_000);

  tempo.failNextMemo(prepared.memo);
  assert.equal((await refunds.send("refund_1")).status, "failed");
  assert.equal(repository.transactions.length, 0);
  const paid = await refunds.send("refund_1");
  assert.equal(paid.status, "paid");
  assert.match(paid.transactionHash ?? "", /^0x[a-f0-9]{64}$/);
  assert.equal(repository.transactions.length, 1);
  assert.deepEqual(await refunds.send("refund_1"), paid);
  assert.equal(repository.transactions.length, 1);
  assert.equal(budgets.snapshot("campaign_1").refundedMinor, 10_000);
});

test("two refund ids racing for one closed campaign cannot double debit or transfer", async () => {
  const budgets = new CampaignBudgetService();
  budgets.open({ campaignId: "campaign_1", fundedMinor: 1_000, dailyCapMinor: 1_000 });
  await budgets.close("campaign_1");
  const tempo = new SyntheticTempoClient();
  const repository = new InMemoryLedgerRepository();
  const { proofs, approvals, refunds } = setup(budgets, tempo, repository);
  const first = await approve(proofs, approvals, "proof_a", "nonce_a", { amountMinor: 1_000 });
  const second = await approve(proofs, approvals, "proof_b", "nonce_b", { amountMinor: 1_000 });

  const results = await Promise.allSettled([
    refunds.prepare(refundInput("refund_a", first.approvalId)),
    refunds.prepare(refundInput("refund_b", second.approvalId)),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(budgets.snapshot("campaign_1").refundedMinor, 1_000);
  assert.equal(budgets.snapshot("campaign_1").withdrawableMinor, 0);

  const winner = results.find((result) => result.status === "fulfilled");
  assert.ok(winner);
  assert.equal(winner.status, "fulfilled");
  await refunds.send(winner.value.refundId);
  assert.equal(repository.transactions.length, 1);
});

test("refund approvals reject forgery, proof replay, approval replay, and target mutation", async () => {
  const budgets = new CampaignBudgetService();
  budgets.open({ campaignId: "campaign_1", fundedMinor: 1_000, dailyCapMinor: 1_000 });
  await budgets.close("campaign_1");
  const { proofs, approvals, refunds } = setup(budgets);

  await assert.rejects(refunds.prepare(refundInput("forged", "caller-authored-approval")), /server-issued/i);

  await recordProof(proofs, "proof_1", "nonce_1");
  const approval = await approvals.issue({
    proofId: "proof_1", accountId: "advertiser_1", campaignId: "campaign_1",
    refundAddress: ADDRESS, amountMinor: 1_000, expiresAt: plus(30_000),
  }, NOW);
  await assert.rejects(approvals.issue({
    proofId: "proof_1", accountId: "advertiser_1", campaignId: "campaign_1",
    refundAddress: ADDRESS, amountMinor: 1_000, expiresAt: plus(30_000),
  }, NOW), /proof/i);
  await assert.rejects(recordProof(proofs, "proof_2", "nonce_1"), /replay/i);

  const mutated = {
    ...refundInput("refund_1", approval.approvalId),
    refundAddress: EVIL_ADDRESS,
    amountMinor: 1,
  };
  const prepared = await refunds.prepare(mutated);
  assert.equal(prepared.address, ADDRESS);
  assert.equal(prepared.amountMinor, 1_000);
  await assert.rejects(approvals.consume(approval.approvalId, {
    accountId: "advertiser_1", campaignId: "campaign_1", refundId: "refund_2",
  }, NOW), /replay/i);
});

test("approval bindings reject changed account, campaign, amount, and address", async () => {
  const budgets = new CampaignBudgetService();
  budgets.open({ campaignId: "campaign_1", fundedMinor: 1_000, dailyCapMinor: 1_000 });
  await budgets.close("campaign_1");
  const { proofs, approvals, refunds } = setup(budgets);
  const wrongAmount = await approve(proofs, approvals, "proof_amount", "nonce_amount", { amountMinor: 999 });
  await assert.rejects(refunds.prepare(refundInput("refund_amount", wrongAmount.approvalId)), /withdrawable/i);

  const wrongAddress = await approve(proofs, approvals, "proof_address", "nonce_address", { refundAddress: EVIL_ADDRESS });
  await assert.rejects(refunds.prepare({ ...refundInput("refund_address", wrongAddress.approvalId), accountId: "attacker" }), /server-issued/i);

  const otherCampaign = await approve(proofs, approvals, "proof_campaign", "nonce_campaign", { campaignId: "other_campaign" });
  await assert.rejects(refunds.prepare(refundInput("refund_campaign", otherCampaign.approvalId)), /server-issued/i);
});

test("proof and approval replay protection survives service reconstruction", async () => {
  const repository = new InMemoryRefundApprovalRepository();
  const firstProofs = new RefundHumanProofStore(repository);
  const firstApprovals = new RefundApprovalRegistry(firstProofs);
  await recordProof(firstProofs, "proof_restart", "nonce_restart");
  const approval = await firstApprovals.issue({
    proofId: "proof_restart", accountId: "advertiser_1", campaignId: "campaign_1",
    refundAddress: ADDRESS, amountMinor: 1_000, expiresAt: plus(30_000),
  }, NOW);
  await firstApprovals.consume(approval.approvalId, {
    accountId: "advertiser_1", campaignId: "campaign_1", refundId: "refund_1",
  }, NOW);

  const reconstructedProofs = new RefundHumanProofStore(repository);
  const reconstructedApprovals = new RefundApprovalRegistry(reconstructedProofs);
  await assert.rejects(recordProof(reconstructedProofs, "proof_restart_2", "nonce_restart"), /replay/i);
  await assert.rejects(reconstructedApprovals.consume(approval.approvalId, {
    accountId: "advertiser_1", campaignId: "campaign_1", refundId: "refund_2",
  }, NOW), /replay/i);
  assert.equal((await reconstructedApprovals.consume(approval.approvalId, {
    accountId: "advertiser_1", campaignId: "campaign_1", refundId: "refund_1",
  }, NOW)).consumedByRefundId, "refund_1");
});

test("pending and paid refunds reconcile once after a cold start", async () => {
  const budgets = new CampaignBudgetService();
  budgets.open({ campaignId: "campaign_1", fundedMinor: 1_000, dailyCapMinor: 1_000 });
  await budgets.close("campaign_1");
  const approvalRepository = new InMemoryRefundApprovalRepository();
  const state = new InMemoryPaymentStateRepository();
  const ledgerRepository = new InMemoryLedgerRepository();
  const tempo = new SyntheticTempoClient();
  const proofs = new RefundHumanProofStore(approvalRepository);
  const approvals = new RefundApprovalRegistry(proofs);
  const first = new RefundService({
    tempo, ledger: new LedgerService(ledgerRepository), policy, tokenAddress: TEMPO_MODERATO_ALPHA_USD,
    memoSalt: "stable-secret-backed-refund-salt", budgets, approvals, repository: state,
  });
  const approval = await approve(proofs, approvals, "proof_cold", "nonce_cold");
  const pending = await first.prepare(refundInput("refund_cold", approval.approvalId));

  const restartedProofs = new RefundHumanProofStore(approvalRepository);
  const restarted = new RefundService({
    tempo, ledger: new LedgerService(ledgerRepository), policy, tokenAddress: TEMPO_MODERATO_ALPHA_USD,
    memoSalt: "stable-secret-backed-refund-salt", budgets,
    approvals: new RefundApprovalRegistry(restartedProofs), repository: state,
  });
  assert.equal((await restarted.prepare(refundInput("refund_cold", approval.approvalId))).memo, pending.memo);
  assert.equal((await restarted.send("refund_cold")).status, "paid");
  assert.equal((await first.send("refund_cold")).status, "paid");
  assert.equal(ledgerRepository.transactions.length, 1);
});

test("a D1 refund withdrawal recovers after refund-record persistence fails", async (t) => {
  const migrated = createMigratedD1();
  t.after(migrated.close);
  await migrated.database.prepare("INSERT INTO human_accounts (id, status) VALUES ('advertiser_1', 'active')").run();
  await migrated.database.prepare(`INSERT INTO advertiser_brands
    (id, account_id, name, verified_domain, ownership_status, verified_at)
    VALUES ('brand_refund', 'advertiser_1', 'Refund test', 'example.com', 'verified', ?)`)
    .bind(NOW.toISOString()).run();
  await migrated.database.prepare(`INSERT INTO campaigns
    (id, account_id, brand_id, status, advertiser_terms_version, destination_url,
     schedule_starts_at, schedule_ends_at, audience_json, offer_json, creative_json,
     conversion_terms, maximum_spend_minor, maximum_bid_minor, daily_cap_minor,
     funded_minor, spent_minor, refunded_minor, closed_at, created_at, updated_at)
    VALUES ('campaign_1', 'advertiser_1', 'brand_refund', 'closed', 'advertiser-terms/1', 'https://example.com', ?, ?,
      '{}', '{}', '{}', 'signup', 1000, 1000, 1000, 1000, 0, 0, ?, ?, ?)`)
    .bind(NOW.toISOString(), plus(60_000), NOW.toISOString(), NOW.toISOString(), NOW.toISOString()).run();
  const budgets = new D1CampaignBudgetService(migrated.database);
  const approvalRepository = new InMemoryRefundApprovalRepository();
  const proofs = new RefundHumanProofStore(approvalRepository);
  const approvals = new RefundApprovalRegistry(proofs);
  const approval = await approve(proofs, approvals, "proof_durable", "nonce_durable");
  const state = new FailFirstRefundPutRepository();
  const serviceInput = {
    tempo: new SyntheticTempoClient(), ledger: new LedgerService(new InMemoryLedgerRepository()), policy,
    tokenAddress: TEMPO_MODERATO_ALPHA_USD, memoSalt: "durable-refund-test-salt", budgets, approvals, repository: state,
  };

  await assert.rejects(new RefundService(serviceInput).prepare(refundInput("refund_durable", approval.approvalId)), /injected refund record outage/);
  assert.equal((await budgets.snapshot("campaign_1")).refundedMinor, 1_000);
  const recovered = await new RefundService(serviceInput).prepare({
    ...refundInput("refund_durable", approval.approvalId),
    now: new Date(NOW.getTime() + 31_000),
  });
  assert.equal(recovered.status, "pending");
  assert.equal((await budgets.snapshot("campaign_1")).refundedMinor, 1_000);
});

class FailFirstRefundPutRepository implements PaymentStateRepository {
  readonly #delegate = new InMemoryPaymentStateRepository();
  #fail = true;
  getDepositCommitment = this.#delegate.getDepositCommitment.bind(this.#delegate);
  putDepositCommitment = this.#delegate.putDepositCommitment.bind(this.#delegate);
  getDepositRecord = this.#delegate.getDepositRecord.bind(this.#delegate);
  getDepositRecordByMemo = this.#delegate.getDepositRecordByMemo.bind(this.#delegate);
  findCreditedCampaignDeposit = this.#delegate.findCreditedCampaignDeposit.bind(this.#delegate);
  putDepositRecord = this.#delegate.putDepositRecord.bind(this.#delegate);
  listPayoutDestinations = this.#delegate.listPayoutDestinations.bind(this.#delegate);
  putPayoutDestination = this.#delegate.putPayoutDestination.bind(this.#delegate);
  getPayout = this.#delegate.getPayout.bind(this.#delegate);
  putPayout = this.#delegate.putPayout.bind(this.#delegate);
  payoutTotalForPeriod = this.#delegate.payoutTotalForPeriod.bind(this.#delegate);
  getRefund = this.#delegate.getRefund.bind(this.#delegate);
  getRefundByCampaign = this.#delegate.getRefundByCampaign.bind(this.#delegate);
  async putRefund(value: DurableRefundRecord) {
    if (this.#fail) { this.#fail = false; throw new Error("injected refund record outage"); }
    return this.#delegate.putRefund(value);
  }
}

function setup(
  budgets: CampaignBudgetService,
  tempo = new SyntheticTempoClient(),
  repository = new InMemoryLedgerRepository(),
) {
  const proofs = new RefundHumanProofStore();
  const approvals = new RefundApprovalRegistry(proofs);
  const refunds = new RefundService({
    tempo, ledger: new LedgerService(repository), policy,
    tokenAddress: TEMPO_MODERATO_ALPHA_USD, memoSalt: "refund-test-salt",
    budgets, approvals,
  });
  return { proofs, approvals, refunds };
}

async function approve(
  proofs: RefundHumanProofStore,
  approvals: RefundApprovalRegistry,
  proofId: string,
  nonce: string,
  overrides: Partial<{ campaignId: string; refundAddress: string; amountMinor: number }> = {},
) {
  await recordProof(proofs, proofId, nonce);
  return approvals.issue({
    proofId, accountId: "advertiser_1", campaignId: overrides.campaignId ?? "campaign_1",
    refundAddress: overrides.refundAddress ?? ADDRESS, amountMinor: overrides.amountMinor ?? 1_000,
    expiresAt: plus(30_000),
  }, NOW);
}

function recordProof(proofs: RefundHumanProofStore, proofId: string, nonce: string) {
  return proofs.recordVerifiedProof({
    proofId, accountId: "advertiser_1", nonce, method: "passkey_and_wallet_signature",
    verifiedAt: NOW.toISOString(), expiresAt: plus(60_000),
  }, NOW);
}

function refundInput(refundId: string, approvalId: string) {
  return {
    refundId, approvalId, accountId: "advertiser_1", campaignId: "campaign_1",
    advertiserLedgerAccountId: "ledger_adv", treasuryLedgerAccountId: "ledger_treasury", now: NOW,
  };
}

function plus(milliseconds: number) { return new Date(NOW.getTime() + milliseconds).toISOString(); }
