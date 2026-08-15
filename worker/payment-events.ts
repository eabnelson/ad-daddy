import type { TempoTransferEvent } from "../lib/payments/tempo-client.ts";
import { paymentRuntime, type PaymentRuntime } from "../lib/payments/runtime.ts";

export async function processPaymentEvents(events: readonly TempoTransferEvent[], runtime: PaymentRuntime = paymentRuntime) {
  const results = [];
  for (const event of events) results.push(await runtime.deposits.process(event));
  return Object.freeze(results);
}
