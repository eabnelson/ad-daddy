CREATE TABLE `advertiser_brands` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`verified_domain` text NOT NULL,
	`ownership_status` text DEFAULT 'pending' NOT NULL,
	`verified_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advertiser_brand_domain_unique` ON `advertiser_brands` (`verified_domain`);--> statement-breakpoint
CREATE INDEX `advertiser_brand_account_idx` ON `advertiser_brands` (`account_id`);--> statement-breakpoint
CREATE TABLE `advertiser_terms_acceptances` (
	`account_id` text NOT NULL,
	`version` text NOT NULL,
	`accepted_at` text NOT NULL,
	`approval_id` text NOT NULL,
	PRIMARY KEY(`account_id`, `version`),
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `campaign_agent_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes_json` text NOT NULL,
	`spend_ceiling_minor` integer NOT NULL,
	`spent_minor` integer DEFAULT 0 NOT NULL,
	`bid_ceiling_minor` integer NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "campaign_agent_token_ceilings_nonnegative" CHECK("campaign_agent_tokens"."spend_ceiling_minor" >= 0 AND "campaign_agent_tokens"."spent_minor" >= 0 AND "campaign_agent_tokens"."bid_ceiling_minor" >= 0),
	CONSTRAINT "campaign_agent_token_bid_within_spend" CHECK("campaign_agent_tokens"."bid_ceiling_minor" <= "campaign_agent_tokens"."spend_ceiling_minor"),
	CONSTRAINT "campaign_agent_token_spent_within_ceiling" CHECK("campaign_agent_tokens"."spent_minor" <= "campaign_agent_tokens"."spend_ceiling_minor")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_agent_token_hash_unique` ON `campaign_agent_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `campaign_agent_token_campaign_expiry_idx` ON `campaign_agent_tokens` (`campaign_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `campaign_budget_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`reason` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`released_at` text,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "campaign_hold_amount_positive" CHECK("campaign_budget_holds"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE INDEX `campaign_hold_status_idx` ON `campaign_budget_holds` (`campaign_id`,`status`);--> statement-breakpoint
CREATE TABLE `campaign_budget_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`budget_day` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`released_at` text,
	`committed_at` text,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "campaign_reservation_amount_positive" CHECK("campaign_budget_reservations"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_reservation_idempotency_unique` ON `campaign_budget_reservations` (`campaign_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `campaign_reservation_budget_idx` ON `campaign_budget_reservations` (`campaign_id`,`budget_day`,`status`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`brand_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`advertiser_terms_version` text NOT NULL,
	`destination_url` text NOT NULL,
	`schedule_starts_at` text NOT NULL,
	`schedule_ends_at` text NOT NULL,
	`audience_json` text NOT NULL,
	`offer_json` text NOT NULL,
	`creative_json` text NOT NULL,
	`conversion_terms` text NOT NULL,
	`maximum_spend_minor` integer NOT NULL,
	`maximum_bid_minor` integer NOT NULL,
	`daily_cap_minor` integer NOT NULL,
	`funded_minor` integer DEFAULT 0 NOT NULL,
	`spent_minor` integer DEFAULT 0 NOT NULL,
	`activated_at` text,
	`closed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`brand_id`) REFERENCES `advertiser_brands`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "campaign_amounts_nonnegative" CHECK("campaigns"."maximum_spend_minor" >= 0 AND "campaigns"."maximum_bid_minor" >= 0 AND "campaigns"."daily_cap_minor" >= 0 AND "campaigns"."funded_minor" >= 0 AND "campaigns"."spent_minor" >= 0),
	CONSTRAINT "campaign_bid_within_spend" CHECK("campaigns"."maximum_bid_minor" <= "campaigns"."maximum_spend_minor"),
	CONSTRAINT "campaign_daily_within_spend" CHECK("campaigns"."daily_cap_minor" <= "campaigns"."maximum_spend_minor"),
	CONSTRAINT "campaign_spend_within_funds" CHECK("campaigns"."spent_minor" <= "campaigns"."funded_minor")
);
--> statement-breakpoint
CREATE INDEX `campaign_account_status_idx` ON `campaigns` (`account_id`,`status`);
