import assert from "node:assert/strict";
import test from "node:test";

import { CampaignBudgetService } from "../../lib/marketplace/budget.ts";
import { InMemoryLedgerRepository, LedgerService } from "../../lib/payments/ledger.ts";
import { RefundService } from "../../lib/payments/refunds.ts";
import { SyntheticTempoClient, TEMPO_MODERATO_ALPHA_USD, TEMPO_MODERATO_CHAIN_ID } from "../../lib/payments/tempo-client.ts";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const ADDRESS = `0x${"3".repeat(40)}`;
const policy = {
  environment: "test" as const, policyVersion: "payments-test/v1", chainId: TEMPO_MODERATO_CHAIN_ID,
  tokenAddress: TEMPO_MODERATO_ALPHA_USD, allowlistedChainId: TEMPO_MODERATO_CHAIN_ID,
  allowlistedTokenAddress: TEMPO_MODERATO_ALPHA_USD, productionFundsEnabled: false,
  approvals: { legal: false, custody: false, dataProtection: false, designPartners: false },
};

test("closed campaign refund excludes reservations and holds, retries without double debit, and reconciles onchain", async () => {
  const budgetService = new CampaignBudgetService();
  budgetService.open({ campaignId: "campaign_1", fundedMinor: 12_500, dailyCapMinor: 12_500 });
  await budgetService.reserve("campaign_1", "reservation_1", 2_000, NOW);
  await budgetService.hold("campaign_1", "hold_1", 500);
  const budget = await budgetService.close("campaign_1");
  assert.equal(budget.withdrawableMinor, 10_000);

  const tempo = new SyntheticTempoClient();
  const repository = new InMemoryLedgerRepository();
  const refunds = new RefundService({ tempo, ledger: new LedgerService(repository), policy, tokenAddress: TEMPO_MODERATO_ALPHA_USD, memoSalt: "refund-test-salt" });
  const prepared = refunds.prepare({
    refundId: "refund_1", accountId: "advertiser_1", campaignId: "campaign_1",
    campaignClosedAt: NOW.toISOString(), budget, advertiserLedgerAccountId: "ledger_adv",
    treasuryLedgerAccountId: "ledger_treasury", approval: approval(), now: NOW,
  });
  assert.throws(() => refunds.prepare({
    refundId: "refund_1", accountId: "advertiser_1", campaignId: "campaign_1",
    campaignClosedAt: NOW.toISOString(), budget, advertiserLedgerAccountId: "different",
    treasuryLedgerAccountId: "ledger_treasury", approval: approval(), now: NOW,
  }), /collision/);
  tempo.failNextMemo(prepared.memo);
  const failed = await refunds.send("refund_1");
  assert.equal(failed.status, "failed");
  assert.equal(repository.transactions.length, 0);
  const paid = await refunds.send("refund_1");
  assert.equal(paid.status, "paid");
  assert.match(paid.transactionHash ?? "", /^0x[a-f0-9]{64}$/);
  assert.equal(repository.transactions.length, 1);
  assert.deepEqual(await refunds.send("refund_1"), paid);
  assert.equal(repository.transactions.length, 1);
});

test("agent-supplied or mismatched refund destinations and amounts are rejected before transfer", async () => {
  const budgetService = new CampaignBudgetService();
  budgetService.open({ campaignId: "campaign_1", fundedMinor: 1_000, dailyCapMinor: 1_000 });
  const budget = await budgetService.close("campaign_1");
  const refunds = new RefundService({ tempo: new SyntheticTempoClient(), ledger: new LedgerService(new InMemoryLedgerRepository()), policy, tokenAddress: TEMPO_MODERATO_ALPHA_USD, memoSalt: "salt" });
  for (const badApproval of [
    { ...approval(), recentAuthentication: false, amountMinor: 1_000 },
    { ...approval(), amountMinor: 999 },
    { ...approval(), refundAddress: "not-an-address", amountMinor: 1_000 },
  ]) {
    assert.throws(() => refunds.prepare({
      refundId: crypto.randomUUID(), accountId: "advertiser_1", campaignId: "campaign_1",
      campaignClosedAt: NOW.toISOString(), budget, advertiserLedgerAccountId: "a", treasuryLedgerAccountId: "t",
      approval: badApproval, now: NOW,
    }));
  }
});

function approval() {
  return {
    accountId: "advertiser_1", campaignId: "campaign_1", refundAddress: ADDRESS,
    amountMinor: 10_000, approvedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    purposes: ["campaign_close", "refund_address", "refund_amount"], recentAuthentication: true,
  };
}
