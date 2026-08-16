import assert from "node:assert/strict";
import test from "node:test";

import { D1PlacementDeliveryRepository } from "../../lib/marketplace/d1-placement.ts";
import { applyPlacementReceiverAction } from "../../lib/marketplace/placement-delivery.ts";
import { createMigratedD1 } from "../helpers/sqlite-d1.ts";

const NOW = "2026-08-15T20:00:00.000Z";

test("receiver placement history, verified receipt summary, and actions survive D1 reconstruction", async (t) => {
  const migrated = createMigratedD1();
  t.after(migrated.close);
  const db = migrated.database;
  const statements: Array<[string, unknown[]]> = [
    ["INSERT INTO human_accounts (id, status) VALUES ('receiver_1', 'active'), ('receiver_2', 'active'), ('advertiser_1', 'active')", []],
    ["INSERT INTO installations (id, account_id, public_key, key_version, host_kind, status) VALUES ('install_1', 'receiver_1', 'legacy', 1, 'codex', 'active')", []],
    ["INSERT INTO receiver_profiles (id, account_id, installation_id, status, current_consent_version) VALUES ('profile_1', 'receiver_1', 'install_1', 'active', 1)", []],
    ["INSERT INTO advertiser_brands (id, account_id, name, verified_domain, ownership_status, verified_at) VALUES ('brand_1', 'advertiser_1', 'Neon', 'neon.tech', 'verified', ?)", [NOW]],
    [`INSERT INTO campaigns (id, account_id, brand_id, status, advertiser_terms_version, destination_url, schedule_starts_at,
      schedule_ends_at, audience_json, offer_json, creative_json, conversion_terms, maximum_spend_minor, maximum_bid_minor,
      daily_cap_minor, funded_minor, spent_minor, refunded_minor) VALUES
      ('campaign_1', 'advertiser_1', 'brand_1', 'active', 'terms/v1', 'https://neon.tech', ?, ?, '{}', '{}', '{}', 'none', 1000, 625, 1000, 1000, 0, 0)`, [NOW, "2026-08-16T20:00:00.000Z"]],
    ["INSERT INTO campaign_budget_reservations (id, campaign_id, idempotency_key, amount_minor, budget_day, status) VALUES ('reservation_1', 'campaign_1', 'reservation_1', 625, '2026-08-15', 'committed')", []],
    ["INSERT INTO revenue_split_versions (version, receiver_basis_points, operator_basis_points, effective_at) VALUES ('launch-80-20/v1', 8000, 2000, ?)", [NOW]],
    ["INSERT INTO opportunities (id, rotating_opportunity_id, receiver_profile_id, installation_id, consent_version, state, opened_at, expires_at) VALUES ('opportunity_1', 'rotating_1', 'profile_1', 'install_1', 1, 'won', ?, ?)", [NOW, "2026-08-15T20:05:00.000Z"]],
    ["INSERT INTO auctions (id, opportunity_id, reward_lane, consent_version, minimum_take_home_minor, matched_signal_names_json, status, closes_at, decided_at) VALUES ('auction_1', 'opportunity_1', 'stablecoin', 1, 500, '[\"TypeScript\"]', 'decided', ?, ?)", [NOW, NOW]],
    ["INSERT INTO auction_bids (id, auction_id, campaign_id, reward_lane, gross_amount_minor, receiver_amount_minor, operator_amount_minor, submitted_at) VALUES ('bid_1', 'auction_1', 'campaign_1', 'stablecoin', 625, 500, 125, ?)", [NOW]],
    ["INSERT INTO auction_decisions (id, auction_id, winner_bid_id, reservation_id, eligible_bidder_count, decided_at) VALUES ('decision_1', 'auction_1', 'bid_1', 'reservation_1', 4, ?)", [NOW]],
    [`INSERT INTO placements (id, opportunity_id, consent_version, revenue_split_version, state, idempotency_key,
      gross_amount_minor, receiver_amount_minor, operator_amount_minor, currency, host_kind, host_session_id, host_turn_id,
      delivery_status, signed_placement_json, host_receipt_json, updated_at)
      VALUES ('placement_1', 'opportunity_1', 1, 'launch-80-20/v1', 'delivered', 'placement_1', 625, 500, 125, 'USD',
      'codex', 'thread_1', 'turn_1', 'delivered', ?, ?, ?)`, [JSON.stringify(signedPlacement()), JSON.stringify(displayReceipt()), NOW]],
  ];
  for (const [sql, values] of statements) await db.prepare(sql).bind(...values).run();
  const secondPlacement = signedPlacement();
  secondPlacement.payload.placementId = "placement_2";
  for (const [sql, values] of [
    ["INSERT INTO opportunities (id, rotating_opportunity_id, receiver_profile_id, installation_id, consent_version, state, opened_at, expires_at) VALUES ('opportunity_2', 'rotating_2', 'profile_1', 'install_1', 1, 'won', ?, ?)", ["2026-08-15T21:00:00.000Z", "2026-08-15T21:05:00.000Z"]],
    ["INSERT INTO auctions (id, opportunity_id, reward_lane, consent_version, minimum_take_home_minor, matched_signal_names_json, status, closes_at, decided_at) VALUES ('auction_2', 'opportunity_2', 'stablecoin', 1, 500, '[\"TypeScript\"]', 'decided', ?, ?)", ["2026-08-15T21:00:00.000Z", "2026-08-15T21:00:00.000Z"]],
    ["INSERT INTO auction_bids (id, auction_id, campaign_id, reward_lane, gross_amount_minor, receiver_amount_minor, operator_amount_minor, submitted_at) VALUES ('bid_2', 'auction_2', 'campaign_1', 'stablecoin', 625, 500, 125, ?)", ["2026-08-15T21:00:00.000Z"]],
    ["INSERT INTO auction_decisions (id, auction_id, winner_bid_id, reservation_id, eligible_bidder_count, decided_at) VALUES ('decision_2', 'auction_2', 'bid_2', 'reservation_1', 3, ?)", ["2026-08-15T21:00:00.000Z"]],
    [`INSERT INTO placements (id, opportunity_id, consent_version, revenue_split_version, state, idempotency_key,
      gross_amount_minor, receiver_amount_minor, operator_amount_minor, currency, delivery_status, signed_placement_json, updated_at)
      VALUES ('placement_2', 'opportunity_2', 1, 'launch-80-20/v1', 'won', 'placement_2', 625, 500, 125, 'USD', 'ready', ?, ?)`,
    [JSON.stringify(secondPlacement), "2026-08-15T21:00:00.000Z"]],
  ] satisfies Array<[string, unknown[]]>) await db.prepare(sql).bind(...values).run();

  const rawReceipt = await db.prepare("SELECT host_receipt_json AS receipt FROM placements WHERE id = 'placement_1'").first<{ receipt: string }>();
  assert.deepEqual(JSON.parse(rawReceipt?.receipt ?? "null"), displayReceipt());

  const first = new D1PlacementDeliveryRepository(db);
  const record = await first.get("placement_1");
  assert.equal(record?.receiverAccountId, "receiver_1");
  assert.deepEqual(record?.receipt, {
    placementId: "placement_1", verified: true, surface: "sidebar_session", hostKind: "codex", displayedAt: NOW,
  });
  assert.equal((await first.listByReceiver("receiver_2", { limit: 50 })).placements.length, 0);
  await applyPlacementReceiverAction(first, "placement_1", "receiver_1", "report", new Date(NOW));

  const restarted = new D1PlacementDeliveryRepository(db);
  const historical = await restarted.get("placement_1");
  assert.equal(historical?.receiverAction, "report");
  assert.equal(historical?.status, "reported");
  const firstPage = await restarted.listByReceiver("receiver_1", { limit: 1 });
  assert.deepEqual(firstPage.placements.map((placement) => placement.placementId), ["placement_2"]);
  assert.ok(firstPage.nextCursor);
  const secondPage = await restarted.listByReceiver("receiver_1", { limit: 1, cursor: firstPage.nextCursor });
  assert.deepEqual(secondPage.placements.map((placement) => placement.placementId), ["placement_1"]);
  assert.equal(secondPage.nextCursor, null);
  assert.equal((await restarted.listByCampaign("campaign_1", { limit: 50 })).placements.length, 2);
});

function signedPlacement() {
  return {
    algorithm: "Ed25519", keyId: "placement_key", signature: "x".repeat(64),
    payload: {
      protocolVersion: 1, placementId: "placement_1", advertiser: { id: "advertiser_1", displayName: "Neon" },
      title: "Branch your database", contentReference: "https://creative.ad-daddy.test/p/1", destinationUrl: "https://neon.tech",
      disclosure: "Sponsored", payout: { amountMinor: 500, currency: "USD" }, signalsUsed: ["TypeScript"],
      creative: { body: "Create a preview database branch.", attachments: [] }, issuedAt: NOW, expiresAt: "2026-08-16T20:00:00.000Z",
    },
  };
}

function displayReceipt() {
  return {
    algorithm: "ES256", signature: "signature", payload: {
      protocolVersion: 1, claimId: "claim_1", grantDigest: "a".repeat(64), reservationId: "reservation_1",
      placementId: "placement_1", creativeDigest: "b".repeat(64), installationId: "install_1",
      deviceKeyThumbprint: "thumbprint", hostKind: "codex", hostSessionId: "thread_1", hostTurnId: "turn_1",
      outputSha256: "c".repeat(64), adapterVersion: "0.1.0", hostVersion: "0.146.1", policyVersion: "pull/v1",
      surface: "sidebar_session", audience: "ad-daddy:test", nonce: "receipt-nonce", displayedAt: NOW,
    },
  };
}
