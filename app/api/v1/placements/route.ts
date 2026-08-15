import { placementDeliveryRepository } from "../../../../lib/marketplace/placement-registry.ts";
import type { PlacementDeliveryRepository } from "../../../../lib/marketplace/placement-delivery.ts";

export function createPlacementHistoryHandler(repository: PlacementDeliveryRepository = placementDeliveryRepository) {
  return async function handle(request: Request): Promise<Response> {
    const accountId = request.headers.get("oai-authenticated-user-id");
    if (!accountId) return Response.json({ error: "human_authentication_required" }, { status: 401 });
    const placements = await repository.listByReceiver(accountId);
    return Response.json({ placements: placements.map(receiverView) });
  };
}
export const GET = createPlacementHistoryHandler();

function receiverView(record: Awaited<ReturnType<PlacementDeliveryRepository["listByReceiver"]>>[number]) {
  const payload = record.validatedCreative.payload;
  return {
    placementId: record.placementId, status: record.status, advertiser: payload.advertiser.displayName,
    title: payload.title, reward: payload.payout, signalsUsed: payload.signalsUsed,
    bidderCount: record.marketContext?.eligibleBidderCount ?? null,
    economics: record.marketContext ? {
      grossAmountMinor: record.marketContext.grossAmountMinor,
      receiverAmountMinor: record.marketContext.receiverAmountMinor,
      operatorAmountMinor: record.marketContext.operatorAmountMinor,
      rewardType: record.marketContext.rewardType,
    } : null,
    receiptStatus: record.receipt ? "verified" : "unavailable",
    payoutState: record.status === "delivered" ? "pending" : "unavailable",
    controls: ["hide", "block_advertiser", "report"], receiverAction: record.receiverAction ?? null,
  };
}
