import assert from "node:assert/strict";
import test from "node:test";

import { findEligibleOpportunities } from "../../lib/marketplace/eligibility.ts";

const campaign = {
  campaignId: "campaign_1",
  categories: ["database"],
  regions: ["US Northeast"],
  hosts: ["codex"],
  rewardTypes: ["credits"] as const,
};

test("hard filters reject stale consent, category, region, host, and reward mismatches", () => {
  const base = {
    rotatingOpportunityId: "opp_rotation_1",
    category: "database",
    region: "US Northeast",
    host: "codex",
    acceptedRewardTypes: ["credits"] as const,
    consentVersion: 3,
    currentConsentVersion: 3,
    expiresAt: "2026-08-15T17:00:00.000Z",
    fields: { subscriptionTier: "pro" },
    preBidExposure: { projectNames: false, publicRepositoryUrls: false },
  };
  const candidates = [
    base,
    { ...base, rotatingOpportunityId: "stale", currentConsentVersion: 4 },
    { ...base, rotatingOpportunityId: "category", category: "hosting" },
    { ...base, rotatingOpportunityId: "region", region: "EU" },
    { ...base, rotatingOpportunityId: "host", host: "claude" },
    { ...base, rotatingOpportunityId: "reward", acceptedRewardTypes: ["discount"] as const },
  ];
  const result = findEligibleOpportunities(campaign, candidates, new Date("2026-08-15T16:00:00.000Z"));
  assert.deepEqual(result.map((item) => item.opportunityId), ["opp_rotation_1"]);
});

test("opportunity inventory reveals only consented fields and separately exposed identifiers", () => {
  const candidates = [{
    rotatingOpportunityId: "rotates_every_window",
    receiverProfileId: "must-never-leak",
    installationId: "must-never-leak",
    category: "database",
    region: "US Northeast",
    host: "codex",
    acceptedRewardTypes: ["credits"] as const,
    consentVersion: 1,
    currentConsentVersion: 1,
    expiresAt: "2026-08-15T17:00:00.000Z",
    fields: {
      subscriptionTier: "pro",
      projectDescriptions: ["An agent inbox"],
      projectNames: ["Secretly identifying"],
      publicRepositoryUrls: ["https://github.com/example/public"],
    },
    preBidExposure: { projectNames: false, publicRepositoryUrls: true },
  }];
  const [view] = findEligibleOpportunities(campaign, candidates, new Date("2026-08-15T16:00:00.000Z"));
  assert.deepEqual(view.fields, {
    subscriptionTier: "pro",
    projectDescriptions: ["An agent inbox"],
    publicRepositoryUrls: ["https://github.com/example/public"],
  });
  assert.deepEqual(view.identityWarnings, ["publicRepositoryUrls may directly identify the receiver"]);
  assert.equal("receiverProfileId" in view, false);
  assert.equal("installationId" in view, false);
});

test("credits-only opportunities do not require a payout address", () => {
  const [view] = findEligibleOpportunities(campaign, [{
    rotatingOpportunityId: "credits_1",
    category: "database", region: "US Northeast", host: "codex",
    acceptedRewardTypes: ["credits"] as const,
    consentVersion: 1, currentConsentVersion: 1,
    expiresAt: "2026-08-15T17:00:00.000Z",
    fields: {}, preBidExposure: { projectNames: false, publicRepositoryUrls: false },
  }], new Date("2026-08-15T16:00:00.000Z"));
  assert.equal(view.requiresCashPayoutAddress, false);
});

test("mixed offers retain the non-cash lane when no payout address exists", () => {
  const [view] = findEligibleOpportunities({ ...campaign, rewardTypes: ["stablecoin", "credits"] }, [{
    rotatingOpportunityId: "mixed_1",
    category: "database", region: "US Northeast", host: "codex",
    acceptedRewardTypes: ["stablecoin", "credits"] as const,
    hasCashPayoutAddress: false,
    consentVersion: 1, currentConsentVersion: 1,
    expiresAt: "2026-08-15T17:00:00.000Z", fields: {},
    preBidExposure: { projectNames: false, publicRepositoryUrls: false },
  }], new Date("2026-08-15T16:00:00.000Z"));
  assert.deepEqual(view.rewardTypes, ["credits"]);
  assert.equal(view.requiresCashPayoutAddress, false);
});
