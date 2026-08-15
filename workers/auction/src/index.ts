interface DurableObjectStateLike {
  id: { toString(): string };
}

interface AuctionEnvironment {
  DB: unknown;
  AUCTION_OBJECT: unknown;
}

export class AuctionObject {
  readonly id: string;

  constructor(state: DurableObjectStateLike) {
    this.id = state.id.toString();
  }

  fetch(): Response {
    return Response.json({ ok: true, auctionObjectId: this.id });
  }
}

export default {
  fetch(_request: Request, env: AuctionEnvironment): Response {
    if (!env.DB || !env.AUCTION_OBJECT) {
      return Response.json(
        { error: "missing_required_binding" },
        { status: 503 },
      );
    }

    return Response.json({ ok: true, service: "ad-daddy-auction" });
  },
};
