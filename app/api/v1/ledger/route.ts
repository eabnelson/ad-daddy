import { getPaymentRuntime, type PaymentRuntime } from "../../../../lib/payments/runtime.ts";

export function createLedgerHandler(injectedRuntime?: PaymentRuntime) {
  return async function handle(request: Request): Promise<Response> {
    const runtime = injectedRuntime ?? await getPaymentRuntime();
    const accountId = request.headers.get("oai-authenticated-user-id");
    if (!accountId) return Response.json({ error: "human_authentication_required" }, { status: 401 });
    const ownedAccounts = new Set([`receiver:${accountId}`, `advertiser:${accountId}`]);
    const transactions = (await runtime.ledgerRepository.list())
      .filter((transaction) => transaction.entries.some((entry) => ownedAccounts.has(entry.accountId)))
      .map((transaction) => ({
        transactionId: transaction.transactionId, kind: transaction.kind, currency: transaction.currency,
        referenceId: transaction.referenceId, createdAt: transaction.createdAt, chainReference: transaction.chainReference ?? null,
        entries: transaction.entries.filter((entry) => ownedAccounts.has(entry.accountId)),
      }));
    return Response.json({ transactions });
  };
}
export const GET = createLedgerHandler();
