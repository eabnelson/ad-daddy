CREATE TABLE `account_recoveries` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`status` text NOT NULL,
	`requested_at` text NOT NULL,
	`sensitive_changes_blocked_until` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_recovery_rate_limit_idx` ON `account_recoveries` (`account_id`,`requested_at`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`resource_kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_account_time_idx` ON `audit_events` (`account_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `audit_resource_time_idx` ON `audit_events` (`resource_kind`,`resource_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `device_enrollment_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_enrollment_token_hash_unique` ON `device_enrollment_grants` (`token_hash`);--> statement-breakpoint
CREATE TABLE `human_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `idempotency_records` (
	`scope` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`result_kind` text NOT NULL,
	`result_id` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text,
	PRIMARY KEY(`scope`, `idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `installations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`public_key` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`host_kind` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "installation_key_version_positive" CHECK("installations"."key_version" > 0)
);
--> statement-breakpoint
CREATE INDEX `installation_account_idx` ON `installations` (`account_id`);--> statement-breakpoint
CREATE TABLE `launch_policies` (
	`environment` text NOT NULL,
	`version` text NOT NULL,
	`policy_json` text NOT NULL,
	`activated_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`environment`, `version`)
);
--> statement-breakpoint
CREATE TABLE `ledger_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`currency` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_account_owner_currency_unique` ON `ledger_accounts` (`owner_kind`,`owner_id`,`currency`);--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`account_id` text NOT NULL,
	`currency` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`memo` text,
	`sequence` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `ledger_transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `ledger_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ledger_entry_amount_nonzero" CHECK("ledger_entries"."amount_minor" <> 0),
	CONSTRAINT "ledger_entry_sequence_positive" CHECK("ledger_entries"."sequence" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_entry_transaction_sequence_unique` ON `ledger_entries` (`transaction_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `ledger_entry_account_time_idx` ON `ledger_entries` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ledger_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`kind` text NOT NULL,
	`currency` text NOT NULL,
	`reference_id` text NOT NULL,
	`revenue_split_version` text,
	`entry_count` integer NOT NULL,
	`balance_minor` integer NOT NULL,
	`chain_reference` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`revenue_split_version`) REFERENCES `revenue_split_versions`(`version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ledger_transaction_entry_count" CHECK("ledger_transactions"."entry_count" >= 2),
	CONSTRAINT "ledger_transaction_balanced" CHECK("ledger_transactions"."balance_minor" = 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_transaction_idempotency_unique` ON `ledger_transactions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `ledger_transaction_reference_idx` ON `ledger_transactions` (`kind`,`reference_id`);--> statement-breakpoint
CREATE TABLE `managed_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`installation_id` text,
	`kind` text NOT NULL,
	`environment` text NOT NULL,
	`key_id` text NOT NULL,
	`scopes_json` text NOT NULL,
	`public_material` text,
	`status` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`retire_at` text,
	`revoked_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `managed_credential_environment_key_unique` ON `managed_credentials` (`environment`,`key_id`);--> statement-breakpoint
CREATE TABLE `onchain_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_transaction_id` text NOT NULL,
	`environment` text NOT NULL,
	`chain_id` text NOT NULL,
	`transaction_hash` text,
	`log_index` integer,
	`opaque_memo` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`finalized_at` text,
	FOREIGN KEY (`ledger_transaction_id`) REFERENCES `ledger_transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onchain_transfer_ledger_unique` ON `onchain_transfers` (`ledger_transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `onchain_transfer_memo_unique` ON `onchain_transfers` (`environment`,`chain_id`,`opaque_memo`);--> statement-breakpoint
CREATE UNIQUE INDEX `onchain_transfer_event_unique` ON `onchain_transfers` (`environment`,`chain_id`,`transaction_hash`,`log_index`);--> statement-breakpoint
CREATE TABLE `opportunities` (
	`id` text PRIMARY KEY NOT NULL,
	`rotating_opportunity_id` text NOT NULL,
	`receiver_profile_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`consent_version` integer NOT NULL,
	`state` text NOT NULL,
	`invalidated_reason` text,
	`opened_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`receiver_profile_id`) REFERENCES `receiver_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "opportunity_consent_version_positive" CHECK("opportunities"."consent_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rotating_opportunity_id_unique` ON `opportunities` (`rotating_opportunity_id`);--> statement-breakpoint
CREATE INDEX `opportunity_receiver_state_idx` ON `opportunities` (`receiver_profile_id`,`state`);--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`topic` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` text NOT NULL,
	`lease_until` text,
	`delivery_receipt_json` text,
	`delivered_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "outbox_attempts_nonnegative" CHECK("outbox_events"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_idempotency_unique` ON `outbox_events` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `outbox_dispatch_idx` ON `outbox_events` (`status`,`available_at`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "passkey_counter_nonnegative" CHECK("passkeys"."counter" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkey_credential_unique` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE TABLE `placements` (
	`id` text PRIMARY KEY NOT NULL,
	`opportunity_id` text NOT NULL,
	`consent_version` integer NOT NULL,
	`revenue_split_version` text NOT NULL,
	`state` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`gross_amount_minor` integer NOT NULL,
	`receiver_amount_minor` integer NOT NULL,
	`operator_amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`host_session_id` text,
	`host_turn_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revenue_split_version`) REFERENCES `revenue_split_versions`(`version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "placement_amounts_nonnegative" CHECK("placements"."gross_amount_minor" >= 0 AND "placements"."receiver_amount_minor" >= 0 AND "placements"."operator_amount_minor" >= 0),
	CONSTRAINT "placement_split_balanced" CHECK("placements"."receiver_amount_minor" + "placements"."operator_amount_minor" = "placements"."gross_amount_minor")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_opportunity_unique` ON `placements` (`opportunity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `placement_idempotency_unique` ON `placements` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `platform_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_subject` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_identity_subject_unique` ON `platform_identities` (`provider`,`provider_subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_identity_account_provider_unique` ON `platform_identities` (`account_id`,`provider`);--> statement-breakpoint
CREATE TABLE `profile_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`receiver_profile_id` text NOT NULL,
	`consent_version` integer NOT NULL,
	`published_fields_json` text NOT NULL,
	`published_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`receiver_profile_id`) REFERENCES `receiver_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_snapshot_consent_unique` ON `profile_snapshots` (`receiver_profile_id`,`consent_version`);--> statement-breakpoint
CREATE INDEX `profile_snapshot_expiry_idx` ON `profile_snapshots` (`expires_at`);--> statement-breakpoint
CREATE TABLE `receiver_consent_versions` (
	`receiver_profile_id` text NOT NULL,
	`version` integer NOT NULL,
	`previous_version` integer,
	`status` text NOT NULL,
	`terms_version` text NOT NULL,
	`privacy_version` text NOT NULL,
	`consented_fields_json` text NOT NULL,
	`accepted_at` text NOT NULL,
	PRIMARY KEY(`receiver_profile_id`, `version`),
	FOREIGN KEY (`receiver_profile_id`) REFERENCES `receiver_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receiver_consent_version_positive" CHECK("receiver_consent_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE `receiver_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_consent_version` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receiver_consent_version_nonnegative" CHECK("receiver_profiles"."current_consent_version" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receiver_profile_installation_unique` ON `receiver_profiles` (`installation_id`);--> statement-breakpoint
CREATE TABLE `revenue_split_versions` (
	`version` text PRIMARY KEY NOT NULL,
	`receiver_basis_points` integer NOT NULL,
	`operator_basis_points` integer NOT NULL,
	`effective_at` text NOT NULL,
	`retired_at` text,
	CONSTRAINT "revenue_split_receiver_range" CHECK("revenue_split_versions"."receiver_basis_points" >= 0 AND "revenue_split_versions"."receiver_basis_points" <= 10000),
	CONSTRAINT "revenue_split_operator_range" CHECK("revenue_split_versions"."operator_basis_points" >= 0 AND "revenue_split_versions"."operator_basis_points" <= 10000),
	CONSTRAINT "revenue_split_balanced" CHECK("revenue_split_versions"."receiver_basis_points" + "revenue_split_versions"."operator_basis_points" = 10000)
);
