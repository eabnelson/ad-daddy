import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryLedgerRepository,
  LedgerInvariantError,
  LedgerService,
  calculateRevenueSplit,
} from "../../lib/payments/ledger.ts";
import { InMemoryOutbox, OutboxDispatcher } from "../../lib/payments/outbox.ts";

test("a placement settlement posts one balanced integer-money transaction", async () => {
  const repository = new InMemoryLedgerRepository();
  const ledger = new LedgerService(repository);
  const split = calculateRevenueSplit(1_001, {
    version: "launch-80-20/v1",
    receiverBasisPoints: 8_000,
    operatorBasisPoints: 2_000,
  });

  assert.deepEqual(split, { receiverMinor: 801, operatorMinor: 200 });

  const transaction = await ledger.post({
    transactionId: "txn_placement_1",
    idempotencyKey: "placement:placement_1:settle:v1",
    kind: "placement_settlement",
    currency: "USDC",
    referenceId: "placement_1",
    splitVersion: "launch-80-20/v1",
    entries: [
      { accountId: "advertiser_1", amountMinor: -1_001 },
      { accountId: "receiver_1", amountMinor: 801 },
      { accountId: "operator_1", amountMinor: 200 },
    ],
  });

  assert.equal(
    transaction.entries.reduce((sum, entry) => sum + entry.amountMinor, 0),
    0,
  );
  assert.equal(repository.transactions.length, 1);
});

test("unbalanced, fractional, unsafe, and mixed-currency entries are rejected", async () => {
  const ledger = new LedgerService(new InMemoryLedgerRepository());

  await assert.rejects(
    ledger.post({
      transactionId: "txn_bad_balance",
      idempotencyKey: "bad:balance",
      kind: "deposit",
      currency: "USDC",
      referenceId: "deposit_1",
      entries: [
        { accountId: "treasury", amountMinor: 100 },
        { accountId: "advertiser", amountMinor: -99 },
      ],
    }),
    LedgerInvariantError,
  );

  for (const amountMinor of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      ledger.post({
        transactionId: `txn_bad_${amountMinor}`,
        idempotencyKey: `bad:${amountMinor}`,
        kind: "deposit",
        currency: "USDC",
        referenceId: "deposit_1",
        entries: [
          { accountId: "treasury", amountMinor },
          { accountId: "advertiser", amountMinor: -amountMinor },
        ],
      }),
      LedgerInvariantError,
    );
  }

  await assert.rejects(
    ledger.post({
      transactionId: "txn_mixed_currency",
      idempotencyKey: "bad:mixed",
      kind: "deposit",
      currency: "USDC",
      referenceId: "deposit_1",
      entries: [
        { accountId: "treasury", amountMinor: 100, currency: "USD" },
        { accountId: "advertiser", amountMinor: -100 },
      ],
    }),
    LedgerInvariantError,
  );
});

test("idempotency returns the original transaction and rejects key collisions", async () => {
  const repository = new InMemoryLedgerRepository();
  const ledger = new LedgerService(repository);
  const input = {
    transactionId: "txn_deposit_1",
    idempotencyKey: "tempo:deposit:0x123:0",
    kind: "deposit" as const,
    currency: "USDC",
    referenceId: "deposit_1",
    entries: [
      { accountId: "treasury", amountMinor: 500 },
      { accountId: "advertiser", amountMinor: -500 },
    ],
  };

  const first = await ledger.post(input);
  const retry = await ledger.post(structuredClone(input));
  assert.strictEqual(retry, first);
  assert.equal(repository.transactions.length, 1);

  await assert.rejects(
    ledger.post({ ...input, referenceId: "different_deposit" }),
    /Idempotency key collision/,
  );
});

test("outbox retries an interrupted delivery and records one completed effect", async () => {
  const outbox = new InMemoryOutbox();
  outbox.enqueue({
    eventId: "event_1",
    idempotencyKey: "payout:batch_1",
    topic: "payout.requested",
    payload: { payoutBatchId: "batch_1" },
  });

  let attempts = 0;
  const completed: string[] = [];
  const dispatcher = new OutboxDispatcher(outbox, async (event) => {
    attempts += 1;
    if (attempts === 1) throw new Error("network interrupted before acceptance");
    completed.push(event.idempotencyKey);
    return { receipt: "tempo_tx_1" };
  });

  await assert.rejects(dispatcher.deliver("event_1"), /network interrupted/);
  const delivered = await dispatcher.deliver("event_1");
  const replay = await dispatcher.deliver("event_1");

  assert.deepEqual(completed, ["payout:batch_1"]);
  assert.deepEqual(replay, delivered);
  assert.equal(outbox.get("event_1")?.status, "delivered");
});

test("outbox idempotency collisions cannot alias a different event or payload", () => {
  const outbox = new InMemoryOutbox();
  outbox.enqueue({ eventId: "event_1", idempotencyKey: "placement:1", topic: "placement.created", payload: { placementId: "1" } });

  assert.throws(
    () => outbox.enqueue({ eventId: "event_2", idempotencyKey: "placement:1", topic: "placement.created", payload: { placementId: "1" } }),
    /Idempotency key collision/,
  );
  assert.throws(
    () => outbox.enqueue({ eventId: "event_1", idempotencyKey: "placement:1", topic: "placement.created", payload: { placementId: "2" } }),
    /Idempotency key collision/,
  );
});

test("outbox snapshots cannot mutate stored nested payloads or receipts", () => {
  const input = { placement: { id: "placement_1" } };
  const outbox = new InMemoryOutbox();
  const created = outbox.enqueue({
    eventId: "event_nested",
    idempotencyKey: "placement:nested",
    topic: "placement.created",
    payload: input,
  });
  const createdPayload = created.payload as { placement: { id: string } };

  input.placement.id = "mutated-input";
  assert.equal(createdPayload.placement.id, "placement_1");
  assert.throws(() => {
    createdPayload.placement.id = "mutated-snapshot";
  }, TypeError);
  const storedPayload = outbox.get("event_nested")?.payload as {
    placement: { id: string };
  };
  assert.equal(storedPayload.placement.id, "placement_1");
});
