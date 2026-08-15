CREATE TABLE `device_proof_nonces` (
	`installation_id` text NOT NULL,
	`nonce` text NOT NULL,
	`canonical_request_sha256` text NOT NULL,
	`first_used_at` text NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`installation_id`, `nonce`),
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `device_proof_nonce_expiry_idx` ON `device_proof_nonces` (`expires_at`);--> statement-breakpoint
CREATE TABLE `installation_device_keys` (
	`installation_id` text NOT NULL,
	`key_version` integer NOT NULL,
	`algorithm` text NOT NULL,
	`public_jwk_json` text NOT NULL,
	`key_thumbprint` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`enrolled_at` text NOT NULL,
	`retired_at` text,
	`revoked_at` text,
	PRIMARY KEY(`installation_id`, `key_version`),
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "installation_device_key_version_positive" CHECK("installation_device_keys"."key_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `installation_device_key_thumbprint_unique` ON `installation_device_keys` (`installation_id`,`key_thumbprint`);--> statement-breakpoint
CREATE INDEX `installation_device_key_status_idx` ON `installation_device_keys` (`installation_id`,`status`);--> statement-breakpoint
CREATE TABLE `placement_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`placement_id` text NOT NULL,
	`opportunity_id` text NOT NULL,
	`reservation_id` text NOT NULL,
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
	FOREIGN KEY (`placement_id`) REFERENCES `placements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reservation_id`) REFERENCES `campaign_budget_reservations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receiver_profile_id`) REFERENCES `receiver_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "placement_claim_consent_version_positive" CHECK("placement_claims"."consent_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_claim_placement_unique` ON `placement_claims` (`placement_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `placement_claim_opportunity_unique` ON `placement_claims` (`opportunity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `placement_claim_reservation_unique` ON `placement_claims` (`reservation_id`);--> statement-breakpoint
CREATE INDEX `placement_claim_installation_state_idx` ON `placement_claims` (`installation_id`,`state`);--> statement-breakpoint
CREATE INDEX `placement_claim_expiry_idx` ON `placement_claims` (`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `placement_delivery_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`device_key_thumbprint` text NOT NULL,
	`creative_digest` text NOT NULL,
	`policy_version` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`displayed_at` text,
	FOREIGN KEY (`claim_id`) REFERENCES `placement_claims`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_delivery_lease_claim_unique` ON `placement_delivery_leases` (`claim_id`);--> statement-breakpoint
CREATE INDEX `placement_delivery_lease_expiry_idx` ON `placement_delivery_leases` (`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `placement_receipt_recovery` (
	`claim_id` text PRIMARY KEY NOT NULL,
	`placement_id` text NOT NULL,
	`lease_id` text NOT NULL,
	`display_receipt_digest` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`policy_version` text NOT NULL,
	`resolution_authority` text NOT NULL,
	`displayed_at` text NOT NULL,
	`grace_expires_at` text NOT NULL,
	`settlement_review_deadline_at` text NOT NULL,
	`receipt_submitted_at` text,
	`resolved_at` text,
	`resolution_audit_event_id` text,
	FOREIGN KEY (`claim_id`) REFERENCES `placement_claims`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`placement_id`) REFERENCES `placements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lease_id`) REFERENCES `placement_delivery_leases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolution_audit_event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_receipt_recovery_placement_unique` ON `placement_receipt_recovery` (`placement_id`);--> statement-breakpoint
CREATE INDEX `placement_receipt_recovery_deadline_idx` ON `placement_receipt_recovery` (`state`,`grace_expires_at`,`settlement_review_deadline_at`);--> statement-breakpoint
DROP TRIGGER `placement_state_on_insert`;--> statement-breakpoint
DROP TRIGGER `placement_state_forward_only`;--> statement-breakpoint
CREATE TRIGGER `placement_state_on_insert`
BEFORE INSERT ON `placements`
WHEN NEW.`state` NOT IN ('offered', 'bidding', 'won', 'claimed', 'delivery_leased', 'displayed_pending_receipt', 'delivered', 'settled', 'settlement_review', 'cancelled', 'conversion_pending', 'conversion_paid', 'conversion_rejected', 'no_fill', 'expired')
BEGIN
	SELECT RAISE(ABORT, 'invalid placement state');
END;--> statement-breakpoint
CREATE TRIGGER `placement_state_forward_only`
BEFORE UPDATE OF `state` ON `placements`
WHEN NEW.`state` <> OLD.`state` AND NOT (
	(OLD.`state` = 'offered' AND NEW.`state` IN ('bidding', 'no_fill'))
	OR (OLD.`state` = 'bidding' AND NEW.`state` IN ('won', 'no_fill'))
	OR (OLD.`state` = 'won' AND NEW.`state` IN ('claimed', 'expired', 'cancelled'))
	OR (OLD.`state` = 'claimed' AND NEW.`state` IN ('delivery_leased', 'expired', 'cancelled'))
	OR (OLD.`state` = 'delivery_leased' AND NEW.`state` IN ('displayed_pending_receipt', 'expired', 'cancelled'))
	OR (OLD.`state` = 'displayed_pending_receipt' AND NEW.`state` IN ('delivered', 'settlement_review'))
	OR (OLD.`state` = 'settlement_review' AND NEW.`state` IN ('delivered', 'cancelled'))
	OR (OLD.`state` = 'delivered' AND NEW.`state` = 'settled')
	OR (OLD.`state` = 'settled' AND NEW.`state` = 'conversion_pending')
	OR (OLD.`state` = 'conversion_pending' AND NEW.`state` IN ('conversion_paid', 'conversion_rejected'))
)
BEGIN
	SELECT RAISE(ABORT, 'illegal placement state transition');
END;
