import type { AuctionDefinition } from "./auction.ts";
import type { AuctionBid } from "./ranking.ts";

export interface AuctionGateway {
  ownsOpportunity(accountId: string, opportunityId: string): Promise<boolean>;
  ownsAuction(accountId: string, auctionId: string): Promise<boolean>;
  open(definition: AuctionDefinition): Promise<Response>;
  read(auctionId: string): Promise<Response>;
  bid(auctionId: string, bid: AuctionBid): Promise<Response>;
}

export const cloudflareAuctionGateway: AuctionGateway = {
  async ownsOpportunity(accountId, opportunityId) {
    const { env } = await import("cloudflare:workers");
    const row = await env.DB.prepare("SELECT 1 AS owned FROM opportunities o JOIN receiver_profiles rp ON rp.id = o.receiver_profile_id WHERE o.id = ? AND rp.account_id = ?")
      .bind(opportunityId, accountId).first<{ owned: number }>();
    return row?.owned === 1;
  },
  async ownsAuction(accountId, auctionId) {
    const { env } = await import("cloudflare:workers");
    const row = await env.DB.prepare("SELECT 1 AS owned FROM auctions a JOIN opportunities o ON o.id = a.opportunity_id JOIN receiver_profiles rp ON rp.id = o.receiver_profile_id WHERE a.id = ? AND rp.account_id = ?")
      .bind(auctionId, accountId).first<{ owned: number }>();
    return row?.owned === 1;
  },
  async open(definition) {
    const { env } = await import("cloudflare:workers");
    return env.AUCTION_SERVICE.fetch(`https://auction.internal/auctions/${encodeURIComponent(definition.auctionId)}/open`, jsonInit(definition));
  },
  async read(auctionId) {
    const { env } = await import("cloudflare:workers");
    return env.AUCTION_SERVICE.fetch(`https://auction.internal/auctions/${encodeURIComponent(auctionId)}`);
  },
  async bid(auctionId, bid) {
    const { env } = await import("cloudflare:workers");
    return env.AUCTION_SERVICE.fetch(`https://auction.internal/auctions/${encodeURIComponent(auctionId)}/bids`, jsonInit(bid));
  },
};

function jsonInit(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
