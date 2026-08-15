# Tempo payment reconciliation

Ad Daddy uses Tempo transfer memos as opaque 32-byte commitments. Internal IDs, receiver IDs, campaign IDs, and placement IDs never appear in an onchain memo. The launch build targets Moderato testnet and keeps production funds disabled.

## Daily proof

Reconcile each finalized deposit, payout, and refund by chain ID, token address, transaction hash, log index where applicable, opaque memo, amount, policy version, and internal ledger transaction. Confirm every internal transaction is balanced and every paid outbound record has exactly one confirmed Tempo receipt.

Treasury assets must reconcile to advertiser funded balances minus spend and refunds, receiver unpaid balances minus payouts, operator fees, active reservations, conversion/compliance holds, and outbound transfers. Never force balance by changing or deleting a posted entry; use a reviewed compensating transaction.

## Unmatched deposit

1. Verify chain, allowlisted token, treasury destination, finality, amount, sender restriction, and 32-byte memo.
2. If no commitment exists, keep the event quarantined and non-spendable.
3. Ask the verified advertiser to identify the intended campaign out of band. Do not accept an agent assertion.
4. Create a reviewed commitment or refund workflow, then post one idempotent ledger transaction bound to the original event.

## Reorganization

Mark the event reorged. If it was credited, post the idempotent compensating transaction and freeze any campaign balance that would become negative. Wait for a new finalized canonical event; never reuse the reorganized event as proof.

## Failed or ambiguous payout

Retry with the same payout ID and opaque memo. The receiver is debited only after a confirmed Tempo receipt, so a transport failure remains retryable without a second debit. If the chain accepted the transfer but the response was lost, the memo-idempotent client must return the existing receipt before ledger posting.

Do not redirect a queued payout after an address change. It keeps the verified destination snapshot it was created with. A later payout may use the new address only after fresh human proof and the configured delay.

## Disputed conversion

Keep the campaign hold active. Verify the allowlisted provider key, evidence ID, signature, amount, campaign terms, occurrence time, claim deadline, and replay status. Rejecting a claim releases the hold; paying it commits the hold and posts the conversion transaction once. Advertiser assertions alone are never proof.

## Campaign refund

Close the campaign before computing withdrawable funds. Show funded, spent, reserved, held, and withdrawable amounts separately. A verified human approves the refund address and exact withdrawable amount with recent authentication. Retry with the same refund ID and opaque memo until the onchain receipt is confirmed.
