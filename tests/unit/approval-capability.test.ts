import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalResourceFingerprint,
  MemoryApprovalCapabilityRepository,
} from "../../lib/auth/approval-capability.ts";

const NOW = new Date("2026-08-15T20:00:00.000Z");

test("server-issued human approval is exact-bound, single-use, and idempotent for one operation", async () => {
  const repository = new MemoryApprovalCapabilityRepository();
  const resourceFingerprint = approvalResourceFingerprint({ campaignId: "campaign_1", amountMinor: 500 });
  await repository.putVerified({
    approvalId: "approval_1", accountId: "account_1", purpose: "campaign_fund", resourceFingerprint,
    approvedAt: new Date(NOW.getTime() - 1_000).toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  });
  const input = { approvalId: "approval_1", accountId: "account_1", purpose: "campaign_fund" as const, resourceFingerprint, useId: "fund:campaign_1", now: NOW };
  assert.equal((await repository.consume(input)).consumedBy, input.useId);
  assert.equal((await repository.consume(input)).consumedBy, input.useId);
  await assert.rejects(repository.consume({ ...input, useId: "fund:campaign_2" }), /replay/i);
  await assert.rejects(repository.consume({ ...input, approvalId: "forged" }), /server-issued/i);
  await assert.rejects(repository.consume({ ...input, resourceFingerprint: approvalResourceFingerprint({ campaignId: "campaign_1", amountMinor: 501 }) }), /server-issued/i);
});
