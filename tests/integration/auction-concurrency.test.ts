import assert from "node:assert/strict";
import test from "node:test";

import { AuctionService } from "../../lib/marketplace/auction.ts";
import { CampaignBudgetService } from "../../lib/marketplace/budget.ts";
import { buildReceiverDemandView } from "../../lib/marketplace/demand.ts";
import { AuctionObject } from "../../workers/auction/src/auction-object.ts";
import { createBidHandler } from "../../app/api/v1/auctions/[id]/bids/route.ts";
import { FixedWindowRateLimiter } from "../../lib/http/rate-limit.ts";
import { createMigratedD1 } from "../helpers/sqlite-d1.ts";

const submittedAt = "2026-08-15T16:00:00.000Z";
const closesAt = "2026-08-15T16:01:00.000Z";

test("one campaign cannot overspend across concurrent auctions and demand stays private", async () => {
  const budgets = new CampaignBudgetService();
  budgets.open({ campaignId: "campaign", fundedMinor: 600, dailyCapMinor: 600 });
  const service = new AuctionService(budgets);
  for (const auctionId of ["auction_a", "auction_b"]) {
    service.open({
      auctionId, opportunityId: `opportunity_${auctionId}`, rewardLane: "stablecoin",
      consentVersion: 1, minimumTakeHomeMinor: 320, matchedSignalNames: ["privateRepoTechStacks"], closesAt,
    });
    await service.bid(auctionId, {
      bidId: `bid_${auctionId}`, campaignId: "campaign", grossMinor: 400,
      rewardLane: "stablecoin", submittedAt,
    }, new Date(submittedAt));
  }
  const decisions = await Promise.all([
    service.clear("auction_a", { now: new Date(closesAt), receiverStatus: "active", currentConsentVersion: 1 }),
    service.clear("auction_b", { now: new Date(closesAt), receiverStatus: "active", currentConsentVersion: 1 }),
  ]);
  assert.equal(decisions.filter((decision) => decision.winner).length, 1);
  assert.equal(decisions.filter((decision) => decision.noFillReason === "budget_unavailable").length, 1);
  assert.equal(budgets.snapshot("campaign").reservedMinor, 400);

  const filled = decisions.find((decision) => decision.winner)!;
  const demand = buildReceiverDemandView(service.history(filled.auctionId));
  assert.equal(demand.bidderCount, 1);
  assert.equal(demand.winningGrossMinor, 400);
  assert.deepEqual(demand.matchedSignalNames, ["privateRepoTechStacks"]);
  assert.equal("campaignId" in demand, false);
  assert.equal(JSON.stringify(demand).includes("bid_"), false);
});

test("durable auction storage survives object restart and its receiver view omits bidder identity", async () => {
  const durableSubmittedAt = new Date(Date.now() - 1_000).toISOString();
  const durableClosesAt = new Date(Date.now() + 60_000).toISOString();
  const values = new Map<string, unknown>();
  let alarm = 0;
  const state = {
    id: { toString: () => "durable_auction" },
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => { values.set(key, structuredClone(value)); },
      setAlarm: async (timestamp: number) => { alarm = timestamp; },
    },
  };
  const persisted = { auction: undefined as unknown[] | undefined, bid: undefined as unknown[] | undefined, decision: undefined as unknown[] | undefined };
  const db = {
    prepare(query: string) {
      let bindings: unknown[] = [];
      return {
        bind(...values: unknown[]) { bindings = values; return this; },
        async run() {
          if (query.includes("INSERT INTO auctions")) persisted.auction = bindings;
          if (query.includes("INSERT INTO auction_bids")) persisted.bid = bindings;
          if (query.includes("INSERT INTO auction_decisions")) persisted.decision = bindings;
          return { meta: { changes: 1 } };
        },
        async first<T>() {
          if (query.includes("c.audience_json AS audienceJson")) return eligibleAudienceRow("credits") as T;
          if (query.includes("FROM auctions WHERE")) return {
            opportunityId: persisted.auction?.[1], rewardLane: persisted.auction?.[2], consentVersion: persisted.auction?.[3],
            minimumTakeHomeMinor: persisted.auction?.[4], matchedSignals: persisted.auction?.[5], closesAt: persisted.auction?.[6],
          } as T;
          if (query.includes("FROM auction_bids WHERE")) return {
            auctionId: persisted.bid?.[1], campaignId: persisted.bid?.[2], rewardLane: persisted.bid?.[3],
            grossMinor: persisted.bid?.[4], receiverMinor: persisted.bid?.[5], operatorMinor: persisted.bid?.[6], submittedAt: persisted.bid?.[7],
          } as T;
          if (query.includes("FROM auction_decisions WHERE")) return {
            id: persisted.decision?.[0], winnerBidId: persisted.decision?.[2], reservationId: persisted.decision?.[3],
            eligibleBidderCount: persisted.decision?.[4], noFillReason: persisted.decision?.[5], decidedAt: persisted.decision?.[6],
          } as T;
          throw new Error("credits auction must not read cash reservation state");
        },
      };
    },
  };
  const definition = {
    auctionId: "durable_auction", opportunityId: "opportunity", rewardLane: "credits" as const,
    consentVersion: 1, minimumTakeHomeMinor: 0, matchedSignalNames: ["projectDescriptions"], closesAt: durableClosesAt,
  };
  const first = new AuctionObject(state, { DB: db } as never);
  assert.equal((await first.fetch(jsonRequest("/auctions/durable_auction/open", definition))).status, 201);
  assert.equal(alarm, Date.parse(durableClosesAt));
  await first.fetch(jsonRequest("/auctions/durable_auction/bids", {
    bidId: "private_bid", campaignId: "private_campaign", grossMinor: 0, rewardLane: "credits", submittedAt: durableSubmittedAt,
  }));

  const restarted = new AuctionObject(state, { DB: db } as never);
  const cleared = await restarted.fetch(jsonRequest("/auctions/durable_auction/clear", {
    now: durableClosesAt, receiverStatus: "active", currentConsentVersion: 1,
  }));
  assert.equal(cleared.status, 200);
  const visible = await (await restarted.fetch(new Request("https://auction.test/auctions/durable_auction"))).json() as { bidderCount: number };
  assert.equal(visible.bidderCount, 1);
  assert.equal(JSON.stringify(visible).includes("private_campaign"), false);
  assert.equal(JSON.stringify(visible).includes("private_bid"), false);
});

test("an alarm clearing an auction is serialized behind an in-flight bid", async () => {
  const closesAt = new Date(Date.now() + 40).toISOString();
  const submittedAt = new Date(Date.now() - 1_000).toISOString();
  const values = new Map<string, unknown>();
  let releaseBidPersistence!: () => void;
  let bidPersistenceStarted!: () => void;
  const bidPersistenceGate = new Promise<void>((resolve) => { releaseBidPersistence = resolve; });
  const bidPersistenceSignal = new Promise<void>((resolve) => { bidPersistenceStarted = resolve; });
  const state = {
    storage: {
      get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
      put: async <T>(key: string, value: T) => { values.set(key, structuredClone(value)); },
      setAlarm: async () => undefined,
    },
  };
  const db = {
    prepare(query: string) {
      return {
        bind() { return this; },
        async run() {
          if (query.includes("INSERT INTO auction_bids")) {
            bidPersistenceStarted();
            await bidPersistenceGate;
          }
          return { meta: { changes: 1 } };
        },
        async first<T>() {
          if (query.includes("c.audience_json AS audienceJson")) return eligibleAudienceRow("credits") as T;
          if (query.includes("FROM opportunities")) {
            return { currentConsentVersion: 1, receiverStatus: "active", frequencyEligible: 1 } as T;
          }
          throw new Error(`Unexpected query: ${query}`);
        },
      };
    },
  };
  const object = new AuctionObject(state, { DB: db } as never);
  const definition = {
    auctionId: "alarm_race", opportunityId: "opportunity", rewardLane: "credits" as const,
    consentVersion: 1, minimumTakeHomeMinor: 0, matchedSignalNames: [], closesAt,
  };
  assert.equal((await object.fetch(jsonRequest("/auctions/alarm_race/open", definition))).status, 201);

  const bid = object.fetch(jsonRequest("/auctions/alarm_race/bids", {
    bidId: "late_persist", campaignId: "campaign", grossMinor: 0, rewardLane: "credits", submittedAt,
  }));
  await bidPersistenceSignal;
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  const alarm = object.alarm();
  releaseBidPersistence();
  await Promise.all([bid, alarm]);

  const stored = values.get("auction") as { bids: unknown[]; decision?: unknown };
  assert.equal(stored.bids.length, 1);
  assert.ok(stored.decision);
});

test("durable auction rejects blocked or audience-ineligible bids and rechecks eligibility at clearance", async (t) => {
  const migrated = createMigratedD1();
  t.after(migrated.close);
  const db = migrated.database;
  const now = new Date();
  const close = new Date(now.getTime() + 30_000);
  await db.prepare("INSERT INTO human_accounts (id, status) VALUES ('receiver_guard', 'active'), ('advertiser_guard', 'active')").run();
  await db.prepare("INSERT INTO installations (id, account_id, public_key, host_kind, status) VALUES ('install_guard', 'receiver_guard', '{}', 'codex', 'active')").run();
  await db.prepare("INSERT INTO receiver_profiles (id, account_id, installation_id, status, current_consent_version) VALUES ('profile_guard', 'receiver_guard', 'install_guard', 'active', 1)").run();
  await db.prepare(`INSERT INTO receiver_consent_versions
    (receiver_profile_id, version, status, terms_version, privacy_version, consented_fields_json, accepted_at)
    VALUES ('profile_guard', 1, 'active', 'terms/v1', 'privacy/v1', '{}', ?)`).bind(now.toISOString()).run();
  await db.prepare(`INSERT INTO profile_snapshots
    (id, receiver_profile_id, consent_version, published_fields_json, published_at, expires_at)
    VALUES ('snapshot_guard', 'profile_guard', 1, ?, ?, ?)`).bind(
      JSON.stringify({ coarseLocation: "US", privateRepoTechStacks: [["database"]], acceptedRewardTypes: ["credits"] }),
      now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString(),
    ).run();
  for (const [suffix, category] of [["allowed", "database"], ["wrong", "gaming"], ["blocked", "database"]] as const) {
    await db.prepare(`INSERT INTO advertiser_brands
      (id, account_id, name, verified_domain, ownership_status, verified_at)
      VALUES (?, 'advertiser_guard', ?, ?, 'verified', ?)`).bind(`brand_${suffix}`, suffix, `${suffix}.example.com`, now.toISOString()).run();
    await db.prepare(`INSERT INTO campaigns
      (id, account_id, brand_id, status, advertiser_terms_version, destination_url, schedule_starts_at, schedule_ends_at,
       audience_json, offer_json, creative_json, conversion_terms, maximum_spend_minor, maximum_bid_minor, daily_cap_minor, funded_minor)
      VALUES (?, 'advertiser_guard', ?, 'active', 'terms/v1', ?, ?, ?, ?, '{}', '{}', 'none', 1000, 100, 1000, 1000)`)
      .bind(`campaign_${suffix}`, `brand_${suffix}`, `https://${suffix}.example.com`, new Date(now.getTime() - 60_000).toISOString(),
        new Date(now.getTime() + 86_400_000).toISOString(), JSON.stringify({ categories: [category], regions: ["US"], hosts: ["codex"], rewardTypes: ["credits"] })).run();
  }
  await db.prepare("INSERT INTO receiver_advertiser_blocks (receiver_account_id, advertiser_id, blocked_at) VALUES ('receiver_guard', 'brand_blocked', ?)")
    .bind(now.toISOString()).run();
  await db.prepare(`INSERT INTO opportunities
    (id, rotating_opportunity_id, receiver_profile_id, installation_id, consent_version, state, opened_at, expires_at)
    VALUES ('opp_guard', 'private_guard', 'profile_guard', 'install_guard', 1, 'bidding', ?, ?)`)
    .bind(now.toISOString(), new Date(now.getTime() + 60_000).toISOString()).run();
  const values = new Map<string, unknown>();
  const object = new AuctionObject({ storage: {
    get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, structuredClone(value)); },
    setAlarm: async () => undefined,
  } }, { DB: db } as never);
  const definition = { auctionId: "auction_guard", opportunityId: "opp_guard", rewardLane: "credits" as const,
    consentVersion: 1, minimumTakeHomeMinor: 0, matchedSignalNames: [], closesAt: close.toISOString() };
  assert.equal((await object.fetch(jsonRequest("/auctions/auction_guard/open", definition))).status, 201);
  const bid = (suffix: string) => ({ bidId: `bid_${suffix}`, campaignId: `campaign_${suffix}`, grossMinor: 0,
    rewardLane: "credits" as const, submittedAt: now.toISOString() });
  assert.equal((await object.fetch(jsonRequest("/auctions/auction_guard/bids", bid("wrong")))).status, 409);
  assert.equal((await object.fetch(jsonRequest("/auctions/auction_guard/bids", bid("blocked")))).status, 409);
  assert.equal((await object.fetch(jsonRequest("/auctions/auction_guard/bids", bid("allowed")))).status, 201);
  await db.prepare("INSERT INTO receiver_advertiser_blocks (receiver_account_id, advertiser_id, blocked_at) VALUES ('receiver_guard', 'brand_allowed', ?)")
    .bind(now.toISOString()).run();
  const cleared = await object.fetch(jsonRequest("/auctions/auction_guard/clear", {
    now: close.toISOString(), receiverStatus: "active", currentConsentVersion: 1,
  }));
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json() as { noFillReason?: string }).noFillReason, "no_eligible_bids");
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM auction_bids WHERE auction_id = 'auction_guard'").first<{ count: number }>())?.count, 1);
});

function jsonRequest(path: string, body: unknown) {
  return new Request(`https://auction.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

function eligibleAudienceRow(rewardLane: "stablecoin" | "credits" | "discount") {
  return {
    audienceJson: JSON.stringify({ categories: ["database"], regions: ["US"], hosts: ["codex"], rewardTypes: [rewardLane] }),
    fieldsJson: JSON.stringify({ coarseLocation: "US", privateRepoTechStacks: [["database"]], acceptedRewardTypes: [rewardLane] }),
    host: "codex",
    rewardLane,
  };
}

test("bid throttles reject before token spend mutation or auction work", async () => {
  let authorizedSpends = 0;
  let forwardedBids = 0;
  const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 60_000, maxRetryAfterSeconds: 60 });
  const gateway = {
    bid: async () => { forwardedBids += 1; return Response.json({ accepted: true }); },
  } as never;
  const runtime = {
    opportunityRateLimit: limiter,
    campaigns: { get: async () => ({ accountId: "account", status: "active" }) },
    tokens: {
      authorize: async () => ({ claims: {} }),
      authorizeVerifiedSpend: () => { authorizedSpends += 1; return {}; },
      commitVerifiedSpend: () => undefined,
      releaseVerifiedSpend: () => undefined,
    },
  } as never;
  const handler = createBidHandler(gateway, runtime);
  const request = () => new Request("https://ad.daddy/api/v1/auctions/auction/bids", {
    method: "POST",
    headers: { authorization: "Bearer token", "cf-connecting-ip": "127.0.0.1" },
    body: JSON.stringify({
      accountId: "account", campaignId: "campaign",
      bid: { bidId: "bid", campaignId: "campaign", grossMinor: 400, rewardLane: "stablecoin", submittedAt },
    }),
  });
  const context = { params: Promise.resolve({ id: "auction" }) };
  assert.equal((await handler(request(), context)).status, 200);
  assert.equal((await handler(request(), context)).status, 429);
  assert.equal(authorizedSpends, 1);
  assert.equal(forwardedBids, 1);
});

test("a rejected or failed auction forward releases a newly reserved token spend", async () => {
  let reserved = false;
  let releases = 0;
  let attempts = 0;
  const runtime = {
    opportunityRateLimit: new FixedWindowRateLimiter({ limit: 10, windowMs: 60_000, maxRetryAfterSeconds: 60 }),
    campaigns: { get: async () => ({ accountId: "account", status: "active" }) },
    tokens: {
      authorize: async () => ({ claims: {} }),
      authorizeVerifiedSpend: () => {
        if (reserved) throw new Error("Campaign token spend ceiling exceeded");
        reserved = true;
        return { newlyAuthorized: true };
      },
      commitVerifiedSpend: () => undefined,
      releaseVerifiedSpend: () => { reserved = false; releases += 1; },
    },
  } as never;
  const handler = createBidHandler({
    bid: async () => {
      attempts += 1;
      if (attempts === 1) return Response.json({ error: "auction_unavailable" }, { status: 503 });
      return Response.json({ accepted: true });
    },
  } as never, runtime);
  const request = (bidId: string) => new Request("https://ad.daddy/api/v1/auctions/auction/bids", {
    method: "POST",
    headers: { authorization: "Bearer token", "cf-connecting-ip": "127.0.0.1" },
    body: JSON.stringify({
      accountId: "account", campaignId: "campaign",
      bid: { bidId, campaignId: "campaign", grossMinor: 400, rewardLane: "stablecoin", submittedAt },
    }),
  });
  const context = { params: Promise.resolve({ id: "auction" }) };

  assert.equal((await handler(request("bid_failed"), context)).status, 503);
  assert.equal(releases, 1);
  assert.equal((await handler(request("bid_retry"), context)).status, 200);
});

test("an accept-before-timeout reconciles the exact durable bid before committing token spend", async () => {
  let commits = 0;
  let releases = 0;
  const runtime = {
    opportunityRateLimit: new FixedWindowRateLimiter({ limit: 10, windowMs: 60_000, maxRetryAfterSeconds: 60 }),
    campaigns: { get: async () => ({ accountId: "account", status: "active" }) },
    tokens: {
      authorize: async () => ({ claims: {} }),
      authorizeVerifiedSpend: async () => ({ newlyAuthorized: true }),
      commitVerifiedSpend: async () => { commits += 1; },
      releaseVerifiedSpend: async () => { releases += 1; },
    },
  } as never;
  const handler = createBidHandler({
    async bid() { throw new DOMException("dependency timeout", "TimeoutError"); },
    async readBid(_auctionId: string, bidId: string) { return Response.json({ accepted: true, bidId }); },
  } as never, runtime);
  const response = await handler(new Request("https://ad.daddy/api/v1/auctions/auction/bids", {
    method: "POST", headers: { authorization: "Bearer token", "cf-connecting-ip": "127.0.0.1" },
    body: JSON.stringify({ accountId: "account", campaignId: "campaign", bid: {
      bidId: "bid_timeout", campaignId: "campaign", grossMinor: 400, rewardLane: "stablecoin", submittedAt,
    } }),
  }), { params: Promise.resolve({ id: "auction" }) });
  assert.equal(response.status, 201);
  assert.equal((await response.json() as { reconciled?: boolean }).reconciled, true);
  assert.equal(commits, 1);
  assert.equal(releases, 0);
});
