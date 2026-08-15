CREATE TABLE `chain_payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`commitment_id` text,
	`chain_id` text NOT NULL,
	`token_address` text NOT NULL,
	`transaction_hash` text NOT NULL,
	`log_index` integer NOT NULL,
	`opaque_memo` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`policy_version` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`commitment_id`) REFERENCES `deposit_commitments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chain_payment_amount_positive" CHECK("chain_payment_events"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chain_payment_event_unique` ON `chain_payment_events` (`chain_id`,`transaction_hash`,`log_index`);--> statement-breakpoint
CREATE INDEX `chain_payment_memo_idx` ON `chain_payment_events` (`opaque_memo`);--> statement-breakpoint
CREATE TABLE `conversion_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`placement_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`evidence_provider` text,
	`evidence_id` text,
	`evidence_type` text NOT NULL,
	`bonus_gross_minor` integer NOT NULL,
	`receiver_minor` integer NOT NULL,
	`operator_minor` integer NOT NULL,
	`status` text NOT NULL,
	`release_at` text,
	`policy_version` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`placement_id`) REFERENCES `placements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversion_claim_amounts_balanced" CHECK("conversion_claims"."bonus_gross_minor" > 0 AND "conversion_claims"."receiver_minor" + "conversion_claims"."operator_minor" = "conversion_claims"."bonus_gross_minor")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversion_claim_placement_unique` ON `conversion_claims` (`placement_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversion_claim_evidence_unique` ON `conversion_claims` (`evidence_provider`,`evidence_id`);--> statement-breakpoint
CREATE TABLE `deposit_commitments` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`advertiser_account_id` text NOT NULL,
	`opaque_memo` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`expected_sender` text,
	`policy_version` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`advertiser_account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deposit_commitment_amount_positive" CHECK("deposit_commitments"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deposit_commitment_memo_unique` ON `deposit_commitments` (`opaque_memo`);--> statement-breakpoint
CREATE TABLE `payout_destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`address` text NOT NULL,
	`approved_at` text NOT NULL,
	`activates_at` text NOT NULL,
	`superseded_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payout_destination_active_idx` ON `payout_destinations` (`account_id`,`activates_at`);--> statement-breakpoint
CREATE TABLE `payout_records` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`opaque_memo` text NOT NULL,
	`status` text NOT NULL,
	`transaction_hash` text,
	`policy_version` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`paid_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`destination_id`) REFERENCES `payout_destinations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payout_record_amount_positive" CHECK("payout_records"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payout_record_memo_unique` ON `payout_records` (`opaque_memo`);--> statement-breakpoint
CREATE TABLE `refund_records` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`address` text NOT NULL,
	`opaque_memo` text NOT NULL,
	`reserved_minor` integer NOT NULL,
	`held_minor` integer NOT NULL,
	`status` text NOT NULL,
	`transaction_hash` text,
	`policy_version` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`paid_at` text,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "refund_record_amounts_nonnegative" CHECK("refund_records"."amount_minor" > 0 AND "refund_records"."reserved_minor" >= 0 AND "refund_records"."held_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refund_record_memo_unique` ON `refund_records` (`opaque_memo`);