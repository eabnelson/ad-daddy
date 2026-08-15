# Ad Daddy closed-beta runbook

## Launch posture

The default mode is synthetic settlement on Tempo Moderato testnet. Production delivery and production funds stay off until all of these records exist:

- written platform approval for sponsored sidebar-session delivery and use of one display turn;
- legal approval for the marketplace, advertising disclosure, promotions, and receiver compensation;
- custody and data-protection approval;
- an allowlisted production Tempo chain, USD stablecoin, RPC/indexing path, treasury, and payout signer;
- at least two verified design-partner advertisers;
- the complete versioned production policy accepted by `validateLaunchPolicy`.

Native Codex insertion is allowlisted only for the exact version in `CODEX_NATIVE_DELIVERY_VERSIONS`. A new host version must pass the task creation, active-task isolation, sidebar visibility, restart readability, exactly-one display turn, tool-free, instruction-isolation, and retry tests before entering that list.

## Canary limits

Start with invited accounts only. Configure a per-placement cap, per-human and per-installation daily reward cap, campaign maximum and daily cap, aggregate payout ceiling, address-change delay, payout minimum, and conversion dispute hold. Keep the payout signer isolated and destination-restricted. Enable fee sponsorship only inside the same ceilings.

The operator kill switch pauses new auctions, placement delivery, deposits, payouts, and refunds independently. Pausing delivery must not delete receipts or reverse earned base rewards.

## Go / no-go check

Before each canary:

1. Run the full test, typecheck, lint, build, migration-drift, adapter-contract, and payment-reconciliation suites.
2. Confirm production-policy versions and approval record IDs.
3. Confirm the selected token address, chain ID, treasury address, fee payer, and payout-only signer.
4. Reconcile treasury assets to advertiser liabilities, receiver balances, operator fees, reservations, holds, refunds, and in-flight payouts.
5. Confirm the fallback creative origin, CSP, reporting controls, and incident contacts.
6. Send one minimum-value deposit, placement, payout, and refund canary before inviting another account.

Any mismatch is a no-go. Switch the affected rail back to synthetic mode; do not edit historical ledger entries.

## Monitoring and incidents

Monitor fill and no-fill reasons, duplicate-placement attempts, receipt failures, reports, blocks, pauses, uninstalls, reward velocity holds, unknown deposit memos, reorgs, conversion replays, payout retries, and reconciliation imbalance. Advertiser-facing reports never include receiver identity or losing bids.

For a suspected key compromise, disable the relevant credential and rail, rotate with the configured overlap only when safe, preserve audit records, and reconcile every event since the last known-good cursor. A payout signer compromise requires immediate payout kill-switch activation and destination review.
