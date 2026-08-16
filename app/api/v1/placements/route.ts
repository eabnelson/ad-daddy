import { getPlacementDeliveryRepository } from "../../../../lib/marketplace/placement-registry.ts";
import {
  PlacementPaginationError,
  assertPageInput,
  type PlacementDeliveryRecord,
  type PlacementDeliveryRepository,
  type PlacementPageInput,
} from "../../../../lib/marketplace/placement-delivery.ts";
import { authenticateAccountRequest } from "../../../../lib/auth/account-agent-token.ts";

export function createPlacementHistoryHandler(repository?: PlacementDeliveryRepository) {
  return async function handle(request: Request): Promise<Response> {
    const activeRepository = repository ?? await getPlacementDeliveryRepository();
    const accountId = await authenticateAccountRequest(request, "placement:read");
    if (!accountId) return Response.json({ error: "human_authentication_required" }, { status: 401 });
    try {
      const pageInput = placementPageInput(request);
      const page = await activeRepository.listByReceiver(accountId, pageInput);
      return Response.json({ placements: page.placements.map(receiverView), nextCursor: page.nextCursor });
    } catch (error) {
      if (error instanceof PlacementPaginationError) return Response.json({ error: "invalid_pagination" }, { status: 400 });
      throw error;
    }
  };
}
export const GET = createPlacementHistoryHandler();

function receiverView(record: PlacementDeliveryRecord) {
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

function placementPageInput(request: Request): PlacementPageInput {
  const url = new URL(request.url);
  const input = {
    limit: Number(url.searchParams.get("limit") ?? 50),
    ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") ?? "" } : {}),
  };
  assertPageInput(input);
  return input;
}
