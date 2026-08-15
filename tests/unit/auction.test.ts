import assert from "node:assert/strict";
import test from "node:test";

import { AuctionService, type AuctionDefinition } from "../../lib/marketplace/auction.ts";
import { CampaignBudgetService } from "../../lib/marketplace/budget.ts";

const now = new Date("2026-08-15T16:00:00.000Z");
const definition: AuctionDefinition = {
  auctionId: "auction_1",
  opportunityId: "opportunity_1",
  rewardLane: "stablecoin",
  consentVersion: 3,
  minimumTakeHomeMinor: 400,
  matchedSignalNames: ["privateRepoTechStacks", "projectDescriptions"],
  closesAt: "2026-08-15T16:01:00.000Z",
};

function setup(fundedMinor = 2_000) {
  const budgets = new CampaignBudgetService();
  budgets.open({ campaignId: "campaign_a", fundedMinor, dailyCapMinor: fundedMinor });
  budgets.open({ campaignId: "campaign_b", fundedMinor, dailyCapMinor: fundedMinor });
  const service = new AuctionService(budgets);
  service.open(definition);
  return { service, budgets };
}

test("cash bids must satisfy take-home minimum and highest eligible first-price bid wins", async () => {
  const { service, budgets } = setup();
  await assert.rejects(service.bid("auction_1", {
    bidId: "below_take_home", campaignId: "campaign_a", grossMinor: 498,
    submittedAt: now.toISOString(), rewardLane: "stablecoin",
  }, now), /take-home minimum/i);
  await service.bid("auction_1", {
    bidId: "lower", campaignId: "campaign_a", grossMinor: 500,
    submittedAt: now.toISOString(), rewardLane: "stablecoin",
  }, now);
  await service.bid("auction_1", {
    bidId: "winner", campaignId: "campaign_b", grossMinor: 700,
    submittedAt: now.toISOString(), rewardLane: "stablecoin",
  }, now);
  const decision = await service.clear("auction_1", {
    now: new Date("2026-08-15T16:01:00.000Z"), receiverStatus: "active", currentConsentVersion: 3,
  });
  assert.equal(decision.winner?.bidId, "winner");
  assert.equal(decision.winner?.grossMinor, 700);
  assert.equal(decision.winner?.receiverMinor, 560);
  assert.equal(decision.winner?.operatorMinor, 140);
  assert.equal(budgets.snapshot("campaign_b").reservedMinor, 700);
  assert.equal(budgets.snapshot("campaign_a").reservedMinor, 0);
});

test("equal bids and replay produce one deterministic decision", async () => {
  const { service } = setup();
  await Promise.all([
    service.bid("auction_1", { bidId: "z", campaignId: "campaign_b", grossMinor: 600, submittedAt: now.toISOString(), rewardLane: "stablecoin" }, now),
    service.bid("auction_1", { bidId: "a", campaignId: "campaign_a", grossMinor: 600, submittedAt: now.toISOString(), rewardLane: "stablecoin" }, now),
  ]);
  const [first, replay] = await Promise.all([
    service.clear("auction_1", { now: new Date("2026-08-15T16:01:00.000Z"), receiverStatus: "active", currentConsentVersion: 3 }),
    service.clear("auction_1", { now: new Date("2026-08-15T16:01:00.000Z"), receiverStatus: "active", currentConsentVersion: 3 }),
  ]);
  assert.equal(first.winner?.bidId, "a");
  assert.deepEqual(replay, first);
  assert.equal(service.history("auction_1").decisions.length, 1);
});

test("one campaign cannot inflate receiver demand with multiple bids", async () => {
  const { service } = setup();
  await service.bid("auction_1", { bidId: "first", campaignId: "campaign_a", grossMinor: 500, submittedAt: now.toISOString(), rewardLane: "stablecoin" }, now);
  await assert.rejects(service.bid("auction_1", { bidId: "second", campaignId: "campaign_a", grossMinor: 600, submittedAt: now.toISOString(), rewardLane: "stablecoin" }, now), /only one bid/i);
});

test("non-cash rewards are isolated from cash ranking", async () => {
  const budgets = new CampaignBudgetService();
  budgets.open({ campaignId: "campaign_a", fundedMinor: 1_000, dailyCapMinor: 1_000 });
  const service = new AuctionService(budgets);
  service.open({ ...definition, auctionId: "credits", rewardLane: "credits", minimumTakeHomeMinor: 0 });
  await assert.rejects(service.bid("credits", {
    bidId: "cash", campaignId: "campaign_a", grossMinor: 900, submittedAt: now.toISOString(), rewardLane: "stablecoin",
  }, now), /reward lane/i);
  await service.bid("credits", {
    bidId: "credit_offer", campaignId: "campaign_a", grossMinor: 0, submittedAt: now.toISOString(), rewardLane: "credits",
  }, now);
  const decision = await service.clear("credits", {
    now: new Date("2026-08-15T16:01:00.000Z"), receiverStatus: "active", currentConsentVersion: 3,
  });
  assert.equal(decision.winner?.grossMinor, 0);
  assert.equal(budgets.snapshot("campaign_a").reservedMinor, 0);
});

test("consent changes, receiver pause, and no bids produce explicit no-fill reasons", async () => {
  for (const [auctionId, receiverStatus, version, reason] of [
    ["paused", "paused", 3, "receiver_paused"],
    ["stale", "active", 4, "stale_consent"],
    ["empty", "active", 3, "no_eligible_bids"],
  ] as const) {
    const budgets = new CampaignBudgetService();
    const service = new AuctionService(budgets);
    service.open({ ...definition, auctionId });
    const decision = await service.clear(auctionId, {
      now: new Date("2026-08-15T16:01:00.000Z"), receiverStatus, currentConsentVersion: version,
    });
    assert.equal(decision.noFillReason, reason);
  }
  const budgets = new CampaignBudgetService();
  const service = new AuctionService(budgets);
  service.open({ ...definition, auctionId: "frequency" });
  const limited = await service.clear("frequency", {
    now: new Date("2026-08-15T16:01:00.000Z"), receiverStatus: "active", currentConsentVersion: 3, frequencyEligible: false,
  });
  assert.equal(limited.noFillReason, "frequency_limited");
});
