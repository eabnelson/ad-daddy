import assert from "node:assert/strict";
import test from "node:test";

import { AttributionService, ConversionEvidenceVerifier } from "../../lib/marketplace/attribution.ts";
import { CampaignBudgetService } from "../../lib/marketplace/budget.ts";
import { InMemoryLedgerRepository, LedgerService } from "../../lib/payments/ledger.ts";

const NOW = new Date("2026-08-15T12:00:00.000Z");

test("allowlisted signed conversion evidence settles once after its dispute hold", async () => {
  const budgets = new CampaignBudgetService();
  budgets.open({ campaignId: "campaign_1", fundedMinor: 20_000, dailyCapMinor: 20_000 });
  const repository = new InMemoryLedgerRepository();
  const verifier = new ConversionEvidenceVerifier();
  verifier.allow("resend", "key_1", "s".repeat(32));
  const service = new AttributionService(budgets, new LedgerService(repository), verifier);
  await service.open(terms());
  assert.equal(budgets.snapshot("campaign_1").heldMinor, 1_000);
  const evidence = verifier.sign({
    eventId: "event_1", provider: "resend", keyId: "key_1", campaignId: "campaign_1",
    placementId: "placement_1", evidenceType: "verified_domain", amountMinor: 1_000,
    occurredAt: NOW.toISOString(),
  });
  const pending = service.submit(evidence, NOW);
  assert.equal(pending.status, "pending");
  await assert.rejects(service.settle("placement_1", new Date(NOW.getTime() + 999)), /has not cleared/);
  const paid = await service.settle("placement_1", new Date(NOW.getTime() + 1_000));
  assert.equal(paid.status, "paid");
  assert.equal(paid.receiverMinor, 800);
  assert.equal(paid.operatorMinor, 200);
  assert.equal(repository.transactions.length, 1);
  assert.deepEqual(await service.settle("placement_1", new Date(NOW.getTime() + 2_000)), paid);
});

test("invalid signature, advertiser assertion, replay, wrong amount, and late callbacks fail closed", async () => {
  const budgets = new CampaignBudgetService();
  budgets.open({ campaignId: "campaign_1", fundedMinor: 20_000, dailyCapMinor: 20_000 });
  const verifier = new ConversionEvidenceVerifier();
  verifier.allow("resend", "key_1", "s".repeat(32));
  assert.throws(() => verifier.allow("advertiser", "key_2", "x".repeat(32)), /invalid/);
  const service = new AttributionService(budgets, new LedgerService(new InMemoryLedgerRepository()), verifier);
  await service.open(terms());
  const valid = verifier.sign({
    eventId: "event_1", provider: "resend", keyId: "key_1", campaignId: "campaign_1",
    placementId: "placement_1", evidenceType: "verified_domain", amountMinor: 1_000, occurredAt: NOW.toISOString(),
  });
  assert.throws(() => service.submit({ ...valid, signature: "bad" }, NOW), /signature/);
  assert.throws(() => service.submit(verifier.sign({ ...withoutSignature(valid), amountMinor: 999 }), NOW), /does not match/);
  assert.throws(() => service.submit(valid, new Date("2026-08-17T00:00:00Z")), /claim window/);
  service.submit(valid, NOW);

  await service.open({ ...terms(), placementId: "placement_2" });
  assert.throws(() => service.submit(verifier.sign({ ...withoutSignature(valid), placementId: "placement_2" }), NOW), /replay/);
});

function terms() {
  return {
    placementId: "placement_1", campaignId: "campaign_1", receiverLedgerAccountId: "receiver",
    advertiserLedgerAccountId: "advertiser", operatorLedgerAccountId: "operator",
    evidenceType: "verified_domain", bonusGrossMinor: 1_000,
    claimDeadline: "2026-08-16T12:00:00.000Z", disputeHoldMs: 1_000, policyVersion: "conversion/v1",
  };
}
function withoutSignature<T extends { signature: string }>(input: T): Omit<T, "signature"> {
  const rest: Partial<T> = { ...input }; delete rest.signature; return rest as Omit<T, "signature">;
}
