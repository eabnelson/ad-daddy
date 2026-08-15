export const ENVIRONMENTS = [
  "test",
  "development",
  "staging",
  "production",
] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

export type RewardType = "stablecoin" | "credits" | "discount";

export interface Money {
  amountMinor: number;
  currency: string;
}

export interface FrequencyPolicy {
  maxPerDay: number;
  quietHours?: Readonly<{
    startHourLocal: number;
    endHourLocal: number;
  }>;
}

export interface ReceiverProfileFields {
  coarseLocation?: string;
  projectNames?: readonly string[];
  publicRepositoryUrls?: readonly string[];
  privateRepoTechStacks?: readonly (readonly string[])[];
  projectDescriptions?: readonly string[];
  adFrequency?: FrequencyPolicy;
  subscriptionTier?: string;
  tokenUsageRange?: string;
  totalSessionRange?: string;
  acceptedRewardTypes?: readonly RewardType[];
  minimumTakeHomeMinor?: number;
  directlyIdentifyingPreBidExposure?: Readonly<{
    projectNames: boolean;
    publicRepositoryUrls: boolean;
  }>;
}

export interface ReceiverProfileSnapshot {
  profileId: string;
  accountId: string;
  installationId: string;
  consentVersion: number;
  publishedAt: string;
  expiresAt: string;
  fields: ReceiverProfileFields;
}

export type ConsentStatus = "active" | "paused" | "revoked";

export interface ConsentVersion {
  receiverId: string;
  version: number;
  previousVersion: number | null;
  acceptedAt: string;
  termsVersion: string;
  privacyVersion: string;
  status: ConsentStatus;
}

export const PLACEMENT_STATES = [
  "offered",
  "bidding",
  "won",
  "delivered",
  "settled",
  "conversion_pending",
  "conversion_paid",
  "conversion_rejected",
  "no_fill",
  "expired",
] as const;

export type PlacementState = (typeof PLACEMENT_STATES)[number];

export interface OpportunityState {
  opportunityId: string;
  consentVersion: number;
  state: "offered" | "bidding" | "no_fill";
  invalidatedReason?: "stale_consent" | "receiver_paused" | "receiver_revoked";
}

export const LEDGER_TRANSACTION_KINDS = [
  "deposit",
  "budget_reservation",
  "reservation_release",
  "placement_settlement",
  "conversion_settlement",
  "refund",
  "payout",
] as const;

export type LedgerTransactionKind = (typeof LEDGER_TRANSACTION_KINDS)[number];

export interface LedgerEntryInput {
  accountId: string;
  amountMinor: number;
  currency?: string;
  memo?: string;
}

export interface LedgerTransactionInput {
  transactionId: string;
  idempotencyKey: string;
  kind: LedgerTransactionKind;
  currency: string;
  referenceId: string;
  entries: readonly LedgerEntryInput[];
  splitVersion?: string;
  chainReference?: string;
  createdAt?: string;
}

export interface LedgerEntry extends LedgerEntryInput {
  entryId: string;
  currency: string;
}

export interface LedgerTransaction
  extends Omit<LedgerTransactionInput, "entries" | "createdAt"> {
  entries: readonly LedgerEntry[];
  createdAt: string;
  inputFingerprint: string;
}

export interface RevenueSplitVersion {
  version: string;
  receiverBasisPoints: number;
  operatorBasisPoints: number;
}

export type HumanApprovalPurpose =
  | "identity_link"
  | "passkey_add"
  | "device_enroll"
  | "device_rotate"
  | "device_revoke"
  | "payout_address_change"
  | "terms_accept"
  | "advertiser_verify"
  | "campaign_fund"
  | "campaign_close"
  | "refund"
  | "production_activate";

export interface HumanApproval {
  accountId: string;
  approvedAt: string;
  expiresAt: string;
  purposes: readonly HumanApprovalPurpose[];
}

export interface AuditEvent {
  eventId: string;
  accountId: string;
  action: string;
  actorKind: "human" | "installation" | "campaign_agent" | "system" | "operator";
  resourceId: string;
  occurredAt: string;
  metadata: Readonly<Record<string, string | number | boolean | null>>;
}
