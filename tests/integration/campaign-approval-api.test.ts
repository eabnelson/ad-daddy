import assert from "node:assert/strict";
import test from "node:test";

import { campaignApprovalBinding, createCampaignHandler } from "../../app/api/v1/campaigns/route.ts";
import { approvalResourceFingerprint, MemoryApprovalCapabilityRepository } from "../../lib/auth/approval-capability.ts";
import { createMemoryCampaignRuntime } from "../../lib/marketplace/campaign-registry.ts";
import { MemoryBrandVerificationRepository } from "../../packages/cli/dist/commands/campaign.js";

test("campaign money transitions require an exact server-issued approval capability", async () => {
  const runtime = createMemoryCampaignRuntime();
  const now = new Date();
  (runtime.brandVerifications as MemoryBrandVerificationRepository).verify({
    verificationId: "brand_1", accountId: "account_1", verifiedDomain: "neon.tech", status: "active", verifiedAt: now.toISOString(),
  });
  const campaign = {
    campaignId: "campaign_1", accountId: "account_1", advertiserTermsVersion: "advertiser-terms/1",
    brand: { name: "Neon", verifiedDomain: "neon.tech", verificationId: "brand_1" }, destinationUrl: "https://neon.tech/offer",
    allowlistedDestinationHosts: ["neon.tech"], schedule: { startsAt: new Date(now.getTime() - 1_000).toISOString(), endsAt: new Date(now.getTime() + 86_400_000).toISOString() },
    categories: ["database"], regions: ["US"], hosts: ["codex"], rewardTypes: ["stablecoin" as const],
    creative: { headline: "Branch your database", body: "Create a preview branch." }, maximumSpendMinor: 10_000,
    maximumBidMinor: 1_000, dailyCapMinor: 5_000, guaranteedPlacementMinor: 500, conversionTerms: "Verified signup", perUserFrequencyLimit: 1,
  };
  await runtime.campaigns.prepare(campaign);
  const approvals = new MemoryApprovalCapabilityRepository();
  await approvals.putVerified({
    approvalId: "approval_fund", accountId: "account_1", purpose: "campaign_fund",
    resourceFingerprint: approvalResourceFingerprint(campaignApprovalBinding(campaign)),
    approvedAt: new Date(now.getTime() - 1_000).toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  });
  const handler = createCampaignHandler(runtime, approvals);
  const request = (body: unknown) => new Request("https://ad.daddy/api/v1/campaigns", {
    method: "POST", headers: { "content-type": "application/json", "x-ad-daddy-verified-account-id": "account_1" }, body: JSON.stringify(body),
  });
  const forged = await handler(request({ action: "fund", campaignId: "campaign_1", approval: { accountId: "account_1" }, approvalId: "forged" }));
  assert.equal(forged.status, 409);
  const funded = await handler(request({ action: "fund", campaignId: "campaign_1", approvalId: "approval_fund" }));
  assert.equal(funded.status, 200);
  assert.equal((await funded.json() as { campaign: { status: string } }).campaign.status, "funding_pending");
});
