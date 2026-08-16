import assert from "node:assert/strict";
import test from "node:test";

import { createCampaignRuntime } from "../../lib/marketplace/campaign-registry.ts";
import { D1CampaignBudgetService } from "../../lib/marketplace/d1-campaign.ts";
import { createMigratedD1 } from "../helpers/sqlite-d1.ts";

const NOW = new Date("2026-08-15T20:00:00.000Z");

test("campaign records and agent-token signatures survive runtime reconstruction", async (t) => {
  const { database, close } = createMigratedD1();
  t.after(close);
  await database.prepare("INSERT INTO human_accounts (id, status) VALUES (?, 'active')").bind("advertiser_1").run();
  await database.prepare(`INSERT INTO advertiser_brands
    (id, account_id, name, verified_domain, ownership_status, verified_at)
    VALUES (?, ?, ?, ?, 'verified', ?)`).bind("brand_1", "advertiser_1", "Neon", "neon.tech", NOW.toISOString()).run();
  const bindings = {
    DB: database,
    AD_DADDY_ENV: "test",
    AD_DADDY_MEMO_SALT: "m".repeat(32),
    AD_DADDY_PAYMENT_EVENT_SECRET: "p".repeat(32),
    AD_DADDY_CAMPAIGN_TOKEN_SECRET: "t".repeat(32),
  } as const;
  const first = createCampaignRuntime(bindings);
  await first.campaigns.prepare({
    campaignId: "campaign_1", accountId: "advertiser_1", advertiserTermsVersion: "advertiser-terms/1",
    brand: { name: "Neon", verifiedDomain: "neon.tech", verificationId: "brand_1" },
    destinationUrl: "https://neon.tech/offer", allowlistedDestinationHosts: ["neon.tech"],
    schedule: { startsAt: NOW.toISOString(), endsAt: new Date(NOW.getTime() + 86_400_000).toISOString() },
    categories: ["database"], regions: ["US"], hosts: ["codex"], rewardTypes: ["stablecoin"],
    creative: { headline: "Branch your database", body: "Create a preview branch." },
    maximumSpendMinor: 10_000, maximumBidMinor: 1_000, dailyCapMinor: 5_000,
    guaranteedPlacementMinor: 500, conversionTerms: "Verified signup", perUserFrequencyLimit: 1,
  });
  const token = await first.tokens.issue({
    tokenId: "token_1", accountId: "advertiser_1", campaignId: "campaign_1",
    scopes: ["campaign:read", "bid:submit"], spendCeilingMinor: 1_000, bidCeilingMinor: 1_000,
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  }, NOW);
  const restarted = createCampaignRuntime(bindings);
  assert.equal((await restarted.campaigns.get("campaign_1")).creative.headline, "Branch your database");
  assert.equal((await restarted.tokens.verify(token, {
    accountId: "advertiser_1", campaignId: "campaign_1", scope: "campaign:read",
  }, NOW)).tokenId, "token_1");
  const firstSpend = await first.tokens.authorizeSpend(token, {
    accountId: "advertiser_1", campaignId: "campaign_1", amountMinor: 600, bidMinor: 600, idempotencyKey: "bid_1",
  }, NOW);
  assert.equal(firstSpend.remainingMinor, 400);
  assert.equal((await restarted.tokens.authorizeSpend(token, {
    accountId: "advertiser_1", campaignId: "campaign_1", amountMinor: 600, bidMinor: 600, idempotencyKey: "bid_1",
  }, NOW)).newlyAuthorized, false);
  await assert.rejects(restarted.tokens.authorizeSpend(token, {
    accountId: "advertiser_1", campaignId: "campaign_1", amountMinor: 401, bidMinor: 401, idempotencyKey: "bid_2",
  }, NOW), /spend ceiling/i);

  const authorization = await restarted.tokens.authorize(token, {
    accountId: "advertiser_1", campaignId: "campaign_1", scope: "bid:submit",
  }, NOW);
  await restarted.tokens.releaseVerifiedSpend(authorization, "bid_1", NOW);
  const afterRelease = createCampaignRuntime(bindings);
  assert.equal((await afterRelease.tokens.authorizeSpend(token, {
    accountId: "advertiser_1", campaignId: "campaign_1", amountMinor: 600, bidMinor: 600, idempotencyKey: "bid_3",
  }, NOW)).remainingMinor, 400);
  await assert.rejects(afterRelease.tokens.authorizeSpend(token, {
    accountId: "advertiser_1", campaignId: "campaign_1", amountMinor: 600, bidMinor: 600, idempotencyKey: "bid_1",
  }, NOW), /idempotency collision/i);
});

test("D1 budget reservation and hold commits are idempotent under retry", async (t) => {
  const { database, close } = createMigratedD1();
  t.after(close);
  await database.prepare("INSERT INTO human_accounts (id, status) VALUES (?, 'active')").bind("advertiser_budget").run();
  await database.prepare(`INSERT INTO advertiser_brands
    (id, account_id, name, verified_domain, ownership_status, verified_at)
    VALUES (?, ?, ?, ?, 'verified', ?)`).bind("brand_budget", "advertiser_budget", "Budget test", "example.com", NOW.toISOString()).run();
  await database.prepare(`INSERT INTO campaigns
    (id, account_id, brand_id, status, advertiser_terms_version, destination_url,
     schedule_starts_at, schedule_ends_at, audience_json, offer_json, creative_json,
     conversion_terms, maximum_spend_minor, maximum_bid_minor, daily_cap_minor,
     funded_minor, spent_minor, refunded_minor, terms_accepted_at, activated_at, created_at, updated_at)
    VALUES (?, ?, 'brand_budget', 'active', 'advertiser-terms/1', 'https://example.com', ?, ?,
      '{"categories":["database"],"regions":["US"],"hosts":["codex"]}',
      '{"rewardTypes":["stablecoin"],"guaranteedPlacementMinor":500,"perUserFrequencyLimit":1}',
      '{"headline":"Budget test","body":"Budget test"}', 'signup', 10000, 1000, 5000,
      10000, 0, 0, ?, ?, ?, ?)`)
    .bind(
      "campaign_budget", "advertiser_budget", NOW.toISOString(), new Date(NOW.getTime() + 86_400_000).toISOString(),
      NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString(),
    )
    .run();

  const budgets = new D1CampaignBudgetService(database);
  await budgets.reserve("campaign_budget", "reservation_1", 600, NOW);
  await Promise.all([
    budgets.commit("campaign_budget", "reservation_1"),
    budgets.commit("campaign_budget", "reservation_1"),
  ]);
  await budgets.hold("campaign_budget", "hold_1", 400);
  await Promise.all([
    budgets.commitHold("campaign_budget", "hold_1"),
    budgets.commitHold("campaign_budget", "hold_1"),
  ]);

  const snapshot = await budgets.snapshot("campaign_budget");
  assert.equal(snapshot.spentMinor, 1_000);
  assert.equal(snapshot.reservedMinor, 0);
  assert.equal(snapshot.heldMinor, 0);
});

test("pausing a D1 campaign preserves a won reservation while releasing unused reservations", async (t) => {
  const { database, close } = createMigratedD1();
  t.after(close);
  await database.prepare("INSERT INTO human_accounts (id, status) VALUES ('advertiser_pause', 'active'), ('receiver_pause', 'active')").run();
  await database.prepare(`INSERT INTO advertiser_brands
    (id, account_id, name, verified_domain, ownership_status, verified_at)
    VALUES ('brand_pause', 'advertiser_pause', 'Pause test', 'example.com', 'verified', ?)`)
    .bind(NOW.toISOString()).run();
  await database.prepare(`INSERT INTO campaigns
    (id, account_id, brand_id, status, advertiser_terms_version, destination_url,
     schedule_starts_at, schedule_ends_at, audience_json, offer_json, creative_json,
     conversion_terms, maximum_spend_minor, maximum_bid_minor, daily_cap_minor,
     funded_minor, spent_minor, refunded_minor, created_at, updated_at)
    VALUES ('campaign_pause', 'advertiser_pause', 'brand_pause', 'active', 'advertiser-terms/1', 'https://example.com', ?, ?,
      '{}', '{}', '{}', 'signup', 10000, 1000, 10000, 10000, 0, 0, ?, ?)`)
    .bind(NOW.toISOString(), new Date(NOW.getTime() + 86_400_000).toISOString(), NOW.toISOString(), NOW.toISOString()).run();
  await database.prepare(`INSERT INTO installations (id, account_id, public_key, host_kind, status)
    VALUES ('install_pause', 'receiver_pause', 'public_key_pause', 'codex', 'active')`).run();
  await database.prepare(`INSERT INTO receiver_profiles (id, account_id, installation_id, current_consent_version)
    VALUES ('profile_pause', 'receiver_pause', 'install_pause', 1)`).run();
  await database.prepare(`INSERT INTO opportunities
    (id, rotating_opportunity_id, receiver_profile_id, installation_id, consent_version, state, opened_at, expires_at)
    VALUES ('opportunity_pause', 'rotating_pause', 'profile_pause', 'install_pause', 1, 'won', ?, ?)`)
    .bind(NOW.toISOString(), new Date(NOW.getTime() + 60_000).toISOString()).run();
  await database.prepare(`INSERT INTO auctions
    (id, opportunity_id, reward_lane, consent_version, minimum_take_home_minor, matched_signal_names_json, status, closes_at, decided_at)
    VALUES ('auction_pause', 'opportunity_pause', 'stablecoin', 1, 0, '[]', 'decided', ?, ?)`)
    .bind(NOW.toISOString(), NOW.toISOString()).run();
  await database.prepare(`INSERT INTO auction_bids
    (id, auction_id, campaign_id, reward_lane, gross_amount_minor, receiver_amount_minor, operator_amount_minor, submitted_at)
    VALUES ('bid_pause', 'auction_pause', 'campaign_pause', 'stablecoin', 625, 500, 125, ?)`)
    .bind(NOW.toISOString()).run();
  const budgets = new D1CampaignBudgetService(database);
  await budgets.reserve("campaign_pause", "reservation_won", 625, NOW);
  await budgets.reserve("campaign_pause", "reservation_unused", 400, NOW);
  await database.prepare(`INSERT INTO auction_decisions
    (id, auction_id, winner_bid_id, reservation_id, eligible_bidder_count, decided_at)
    VALUES ('decision_pause', 'auction_pause', 'bid_pause', 'reservation_won', 1, ?)`)
    .bind(NOW.toISOString()).run();

  const paused = await budgets.pause("campaign_pause");
  assert.equal(paused.status, "paused");
  assert.equal(paused.reservedMinor, 625);
  assert.equal(paused.history.find((item) => item.reservationId === "reservation_won")?.status, "reserved");
  assert.equal(paused.history.find((item) => item.reservationId === "reservation_unused")?.status, "released");
});
