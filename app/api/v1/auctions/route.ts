import { AUCTION_REQUEST_LIMITS, parseBoundedJson, RequestLimitError } from "../../../../lib/http/request-limits.ts";
import { cloudflareAuctionGateway, type AuctionGateway } from "../../../../lib/marketplace/auction-gateway.ts";
import type { AuctionDefinition } from "../../../../lib/marketplace/auction.ts";
import { campaignRuntime } from "../../../../lib/marketplace/campaign-registry.ts";
import type { FixedWindowRateLimiter } from "../../../../lib/http/rate-limit.ts";

export function createAuctionHandler(
  gateway: AuctionGateway = cloudflareAuctionGateway,
  rateLimiter: FixedWindowRateLimiter = campaignRuntime.campaignRateLimit,
) {
  return async function handle(request: Request): Promise<Response> {
    const accountId = request.headers.get("oai-authenticated-user-id");
    if (!accountId) return json(401, { error: "human_authentication_required" });
    const initialLimit = rateLimiter.check([`auction-actor:${accountId}`, `auction-ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`]);
    if (!initialLimit.allowed) return rateLimited(initialLimit.retryAfterSeconds);
    if (request.method === "GET") {
      const auctionId = new URL(request.url).searchParams.get("id");
      if (!auctionId || auctionId.length > 128) return json(400, { error: "auction_id_required" });
      const auctionLimit = rateLimiter.check([`auction:${auctionId}`]);
      if (!auctionLimit.allowed) return rateLimited(auctionLimit.retryAfterSeconds);
      if (!await gateway.ownsAuction(accountId, auctionId)) return json(404, { error: "auction_not_found" });
      return gateway.read(auctionId);
    }
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    let definition: AuctionDefinition;
    try { definition = await parseBoundedJson(request, AUCTION_REQUEST_LIMITS) as AuctionDefinition; }
    catch (error) { return limitError(error); }
    if (!definition?.auctionId || !definition.opportunityId) return json(400, { error: "invalid_auction" });
    const auctionLimit = rateLimiter.check([`auction:${definition.auctionId}`]);
    if (!auctionLimit.allowed) return rateLimited(auctionLimit.retryAfterSeconds);
    if (!await gateway.ownsOpportunity(accountId, definition.opportunityId)) return json(404, { error: "opportunity_not_found" });
    return gateway.open(definition);
  };
}

export const GET = createAuctionHandler();
export const POST = GET;

function json(status: number, body: unknown) { return Response.json(body, { status }); }
function rateLimited(seconds: number) { return Response.json({ error: "rate_limited", retryAfterSeconds: seconds }, { status: 429, headers: { "retry-after": String(seconds) } }); }
function limitError(error: unknown) {
  if (error instanceof RequestLimitError) return json(error.status, { error: error.code, message: error.message.slice(0, 160) });
  return json(400, { error: "invalid_request" });
}
