import {
  authenticateSponsorshipRequest,
  deployedSponsorshipRuntime,
  sponsorshipRequestRateLimit,
  type SponsorshipRuntime,
} from "../../../../../lib/marketplace/sponsorship-runtime.ts";
import type { FixedWindowRateLimiter } from "../../../../../lib/http/rate-limit.ts";

export function createNextSponsorshipHandler(runtime?: SponsorshipRuntime, rateLimit: FixedWindowRateLimiter = sponsorshipRequestRateLimit) {
  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    const ipLimit = rateLimit.check([`sponsorship-next-ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`]);
    if (!ipLimit.allowed) return rateLimited(ipLimit.retryAfterSeconds);
    try {
      const rawBody = await boundedBody(request);
      const body = parseBody(rawBody);
      if (body === undefined) return json(400, { error: "invalid_sponsorship_request" });
      const activeRuntime = runtime ?? await deployedSponsorshipRuntime();
      const device = await authenticateSponsorshipRequest(request, rawBody, activeRuntime);
      const deviceLimit = rateLimit.check([`sponsorship-next-installation:${device.installationId}`]);
      if (!deviceLimit.allowed) return rateLimited(deviceLimit.retryAfterSeconds);
      const result = await activeRuntime.service.next(device, activeRuntime.clock(), body.opportunityId);
      return json(result.status === "ready" ? 200 : 202, result, result.status === "ready" ? undefined : { "retry-after": String(result.retryAfterSeconds) });
    } catch (error) {
      return json(403, { error: "sponsorship_fetch_rejected", message: boundedMessage(error) });
    }
  };
}

export const POST = createNextSponsorshipHandler();

async function boundedBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > 16_384) throw new Error("Sponsorship request is too large");
  const value = await request.text();
  if (new TextEncoder().encode(value).byteLength > 16_384) throw new Error("Sponsorship request is too large");
  return value;
}
function parseBody(value: string): { opportunityId?: string } | undefined {
  try {
    const parsed: unknown = value ? JSON.parse(value) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "opportunityId")) return undefined;
    if (record.opportunityId !== undefined && (typeof record.opportunityId !== "string" || !record.opportunityId || record.opportunityId.length > 256)) return undefined;
    return record.opportunityId === undefined ? {} : { opportunityId: record.opportunityId as string };
  } catch { return undefined; }
}
function json(status: number, value: unknown, headers?: HeadersInit) { return Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } }); }
function rateLimited(seconds: number) { return json(429, { error: "rate_limited", retryAfterSeconds: seconds }, { "retry-after": String(seconds) }); }
function boundedMessage(error: unknown) { return (error instanceof Error ? error.message : "Sponsorship request rejected").slice(0, 200); }
