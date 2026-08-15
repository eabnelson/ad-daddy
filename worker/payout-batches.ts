import { paymentRuntime, type PaymentRuntime } from "../lib/payments/runtime.ts";

export async function runPayoutBatch(payoutIds: readonly string[], runtime: PaymentRuntime = paymentRuntime) {
  if (payoutIds.length > 100 || new Set(payoutIds).size !== payoutIds.length) throw new Error("Payout batch must contain at most 100 unique records");
  const results = [];
  for (const payoutId of payoutIds) results.push(await runtime.payouts.send(payoutId));
  return Object.freeze(results);
}
