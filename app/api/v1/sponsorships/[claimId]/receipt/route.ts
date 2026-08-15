import type { SignedDisplayReceipt } from "../../../../../../lib/marketplace/sponsorship-claims.ts";
import {
  authenticateSponsorshipRequest,
  deployedSponsorshipRuntime,
  type SponsorshipRuntime,
} from "../../../../../../lib/marketplace/sponsorship-runtime.ts";

export function createSponsorshipReceiptHandler(runtime?: SponsorshipRuntime) {
  return async function handle(request: Request, context: { params: Promise<{ claimId: string }> }): Promise<Response> {
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    try {
      const rawBody = await boundedBody(request);
      const receipt = JSON.parse(rawBody) as SignedDisplayReceipt;
      const activeRuntime = runtime ?? await deployedSponsorshipRuntime();
      const device = await authenticateSponsorshipRequest(request, rawBody, activeRuntime);
      const { claimId } = await context.params;
      if (!claimId || claimId.length > 256) return json(404, { error: "sponsorship_not_found" });
      const result = await activeRuntime.service.receipt(claimId, device, receipt, activeRuntime.clock());
      return json(200, result);
    } catch (error) {
      return json(403, { error: "sponsorship_receipt_rejected", message: boundedMessage(error) });
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
function boundedMessage(error: unknown) { return (error instanceof Error ? error.message : "Sponsorship receipt rejected").slice(0, 200); }
