import assert from "node:assert/strict";
import test from "node:test";

import { buildDemoAuction, createSponsoredSession, DEMO_FREQUENCIES, isDemoFrequencyId, suggestDemoMinimumTakeHomeRange } from "../../lib/demo/market.ts";

test("demo auction ranks real contextual cash offers and derives the 80/20 split", () => {
  const auction = buildDemoAuction({ projectName: "Receipt API",
    projectDescription: "A TypeScript API running on Cloudflare with Postgres",
    sharedSignalCount: 5, minimumTakeHomeMinor: 50, acceptedRewards: ["cash", "credits"] });

  assert.equal(auction.status, "filled");
  if (auction.status !== "filled") return;
  assert.equal(auction.bids.length, 3);
  assert.equal(auction.winner.advertiserId, "neon");
  assert.equal(auction.winner.rewardType, "cash");
  if (auction.winner.rewardType !== "cash") return;
  assert.equal(auction.winner.grossAmountMinor, 106);
  assert.equal(auction.winner.operatorFeeMinor, 21);
  assert.equal(auction.winner.receiverTakeHomeMinor, 85);
  assert.equal(auction.winner.profileBoostMinor, 20);
  assert.equal(auction.winner.profileBoostTakeHomeMinor, 16);
  assert.deepEqual(auction.winner.actionRewards.map((reward) => ({
    id: reward.id,
    receiverTakeHomeMinor: reward.receiverTakeHomeMinor,
    verification: reward.verification,
  })), [
    { id: "open_brief", receiverTakeHomeMinor: 160, verification: "Verified link open" },
    { id: "activate", receiverTakeHomeMinor: 1_200, verification: "Verified product activation" },
    { id: "paid_conversion", receiverTakeHomeMinor: 8_000, verification: "Verified first payment" },
  ]);
  assert.deepEqual(auction.winner.matchedSignals, [
    { signal: "Project name", terms: ["api"] },
    { signal: "Project description", terms: ["postgres", "cloudflare", "api"] },
  ]);
});

test("a receiver minimum is eligibility, not a floor that inflates advertiser offers", () => {
  const auction = buildDemoAuction({ projectName: "Receipt API",
    projectDescription: "A TypeScript API running on Cloudflare with Postgres",
    sharedSignalCount: 5, minimumTakeHomeMinor: 100, acceptedRewards: ["cash"] });

  assert.equal(auction.status, "no_fill");
  if (auction.status !== "no_fill") return;
  assert.equal(auction.reason, "minimum_not_met");
  assert.equal(auction.bids[0]?.rewardType, "cash");
  if (auction.bids[0]?.rewardType !== "cash") return;
  assert.equal(auction.bids[0].grossAmountMinor, 106);
  assert.equal(auction.bids[0].receiverTakeHomeMinor, 85);
});

test("discounts-only selection produces an explicitly noncash, fee-free offer", () => {
  const auction = buildDemoAuction({ projectName: "Weekend project",
    projectDescription: "Trying a small new idea", sharedSignalCount: 0,
    minimumTakeHomeMinor: 0, acceptedRewards: ["discounts"] });

  assert.equal(auction.status, "filled");
  if (auction.status !== "filled") return;
  assert.equal(auction.bids.length, 1);
  assert.equal(auction.winner.advertiserId, "doordash");
  assert.equal(auction.winner.rewardType, "discounts");
  if (auction.winner.rewardType !== "discounts") return;
  assert.equal(auction.winner.baseValueMinor, 800);
  assert.equal(auction.winner.valueMinor, 800);
  assert.equal(auction.winner.profileBoostValueMinor, 0);
  assert.equal("operatorFeeMinor" in auction.winner, false);
});

test("sponsored session derives its disclosure from actual matched signals", () => {
  const auction = buildDemoAuction({ projectName: "Receipt API",
    projectDescription: "A TypeScript API running on Cloudflare with Postgres",
    sharedSignalCount: 5, minimumTakeHomeMinor: 50, acceptedRewards: ["cash", "credits"] });

  assert.equal(auction.status, "filled");
  if (auction.status !== "filled") return;
  const session = createSponsoredSession(auction);
  assert.equal(session.title, `AD DADDY: ${session.headline}`);
  assert.equal(session.disclosure, "Sponsored via Ad Daddy");
  assert.equal(session.rewardType, "cash");
  assert.equal(session.rewardMinor, 85);
  assert.equal(session.potentialRewardMinor, 9_445);
  assert.equal(session.actionRewards.length, 3);
  assert.deepEqual(session.matchedSignals, [
    { signal: "Project name", terms: ["api"] },
    { signal: "Project description", terms: ["postgres", "cloudflare", "api"] },
  ]);
  assert.equal(session.executionPolicy, "display-only");
});

test("sharing more approved profile signals raises only the guaranteed placement bid", () => {
  const privateAuction = buildDemoAuction({ projectName: "Receipt API",
    projectDescription: "A TypeScript API running on Cloudflare with Postgres",
    sharedSignalCount: 2, minimumTakeHomeMinor: 0, acceptedRewards: ["cash"] });
  const richAuction = buildDemoAuction({ projectName: "Receipt API",
    projectDescription: "A TypeScript API running on Cloudflare with Postgres",
    sharedSignalCount: 7, minimumTakeHomeMinor: 0, acceptedRewards: ["cash"] });

  assert.equal(privateAuction.status, "filled");
  assert.equal(richAuction.status, "filled");
  if (privateAuction.status !== "filled" || richAuction.status !== "filled") return;
  assert.equal(privateAuction.winner.rewardType, "cash");
  assert.equal(richAuction.winner.rewardType, "cash");
  if (privateAuction.winner.rewardType !== "cash" || richAuction.winner.rewardType !== "cash") return;
  assert.ok(richAuction.winner.receiverTakeHomeMinor > privateAuction.winner.receiverTakeHomeMinor);
  assert.deepEqual(richAuction.winner.actionRewards, privateAuction.winner.actionRewards);
});

test("profile lift uses the exact post-rounding take-home delta", () => {
  const auction = buildDemoAuction({ projectName: "Receipt API",
    projectDescription: "A TypeScript API running on Cloudflare with Postgres",
    sharedSignalCount: 1, minimumTakeHomeMinor: 0, acceptedRewards: ["cash"] });

  assert.equal(auction.status, "filled");
  if (auction.status !== "filled" || auction.winner.rewardType !== "cash") return;
  assert.equal(auction.winner.profileBoostMinor, 4);
  assert.equal(auction.winner.profileBoostTakeHomeMinor, 3);
});

test("approved profile context raises credits and discounts offers too", () => {
  for (const reward of ["credits", "discounts"] as const) {
    const privateAuction = buildDemoAuction({ projectName: "Weekend project",
      projectDescription: "Trying a small new idea", sharedSignalCount: 0,
      minimumTakeHomeMinor: 0, acceptedRewards: [reward] });
    const richAuction = buildDemoAuction({ projectName: "Weekend project",
      projectDescription: "Trying a small new idea", sharedSignalCount: 7,
      minimumTakeHomeMinor: 0, acceptedRewards: [reward] });

    assert.equal(privateAuction.status, "filled");
    assert.equal(richAuction.status, "filled");
    if (privateAuction.status !== "filled" || richAuction.status !== "filled") continue;
    assert.equal(privateAuction.winner.rewardType, reward);
    assert.equal(richAuction.winner.rewardType, reward);
    assert.equal(richAuction.winner.profileBoostValueMinor, 28);
    assert.equal(richAuction.winner.valueMinor - privateAuction.winner.valueMinor, 28);
  }
});

test("cash economics stay internally balanced through the sponsored session", () => {
  const auction = buildDemoAuction({ projectName: "Receipt API",
    projectDescription: "A TypeScript API running on Cloudflare with Postgres",
    sharedSignalCount: 5, minimumTakeHomeMinor: 0, acceptedRewards: ["cash"] });

  assert.equal(auction.status, "filled");
  if (auction.status !== "filled" || auction.winner.rewardType !== "cash") return;
  assert.equal(auction.winner.grossAmountMinor,
    auction.winner.operatorFeeMinor + auction.winner.receiverTakeHomeMinor);
  const session = createSponsoredSession(auction);
  assert.equal(session.potentialRewardMinor,
    auction.winner.receiverTakeHomeMinor
      + auction.winner.actionRewards.reduce((sum, reward) => sum + reward.receiverTakeHomeMinor, 0));
});

test("suggested cash minimums reflect profile context and frequency", () => {
  const context = { projectName: "Receipt API",
    projectDescription: "A TypeScript API running on Cloudflare with Postgres",
    sharedSignalCount: 5 };

  assert.deepEqual(suggestDemoMinimumTakeHomeRange(context, "manual"),
    { lowMinor: 79, highMinor: 94, sampleSize: 3 });
  assert.deepEqual(suggestDemoMinimumTakeHomeRange(context, "daily"),
    { lowMinor: 61, highMinor: 72, sampleSize: 3 });
  assert.deepEqual(suggestDemoMinimumTakeHomeRange(context, "every_session"),
    { lowMinor: 43, highMinor: 51, sampleSize: 3 });
});

test("suggested cash minimums still use cash market data when cash is not selected", () => {
  const range = suggestDemoMinimumTakeHomeRange({ projectName: "Receipt API",
    projectDescription: "A TypeScript API running on Cloudflare with Postgres",
    sharedSignalCount: 7 }, "every_session");

  assert.equal(range.sampleSize, 3);
  assert.ok(range.lowMinor > 0);
  assert.ok(range.highMinor >= range.lowMinor);
});

test("suggested cash minimums rise with richer comparable profile context", () => {
  const sparse = suggestDemoMinimumTakeHomeRange({ projectName: "Weekend project",
    projectDescription: "Trying a small new idea", sharedSignalCount: 0 }, "twice_weekly");
  const rich = suggestDemoMinimumTakeHomeRange({ projectName: "Receipt API",
    projectDescription: "A TypeScript API running on Cloudflare with Postgres",
    sharedSignalCount: 5 }, "twice_weekly");

  assert.deepEqual(sparse, { lowMinor: 32, highMinor: 42, sampleSize: 3 });
  assert.deepEqual(rich, { lowMinor: 72, highMinor: 85, sampleSize: 3 });
});

test("frequency configuration is one typed source of truth from manual pulls to every session", () => {
  assert.deepEqual(DEMO_FREQUENCIES.three_daily, { label: "3 per day", slots: 90 });
  assert.deepEqual(DEMO_FREQUENCIES.eight_daily, { label: "8 per day", slots: 240 });
  assert.deepEqual(DEMO_FREQUENCIES.every_session, { label: "Every eligible session", slots: 600 });
  assert.equal(isDemoFrequencyId("every_session"), true);
  assert.equal(isDemoFrequencyId("unbounded"), false);
});
