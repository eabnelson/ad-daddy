import { parseBoundedForm, parseBoundedJson, RequestLimitError } from "../../../../../../lib/http/request-limits.ts";
import {
  placementDeliveryRepository,
} from "../../../../../../lib/marketplace/placement-registry.ts";
import type {
  PlacementDeliveryRecord,
  PlacementDeliveryRepository,
  PlacementReceiverAction,
} from "../../../../../../lib/marketplace/placement-delivery.ts";

const RECEIPT_LIMITS = { maxBytes: 4_096, maxDepth: 3, maxCollectionItems: 8, maxStringLength: 128 } as const;

export function createPlacementReceiptHandler(
  repository: PlacementDeliveryRepository = placementDeliveryRepository,
) {
  return async function handle(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const accountId = request.headers.get("oai-authenticated-user-id");
    if (!accountId) return json(401, { error: "human_authentication_required" });
    const { id } = await context.params;
    if (!id || id.length > 128) return json(400, { error: "invalid_placement_id" });
    const record = await repository.get(id);
    if (!record || record.receiverAccountId !== accountId) return json(404, { error: "placement_not_found" });
    if (request.method === "GET") {
      return json(200, publicReceipt(record));
    }
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    try {
      const body = request.headers.get("content-type")?.includes("application/json")
        ? await parseBoundedJson(request, RECEIPT_LIMITS) as { action?: PlacementReceiverAction }
        : await parseBoundedForm(request, RECEIPT_LIMITS) as { action?: PlacementReceiverAction };
      if (!body?.action || !["hide", "block_advertiser", "report"].includes(body.action)) {
        return json(400, { error: "invalid_receiver_action" });
      }
      const updated = {
        ...record,
        status: body.action === "report" ? "reported" as const : "blocked" as const,
        receiverAction: body.action,
        updatedAt: new Date().toISOString(),
      };
      await repository.put(updated);
      return json(200, publicReceipt(updated));
    } catch (error) {
      if (error instanceof RequestLimitError) return json(error.status, { error: error.code });
      return json(400, { error: "invalid_request" });
    }
  };
}

export const GET = createPlacementReceiptHandler();
export const POST = GET;

function publicReceipt(record: PlacementDeliveryRecord) {
  return {
    placementId: record.placementId,
    status: record.status,
    hostKind: record.hostKind ?? null,
    receipt: record.receipt ?? null,
    receiverAction: record.receiverAction ?? null,
    advertiser: record.validatedCreative.payload.advertiser.displayName,
    title: record.validatedCreative.payload.title,
    reward: record.validatedCreative.payload.payout,
    signalsUsed: record.validatedCreative.payload.signalsUsed,
    controls: ["hide", "block_advertiser", "report"],
    updatedAt: record.updatedAt,
  };
}

function json(status: number, body: unknown) { return Response.json(body, { status }); }
