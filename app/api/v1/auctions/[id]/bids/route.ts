import { getCampaignRuntime, type CampaignRuntime } from "../../../../../../lib/marketplace/campaign-registry.ts";
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
  runtime?: BidRuntime,
) {
  return async function handle(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const activeRuntime = runtime ?? await getCampaignRuntime();
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return json(401, { error: "campaign_token_required" });
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const ipLimit = activeRuntime.opportunityRateLimit.check([`auction-ip:${ip}`]);
    if (!ipLimit.allowed) return rateLimited(ipLimit.retryAfterSeconds);
    const { id: auctionId } = await context.params;
    if (!auctionId || auctionId.length > 128) return json(400, { error: "invalid_auction_id" });
    let body: BidBody;
    try { body = await parseBoundedJson(request, AUCTION_REQUEST_LIMITS) as BidBody; }
    catch (error) { return limitError(error); }
    if (!body?.bid || body.bid.campaignId !== body.campaignId) return json(400, { error: "invalid_bid" });
    try {
      const verified = await activeRuntime.tokens.authorize(authorization.slice(7), {
        accountId: body.accountId,
        campaignId: body.campaignId,
        scope: "bid:submit",
        requestedBidMinor: body.bid.grossMinor,
      });
      const authenticatedLimit = activeRuntime.opportunityRateLimit.check([
        `auction-actor:${body.accountId}`, `auction-campaign:${body.campaignId}`, `auction:${auctionId}`,
      ]);
      if (!authenticatedLimit.allowed) return rateLimited(authenticatedLimit.retryAfterSeconds);
      const campaign = await activeRuntime.campaigns.get(body.campaignId);
      if (campaign.accountId !== body.accountId || campaign.status !== "active") return json(403, { error: "active_owned_campaign_required" });
      const spendKey = `auction:${auctionId}:bid:${body.bid.bidId}`;
      let authorizedSpend = false;
      if (body.bid.grossMinor > 0) {
        await activeRuntime.tokens.authorizeVerifiedSpend(verified, {
          accountId: body.accountId,
          campaignId: body.campaignId,
          amountMinor: body.bid.grossMinor,
          bidMinor: body.bid.grossMinor,
          idempotencyKey: spendKey,
        });
        authorizedSpend = true;
      }
      try {
        const response = await gateway.bid(auctionId, body.bid);
        if (authorizedSpend) {
          if (response.ok) await activeRuntime.tokens.commitVerifiedSpend(verified, spendKey);
          else await activeRuntime.tokens.releaseVerifiedSpend(verified, spendKey);
        }
        return response;
      } catch (error) {
        if (!authorizedSpend) throw error;
        const reconciled = await reconcileAmbiguousBid(gateway, auctionId, body.bid.bidId);
        if (reconciled === "accepted") {
          await activeRuntime.tokens.commitVerifiedSpend(verified, spendKey);
          return json(201, { accepted: true, bidId: body.bid.bidId, reconciled: true });
        }
        if (reconciled === "rejected") {
          await activeRuntime.tokens.releaseVerifiedSpend(verified, spendKey);
          throw error;
        }
        return json(503, { error: "bid_status_uncertain", message: "Bid status could not be reconciled; spend remains reserved for safety" }, { "retry-after": "5" });
      }
    } catch (error) {
      return json(403, { error: "bid_rejected", message: boundedMessage(error) });
    }
  };
}

async function reconcileAmbiguousBid(gateway: AuctionGateway, auctionId: string, bidId: string): Promise<"accepted" | "rejected" | "unknown"> {
  if (!gateway.readBid) return "unknown";
  try {
    const response = await gateway.readBid(auctionId, bidId);
    if (response.ok) {
      const body = await response.clone().json().catch(() => undefined) as { accepted?: unknown; bidId?: unknown } | undefined;
      return body?.accepted === true && body.bidId === bidId ? "accepted" : "unknown";
    }
    return response.status === 404 ? "rejected" : "unknown";
  } catch {
    return "unknown";
  }
}

export const POST = createBidHandler();

function boundedMessage(error: unknown) { return (error instanceof Error ? error.message : "Request rejected").slice(0, 240); }
function json(status: number, body: unknown, headers?: HeadersInit) { return Response.json(body, { status, headers }); }
function rateLimited(seconds: number) { return json(429, { error: "rate_limited", retryAfterSeconds: seconds }, { "retry-after": String(seconds) }); }
function limitError(error: unknown) {
  if (error instanceof RequestLimitError) return json(error.status, { error: error.code, message: error.message.slice(0, 160) });
  return json(400, { error: "invalid_request" });
}
