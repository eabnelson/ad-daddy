import { placementDeliveryRepository } from "../../../../lib/marketplace/placement-registry.ts";
import type { PlacementDeliveryRepository } from "../../../../lib/marketplace/placement-delivery.ts";
import { lifecycleEvents, type LifecycleEventStore } from "../../../../lib/observability/events.ts";

export function createReportHandler(repository: PlacementDeliveryRepository = placementDeliveryRepository, events: LifecycleEventStore = lifecycleEvents) {
  return async function handle(request: Request): Promise<Response> {
    const accountId = request.headers.get("oai-authenticated-user-id");
    if (!accountId) return Response.json({ error: "human_authentication_required" }, { status: 401 });
    if (request.headers.get("oai-operator-scope") === "closed-beta-reporting") {
      return Response.json({ aggregate: events.aggregate() });
    }
    const advertiserId = request.headers.get("oai-advertiser-id");
    if (!advertiserId || request.headers.get("oai-advertiser-owner-id") !== accountId) return Response.json({ error: "advertiser_identity_required" }, { status: 403 });
    const placements = await repository.listByAdvertiser(advertiserId);
    return Response.json({ placements: placements.map((record) => ({
      placementId: record.placementId, campaignId: record.marketContext?.campaignId ?? null,
      status: record.status, spendMinor: record.marketContext?.grossAmountMinor ?? 0,
      renderedResponse: record.receipt && "output" in record.receipt ? record.receipt.output : null,
      receiptStatus: record.receipt ? "verified" : "unavailable",
      measurement: { sessionCreated: record.receipt ? "verified" : "unavailable", sessionOpen: "unavailable", creativeEngagement: "unavailable", conversion: "unavailable" },
    })) });
  };
}
export const GET = createReportHandler();
