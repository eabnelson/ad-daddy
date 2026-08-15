import assert from "node:assert/strict";
import test from "node:test";

import {
  DeviceProofError,
  MemoryDeviceProofRepository,
  canonicalizeDeviceProofEnvelope,
  deviceKeyThumbprint,
  normalizeRequestTarget,
  sha256BodyDigest,
  verifyDeviceProof,
  type DeviceProofEnvelope,
  type SignedDeviceProof,
} from "../../lib/auth/device-proof.ts";

const NOW = new Date("2026-08-15T16:00:00.000Z");

function base64Url(input: ArrayBuffer): string {
  return Buffer.from(input).toString("base64url");
}

async function fixture() {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const keyThumbprint = await deviceKeyThumbprint(publicJwk);
  const envelope: DeviceProofEnvelope = {
    method: "POST",
    target: "/api/v1/sponsorships/fetch?a=1&b=2",
    audience: "ad-daddy:production",
    bodyDigest: await sha256BodyDigest('{"profile":"snapshot_1"}'),
    installationId: "installation_1",
    consentVersion: 7,
    keyThumbprint,
    nonce: "c29tZS1jcnlwdG9ncmFwaGljLW5vbmNl",
    issuedAt: "2026-08-15T15:59:30.000Z",
    expiresAt: "2026-08-15T16:01:00.000Z",
  };

  const sign = async (value: DeviceProofEnvelope): Promise<SignedDeviceProof> => ({
    envelope: value,
    signature: base64Url(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keys.privateKey,
        new TextEncoder().encode(canonicalizeDeviceProofEnvelope(value)),
      ),
    ),
  });

  return { envelope, publicJwk, sign };
}

test("canonical ES256 proof verifies and a byte-identical nonce replay is idempotent", async () => {
  const { envelope, publicJwk, sign } = await fixture();
  const store = new Map();
  const repository = new MemoryDeviceProofRepository({
    store,
    keys: [{
      installationId: envelope.installationId,
      accountId: "account_receiver",
      keyVersion: 3,
      publicJwk,
      thumbprint: envelope.keyThumbprint,
      algorithm: "ES256",
      status: "active",
    }],
  });
  const proof = await sign(envelope);
  const expected = {
    method: envelope.method,
    target: envelope.target,
    environment: "production" as const,
    bodyDigest: envelope.bodyDigest,
  };

  const first = await verifyDeviceProof({ proof, expected, repository, now: NOW });
  assert.equal(first.replay, false);
  assert.equal(first.key.keyVersion, 3);

  // A fresh verifier process using the same durable store accepts only the exact retry.
  const restarted = new MemoryDeviceProofRepository({
    store,
    keys: [first.key],
  });
  const replay = await verifyDeviceProof({ proof, expected, repository: restarted, now: NOW });
  assert.equal(replay.replay, true);
});

test("proof rejects non-canonical targets, wrong audiences, expiry, and mutated nonce replay", async () => {
  const { envelope, publicJwk, sign } = await fixture();
  const store = new Map();
  const repository = new MemoryDeviceProofRepository({
    store,
    keys: [{
      installationId: envelope.installationId,
      accountId: "account_receiver",
      keyVersion: 1,
      publicJwk,
      thumbprint: envelope.keyThumbprint,
      algorithm: "ES256",
      status: "active",
    }],
  });
  const expected = {
    method: envelope.method,
    target: envelope.target,
    environment: "production" as const,
    bodyDigest: envelope.bodyDigest,
  };

  assert.equal(
    normalizeRequestTarget("/api/v1/sponsorships/fetch?b=2&a=1"),
    envelope.target,
  );
  const canonicalProof = await sign(envelope);
  await assert.rejects(
    verifyDeviceProof({
      proof: {
        ...canonicalProof,
        envelope: { ...envelope, target: "/api/v1/sponsorships/fetch?b=2&a=1" },
      },
      expected,
      repository,
      now: NOW,
    }),
    /canonical/,
  );
  await assert.rejects(
    verifyDeviceProof({
      proof: await sign({ ...envelope, audience: "ad-daddy:staging" }),
      expected,
      repository,
      now: NOW,
    }),
    /audience/,
  );
  await assert.rejects(
    verifyDeviceProof({ proof: await sign(envelope), expected, repository, now: new Date(envelope.expiresAt) }),
    /expired/,
  );

  await verifyDeviceProof({ proof: await sign(envelope), expected, repository, now: NOW });
  const mutated = { ...envelope, bodyDigest: await sha256BodyDigest("different body") };
  await assert.rejects(
    verifyDeviceProof({
      proof: await sign(mutated),
      expected: { ...expected, bodyDigest: mutated.bodyDigest },
      repository,
      now: NOW,
    }),
    /nonce replay/,
  );
  assert.equal(repository.auditEvents.at(-1)?.action, "device_proof.nonce_conflict");
});

test("changing any signed field, signature, or key thumbprint invalidates the proof", async () => {
  const { envelope, publicJwk, sign } = await fixture();
  const repository = new MemoryDeviceProofRepository({
    keys: [{
      installationId: envelope.installationId,
      accountId: "account_receiver",
      keyVersion: 1,
      publicJwk,
      thumbprint: envelope.keyThumbprint,
      algorithm: "ES256",
      status: "active",
    }],
  });
  const proof = await sign(envelope);
  const mutations: DeviceProofEnvelope[] = [
    { ...envelope, method: "PUT" },
    { ...envelope, target: "/api/v1/sponsorships/receipt" },
    { ...envelope, audience: "ad-daddy:staging" },
    { ...envelope, bodyDigest: "0".repeat(64) },
    { ...envelope, installationId: "installation_2" },
    { ...envelope, consentVersion: 8 },
    { ...envelope, keyThumbprint: `${envelope.keyThumbprint.slice(0, -1)}A` },
    { ...envelope, nonce: `${envelope.nonce}A` },
    { ...envelope, issuedAt: "2026-08-15T15:59:31.000Z" },
    { ...envelope, expiresAt: "2026-08-15T16:01:01.000Z" },
  ];

  for (const [index, mutation] of mutations.entries()) {
    await assert.rejects(
      verifyDeviceProof({
        proof: { ...proof, envelope: mutation },
        expected: {
          method: envelope.method,
          target: envelope.target,
          environment: "production",
          bodyDigest: envelope.bodyDigest,
        },
        repository,
        now: NOW,
      }),
      DeviceProofError,
      `mutation ${index} must fail`,
    );
  }

  const signatureBytes = Buffer.from(proof.signature, "base64url");
  signatureBytes[0] ^= 1;
  await assert.rejects(
    verifyDeviceProof({
      proof: { ...proof, signature: signatureBytes.toString("base64url") },
      expected: {
        method: envelope.method,
        target: envelope.target,
        environment: "production",
        bodyDigest: envelope.bodyDigest,
      },
      repository,
      now: NOW,
    }),
    /signature/,
  );
});

test("revoked and non-ES256 device material fails closed", async () => {
  const { envelope, publicJwk, sign } = await fixture();
  for (const key of [
    { status: "revoked" as const, algorithm: "ES256" as const },
    { status: "active" as const, algorithm: "RS256" as const },
  ]) {
    const repository = new MemoryDeviceProofRepository({
      keys: [{
        installationId: envelope.installationId,
        accountId: "account_receiver",
        keyVersion: 1,
        publicJwk,
        thumbprint: envelope.keyThumbprint,
        ...key,
      }],
    });
    await assert.rejects(
      verifyDeviceProof({
        proof: await sign(envelope),
        expected: {
          method: envelope.method,
          target: envelope.target,
          environment: "production",
          bodyDigest: envelope.bodyDigest,
        },
        repository,
        now: NOW,
      }),
      /active ES256 device key/,
    );
  }
});
