import assert from "node:assert/strict";
import test from "node:test";

import { buildDemoAuction } from "../../lib/demo/market.ts";
import { creditDemoAction, creditDemoPlacement, INITIAL_DEMO_CASH_REWARDS } from "../../lib/demo/reward-state.ts";

function cashWinner() {
  const auction = buildDemoAuction({ projectName: "Receipt API",
    projectDescription: "A TypeScript API running on Cloudflare with Postgres",
    sharedSignalCount: 5, minimumTakeHomeMinor: 0, acceptedRewards: ["cash"] });
  assert.equal(auction.status, "filled");
  if (auction.status !== "filled" || auction.winner.rewardType !== "cash") throw new Error("cash winner required");
  return { auction, winner: auction.winner };
}

test("a placement credits the demo wallet exactly once", () => {
  const { auction, winner } = cashWinner();
  const credited = creditDemoPlacement(INITIAL_DEMO_CASH_REWARDS, auction.auctionId, winner.receiverTakeHomeMinor);
  const replayed = creditDemoPlacement(credited, auction.auctionId, winner.receiverTakeHomeMinor);

  assert.equal(credited.balanceMinor, winner.receiverTakeHomeMinor);
  assert.strictEqual(replayed, credited);
});

test("each optional action credits exactly once", () => {
  const { winner } = cashWinner();
  const reward = winner.actionRewards[0];
  assert.ok(reward);
  const credited = creditDemoAction(INITIAL_DEMO_CASH_REWARDS, reward);
  const replayed = creditDemoAction(credited, reward);

  assert.equal(credited.balanceMinor, reward.receiverTakeHomeMinor);
  assert.deepEqual(credited.completedActionIds, [reward.id]);
  assert.strictEqual(replayed, credited);
});
