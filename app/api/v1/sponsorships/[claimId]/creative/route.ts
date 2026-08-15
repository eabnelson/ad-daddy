import {
  authenticateSponsorshipRequest,
  deployedSponsorshipRuntime,
  type SponsorshipRuntime,
} from "../../../../../../lib/marketplace/sponsorship-runtime.ts";

export function createSponsorshipCreativeHandler(runtime?: SponsorshipRuntime) {
  return async function handle(request: Request, context: { params: Promise<{ claimId: string }> }): Promise<Response> {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
    try {
      const activeRuntime = runtime ?? await deployedSponsorshipRuntime();
      const device = await authenticateSponsorshipRequest(request, "", activeRuntime);
      const { claimId } = await context.params;
      if (!claimId || claimId.length > 256) return json(404, { error: "sponsorship_not_found" });
      const creative = await activeRuntime.service.creative(claimId, device, activeRuntime.clock());
      return json(200, creative);
    } catch (error) {
      return json(403, { error: "sponsorship_creative_rejected", message: boundedMessage(error) });
    }
  };
}

export const GET = createSponsorshipCreativeHandler();

function json(status: number, value: unknown) { return Response.json(value, { status, headers: { "cache-control": "no-store" } }); }
function boundedMessage(error: unknown) { return (error instanceof Error ? error.message : "Sponsorship creative rejected").slice(0, 200); }
