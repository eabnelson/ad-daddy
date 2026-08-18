import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildCampaignPrepareRequest } from "../../app/advertiser/campaigns/campaign-request.ts";
import { createReceiverSettingsHandler } from "../../app/api/receiver/settings/route.ts";
import { MemoryLocalStore, ReceiverSetupService } from "../../packages/cli/dist/index.js";

test("advertiser form constructs the complete bounded prepare contract", async () => {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    campaignId: "campaign_ui", brandName: "Neon", verifiedDomain: "neon.tech", verificationId: "verification_neon",
    destinationUrl: "https://neon.tech/offer", startsAt: "2026-08-16T10:00", endsAt: "2026-08-17T10:00",
    categories: "database, developer-tools", regions: "US Northeast", hosts: "codex, claude",
    headline: "Postgres in one prompt", body: "Claim credits.", maximumSpendMinor: "10000", maximumBidMinor: "500",
    dailyCapMinor: "2000", guaranteedPlacementMinor: "200", conversionBonusMinor: "1000",
    conversionTerms: "Verified database creation", perUserFrequencyLimit: "1",
  })) form.set(key, value);
  form.append("rewardTypes", "stablecoin");
  form.append("rewardTypes", "credits");

  const request = buildCampaignPrepareRequest(form);
  assert.equal(request.action, "prepare");
  assert.deepEqual(request.campaign, {
    campaignId: "campaign_ui", accountId: "resolved-by-server", advertiserTermsVersion: "advertiser-terms/1",
    brand: { name: "Neon", verifiedDomain: "neon.tech", verificationId: "verification_neon" },
    destinationUrl: "https://neon.tech/offer", allowlistedDestinationHosts: ["neon.tech"],
    schedule: { startsAt: "2026-08-16T14:00:00.000Z", endsAt: "2026-08-17T14:00:00.000Z" },
    categories: ["database", "developer-tools"], regions: ["US Northeast"], hosts: ["codex", "claude"], rewardTypes: ["stablecoin", "credits"],
    creative: { headline: "Postgres in one prompt", body: "Claim credits." }, maximumSpendMinor: 10000, maximumBidMinor: 500,
    dailyCapMinor: 2000, guaranteedPlacementMinor: 200, conversionBonusMinor: 1000,
    conversionTerms: "Verified database creation", perUserFrequencyLimit: 1,
  });

  const client = await readFile(new URL("../../app/advertiser/campaigns/campaign-form.tsx", import.meta.url), "utf8");
  assert.match(client, /fetch\("\/api\/v1\/campaigns"/);
  assert.match(client, /JSON\.stringify\(request\)/);
  assert.match(client, /aria-live="polite"/);
});

test("authenticated receiver preview, pause, and revoke share the setup service", async () => {
  const store = new MemoryLocalStore();
  const handler = createReceiverSettingsHandler({ store, setup: new ReceiverSetupService(store) });
  const preview = await handler(receiverRequest(new URLSearchParams({
    intent: "preview", cadenceMinutes: "1", quietHours: "22:00-07:00", maxAdsPerDay: "2",
    "enabled.coarseLocation": "on", coarseLocation: "US Northeast",
    "enabled.projectDescriptions": "on", projectDescriptions: "Building an agent inbox\nBuilding a deploy monitor",
    "enabled.acceptedRewardTypes": "on", rewardType: "credits",
    "enabled.minimumTakeHomeMinor": "on", minimumTakeHomeMinor: "250",
    "enabled.adFrequency": "on",
  })));
  assert.equal(preview.status, 200);
  const previewBody = await preview.json() as { status: string; installationId: string; publishedFields: Record<string, unknown> };
  assert.equal(previewBody.status, "draft");
  assert.equal(previewBody.installationId, "web:account_receiver");
  assert.deepEqual(previewBody.publishedFields, {
    coarseLocation: "US Northeast",
    projectDescriptions: ["Building an agent inbox", "Building a deploy monitor"],
    adFrequency: { maxPerDay: 2, quietHours: { startHourLocal: 22, endHourLocal: 7 } },
    acceptedRewardTypes: ["credits"],
    minimumTakeHomeMinor: 250,
  });

  const pause = await handler(receiverRequest(new URLSearchParams({ intent: "pause" })));
  assert.equal(pause.status, 200);
  assert.equal((await pause.json() as { status: string }).status, "paused");
  const revoke = await handler(receiverRequest(new URLSearchParams({ intent: "revoke" })));
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json() as { status: string }).status, "revoked");

  const read = await handler(new Request("https://ad.daddy/api/receiver/settings", { headers: { "x-ad-daddy-verified-account-id": "account_receiver" } }));
  assert.equal(read.status, 200);
  assert.equal((await read.json() as { status: string }).status, "revoked");
});

test("receiver settings reject unsigned, cross-account, oversized, and unsupported submissions", async () => {
  const store = new MemoryLocalStore();
  const handler = createReceiverSettingsHandler({ store, setup: new ReceiverSetupService(store) });
  assert.equal((await handler(new Request("https://ad.daddy/api/receiver/settings", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "intent=preview" }))).status, 401);
  assert.equal((await handler(new Request("https://ad.daddy/api/receiver/settings", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-ad-daddy-verified-account-id": "account_receiver", origin: "https://evil.example" }, body: "intent=preview&cadenceMinutes=60" }))).status, 403);

  const unsupported = await handler(receiverRequest(new URLSearchParams({ intent: "preview", cadenceMinutes: "60", injected: "true" })));
  assert.equal(unsupported.status, 400);
  const oversized = await handler(receiverRequest(new URLSearchParams({ intent: "preview", cadenceMinutes: "60", coarseLocation: "x".repeat(17_000) })));
  assert.equal(oversized.status, 400);

  const otherAccountPause = await handler(receiverRequest(new URLSearchParams({ intent: "pause" }), "account_other"));
  assert.equal(otherAccountPause.status, 409);
  assert.match((await otherAccountPause.json() as { message: string }).message, /unknown installation/i);
});

function receiverRequest(form: URLSearchParams, accountId = "account_receiver"): Request {
  return new Request("https://ad.daddy/api/receiver/settings", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-ad-daddy-verified-account-id": accountId },
    body: form.toString(),
  });
}
