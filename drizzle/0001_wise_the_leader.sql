ALTER TABLE `ledger_transactions` ADD `status` text DEFAULT 'draft' NOT NULL;--> statement-breakpoint

CREATE TRIGGER `audit_events_immutable_update`
BEFORE UPDATE ON `audit_events`
BEGIN
	SELECT RAISE(ABORT, 'audit_events are immutable');
END;--> statement-breakpoint

CREATE TRIGGER `audit_events_immutable_delete`
BEFORE DELETE ON `audit_events`
BEGIN
	SELECT RAISE(ABORT, 'audit_events are immutable');
END;--> statement-breakpoint

CREATE TRIGGER `receiver_consent_versions_forward_only`
BEFORE INSERT ON `receiver_consent_versions`
WHEN NEW.`version` <> COALESCE((
	SELECT MAX(`version`) + 1 FROM `receiver_consent_versions`
	WHERE `receiver_profile_id` = NEW.`receiver_profile_id`
), 1)
OR (
	(NEW.`version` = 1 AND NEW.`previous_version` IS NOT NULL)
	OR (NEW.`version` > 1 AND NEW.`previous_version` <> NEW.`version` - 1)
)
BEGIN
	SELECT RAISE(ABORT, 'consent versions must advance by exactly one');
END;--> statement-breakpoint

CREATE TRIGGER `receiver_consent_versions_immutable_update`
BEFORE UPDATE ON `receiver_consent_versions`
BEGIN
	SELECT RAISE(ABORT, 'receiver consent versions are immutable');
END;--> statement-breakpoint

CREATE TRIGGER `receiver_consent_versions_immutable_delete`
BEFORE DELETE ON `receiver_consent_versions`
BEGIN
	SELECT RAISE(ABORT, 'receiver consent versions are immutable');
END;--> statement-breakpoint

CREATE TRIGGER `revenue_split_versions_immutable_update`
BEFORE UPDATE ON `revenue_split_versions`
WHEN NOT (
	OLD.`retired_at` IS NULL
	AND NEW.`retired_at` IS NOT NULL
	AND NEW.`version` = OLD.`version`
	AND NEW.`receiver_basis_points` = OLD.`receiver_basis_points`
	AND NEW.`operator_basis_points` = OLD.`operator_basis_points`
	AND NEW.`effective_at` = OLD.`effective_at`
)
BEGIN
	SELECT RAISE(ABORT, 'revenue split terms are immutable');
END;--> statement-breakpoint

CREATE TRIGGER `revenue_split_versions_immutable_delete`
BEFORE DELETE ON `revenue_split_versions`
BEGIN
	SELECT RAISE(ABORT, 'revenue split versions are immutable');
END;--> statement-breakpoint

CREATE TRIGGER `placement_state_on_insert`
BEFORE INSERT ON `placements`
WHEN NEW.`state` NOT IN ('offered', 'bidding', 'won', 'delivered', 'settled', 'conversion_pending', 'conversion_paid', 'conversion_rejected', 'no_fill', 'expired')
BEGIN
	SELECT RAISE(ABORT, 'invalid placement state');
END;--> statement-breakpoint

CREATE TRIGGER `placement_state_forward_only`
BEFORE UPDATE OF `state` ON `placements`
WHEN NEW.`state` <> OLD.`state` AND NOT (
	(OLD.`state` = 'offered' AND NEW.`state` IN ('bidding', 'no_fill'))
	OR (OLD.`state` = 'bidding' AND NEW.`state` IN ('won', 'no_fill'))
	OR (OLD.`state` = 'won' AND NEW.`state` IN ('delivered', 'expired'))
	OR (OLD.`state` = 'delivered' AND NEW.`state` = 'settled')
	OR (OLD.`state` = 'settled' AND NEW.`state` = 'conversion_pending')
	OR (OLD.`state` = 'conversion_pending' AND NEW.`state` IN ('conversion_paid', 'conversion_rejected'))
)
BEGIN
	SELECT RAISE(ABORT, 'illegal placement state transition');
END;--> statement-breakpoint

CREATE TRIGGER `ledger_transaction_draft_on_insert`
BEFORE INSERT ON `ledger_transactions`
WHEN NEW.`status` <> 'draft'
BEGIN
	SELECT RAISE(ABORT, 'ledger transactions must begin as draft');
END;--> statement-breakpoint

CREATE TRIGGER `ledger_entry_matches_draft_transaction`
BEFORE INSERT ON `ledger_entries`
WHEN NOT EXISTS (
	SELECT 1 FROM `ledger_transactions`
	WHERE `id` = NEW.`transaction_id`
	AND `status` = 'draft'
	AND `currency` = NEW.`currency`
)
BEGIN
	SELECT RAISE(ABORT, 'ledger entry requires a same-currency draft transaction');
END;--> statement-breakpoint

CREATE TRIGGER `ledger_transaction_seal_balanced`
BEFORE UPDATE OF `status` ON `ledger_transactions`
WHEN OLD.`status` = 'draft' AND NEW.`status` = 'posted' AND (
	NEW.`entry_count` <> (SELECT COUNT(*) FROM `ledger_entries` WHERE `transaction_id` = NEW.`id`)
	OR (SELECT COALESCE(SUM(`amount_minor`), 0) FROM `ledger_entries` WHERE `transaction_id` = NEW.`id`) <> 0
	OR EXISTS (SELECT 1 FROM `ledger_entries` WHERE `transaction_id` = NEW.`id` AND `currency` <> NEW.`currency`)
)
BEGIN
	SELECT RAISE(ABORT, 'ledger transaction entries must be complete, balanced, and same-currency');
END;--> statement-breakpoint

CREATE TRIGGER `ledger_transaction_status_valid`
BEFORE UPDATE OF `status` ON `ledger_transactions`
WHEN NEW.`status` NOT IN ('draft', 'posted')
BEGIN
	SELECT RAISE(ABORT, 'invalid ledger transaction status');
END;--> statement-breakpoint

CREATE TRIGGER `ledger_transaction_posted_immutable`
BEFORE UPDATE ON `ledger_transactions`
WHEN OLD.`status` = 'posted'
BEGIN
	SELECT RAISE(ABORT, 'posted ledger transactions are immutable');
END;--> statement-breakpoint

CREATE TRIGGER `ledger_transaction_no_delete`
BEFORE DELETE ON `ledger_transactions`
BEGIN
	SELECT RAISE(ABORT, 'ledger transactions cannot be deleted');
END;--> statement-breakpoint

CREATE TRIGGER `ledger_entry_posted_immutable_update`
BEFORE UPDATE ON `ledger_entries`
WHEN EXISTS (SELECT 1 FROM `ledger_transactions` WHERE `id` = OLD.`transaction_id` AND `status` = 'posted')
BEGIN
	SELECT RAISE(ABORT, 'posted ledger entries are immutable');
END;--> statement-breakpoint

CREATE TRIGGER `ledger_entry_posted_immutable_delete`
BEFORE DELETE ON `ledger_entries`
WHEN EXISTS (SELECT 1 FROM `ledger_transactions` WHERE `id` = OLD.`transaction_id` AND `status` = 'posted')
BEGIN
	SELECT RAISE(ABORT, 'posted ledger entries are immutable');
END;
