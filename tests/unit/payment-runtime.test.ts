import assert from "node:assert/strict";
import test from "node:test";

import { createPaymentCore, deployedEnvironment, type PaymentBindings } from "../../lib/payments/deposit-runtime.ts";
import { D1LedgerRepository, D1PaymentStateRepository, D1RefundApprovalRepository } from "../../lib/payments/d1-repositories.ts";
import { createPaymentRuntime } from "../../lib/payments/runtime.ts";

test("deployment environment selection fails closed", () => {
  assert.equal(deployedEnvironment("test"), "test");
  assert.equal(deployedEnvironment("staging"), "staging");
  assert.equal(deployedEnvironment("production"), "production");
  assert.equal(deployedEnvironment(undefined), "production");
  assert.equal(deployedEnvironment("development"), "production");
});

test("payment core requires stable secret-backed memo and operator keys", () => {
  const base = {
    DB: {} as D1Database,
    AD_DADDY_ENV: "test",
    AD_DADDY_MEMO_SALT: "m".repeat(32),
    AD_DADDY_PAYMENT_EVENT_SECRET: "e".repeat(32),
  } satisfies PaymentBindings;
  const core = createPaymentCore(base);
  assert.equal(core.memoSalt, "m".repeat(32));
  assert.ok(core.ledgerRepository instanceof D1LedgerRepository);
  assert.ok(core.stateRepository instanceof D1PaymentStateRepository);
  assert.ok(core.refundApprovalRepository instanceof D1RefundApprovalRepository);
  assert.throws(() => createPaymentCore({ ...base, AD_DADDY_MEMO_SALT: "" }), /AD_DADDY_MEMO_SALT/);
  assert.throws(() => createPaymentCore({ ...base, AD_DADDY_PAYMENT_EVENT_SECRET: "short" }), /AD_DADDY_PAYMENT_EVENT_SECRET/);
  assert.equal(createPaymentCore({ ...base, AD_DADDY_ENV: "unexpected" }).policy.environment, "production");
});

test("production runtime fails closed until conversion state has a durable authority", async () => {
  const runtime = await createPaymentRuntime({
    DB: {} as D1Database,
    AD_DADDY_ENV: "production",
    AD_DADDY_MEMO_SALT: "m".repeat(32),
    AD_DADDY_PAYMENT_EVENT_SECRET: "e".repeat(32),
  });
  await assert.rejects(runtime.attribution.open({
    placementId: "placement_1", campaignId: "campaign_1",
    receiverLedgerAccountId: "receiver:1", advertiserLedgerAccountId: "advertiser:1", operatorLedgerAccountId: "operator:ad-daddy",
    evidenceType: "verified_signup", bonusGrossMinor: 1_000,
    claimDeadline: "2026-08-16T12:00:00.000Z", disputeHoldMs: 1_000, policyVersion: "conversion/v1",
  }), /durable conversion authority/i);
});
