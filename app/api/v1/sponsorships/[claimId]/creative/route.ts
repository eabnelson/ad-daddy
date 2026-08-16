import {
  authenticateSponsorshipRequest,
  deployedSponsorshipRuntime,
  sponsorshipRequestRateLimit,
  type SponsorshipRuntime,
} from "../../../../../../lib/marketplace/sponsorship-runtime.ts";
import type { FixedWindowRateLimiter } from "../../../../../../lib/http/rate-limit.ts";

export function createSponsorshipCreativeHandler(runtime?: SponsorshipRuntime, rateLimit: FixedWindowRateLimiter = sponsorshipRequestRateLimit) {
  return async function handle(request: Request, context: { params: Promise<{ claimId: string }> }): Promise<Response> {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
    const ipLimit = rateLimit.check([`sponsorship-creative-ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`]);
    if (!ipLimit.allowed) return rateLimited(ipLimit.retryAfterSeconds);
    try {
      const activeRuntime = runtime ?? await deployedSponsorshipRuntime();
      const device = await authenticateSponsorshipRequest(request, "", activeRuntime);
      const deviceLimit = rateLimit.check([`sponsorship-creative-installation:${device.installationId}`]);
      if (!deviceLimit.allowed) return rateLimited(deviceLimit.retryAfterSeconds);
      const { claimId } = await context.params;
      if (!claimId || claimId.length > 256) return json(404, { error: "sponsorship_not_found" });
      const creative = await activeRuntime.service.creative(claimId, device, activeRuntime.clock());
      return json(200, creative);
    } catch (error) {
      return json(403, { error: "sponsorship_creative_rejected", message: boundedMessage(error) });
    }
  };
}

export function createSponsorshipCancelHandler(runtime?: SponsorshipRuntime, rateLimit: FixedWindowRateLimiter = sponsorshipRequestRateLimit) {
  return async function handle(request: Request, context: { params: Promise<{ claimId: string }> }): Promise<Response> {
    if (request.method !== "DELETE") return json(405, { error: "method_not_allowed" });
    const ipLimit = rateLimit.check([`sponsorship-cancel-ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`]);
    if (!ipLimit.allowed) return rateLimited(ipLimit.retryAfterSeconds);
    try {
      const activeRuntime = runtime ?? await deployedSponsorshipRuntime();
      const device = await authenticateSponsorshipRequest(request, "", activeRuntime);
      const deviceLimit = rateLimit.check([`sponsorship-cancel-installation:${device.installationId}`]);
      if (!deviceLimit.allowed) return rateLimited(deviceLimit.retryAfterSeconds);
      const { claimId } = await context.params;
      if (!claimId || claimId.length > 256) return json(404, { error: "sponsorship_not_found" });
      return json(200, await activeRuntime.service.cancel(claimId, device, activeRuntime.clock()));
    } catch (error) {
      return json(403, { error: "sponsorship_cancel_rejected", message: boundedMessage(error) });
    }
  };
}

export const GET = createSponsorshipCreativeHandler();
export const DELETE = createSponsorshipCancelHandler();

function json(status: number, value: unknown) { return Response.json(value, { status, headers: { "cache-control": "no-store" } }); }
function rateLimited(seconds: number) { return Response.json({ error: "rate_limited", retryAfterSeconds: seconds }, { status: 429, headers: { "cache-control": "no-store", "retry-after": String(seconds) } }); }
function boundedMessage(error: unknown) { return (error instanceof Error ? error.message : "Sponsorship creative rejected").slice(0, 200); }
