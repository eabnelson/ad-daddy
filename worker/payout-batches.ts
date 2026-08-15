import { getPaymentRuntime, type PaymentRuntime } from "../lib/payments/runtime.ts";

export async function runPayoutBatch(payoutIds: readonly string[], injectedRuntime?: PaymentRuntime) {
  const runtime = injectedRuntime ?? await getPaymentRuntime();
  if (payoutIds.length > 100 || new Set(payoutIds).size !== payoutIds.length) throw new Error("Payout batch must contain at most 100 unique records");
  const results = [];
  for (const payoutId of payoutIds) results.push(await runtime.payouts.send(payoutId));
  return Object.freeze(results);
}
