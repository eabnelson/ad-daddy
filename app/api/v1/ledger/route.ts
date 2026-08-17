import { getPaymentRuntime, type PaymentRuntime } from "../../../../lib/payments/runtime.ts";
import { verifiedAccountId } from "../../../../lib/auth/verified-request-identity.ts";

export function createLedgerHandler(injectedRuntime?: PaymentRuntime) {
  return async function handle(request: Request): Promise<Response> {
    const runtime = injectedRuntime ?? await getPaymentRuntime();
    const accountId = verifiedAccountId(request);
    if (!accountId) return Response.json({ error: "human_authentication_required" }, { status: 401 });
    const ownedAccounts = new Set([`receiver:${accountId}`, `advertiser:${accountId}`]);
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (cursor && cursor.length > 512)) return Response.json({ error: "invalid_pagination" }, { status: 400 });
    const page = runtime.ledgerRepository.listForAccounts
      ? await runtime.ledgerRepository.listForAccounts([...ownedAccounts], { limit, cursor })
      : { transactions: await runtime.ledgerRepository.list(), nextCursor: null };
    const transactions = page.transactions
      .filter((transaction) => transaction.entries.some((entry) => ownedAccounts.has(entry.accountId)))
      .map((transaction) => ({
        transactionId: transaction.transactionId, kind: transaction.kind, currency: transaction.currency,
        referenceId: transaction.referenceId, createdAt: transaction.createdAt, chainReference: transaction.chainReference ?? null,
        entries: transaction.entries.filter((entry) => ownedAccounts.has(entry.accountId)),
      }));
    return Response.json({ transactions, nextCursor: page.nextCursor });
  };
}
export const GET = createLedgerHandler();
