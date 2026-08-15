import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryLedgerRepository, LedgerService } from "../../lib/payments/ledger.ts";
import { PayoutDestinationRegistry, PayoutService } from "../../lib/payments/payouts.ts";
import { InMemoryPaymentStateRepository } from "../../lib/payments/repository.ts";
import { SyntheticTempoClient, TEMPO_MODERATO_ALPHA_USD, TEMPO_MODERATO_CHAIN_ID } from "../../lib/payments/tempo-client.ts";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const OLD_ADDRESS = `0x${"4".repeat(40)}`;
const NEW_ADDRESS = `0x${"5".repeat(40)}`;
const policy = {
  environment: "test" as const, policyVersion: "payments-test/v1", chainId: TEMPO_MODERATO_CHAIN_ID,
  tokenAddress: TEMPO_MODERATO_ALPHA_USD, allowlistedChainId: TEMPO_MODERATO_CHAIN_ID,
  allowlistedTokenAddress: TEMPO_MODERATO_ALPHA_USD, productionFundsEnabled: false,
  approvals: { legal: false, custody: false, dataProtection: false, designPartners: false },
};

test("payout snapshots a verified destination, retries safely, and reconciles one ledger debit to one Tempo receipt", async () => {
  const destinations = new PayoutDestinationRegistry(60_000);
  await destinations.enroll(approval(OLD_ADDRESS), NOW);
  await destinations.enroll(approval(NEW_ADDRESS), NOW);
  const tempo = new SyntheticTempoClient();
  const repository = new InMemoryLedgerRepository();
  const service = payoutService(destinations, tempo, repository);
  const queued = await service.queue({
    payoutId: "payout_1", receiverHumanId: "receiver_1", receiverLedgerAccountId: "ledger_receiver",
    treasuryLedgerAccountId: "ledger_treasury", amountMinor: 500, now: new Date(NOW.getTime() + 30_000),
  });
  assert.equal(queued.destination, OLD_ADDRESS);
  await assert.rejects(service.queue({
    payoutId: "payout_1", receiverHumanId: "receiver_1", receiverLedgerAccountId: "different",
    treasuryLedgerAccountId: "ledger_treasury", amountMinor: 500, now: new Date(NOW.getTime() + 30_000),
  }), /collision/);
  tempo.failNextMemo(queued.memo);
  assert.equal((await service.send("payout_1")).status, "failed");
  assert.equal(repository.transactions.length, 0);
  const paid = await service.send("payout_1");
  assert.equal(paid.status, "paid");
  assert.equal(repository.transactions.length, 1);
  assert.equal(repository.transactions[0].chainReference, paid.transactionHash);
  assert.equal(repository.transactions[0].entries.reduce((sum, entry) => sum + entry.amountMinor, 0), 0);

  const later = await service.queue({
    payoutId: "payout_2", receiverHumanId: "receiver_1", receiverLedgerAccountId: "ledger_receiver",
    treasuryLedgerAccountId: "ledger_treasury", amountMinor: 400, now: new Date(NOW.getTime() + 60_001),
  });
  assert.equal(later.destination, NEW_ADDRESS);
});

test("unverified destinations, treasury ceiling overflow, and ungated production funds fail closed", async () => {
  const empty = new PayoutDestinationRegistry(60_000);
  const repo = new InMemoryLedgerRepository();
  const service = payoutService(empty, new SyntheticTempoClient(), repo);
  await assert.rejects(service.queue({ payoutId: "p_0", receiverHumanId: "unknown", receiverLedgerAccountId: "r", treasuryLedgerAccountId: "t", amountMinor: 1, now: NOW }), /verified/);

  await empty.enroll(approval(OLD_ADDRESS), NOW);
  await service.queue({ payoutId: "p_1", receiverHumanId: "receiver_1", receiverLedgerAccountId: "r", treasuryLedgerAccountId: "t", amountMinor: 800, now: NOW });
  await assert.rejects(service.queue({ payoutId: "p_2", receiverHumanId: "receiver_1", receiverLedgerAccountId: "r", treasuryLedgerAccountId: "t", amountMinor: 300, now: NOW }), /ceiling/);

  const production = new PayoutService({
    destinations: empty, tempo: new SyntheticTempoClient(), ledger: new LedgerService(repo),
    policy: { ...policy, environment: "production", productionFundsEnabled: false }, tokenAddress: TEMPO_MODERATO_ALPHA_USD,
    memoSalt: "salt", periodCeilingMinor: 10_000,
  });
  await production.queue({ payoutId: "prod_1", receiverHumanId: "receiver_1", receiverLedgerAccountId: "r", treasuryLedgerAccountId: "t", amountMinor: 100, now: NOW });
  await assert.rejects(production.send("prod_1"), /Production funds are disabled/);
});

test("a cold-start retry reloads the queued payout and reconciles one transfer and ledger debit", async () => {
  const state = new InMemoryPaymentStateRepository();
  const ledgerRepository = new InMemoryLedgerRepository();
  const tempo = new SyntheticTempoClient();
  const firstDestinations = new PayoutDestinationRegistry(60_000, state);
  await firstDestinations.enroll(approval(OLD_ADDRESS), NOW);
  const first = new PayoutService({
    destinations: firstDestinations, tempo, ledger: new LedgerService(ledgerRepository), policy,
    tokenAddress: TEMPO_MODERATO_ALPHA_USD, memoSalt: "stable-secret-backed-salt-for-restarts", periodCeilingMinor: 1_000,
    repository: state,
  });
  const queued = await first.queue({
    payoutId: "payout_restart", receiverHumanId: "receiver_1", receiverLedgerAccountId: "ledger_receiver",
    treasuryLedgerAccountId: "ledger_treasury", amountMinor: 500, now: NOW,
  });

  const restarted = new PayoutService({
    destinations: new PayoutDestinationRegistry(60_000, state), tempo, ledger: new LedgerService(ledgerRepository), policy,
    tokenAddress: TEMPO_MODERATO_ALPHA_USD, memoSalt: "stable-secret-backed-salt-for-restarts", periodCeilingMinor: 1_000,
    repository: state,
  });
  const retried = await restarted.queue({
    payoutId: "payout_restart", receiverHumanId: "receiver_1", receiverLedgerAccountId: "ledger_receiver",
    treasuryLedgerAccountId: "ledger_treasury", amountMinor: 500, now: NOW,
  });
  assert.equal(retried.memo, queued.memo);
  assert.equal((await restarted.send("payout_restart")).status, "paid");
  assert.equal((await first.send("payout_restart")).status, "paid");
  assert.equal(ledgerRepository.transactions.length, 1);
});

function payoutService(destinations: PayoutDestinationRegistry, tempo: SyntheticTempoClient, repository: InMemoryLedgerRepository) {
  return new PayoutService({
    destinations, tempo, ledger: new LedgerService(repository), policy,
    tokenAddress: TEMPO_MODERATO_ALPHA_USD, memoSalt: "payout-test-salt", periodCeilingMinor: 1_000,
  });
}
function approval(address: string) {
  return {
    humanId: "receiver_1", address, approvedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 120_000).toISOString(),
    purpose: "payout_destination" as const, proofVerified: true,
  };
}
