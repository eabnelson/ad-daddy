import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { CodexDeliveryReceipt } from "@ad-daddy/host-adapters";
import { CampaignBudgetService } from "../../lib/marketplace/budget.ts";
import { DepositService } from "../../lib/payments/deposits.ts";
import { InMemoryLedgerRepository, LedgerService } from "../../lib/payments/ledger.ts";
import { InMemoryPaymentStateRepository } from "../../lib/payments/repository.ts";
import { RewardVelocityGuard, SettlementService } from "../../lib/payments/settlement.ts";
import { opaqueTempoMemo, TEMPO_MODERATO_ALPHA_USD, TEMPO_MODERATO_CHAIN_ID, type TempoTransferEvent } from "../../lib/payments/tempo-client.ts";

const TREASURY = `0x${"1".repeat(40)}`;
const SENDER = `0x${"2".repeat(40)}`;
const policy = {
  environment: "test" as const, policyVersion: "payments-test/v1",
  chainId: TEMPO_MODERATO_CHAIN_ID, tokenAddress: TEMPO_MODERATO_ALPHA_USD,
  allowlistedChainId: TEMPO_MODERATO_CHAIN_ID, allowlistedTokenAddress: TEMPO_MODERATO_ALPHA_USD,
  productionFundsEnabled: false,
  approvals: { legal: false, custody: false, dataProtection: false, designPartners: false },
};

test("finalized Tempo deposit credits once, quarantines unknown memos, and compensates a reorg", async () => {
  const repository = new InMemoryLedgerRepository();
  const service = new DepositService(new LedgerService(repository), policy, TREASURY);
  const memo = opaqueTempoMemo("deposit", "commit_1", "test-salt");
  await service.register({
    commitmentId: "commit_1", campaignId: "campaign_1", advertiserAccountId: "human_adv",
    advertiserLedgerAccountId: "ledger_adv", treasuryLedgerAccountId: "ledger_treasury",
    amountMinor: 10_000, memo, expectedSender: SENDER,
  });
  const event = transfer({ memo });
  const credited = await service.process(event);
  const duplicate = await service.process(structuredClone(event));
  assert.equal(credited.status, "credited");
  assert.deepEqual(duplicate, credited);
  assert.equal(repository.transactions.length, 1);

  const unknown = await service.process(transfer({ memo: opaqueTempoMemo("deposit", "unknown", "test-salt"), transactionHash: `0x${"b".repeat(64)}` }));
  assert.equal(unknown.status, "quarantined");
  assert.equal(unknown.reason, "unknown_memo");
  assert.equal(repository.transactions.length, 1);

  const reorged = await service.process({ ...event, status: "reorged" });
  assert.equal(reorged.status, "reorged");
  assert.equal(repository.transactions.length, 2);
  assert.equal(repository.transactions.flatMap((transaction) => transaction.entries).reduce((sum, entry) => sum + entry.amountMinor, 0), 0);
});

test("deposit commitments, credits, and reorg reconciliation survive a cold start", async () => {
  const ledgerRepository = new InMemoryLedgerRepository();
  const ledger = new LedgerService(ledgerRepository);
  const state = new InMemoryPaymentStateRepository();
  const memo = opaqueTempoMemo("deposit", "commit_restart", "stable-secret-backed-salt");
  const first = new DepositService(ledger, policy, TREASURY, state);
  await first.register({
    commitmentId: "commit_restart", campaignId: "campaign_restart", advertiserAccountId: "human_adv",
    advertiserLedgerAccountId: "ledger_adv", treasuryLedgerAccountId: "ledger_treasury",
    amountMinor: 10_000, memo, expectedSender: SENDER,
  });
  const event = transfer({ memo, transactionHash: `0x${"c".repeat(64)}` });
  assert.equal((await first.process(event)).status, "credited");

  const restarted = new DepositService(ledger, policy, TREASURY, state);
  assert.deepEqual(await restarted.requireCreditedCampaignDeposit({
    campaignId: "campaign_restart", advertiserAccountId: "human_adv", amountMinor: 10_000,
  }), { depositId: `deposit:${TEMPO_MODERATO_CHAIN_ID}:0x${"c".repeat(64)}:0` });
  assert.equal((await restarted.process({ ...event, status: "reorged" })).status, "reorged");
  await assert.rejects(restarted.requireCreditedCampaignDeposit({
    campaignId: "campaign_restart", advertiserAccountId: "human_adv", amountMinor: 10_000,
  }), /credited, unreorged/);
  assert.equal(ledgerRepository.transactions.length, 2);
});

test("a verified rendered receipt settles the reserved base reward once with exact 80/20 economics", async () => {
  const repository = new InMemoryLedgerRepository();
  const budgets = new CampaignBudgetService();
  budgets.open({ campaignId: "campaign_1", fundedMinor: 10_000, dailyCapMinor: 10_000 });
  await budgets.reserve("campaign_1", "reservation_1", 625, new Date("2026-08-15T12:00:00Z"));
  const service = new SettlementService(new LedgerService(repository), budgets, new RewardVelocityGuard(5_000, 5_000));
  const input = {
    placementId: "placement_1", campaignId: "campaign_1", reservationId: "reservation_1",
    rewardType: "stablecoin" as const, grossAmountMinor: 625, receiverAmountMinor: 500, operatorAmountMinor: 125,
    advertiserLedgerAccountId: "ledger_adv", receiverLedgerAccountId: "ledger_receiver", operatorLedgerAccountId: "ledger_operator",
    receiverHumanId: "human_receiver", installationId: "installation_1", receipt: receipt(),
    policyVersion: "payments-test/v1", now: new Date("2026-08-15T12:00:00Z"),
  };
  const first = await service.settleBase(input);
  const retry = await service.settleBase(structuredClone(input));
  assert.deepEqual(retry, first);
  assert.equal(first.status, "settled");
  assert.equal(repository.transactions.length, 1);
  assert.equal(budgets.snapshot("campaign_1").spentMinor, 625);
  assert.equal(budgets.snapshot("campaign_1").reservedMinor, 0);

  await assert.rejects(service.settleBase({ ...input, placementId: "placement_bad", reservationId: "reservation_bad", receipt: { ...receipt(), outputSha256: "0".repeat(64) } }), /Verified sponsored render receipt/);
});

test("non-cash offers never enter the ledger and reward velocity holds anomalous cash", async () => {
  const repository = new InMemoryLedgerRepository();
  const budgets = new CampaignBudgetService();
  budgets.open({ campaignId: "campaign_1", fundedMinor: 5_000, dailyCapMinor: 5_000 });
  const settlement = new SettlementService(new LedgerService(repository), budgets, new RewardVelocityGuard(499, 499));
  const nonCash = await settlement.settleBase({
    placementId: "credits_1", campaignId: "campaign_1", reservationId: "none", rewardType: "credits",
    grossAmountMinor: 0, receiverAmountMinor: 0, operatorAmountMinor: 0,
    advertiserLedgerAccountId: "a", receiverLedgerAccountId: "r", operatorLedgerAccountId: "o",
    receiverHumanId: "h", installationId: "i", receipt: receipt(), policyVersion: "v1",
  });
  assert.equal(nonCash.status, "non_cash");
  assert.equal(repository.transactions.length, 0);

  await budgets.reserve("campaign_1", "reservation_1", 625);
  await assert.rejects(settlement.settleBase({
    placementId: "cash_1", campaignId: "campaign_1", reservationId: "reservation_1", rewardType: "stablecoin",
    grossAmountMinor: 625, receiverAmountMinor: 500, operatorAmountMinor: 125,
    advertiserLedgerAccountId: "a", receiverLedgerAccountId: "r", operatorLedgerAccountId: "o",
    receiverHumanId: "h", installationId: "i", receipt: { ...receipt(), placementId: "cash_1" }, policyVersion: "v1",
  }), /anomaly hold/);
});

function transfer(overrides: Partial<TempoTransferEvent>): TempoTransferEvent {
  return {
    chainId: TEMPO_MODERATO_CHAIN_ID, tokenAddress: TEMPO_MODERATO_ALPHA_USD,
    transactionHash: `0x${"a".repeat(64)}`, logIndex: 0, blockNumber: 100,
    from: SENDER, to: TREASURY, amountMinor: 10_000,
    memo: opaqueTempoMemo("deposit", "commit_1", "test-salt"), status: "finalized",
    ...overrides,
  };
}

function receipt(): CodexDeliveryReceipt {
  const output = "Sponsored via Ad Daddy\nNeon — Postgres\nReward $5.00\nMatched: TypeScript";
  return {
    placementId: "placement_1", threadId: "thread_1", turnId: "turn_1", title: "Sponsored · Postgres",
    output, outputSha256: createHash("sha256").update(output).digest("hex"), advertiserDisplayName: "Neon",
    receiverAmountMinor: 500, currency: "USD", signalsUsed: ["TypeScript"], toolItemCount: 0,
    cliVersion: "0.146.1", userAgent: "Codex Desktop/0.146.1", model: "gpt-5.6-luna", isolatedCwd: "/tmp/ad-daddy",
    activeTaskIdBefore: "active", activeTaskIdAfter: "active", listedAfterRestart: true, restartReadable: true,
    sidebarVerified: true, instructionSources: [], budgetVersion: 1,
  };
}
