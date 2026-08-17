import assert from "node:assert/strict";
import test from "node:test";
import {
  createCampaignReportAuthority,
  createReportHandler,
} from "../../app/api/v1/reports/route.ts";
import {
  MemoryPlacementDeliveryRepository,
  type PlacementDeliveryRecord,
} from "../../lib/marketplace/placement-delivery.ts";

const campaignOwner = {
  accountId: "advertiser_owner",
  brand: {
    verificationId: "verification_owner",
    verifiedDomain: "owner.example",
  },
};

function authority(overrides: {
  campaignAccountId?: string;
  verificationAccountId?: string;
  verificationStatus?: "active" | "revoked";
} = {}) {
  return createCampaignReportAuthority({
    campaigns: {
      async get(campaignId: string) {
        if (campaignId !== "campaign_owner") throw new Error("Unknown campaign");
        return {
          ...campaignOwner,
          accountId: overrides.campaignAccountId ?? campaignOwner.accountId,
        };
      },
    },
    brandVerifications: {
      async get(verificationId: string) {
        if (verificationId !== campaignOwner.brand.verificationId) return undefined;
        return {
          verificationId,
          accountId: overrides.verificationAccountId ?? campaignOwner.accountId,
          verifiedDomain: campaignOwner.brand.verifiedDomain,
          status: overrides.verificationStatus ?? "active",
          verifiedAt: "2026-08-15T12:00:00.000Z",
        };
      },
    },
  }, []);
}

function placement(placementId: string, campaignId: string): PlacementDeliveryRecord {
  return {
    placementId,
    receiverAccountId: "receiver_1",
    status: "delivered",
    marketContext: {
      campaignId,
      eligibleBidderCount: 2,
      rewardType: "stablecoin",
      grossAmountMinor: 625,
      receiverAmountMinor: 500,
      operatorAmountMinor: 125,
    },
    receipt: { output: `Sponsored ${placementId}` },
    updatedAt: "2026-08-15T12:00:00.000Z",
  } as PlacementDeliveryRecord;
}

test("advertiser reports resolve campaign and brand ownership server-side", async () => {
  const repository = new MemoryPlacementDeliveryRepository();
  await repository.put(placement("placement_owner", "campaign_owner"));
  await repository.put(placement("placement_other", "campaign_other"));
  const handler = createReportHandler(repository, undefined, authority());

  const response = await handler(new Request("https://ad-daddy.test/api/v1/reports?campaignId=campaign_owner", {
    headers: { "x-ad-daddy-verified-account-id": "advertiser_owner" },
  }));

  assert.equal(response.status, 200);
  const body = await response.json() as { placements: Array<{ placementId: string; campaignId: string }> };
  assert.deepEqual(body.placements.map(({ placementId, campaignId }) => ({ placementId, campaignId })), [
    { placementId: "placement_owner", campaignId: "campaign_owner" },
  ]);
});

test("forged advertiser identity headers cannot expose another account's reports", async () => {
  const repository = new MemoryPlacementDeliveryRepository();
  await repository.put(placement("placement_owner", "campaign_owner"));
  const handler = createReportHandler(repository, undefined, authority());

  const response = await handler(new Request("https://ad-daddy.test/api/v1/reports?campaignId=campaign_owner", {
    headers: {
      "x-ad-daddy-verified-account-id": "advertiser_attacker",
      "oai-advertiser-id": "adv_owner",
      "oai-advertiser-owner-id": "advertiser_attacker",
      "oai-operator-scope": "closed-beta-reporting",
    },
  }));

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "campaign_not_found" });
});

test("reports fail closed when the campaign's brand binding is revoked or belongs to another account", async () => {
  const repository = new MemoryPlacementDeliveryRepository();
  await repository.put(placement("placement_owner", "campaign_owner"));

  for (const reportAuthority of [
    authority({ verificationStatus: "revoked" }),
    authority({ verificationAccountId: "advertiser_attacker" }),
  ]) {
    const response = await createReportHandler(repository, undefined, reportAuthority)(new Request(
      "https://ad-daddy.test/api/v1/reports?campaignId=campaign_owner",
      { headers: { "x-ad-daddy-verified-account-id": "advertiser_owner" } },
    ));
    assert.equal(response.status, 404);
  }
});
