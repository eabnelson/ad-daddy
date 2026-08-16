import assert from "node:assert/strict";
import test from "node:test";

import { createCloudflareAuctionGateway } from "../../lib/marketplace/auction-gateway.ts";

test("auction service calls abort at the configured dependency deadline", async () => {
  const gateway = createCloudflareAuctionGateway(async () => ({
    DB: {} as D1Database,
    AUCTION_SERVICE: {
      fetch(_input, init) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      },
    },
  }), 5);

  await assert.rejects(gateway.read("auction_timeout"), /timeout|abort/i);
});
