import type { AuctionDefinition } from "./auction.ts";
import type { AuctionBid } from "./ranking.ts";

export interface AuctionGateway {
  ownsOpportunity(accountId: string, opportunityId: string): Promise<boolean>;
  ownsAuction(accountId: string, auctionId: string): Promise<boolean>;
  open(definition: AuctionDefinition): Promise<Response>;
  read(auctionId: string): Promise<Response>;
  readBid?(auctionId: string, bidId: string): Promise<Response>;
  bid(auctionId: string, bid: AuctionBid): Promise<Response>;
}

interface AuctionGatewayBindings {
  DB: D1Database;
  AUCTION_SERVICE: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

const DEFAULT_AUCTION_TIMEOUT_MS = 5_000;

export function createCloudflareAuctionGateway(
  loadBindings: () => Promise<AuctionGatewayBindings>,
  timeoutMs = DEFAULT_AUCTION_TIMEOUT_MS,
): AuctionGateway {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new Error("Auction gateway timeout must be between 1 and 30000 milliseconds");
  }
  return {
  async ownsOpportunity(accountId, opportunityId) {
    const env = await loadBindings();
    const row = await env.DB.prepare("SELECT 1 AS owned FROM opportunities o JOIN receiver_profiles rp ON rp.id = o.receiver_profile_id WHERE o.id = ? AND rp.account_id = ?")
      .bind(opportunityId, accountId).first<{ owned: number }>();
    return row?.owned === 1;
  },
  async ownsAuction(accountId, auctionId) {
    const env = await loadBindings();
    const row = await env.DB.prepare("SELECT 1 AS owned FROM auctions a JOIN opportunities o ON o.id = a.opportunity_id JOIN receiver_profiles rp ON rp.id = o.receiver_profile_id WHERE a.id = ? AND rp.account_id = ?")
      .bind(auctionId, accountId).first<{ owned: number }>();
    return row?.owned === 1;
  },
  async open(definition) {
    const env = await loadBindings();
    return env.AUCTION_SERVICE.fetch(
      `https://auction.internal/auctions/${encodeURIComponent(definition.auctionId)}/open`,
      jsonInit(definition, timeoutMs),
    );
  },
  async read(auctionId) {
    const env = await loadBindings();
    return env.AUCTION_SERVICE.fetch(
      `https://auction.internal/auctions/${encodeURIComponent(auctionId)}`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
  },
  async bid(auctionId, bid) {
    const env = await loadBindings();
    return env.AUCTION_SERVICE.fetch(
      `https://auction.internal/auctions/${encodeURIComponent(auctionId)}/bids`,
      jsonInit(bid, timeoutMs),
    );
  },
  async readBid(auctionId, bidId) {
    const env = await loadBindings();
    return env.AUCTION_SERVICE.fetch(
      `https://auction.internal/auctions/${encodeURIComponent(auctionId)}/bids/${encodeURIComponent(bidId)}`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
  },
  };
}

export const cloudflareAuctionGateway = createCloudflareAuctionGateway(async () => {
  const { env } = await import("cloudflare:workers");
  return env;
});

function jsonInit(body: unknown, timeoutMs: number): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  };
}
