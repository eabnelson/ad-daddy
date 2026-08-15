export { AuctionObject } from "./auction-object.js";

interface DurableObjectIdLike { toString(): string; }
interface DurableObjectStubLike { fetch(request: Request): Promise<Response>; }
interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}
interface AuctionEnvironment { DB: unknown; AUCTION_OBJECT: DurableObjectNamespaceLike; }

export default {
  async fetch(request: Request, env: AuctionEnvironment): Promise<Response> {
    if (!env.DB || !env.AUCTION_OBJECT) {
      return Response.json({ error: "missing_required_binding" }, { status: 503 });
    }
    const url = new URL(request.url);
    const match = /^\/auctions\/([^/]+)(?:\/.*)?$/.exec(url.pathname);
    if (!match) return Response.json({ error: "auction_not_found" }, { status: 404 });
    const auctionId = decodeURIComponent(match[1]);
    if (!auctionId || auctionId.length > 128) return Response.json({ error: "invalid_auction_id" }, { status: 400 });
    return env.AUCTION_OBJECT.get(env.AUCTION_OBJECT.idFromName(auctionId)).fetch(request);
  },
};
