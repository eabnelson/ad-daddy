import assert from "node:assert/strict";
import test from "node:test";

import { createEnrollmentGrantHandler } from "../../app/api/v1/installations/enrollment-grants/route.ts";
import { createEnrollmentHandler } from "../../app/api/v1/installations/enroll/route.ts";
import {
  DurableDeviceEnrollmentService,
  MemoryDeviceEnrollmentRepository,
} from "../../lib/auth/device-enrollment.ts";
import { deviceKeyThumbprint } from "../../lib/auth/device-proof.ts";
import { approvalResourceFingerprint, MemoryApprovalCapabilityRepository } from "../../lib/auth/approval-capability.ts";

const NOW = new Date("2026-08-15T16:00:00.000Z");
const APPROVAL = {
  accountId: "account_1",
  approvedAt: "2026-08-15T15:59:00.000Z",
  expiresAt: "2026-08-15T16:05:00.000Z",
  purposes: ["device_enroll"] as const,
};

async function publicKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { publicJwk, thumbprint: await deviceKeyThumbprint(publicJwk) };
}

test("human-authenticated grant enrolls one durable ES256 key and cannot replay", async () => {
  const repository = new MemoryDeviceEnrollmentRepository();
  const service = new DurableDeviceEnrollmentService(repository, { randomBytes: () => new Uint8Array(32).fill(7) });
  const key = await publicKey();
  const approvals = new MemoryApprovalCapabilityRepository();
  await approvals.putVerified({
    approvalId: "approval_device_1", accountId: "account_1", purpose: "device_enroll",
    resourceFingerprint: approvalResourceFingerprint({ installationId: "install_1", keyThumbprint: key.thumbprint }),
    approvedAt: APPROVAL.approvedAt, expiresAt: APPROVAL.expiresAt,
  });
  const grantHandler = createEnrollmentGrantHandler(service, () => NOW, approvals);
  const enrollHandler = createEnrollmentHandler(service, () => NOW);

  const unauthenticated = await grantHandler(new Request("https://ad.daddy/api/v1/installations/enrollment-grants", {
    method: "POST", body: JSON.stringify({ installationId: "install_1", keyThumbprint: key.thumbprint, approvalId: "approval_device_1" }),
  }));
  assert.equal(unauthenticated.status, 401);

  const grantResponse = await grantHandler(new Request("https://ad.daddy/api/v1/installations/enrollment-grants", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ad-daddy-verified-account-id": "account_1" },
    body: JSON.stringify({ installationId: "install_1", keyThumbprint: key.thumbprint, approvalId: "approval_device_1" }),
  }));
  assert.equal(grantResponse.status, 201);
  const grant = await grantResponse.json() as { grantToken: string; expiresAt: string };
  assert.ok(grant.grantToken.length >= 43);
  assert.equal(repository.debugGrants[0]?.tokenHash.includes(grant.grantToken), false, "only a hash is persisted");

  const enrollmentBody = {
    grantToken: grant.grantToken,
    installationId: "install_1",
    hostKind: "codex",
    algorithm: "ES256",
    keyVersion: 1,
    publicJwk: key.publicJwk,
    keyThumbprint: key.thumbprint,
  };
  const enrolled = await enrollHandler(new Request("https://ad.daddy/api/v1/installations/enroll", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(enrollmentBody),
  }));
  assert.equal(enrolled.status, 201);
  assert.deepEqual(await enrolled.json(), {
    installationId: "install_1", accountId: "account_1", status: "active", algorithm: "ES256",
    keyVersion: 1, keyThumbprint: key.thumbprint, enrolledAt: NOW.toISOString(),
  });

  const replay = await enrollHandler(new Request("https://ad.daddy/api/v1/installations/enroll", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(enrollmentBody),
  }));
  assert.equal(replay.status, 409);
  assert.match((await replay.json() as { message: string }).message, /consumed|enrolled/i);
});

test("caller-authored device approval data cannot mint an enrollment grant", async () => {
  const service = new DurableDeviceEnrollmentService(new MemoryDeviceEnrollmentRepository());
  const approvals = new MemoryApprovalCapabilityRepository();
  const key = await publicKey();
  const handler = createEnrollmentGrantHandler(service, () => NOW, approvals);
  const response = await handler(new Request("https://ad.daddy/api/v1/installations/enrollment-grants", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ad-daddy-verified-account-id": "account_1" },
    body: JSON.stringify({ installationId: "install_1", keyThumbprint: key.thumbprint, approval: APPROVAL, approvalId: "forged" }),
  }));
  assert.equal(response.status, 409);
  assert.match((await response.json() as { message: string }).message, /server-issued/i);
});

test("expiry, installation scope, and public-key thumbprint mismatches fail closed", async () => {
  const repository = new MemoryDeviceEnrollmentRepository();
  const service = new DurableDeviceEnrollmentService(repository, { grantTtlMs: 60_000 });
  const first = await publicKey();
  const second = await publicKey();
  const issued = await service.issueGrant({ accountId: "account_1", installationId: "install_1", keyThumbprint: first.thumbprint, approval: APPROVAL, now: NOW });

  await assert.rejects(service.enroll({
    grantToken: issued.grantToken, installationId: "install_other", hostKind: "codex", algorithm: "ES256",
    keyVersion: 1, publicJwk: first.publicJwk, keyThumbprint: first.thumbprint, now: NOW,
  }), /scope|grant/i);
  await assert.rejects(service.enroll({
    grantToken: issued.grantToken, installationId: "install_1", hostKind: "codex", algorithm: "ES256",
    keyVersion: 1, publicJwk: second.publicJwk, keyThumbprint: first.thumbprint, now: NOW,
  }), /thumbprint/i);
  await assert.rejects(service.enroll({
    grantToken: issued.grantToken, installationId: "install_1", hostKind: "codex", algorithm: "ES256",
    keyVersion: 1, publicJwk: { kty: "EC", crv: "P-256", x: "a", y: "b" },
    keyThumbprint: first.thumbprint, now: NOW,
  }), /public JWK|coordinates/i);
  await assert.rejects(service.enroll({
    grantToken: issued.grantToken, installationId: "install_1", hostKind: "codex", algorithm: "ES256",
    keyVersion: 1, publicJwk: first.publicJwk, keyThumbprint: first.thumbprint, now: new Date(NOW.getTime() + 60_001),
  }), /expired/i);
  assert.equal(repository.debugInstallations.length, 0);
});

test("grant issuance requires fresh human device-enrollment approval", async () => {
  const key = await publicKey();
  const service = new DurableDeviceEnrollmentService(new MemoryDeviceEnrollmentRepository());
  await assert.rejects(service.issueGrant({
    accountId: "account_1", installationId: "install_1", keyThumbprint: key.thumbprint,
    approval: { ...APPROVAL, expiresAt: "2026-08-15T15:59:30.000Z" }, now: NOW,
  }), /human approval/i);
});

test("a persistence failure does not consume the grant and a retry can enroll", async () => {
  const durable = new MemoryDeviceEnrollmentRepository();
  let fail = true;
  const repository = {
    findPendingGrant: durable.findPendingGrant.bind(durable),
    createGrant: durable.createGrant.bind(durable),
    findGrantByTokenHash: durable.findGrantByTokenHash.bind(durable),
    findInstallation: durable.findInstallation.bind(durable),
    consumeGrantAndEnroll: async (input: Parameters<typeof durable.consumeGrantAndEnroll>[0]) => {
      if (fail) { fail = false; throw new Error("injected persistence failure"); }
      return durable.consumeGrantAndEnroll(input);
    },
  };
  const service = new DurableDeviceEnrollmentService(repository);
  const key = await publicKey();
  const grant = await service.issueGrant({
    accountId: "account_1", installationId: "install_retry", keyThumbprint: key.thumbprint, approval: APPROVAL, now: NOW,
  });
  const input = {
    grantToken: grant.grantToken, installationId: "install_retry", hostKind: "codex", algorithm: "ES256",
    keyVersion: 1, publicJwk: key.publicJwk, keyThumbprint: key.thumbprint, now: NOW,
  };
  await assert.rejects(service.enroll(input), /injected persistence failure/);
  await assert.doesNotReject(service.enroll(input));
  assert.equal(durable.debugInstallations.length, 1);
});
