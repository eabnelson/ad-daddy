CREATE TABLE `auction_bids` (
	`id` text PRIMARY KEY NOT NULL,
	`auction_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`reward_lane` text NOT NULL,
	`gross_amount_minor` integer NOT NULL,
	`receiver_amount_minor` integer NOT NULL,
	`operator_amount_minor` integer NOT NULL,
	`submitted_at` text NOT NULL,
	FOREIGN KEY (`auction_id`) REFERENCES `auctions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "auction_bid_amounts_nonnegative" CHECK("auction_bids"."gross_amount_minor" >= 0 AND "auction_bids"."receiver_amount_minor" >= 0 AND "auction_bids"."operator_amount_minor" >= 0),
	CONSTRAINT "auction_bid_split_balanced" CHECK("auction_bids"."receiver_amount_minor" + "auction_bids"."operator_amount_minor" = "auction_bids"."gross_amount_minor")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auction_bid_campaign_unique` ON `auction_bids` (`auction_id`,`campaign_id`);--> statement-breakpoint
CREATE INDEX `auction_bid_rank_idx` ON `auction_bids` (`auction_id`,`gross_amount_minor`);--> statement-breakpoint
CREATE TABLE `auction_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`auction_id` text NOT NULL,
	`winner_bid_id` text,
	`reservation_id` text,
	`eligible_bidder_count` integer NOT NULL,
	`no_fill_reason` text,
	`decided_at` text NOT NULL,
	FOREIGN KEY (`auction_id`) REFERENCES `auctions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`winner_bid_id`) REFERENCES `auction_bids`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "auction_decision_bidder_count_nonnegative" CHECK("auction_decisions"."eligible_bidder_count" >= 0),
	CONSTRAINT "auction_decision_exact_outcome" CHECK(("auction_decisions"."winner_bid_id" IS NOT NULL AND "auction_decisions"."no_fill_reason" IS NULL) OR ("auction_decisions"."winner_bid_id" IS NULL AND "auction_decisions"."no_fill_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auction_decision_once_unique` ON `auction_decisions` (`auction_id`);--> statement-breakpoint
CREATE TABLE `auctions` (
	`id` text PRIMARY KEY NOT NULL,
	`opportunity_id` text NOT NULL,
	`reward_lane` text NOT NULL,
	`consent_version` integer NOT NULL,
	`minimum_take_home_minor` integer NOT NULL,
	`matched_signal_names_json` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`closes_at` text NOT NULL,
	`decided_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "auction_consent_version_positive" CHECK("auctions"."consent_version" > 0),
	CONSTRAINT "auction_minimum_nonnegative" CHECK("auctions"."minimum_take_home_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auction_opportunity_unique` ON `auctions` (`opportunity_id`);--> statement-breakpoint
CREATE INDEX `auction_deadline_status_idx` ON `auctions` (`status`,`closes_at`);