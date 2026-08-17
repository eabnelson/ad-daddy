import assert from "node:assert/strict";
import test from "node:test";

import { createLedgerHandler } from "../../app/api/v1/ledger/route.ts";
import { D1LedgerRepository } from "../../lib/payments/d1-repositories.ts";
import { LedgerService } from "../../lib/payments/ledger.ts";
import type { PaymentRuntime } from "../../lib/payments/runtime.ts";
import { createMigratedD1 } from "../helpers/sqlite-d1.ts";

test("ledger history uses account-scoped keyset pages without leaking another account", async (t) => {
  const migrated = createMigratedD1();
  t.after(migrated.close);
  const repository = new D1LedgerRepository(migrated.database);
  const ledger = new LedgerService(repository);
  await post(ledger, "txn_old", "receiver:account_1", "2026-08-15T19:00:00.000Z");
  await post(ledger, "txn_other", "receiver:account_2", "2026-08-15T20:00:00.000Z");
  await post(ledger, "txn_new", "advertiser:account_1", "2026-08-15T21:00:00.000Z");
  const handler = createLedgerHandler({ ledgerRepository: repository } as PaymentRuntime);

  const first = await handler(new Request("https://ad.daddy/api/v1/ledger?limit=1", {
    headers: { "x-ad-daddy-verified-account-id": "account_1" },
  }));
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { transactions: Array<{ transactionId: string; entries: Array<{ accountId: string }> }>; nextCursor: string };
  assert.deepEqual(firstBody.transactions.map((transaction) => transaction.transactionId), ["txn_new"]);
  assert.deepEqual(firstBody.transactions[0]?.entries.map((entry) => entry.accountId), ["advertiser:account_1"]);
  assert.ok(firstBody.nextCursor);

  const second = await handler(new Request(`https://ad.daddy/api/v1/ledger?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`, {
    headers: { "x-ad-daddy-verified-account-id": "account_1" },
  }));
  const secondBody = await second.json() as { transactions: Array<{ transactionId: string }>; nextCursor: string | null };
  assert.deepEqual(secondBody.transactions.map((transaction) => transaction.transactionId), ["txn_old"]);
  assert.notEqual(secondBody.transactions[0]?.transactionId, "txn_other");
});

async function post(ledger: LedgerService, transactionId: string, ownedAccount: string, createdAt: string) {
  await ledger.post({
    transactionId, idempotencyKey: transactionId, kind: "placement_settlement", currency: "USDC", referenceId: transactionId, createdAt,
    entries: [{ accountId: ownedAccount, amountMinor: 100 }, { accountId: "operator:treasury", amountMinor: -100 }],
  });
}
