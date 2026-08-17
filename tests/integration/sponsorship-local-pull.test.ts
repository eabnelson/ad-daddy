import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalJson,
  type ClaimedPlacementEnvelope,
  type LocalPlacementDeliveryResult,
  type SignedPlacement,
  type SignedSponsorshipGrant,
} from "../../packages/host-adapters/dist/index.js";
import { InMemoryDeviceKeyProvider } from "../../packages/cli/dist/device-key.js";
import {
  JsonSponsorshipPullStateStore,
  SponsorshipPullClient,
  type LocalSponsorshipIdentity,
} from "../../packages/cli/dist/sponsorship-pull.js";
import {
  MemoryDeviceProofRepository,
  sha256BodyDigest,
  verifyDeviceProof,
  type SignedDeviceProof,
} from "../../lib/auth/device-proof.ts";
import { verifyDisplayReceipt, type SignedDisplayReceipt } from "../../lib/marketplace/sponsorship-claims.ts";

const NOW = new Date("2026-08-15T20:00:00.000Z");

test("receiver pull preserves the signed receipt after retryable HTTP failure and recovers without redisplay", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-pull-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const deviceProvider = new InMemoryDeviceKeyProvider();
  const credential = await deviceProvider.createOrLoad("install_local");
  const identity = localIdentity(credential.credentialReference, credential.keyThumbprint);
  const proofs = new MemoryDeviceProofRepository({ keys: [{
    installationId: identity.installationId, accountId: identity.receiverAccountId, keyVersion: 1,
    publicJwk: credential.publicJwk, thumbprint: credential.keyThumbprint, algorithm: "ES256", status: "active",
  }] });
  const marketplace = generateKeyPairSync("ed25519");
  const publicKeyPem = marketplace.publicKey.export({ type: "spki", format: "pem" }).toString();
  const envelope = claimedEnvelope(identity, marketplace.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const state = new JsonSponsorshipPullStateStore(join(directory, "pull-state.json"));
  let nextCalls = 0;
  let receiptCalls = 0;
  let deliveries = 0;
  let failFirstReceipt = true;
  let currentTime = NOW;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const target = `${new URL(request.url).pathname}${new URL(request.url).search}`;
    const body = request.method === "GET" || request.method === "DELETE" ? "" : await request.clone().text();
    await verifyProof(request, target, body, proofs, currentTime);
    if (target === "/api/v1/sponsorships/next") {
      nextCalls += 1;
      return nextCalls === 1
        ? Response.json({ status: "pending", opportunityId: "opportunity_local", retryAfterSeconds: 5 }, { status: 202 })
        : Response.json({ status: "ready", claimId: envelope.claimId, grant: envelope.grant });
    }
    if (target.endsWith("/creative") && request.method === "GET") return Response.json(envelope);
    if (target.endsWith("/receipt")) {
      receiptCalls += 1;
      const receipt = JSON.parse(body) as SignedDisplayReceipt;
      verifyDisplayReceipt(receipt, credential.publicJwk, currentTime);
      assert.equal(receipt.payload.displayedAt, new Date(NOW.getTime() + 2_000).toISOString());
      if (failFirstReceipt) {
        failFirstReceipt = false;
        return Response.json({ error: "sponsorship_receipt_pending", message: "Receipt was preserved and settlement can be retried" }, { status: 503 });
      }
      return Response.json({ status: "settled" });
    }
    throw new Error(`Unexpected request ${request.method} ${target}`);
  };
  const delivery = {
    async deliver(): Promise<LocalPlacementDeliveryResult> {
      deliveries += 1;
      currentTime = new Date(NOW.getTime() + 2_000);
      return nativeDelivery(envelope.placement);
    },
  };
  const makeClient = () => new SponsorshipPullClient({
    identity, environment: "test", provider: deviceProvider, marketplacePublicKeyPem: publicKeyPem,
    apiBaseUrl: "https://ad.daddy", fetch: fetch as typeof globalThis.fetch, state, delivery,
    readCurrentIdentity: async () => ({ ...identity, status: "active" }),
    clock: () => currentTime,
  });

  assert.deepEqual(await makeClient().check(NOW), { status: "pending", opportunityId: "opportunity_local", retryAfterSeconds: 5 });
  await assert.rejects(makeClient().check(NOW), /receipt was preserved/i);
  assert.equal(deliveries, 1);
  assert.ok((await state.get(identity.installationId))?.signedReceipt, "receipt is durable before network submission");
  const recovered = await makeClient().check(NOW);
  assert.equal(recovered.status, "settled");
  assert.equal(recovered.recoveredReceipt, true);
  assert.equal("delivery" in recovered, false, "receipt recovery does not fabricate a host delivery result");
  assert.equal(deliveries, 1, "restart submits the receipt without displaying again");
  assert.equal(receiptCalls, 2);
  assert.equal(await state.get(identity.installationId), undefined);
});

test("a final local pause cancels the lease before any host mutation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-pull-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const deviceProvider = new InMemoryDeviceKeyProvider();
  const credential = await deviceProvider.createOrLoad("install_local");
  const identity = localIdentity(credential.credentialReference, credential.keyThumbprint);
  const proofs = new MemoryDeviceProofRepository({ keys: [{
    installationId: identity.installationId, accountId: identity.receiverAccountId, keyVersion: 1,
    publicJwk: credential.publicJwk, thumbprint: credential.keyThumbprint, algorithm: "ES256", status: "active",
  }] });
  const marketplace = generateKeyPairSync("ed25519");
  const publicKeyPem = marketplace.publicKey.export({ type: "spki", format: "pem" }).toString();
  const envelope = claimedEnvelope(identity, marketplace.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  let cancelled = 0;
  let deliveries = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const target = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.clone().text() : "";
    await verifyProof(request, target, body, proofs);
    if (target.endsWith("/creative") && request.method === "DELETE") { cancelled += 1; return Response.json({ status: "cancelled" }); }
    if (target.endsWith("/creative")) return Response.json(envelope);
    return Response.json({ status: "ready", claimId: envelope.claimId, grant: envelope.grant });
  };
  const client = new SponsorshipPullClient({
    identity, environment: "test", provider: deviceProvider, marketplacePublicKeyPem: publicKeyPem,
    apiBaseUrl: "https://ad.daddy", fetch: fetch as typeof globalThis.fetch,
    state: new JsonSponsorshipPullStateStore(join(directory, "pull-state.json")),
    delivery: { async deliver() { deliveries += 1; return nativeDelivery(envelope.placement); } },
    readCurrentIdentity: async () => ({ ...identity, status: "paused" }),
    clock: () => NOW,
  });

  assert.deepEqual(await client.check(NOW), { status: "cancelled", claimId: envelope.claimId, reason: "local_consent_changed" });
  assert.equal(cancelled, 1);
  assert.equal(deliveries, 0);
});

test("receiver pull cancels an oversized chunked response before buffering it", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-pull-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const deviceProvider = new InMemoryDeviceKeyProvider();
  const credential = await deviceProvider.createOrLoad("install_local");
  const identity = localIdentity(credential.credentialReference, credential.keyThumbprint);
  const marketplace = generateKeyPairSync("ed25519");
  const publicKeyPem = marketplace.publicKey.export({ type: "spki", format: "pem" }).toString();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() { cancelled = true; },
  });
  const client = new SponsorshipPullClient({
    identity, environment: "test", provider: deviceProvider, marketplacePublicKeyPem: publicKeyPem,
    apiBaseUrl: "https://ad.daddy", fetch: (async () => new Response(body)) as typeof globalThis.fetch,
    state: new JsonSponsorshipPullStateStore(join(directory, "pull-state.json")),
    delivery: { async deliver() { throw new Error("delivery must not run"); } },
    readCurrentIdentity: async () => ({ ...identity, status: "active" }),
    clock: () => NOW,
  });

  await assert.rejects(client.check(NOW), /response is too large/);
  assert.equal(cancelled, true);
});

test("a terminal receipt rejection clears local recovery state so later checks can continue", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-pull-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const deviceProvider = new InMemoryDeviceKeyProvider();
  const credential = await deviceProvider.createOrLoad("install_local");
  const identity = localIdentity(credential.credentialReference, credential.keyThumbprint);
  const marketplace = generateKeyPairSync("ed25519");
  const publicKeyPem = marketplace.publicKey.export({ type: "spki", format: "pem" }).toString();
  const envelope = claimedEnvelope(identity, marketplace.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const state = new JsonSponsorshipPullStateStore(join(directory, "pull-state.json"));
  let nextCalls = 0;
  const client = new SponsorshipPullClient({
    identity, environment: "test", provider: deviceProvider, marketplacePublicKeyPem: publicKeyPem, apiBaseUrl: "https://ad.daddy",
    state, clock: () => NOW, readCurrentIdentity: async () => ({ ...identity, status: "active" }),
    delivery: { async deliver() { return nativeDelivery(envelope.placement); } },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const target = new URL(request.url).pathname;
      if (target.endsWith("/receipt")) return Response.json({ error: "receipt_recovery_expired", message: "Receipt recovery grace period expired" }, { status: 409 });
      if (target.endsWith("/creative")) return Response.json(envelope);
      nextCalls += 1;
      return nextCalls === 1 ? Response.json({ status: "ready", claimId: envelope.claimId, grant: envelope.grant })
        : Response.json({ status: "no_fill", opportunityId: "opportunity_next", retryAfterSeconds: 5 }, { status: 202 });
    }) as typeof globalThis.fetch,
  });
  await assert.rejects(client.check(NOW), /grace period expired/i);
  assert.equal(await state.get(identity.installationId), undefined);
  assert.deepEqual(await client.check(NOW), { status: "no_fill", opportunityId: "opportunity_next", retryAfterSeconds: 5 });
});

test("one installation lock prevents overlapping checks from creating two local surfaces", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-pull-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const deviceProvider = new InMemoryDeviceKeyProvider();
  const credential = await deviceProvider.createOrLoad("install_local");
  const identity = localIdentity(credential.credentialReference, credential.keyThumbprint);
  const marketplace = generateKeyPairSync("ed25519");
  const state = new JsonSponsorshipPullStateStore(join(directory, "pull-state.json"));
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const signal = new Promise<void>((resolve) => { started = resolve; });
  const makeClient = () => new SponsorshipPullClient({
    identity, environment: "test", provider: deviceProvider,
    marketplacePublicKeyPem: marketplace.publicKey.export({ type: "spki", format: "pem" }).toString(), apiBaseUrl: "https://ad.daddy",
    state, clock: () => NOW, readCurrentIdentity: async () => ({ ...identity, status: "active" }),
    delivery: { async deliver() { throw new Error("delivery must not run"); } },
    fetch: (async () => { started(); await gate; return Response.json({ status: "no_fill", opportunityId: "opportunity_lock", retryAfterSeconds: 5 }, { status: 202 }); }) as typeof globalThis.fetch,
  });
  const first = makeClient().check(NOW);
  await signal;
  assert.deepEqual(await makeClient().check(NOW), { status: "busy", reason: "check_already_running" });
  release();
  assert.equal((await first).status, "no_fill");
});

async function verifyProof(request: Request, target: string, body: string, repository: MemoryDeviceProofRepository, now = NOW) {
  const header = request.headers.get("x-ad-daddy-device-proof");
  assert.ok(header);
  const proof = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as SignedDeviceProof;
  await verifyDeviceProof({
    proof,
    expected: { method: request.method, target, environment: "test", bodyDigest: await sha256BodyDigest(body) },
    repository,
    now,
  });
}

function localIdentity(credentialReference: string, deviceKeyThumbprint: string): LocalSponsorshipIdentity {
  return { receiverAccountId: "receiver_local", installationId: "install_local", consentVersion: 2, credentialReference, deviceKeyThumbprint };
}

function claimedEnvelope(identity: LocalSponsorshipIdentity, privateKeyPem: string): ClaimedPlacementEnvelope {
  const placementPayload: SignedPlacement["payload"] = {
    protocolVersion: 1, placementId: "placement_local", advertiser: { id: "advertiser_local", displayName: "Neon" },
    title: "Branch your database", contentReference: "https://creative.ad-daddy.test/creative/placement_local",
    destinationUrl: "https://neon.tech", disclosure: "Sponsored", payout: { amountMinor: 500, currency: "USD" },
    signalsUsed: ["TypeScript"], creative: { body: "Create a preview database branch.", attachments: [] },
    issuedAt: new Date(NOW.getTime() - 1_000).toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  };
  const placement: SignedPlacement = {
    algorithm: "Ed25519", keyId: "marketplace_1", payload: placementPayload,
    signature: sign(null, Buffer.from(canonicalJson(placementPayload)), privateKeyPem).toString("base64url"),
  };
  const unsigned = {
    protocolVersion: 1 as const, claimId: "claim_local", receiverAccountId: identity.receiverAccountId,
    receiverProfileId: "profile_local", installationId: identity.installationId, deviceKeyThumbprint: identity.deviceKeyThumbprint,
    consentVersion: identity.consentVersion, opportunityId: "opportunity_local", placementId: placement.payload.placementId,
    campaignId: "campaign_local", reservationId: "reservation_local", rewardType: "stablecoin" as const,
    grossAmountMinor: 625, receiverAmountMinor: 500, operatorAmountMinor: 125, currency: "USD" as const,
    creativeDigest: digest(placement), eligibleBidderCount: 2, issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  };
  const grantPayload = { ...unsigned, grantDigest: digest(unsigned) };
  const grant: SignedSponsorshipGrant = {
    algorithm: "Ed25519", keyId: "marketplace_1", payload: grantPayload,
    signature: sign(null, Buffer.from(canonicalJson(grantPayload)), privateKeyPem).toString("base64url"),
  };
  return {
    claimId: grant.payload.claimId,
    grant,
    lease: {
      leaseId: "lease_local", claimId: grant.payload.claimId, installationId: identity.installationId,
      deviceKeyThumbprint: identity.deviceKeyThumbprint, creativeDigest: grant.payload.creativeDigest,
      policyVersion: "pull/v1", state: "active", issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 15_000).toISOString(),
    },
    placement,
  };
}

function nativeDelivery(placement: SignedPlacement): LocalPlacementDeliveryResult {
  return {
    status: "native",
    record: {
      placementId: placement.payload.placementId, receiverAccountId: "receiver_local", installationId: "install_local",
      signedPlacementSha256: digest(placement), status: "native", updatedAt: NOW.toISOString(),
      receipt: {
        placementId: placement.payload.placementId, threadId: "thread_local", turnId: "turn_local", title: "AD DADDY: Branch your database",
        output: "Sponsored via Ad Daddy\nNeon — Branch your database", outputSha256: "a".repeat(64), advertiserDisplayName: "Neon",
        receiverAmountMinor: 500, currency: "USD", signalsUsed: ["TypeScript"], toolItemCount: 0, cliVersion: "0.146.1",
        userAgent: "Codex Desktop", model: "gpt-5.6-luna", isolatedCwd: "/tmp/ad-daddy", activeTaskIdBefore: "active",
        activeTaskIdAfter: "active", listedAfterRestart: true, restartReadable: true, sidebarVerified: true,
        instructionSources: [], budgetVersion: 1,
      },
    },
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
