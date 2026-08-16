import assert from "node:assert/strict";
import test from "node:test";

import { createPlacementHistoryHandler } from "../../app/api/v1/placements/route.ts";
import { createReportHandler, type CampaignReportAuthority } from "../../app/api/v1/reports/route.ts";
import {
  MemoryPlacementDeliveryRepository,
  type PlacementDeliveryRecord,
} from "../../lib/marketplace/placement-delivery.ts";

test("receiver and campaign placement feeds use bounded stable cursor pages", async () => {
  const repository = new MemoryPlacementDeliveryRepository();
  await repository.put(placement("placement_old", "2026-08-15T19:00:00.000Z"));
  await repository.put(placement("placement_middle", "2026-08-15T20:00:00.000Z"));
  await repository.put(placement("placement_new", "2026-08-15T21:00:00.000Z"));

  const receiverHandler = createPlacementHistoryHandler(repository);
  const first = await receiverHandler(request("https://ad.daddy/api/v1/placements?limit=1", "receiver_1"));
  assert.equal(first.status, 200);
  const firstBody = await page(first);
  assert.deepEqual(firstBody.placements.map((record) => record.placementId), ["placement_new"]);
  assert.ok(firstBody.nextCursor);

  const second = await receiverHandler(request(
    `https://ad.daddy/api/v1/placements?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    "receiver_1",
  ));
  const secondBody = await page(second);
  assert.deepEqual(secondBody.placements.map((record) => record.placementId), ["placement_middle"]);
  assert.notEqual(secondBody.placements[0]?.placementId, firstBody.placements[0]?.placementId);

  const reportHandler = createReportHandler(repository, undefined, authority);
  const campaign = await reportHandler(request("https://ad.daddy/api/v1/reports?campaignId=campaign_1&limit=2", "advertiser_1"));
  assert.equal(campaign.status, 200);
  const campaignBody = await page(campaign);
  assert.deepEqual(campaignBody.placements.map((record) => record.placementId), ["placement_new", "placement_middle"]);
  assert.ok(campaignBody.nextCursor);
});

test("placement feed pagination rejects oversized limits and malformed cursors", async () => {
  const repository = new MemoryPlacementDeliveryRepository();
  const receiverHandler = createPlacementHistoryHandler(repository);
  const reportHandler = createReportHandler(repository, undefined, authority);

  for (const response of [
    await receiverHandler(request("https://ad.daddy/api/v1/placements?limit=101", "receiver_1")),
    await receiverHandler(request("https://ad.daddy/api/v1/placements?cursor=not-a-placement-cursor", "receiver_1")),
    await reportHandler(request("https://ad.daddy/api/v1/reports?campaignId=campaign_1&limit=0", "advertiser_1")),
  ]) {
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_pagination" });
  }
});

const authority: CampaignReportAuthority = {
  async canReadCampaign(accountId, campaignId) {
    return accountId === "advertiser_1" && campaignId === "campaign_1";
  },
  isOperator() { return false; },
};

function request(url: string, accountId: string) {
  return new Request(url, { headers: { "oai-authenticated-user-id": accountId } });
}

async function page(response: Response) {
  return await response.json() as {
    placements: Array<{ placementId: string }>;
    nextCursor: string | null;
  };
}

function placement(placementId: string, updatedAt: string): PlacementDeliveryRecord {
  return {
    placementId,
    receiverAccountId: "receiver_1",
    status: "delivered",
    signedPlacement: {} as PlacementDeliveryRecord["signedPlacement"],
    validatedCreative: {
      payload: {
        advertiser: { displayName: "Neon" }, title: "Branch your database",
        payout: { amountMinor: 500, currency: "USD" }, signalsUsed: ["TypeScript"],
      },
    } as PlacementDeliveryRecord["validatedCreative"],
    marketContext: {
      campaignId: "campaign_1", eligibleBidderCount: 2, rewardType: "stablecoin",
      grossAmountMinor: 625, receiverAmountMinor: 500, operatorAmountMinor: 125,
    },
    updatedAt,
  };
}
