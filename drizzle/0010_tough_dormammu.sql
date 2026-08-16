PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_campaigns` (
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
	`refunded_minor` integer DEFAULT 0 NOT NULL,
	`terms_accepted_at` text,
	`activated_at` text,
	`closed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`brand_id`) REFERENCES `advertiser_brands`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "campaign_amounts_nonnegative" CHECK("__new_campaigns"."maximum_spend_minor" >= 0 AND "__new_campaigns"."maximum_bid_minor" >= 0 AND "__new_campaigns"."daily_cap_minor" >= 0 AND "__new_campaigns"."funded_minor" >= 0 AND "__new_campaigns"."spent_minor" >= 0 AND "__new_campaigns"."refunded_minor" >= 0),
	CONSTRAINT "campaign_bid_within_spend" CHECK("__new_campaigns"."maximum_bid_minor" <= "__new_campaigns"."maximum_spend_minor"),
	CONSTRAINT "campaign_daily_within_spend" CHECK("__new_campaigns"."daily_cap_minor" <= "__new_campaigns"."maximum_spend_minor"),
	CONSTRAINT "campaign_spend_within_funds" CHECK("__new_campaigns"."spent_minor" <= "__new_campaigns"."funded_minor")
);
--> statement-breakpoint
INSERT INTO `__new_campaigns`("id", "account_id", "brand_id", "status", "advertiser_terms_version", "destination_url", "schedule_starts_at", "schedule_ends_at", "audience_json", "offer_json", "creative_json", "conversion_terms", "maximum_spend_minor", "maximum_bid_minor", "daily_cap_minor", "funded_minor", "spent_minor", "refunded_minor", "terms_accepted_at", "activated_at", "closed_at", "created_at", "updated_at") SELECT "id", "account_id", "brand_id", "status", "advertiser_terms_version", "destination_url", "schedule_starts_at", "schedule_ends_at", "audience_json", "offer_json", "creative_json", "conversion_terms", "maximum_spend_minor", "maximum_bid_minor", "daily_cap_minor", "funded_minor", "spent_minor", 0, NULL, "activated_at", "closed_at", "created_at", "updated_at" FROM `campaigns`;--> statement-breakpoint
DROP TABLE `campaigns`;--> statement-breakpoint
ALTER TABLE `__new_campaigns` RENAME TO `campaigns`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `campaign_account_status_idx` ON `campaigns` (`account_id`,`status`);
