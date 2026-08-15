import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { CREDENTIAL_KINDS } from "../lib/auth/credential-lifecycle";
import {
  ENVIRONMENTS,
  LEDGER_TRANSACTION_KINDS,
  PLACEMENT_STATES,
} from "../lib/domain/types";

const createdAt = () => text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`);

export const humanAccounts = sqliteTable("human_accounts", {
  id: text("id").primaryKey(),
  status: text("status", { enum: ["active", "recovery_pending", "suspended", "closed"] }).notNull().default("active"),
  createdAt: createdAt(),
});

export const platformIdentities = sqliteTable("platform_identities", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => humanAccounts.id),
  provider: text("provider", { enum: ["chatgpt", "github"] }).notNull(),
  providerSubject: text("provider_subject").notNull(),
  linkedAt: createdAt(),
}, (table) => [
  uniqueIndex("platform_identity_subject_unique").on(table.provider, table.providerSubject),
  uniqueIndex("platform_identity_account_provider_unique").on(table.accountId, table.provider),
]);

export const passkeys = sqliteTable("passkeys", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => humanAccounts.id),
  credentialId: text("credential_id").notNull(),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
  createdAt: createdAt(),
  revokedAt: text("revoked_at"),
}, (table) => [
  uniqueIndex("passkey_credential_unique").on(table.credentialId),
  check("passkey_counter_nonnegative", sql`${table.counter} >= 0`),
]);

export const accountRecoveries = sqliteTable("account_recoveries", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => humanAccounts.id),
  status: text("status", { enum: ["pending", "completed", "cancelled", "expired"] }).notNull(),
  requestedAt: text("requested_at").notNull(),
  sensitiveChangesBlockedUntil: text("sensitive_changes_blocked_until").notNull(),
  completedAt: text("completed_at"),
}, (table) => [index("account_recovery_rate_limit_idx").on(table.accountId, table.requestedAt)]);

export const deviceEnrollmentGrants = sqliteTable("device_enrollment_grants", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => humanAccounts.id),
  installationId: text("installation_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("device_enrollment_token_hash_unique").on(table.tokenHash),
]);

export const installations = sqliteTable("installations", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => humanAccounts.id),
  publicKey: text("public_key").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  hostKind: text("host_kind").notNull(),
  status: text("status", { enum: ["active", "paused", "revoked"] }).notNull().default("active"),
  createdAt: createdAt(),
  revokedAt: text("revoked_at"),
}, (table) => [
  index("installation_account_idx").on(table.accountId),
  check("installation_key_version_positive", sql`${table.keyVersion} > 0`),
]);

export const managedCredentials = sqliteTable("managed_credentials", {
  id: text("id").primaryKey(),
  accountId: text("account_id").references(() => humanAccounts.id),
  installationId: text("installation_id").references(() => installations.id),
  kind: text("kind", { enum: CREDENTIAL_KINDS }).notNull(),
  environment: text("environment", { enum: ENVIRONMENTS }).notNull(),
  keyId: text("key_id").notNull(),
  scopesJson: text("scopes_json").notNull(),
  publicMaterial: text("public_material"),
  status: text("status", { enum: ["active", "rotating", "revoked", "retired"] }).notNull(),
  createdAt: createdAt(),
  retireAt: text("retire_at"),
  revokedAt: text("revoked_at"),
}, (table) => [uniqueIndex("managed_credential_environment_key_unique").on(table.environment, table.keyId)]);

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  accountId: text("account_id").references(() => humanAccounts.id),
  actorKind: text("actor_kind", { enum: ["human", "installation", "campaign_agent", "system", "operator"] }).notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  resourceKind: text("resource_kind").notNull(),
  resourceId: text("resource_id").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  occurredAt: text("occurred_at").notNull(),
}, (table) => [
  index("audit_account_time_idx").on(table.accountId, table.occurredAt),
  index("audit_resource_time_idx").on(table.resourceKind, table.resourceId, table.occurredAt),
]);

export const receiverProfiles = sqliteTable("receiver_profiles", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => humanAccounts.id),
  installationId: text("installation_id").notNull().references(() => installations.id),
  status: text("status", { enum: ["draft", "active", "paused", "revoked"] }).notNull().default("draft"),
  currentConsentVersion: integer("current_consent_version").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("receiver_profile_installation_unique").on(table.installationId),
  check("receiver_consent_version_nonnegative", sql`${table.currentConsentVersion} >= 0`),
]);

export const receiverConsentVersions = sqliteTable("receiver_consent_versions", {
  receiverProfileId: text("receiver_profile_id").notNull().references(() => receiverProfiles.id),
  version: integer("version").notNull(),
  previousVersion: integer("previous_version"),
  status: text("status", { enum: ["active", "paused", "revoked"] }).notNull(),
  termsVersion: text("terms_version").notNull(),
  privacyVersion: text("privacy_version").notNull(),
  consentedFieldsJson: text("consented_fields_json").notNull(),
  acceptedAt: text("accepted_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.receiverProfileId, table.version] }),
  check("receiver_consent_version_positive", sql`${table.version} > 0`),
]);

export const profileSnapshots = sqliteTable("profile_snapshots", {
  id: text("id").primaryKey(),
  receiverProfileId: text("receiver_profile_id").notNull().references(() => receiverProfiles.id),
  consentVersion: integer("consent_version").notNull(),
  publishedFieldsJson: text("published_fields_json").notNull(),
  publishedAt: text("published_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
}, (table) => [
  uniqueIndex("profile_snapshot_consent_unique").on(table.receiverProfileId, table.consentVersion),
  index("profile_snapshot_expiry_idx").on(table.expiresAt),
]);

export const advertiserBrands = sqliteTable("advertiser_brands", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => humanAccounts.id),
  name: text("name").notNull(),
  verifiedDomain: text("verified_domain").notNull(),
  ownershipStatus: text("ownership_status", { enum: ["pending", "verified", "revoked"] }).notNull().default("pending"),
  verifiedAt: text("verified_at"),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("advertiser_brand_domain_unique").on(table.verifiedDomain),
  index("advertiser_brand_account_idx").on(table.accountId),
]);

export const advertiserTermsAcceptances = sqliteTable("advertiser_terms_acceptances", {
  accountId: text("account_id").notNull().references(() => humanAccounts.id),
  version: text("version").notNull(),
  acceptedAt: text("accepted_at").notNull(),
  approvalId: text("approval_id").notNull(),
}, (table) => [primaryKey({ columns: [table.accountId, table.version] })]);

export const campaigns = sqliteTable("campaigns", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => humanAccounts.id),
  brandId: text("brand_id").notNull().references(() => advertiserBrands.id),
  status: text("status", { enum: ["draft", "funding_pending", "active", "paused", "closed"] }).notNull().default("draft"),
  advertiserTermsVersion: text("advertiser_terms_version").notNull(),
  destinationUrl: text("destination_url").notNull(),
  scheduleStartsAt: text("schedule_starts_at").notNull(),
  scheduleEndsAt: text("schedule_ends_at").notNull(),
  audienceJson: text("audience_json").notNull(),
  offerJson: text("offer_json").notNull(),
  creativeJson: text("creative_json").notNull(),
  conversionTerms: text("conversion_terms").notNull(),
  maximumSpendMinor: integer("maximum_spend_minor").notNull(),
  maximumBidMinor: integer("maximum_bid_minor").notNull(),
  dailyCapMinor: integer("daily_cap_minor").notNull(),
  fundedMinor: integer("funded_minor").notNull().default(0),
  spentMinor: integer("spent_minor").notNull().default(0),
  activatedAt: text("activated_at"),
  closedAt: text("closed_at"),
  createdAt: createdAt(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("campaign_account_status_idx").on(table.accountId, table.status),
  check("campaign_amounts_nonnegative", sql`${table.maximumSpendMinor} >= 0 AND ${table.maximumBidMinor} >= 0 AND ${table.dailyCapMinor} >= 0 AND ${table.fundedMinor} >= 0 AND ${table.spentMinor} >= 0`),
  check("campaign_bid_within_spend", sql`${table.maximumBidMinor} <= ${table.maximumSpendMinor}`),
  check("campaign_daily_within_spend", sql`${table.dailyCapMinor} <= ${table.maximumSpendMinor}`),
  check("campaign_spend_within_funds", sql`${table.spentMinor} <= ${table.fundedMinor}`),
]);

export const campaignBudgetReservations = sqliteTable("campaign_budget_reservations", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id),
  idempotencyKey: text("idempotency_key").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  budgetDay: text("budget_day").notNull(),
  status: text("status", { enum: ["reserved", "released", "committed"] }).notNull(),
  createdAt: createdAt(),
  releasedAt: text("released_at"),
  committedAt: text("committed_at"),
}, (table) => [
  uniqueIndex("campaign_reservation_idempotency_unique").on(table.campaignId, table.idempotencyKey),
  index("campaign_reservation_budget_idx").on(table.campaignId, table.budgetDay, table.status),
  check("campaign_reservation_amount_positive", sql`${table.amountMinor} > 0`),
]);

export const campaignBudgetHolds = sqliteTable("campaign_budget_holds", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id),
  reason: text("reason").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  status: text("status", { enum: ["active", "released"] }).notNull(),
  createdAt: createdAt(),
  releasedAt: text("released_at"),
}, (table) => [
  index("campaign_hold_status_idx").on(table.campaignId, table.status),
  check("campaign_hold_amount_positive", sql`${table.amountMinor} > 0`),
]);

export const campaignAgentTokens = sqliteTable("campaign_agent_tokens", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => humanAccounts.id),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id),
  tokenHash: text("token_hash").notNull(),
  scopesJson: text("scopes_json").notNull(),
  spendCeilingMinor: integer("spend_ceiling_minor").notNull(),
  spentMinor: integer("spent_minor").notNull().default(0),
  bidCeilingMinor: integer("bid_ceiling_minor").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("campaign_agent_token_hash_unique").on(table.tokenHash),
  index("campaign_agent_token_campaign_expiry_idx").on(table.campaignId, table.expiresAt),
  check("campaign_agent_token_ceilings_nonnegative", sql`${table.spendCeilingMinor} >= 0 AND ${table.spentMinor} >= 0 AND ${table.bidCeilingMinor} >= 0`),
  check("campaign_agent_token_bid_within_spend", sql`${table.bidCeilingMinor} <= ${table.spendCeilingMinor}`),
  check("campaign_agent_token_spent_within_ceiling", sql`${table.spentMinor} <= ${table.spendCeilingMinor}`),
]);

export const revenueSplitVersions = sqliteTable("revenue_split_versions", {
  version: text("version").primaryKey(),
  receiverBasisPoints: integer("receiver_basis_points").notNull(),
  operatorBasisPoints: integer("operator_basis_points").notNull(),
  effectiveAt: text("effective_at").notNull(),
  retiredAt: text("retired_at"),
}, (table) => [
  check("revenue_split_receiver_range", sql`${table.receiverBasisPoints} >= 0 AND ${table.receiverBasisPoints} <= 10000`),
  check("revenue_split_operator_range", sql`${table.operatorBasisPoints} >= 0 AND ${table.operatorBasisPoints} <= 10000`),
  check("revenue_split_balanced", sql`${table.receiverBasisPoints} + ${table.operatorBasisPoints} = 10000`),
]);

export const opportunities = sqliteTable("opportunities", {
  id: text("id").primaryKey(),
  rotatingOpportunityId: text("rotating_opportunity_id").notNull(),
  receiverProfileId: text("receiver_profile_id").notNull().references(() => receiverProfiles.id),
  installationId: text("installation_id").notNull().references(() => installations.id),
  consentVersion: integer("consent_version").notNull(),
  state: text("state", { enum: ["offered", "bidding", "won", "no_fill", "expired"] }).notNull(),
  invalidatedReason: text("invalidated_reason"),
  openedAt: text("opened_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (table) => [
  uniqueIndex("rotating_opportunity_id_unique").on(table.rotatingOpportunityId),
  index("opportunity_receiver_state_idx").on(table.receiverProfileId, table.state),
  check("opportunity_consent_version_positive", sql`${table.consentVersion} > 0`),
]);

export const auctions = sqliteTable("auctions", {
  id: text("id").primaryKey(),
  opportunityId: text("opportunity_id").notNull().references(() => opportunities.id),
  rewardLane: text("reward_lane", { enum: ["stablecoin", "credits", "discount"] }).notNull(),
  consentVersion: integer("consent_version").notNull(),
  minimumTakeHomeMinor: integer("minimum_take_home_minor").notNull(),
  matchedSignalNamesJson: text("matched_signal_names_json").notNull(),
  status: text("status", { enum: ["open", "decided"] }).notNull().default("open"),
  closesAt: text("closes_at").notNull(),
  decidedAt: text("decided_at"),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("auction_opportunity_unique").on(table.opportunityId),
  index("auction_deadline_status_idx").on(table.status, table.closesAt),
  check("auction_consent_version_positive", sql`${table.consentVersion} > 0`),
  check("auction_minimum_nonnegative", sql`${table.minimumTakeHomeMinor} >= 0`),
]);

export const auctionBids = sqliteTable("auction_bids", {
  id: text("id").primaryKey(),
  auctionId: text("auction_id").notNull().references(() => auctions.id),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id),
  rewardLane: text("reward_lane", { enum: ["stablecoin", "credits", "discount"] }).notNull(),
  grossAmountMinor: integer("gross_amount_minor").notNull(),
  receiverAmountMinor: integer("receiver_amount_minor").notNull(),
  operatorAmountMinor: integer("operator_amount_minor").notNull(),
  submittedAt: text("submitted_at").notNull(),
}, (table) => [
  uniqueIndex("auction_bid_campaign_unique").on(table.auctionId, table.campaignId),
  index("auction_bid_rank_idx").on(table.auctionId, table.grossAmountMinor),
  check("auction_bid_amounts_nonnegative", sql`${table.grossAmountMinor} >= 0 AND ${table.receiverAmountMinor} >= 0 AND ${table.operatorAmountMinor} >= 0`),
  check("auction_bid_split_balanced", sql`${table.receiverAmountMinor} + ${table.operatorAmountMinor} = ${table.grossAmountMinor}`),
]);

export const auctionDecisions = sqliteTable("auction_decisions", {
  id: text("id").primaryKey(),
  auctionId: text("auction_id").notNull().references(() => auctions.id),
  winnerBidId: text("winner_bid_id").references(() => auctionBids.id),
  reservationId: text("reservation_id"),
  eligibleBidderCount: integer("eligible_bidder_count").notNull(),
  noFillReason: text("no_fill_reason", { enum: ["no_eligible_bids", "budget_unavailable", "receiver_paused", "receiver_revoked", "stale_consent", "frequency_limited"] }),
  decidedAt: text("decided_at").notNull(),
}, (table) => [
  uniqueIndex("auction_decision_once_unique").on(table.auctionId),
  check("auction_decision_bidder_count_nonnegative", sql`${table.eligibleBidderCount} >= 0`),
  check("auction_decision_exact_outcome", sql`(${table.winnerBidId} IS NOT NULL AND ${table.noFillReason} IS NULL) OR (${table.winnerBidId} IS NULL AND ${table.noFillReason} IS NOT NULL)`),
]);

export const placements = sqliteTable("placements", {
  id: text("id").primaryKey(),
  opportunityId: text("opportunity_id").notNull().references(() => opportunities.id),
  consentVersion: integer("consent_version").notNull(),
  revenueSplitVersion: text("revenue_split_version").notNull().references(() => revenueSplitVersions.version),
  state: text("state", { enum: PLACEMENT_STATES }).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  grossAmountMinor: integer("gross_amount_minor").notNull(),
  receiverAmountMinor: integer("receiver_amount_minor").notNull(),
  operatorAmountMinor: integer("operator_amount_minor").notNull(),
  currency: text("currency").notNull(),
  hostSessionId: text("host_session_id"),
  hostTurnId: text("host_turn_id"),
  hostKind: text("host_kind", { enum: ["codex", "claude", "signed-html"] }),
  deliveryStatus: text("delivery_status", { enum: ["verifying", "ready", "displaying", "delivered", "fallback", "expired", "blocked", "reported"] }).notNull().default("verifying"),
  signedPlacementJson: text("signed_placement_json"),
  renderedResponse: text("rendered_response"),
  renderedResponseSha256: text("rendered_response_sha256"),
  hostReceiptJson: text("host_receipt_json"),
  creativeRetentionExpiresAt: text("creative_retention_expires_at"),
  reportedAt: text("reported_at"),
  createdAt: createdAt(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("placement_opportunity_unique").on(table.opportunityId),
  uniqueIndex("placement_idempotency_unique").on(table.idempotencyKey),
  check("placement_amounts_nonnegative", sql`${table.grossAmountMinor} >= 0 AND ${table.receiverAmountMinor} >= 0 AND ${table.operatorAmountMinor} >= 0`),
  check("placement_split_balanced", sql`${table.receiverAmountMinor} + ${table.operatorAmountMinor} = ${table.grossAmountMinor}`),
]);

export const placementMeasurementEvents = sqliteTable("placement_measurement_events", {
  id: text("id").primaryKey(),
  placementId: text("placement_id").notNull().references(() => placements.id),
  eventType: text("event_type", { enum: ["session_created", "session_open", "creative_engagement", "approved_action", "verified_conversion"] }).notNull(),
  evidenceStatus: text("evidence_status", { enum: ["verified", "unavailable", "rejected"] }).notNull(),
  evidenceProvider: text("evidence_provider"),
  evidenceId: text("evidence_id"),
  occurredAt: text("occurred_at").notNull(),
  receivedAt: createdAt(),
}, (table) => [
  uniqueIndex("placement_measurement_evidence_unique").on(table.placementId, table.eventType, table.evidenceId),
  index("placement_measurement_time_idx").on(table.placementId, table.occurredAt),
]);

export const idempotencyRecords = sqliteTable("idempotency_records", {
  scope: text("scope").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  resultKind: text("result_kind").notNull(),
  resultId: text("result_id").notNull(),
  responseJson: text("response_json").notNull(),
  createdAt: createdAt(),
  expiresAt: text("expires_at"),
}, (table) => [primaryKey({ columns: [table.scope, table.idempotencyKey] })]);

export const ledgerAccounts = sqliteTable("ledger_accounts", {
  id: text("id").primaryKey(),
  ownerKind: text("owner_kind", { enum: ["advertiser", "receiver", "operator", "treasury", "clearing", "hold"] }).notNull(),
  ownerId: text("owner_id").notNull(),
  currency: text("currency").notNull(),
  createdAt: createdAt(),
  closedAt: text("closed_at"),
}, (table) => [uniqueIndex("ledger_account_owner_currency_unique").on(table.ownerKind, table.ownerId, table.currency)]);

export const ledgerTransactions = sqliteTable("ledger_transactions", {
  id: text("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  kind: text("kind", { enum: LEDGER_TRANSACTION_KINDS }).notNull(),
  currency: text("currency").notNull(),
  referenceId: text("reference_id").notNull(),
  revenueSplitVersion: text("revenue_split_version").references(() => revenueSplitVersions.version),
  entryCount: integer("entry_count").notNull(),
  balanceMinor: integer("balance_minor").notNull(),
  chainReference: text("chain_reference"),
  status: text("status", { enum: ["draft", "posted"] }).notNull().default("draft"),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("ledger_transaction_idempotency_unique").on(table.idempotencyKey),
  index("ledger_transaction_reference_idx").on(table.kind, table.referenceId),
  check("ledger_transaction_entry_count", sql`${table.entryCount} >= 2`),
  check("ledger_transaction_balanced", sql`${table.balanceMinor} = 0`),
]);

export const ledgerEntries = sqliteTable("ledger_entries", {
  id: text("id").primaryKey(),
  transactionId: text("transaction_id").notNull().references(() => ledgerTransactions.id),
  accountId: text("account_id").notNull().references(() => ledgerAccounts.id),
  currency: text("currency").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  memo: text("memo"),
  sequence: integer("sequence").notNull(),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("ledger_entry_transaction_sequence_unique").on(table.transactionId, table.sequence),
  index("ledger_entry_account_time_idx").on(table.accountId, table.createdAt),
  check("ledger_entry_amount_nonzero", sql`${table.amountMinor} <> 0`),
  check("ledger_entry_sequence_positive", sql`${table.sequence} > 0`),
]);

export const outboxEvents = sqliteTable("outbox_events", {
  id: text("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  topic: text("topic").notNull(),
  payloadJson: text("payload_json").notNull(),
  status: text("status", { enum: ["pending", "delivering", "delivered", "dead_letter"] }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: text("available_at").notNull(),
  leaseUntil: text("lease_until"),
  deliveryReceiptJson: text("delivery_receipt_json"),
  deliveredAt: text("delivered_at"),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("outbox_idempotency_unique").on(table.idempotencyKey),
  index("outbox_dispatch_idx").on(table.status, table.availableAt),
  check("outbox_attempts_nonnegative", sql`${table.attempts} >= 0`),
]);

export const onchainTransfers = sqliteTable("onchain_transfers", {
  id: text("id").primaryKey(),
  ledgerTransactionId: text("ledger_transaction_id").notNull().references(() => ledgerTransactions.id),
  environment: text("environment", { enum: ENVIRONMENTS }).notNull(),
  chainId: text("chain_id").notNull(),
  transactionHash: text("transaction_hash"),
  logIndex: integer("log_index"),
  opaqueMemo: text("opaque_memo").notNull(),
  status: text("status", { enum: ["observed", "finalized", "submitted", "confirmed", "failed", "reorged"] }).notNull(),
  createdAt: createdAt(),
  finalizedAt: text("finalized_at"),
}, (table) => [
  uniqueIndex("onchain_transfer_ledger_unique").on(table.ledgerTransactionId),
  uniqueIndex("onchain_transfer_memo_unique").on(table.environment, table.chainId, table.opaqueMemo),
  uniqueIndex("onchain_transfer_event_unique").on(table.environment, table.chainId, table.transactionHash, table.logIndex),
]);

export const launchPolicies = sqliteTable("launch_policies", {
  environment: text("environment", { enum: ENVIRONMENTS }).notNull(),
  version: text("version").notNull(),
  policyJson: text("policy_json").notNull(),
  activatedAt: text("activated_at"),
  createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.environment, table.version] })]);
