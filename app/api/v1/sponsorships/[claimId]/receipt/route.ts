import type { SignedDisplayReceipt } from "../../../../../../lib/marketplace/sponsorship-claims.ts";
import {
  authenticateSponsorshipRequest,
  deployedSponsorshipRuntime,
  sponsorshipRequestRateLimit,
  type SponsorshipRuntime,
} from "../../../../../../lib/marketplace/sponsorship-runtime.ts";
import type { FixedWindowRateLimiter } from "../../../../../../lib/http/rate-limit.ts";

const RECEIPT_CONFLICTS: Readonly<Record<string, string>> = Object.freeze({
  "Receipt recovery grace period expired": "receipt_recovery_expired",
  "Receipt recovery requires settlement review": "settlement_review_required",
  "A different first verified surface already won": "different_first_surface",
  "Active device-bound delivery lease required": "claim_cancelled",
  "Sponsorship claim expired or is unavailable": "claim_cancelled",
});
const INVALID_RECEIPTS = new Set([
  "Signed display receipt is malformed",
  "Display receipt payload is malformed",
  "Display receipt time is in the future",
  "Display receipt signature is invalid",
  "Display receipt audience is invalid",
  "Display receipt does not match the device-bound claim and lease",
  "Display receipt falls outside the delivery lease",
]);

export function createSponsorshipReceiptHandler(runtime?: SponsorshipRuntime, rateLimit: FixedWindowRateLimiter = sponsorshipRequestRateLimit) {
  return async function handle(request: Request, context: { params: Promise<{ claimId: string }> }): Promise<Response> {
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    const ipLimit = rateLimit.check([`sponsorship-receipt-ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`]);
    if (!ipLimit.allowed) return rateLimited(ipLimit.retryAfterSeconds);
    let rawBody: string;
    let receipt: SignedDisplayReceipt;
    try {
      rawBody = await boundedBody(request);
      receipt = JSON.parse(rawBody) as SignedDisplayReceipt;
    } catch {
      return json(400, { error: "invalid_sponsorship_receipt", message: "Display receipt JSON is malformed or too large" });
    }
    let activeRuntime: SponsorshipRuntime;
    try {
      activeRuntime = runtime ?? await deployedSponsorshipRuntime();
    } catch {
      return json(503, { error: "sponsorship_receipt_pending", message: "Receipt service is temporarily unavailable" });
    }
    let device: Awaited<ReturnType<typeof authenticateSponsorshipRequest>>;
    try {
      device = await authenticateSponsorshipRequest(request, rawBody, activeRuntime);
    } catch {
      return json(401, { error: "device_proof_rejected", message: "A valid device proof is required" });
    }
    const deviceLimit = rateLimit.check([`sponsorship-receipt-installation:${device.installationId}`]);
    if (!deviceLimit.allowed) return rateLimited(deviceLimit.retryAfterSeconds);
    const { claimId } = await context.params;
    if (!claimId || claimId.length > 256) return json(404, { error: "sponsorship_not_found" });
    try {
      const result = await activeRuntime.service.receipt(claimId, device, receipt, activeRuntime.clock());
      return json(200, result);
    } catch (error) {
      const rejected = receiptRejection(error);
      if (rejected) return json(rejected.status, { error: rejected.code, message: rejected.message });
      return json(503, {
        error: "sponsorship_receipt_pending",
        message: "Receipt was preserved and settlement can be retried",
      });
    }
  };
}

export const POST = createSponsorshipReceiptHandler();

async function boundedBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > 65_536) throw new Error("Display receipt body is missing or too large");
  const value = await request.text();
  if (!value || new TextEncoder().encode(value).byteLength > 65_536) throw new Error("Display receipt body is missing or too large");
  return value;
}
function json(status: number, value: unknown) { return Response.json(value, { status, headers: { "cache-control": "no-store" } }); }
function rateLimited(seconds: number) { return Response.json({ error: "rate_limited", retryAfterSeconds: seconds }, { status: 429, headers: { "cache-control": "no-store", "retry-after": String(seconds) } }); }
function receiptRejection(error: unknown): { status: number; code: string; message: string } | undefined {
  const message = error instanceof Error ? error.message : "";
  if (message === "Sponsorship claim not found") return { status: 404, code: "sponsorship_not_found", message };
  const conflict = RECEIPT_CONFLICTS[message];
  if (conflict) return { status: 409, code: conflict, message };
  return INVALID_RECEIPTS.has(message) ? { status: 422, code: "invalid_sponsorship_receipt", message } : undefined;
}
