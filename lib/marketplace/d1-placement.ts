import type { SignedPlacement } from "@ad-daddy/host-adapters";

import { validateCreative } from "./creative.ts";
import type {
  PlacementDeliveryRecord,
  PlacementDeliveryPage,
  PlacementDeliveryRepository,
  PlacementDeliveryStatus,
  PlacementPageInput,
  PlacementReceiverAction,
} from "./placement-delivery.ts";
import { assertPageInput, decodePlacementCursor, encodePlacementCursor } from "./placement-delivery.ts";

type Row = Record<string, unknown>;

const SELECT = `SELECT p.*, rp.account_id AS receiverAccountId, b.campaign_id AS campaignId,
  b.reward_lane AS rewardType, d.eligible_bidder_count AS eligibleBidderCount
  FROM placements p JOIN opportunities o ON o.id = p.opportunity_id
  JOIN receiver_profiles rp ON rp.id = o.receiver_profile_id
  LEFT JOIN auctions a ON a.opportunity_id = o.id LEFT JOIN auction_decisions d ON d.auction_id = a.id
  LEFT JOIN auction_bids b ON b.id = d.winner_bid_id`;

export class D1PlacementDeliveryRepository implements PlacementDeliveryRepository {
  readonly #db: D1Database;
  constructor(db: D1Database) { this.#db = db; }

  async get(placementId: string): Promise<PlacementDeliveryRecord | undefined> {
    const row = await this.#db.prepare(`${SELECT} WHERE p.id = ?`).bind(placementId).first<Row>();
    return row ? recordFromRow(row) : undefined;
  }

  async put(record: PlacementDeliveryRecord): Promise<void> {
    const result = await this.#db.prepare(`UPDATE placements SET delivery_status = ?, host_kind = ?, host_session_id = ?,
      host_turn_id = ?, receiver_action = ?, updated_at = ?
      WHERE id = ? AND opportunity_id IN (
        SELECT o.id FROM opportunities o JOIN receiver_profiles rp ON rp.id = o.receiver_profile_id WHERE rp.account_id = ?
      )`).bind(
        record.status, record.hostKind ?? null, record.hostSessionId ?? null, record.hostTurnId ?? null,
        record.receiverAction ?? null, record.updatedAt,
        record.placementId, record.receiverAccountId,
      ).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error("Placement not found");
  }

  async listByReceiver(receiverAccountId: string, input: PlacementPageInput): Promise<PlacementDeliveryPage> {
    return this.#page("rp.account_id", receiverAccountId, input);
  }

  async listByCampaign(campaignId: string, input: PlacementPageInput): Promise<PlacementDeliveryPage> {
    return this.#page("b.campaign_id", campaignId, input);
  }

  async #page(scopeColumn: "rp.account_id" | "b.campaign_id", scopeId: string, input: PlacementPageInput): Promise<PlacementDeliveryPage> {
    assertPageInput(input);
    const cursor = input.cursor ? decodePlacementCursor(input.cursor) : undefined;
    const rows = await this.#db.prepare(`${SELECT} WHERE ${scopeColumn} = ?
      ${cursor ? "AND (p.updated_at < ? OR (p.updated_at = ? AND p.id < ?))" : ""}
      ORDER BY p.updated_at DESC, p.id DESC LIMIT ?`).bind(
        scopeId,
        ...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.placementId] : []),
        input.limit + 1,
      ).all<Row>();
    const records = (rows.results ?? []).map(recordFromRow);
    const hasMore = records.length > input.limit;
    const placements = records.slice(0, input.limit);
    return { placements, nextCursor: hasMore ? encodePlacementCursor(placements.at(-1)!) : null };
  }
}

function recordFromRow(row: Row): PlacementDeliveryRecord {
  const signedPlacement = parsed(row.signed_placement_json) as SignedPlacement;
  const payload = signedPlacement.payload;
  const contentReference = new URL(payload.contentReference);
  const destination = payload.destinationUrl ? new URL(payload.destinationUrl) : undefined;
  const validatedCreative = validateCreative(payload, {
    creativeOrigins: [contentReference.origin],
    verifiedDestinationDomains: destination ? [destination.hostname] : [],
    approvedPackages: [], approvedPackageDomains: [],
  });
  const displayReceipt = row.host_receipt_json ? parsed(row.host_receipt_json) as Row : undefined;
  const receipt = displayReceipt ? verifiedReceiptSummary(displayReceipt, payload.placementId) : undefined;
  return {
    placementId: text(row.id), receiverAccountId: text(row.receiverAccountId), signedPlacement, validatedCreative,
    status: deliveryStatus(row.delivery_status),
    ...(row.host_kind ? { hostKind: row.host_kind === "signed-html" ? "signed-html" as const : "codex" as const } : {}),
    ...(row.host_session_id ? { hostSessionId: text(row.host_session_id) } : {}),
    ...(row.host_turn_id ? { hostTurnId: text(row.host_turn_id) } : {}),
    ...(receipt ? { receipt } : {}),
    ...(row.receiver_action ? { receiverAction: text(row.receiver_action) as PlacementReceiverAction } : {}),
    ...(row.campaignId ? { marketContext: {
      campaignId: text(row.campaignId), eligibleBidderCount: integer(row.eligibleBidderCount),
      rewardType: text(row.rewardType) as "stablecoin" | "credits" | "discount",
      grossAmountMinor: integer(row.gross_amount_minor), receiverAmountMinor: integer(row.receiver_amount_minor),
      operatorAmountMinor: integer(row.operator_amount_minor),
    } } : {}),
    updatedAt: text(row.updated_at),
  };
}

function verifiedReceiptSummary(receipt: Row, placementId: string) {
  const payload = receipt.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Durable display receipt is malformed");
  const value = payload as Row;
  if (value.placementId !== placementId || value.surface !== "sidebar_session" && value.surface !== "signed_html" ||
    !["codex", "claude", "signed-html"].includes(String(value.hostKind)) || !Number.isFinite(Date.parse(String(value.displayedAt)))) {
    throw new Error("Durable display receipt is malformed");
  }
  return {
    placementId, verified: true as const, surface: value.surface as "sidebar_session" | "signed_html",
    hostKind: value.hostKind as "codex" | "claude" | "signed-html", displayedAt: String(value.displayedAt),
  };
}
function deliveryStatus(value: unknown): PlacementDeliveryStatus {
  if (["verifying", "ready", "displaying", "delivered", "fallback", "expired", "blocked", "reported"].includes(String(value))) return value as PlacementDeliveryStatus;
  throw new Error("Durable placement status is malformed");
}
function parsed(value: unknown): unknown { return JSON.parse(text(value)); }
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Durable placement field is malformed"); return value; }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Durable placement amount is malformed"); return value; }
