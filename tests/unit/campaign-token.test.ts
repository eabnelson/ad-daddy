import assert from "node:assert/strict";
import test from "node:test";

import { CampaignTokenService } from "../../lib/auth/campaign-token.ts";

const now = new Date("2026-08-15T16:00:00.000Z");

test("campaign tokens are short-lived, scoped, bounded, and campaign-owned", async () => {
  const tokens = new CampaignTokenService("test-secret-with-at-least-32-characters");
  const token = await tokens.issue({
    tokenId: "token_1", accountId: "acct_1", campaignId: "campaign_1",
    scopes: ["campaign:read", "opportunity:search", "bid:submit"],
    spendCeilingMinor: 5_000, bidCeilingMinor: 500,
    expiresAt: "2026-08-15T16:05:00.000Z",
  }, now);
  const claims = await tokens.verify(token, {
    accountId: "acct_1", campaignId: "campaign_1", scope: "bid:submit",
    requestedSpendMinor: 500, requestedBidMinor: 500,
  }, now);
  assert.equal(claims.campaignId, "campaign_1");
  await assert.rejects(tokens.verify(token, { accountId: "acct_1", campaignId: "campaign_2", scope: "campaign:read" }, now), /campaign/i);
  await assert.rejects(tokens.verify(token, { accountId: "acct_1", campaignId: "campaign_1", scope: "bid:submit", requestedBidMinor: 501 }, now), /bid ceiling/i);
  await assert.rejects(tokens.verify(token, { accountId: "acct_1", campaignId: "campaign_1", scope: "campaign:write" }, now), /scope/i);
  await tokens.authorizeSpend(token, { accountId: "acct_1", campaignId: "campaign_1", amountMinor: 3_000, bidMinor: 500, idempotencyKey: "spend_1" }, now);
  const replay = await tokens.authorizeSpend(token, { accountId: "acct_1", campaignId: "campaign_1", amountMinor: 3_000, bidMinor: 500, idempotencyKey: "spend_1" }, now);
  assert.equal(replay.remainingMinor, 2_000);
  await assert.rejects(tokens.authorizeSpend(token, { accountId: "acct_1", campaignId: "campaign_1", amountMinor: 2_001, bidMinor: 500, idempotencyKey: "spend_2" }, now), /spend ceiling/i);
});

test("revoked, expired, and tampered tokens fail closed", async () => {
  const tokens = new CampaignTokenService("test-secret-with-at-least-32-characters");
  const token = await tokens.issue({
    tokenId: "token_2", accountId: "acct_1", campaignId: "campaign_1",
    scopes: ["campaign:read"], spendCeilingMinor: 0, bidCeilingMinor: 0,
    expiresAt: "2026-08-15T16:01:00.000Z",
  }, now);
  await assert.rejects(tokens.verify(`${token}x`, { accountId: "acct_1", campaignId: "campaign_1", scope: "campaign:read" }, now), /invalid/i);
  await assert.rejects(tokens.verify(token, { accountId: "acct_1", campaignId: "campaign_1", scope: "campaign:read" }, new Date("2026-08-15T16:02:00.000Z")), /expired/i);
  tokens.revoke("token_2");
  await assert.rejects(tokens.verify(token, { accountId: "acct_1", campaignId: "campaign_1", scope: "campaign:read" }, now), /revoked/i);
});

test("spend authorization accepts only contexts produced by the token service", async () => {
  const tokens = new CampaignTokenService("test-secret-with-at-least-32-characters");
  assert.throws(() => tokens.authorizeVerifiedSpend({ claims: {} } as never, {
    accountId: "acct_1", campaignId: "campaign_1", amountMinor: 1, bidMinor: 1, idempotencyKey: "forged",
  }, now), /context is invalid/i);
});
