import assert from "node:assert/strict";
import test from "node:test";

import { authorize, AuthorizationError } from "../../lib/auth/authorize.ts";
import { AccountIdentityService } from "../../lib/auth/account-identity.ts";
import { DeviceEnrollmentService } from "../../lib/auth/device-enrollment.ts";
import { CredentialLifecycleService } from "../../lib/auth/credential-lifecycle.ts";

const NOW = new Date("2026-08-15T16:00:00.000Z");
const APPROVAL = {
  accountId: "account_receiver",
  approvedAt: "2026-08-15T15:59:00.000Z",
  expiresAt: "2026-08-15T16:05:00.000Z",
  purposes: ["identity_link", "passkey_add", "device_enroll", "device_rotate", "device_revoke"] as const,
};

test("actor and resource ownership is enforced at every authorization boundary", () => {
  assert.doesNotThrow(() =>
    authorize({
      actor: { kind: "installation", accountId: "account_receiver", installationId: "install_1" },
      action: "opportunity:open",
      resource: { kind: "installation", accountId: "account_receiver", installationId: "install_1" },
    }),
  );

  for (const request of [
    {
      actor: { kind: "human", accountId: "account_receiver" } as const,
      action: "campaign:read" as const,
      resource: { kind: "campaign", accountId: "account_advertiser", campaignId: "campaign_1" } as const,
    },
    {
      actor: {
        kind: "campaign_agent",
        accountId: "account_advertiser",
        campaignId: "campaign_1",
        scopes: ["campaign:read"] as const,
      } as const,
      action: "profile:private:read" as const,
      resource: { kind: "profile", accountId: "account_receiver", profileId: "profile_1" } as const,
    },
    {
      actor: { kind: "installation", accountId: "account_receiver", installationId: "install_1" } as const,
      action: "receipt:submit" as const,
      resource: { kind: "installation", accountId: "account_receiver", installationId: "install_2" } as const,
    },
  ]) {
    assert.throws(() => authorize(request), AuthorizationError);
  }
});

test("linking identity, adding a passkey, and recovery require human boundaries and audit", () => {
  const notices: string[] = [];
  const service = new AccountIdentityService({
    recoveryMaxAttempts: 2,
    recoveryWindowMs: 60_000,
    recoveryCoolingOffMs: 3_600_000,
    notify: (accountId) => notices.push(accountId),
  });

  service.linkPlatformIdentity(
    "account_receiver",
    { provider: "chatgpt", subject: "chatgpt_subject_1" },
    APPROVAL,
    NOW,
  );
  service.addPasskey(
    "account_receiver",
    { credentialId: "passkey_1", publicKey: "public-key", counter: 0 },
    APPROVAL,
    NOW,
  );
  const recovery = service.requestRecovery("account_receiver", NOW);

  assert.equal(recovery.sensitiveChangesBlockedUntil, "2026-08-15T17:00:00.000Z");
  assert.deepEqual(notices, ["account_receiver"]);
  assert.deepEqual(
    service.auditEvents.map((event) => event.action),
    ["identity.linked", "passkey.added", "recovery.requested"],
  );
  assert.throws(() => service.requestRecovery("account_receiver", NOW), /already pending/);
});

test("account recovery is rate-limited across resolved attempts", () => {
  const service = new AccountIdentityService({
    recoveryMaxAttempts: 2,
    recoveryWindowMs: 60_000,
    recoveryCoolingOffMs: 3_600_000,
    notify: () => undefined,
  });

  const first = service.requestRecovery("account_receiver", NOW);
  service.resolveRecovery("account_receiver", first.recoveryId, "cancelled", NOW);
  const second = service.requestRecovery("account_receiver", new Date(NOW.getTime() + 1_000));
  service.resolveRecovery("account_receiver", second.recoveryId, "completed", new Date(NOW.getTime() + 2_000));
  assert.throws(
    () => service.requestRecovery("account_receiver", new Date(NOW.getTime() + 3_000)),
    /rate-limited/,
  );
  assert.throws(
    () => service.assertSensitiveChangesAllowed("account_receiver", new Date(NOW.getTime() + 3_000)),
    /cooling off/,
  );
});

test("one-time device enrollment cannot replay and revoked devices fail closed", () => {
  const service = new DeviceEnrollmentService();
  service.issueGrant({
    grantId: "grant_1",
    accountId: "account_receiver",
    installationId: "install_1",
    expiresAt: "2026-08-15T16:05:00.000Z",
    approval: APPROVAL,
    now: NOW,
  });
  const device = service.consumeGrant({
    grantId: "grant_1",
    accountId: "account_receiver",
    installationId: "install_1",
    publicKey: "device-key-1",
    now: NOW,
  });
  assert.equal(device.status, "active");
  assert.throws(
    () =>
      service.consumeGrant({
        grantId: "grant_1",
        accountId: "account_receiver",
        installationId: "install_1",
        publicKey: "device-key-1",
        now: NOW,
      }),
    /already consumed/,
  );

  service.rotateKey("install_1", "device-key-2", APPROVAL, NOW);
  service.revoke("install_1", APPROVAL, NOW);
  assert.throws(() => service.assertCanOpenOpportunity("install_1"), /revoked/);
  assert.throws(() => service.assertCanSubmitReceipt("install_1"), /revoked/);
  assert.equal(service.canReadFinancialHistory("install_1", "account_receiver"), true);
  assert.deepEqual(
    service.auditEvents.map((event) => event.action),
    ["device.enrollment_grant_issued", "device.enrolled", "device.key_rotated", "device.revoked"],
  );
});

test("an expired enrollment grant can be replaced for the same installation", () => {
  const service = new DeviceEnrollmentService();
  service.issueGrant({
    grantId: "grant_expired",
    accountId: "account_receiver",
    installationId: "install_retry",
    expiresAt: "2026-08-15T16:01:00.000Z",
    approval: APPROVAL,
    now: NOW,
  });

  assert.doesNotThrow(() =>
    service.issueGrant({
      grantId: "grant_replacement",
      accountId: "account_receiver",
      installationId: "install_retry",
      expiresAt: "2026-08-15T16:05:00.000Z",
      approval: APPROVAL,
      now: new Date("2026-08-15T16:02:00.000Z"),
    }),
  );
});

test("environment-scoped credentials rotate with bounded overlap and revoke", () => {
  const service = new CredentialLifecycleService();
  service.enroll({
    credentialId: "signing_v1",
    kind: "marketplace_signing",
    environment: "production",
    keyId: "kid_1",
    scopes: ["placement:sign"],
    publicMaterial: "public-1",
    now: NOW,
  });
  service.rotate({
    credentialId: "signing_v1",
    replacement: {
      credentialId: "signing_v2",
      kind: "marketplace_signing",
      environment: "production",
      keyId: "kid_2",
      scopes: ["placement:sign"],
      publicMaterial: "public-2",
    },
    overlapMs: 300_000,
    now: NOW,
  });

  assert.equal(service.assertUsable("kid_1", "production", "placement:sign", NOW).keyId, "kid_1");
  assert.throws(
    () => service.assertUsable("kid_1", "staging", "placement:sign", NOW),
    /environment/,
  );
  service.revoke("signing_v2", NOW, "operator incident response");
  assert.throws(
    () => service.assertUsable("kid_2", "production", "placement:sign", NOW),
    /revoked/,
  );
});

test("a failed credential replacement leaves the current credential active", () => {
  const service = new CredentialLifecycleService();
  service.enroll({
    credentialId: "current",
    kind: "marketplace_signing",
    environment: "production",
    keyId: "current_key",
    scopes: ["placement:sign"],
    publicMaterial: "public-current",
    now: NOW,
  });
  service.enroll({
    credentialId: "conflict",
    kind: "marketplace_signing",
    environment: "production",
    keyId: "conflict_key",
    scopes: ["placement:sign"],
    publicMaterial: "public-conflict",
    now: NOW,
  });

  assert.throws(() => service.rotate({
    credentialId: "current",
    replacement: {
      credentialId: "conflict",
      kind: "marketplace_signing",
      environment: "production",
      keyId: "replacement_key",
      scopes: ["placement:sign"],
      publicMaterial: "public-replacement",
    },
    overlapMs: 300_000,
    now: NOW,
  }), /already exists/);
  assert.equal(service.assertUsable("current_key", "production", "placement:sign", NOW).status, "active");
});
