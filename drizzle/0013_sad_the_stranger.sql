ALTER TABLE `placement_claims` ADD `settlement_review_started_at` text;--> statement-breakpoint
ALTER TABLE `placement_claims` ADD `settlement_review_deadline_at` text;--> statement-breakpoint
ALTER TABLE `placement_receipt_recovery` ADD `display_receipt_json` text;--> statement-breakpoint
DROP TRIGGER `placement_state_forward_only`;--> statement-breakpoint
CREATE TRIGGER `placement_state_forward_only`
BEFORE UPDATE OF `state` ON `placements`
WHEN NEW.`state` <> OLD.`state` AND NOT (
	(OLD.`state` = 'offered' AND NEW.`state` IN ('bidding', 'no_fill'))
	OR (OLD.`state` = 'bidding' AND NEW.`state` IN ('won', 'no_fill'))
	OR (OLD.`state` = 'won' AND NEW.`state` IN ('claimed', 'expired', 'cancelled'))
	OR (OLD.`state` = 'claimed' AND NEW.`state` IN ('delivery_leased', 'expired', 'cancelled'))
	OR (OLD.`state` = 'delivery_leased' AND NEW.`state` IN ('displayed_pending_receipt', 'settlement_review', 'expired', 'cancelled'))
	OR (OLD.`state` = 'displayed_pending_receipt' AND NEW.`state` IN ('delivered', 'settlement_review'))
	OR (OLD.`state` = 'delivered' AND NEW.`state` IN ('settled', 'settlement_review'))
	OR (OLD.`state` = 'settlement_review' AND NEW.`state` IN ('delivered', 'settled', 'expired', 'cancelled'))
	OR (OLD.`state` = 'settled' AND NEW.`state` = 'conversion_pending')
	OR (OLD.`state` = 'conversion_pending' AND NEW.`state` IN ('conversion_paid', 'conversion_rejected'))
)
BEGIN
	SELECT RAISE(ABORT, 'illegal placement state transition');
END;
