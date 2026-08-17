import assert from "node:assert/strict";
import test from "node:test";

import { createSettlementReviewHandler } from "../../app/api/v1/operator/settlement-reviews/[claimId]/route.ts";
import { MemorySettlementReviewApprovalRepository } from "../../lib/marketplace/settlement-review.ts";
import type { SponsorshipRuntime } from "../../lib/marketplace/sponsorship-runtime.ts";

test("settlement review requires two distinct allowlisted human operators", async () => {
  let resolutions = 0;
  const runtime = {
    environment: "test",
    clock: () => new Date("2026-08-15T20:00:00.000Z"),
    service: {
      async settlementReviewStatus() { return { available: true, hasVerifiedReceipt: false }; },
      async resolveSettlementReview(_claimId: string, resolution: "settled" | "released") { resolutions += 1; return { status: resolution }; },
    },
  } as unknown as SponsorshipRuntime;
  const handler = createSettlementReviewHandler(runtime, new MemorySettlementReviewApprovalRepository(), ["operator_1", "operator_2"]);
  const context = { params: Promise.resolve({ claimId: "claim_1" }) };
  const request = (operator: string) => new Request("https://ad.daddy/api/v1/operator/settlement-reviews/claim_1", {
    method: "POST", headers: { "content-type": "application/json", "x-ad-daddy-verified-account-id": operator },
    body: JSON.stringify({ resolution: "released" }),
  });

  assert.equal((await handler(request("not_operator"), context)).status, 403);
  const first = await handler(request("operator_1"), context);
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { status: "pending_second_operator", approvalCount: 1 });
  assert.equal((await handler(request("operator_1"), context)).status, 202, "one operator cannot self-approve twice");
  assert.equal(resolutions, 0);
  const second = await handler(request("operator_2"), context);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { status: "released", approvalCount: 2 });
  assert.equal(resolutions, 1);
});
