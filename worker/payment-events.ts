import type { TempoTransferEvent } from "../lib/payments/tempo-client.ts";
import { getPaymentRuntime, type PaymentRuntime } from "../lib/payments/runtime.ts";

export async function processPaymentEvents(events: readonly TempoTransferEvent[], injectedRuntime?: PaymentRuntime) {
  const runtime = injectedRuntime ?? await getPaymentRuntime();
  const results = [];
  for (const event of events) results.push(await runtime.deposits.process(event));
  return Object.freeze(results);
}
