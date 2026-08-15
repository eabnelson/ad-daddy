import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { CampaignService, MemoryBrandVerificationRepository, MemoryCampaignRepository, ADVERTISER_TERMS_VERSION, type CampaignApproval, type CampaignDraft } from "@ad-daddy/cli/campaign";
import { buildPublishedProfile } from "@ad-daddy/cli";
import { createPlacementHistoryHandler } from "../../app/api/v1/placements/route.ts";
import { createCampaignReportAuthority, createReportHandler } from "../../app/api/v1/reports/route.ts";
import { CredentialLifecycleService } from "../../lib/auth/credential-lifecycle.ts";
import { AttributionService, ConversionEvidenceVerifier } from "../../lib/marketplace/attribution.ts";
import { AuctionService } from "../../lib/marketplace/auction.ts";
import { CampaignBudgetService } from "../../lib/marketplace/budget.ts";
import { MemoryPlacementDeliveryRepository, PlacementDeliveryService } from "../../lib/marketplace/placement-delivery.ts";
import { MarketplaceSigningKeys, enrollMarketplacePublicKey, signPlacement } from "../../lib/marketplace/signing-keys.ts";
import { LifecycleEventStore } from "../../lib/observability/events.ts";
import { InMemoryLedgerRepository, LedgerService } from "../../lib/payments/ledger.ts";
import { RewardVelocityGuard, SettlementService } from "../../lib/payments/settlement.ts";
import type { CodexAppServerConnection, CodexDeliveryReceipt, PlacementPayload } from "../../packages/host-adapters/src/index.ts";

const NOW = new Date("2026-08-15T12:00:00.000Z");

test("seeded receiver and advertiser agents clear an auction, create one sponsored task, and settle base plus conversion", async () => {
  const published = buildPublishedProfile({
    values: {
      coarseLocation: "US Northeast", privateRepoTechStacks: [["TypeScript", "Postgres"]],
      acceptedRewardTypes: ["stablecoin", "credits"], minimumTakeHomeMinor: 500,
      projectDescriptions: ["Building an agent-native deployment tool"],
    },
    enabled: { coarseLocation: true, privateRepoTechStacks: true, acceptedRewardTypes: true, minimumTakeHomeMinor: true, projectDescriptions: true },
  });
  assert.deepEqual(Object.keys(published).sort(), ["acceptedRewardTypes", "coarseLocation", "minimumTakeHomeMinor", "privateRepoTechStacks", "projectDescriptions"]);

  const budgets = new CampaignBudgetService();
  const brands = new MemoryBrandVerificationRepository();
  brands.verify({ verificationId: "brand_neon", accountId: "advertiser_1", verifiedDomain: "neon.tech", status: "active", verifiedAt: NOW.toISOString() });
  const campaigns = new CampaignService(new MemoryCampaignRepository(), budgets, brands, {
    requireCreditedCampaignDeposit: async () => ({ depositId: "deposit_demo" }),
    withCreditedCampaignDeposit: async <T>(_input: unknown, action: () => Promise<T>) => action(),
  });
  const draft = campaignDraft();
  await campaigns.prepare(draft);
  await campaigns.fund(draft.campaignId, approval(["advertiser_verify", "terms_accept", "campaign_fund"]), NOW);
  await campaigns.activate(draft.campaignId, approval(["advertiser_verify", "terms_accept", "campaign_fund", "production_activate"]), NOW);
  const opportunities = await campaigns.search(draft.campaignId, [{
    rotatingOpportunityId: "opportunity_1", category: "developer-tools", region: "US Northeast", host: "codex",
    acceptedRewardTypes: ["stablecoin"], consentVersion: 1, currentConsentVersion: 1,
    expiresAt: "2026-08-15T13:00:00.000Z", fields: { ...published },
    preBidExposure: { projectNames: false, publicRepositoryUrls: false }, hasCashPayoutAddress: true,
  }], NOW);
  assert.equal(opportunities.length, 1);

  budgets.open({ campaignId: "campaign_runner_up", fundedMinor: 2_000, dailyCapMinor: 2_000 });
  const auctions = new AuctionService(budgets);
  auctions.open({
    auctionId: "auction_1", opportunityId: "opportunity_1", rewardLane: "stablecoin", consentVersion: 1,
    minimumTakeHomeMinor: 500, matchedSignalNames: ["TypeScript", "Postgres"], closesAt: "2026-08-15T12:00:01.000Z",
  });
  await auctions.bid("auction_1", { bidId: "bid_winner", campaignId: draft.campaignId, rewardLane: "stablecoin", grossMinor: 625, submittedAt: NOW.toISOString() }, NOW);
  await auctions.bid("auction_1", { bidId: "bid_runner_up", campaignId: "campaign_runner_up", rewardLane: "stablecoin", grossMinor: 624, submittedAt: NOW.toISOString() }, NOW);
  const decision = await auctions.clear("auction_1", { now: new Date("2026-08-15T12:00:02.000Z"), receiverStatus: "active", currentConsentVersion: 1, frequencyEligible: true });
  assert.equal(decision.winner?.campaignId, draft.campaignId);
  assert.equal(decision.eligibleBidderCount, 2);

  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const credentials = new CredentialLifecycleService();
  enrollMarketplacePublicKey(credentials, { credentialId: "signing_1", keyId: "key_1", publicKeyPem, environment: "test", now: NOW });
  const placementRepository = new MemoryPlacementDeliveryRepository();
  const delivery = new PlacementDeliveryService(placementRepository, new MarketplaceSigningKeys(credentials, "test"), {
    creativeOrigins: ["https://creative.ad-daddy.test"], verifiedDestinationDomains: ["neon.tech"], approvedPackages: [], approvedPackageDomains: [],
  });
  const signed = signPlacement(placementPayload(), { keyId: "key_1", privateKeyPem });
  await delivery.prepare({
    receiverAccountId: "receiver_1", placement: signed, now: NOW,
    marketContext: {
      campaignId: draft.campaignId, eligibleBidderCount: decision.eligibleBidderCount, rewardType: "stablecoin",
      grossAmountMinor: 625, receiverAmountMinor: 500, operatorAmountMinor: 125,
    },
  });
  const host = new DemoCodexHost();
  const delivered = await delivery.deliverCodex("placement_1", {
    isolatedCwd: "/tmp/ad-daddy-demo", createConnection: host.createConnection,
    readActiveTaskId: async () => "active_task", verifySidebarVisibility: async ({ threadId }) => host.hasThread(threadId), now: NOW,
  });
  assert.equal(delivered.status, "delivered");
  assert.equal(host.turnCount, 1);
  const receipt = delivered.receipt as CodexDeliveryReceipt;

  const ledgerRepository = new InMemoryLedgerRepository();
  const ledger = new LedgerService(ledgerRepository);
  const settlement = new SettlementService(ledger, budgets, new RewardVelocityGuard(10_000, 10_000));
  await settlement.settleBase({
    placementId: "placement_1", campaignId: draft.campaignId, reservationId: decision.winner!.reservationId!, rewardType: "stablecoin",
    grossAmountMinor: 625, receiverAmountMinor: 500, operatorAmountMinor: 125,
    advertiserLedgerAccountId: "advertiser:advertiser_1", receiverLedgerAccountId: "receiver:receiver_1", operatorLedgerAccountId: "operator:ad-daddy",
    receiverHumanId: "receiver_1", installationId: "installation_1", receipt, policyVersion: "demo/v1", now: NOW,
  });

  const verifier = new ConversionEvidenceVerifier();
  verifier.allow("neon", "conversion_1", "c".repeat(32));
  const attribution = new AttributionService(budgets, ledger, verifier);
  await attribution.open({
    placementId: "placement_1", campaignId: draft.campaignId, receiverLedgerAccountId: "receiver:receiver_1",
    advertiserLedgerAccountId: "advertiser:advertiser_1", operatorLedgerAccountId: "operator:ad-daddy",
    evidenceType: "database_created", bonusGrossMinor: 1_000, claimDeadline: "2026-08-16T12:00:00.000Z", disputeHoldMs: 1_000, policyVersion: "demo/v1",
  });
  attribution.submit(verifier.sign({
    eventId: "conversion_event_1", provider: "neon", keyId: "conversion_1", campaignId: draft.campaignId,
    placementId: "placement_1", evidenceType: "database_created", amountMinor: 1_000, occurredAt: NOW.toISOString(),
  }), NOW);
  await attribution.settle("placement_1", new Date(NOW.getTime() + 1_000));
  assert.equal(ledgerRepository.transactions.length, 2);

  const history = await createPlacementHistoryHandler(placementRepository)(new Request("https://ad-daddy.test/api/v1/placements", { headers: { "oai-authenticated-user-id": "receiver_1" } }));
  const historyBody = await history.json() as { placements: Array<{ bidderCount: number; economics: { receiverAmountMinor: number } }> };
  assert.equal(historyBody.placements[0].bidderCount, 2);
  assert.equal(historyBody.placements[0].economics.receiverAmountMinor, 500);

  const reports = await createReportHandler(
    placementRepository,
    new LifecycleEventStore(),
    createCampaignReportAuthority({ campaigns, brandVerifications: brands }, []),
  )(new Request("https://ad-daddy.test/api/v1/reports?campaignId=campaign_neon", {
    headers: { "oai-authenticated-user-id": "advertiser_1" },
  }));
  const reportBody = await reports.json() as { placements: Array<{ renderedResponse: string; measurement: { sessionOpen: string } }> };
  assert.match(reportBody.placements[0].renderedResponse, /Sponsored via Ad Daddy/);
  assert.equal(reportBody.placements[0].measurement.sessionOpen, "unavailable");
});

function campaignDraft(): CampaignDraft {
  return {
    campaignId: "campaign_neon", accountId: "advertiser_1", advertiserTermsVersion: ADVERTISER_TERMS_VERSION,
    brand: { name: "Neon", verifiedDomain: "neon.tech", verificationId: "brand_neon" }, destinationUrl: "https://neon.tech/docs",
    schedule: { startsAt: "2026-08-15T11:00:00.000Z", endsAt: "2026-08-16T12:00:00.000Z" }, allowlistedDestinationHosts: ["neon.tech"],
    categories: ["developer-tools"], regions: ["US Northeast"], hosts: ["codex"], rewardTypes: ["stablecoin"],
    creative: { headline: "Branch Postgres for every preview", body: "Create an isolated database branch for every preview." },
    maximumSpendMinor: 5_000, maximumBidMinor: 625, dailyCapMinor: 5_000, guaranteedPlacementMinor: 625,
    conversionBonusMinor: 1_000, conversionTerms: "Pay after a provider-signed database_created event.", perUserFrequencyLimit: 1,
  };
}
function approval(purposes: readonly string[]): CampaignApproval {
  return {
    accountId: "advertiser_1", approvedAt: NOW.toISOString(), expiresAt: "2026-08-15T12:10:00.000Z", purposes,
    approvedCampaignId: "campaign_neon", approvedMaximumSpendMinor: 5_000, approvedDestinationUrl: "https://neon.tech/docs",
    approvedConversionTerms: "Pay after a provider-signed database_created event.",
  };
}
function placementPayload(): PlacementPayload {
  return {
    protocolVersion: 1, placementId: "placement_1", advertiser: { id: "adv_neon", displayName: "Neon" },
    title: "Branch Postgres for every preview", contentReference: "https://creative.ad-daddy.test/placements/placement_1",
    destinationUrl: "https://neon.tech/docs", disclosure: "Sponsored", payout: { amountMinor: 500, currency: "USD" },
    signalsUsed: ["TypeScript", "Postgres"], creative: { body: "Create an isolated database branch for every preview.", attachments: [] },
    issuedAt: "2026-08-15T11:59:00.000Z", expiresAt: "2026-08-16T12:00:00.000Z",
  };
}

class DemoCodexHost {
  readonly threads = new Map<string, { id: string; name: string; preview: string; turns: Array<{ id: string; status: string; items: unknown[] }> }>();
  turnCount = 0;
  hasThread = (id: string) => this.threads.has(id);
  createConnection = async (): Promise<CodexAppServerConnection> => {
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    let waiter: ((value: { method: string; params: Record<string, unknown> }) => void) | undefined;
    const emit = (value: { method: string; params: Record<string, unknown> }) => waiter ? (waiter(value), waiter = undefined) : notifications.push(value);
    return {
      cliVersion: "0.146.1", userAgent: "Codex Desktop/0.146.1 (demo)", allowedInstructionSources: [],
      request: async <T>(method: string, paramsValue: unknown): Promise<T> => {
        const params = paramsValue as { threadId?: string; name?: string; input?: Array<{ text: string }> };
        if (method === "thread/list") return { data: [...this.threads.values()].map((thread) => ({ id: thread.id, name: thread.name, preview: thread.preview })), nextCursor: null } as T;
        if (method === "thread/start") {
          const thread = { id: "sponsored_task", name: "", preview: "", turns: [] as Array<{ id: string; status: string; items: unknown[] }> };
          this.threads.set(thread.id, thread); return { thread, instructionSources: [] } as T;
        }
        if (method === "thread/name/set") { this.threads.get(params.threadId!)!.name = params.name!; return {} as T; }
        if (method === "turn/start") {
          this.turnCount += 1;
          const thread = this.threads.get(params.threadId!)!; thread.preview = params.input![0].text;
          const turn = { id: "display_turn", status: "inProgress", items: [] as unknown[] }; thread.turns.push(turn);
          queueMicrotask(() => {
            const item = { type: "agentMessage", id: "answer", phase: "final_answer", text: "Sponsored via Ad Daddy\nNeon — Branch Postgres for every preview\nReward: $5.00\nMatched: TypeScript, Postgres\nCreate an isolated database branch for every preview." };
            turn.items.push(item); emit({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item } });
            turn.status = "completed"; emit({ method: "turn/completed", params: { threadId: thread.id, turn: structuredClone(turn) } });
          });
          return { turn } as T;
        }
        if (method === "thread/read") { const thread = this.threads.get(params.threadId!); if (!thread) throw new Error("missing task"); return { thread: structuredClone(thread) } as T; }
        if (method === "turn/interrupt") return {} as T;
        throw new Error(`Unexpected App Server method ${method}`);
      },
      nextNotification: async () => notifications.shift() ?? await new Promise((resolve) => { waiter = resolve; }),
      close: async () => {},
    };
  };
}
