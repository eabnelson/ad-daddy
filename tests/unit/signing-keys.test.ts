import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { CredentialLifecycleService } from "../../lib/auth/credential-lifecycle.ts";
import {
  MarketplaceSigningKeys,
  enrollMarketplacePublicKey,
  signPlacement,
} from "../../lib/marketplace/signing-keys.ts";
import type { PlacementPayload } from "../../packages/host-adapters/src/contract.ts";

const NOW = new Date("2026-08-15T12:00:00.000Z");

test("accepts active and overlapping signing keys, then rejects retired, revoked, unknown, and wrong-environment keys", () => {
  const lifecycle = new CredentialLifecycleService();
  const first = keyPair();
  enrollMarketplacePublicKey(lifecycle, { credentialId: "cred_1", keyId: "key_1", publicKeyPem: first.publicKeyPem, environment: "staging", now: NOW });
  const verifier = new MarketplaceSigningKeys(lifecycle, "staging");
  assert.equal(verifier.verify(signPlacement(payload(), { keyId: "key_1", privateKeyPem: first.privateKeyPem }), NOW).placementId, "pl_signing_1");

  const second = keyPair();
  lifecycle.rotate({
    credentialId: "cred_1",
    replacement: { credentialId: "cred_2", keyId: "key_2", publicMaterial: second.publicKeyPem, kind: "marketplace_signing", environment: "staging", scopes: ["placement:verify"] },
    overlapMs: 1_000,
    now: NOW,
  });
  assert.equal(verifier.verify(signPlacement(payload(), { keyId: "key_1", privateKeyPem: first.privateKeyPem }), new Date(NOW.getTime() + 500)).placementId, "pl_signing_1");
  assert.throws(() => verifier.verify(signPlacement(payload(), { keyId: "key_1", privateKeyPem: first.privateKeyPem }), new Date(NOW.getTime() + 1_001)), /retired/);
  lifecycle.revoke("cred_2", NOW, "test");
  assert.throws(() => verifier.verify(signPlacement(payload(), { keyId: "key_2", privateKeyPem: second.privateKeyPem }), NOW), /revoked/);
  assert.throws(() => new MarketplaceSigningKeys(lifecycle, "production").verify(signPlacement(payload(), { keyId: "key_1", privateKeyPem: first.privateKeyPem }), NOW), /environment mismatch|retired/);
  assert.throws(() => verifier.verify({ ...signPlacement(payload(), { keyId: "key_1", privateKeyPem: first.privateKeyPem }), keyId: "unknown" }, NOW), /Unknown credential key/);
});

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function payload(): PlacementPayload {
  return {
    protocolVersion: 1, placementId: "pl_signing_1",
    advertiser: { id: "adv_1", displayName: "Neon" },
    title: "Postgres", contentReference: "https://creative.ad-daddy.test/pl_signing_1",
    disclosure: "Sponsored", payout: { amountMinor: 100, currency: "USD" },
    signalsUsed: ["Postgres"], creative: { body: "Serverless Postgres", attachments: [] },
    issuedAt: "2026-08-15T00:00:00.000Z", expiresAt: "2026-08-16T00:00:00.000Z",
  };
}
