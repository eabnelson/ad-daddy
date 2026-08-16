import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProductionCashSettlementCapability,
  LaunchPolicyError,
  validateLaunchPolicy,
  type ProductionLaunchPolicy,
} from "../../lib/config/launch-policy.ts";

function policy(): ProductionLaunchPolicy {
  const version = "closed-beta/2026-08-15";
  const value = <T>(input: T) => ({ policyVersion: version, value: input });
  return {
    environment: "production",
    version,
    profileSnapshotExpirySeconds: value(3_600),
    auctionWindowSeconds: value(30),
    deliveryDeadlineSeconds: value(300),
    creativeRedemptionLeaseSeconds: value(90),
    receiptSubmissionGraceSeconds: value(3_600),
    settlementReviewSlaHours: value(24),
    settlementReviewResolutionAuthority: value("operator_dual_control"),
    displayModel: value("gpt-5.6-luna"),
    displayTimeoutMs: value(30_000),
    displayOutputCharacterBudget: value(4_000),
    creativeReceiptRetentionDays: value(30),
    conversionClaimWindowDays: value(14),
    conversionDisputeHoldDays: value(7),
    payoutCadenceHours: value(24),
    payoutMinimumMinor: value(500),
    payoutAddressChangeDelayHours: value(72),
    refundComplianceHoldHours: value(24),
    refundAddressVerification: value("wallet_signature"),
    targetingDeletionDays: value(30),
    financialRecordRetentionDays: value(2_555),
    recoveryCoolingOffHours: value(24),
    recoveryWindowMinutes: value(60),
    recoveryMaxAttempts: value(3),
    credentialOverlapMinutes: value(15),
    requestRateWindowSeconds: value(60),
    rewardVelocityDailyMinor: value(10_000),
    approvals: {
      legal: { approvedAt: "2026-08-15T15:00:00.000Z", recordId: "legal_1" },
      custody: { approvedAt: "2026-08-15T15:01:00.000Z", recordId: "custody_1" },
      dataProtection: { approvedAt: "2026-08-15T15:02:00.000Z", recordId: "privacy_1" },
    },
  };
}

test("a complete versioned production policy activates", () => {
  assert.deepEqual(validateLaunchPolicy(policy()), {
    allowed: true,
    environment: "production",
    version: "closed-beta/2026-08-15",
  });
});

test("production activation fails closed for every missing required policy", () => {
  for (const key of [
    "auctionWindowSeconds",
    "creativeRedemptionLeaseSeconds",
    "receiptSubmissionGraceSeconds",
    "settlementReviewSlaHours",
    "settlementReviewResolutionAuthority",
    "payoutMinimumMinor",
    "payoutAddressChangeDelayHours",
    "targetingDeletionDays",
    "financialRecordRetentionDays",
    "recoveryCoolingOffHours",
    "requestRateWindowSeconds",
  ] as const) {
    const candidate = policy() as unknown as Record<string, unknown>;
    delete candidate[key];
    assert.throws(() => validateLaunchPolicy(candidate), LaunchPolicyError, key);
  }
});

test("production activation rejects unversioned or mismatched values and missing approvals", () => {
  const mismatched = policy();
  mismatched.payoutCadenceHours.policyVersion = "stale/v1";
  assert.throws(() => validateLaunchPolicy(mismatched), /payoutCadenceHours/);

  const missingApproval = policy() as unknown as {
    approvals: Partial<ProductionLaunchPolicy["approvals"]>;
  };
  delete missingApproval.approvals.custody;
  assert.throws(() => validateLaunchPolicy(missingApproval), /custody/);

  const badRefundProof = policy() as unknown as Record<string, unknown>;
  badRefundProof.refundAddressVerification = {
    policyVersion: badRefundProof.version,
    value: "email_link",
  };
  assert.throws(() => validateLaunchPolicy(badRefundProof), /refundAddressVerification/);

  const badSettlementAuthority = policy() as unknown as Record<string, unknown>;
  badSettlementAuthority.settlementReviewResolutionAuthority = {
    policyVersion: badSettlementAuthority.version,
    value: "automated_model",
  };
  assert.throws(
    () => validateLaunchPolicy(badSettlementAuthority),
    /settlementReviewResolutionAuthority/,
  );
});

test("non-production policy may use explicit fixtures without production approvals", () => {
  const fixture = policy() as unknown as Record<string, unknown>;
  fixture.environment = "test";
  delete fixture.approvals;
  assert.deepEqual(validateLaunchPolicy(fixture), {
    allowed: true,
    environment: "test",
    version: "closed-beta/2026-08-15",
  });
});

test("production cash settlement stays fail-closed until host-integrity and durable velocity controls exist", () => {
  assert.doesNotThrow(() => assertProductionCashSettlementCapability("test"));
  assert.throws(
    () => assertProductionCashSettlementCapability("production"),
    /host-integrity.*durable reward-velocity|durable reward-velocity.*host-integrity/i,
  );
});
