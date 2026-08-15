import { campaignRuntime, type CampaignRuntime } from "../../../../lib/marketplace/campaign-registry.ts";
import { OPPORTUNITY_REQUEST_LIMITS, parseBoundedJson, RequestLimitError } from "../../../../lib/http/request-limits.ts";

interface SearchBody { campaignId: string; accountId: string; limit?: number; cursor?: number; }

export function createOpportunityHandler(runtime: CampaignRuntime = campaignRuntime) {
  return async function handle(request: Request): Promise<Response> {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return json(401, { error: "campaign_token_required" });
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const initial = runtime.opportunityRateLimit.check([`ip:${ip}`]);
    if (!initial.allowed) return rateLimited(initial.retryAfterSeconds);
    let body: SearchBody;
    try {
      const parsed = await parseBoundedJson(request, OPPORTUNITY_REQUEST_LIMITS);
      if (!isRecord(parsed) || typeof parsed.accountId !== "string" || !parsed.accountId || parsed.accountId.length > 128 || typeof parsed.campaignId !== "string" || !parsed.campaignId || parsed.campaignId.length > 128) return json(400, { error: "invalid_opportunity_request" });
      body = parsed as unknown as SearchBody;
    }
    catch (error) { return limitError(error); }
    const limit = body.limit ?? 20;
    const cursor = body.cursor ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > 10_000) return json(400, { error: "invalid_pagination" });
    try {
      await runtime.tokens.verify(authorization.slice(7), { accountId: body.accountId, campaignId: body.campaignId, scope: "opportunity:search" });
      const authenticatedLimit = runtime.opportunityRateLimit.check([`actor:${body.accountId}`, `campaign:${body.campaignId}`]);
      if (!authenticatedLimit.allowed) return rateLimited(authenticatedLimit.retryAfterSeconds);
      const campaign = await runtime.campaigns.get(body.campaignId);
      if (campaign.accountId !== body.accountId || campaign.status !== "active") return json(403, { error: "active_owned_campaign_required" });
      const inventory = await runtime.listCandidates(body.campaignId);
      const results = await runtime.campaigns.search(body.campaignId, inventory);
      const items = results.slice(cursor, cursor + limit);
      return json(200, { items, nextCursor: cursor + items.length < results.length ? cursor + items.length : null });
    } catch (error) {
      return json(403, { error: "opportunity_search_rejected", message: boundedMessage(error) });
    }
  };
}

export const POST = createOpportunityHandler();

function boundedMessage(error: unknown) { return (error instanceof Error ? error.message : "Request rejected").slice(0, 240); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function json(status: number, body: unknown, headers?: HeadersInit) { return Response.json(body, { status, headers }); }
function rateLimited(seconds: number) { return json(429, { error: "rate_limited", retryAfterSeconds: seconds }, { "retry-after": String(seconds) }); }
function limitError(error: unknown) {
  if (error instanceof RequestLimitError) return json(error.status, { error: error.code, message: error.message.slice(0, 160) });
  return json(400, { error: "invalid_request" });
}
