import { ENVIRONMENTS, type Environment } from "../domain/types.ts";

export interface VersionedPolicyValue<T> {
  policyVersion: string;
  value: T;
}

export interface ApprovalRecord {
  approvedAt: string;
  recordId: string;
}

export interface ProductionLaunchPolicy {
  environment: Environment;
  version: string;
  profileSnapshotExpirySeconds: VersionedPolicyValue<number>;
  auctionWindowSeconds: VersionedPolicyValue<number>;
  deliveryDeadlineSeconds: VersionedPolicyValue<number>;
  displayModel: VersionedPolicyValue<string>;
  displayTimeoutMs: VersionedPolicyValue<number>;
  displayOutputCharacterBudget: VersionedPolicyValue<number>;
  creativeReceiptRetentionDays: VersionedPolicyValue<number>;
  conversionClaimWindowDays: VersionedPolicyValue<number>;
  conversionDisputeHoldDays: VersionedPolicyValue<number>;
  payoutCadenceHours: VersionedPolicyValue<number>;
  payoutMinimumMinor: VersionedPolicyValue<number>;
  payoutAddressChangeDelayHours: VersionedPolicyValue<number>;
  refundComplianceHoldHours: VersionedPolicyValue<number>;
  refundAddressVerification: VersionedPolicyValue<"wallet_signature" | "passkey_and_wallet_signature">;
  targetingDeletionDays: VersionedPolicyValue<number>;
  financialRecordRetentionDays: VersionedPolicyValue<number>;
  recoveryCoolingOffHours: VersionedPolicyValue<number>;
  recoveryWindowMinutes: VersionedPolicyValue<number>;
  recoveryMaxAttempts: VersionedPolicyValue<number>;
  credentialOverlapMinutes: VersionedPolicyValue<number>;
  requestRateWindowSeconds: VersionedPolicyValue<number>;
  rewardVelocityDailyMinor: VersionedPolicyValue<number>;
  approvals: {
    legal: ApprovalRecord;
    custody: ApprovalRecord;
    dataProtection: ApprovalRecord;
  };
}

const POLICY_FIELDS = [
  "profileSnapshotExpirySeconds",
  "auctionWindowSeconds",
  "deliveryDeadlineSeconds",
  "displayModel",
  "displayTimeoutMs",
  "displayOutputCharacterBudget",
  "creativeReceiptRetentionDays",
  "conversionClaimWindowDays",
  "conversionDisputeHoldDays",
  "payoutCadenceHours",
  "payoutMinimumMinor",
  "payoutAddressChangeDelayHours",
  "refundComplianceHoldHours",
  "refundAddressVerification",
  "targetingDeletionDays",
  "financialRecordRetentionDays",
  "recoveryCoolingOffHours",
  "recoveryWindowMinutes",
  "recoveryMaxAttempts",
  "credentialOverlapMinutes",
  "requestRateWindowSeconds",
  "rewardVelocityDailyMinor",
] as const satisfies readonly (keyof ProductionLaunchPolicy)[];

const NON_NEGATIVE_FIELDS = new Set<string>(["payoutMinimumMinor"]);
const STRING_FIELDS = new Set<string>(["displayModel", "refundAddressVerification"]);
const MAXIMUMS: Readonly<Record<string, number>> = Object.freeze({
  profileSnapshotExpirySeconds: 604_800,
  auctionWindowSeconds: 3_600,
  deliveryDeadlineSeconds: 86_400,
  displayTimeoutMs: 300_000,
  displayOutputCharacterBudget: 50_000,
  creativeReceiptRetentionDays: 365,
  conversionClaimWindowDays: 365,
  conversionDisputeHoldDays: 90,
  payoutCadenceHours: 720,
  payoutMinimumMinor: 1_000_000_000_000,
  payoutAddressChangeDelayHours: 720,
  refundComplianceHoldHours: 2_160,
  targetingDeletionDays: 365,
  financialRecordRetentionDays: 3_650,
  recoveryCoolingOffHours: 720,
  recoveryWindowMinutes: 1_440,
  recoveryMaxAttempts: 20,
  credentialOverlapMinutes: 1_440,
  requestRateWindowSeconds: 3_600,
  rewardVelocityDailyMinor: 1_000_000_000_000,
});
const POLICY_KEYS = new Set<string>(["environment", "version", "approvals", ...POLICY_FIELDS]);

export class LaunchPolicyError extends Error {
  readonly field: string;

  constructor(
    field: string,
    message: string,
  ) {
    super(`Production launch policy ${field}: ${message}`);
    this.name = "LaunchPolicyError";
    this.field = field;
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input && typeof input === "object" && !Array.isArray(input));
}

function validIsoDate(input: unknown): boolean {
  return typeof input === "string" && !Number.isNaN(Date.parse(input));
}

export function validateLaunchPolicy(input: unknown): {
  allowed: true;
  environment: Environment;
  version: string;
} {
  if (!isRecord(input)) throw new LaunchPolicyError("root", "must be an object");
  for (const key of Object.keys(input)) {
    if (!POLICY_KEYS.has(key)) throw new LaunchPolicyError(key, "is not a recognized launch policy field");
  }
  const environment = input.environment;
  if (!ENVIRONMENTS.includes(environment as Environment)) {
    throw new LaunchPolicyError("environment", "is unsupported");
  }
  const version = input.version;
  if (typeof version !== "string" || version.length === 0 || version.length > 128) {
    throw new LaunchPolicyError("version", "must be a named version");
  }

  for (const field of POLICY_FIELDS) {
    const entry = input[field];
    if (!isRecord(entry)) throw new LaunchPolicyError(field, "is required");
    if (entry.policyVersion !== version) throw new LaunchPolicyError(field, "must use the active policy version");
    if (STRING_FIELDS.has(field)) {
      if (typeof entry.value !== "string" || entry.value.length === 0 || entry.value.length > 128) throw new LaunchPolicyError(field, "must have a 1-128 character value");
      if (
        field === "refundAddressVerification" &&
        entry.value !== "wallet_signature" &&
        entry.value !== "passkey_and_wallet_signature"
      ) {
        throw new LaunchPolicyError(field, "must use an approved proof method");
      }
    } else if (
      !Number.isSafeInteger(entry.value) ||
      (entry.value as number) < (NON_NEGATIVE_FIELDS.has(field) ? 0 : 1) ||
      (entry.value as number) > MAXIMUMS[field]
    ) {
      throw new LaunchPolicyError(field, `must be a bounded ${NON_NEGATIVE_FIELDS.has(field) ? "non-negative" : "positive"} safe integer`);
    }
  }

  if (input.environment === "production") {
    if (!isRecord(input.approvals)) throw new LaunchPolicyError("approvals", "are required in production");
    for (const approvalName of ["legal", "custody", "dataProtection"] as const) {
      const approval = input.approvals[approvalName];
      if (!isRecord(approval) || typeof approval.recordId !== "string" || approval.recordId.length === 0 || !validIsoDate(approval.approvedAt)) {
        throw new LaunchPolicyError(approvalName, "approval record is required in production");
      }
    }
  }

  return Object.freeze({ allowed: true, environment: environment as Environment, version });
}
