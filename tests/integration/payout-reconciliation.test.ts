import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryLedgerRepository, LedgerService } from "../../lib/payments/ledger.ts";
import { PayoutDestinationRegistry, PayoutService } from "../../lib/payments/payouts.ts";
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
  destinations.enroll(approval(OLD_ADDRESS), NOW);
  destinations.enroll(approval(NEW_ADDRESS), NOW);
  const tempo = new SyntheticTempoClient();
  const repository = new InMemoryLedgerRepository();
  const service = payoutService(destinations, tempo, repository);
  const queued = service.queue({
    payoutId: "payout_1", receiverHumanId: "receiver_1", receiverLedgerAccountId: "ledger_receiver",
    treasuryLedgerAccountId: "ledger_treasury", amountMinor: 500, now: new Date(NOW.getTime() + 30_000),
  });
  assert.equal(queued.destination, OLD_ADDRESS);
  assert.throws(() => service.queue({
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

  const later = service.queue({
    payoutId: "payout_2", receiverHumanId: "receiver_1", receiverLedgerAccountId: "ledger_receiver",
    treasuryLedgerAccountId: "ledger_treasury", amountMinor: 400, now: new Date(NOW.getTime() + 60_001),
  });
  assert.equal(later.destination, NEW_ADDRESS);
});

test("unverified destinations, treasury ceiling overflow, and ungated production funds fail closed", async () => {
  const empty = new PayoutDestinationRegistry(60_000);
  const repo = new InMemoryLedgerRepository();
  const service = payoutService(empty, new SyntheticTempoClient(), repo);
  assert.throws(() => service.queue({ payoutId: "p_0", receiverHumanId: "unknown", receiverLedgerAccountId: "r", treasuryLedgerAccountId: "t", amountMinor: 1, now: NOW }), /verified/);

  empty.enroll(approval(OLD_ADDRESS), NOW);
  service.queue({ payoutId: "p_1", receiverHumanId: "receiver_1", receiverLedgerAccountId: "r", treasuryLedgerAccountId: "t", amountMinor: 800, now: NOW });
  assert.throws(() => service.queue({ payoutId: "p_2", receiverHumanId: "receiver_1", receiverLedgerAccountId: "r", treasuryLedgerAccountId: "t", amountMinor: 300, now: NOW }), /ceiling/);

  const production = new PayoutService({
    destinations: empty, tempo: new SyntheticTempoClient(), ledger: new LedgerService(repo),
    policy: { ...policy, environment: "production", productionFundsEnabled: false }, tokenAddress: TEMPO_MODERATO_ALPHA_USD,
    memoSalt: "salt", periodCeilingMinor: 10_000,
  });
  production.queue({ payoutId: "prod_1", receiverHumanId: "receiver_1", receiverLedgerAccountId: "r", treasuryLedgerAccountId: "t", amountMinor: 100, now: NOW });
  await assert.rejects(production.send("prod_1"), /Production funds are disabled/);
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
