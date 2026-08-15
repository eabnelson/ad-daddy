import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import type { SignedPlacement } from "@ad-daddy/host-adapters";
import {
  MemorySponsorshipClaimRepository,
  SponsorshipClaimService,
  signDisplayReceipt,
  verifySponsorshipGrant,
  type SponsorshipOutcome,
} from "../../lib/marketplace/sponsorship-claims.ts";

const NOW = new Date("2026-08-15T18:00:00.000Z");

test("pull coalesces one opportunity, stays pending, then reuses one winner reservation and claim", async () => {
  const fixture = setup();
  const first = await fixture.service.next(fixture.device, NOW);
  const retry = await fixture.service.next(fixture.device, NOW);
  assert.deepEqual(first, retry);
  assert.equal(first.status, "pending");
  assert.equal(fixture.repository.opportunityCount, 1);

  fixture.repository.setOutcome(fixture.opportunityId, fixture.outcome);
  const [won, raced] = await Promise.all([
    fixture.service.next(fixture.device, new Date(NOW.getTime() + 1_000)),
    fixture.service.next(fixture.device, new Date(NOW.getTime() + 1_000)),
  ]);
  assert.equal(won.status, "ready");
  assert.deepEqual(won, raced);
  assert.equal(fixture.repository.claimCount, 1);
  assert.equal(won.status === "ready" && won.grant.payload.reservationId, "reservation_1");
});

test("signed grant verification covers receiver, reservation, economics, creative digest, and expiry", async () => {
  const fixture = setup();
  await fixture.service.next(fixture.device, NOW);
  fixture.repository.setOutcome(fixture.opportunityId, fixture.outcome);
  const ready = await fixture.service.next(fixture.device, NOW, fixture.opportunityId);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  const verified = verifySponsorshipGrant(ready.grant, fixture.grantPublicKey, NOW);
  assert.equal(verified.receiverAccountId, "receiver_1");
  assert.equal(verified.reservationId, "reservation_1");
  assert.equal(verified.receiverAmountMinor, 500);
  assert.equal(verified.creativeDigest, ready.grant.payload.creativeDigest);
  await assert.rejects(async () => verifySponsorshipGrant({
    ...ready.grant, payload: { ...ready.grant.payload, receiverAmountMinor: 501 },
  }, fixture.grantPublicKey, NOW), /signature|digest|malformed/i);
  assert.throws(
    () => verifySponsorshipGrant(ready.grant, fixture.grantPublicKey, new Date(Date.parse(ready.grant.payload.expiresAt))),
    /expired/i,
  );
});

test("creative redemption is device-bound, rechecks consent and issues one short lease", async () => {
  const fixture = setup();
  await fixture.service.next(fixture.device, NOW);
  fixture.repository.setOutcome(fixture.opportunityId, fixture.outcome);
  const pulled = await fixture.service.next(fixture.device, NOW);
  assert.equal(pulled.status, "ready");
  if (pulled.status !== "ready") return;

  const [first, replay] = await Promise.all([
    fixture.service.creative(pulled.claimId, fixture.device, NOW),
    fixture.service.creative(pulled.claimId, fixture.device, NOW),
  ]);
  assert.deepEqual(first, replay);
  assert.equal(first.lease.claimId, pulled.claimId);
  await assert.rejects(
    fixture.service.creative(pulled.claimId, { ...fixture.device, installationId: "install_other" }, NOW),
    /claim.*device|installation/i,
  );
  fixture.repository.pause("install_1");
  await assert.rejects(fixture.service.creative(pulled.claimId, fixture.device, NOW), /active consent/i);
});

test("first signed display receipt wins and base settlement is retried exactly once after a crash", async () => {
  const fixture = setup({ failFirstSettlement: true });
  await fixture.service.next(fixture.device, NOW);
  fixture.repository.setOutcome(fixture.opportunityId, fixture.outcome);
  const pulled = await fixture.service.next(fixture.device, NOW);
  assert.equal(pulled.status, "ready");
  if (pulled.status !== "ready") return;
  await fixture.service.creative(pulled.claimId, fixture.device, NOW);
  const receipt = signDisplayReceipt(fixture.receiptPayload(pulled.claimId, pulled.grant.payload.grantDigest, pulled.grant.payload.creativeDigest), fixture.devicePrivateKey);

  await assert.rejects(fixture.service.receipt(pulled.claimId, fixture.device, receipt, NOW), /injected settlement crash/);
  const settled = await fixture.service.receipt(pulled.claimId, fixture.device, receipt, NOW);
  assert.equal(settled.status, "settled");
  assert.equal((await fixture.service.receipt(pulled.claimId, fixture.device, receipt, new Date(NOW.getTime() + 50_000))).status, "settled");
  assert.equal(fixture.settlementAttempts, 2);
  assert.equal(fixture.settlementSuccesses, 1);

  const secondSurface = signDisplayReceipt({
    ...fixture.receiptPayload(pulled.claimId, pulled.grant.payload.grantDigest, pulled.grant.payload.creativeDigest),
    hostSessionId: "thread_other",
    nonce: "receipt-nonce-other",
  }, fixture.devicePrivateKey);
  await assert.rejects(fixture.service.receipt(pulled.claimId, fixture.device, secondSurface, NOW), /first verified surface/i);
});

test("a leased display can submit offline during grace and otherwise moves to review without release", async () => {
  const offline = setup();
  await offline.service.next(offline.device, NOW);
  offline.repository.setOutcome(offline.opportunityId, offline.outcome);
  const ready = await offline.service.next(offline.device, NOW, offline.opportunityId);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  await offline.service.creative(ready.claimId, offline.device, NOW);
  const receipt = signDisplayReceipt(
    offline.receiptPayload(ready.claimId, ready.grant.payload.grantDigest, ready.grant.payload.creativeDigest),
    offline.devicePrivateKey,
  );
  assert.equal((await offline.service.receipt(ready.claimId, offline.device, receipt, new Date(NOW.getTime() + 20_000))).status, "settled");

  const missingReceipt = setup();
  await missingReceipt.service.next(missingReceipt.device, NOW);
  missingReceipt.repository.setOutcome(missingReceipt.opportunityId, missingReceipt.outcome);
  const leased = await missingReceipt.service.next(missingReceipt.device, NOW, missingReceipt.opportunityId);
  assert.equal(leased.status, "ready");
  if (leased.status !== "ready") return;
  await missingReceipt.service.creative(leased.claimId, missingReceipt.device, NOW);
  await missingReceipt.service.expire(new Date(NOW.getTime() + 40_000));
  assert.equal((await missingReceipt.repository.getClaim(leased.claimId))?.state, "delivery_leased");
  await missingReceipt.service.expire(new Date(NOW.getTime() + 46_000));
  assert.equal((await missingReceipt.repository.getClaim(leased.claimId))?.state, "settlement_review");
  assert.equal(missingReceipt.releases, 0);
});

test("unredeemed expiry releases once while displayed receipt recovery moves to review", async () => {
  const fixture = setup();
  await fixture.service.next(fixture.device, NOW);
  fixture.repository.setOutcome(fixture.opportunityId, fixture.outcome);
  const pulled = await fixture.service.next(fixture.device, NOW);
  assert.equal(pulled.status, "ready");
  if (pulled.status !== "ready") return;
  await fixture.service.expire(new Date(NOW.getTime() + 61_000));
  await fixture.service.expire(new Date(NOW.getTime() + 62_000));
  assert.equal(fixture.releases, 1);

  const recovery = setup();
  await recovery.service.next(recovery.device, NOW);
  recovery.repository.setOutcome(recovery.opportunityId, recovery.outcome);
  const ready = await recovery.service.next(recovery.device, NOW);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  await recovery.service.creative(ready.claimId, recovery.device, NOW);
  await recovery.repository.recordDisplayedPendingReceipt(ready.claimId, "display-digest", NOW);
  await recovery.service.expire(new Date(NOW.getTime() + 61_000));
  assert.equal((await recovery.repository.getClaim(ready.claimId))?.state, "settlement_review");
  assert.equal(recovery.releases, 0);
});

test("explicit opportunity follow-up crosses a bucket boundary without opening or claiming new inventory", async () => {
  const fixture = setup();
  const nearBoundary = new Date(NOW.getTime() + 59_500);
  const pending = await fixture.service.next(fixture.device, nearBoundary);
  assert.equal(pending.status, "pending");
  fixture.repository.setOutcome(fixture.opportunityId, fixture.outcome);
  const coalesced = await fixture.service.next(fixture.device, new Date(NOW.getTime() + 60_500));
  assert.equal(coalesced.status, "ready");
  assert.equal(fixture.repository.opportunityCount, 1);
  const ready = await fixture.service.next(fixture.device, new Date(NOW.getTime() + 60_500), fixture.opportunityId);
  assert.equal(ready.status, "ready");
  assert.equal(fixture.repository.opportunityCount, 1);
  assert.equal(fixture.repository.claimCount, 1);
});

test("a cleared winner that is never followed up releases its reservation once", async () => {
  const fixture = setup();
  await fixture.service.next(fixture.device, NOW);
  fixture.repository.setOutcome(fixture.opportunityId, fixture.outcome);
  await fixture.service.expire(new Date(NOW.getTime() + 60_001));
  await fixture.service.expire(new Date(NOW.getTime() + 61_000));
  assert.equal(fixture.repository.claimCount, 0);
  assert.equal(fixture.releases, 1);
});

test("claimed and unclaimed expiry retry a transient release failure before becoming terminal", async () => {
  const claimed = setup({ failFirstRelease: true });
  await claimed.service.next(claimed.device, NOW);
  claimed.repository.setOutcome(claimed.opportunityId, claimed.outcome);
  const ready = await claimed.service.next(claimed.device, NOW, claimed.opportunityId);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  await assert.rejects(claimed.service.expire(new Date(NOW.getTime() + 60_001)), /injected release failure/);
  assert.equal((await claimed.repository.getClaim(ready.claimId))?.state, "expired");
  assert.equal((await claimed.service.next(claimed.device, NOW, claimed.opportunityId)).status, "no_fill");
  await claimed.service.expire(new Date(NOW.getTime() + 61_000));
  assert.equal(claimed.releaseAttempts, 2);
  assert.equal(claimed.releases, 1);

  const unclaimed = setup({ failFirstRelease: true });
  await unclaimed.service.next(unclaimed.device, NOW);
  unclaimed.repository.setOutcome(unclaimed.opportunityId, unclaimed.outcome);
  await assert.rejects(unclaimed.service.expire(new Date(NOW.getTime() + 60_001)), /injected release failure/);
  await unclaimed.service.expire(new Date(NOW.getTime() + 61_000));
  assert.equal(unclaimed.releaseAttempts, 2);
  assert.equal(unclaimed.releases, 1);
});

test("an expired stored claim cannot be replayed as a fresh ready grant", async () => {
  const fixture = setup();
  await fixture.service.next(fixture.device, NOW);
  fixture.repository.setOutcome(fixture.opportunityId, fixture.outcome);
  assert.equal((await fixture.service.next(fixture.device, NOW, fixture.opportunityId)).status, "ready");
  const replay = await fixture.service.next(fixture.device, new Date(NOW.getTime() + 61_000), fixture.opportunityId);
  assert.equal(replay.status, "no_fill");
  assert.equal(fixture.repository.claimCount, 1);
});

function setup(options: { failFirstSettlement?: boolean; failFirstRelease?: boolean } = {}) {
  const grantKeys = generateKeyPairSync("ed25519");
  const grantPublicKey = grantKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const deviceKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const devicePublicJwk = deviceKeys.publicKey.export({ format: "jwk" });
  const devicePrivateKey = deviceKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const opportunityId = `opportunity:install_1:4:${Math.floor(NOW.getTime() / 60_000)}`;
  const repository = new MemorySponsorshipClaimRepository({
    receivers: [{ accountId: "receiver_1", receiverProfileId: "profile_1", installationId: "install_1", consentVersion: 4, status: "active" }],
    opportunityWindowMs: 60_000,
  });
  const placement = signedPlacement();
  const outcome: SponsorshipOutcome = {
    status: "winner", opportunityId, auctionId: "auction_1", placementId: "placement_1", campaignId: "campaign_1",
    reservationId: "reservation_1", eligibleBidderCount: 3, rewardType: "stablecoin",
    grossAmountMinor: 625, receiverAmountMinor: 500, operatorAmountMinor: 125, currency: "USD", signedPlacement: placement,
  };
  let releases = 0;
  let releaseAttempts = 0;
  let settlementAttempts = 0;
  let settlementSuccesses = 0;
  const service = new SponsorshipClaimService(repository, {
    keyId: "grant_key_1",
    privateKeyPem: grantKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    claimTtlMs: 60_000,
    leaseTtlMs: 15_000,
    receiptGraceMs: 30_000,
    settlementReviewMs: 60_000,
    settlement: {
      async settle() {
        settlementAttempts += 1;
        if (options.failFirstSettlement && settlementAttempts === 1) throw new Error("injected settlement crash");
        settlementSuccesses += 1;
      },
      async release() {
        releaseAttempts += 1;
        if (options.failFirstRelease && releaseAttempts === 1) throw new Error("injected release failure");
        releases += 1;
      },
    },
  });
  const device = {
    accountId: "receiver_1", installationId: "install_1", consentVersion: 4,
    deviceKeyThumbprint: "thumbprint_1", devicePublicJwk,
  };
  return {
    repository, service, opportunityId, outcome, device, devicePrivateKey, grantPublicKey,
    get releases() { return releases; }, get releaseAttempts() { return releaseAttempts; }, get settlementAttempts() { return settlementAttempts; }, get settlementSuccesses() { return settlementSuccesses; },
    receiptPayload: (claimId: string, grantDigest: string, creativeDigest: string) => ({
      protocolVersion: 1 as const, claimId, grantDigest, reservationId: "reservation_1", placementId: "placement_1",
      creativeDigest, installationId: "install_1", deviceKeyThumbprint: "thumbprint_1",
      hostKind: "codex" as const, hostSessionId: "thread_1", hostTurnId: "turn_1", outputSha256: "a".repeat(64),
      adapterVersion: "0.1.0", policyVersion: "pull/v1", surface: "sidebar_session" as const,
      audience: "ad-daddy:test" as const, nonce: "receipt-nonce-1", displayedAt: NOW.toISOString(),
    }),
  };
}

function signedPlacement(): SignedPlacement {
  return {
    algorithm: "Ed25519", keyId: "placement_key", signature: "x".repeat(64),
    payload: {
      protocolVersion: 1, placementId: "placement_1", advertiser: { id: "advertiser_1", displayName: "Neon" },
      title: "Ship a database branch", contentReference: "https://creative.ad-daddy.test/p/1", destinationUrl: "https://neon.tech",
      disclosure: "Sponsored", payout: { amountMinor: 500, currency: "USD" }, signalsUsed: ["TypeScript"],
      creative: { body: "Create a branch for this preview.", attachments: [] },
      issuedAt: "2026-08-15T17:59:00.000Z", expiresAt: "2026-08-16T18:00:00.000Z",
    },
  };
}
