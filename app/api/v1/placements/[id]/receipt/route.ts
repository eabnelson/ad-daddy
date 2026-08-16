import { parseBoundedForm, parseBoundedJson, RequestLimitError } from "../../../../../../lib/http/request-limits.ts";
import {
  getPlacementDeliveryRepository,
} from "../../../../../../lib/marketplace/placement-registry.ts";
import {
  applyPlacementReceiverAction,
  type PlacementDeliveryRecord,
  type PlacementDeliveryRepository,
  type PlacementReceiverAction,
} from "../../../../../../lib/marketplace/placement-delivery.ts";
import { getReceiverAdvertiserBlockRepository, type ReceiverAdvertiserBlockRepository } from "../../../../../../lib/marketplace/blocking.ts";
import { lifecycleEvents, type LifecycleEventStore } from "../../../../../../lib/observability/events.ts";
import { authenticateAccountRequest } from "../../../../../../lib/auth/account-agent-token.ts";

const RECEIPT_LIMITS = { maxBytes: 4_096, maxDepth: 3, maxCollectionItems: 8, maxStringLength: 128 } as const;

export function createPlacementReceiptHandler(
  repository?: PlacementDeliveryRepository,
  blocklist?: ReceiverAdvertiserBlockRepository,
  events: LifecycleEventStore = lifecycleEvents,
) {
  return async function handle(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const activeRepository = repository ?? await getPlacementDeliveryRepository();
    const accountId = await authenticateAccountRequest(request, request.method === "GET" ? "placement:read" : "placement:act");
    if (!accountId) return json(401, { error: "human_authentication_required" });
    const { id } = await context.params;
    if (!id || id.length > 128) return json(400, { error: "invalid_placement_id" });
    const record = await activeRepository.get(id);
    if (!record || record.receiverAccountId !== accountId) return json(404, { error: "placement_not_found" });
    if (request.method === "GET") {
      return json(200, publicReceipt(record));
    }
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    const origin = request.headers.get("origin");
    if (!request.headers.has("authorization") && origin && origin !== new URL(request.url).origin) {
      return json(403, { error: "same_origin_required" });
    }
    try {
      const body = request.headers.get("content-type")?.includes("application/json")
        ? await parseBoundedJson(request, RECEIPT_LIMITS) as { action?: PlacementReceiverAction }
        : await parseBoundedForm(request, RECEIPT_LIMITS) as { action?: PlacementReceiverAction };
      if (!body?.action || !["hide", "block_advertiser", "report"].includes(body.action)) {
        return json(400, { error: "invalid_receiver_action" });
      }
      if (body.action === "block_advertiser") {
        await (blocklist ?? await getReceiverAdvertiserBlockRepository())
          .block(accountId, record.validatedCreative.payload.advertiser.id, id);
      }
      const updated = await applyPlacementReceiverAction(activeRepository, id, accountId, body.action);
      if (body.action === "block_advertiser") {
        events.record({ eventId: `block:${id}`, type: "advertiser_blocked", occurredAt: updated.updatedAt, receiverAccountId: accountId, advertiserId: record.validatedCreative.payload.advertiser.id, placementId: id });
      }
      if (body.action === "report") {
        events.record({ eventId: `report:${id}`, type: "placement_reported", occurredAt: updated.updatedAt, receiverAccountId: accountId, advertiserId: record.validatedCreative.payload.advertiser.id, placementId: id });
      }
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
