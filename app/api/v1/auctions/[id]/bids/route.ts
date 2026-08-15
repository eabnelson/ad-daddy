import { campaignRuntime, type CampaignRuntime } from "../../../../../../lib/marketplace/campaign-registry.ts";
import { cloudflareAuctionGateway, type AuctionGateway } from "../../../../../../lib/marketplace/auction-gateway.ts";
import { AUCTION_REQUEST_LIMITS, parseBoundedJson, RequestLimitError } from "../../../../../../lib/http/request-limits.ts";
import type { AuctionBid } from "../../../../../../lib/marketplace/ranking.ts";

interface BidBody {
  accountId: string;
  campaignId: string;
  bid: AuctionBid;
}
interface BidRuntime {
  campaigns: CampaignRuntime["campaigns"];
  tokens: CampaignRuntime["tokens"];
  opportunityRateLimit: CampaignRuntime["opportunityRateLimit"];
}

export function createBidHandler(
  gateway: AuctionGateway = cloudflareAuctionGateway,
  runtime: BidRuntime = campaignRuntime,
) {
  return async function handle(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return json(401, { error: "campaign_token_required" });
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const ipLimit = runtime.opportunityRateLimit.check([`auction-ip:${ip}`]);
    if (!ipLimit.allowed) return rateLimited(ipLimit.retryAfterSeconds);
    const { id: auctionId } = await context.params;
    if (!auctionId || auctionId.length > 128) return json(400, { error: "invalid_auction_id" });
    let body: BidBody;
    try { body = await parseBoundedJson(request, AUCTION_REQUEST_LIMITS) as BidBody; }
    catch (error) { return limitError(error); }
    if (!body?.bid || body.bid.campaignId !== body.campaignId) return json(400, { error: "invalid_bid" });
    try {
      const verified = await runtime.tokens.authorize(authorization.slice(7), {
        accountId: body.accountId,
        campaignId: body.campaignId,
        scope: "bid:submit",
        requestedBidMinor: body.bid.grossMinor,
      });
      const authenticatedLimit = runtime.opportunityRateLimit.check([
        `auction-actor:${body.accountId}`, `auction-campaign:${body.campaignId}`, `auction:${auctionId}`,
      ]);
      if (!authenticatedLimit.allowed) return rateLimited(authenticatedLimit.retryAfterSeconds);
      const campaign = await runtime.campaigns.get(body.campaignId);
      if (campaign.accountId !== body.accountId || campaign.status !== "active") return json(403, { error: "active_owned_campaign_required" });
      const spendKey = `auction:${auctionId}:bid:${body.bid.bidId}`;
      let newlyAuthorizedSpend = false;
      if (body.bid.grossMinor > 0) {
        const spend = runtime.tokens.authorizeVerifiedSpend(verified, {
          accountId: body.accountId,
          campaignId: body.campaignId,
          amountMinor: body.bid.grossMinor,
          bidMinor: body.bid.grossMinor,
          idempotencyKey: spendKey,
        });
        newlyAuthorizedSpend = spend.newlyAuthorized;
      }
      try {
        const response = await gateway.bid(auctionId, body.bid);
        if (newlyAuthorizedSpend) {
          if (response.ok) runtime.tokens.commitVerifiedSpend(verified, spendKey);
          else runtime.tokens.releaseVerifiedSpend(verified, spendKey);
        }
        return response;
      } catch (error) {
        if (newlyAuthorizedSpend) runtime.tokens.releaseVerifiedSpend(verified, spendKey);
        throw error;
      }
    } catch (error) {
      return json(403, { error: "bid_rejected", message: boundedMessage(error) });
    }
  };
}

export const POST = createBidHandler();

function boundedMessage(error: unknown) { return (error instanceof Error ? error.message : "Request rejected").slice(0, 240); }
function json(status: number, body: unknown, headers?: HeadersInit) { return Response.json(body, { status, headers }); }
function rateLimited(seconds: number) { return json(429, { error: "rate_limited", retryAfterSeconds: seconds }, { "retry-after": String(seconds) }); }
function limitError(error: unknown) {
  if (error instanceof RequestLimitError) return json(error.status, { error: error.code, message: error.message.slice(0, 160) });
  return json(400, { error: "invalid_request" });
}
