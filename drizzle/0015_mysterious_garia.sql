DROP TABLE IF EXISTS `__ad_daddy_0015_receiver_profile_preflight`;--> statement-breakpoint
CREATE TABLE `__ad_daddy_0015_receiver_profile_preflight` (
	`ok` integer NOT NULL,
	CONSTRAINT "receiver_profiles_must_be_empty_before_0015" CHECK (`ok` = 1)
);--> statement-breakpoint
INSERT INTO `__ad_daddy_0015_receiver_profile_preflight` (`ok`)
SELECT CASE WHEN (SELECT COUNT(*) FROM `receiver_profiles`) = 0 THEN 1 ELSE 0 END;--> statement-breakpoint
DROP TABLE `__ad_daddy_0015_receiver_profile_preflight`;--> statement-breakpoint
CREATE TABLE `campaign_refund_withdrawals` (
	`refund_id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`applied_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "campaign_refund_withdrawal_amount_positive" CHECK("campaign_refund_withdrawals"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_refund_withdrawal_campaign_unique` ON `campaign_refund_withdrawals` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `receiver_advertiser_blocks` (
	`receiver_account_id` text NOT NULL,
	`advertiser_id` text NOT NULL,
	`source_placement_id` text,
	`blocked_at` text NOT NULL,
	PRIMARY KEY(`receiver_account_id`, `advertiser_id`),
	FOREIGN KEY (`receiver_account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`advertiser_id`) REFERENCES `advertiser_brands`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_placement_id`) REFERENCES `placements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `receiver_advertiser_block_advertiser_idx` ON `receiver_advertiser_blocks` (`advertiser_id`,`receiver_account_id`);--> statement-breakpoint
ALTER TABLE `receiver_profiles` ADD `config_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX `receiver_profile_account_idx` ON `receiver_profiles` (`account_id`,`id`);--> statement-breakpoint
CREATE INDEX `opportunity_expiry_order_idx` ON `opportunities` (`state`,`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `auction_bid_campaign_lookup_idx` ON `auction_bids` (`campaign_id`,`auction_id`);--> statement-breakpoint
CREATE INDEX `placement_updated_feed_idx` ON `placements` (`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `placement_claim_expiry_order_idx` ON `placement_claims` (`state`,`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `placement_delivery_lease_expiry_order_idx` ON `placement_delivery_leases` (`state`,`expires_at`,`claim_id`);--> statement-breakpoint
CREATE INDEX `placement_receipt_recovery_grace_order_idx` ON `placement_receipt_recovery` (`state`,`grace_expires_at`,`claim_id`);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_placement_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`placement_id` text NOT NULL,
	`opportunity_id` text NOT NULL,
	`reservation_id` text,
	`reward_reference_id` text NOT NULL,
	`receiver_profile_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`consent_version` integer NOT NULL,
	`device_key_thumbprint` text NOT NULL,
	`creative_digest` text NOT NULL,
	`state` text NOT NULL,
	`grant_json` text NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`cancelled_at` text,
	`settlement_review_started_at` text,
	`settlement_review_deadline_at` text,
	FOREIGN KEY (`placement_id`) REFERENCES `placements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reservation_id`) REFERENCES `campaign_budget_reservations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receiver_profile_id`) REFERENCES `receiver_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "placement_claim_consent_version_positive" CHECK("__new_placement_claims"."consent_version" > 0),
	CONSTRAINT "placement_claim_reward_reference_valid" CHECK(("__new_placement_claims"."reservation_id" IS NOT NULL AND "__new_placement_claims"."reward_reference_id" = "__new_placement_claims"."reservation_id") OR ("__new_placement_claims"."reservation_id" IS NULL AND "__new_placement_claims"."reward_reference_id" LIKE 'offer:%'))
);
--> statement-breakpoint
INSERT INTO `__new_placement_claims` (
	`id`, `placement_id`, `opportunity_id`, `reservation_id`, `reward_reference_id`, `receiver_profile_id`, `installation_id`,
	`consent_version`, `device_key_thumbprint`, `creative_digest`, `state`, `grant_json`, `issued_at`, `expires_at`,
	`consumed_at`, `cancelled_at`, `settlement_review_started_at`, `settlement_review_deadline_at`
) SELECT
	`id`, `placement_id`, `opportunity_id`, `reservation_id`, `reservation_id`, `receiver_profile_id`, `installation_id`,
	`consent_version`, `device_key_thumbprint`, `creative_digest`, `state`, `grant_json`, `issued_at`, `expires_at`,
	`consumed_at`, `cancelled_at`, `settlement_review_started_at`, `settlement_review_deadline_at`
FROM `placement_claims`;
--> statement-breakpoint
DROP TABLE `placement_claims`;
--> statement-breakpoint
ALTER TABLE `__new_placement_claims` RENAME TO `placement_claims`;
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_claim_placement_unique` ON `placement_claims` (`placement_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_claim_opportunity_unique` ON `placement_claims` (`opportunity_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_claim_reservation_unique` ON `placement_claims` (`reservation_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_claim_reward_reference_unique` ON `placement_claims` (`reward_reference_id`);
--> statement-breakpoint
CREATE INDEX `placement_claim_installation_state_idx` ON `placement_claims` (`installation_id`,`state`);
--> statement-breakpoint
CREATE INDEX `placement_claim_expiry_idx` ON `placement_claims` (`state`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `placement_claim_expiry_order_idx` ON `placement_claims` (`state`,`expires_at`,`id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
