CREATE TABLE `campaign_agent_token_spends` (
	`token_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`committed_at` text,
	`released_at` text,
	PRIMARY KEY(`token_id`, `idempotency_key`),
	FOREIGN KEY (`token_id`) REFERENCES `campaign_agent_tokens`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "campaign_agent_token_spend_amount_positive" CHECK("campaign_agent_token_spends"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE INDEX `campaign_agent_token_spend_status_idx` ON `campaign_agent_token_spends` (`token_id`,`status`);--> statement-breakpoint
ALTER TABLE `campaign_budget_holds` ADD `committed_at` text;