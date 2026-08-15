import assert from "node:assert/strict";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import test from "node:test";

import type { SignedPlacement } from "@ad-daddy/host-adapters";
import { createSponsorshipCreativeHandler } from "../../app/api/v1/sponsorships/[claimId]/creative/route.ts";
import { createSponsorshipReceiptHandler } from "../../app/api/v1/sponsorships/[claimId]/receipt/route.ts";
import { createNextSponsorshipHandler } from "../../app/api/v1/sponsorships/next/route.ts";
import {
  MemoryDeviceProofRepository,
  canonicalizeDeviceProofEnvelope,
  deviceKeyThumbprint,
  sha256BodyDigest,
  type DeviceProofEnvelope,
} from "../../lib/auth/device-proof.ts";
import {
  MemorySponsorshipClaimRepository,
  SponsorshipClaimService,
  signDisplayReceipt,
  type SponsorshipOutcome,
} from "../../lib/marketplace/sponsorship-claims.ts";
import type { SponsorshipRuntime } from "../../lib/marketplace/sponsorship-runtime.ts";
import { D1SponsorshipClaimRepository, D1SponsorshipSettlementGateway } from "../../lib/marketplace/sponsorship-runtime.ts";
import type { SignedSponsorshipGrant, SponsorshipClaimRecord, SponsorshipDeliveryLease } from "../../lib/marketplace/sponsorship-claims.ts";
import { createMigratedD1 } from "../helpers/sqlite-d1.ts";

const NOW = new Date("2026-08-15T19:00:00.000Z");

test("fresh device-proved pull routes return inert data and never invoke a host API", async () => {
  const deviceKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicJwk = deviceKeys.publicKey.export({ format: "jwk" });
  const privateKeyPem = deviceKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const thumbprint = await deviceKeyThumbprint(publicJwk);
  const otherDeviceKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const otherPublicJwk = otherDeviceKeys.publicKey.export({ format: "jwk" });
  const otherPrivateKeyPem = otherDeviceKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const otherThumbprint = await deviceKeyThumbprint(otherPublicJwk);
  const repository = new MemorySponsorshipClaimRepository({ receivers: [{
    accountId: "receiver_1", receiverProfileId: "profile_1", installationId: "install_1", consentVersion: 2, status: "active",
  }, { accountId: "receiver_1", receiverProfileId: "profile_1", installationId: "install_2", consentVersion: 2, status: "active" }] });
  const grantKeys = generateKeyPairSync("ed25519");
  let settlements = 0;
  const runtime: SponsorshipRuntime = {
    environment: "test", clock: () => NOW,
    proofs: new MemoryDeviceProofRepository({ keys: [{
      installationId: "install_1", accountId: "receiver_1", keyVersion: 1, publicJwk, thumbprint, algorithm: "ES256", status: "active",
    }, { installationId: "install_2", accountId: "receiver_1", keyVersion: 1, publicJwk: otherPublicJwk, thumbprint: otherThumbprint, algorithm: "ES256", status: "active" }] }),
    service: new SponsorshipClaimService(repository, {
      keyId: "grant_1", privateKeyPem: grantKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      claimTtlMs: 60_000, leaseTtlMs: 15_000, receiptGraceMs: 30_000, settlementReviewMs: 60_000,
      environment: "test", settlement: { async settle() { settlements += 1; }, async release() {} },
    }),
  };
  let hostMutations = 0;
  const forbiddenHostApi = { async createSession() { hostMutations += 1; throw new Error("marketplace called host"); } };
  void forbiddenHostApi;
  const next = createNextSponsorshipHandler(runtime);
  const first = await next(await provedRequest("POST", "/api/v1/sponsorships/next", "{}", "bm9uY2UtbmV4dC0xLTAwMDA", thumbprint, privateKeyPem));
  assert.equal(first.status, 202);
  const pending = await first.json() as { opportunityId: string };
  repository.setOutcome(pending.opportunityId, winner(pending.opportunityId));

  const second = await next(await provedRequest("POST", "/api/v1/sponsorships/next", "{}", "bm9uY2UtbmV4dC0yLTAwMDA", thumbprint, privateKeyPem));
  assert.equal(second.status, 200);
  const ready = await second.json() as { claimId: string; grant: { payload: { grantDigest: string; creativeDigest: string } } };
  const creativeHandler = createSponsorshipCreativeHandler(runtime);
  const crossInstallation = await creativeHandler(
    await provedRequest("GET", `/api/v1/sponsorships/${ready.claimId}/creative`, "", "Y3Jvc3MtaW5zdGFsbC1ub25jZS0x", otherThumbprint, otherPrivateKeyPem, { installationId: "install_2", consentVersion: 2 }),
    { params: Promise.resolve({ claimId: ready.claimId }) },
  );
  assert.equal(crossInstallation.status, 403);
  assert.match((await crossInstallation.json() as { message: string }).message, /different device/i);
  const creative = await creativeHandler(
    await provedRequest("GET", `/api/v1/sponsorships/${ready.claimId}/creative`, "", "bm9uY2UtY3JlYXRpdmUtMS0wMDAw", thumbprint, privateKeyPem),
    { params: Promise.resolve({ claimId: ready.claimId }) },
  );
  assert.equal(creative.status, 200);
  const creativeBody = await creative.json() as { placement: SignedPlacement };
  assert.equal(creativeBody.placement.payload.disclosure, "Sponsored");
  assert.equal(hostMutations, 0, "server routes only return inert placement data");

  const receipt = signDisplayReceipt({
    protocolVersion: 1, claimId: ready.claimId, grantDigest: ready.grant.payload.grantDigest,
    reservationId: "reservation_1", placementId: "placement_1", creativeDigest: ready.grant.payload.creativeDigest,
    installationId: "install_1", deviceKeyThumbprint: thumbprint, hostKind: "codex", hostSessionId: "thread_1",
    hostTurnId: "turn_1", outputSha256: "a".repeat(64), adapterVersion: "0.1.0", policyVersion: "pull/v1",
    surface: "sidebar_session", audience: "ad-daddy:test", nonce: "display-nonce-1", displayedAt: NOW.toISOString(),
  }, privateKeyPem);
  const receiptBody = JSON.stringify(receipt);
  const receiptResponse = await createSponsorshipReceiptHandler(runtime)(
    await provedRequest("POST", `/api/v1/sponsorships/${ready.claimId}/receipt`, receiptBody, "bm9uY2UtcmVjZWlwdC0xLTAwMDA", thumbprint, privateKeyPem),
    { params: Promise.resolve({ claimId: ready.claimId }) },
  );
  assert.equal(receiptResponse.status, 200);
  assert.equal(settlements, 1);
  assert.equal(hostMutations, 0);
});

test("claim routes reject stale proof reuse on a different target before creative access", async () => {
  const deviceKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicJwk = deviceKeys.publicKey.export({ format: "jwk" });
  const privateKeyPem = deviceKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const thumbprint = await deviceKeyThumbprint(publicJwk);
  const repository = new MemorySponsorshipClaimRepository({ receivers: [{ accountId: "receiver_1", receiverProfileId: "profile_1", installationId: "install_1", consentVersion: 2, status: "active" }] });
  const grantKeys = generateKeyPairSync("ed25519");
  const runtime: SponsorshipRuntime = {
    environment: "test", clock: () => NOW,
    proofs: new MemoryDeviceProofRepository({ keys: [{ installationId: "install_1", accountId: "receiver_1", keyVersion: 1, publicJwk, thumbprint, algorithm: "ES256", status: "active" }] }),
    service: new SponsorshipClaimService(repository, { keyId: "grant", privateKeyPem: grantKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), claimTtlMs: 60_000, leaseTtlMs: 15_000, receiptGraceMs: 30_000, settlementReviewMs: 60_000, environment: "test", settlement: { async settle() {}, async release() {} } }),
  };
  const proofForOtherTarget = await proofHeader("GET", "/api/v1/sponsorships/other/creative", "", "bm9uY2Utd3JvbmctdGFyZ2V0LTAwMDA", thumbprint, privateKeyPem);
  const response = await createSponsorshipCreativeHandler(runtime)(new Request("https://ad.daddy/api/v1/sponsorships/claim_1/creative", {
    headers: { "x-ad-daddy-device-proof": proofForOtherTarget },
  }), { params: Promise.resolve({ claimId: "claim_1" }) });
  assert.equal(response.status, 403);
  assert.match((await response.json() as { message: string }).message, /target mismatch/i);
});

test("D1 claim persistence survives a cold repository and reconciles the identical first receipt", async () => {
  const database = new ClaimD1Fake();
  const createRepository = () => new D1SponsorshipClaimRepository(database as unknown as D1Database, {
    auctionGateway: { async ownsOpportunity() { return false; }, async ownsAuction() { return false; }, async open() { return Response.json({}); }, async read() { return Response.json({}); }, async bid() { return Response.json({}); } },
    keyId: "unused", privateKeyPem: "unused",
  });
  const record = durableClaim();
  const firstProcess = createRepository();
  await firstProcess.createOrGetClaim(record);
  const lease: SponsorshipDeliveryLease = {
    leaseId: "lease_1", claimId: record.claimId, installationId: record.installationId,
    deviceKeyThumbprint: record.deviceKeyThumbprint, creativeDigest: record.creativeDigest,
    policyVersion: "pull/v1", state: "active", issuedAt: NOW.toISOString(), expiresAt: "2026-08-15T19:01:00.000Z",
  };
  await firstProcess.issueOrGetLease(record, lease);
  const receipt = { algorithm: "ES256" as const, payload: {
    protocolVersion: 1 as const, claimId: record.claimId, grantDigest: record.grant.payload.grantDigest,
    reservationId: record.reservationId, placementId: record.placementId, creativeDigest: record.creativeDigest,
    installationId: record.installationId, deviceKeyThumbprint: record.deviceKeyThumbprint, hostKind: "codex" as const,
    hostSessionId: "thread_1", outputSha256: "b".repeat(64), adapterVersion: "0.1.0", policyVersion: "pull/v1",
    surface: "sidebar_session" as const, audience: "ad-daddy:test" as const, nonce: "display-receipt-nonce-1", displayedAt: NOW.toISOString(),
  }, signature: "signature" };
  const accepted = await firstProcess.acceptReceipt({ claim: record, lease, receipt, receiptDigest: "c".repeat(64), now: NOW,
    graceExpiresAt: "2026-08-15T19:30:00.000Z", settlementReviewDeadlineAt: "2026-08-16T19:00:00.000Z" });
  assert.equal(accepted.firstSurface, true);

  const coldProcess = createRepository();
  assert.equal((await coldProcess.getClaim(record.claimId))?.state, "consumed");
  assert.equal((await coldProcess.getLease(record.claimId))?.state, "displayed");
  const replay = await coldProcess.acceptReceipt({ claim: record, lease, receipt, receiptDigest: "c".repeat(64), now: NOW,
    graceExpiresAt: "2026-08-15T19:30:00.000Z", settlementReviewDeadlineAt: "2026-08-16T19:00:00.000Z" });
  assert.deepEqual(replay, { receiptDigest: "c".repeat(64), firstSurface: false, settlementState: "pending" });
  await assert.rejects(coldProcess.acceptReceipt({ claim: record, lease, receipt, receiptDigest: "d".repeat(64), now: NOW,
    graceExpiresAt: "2026-08-15T19:30:00.000Z", settlementReviewDeadlineAt: "2026-08-16T19:00:00.000Z" }), /first verified surface/i);
  await coldProcess.markSettled(record.claimId, NOW.toISOString());
  const settledReplay = await coldProcess.acceptReceipt({ claim: record, lease, receipt, receiptDigest: "c".repeat(64), now: NOW,
    graceExpiresAt: "2026-08-15T19:30:00.000Z", settlementReviewDeadlineAt: "2026-08-16T19:00:00.000Z" });
  assert.equal(settledReplay.settlementState, "settled");
});

test("real D1 schema atomically guards claims and durably releases expired reservations", async (context) => {
  const migrated = createMigratedD1();
  context.after(() => migrated.close());
  await seedD1Graph(migrated.database, "a");
  await seedD1Graph(migrated.database, "b");
  const grantKeys = generateKeyPairSync("ed25519");
  const repository = new D1SponsorshipClaimRepository(migrated.database, {
    auctionGateway: {
      async ownsOpportunity() { return false; }, async ownsAuction() { return false; },
      async open() { return Response.json({}); }, async read() { return Response.json({}); }, async bid() { return Response.json({}); },
    },
    keyId: "grant_1",
    privateKeyPem: grantKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    clock: () => NOW,
  });
  const service = new SponsorshipClaimService(repository, {
    keyId: "grant_1",
    privateKeyPem: grantKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    claimTtlMs: 60_000,
    leaseTtlMs: 15_000,
    receiptGraceMs: 30_000,
    settlementReviewMs: 60_000,
    environment: "test",
    settlement: new D1SponsorshipSettlementGateway(migrated.database),
  });

  const claimed = await repository.createOrGetClaim(durableClaim("a"));
  assert.equal(claimed.claimId, "claim_a");
  await service.expire(new Date(NOW.getTime() + 61_000));
  assert.equal(await d1Value(migrated.database, "SELECT state FROM placement_claims WHERE id = ?", "claim_a"), "expired");
  assert.equal(await d1Value(migrated.database, "SELECT status FROM campaign_budget_reservations WHERE id = ?", "reservation_a"), "released");
  assert.equal(await d1Value(migrated.database, "SELECT state FROM opportunities WHERE id = ?", "opportunity_b"), "expired");
  assert.equal(await d1Value(migrated.database, "SELECT status FROM campaign_budget_reservations WHERE id = ?", "reservation_b"), "released");
  await assert.rejects(repository.createOrGetClaim(durableClaim("b")), /persistence failed/i);
});

async function provedRequest(method: string, target: string, body: string, nonce: string, thumbprint: string, privateKeyPem: string, identity?: { installationId: string; consentVersion: number }) {
  return new Request(`https://ad.daddy${target}`, {
    method, headers: { "content-type": "application/json", "x-ad-daddy-device-proof": await proofHeader(method, target, body, nonce, thumbprint, privateKeyPem, identity) },
    ...(method === "GET" ? {} : { body }),
  });
}

async function proofHeader(method: string, target: string, body: string, nonce: string, thumbprint: string, privateKeyPem: string, identity?: { installationId: string; consentVersion: number }) {
  const envelope: DeviceProofEnvelope = {
    method, target, audience: "ad-daddy:test", bodyDigest: await sha256BodyDigest(body), installationId: identity?.installationId ?? "install_1",
    consentVersion: identity?.consentVersion ?? 2, keyThumbprint: thumbprint, nonce, issuedAt: "2026-08-15T18:59:30.000Z", expiresAt: "2026-08-15T19:01:00.000Z",
  };
  const signature = nodeSign("sha256", Buffer.from(canonicalizeDeviceProofEnvelope(envelope)), { key: privateKeyPem, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return Buffer.from(JSON.stringify({ envelope, signature })).toString("base64url");
}

function winner(opportunityId: string): Extract<SponsorshipOutcome, { status: "winner" }> {
  return { status: "winner", opportunityId, auctionId: `auction:${opportunityId}`, placementId: "placement_1", campaignId: "campaign_1",
    reservationId: "reservation_1", eligibleBidderCount: 2, rewardType: "stablecoin", grossAmountMinor: 625,
    receiverAmountMinor: 500, operatorAmountMinor: 125, currency: "USD", signedPlacement: {
      algorithm: "Ed25519", keyId: "placement_key", signature: "x".repeat(64), payload: {
        protocolVersion: 1, placementId: "placement_1", advertiser: { id: "advertiser_1", displayName: "Neon" },
        title: "Database branches", contentReference: "https://creative.ad-daddy.test/p/1", destinationUrl: "https://neon.tech",
        disclosure: "Sponsored", payout: { amountMinor: 500, currency: "USD" }, signalsUsed: ["TypeScript"],
        creative: { body: "Create a preview database branch.", attachments: [] },
        issuedAt: "2026-08-15T18:59:00.000Z", expiresAt: "2026-08-16T19:00:00.000Z",
      },
    } };
}

function durableClaim(suffix = "1"): SponsorshipClaimRecord {
  const id = (prefix: string) => `${prefix}_${suffix}`;
  const grant = { algorithm: "Ed25519" as const, keyId: "grant_1", signature: "signature", payload: {
    protocolVersion: 1 as const, receiverAccountId: id("receiver"), receiverProfileId: id("profile"), installationId: id("install"),
    deviceKeyThumbprint: id("thumbprint"), consentVersion: 2, opportunityId: id("opportunity"), placementId: id("placement"),
    campaignId: id("campaign"), reservationId: id("reservation"), rewardType: "stablecoin" as const, grossAmountMinor: 625,
    receiverAmountMinor: 500, operatorAmountMinor: 125, currency: "USD" as const, creativeDigest: "a".repeat(64),
    eligibleBidderCount: 2, grantDigest: "b".repeat(64), issuedAt: NOW.toISOString(), expiresAt: "2026-08-15T19:01:00.000Z",
  } } satisfies SignedSponsorshipGrant;
  return { claimId: id("claim"), placementId: id("placement"), opportunityId: id("opportunity"), reservationId: id("reservation"),
    receiverProfileId: id("profile"), installationId: id("install"), consentVersion: 2, deviceKeyThumbprint: id("thumbprint"),
    creativeDigest: "a".repeat(64), state: "claimed", grant, issuedAt: NOW.toISOString(), expiresAt: "2026-08-15T19:01:00.000Z" };
}

async function seedD1Graph(database: D1Database, suffix: string) {
  const id = (prefix: string) => `${prefix}_${suffix}`;
  const placement = structuredClone(winner(id("opportunity")).signedPlacement);
  placement.payload.placementId = id("placement");
  const statements: Array<[string, unknown[]]> = [
    ["INSERT INTO human_accounts (id, status) VALUES (?, 'active')", [id("receiver")]],
    ["INSERT INTO human_accounts (id, status) VALUES (?, 'active')", [id("advertiser")]],
    ["INSERT INTO installations (id, account_id, public_key, key_version, host_kind, status) VALUES (?, ?, ?, 1, 'codex', 'active')", [id("install"), id("receiver"), "legacy-key"]],
    ["INSERT INTO receiver_profiles (id, account_id, installation_id, status, current_consent_version) VALUES (?, ?, ?, 'active', 2)", [id("profile"), id("receiver"), id("install")]],
    ["INSERT INTO receiver_consent_versions (receiver_profile_id, version, previous_version, status, terms_version, privacy_version, consented_fields_json, accepted_at) VALUES (?, 1, NULL, 'paused', 'terms/v1', 'privacy/v1', '{}', ?)", [id("profile"), new Date(NOW.getTime() - 1_000).toISOString()]],
    ["INSERT INTO receiver_consent_versions (receiver_profile_id, version, previous_version, status, terms_version, privacy_version, consented_fields_json, accepted_at) VALUES (?, 2, 1, 'active', 'terms/v1', 'privacy/v1', '{}', ?)", [id("profile"), NOW.toISOString()]],
    ["INSERT INTO advertiser_brands (id, account_id, name, verified_domain, ownership_status, verified_at) VALUES (?, ?, 'Neon', ?, 'verified', ?)", [id("brand"), id("advertiser"), `${suffix}.example.test`, NOW.toISOString()]],
    [`INSERT INTO campaigns (id, account_id, brand_id, status, advertiser_terms_version, destination_url,
       schedule_starts_at, schedule_ends_at, audience_json, offer_json, creative_json, conversion_terms,
       maximum_spend_minor, maximum_bid_minor, daily_cap_minor, funded_minor, spent_minor)
       VALUES (?, ?, ?, 'active', 'terms/v1', 'https://neon.tech', ?, ?, '{}', '{}', ?, 'none', 10000, 1000, 10000, 10000, 0)`,
      [id("campaign"), id("advertiser"), id("brand"), new Date(NOW.getTime() - 60_000).toISOString(), new Date(NOW.getTime() + 86_400_000).toISOString(), JSON.stringify({ headline: "Database branches", body: "Create a preview database branch." })]],
    ["INSERT INTO campaign_budget_reservations (id, campaign_id, idempotency_key, amount_minor, budget_day, status) VALUES (?, ?, ?, 625, '2026-08-15', 'reserved')", [id("reservation"), id("campaign"), id("reservation-key")]],
    ["INSERT OR IGNORE INTO revenue_split_versions (version, receiver_basis_points, operator_basis_points, effective_at) VALUES ('launch-80-20/v1', 8000, 2000, ?)", [NOW.toISOString()]],
    ["INSERT INTO opportunities (id, rotating_opportunity_id, receiver_profile_id, installation_id, consent_version, state, opened_at, expires_at) VALUES (?, ?, ?, ?, 2, 'won', ?, ?)", [id("opportunity"), id("rotating"), id("profile"), id("install"), NOW.toISOString(), new Date(NOW.getTime() + 60_000).toISOString()]],
    ["INSERT INTO auctions (id, opportunity_id, reward_lane, consent_version, minimum_take_home_minor, matched_signal_names_json, status, closes_at, decided_at) VALUES (?, ?, 'stablecoin', 2, 500, '[\"TypeScript\"]', 'decided', ?, ?)", [id("auction"), id("opportunity"), new Date(NOW.getTime() + 15_000).toISOString(), NOW.toISOString()]],
    ["INSERT INTO auction_bids (id, auction_id, campaign_id, reward_lane, gross_amount_minor, receiver_amount_minor, operator_amount_minor, submitted_at) VALUES (?, ?, ?, 'stablecoin', 625, 500, 125, ?)", [id("bid"), id("auction"), id("campaign"), NOW.toISOString()]],
    ["INSERT INTO auction_decisions (id, auction_id, winner_bid_id, reservation_id, eligible_bidder_count, decided_at) VALUES (?, ?, ?, ?, 2, ?)", [id("decision"), id("auction"), id("bid"), id("reservation"), NOW.toISOString()]],
    [`INSERT INTO placements (id, opportunity_id, consent_version, revenue_split_version, state, idempotency_key,
       gross_amount_minor, receiver_amount_minor, operator_amount_minor, currency, delivery_status, signed_placement_json)
       VALUES (?, ?, 2, 'launch-80-20/v1', 'won', ?, 625, 500, 125, 'USD', 'ready', ?)`,
      [id("placement"), id("opportunity"), id("placement-key"), JSON.stringify(placement)]],
  ];
  for (const [query, values] of statements) await database.prepare(query).bind(...values).run();
}

async function d1Value(database: D1Database, query: string, value: string) {
  const row = await database.prepare(query).bind(value).first<Record<string, unknown>>();
  return row ? Object.values(row)[0] : undefined;
}

class ClaimD1Fake {
  claim?: SponsorshipClaimRecord;
  lease?: SponsorshipDeliveryLease;
  recovery?: { receiptDigest: string; state: string };

  prepare(query: string) {
    const sql = query.replace(/\s+/g, " ").trim();
    let bindings: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => { bindings = values; return statement; },
      run: async () => this.run(sql, bindings),
      first: async <T>() => this.first(sql, bindings) as T | null,
      all: async <T>() => ({ results: [] as T[] }),
    };
    return statement;
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) { return Promise.all(statements.map((statement) => statement.run())); }

  private run(sql: string, values: unknown[]) {
    if (sql.startsWith("INSERT INTO placement_claims")) {
      if (!this.claim) this.claim = { claimId: values[0] as string, placementId: values[1] as string, opportunityId: values[2] as string,
        reservationId: values[3] as string, receiverProfileId: values[4] as string, installationId: values[5] as string,
        consentVersion: values[6] as number, deviceKeyThumbprint: values[7] as string, creativeDigest: values[8] as string,
        state: "claimed", grant: JSON.parse(values[9] as string), issuedAt: values[10] as string, expiresAt: values[11] as string };
      return result(this.claim.claimId === values[0] ? 1 : 0);
    }
    if (sql.startsWith("INSERT INTO placement_delivery_leases")) {
      if (!this.lease) this.lease = { leaseId: values[0] as string, claimId: values[1] as string, installationId: values[2] as string,
        deviceKeyThumbprint: values[3] as string, creativeDigest: values[4] as string, policyVersion: values[5] as string,
        state: "active", issuedAt: values[6] as string, expiresAt: values[7] as string };
      return result(1);
    }
    if (sql.startsWith("INSERT INTO placement_receipt_recovery")) {
      if (this.recovery) return result(0);
      this.recovery = { receiptDigest: values[3] as string, state: "submitted" };
      return result(1);
    }
    if (sql.startsWith("UPDATE placement_claims SET state = 'delivery_leased'")) { if (this.claim?.state === "claimed") this.claim.state = "delivery_leased"; return result(1); }
    if (sql.startsWith("UPDATE placement_claims SET state = 'consumed'")) { if (this.claim) this.claim.state = "consumed"; return result(1); }
    if (sql.startsWith("UPDATE placement_delivery_leases SET state = 'displayed'")) { if (this.lease) this.lease.state = "displayed"; return result(1); }
    if (sql.startsWith("UPDATE placement_receipt_recovery SET state = 'settled'")) { if (this.recovery) this.recovery.state = "settled"; return result(1); }
    return result(1);
  }

  private first(sql: string, values: unknown[]) {
    if (sql.includes("FROM placement_claims pc") && this.claim && (values[0] === this.claim.claimId || values[0] === this.claim.opportunityId)) {
      return { ...this.claim, grantJson: JSON.stringify(this.claim.grant), state: this.claim.state };
    }
    if (sql.includes("FROM placement_delivery_leases") && this.lease && values[0] === this.lease.claimId) return { ...this.lease };
    if (sql.includes("FROM placement_receipt_recovery") && this.recovery) return { receiptDigest: this.recovery.receiptDigest, state: this.recovery.state };
    return null;
  }
}

function result(changes: number) { return { success: true, meta: { changes } }; }
