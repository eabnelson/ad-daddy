import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryDeviceKeyProvider,
  MacOSDeviceKeyProvider,
  derEcdsaSignatureToRaw,
} from "../../packages/cli/dist/device-key.js";
import {
  canonicalizeDeviceProofEnvelope,
  MemoryDeviceProofRepository,
  sha256BodyDigest,
  verifyDeviceProof,
  type DeviceProofEnvelope,
} from "../../lib/auth/device-proof.ts";

test("the explicit memory provider signs compatible ES256 proofs but cannot claim production enrollment", async () => {
  const provider = new InMemoryDeviceKeyProvider();
  const credential = await provider.createOrLoad("installation_test");
  const again = await provider.createOrLoad("installation_test");

  assert.equal(credential.credentialReference, again.credentialReference);
  assert.equal(credential.productionCapable, false);
  assert.equal(credential.algorithm, "ES256");
  assert.equal(credential.publicJwk.d, undefined);
  assert.throws(() => provider.assertProductionEnrollment(), /test-only|production/i);

  const message = new TextEncoder().encode("canonical request");
  const signature = await provider.sign(credential.credentialReference, message);
  assert.equal(signature.byteLength, 64);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    credential.publicJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const signatureBuffer = signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength) as ArrayBuffer;
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signatureBuffer, message), true);
});

test("X9.62 DER signatures are normalized to fixed-width raw ES256 wire signatures", () => {
  const r = Uint8Array.from([0x00, 0x80, ...Array.from({ length: 31 }, (_, index) => index + 1)]);
  const s = Uint8Array.from([0x7f, ...Array.from({ length: 31 }, (_, index) => 31 - index)]);
  const der = Uint8Array.from([0x30, 0x45, 0x02, r.length, ...r, 0x02, s.length, ...s]);
  const raw = derEcdsaSignatureToRaw(der);

  assert.equal(raw.byteLength, 64);
  assert.equal(raw[0], 0x80);
  assert.equal(raw[32], 0x7f);
  assert.throws(() => derEcdsaSignatureToRaw(Uint8Array.from([0x30, 0x01, 0x00])), /DER|X9\.62/i);
});

test("the macOS provider fails closed on unsupported platforms before invoking a helper", async () => {
  let invoked = false;
  const provider = new MacOSDeviceKeyProvider({
    platform: "linux",
    runHelper: async () => { invoked = true; return "{}"; },
  });

  await assert.rejects(provider.createOrLoad("installation_1"), /macOS/i);
  assert.equal(invoked, false);
});

test("provider signatures verify against the canonical device-proof contract", async () => {
  const provider = new InMemoryDeviceKeyProvider();
  const credential = await provider.createOrLoad("installation_1");
  const envelope: DeviceProofEnvelope = {
    method: "POST",
    target: "/api/v1/sponsorships/next",
    audience: "ad-daddy:test",
    bodyDigest: await sha256BodyDigest("{}"),
    installationId: "installation_1",
    consentVersion: 1,
    keyThumbprint: credential.keyThumbprint,
    nonce: "abcdefghijklmnopqrstuv",
    issuedAt: "2026-08-15T16:00:00.000Z",
    expiresAt: "2026-08-15T16:01:00.000Z",
  };
  const signature = await provider.sign(
    credential.credentialReference,
    new TextEncoder().encode(canonicalizeDeviceProofEnvelope(envelope)),
  );
  const repository = new MemoryDeviceProofRepository({ keys: [{
    installationId: "installation_1", accountId: "account_1", keyVersion: 1,
    publicJwk: credential.publicJwk, thumbprint: credential.keyThumbprint,
    algorithm: "ES256", status: "active",
  }] });

  await assert.doesNotReject(verifyDeviceProof({
    proof: { envelope, signature: Buffer.from(signature).toString("base64url") },
    expected: { method: "POST", target: envelope.target, environment: "test", bodyDigest: envelope.bodyDigest },
    repository,
    now: new Date("2026-08-15T16:00:30.000Z"),
  }));
});
