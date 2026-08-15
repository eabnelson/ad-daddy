import assert from "node:assert/strict";
import test from "node:test";

import { CampaignService, MemoryCampaignRepository } from "../../packages/cli/dist/commands/campaign.js";
import { AdvertiserAgentService } from "../../packages/cli/dist/commands/advertiser.js";
import { CampaignBudgetService } from "../../lib/marketplace/budget.ts";
import { createCampaignHandler } from "../../app/api/v1/campaigns/route.ts";
import { createOpportunityHandler } from "../../app/api/v1/opportunities/route.ts";
import { FixedWindowRateLimiter } from "../../lib/http/rate-limit.ts";

const now = new Date("2026-08-15T16:00:00.000Z");
const draft = {
  campaignId: "campaign_1", accountId: "acct_advertiser", advertiserTermsVersion: "advertiser-terms/1",
  brand: { name: "Neon", verifiedDomain: "neon.tech", ownershipVerified: true },
  destinationUrl: "https://neon.tech/ad-daddy", allowlistedDestinationHosts: ["neon.tech"],
  schedule: { startsAt: "2026-08-15T15:00:00.000Z", endsAt: "2026-08-15T18:00:00.000Z" },
  categories: ["database"], regions: ["US Northeast"], hosts: ["codex"],
  rewardTypes: ["stablecoin", "credits"] as const,
  creative: { headline: "Branch Postgres in one prompt", body: "Claim $20 credits." },
  maximumSpendMinor: 10_000, maximumBidMinor: 500, dailyCapMinor: 2_000,
  guaranteedPlacementMinor: 200, conversionBonusMinor: 1_000,
  conversionTerms: "Verified first database creation", perUserFrequencyLimit: 1,
};

function approval() {
  return {
    accountId: "acct_advertiser", approvedAt: "2026-08-15T15:59:00.000Z", expiresAt: "2026-08-15T16:05:00.000Z",
    purposes: ["advertiser_verify", "terms_accept", "campaign_fund", "production_activate"] as const,
    approvedCampaignId: "campaign_1", approvedMaximumSpendMinor: 10_000,
    approvedDestinationUrl: "https://neon.tech/ad-daddy", approvedConversionTerms: "Verified first database creation",
  };
}

test("agent prepares campaign but verified funded human approval gates production and inventory", async () => {
  const budgets = new CampaignBudgetService();
  const campaigns = new CampaignService(new MemoryCampaignRepository(), budgets);
  await campaigns.prepare(draft);
  await assert.rejects(campaigns.activate("campaign_1", undefined, now), /human approval/i);
  await campaigns.fund("campaign_1", 10_000, approval(), now);
  const active = await campaigns.activate("campaign_1", approval(), now);
  assert.equal(active.status, "active");
  await assert.rejects(campaigns.prepare({ ...draft, maximumSpendMinor: 20_000 }), /cannot be edited/i);
  const agent = new AdvertiserAgentService(campaigns);
  const results = await agent.search("campaign_1", [{
    rotatingOpportunityId: "rotation_1", category: "database", region: "US Northeast", host: "codex",
    acceptedRewardTypes: ["stablecoin"] as const, hasCashPayoutAddress: true,
    consentVersion: 2, currentConsentVersion: 2, expiresAt: "2026-08-15T17:00:00.000Z",
    fields: { projectDescriptions: ["Building a customer support agent"], projectNames: ["Identifying"] },
    preBidExposure: { projectNames: false, publicRepositoryUrls: false },
  }], now);
  assert.deepEqual(results.map((item) => item.opportunityId), ["rotation_1"]);
  assert.equal("projectNames" in results[0].fields, false);
});

test("funding retries are idempotent and approvals reject malformed time bounds", async () => {
  const budgets = new CampaignBudgetService();
  const campaigns = new CampaignService(new MemoryCampaignRepository(), budgets);
  await campaigns.prepare({ ...draft, campaignId: "fund_retry" });
  const approved = { ...approval(), approvedCampaignId: "fund_retry" };
  await campaigns.fund("fund_retry", 10_000, approved, now);
  await assert.doesNotReject(campaigns.fund("fund_retry", 10_000, approved, now));
  await campaigns.prepare({ ...draft, campaignId: "bad_time" });
  await assert.rejects(campaigns.fund("bad_time", 10_000, { ...approval(), approvedCampaignId: "bad_time", approvedAt: "not-a-date" }, now), /human approval/i);
});

test("mixed cash and credits inventory keeps credits when the receiver has no payout address", async () => {
  const budgets = new CampaignBudgetService();
  const campaigns = new CampaignService(new MemoryCampaignRepository(), budgets);
  await campaigns.prepare({ ...draft, campaignId: "mixed_campaign" });
  const approved = { ...approval(), approvedCampaignId: "mixed_campaign" };
  await campaigns.fund("mixed_campaign", 10_000, approved, now);
  await campaigns.activate("mixed_campaign", approved, now);
  const [opportunity] = await campaigns.search("mixed_campaign", [{
    rotatingOpportunityId: "mixed_opp", category: "database", region: "US Northeast", host: "codex",
    acceptedRewardTypes: ["stablecoin", "credits"], hasCashPayoutAddress: false,
    consentVersion: 1, currentConsentVersion: 1, expiresAt: "2026-08-15T17:00:00.000Z", fields: {},
    preBidExposure: { projectNames: false, publicRepositoryUrls: false },
  }], now);
  assert.deepEqual(opportunity.rewardTypes, ["credits"]);
  const invalidExpiry = await campaigns.search("mixed_campaign", [{
    rotatingOpportunityId: "invalid_expiry", category: "database", region: "US Northeast", host: "codex",
    acceptedRewardTypes: ["credits"], consentVersion: 1, currentConsentVersion: 1,
    expiresAt: "not-a-date", fields: {}, preBidExposure: { projectNames: false, publicRepositoryUrls: false },
  }], now);
  assert.deepEqual(invalidExpiry, []);
});

test("campaign validation rejects empty creative and invalid conversion bonus", async () => {
  const campaigns = new CampaignService(new MemoryCampaignRepository(), new CampaignBudgetService());
  await assert.rejects(campaigns.prepare({ ...draft, campaignId: "empty", creative: { headline: " ", body: "copy" } }), /creative/i);
  await assert.rejects(campaigns.prepare({ ...draft, campaignId: "bonus", conversionBonusMinor: -1 }), /conversion bonus/i);
  await assert.rejects(campaigns.prepare({ ...draft, campaignId: "unknown", injected: true } as typeof draft), /unsupported fields/i);
});

test("funding-pending campaigns cannot bypass production approval through pause and resume", async () => {
  const budgets = new CampaignBudgetService();
  const campaigns = new CampaignService(new MemoryCampaignRepository(), budgets);
  await campaigns.prepare({ ...draft, campaignId: "resume_bypass" });
  const approved = { ...approval(), approvedCampaignId: "resume_bypass" };
  await campaigns.fund("resume_bypass", 10_000, approved, now);
  await assert.rejects(campaigns.pause("resume_bypass"), /only an active/i);
  await assert.rejects(campaigns.resume("resume_bypass"), /previously approved/i);
});

test("unverified brands and non-allowlisted destinations never activate or expose inventory", async () => {
  const budgets = new CampaignBudgetService();
  const campaigns = new CampaignService(new MemoryCampaignRepository(), budgets);
  await campaigns.prepare({ ...draft, campaignId: "campaign_unverified", brand: { ...draft.brand, ownershipVerified: false } });
  const unverifiedApproval = { ...approval(), approvedCampaignId: "campaign_unverified" };
  await campaigns.fund("campaign_unverified", 10_000, unverifiedApproval, now);
  await assert.rejects(campaigns.activate("campaign_unverified", unverifiedApproval, now), /ownership/i);
  await assert.rejects(campaigns.search("campaign_unverified", [], now), /active/i);
  await assert.rejects(campaigns.prepare({ ...draft, campaignId: "bad_destination", destinationUrl: "https://tracking.example/offer" }), /destination/i);
});

test("budget reservations are concurrency-safe, idempotent, and pause releases unused money", async () => {
  const budgets = new CampaignBudgetService();
  budgets.open({ campaignId: "campaign_1", fundedMinor: 1_000, dailyCapMinor: 600 });
  const attempts = await Promise.allSettled([
    budgets.reserve("campaign_1", "a", 400, now),
    budgets.reserve("campaign_1", "b", 400, now),
  ]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  const prior = await budgets.reserve("campaign_1", "a", 400, now).catch(() => budgets.reserve("campaign_1", "b", 400, now));
  assert.equal(prior.amountMinor, 400);
  const paused = await budgets.pause("campaign_1");
  assert.equal(paused.reservedMinor, 0);
  assert.equal(paused.history.length, 1);
  await assert.rejects(budgets.reserve("campaign_1", "c", 100, now), /paused/i);
});

test("closing is permanent and withdrawable excludes reservations and holds", async () => {
  const budgets = new CampaignBudgetService();
  budgets.open({ campaignId: "campaign_1", fundedMinor: 1_000, dailyCapMinor: 1_000 });
  await budgets.reserve("campaign_1", "placement", 200, now);
  await budgets.hold("campaign_1", "conversion", 50);
  const closed = await budgets.close("campaign_1");
  assert.equal(closed.withdrawableMinor, 750);
  await assert.rejects(budgets.reserve("campaign_1", "late", 1, now), /closed/i);
  await assert.rejects(budgets.hold("campaign_1", "late_hold", 1), /closed/i);
  await assert.rejects(budgets.resume("campaign_1"), /closed/i);
});

test("API limits reject before campaign mutation or inventory exposure", async () => {
  let prepareCalls = 0;
  let inventoryReads = 0;
  const campaignLimiter = new FixedWindowRateLimiter({ limit: 10, windowMs: 60_000, maxRetryAfterSeconds: 60 });
  const opportunityLimiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 60_000, maxRetryAfterSeconds: 60 });
  const runtime = {
    campaignRateLimit: campaignLimiter,
    opportunityRateLimit: opportunityLimiter,
    campaigns: {
      prepare: async () => { prepareCalls += 1; return {}; },
      get: async () => ({ accountId: "acct", status: "active" }),
      search: async () => [],
    },
    tokens: { verify: async () => ({}) },
    listCandidates: async () => { inventoryReads += 1; return []; },
  } as never;
  const campaignHandler = createCampaignHandler(runtime);
  const oversized = await campaignHandler(new Request("https://ad.daddy/api/v1/campaigns", {
    method: "POST",
    headers: { "oai-authenticated-user-id": "acct", "cf-connecting-ip": "127.0.0.1" },
    body: "x".repeat(40_000),
  }));
  assert.equal(oversized.status, 413);
  assert.equal(prepareCalls, 0);

  const opportunityHandler = createOpportunityHandler(runtime);
  const request = () => new Request("https://ad.daddy/api/v1/opportunities", {
    method: "POST",
    headers: {
      authorization: "Bearer signed",
      "content-type": "application/json",
      "x-ad-daddy-account-id": "acct",
      "x-ad-daddy-campaign-id": "campaign_1",
      "cf-connecting-ip": "127.0.0.2",
    },
    body: JSON.stringify({ accountId: "acct", campaignId: "campaign_1", limit: 20 }),
  });
  assert.equal((await opportunityHandler(request())).status, 200);
  const limited = await opportunityHandler(request());
  assert.equal(limited.status, 429);
  assert.equal(inventoryReads, 1);
  assert.ok(Number((await limited.json() as { retryAfterSeconds: number }).retryAfterSeconds) <= 60);
});
