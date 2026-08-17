import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createPlacementReceiptHandler } from "../../app/api/v1/placements/[id]/receipt/route.ts";
import { CredentialLifecycleService } from "../../lib/auth/credential-lifecycle.ts";
import { PlacementBlocklist } from "../../lib/marketplace/blocking.ts";
import { MemoryPlacementDeliveryRepository, PlacementDeliveryService, type PlacementDeliveryRecord } from "../../lib/marketplace/placement-delivery.ts";
import { MarketplaceSigningKeys, enrollMarketplacePublicKey, signPlacement } from "../../lib/marketplace/signing-keys.ts";
import { LifecycleEventStore } from "../../lib/observability/events.ts";
import type { PlacementPayload } from "../../packages/host-adapters/src/contract.ts";

const NOW = new Date("2026-08-15T12:00:00.000Z");

test("report and block preserve the receipt, stop later ads, and expose only aggregate telemetry", async () => {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const credentials = new CredentialLifecycleService();
  enrollMarketplacePublicKey(credentials, { credentialId: "cred", keyId: "key", publicKeyPem, environment: "test", now: NOW });
  const repository = new MemoryPlacementDeliveryRepository();
  const blocklist = new PlacementBlocklist();
  const events = new LifecycleEventStore();
  const service = new PlacementDeliveryService(repository, new MarketplaceSigningKeys(credentials, "test"), {
    creativeOrigins: ["https://creative.ad-daddy.test"], verifiedDestinationDomains: ["neon.tech"],
    approvedPackages: [], approvedPackageDomains: [],
  }, blocklist);
  const first = signPlacement(payload("placement_1"), { keyId: "key", privateKeyPem });
  await service.prepare({ receiverAccountId: "receiver_1", placement: first, now: NOW });
  await service.deliverFallback("placement_1", "https://creative.ad-daddy.test/placements/placement_1", NOW);

  const handler = createPlacementReceiptHandler(repository, blocklist, events);
  const post = (action: string) => handler(new Request("https://ad-daddy.test/api/v1/placements/placement_1/receipt", {
    method: "POST", headers: { "content-type": "application/json", "x-ad-daddy-verified-account-id": "receiver_1" }, body: JSON.stringify({ action }),
  }), { params: Promise.resolve({ id: "placement_1" }) });
  assert.equal((await post("report")).status, 200);
  assert.equal((await post("block_advertiser")).status, 200);
  const historical = await repository.get("placement_1");
  assert.equal(historical?.status, "blocked");
  assert.equal(historical?.receipt?.placementId, "placement_1");
  assert.equal(blocklist.isBlocked("receiver_1", "adv_neon"), true);

  await assert.rejects(service.prepare({
    receiverAccountId: "receiver_1",
    placement: signPlacement(payload("placement_2"), { keyId: "key", privateKeyPem }),
    now: NOW,
  }), /blocked/);

  const unshown = signPlacement(payload("placement_blocked_before_delivery"), { keyId: "key", privateKeyPem });
  const unblockedService = new PlacementDeliveryService(repository, new MarketplaceSigningKeys(credentials, "test"), {
    creativeOrigins: ["https://creative.ad-daddy.test"], verifiedDestinationDomains: ["neon.tech"],
    approvedPackages: [], approvedPackageDomains: [],
  });
  await unblockedService.prepare({ receiverAccountId: "receiver_2", placement: unshown, now: NOW });
  await unblockedService.receiverAction("placement_blocked_before_delivery", "receiver_2", "hide", NOW);
  await assert.rejects(
    unblockedService.deliverFallback("placement_blocked_before_delivery", "https://creative.ad-daddy.test/placements/placement_blocked_before_delivery", NOW),
    /blocked/,
  );
  assert.equal((await repository.get("placement_blocked_before_delivery"))?.receipt, undefined);
  events.record({ eventId: "pause:receiver_1:2", type: "receiver_paused", occurredAt: NOW.toISOString(), receiverAccountId: "receiver_1" });
  assert.deepEqual(events.aggregate(), { placement_reported: 1, advertiser_blocked: 1, receiver_paused: 1 });
  assert.doesNotMatch(JSON.stringify(events.aggregate()), /receiver_1|adv_neon/);
});

test("a receiver action is serialized with an in-flight delivery and preserves its receipt", async () => {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const credentials = new CredentialLifecycleService();
  enrollMarketplacePublicKey(credentials, { credentialId: "race_cred", keyId: "race_key", publicKeyPem, environment: "test", now: NOW });
  const repository = new GatedFallbackRepository();
  const service = new PlacementDeliveryService(repository, new MarketplaceSigningKeys(credentials, "test"), {
    creativeOrigins: ["https://creative.ad-daddy.test"], verifiedDestinationDomains: ["neon.tech"],
    approvedPackages: [], approvedPackageDomains: [],
  });
  await service.prepare({
    receiverAccountId: "receiver_race",
    placement: signPlacement(payload("placement_race"), { keyId: "race_key", privateKeyPem }),
    now: NOW,
  });
  repository.arm();

  const delivery = service.deliverFallback("placement_race", "https://creative.ad-daddy.test/placements/placement_race", NOW);
  await repository.fallbackPutStarted;
  const action = createPlacementReceiptHandler(repository)(new Request("https://ad-daddy.test/api/v1/placements/placement_race/receipt", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ad-daddy-verified-account-id": "receiver_race" },
    body: JSON.stringify({ action: "hide" }),
  }), { params: Promise.resolve({ id: "placement_race" }) });
  await new Promise<void>((resolve) => setImmediate(resolve));
  repository.releaseFallbackPut();
  await Promise.all([delivery, action]);

  const record = await repository.get("placement_race");
  assert.equal(record?.status, "blocked");
  assert.equal(record?.receipt?.placementId, "placement_race");
});

class GatedFallbackRepository extends MemoryPlacementDeliveryRepository {
  #armed = false;
  #release!: () => void;
  #started!: () => void;
  readonly #gate = new Promise<void>((resolve) => { this.#release = resolve; });
  readonly fallbackPutStarted = new Promise<void>((resolve) => { this.#started = resolve; });
  arm() { this.#armed = true; }
  releaseFallbackPut() { this.#release(); }
  override async put(record: PlacementDeliveryRecord) {
    if (this.#armed && record.status === "fallback") {
      this.#started();
      await this.#gate;
    }
    await super.put(record);
  }
}

function payload(placementId: string): PlacementPayload {
  return {
    protocolVersion: 1, placementId, advertiser: { id: "adv_neon", displayName: "Neon" }, title: "Postgres branches",
    contentReference: `https://creative.ad-daddy.test/placements/${placementId}`, destinationUrl: "https://neon.tech/docs",
    disclosure: "Sponsored", payout: { amountMinor: 500, currency: "USD" }, signalsUsed: ["Postgres"],
    creative: { body: "Create a branch for every preview.", attachments: [] },
    issuedAt: "2026-08-15T00:00:00.000Z", expiresAt: "2026-08-16T00:00:00.000Z",
  };
}
