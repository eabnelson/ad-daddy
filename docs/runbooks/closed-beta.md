# Ad Daddy closed-beta runbook

## Launch posture

The default mode is synthetic settlement on Tempo Moderato testnet. Production delivery and production funds stay off until all of these records exist:

- a recorded review of the current published host contract and terms, plus a passing exact-version capability probe for the receiver-initiated integration; no separate platform sponsorship approval is required;
- legal approval for the marketplace, advertising disclosure, promotions, and receiver compensation;
- custody and data-protection approval;
- an allowlisted production Tempo chain, USD stablecoin, RPC/indexing path, treasury, and payout signer;
- at least two verified design-partner advertisers;
- the complete versioned production policy accepted by `validateLaunchPolicy`.

Native Codex insertion is allowlisted only for the exact version in `CODEX_NATIVE_DELIVERY_VERSIONS`. A new host version must pass the task creation, active-task isolation, sidebar visibility, restart readability, exactly-one display turn, tool-free, instruction-isolation, and retry tests before entering that list. In production, the connection must additionally provide a host-derived `builtInToolsDisabled: true` capability before Ad Daddy sends any advertiser content to `turn/start`; config flags, read-only sandboxing, post-hoc tool detection, or an operator assertion do not satisfy this gate. Current App Server builds do not expose that proof, so native sidebar delivery remains test/staging-only until the host does. This is a technical capability requirement, not a request for OpenAI approval.

Production stablecoin settlement is code-gated off by `assertProductionCashSettlementCapability` until host-integrity receipts and durable per-human, per-installation, and aggregate reward-velocity controls exist. Deployment configuration cannot bypass this implementation gate. This is independent of platform sponsorship approval: the protocol does not require special OpenAI approval, while the current host contract/terms review and exact-version capability evidence remain ordinary launch requirements.

The signed-HTML fallback is not receipt-eligible merely because the CLI wrote fallback metadata. A local presenter must return verified display time and output integrity evidence before the client can create a signed display receipt. If a native host turn may already exist, fallback is suppressed so one claim cannot appear on two surfaces.

## Canary limits

Start with invited accounts only. Configure a per-placement cap, per-human and per-installation daily reward cap, campaign maximum and daily cap, aggregate payout ceiling, address-change delay, payout minimum, and conversion dispute hold. Keep the payout signer isolated and destination-restricted. Enable fee sponsorship only inside the same ceilings.

The operator kill switch pauses new auctions, placement delivery, deposits, payouts, and refunds independently. Pausing delivery must not delete receipts or reverse earned base rewards.

## Go / no-go check

Before each canary:

1. Run the full test, typecheck, lint, build, migration-drift, adapter-contract, and payment-reconciliation suites.
2. Confirm production-policy versions and required legal, custody, data-protection, and payment review record IDs.
3. Confirm the selected token address, chain ID, treasury address, fee payer, and payout-only signer.
4. Reconcile treasury assets to advertiser liabilities, receiver balances, operator fees, reservations, holds, refunds, and in-flight payouts.
5. Confirm the fallback creative origin, CSP, reporting controls, and incident contacts.
6. Confirm a receiver-device fetch opens or coalesces one opportunity, returns `pending` during bidding, reuses the auction's single winning reservation, and issues one installation-bound claim only after clearance.
7. Confirm cross-installation replay fails, the signed grant contains its exact claim ID, protected creative redemption and receipt submission require fresh device proof, a final local pause cancels an undisplayed lease idempotently, an unredeemed claim releases its reservation on expiry, and a displayed placement retains its reservation through receipt recovery or settlement review. Exercise the minute reconciliation trigger and prove that settlement review changes money only after two distinct allowlisted operators agree; settlement additionally requires the durable verified receipt.
8. Confirm the CLI rejects scheduler configuration and that the receiver can claim inventory only through an explicit manual check.
9. Send one minimum-value deposit, placement, payout, and refund canary before inviting another account.

Any mismatch is a no-go. Switch the affected rail back to synthetic mode; do not edit historical ledger entries.

## Migration 0015 receiver-profile preflight

Migration `0015_mysterious_garia.sql` intentionally aborts before its feature schema changes when `receiver_profiles` contains any row. The prior schema does not contain enough data to reconstruct the exact editable settings, disclosure, cadence, and immutable published snapshot represented by `config_json`; silently writing `{}` would make those receivers unreadable and could misstate consent.

Before applying 0015, run `SELECT COUNT(*) AS legacy_receiver_profiles FROM receiver_profiles;`. A zero result is the only automatic go path. For a nonzero result, stop the deployment and keep delivery paused. Snapshot and retain the old D1 database as read-only evidence, provision a fresh D1 database, run the complete migration chain there, switch the binding only after verification, and have each receiver review and republish preferences through the authenticated settings flow. Do not delete, rewrite, or synthesize consent history merely to pass the check. The preflight table is retry-safe when an interrupted migration is rerun against an otherwise eligible database.

## Monitoring and incidents

Monitor fill and no-fill reasons, duplicate-placement attempts, receipt failures, reports, blocks, pauses, uninstalls, reward velocity holds, unknown deposit memos, reorgs, conversion replays, payout retries, and reconciliation imbalance. Advertiser-facing reports never include receiver identity or losing bids.

For a suspected key compromise, disable the relevant credential and rail, rotate with the configured overlap only when safe, preserve audit records, and reconcile every event since the last known-good cursor. A payout signer compromise requires immediate payout kill-switch activation and destination review.
