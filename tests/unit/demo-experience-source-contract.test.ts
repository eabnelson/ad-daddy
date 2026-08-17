import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const demoSource = readFile("app/demo/demo-experience.tsx", "utf8");
const marketSource = readFile("lib/demo/market.ts", "utf8");

test("demo source exposes the receiver setup and sponsored-session contract", async () => {
  const source = await demoSource;

  for (const expected of [
    "Project names",
    "Public GitHub repos",
    "Project descriptions",
    "Tech stack",
    "Location",
    "Token usage",
    "Subscription tier",
    "Background polling active",
    "Sponsored via Ad Daddy",
    "Display only",
  ]) {
    assert.match(source, new RegExp(expected, "i"), `missing demo contract: ${expected}`);
  }

  assert.match(source, /stage !== "ready"/);
  assert.match(source, /setStage\("auction"\)/);
  assert.doesNotMatch(source, /Nothing happens until you ask/i);
  assert.doesNotMatch(source, /Check for a sponsorship/i);
});

test("demo source only sends consented project signals into matching", async () => {
  const source = await demoSource;

  assert.match(source, /projectName: shared\.projects \? projectName : ""/);
  assert.match(source, /projectDescription: shared\.descriptions \? projectDescription : ""/);
  assert.match(source, /sponsoredSession\.matchedSignals/);
  assert.doesNotMatch(source, /createSponsoredSession\(auction, sharedLabels\)/);
});

test("demo source validates take-home, handles no-fill, and keeps reward types distinct", async () => {
  const source = await demoSource;

  assert.match(source, /Number\.isFinite\(minimumRewardValue\)/);
  assert.match(source, /type="number" min="0"/);
  assert.match(source, /disabled=\{!minimumRewardIsValid\}/);
  assert.match(source, /stage === "no-fill"/);
  assert.match(source, /No sponsored session created/);
  assert.match(source, /winner\.rewardType === "cash"/);
  assert.match(source, /Placement gross/);
  assert.match(source, /Ad Daddy fee/);
  assert.match(source, /Guaranteed take-home/);
});

test("demo source exposes restart, test-money, and illustrative-brand disclosures", async () => {
  const source = await demoSource;

  assert.match(source, /Start over/);
  assert.match(source, /No real money/);
  assert.match(source, /fictional demo data—not endorsements or partnerships/);
});

test("demo makes the placement guarantee, action ladder, and profile-frequency incentives explicit", async () => {
  const [source, market] = await Promise.all([demoSource, marketSource]);

  for (const expected of [
    "Earned on placement",
    "Potential total",
    "More approved context",
    "placement slots / month",
    "Optional actions",
  ]) assert.match(source, new RegExp(expected, "i"), `missing payout explanation: ${expected}`);

  for (const expected of [
    "Similar profiles ask",
    "Use suggested minimum",
  ]) assert.match(source, new RegExp(expected, "i"), `missing frequency or pricing guidance: ${expected}`);

  for (const action of ["Open setup brief", "Activate product", "Become a paid customer"]) {
    assert.match(market, new RegExp(action, "i"), `missing demo action: ${action}`);
  }
});
