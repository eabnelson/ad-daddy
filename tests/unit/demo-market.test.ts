import assert from "node:assert/strict";
import test from "node:test";

import { buildDemoAuction, createSponsoredSession } from "../../lib/demo/market.ts";

test("demo auction ranks real contextual cash offers and derives the 80/20 split", () => {
  const auction = buildDemoAuction({ projectName: "Receipt API",
    projectDescription: "A TypeScript API running on Cloudflare with Postgres",
    minimumTakeHomeMinor: 50, acceptedRewards: ["cash", "credits"] });

  assert.equal(auction.status, "filled");
  if (auction.status !== "filled") return;
  assert.equal(auction.bids.length, 3);
  assert.equal(auction.winner.advertiserId, "neon");
  assert.equal(auction.winner.rewardType, "cash");
  if (auction.winner.rewardType !== "cash") return;
  assert.equal(auction.winner.grossAmountMinor, 86);
  assert.equal(auction.winner.operatorFeeMinor, 17);
  assert.equal(auction.winner.receiverTakeHomeMinor, 69);
  assert.deepEqual(auction.winner.matchedSignals, [
    { signal: "Project name", terms: ["api"] },
    { signal: "Project description", terms: ["postgres", "cloudflare", "api"] },
  ]);
});

test("a receiver minimum is eligibility, not a floor that inflates advertiser offers", () => {
  const auction = buildDemoAuction({ projectName: "Receipt API",
    projectDescription: "A TypeScript API running on Cloudflare with Postgres",
    minimumTakeHomeMinor: 100, acceptedRewards: ["cash"] });

  assert.equal(auction.status, "no_fill");
  if (auction.status !== "no_fill") return;
  assert.equal(auction.reason, "minimum_not_met");
  assert.equal(auction.bids[0]?.rewardType, "cash");
  if (auction.bids[0]?.rewardType !== "cash") return;
  assert.equal(auction.bids[0].grossAmountMinor, 86);
  assert.equal(auction.bids[0].receiverTakeHomeMinor, 69);
});

test("discounts-only selection produces an explicitly noncash, fee-free offer", () => {
  const auction = buildDemoAuction({ projectName: "Weekend project",
    projectDescription: "Trying a small new idea", minimumTakeHomeMinor: 0, acceptedRewards: ["discounts"] });

  assert.equal(auction.status, "filled");
  if (auction.status !== "filled") return;
  assert.equal(auction.bids.length, 1);
  assert.equal(auction.winner.advertiserId, "doordash");
  assert.equal(auction.winner.rewardType, "discounts");
  if (auction.winner.rewardType !== "discounts") return;
  assert.equal(auction.winner.valueMinor, 800);
  assert.equal("operatorFeeMinor" in auction.winner, false);
});

test("sponsored session derives its disclosure from actual matched signals", () => {
  const auction = buildDemoAuction({ projectName: "Receipt API",
    projectDescription: "A TypeScript API running on Cloudflare with Postgres",
    minimumTakeHomeMinor: 50, acceptedRewards: ["cash", "credits"] });

  assert.equal(auction.status, "filled");
  if (auction.status !== "filled") return;
  const session = createSponsoredSession(auction);
  assert.match(session.title, /^Sponsored · /);
  assert.equal(session.disclosure, "Sponsored via Ad Daddy");
  assert.equal(session.rewardType, "cash");
  assert.equal(session.rewardMinor, 69);
  assert.deepEqual(session.matchedSignals, [
    { signal: "Project name", terms: ["api"] },
    { signal: "Project description", terms: ["postgres", "cloudflare", "api"] },
  ]);
  assert.equal(session.executionPolicy, "display-only");
});
