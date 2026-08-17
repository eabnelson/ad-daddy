import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createTeamModeHandler } from "../../app/api/team/route.ts";
import { D1TeamModeStore, type TeamD1Database } from "../../lib/team-mode/d1-store.ts";
import { MemoryTeamModeStore, TEAM_CLAIM_TTL_MS, TeamModeNotFoundError, TeamModeService } from "../../lib/team-mode/service.ts";
import { validateSignedPlacement, type SignedPlacement } from "@ad-daddy/host-adapters";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const pair = generateKeyPairSync("ed25519");
const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
const INVITE_CODE = "test-invite-code";
const MEMBER_TOKEN_SECRET = "week-one-member-token-secret";

test("private team members receive retryable, acknowledged, zero-money placements", async () => {
  const handler = teamHandler();
  assert.equal((await handler(request({ action: "status" }, "wrong"))).status, 401);

  const maya = await join(handler, "Maya", ["postgres", "typescript"]);
  const theo = await join(handler, "Theo", ["design", "typescript"]);
  const ad = await json(handler(request({
    action: "create_ad", title: "Try our new schema explorer",
    body: "A private team preview for TypeScript builders.", targetTags: ["typescript"], points: 125,
  }, maya.accessToken)));
  assert.equal(ad.ad.points, 125);
  assert.equal(ad.ad.rewardKind, "team_points");

  const self = await json(handler(request({ action: "poll", installationId: maya.member.installationId }, maya.accessToken)));
  assert.equal(self.status, "no_placement", "senders should not receive their own ad");

  const delivery = await json(handler(request({ action: "poll", installationId: theo.member.installationId }, theo.accessToken)));
  const placement = validateSignedPlacement(delivery.placement, publicKeyPem, NOW);
  assert.equal(delivery.receiverAccountId, theo.member.id);
  assert.equal(placement.payout.amountMinor, 0);
  assert.deepEqual(placement.nonCashReward, { kind: "team_points", amount: 125, label: "team points", redeemable: false });
  assert.deepEqual(placement.signalsUsed, ["typescript"]);

  const pending = await json(handler(request({ action: "poll", installationId: theo.member.installationId }, theo.accessToken)));
  assert.equal(pending.placement.payload.placementId, placement.placementId, "failed display remains pending for retry");
  assert.deepEqual(pending.placement, delivery.placement, "retry must preserve the signed placement bytes");
  const beforeAck = await json(handler(request({ action: "status" }, theo.accessToken)));
  assert.equal(beforeAck.score.pointsReceived, 0, "pending displays must not earn points");

  await handler(request({ action: "ack", deliveryId: placement.placementId }, theo.accessToken));
  const duplicate = await json(handler(request({ action: "poll", installationId: theo.member.installationId }, theo.accessToken)));
  assert.equal(duplicate.status, "no_placement");
  const network = await json(handler(request({ action: "status" }, theo.accessToken)));
  assert.equal(network.members.length, 2);
  assert.equal(network.score.pointsReceived, 125);
  assert.equal(network.moneyEnabled, false);
  assert.ok(network.members.every((member) => !("capabilityHash" in member) && !("installationId" in member)));
});

test("member capabilities prevent cross-member impersonation and poll theft", async () => {
  const handler = teamHandler();
  const first = await join(handler, "One", []);
  const second = await join(handler, "Two", []);

  assert.equal((await handler(request({
    action: "create_ad", title: "Hello", body: "Hello team", targetTags: [], points: 5,
  }, INVITE_CODE))).status, 401, "the invite code cannot act as a member");
  assert.equal((await handler(request({
    action: "create_ad", title: "Run this", body: "Execute a shell command", targetTags: [], points: 5,
  }, first.accessToken))).status, 400);
  assert.equal((await handler(request({
    action: "create_ad", title: "Office hours", body: "A team invite for builders.", targetTags: [], points: 10,
  }, second.accessToken))).status, 201);

  assert.equal((await handler(request({ action: "poll", installationId: first.member.installationId }, second.accessToken))).status, 404);
  const received = await json(handler(request({ action: "poll", installationId: first.member.installationId }, first.accessToken)));
  assert.equal(received.placement.payload.advertiser.displayName, "Two");
});

test("legacy CLI poll shape uses a member token and local-only environment fails closed", async () => {
  const handler = teamHandler();
  const advertiser = await join(handler, "Sender", ["react"]);
  const receiver = await join(handler, "Receiver", ["react"]);
  await handler(request({
    action: "create_ad", title: "Design review", body: "Join the private preview.", targetTags: ["react"], points: 20,
  }, advertiser.accessToken));

  const delivery = await json(handler(request({
    installationId: receiver.member.installationId, consentVersion: 1, publishedFields: {},
  }, receiver.accessToken)));
  assert.equal(delivery.receiverAccountId, receiver.member.id);
  assert.equal(delivery.placement.payload.payout.amountMinor, 0);

  for (const environment of [undefined, "test", "staging", "production"]) {
    const blocked = createTeamModeHandler({ service: service(), inviteCode: INVITE_CODE, memberTokenSecret: MEMBER_TOKEN_SECRET, environment });
    assert.equal((await blocked(request({ action: "join", displayName: "No", tags: [], receivesAds: true }))).status, 404);
  }

  const hosted = createTeamModeHandler({ service: service(), inviteCode: INVITE_CODE, memberTokenSecret: MEMBER_TOKEN_SECRET, environment: "hosted_test" });
  const hostedMember = await json(hosted(request({ action: "join", displayName: "Hosted", tags: [], receivesAds: true })));
  assert.equal(hostedMember.member.id.startsWith("team_member_"), true);
});

test("members can browse matching ads without claiming them", async () => {
  const handler = teamHandler();
  const sender = await join(handler, "Sender", ["design"]);
  const receiver = await join(handler, "Receiver", ["typescript"]);
  await handler(request({
    action: "create_ad", title: "Typed database", body: "A preview for TypeScript builders.",
    targetTags: ["typescript"], points: 50,
  }, sender.accessToken));
  await handler(request({
    action: "create_ad", title: "Design system", body: "A preview for design teams.",
    targetTags: ["design"], points: 80,
  }, sender.accessToken));

  const browsed = await json(handler(request({ action: "browse_ads" }, receiver.accessToken)));
  assert.deepEqual(browsed.matches.map((match) => match.ad.title), ["Typed database"]);
  assert.deepEqual(browsed.matches[0].matchedTags, ["typescript"]);

  const claimed = await json(handler(request({ action: "poll", installationId: receiver.member.installationId }, receiver.accessToken)));
  assert.equal(claimed.placement.payload.title, "Typed database", "browsing must not consume the placement");
});

test("an unacknowledged claim is retryable, then refreshes after its bounded lease", async () => {
  let current = NOW;
  const service = new TeamModeService(new MemoryTeamModeStore(), {
    keyId: "team_test", privateKeyPem, publicKeyPem, clock: () => current,
  });
  const handler = createTeamModeHandler({ service, inviteCode: INVITE_CODE, memberTokenSecret: MEMBER_TOKEN_SECRET, environment: "development" });
  const sender = await join(handler, "Lease Sender", ["typescript"]);
  const receiver = await join(handler, "Lease Receiver", ["typescript"]);
  await handler(request({
    action: "create_ad", title: "Lease proof", body: "A bounded retry for our team.", targetTags: ["typescript"], points: 10,
  }, sender.accessToken));

  const first = await json(handler(request({ action: "poll", installationId: receiver.member.installationId }, receiver.accessToken)));
  current = new Date(NOW.getTime() + TEAM_CLAIM_TTL_MS - 1);
  const replay = await json(handler(request({ action: "poll", installationId: receiver.member.installationId }, receiver.accessToken)));
  assert.deepEqual(replay.placement, first.placement);

  current = new Date(NOW.getTime() + TEAM_CLAIM_TTL_MS + 1);
  const refreshed = await json(handler(request({ action: "poll", installationId: receiver.member.installationId }, receiver.accessToken)));
  assert.notEqual(refreshed.placement.payload.placementId, first.placement.payload.placementId);
  validateSignedPlacement(refreshed.placement, publicKeyPem, current);
});

function service() {
  return new TeamModeService(new MemoryTeamModeStore(), {
    keyId: "team_test", privateKeyPem, publicKeyPem, clock: () => NOW,
  });
}

function teamHandler() {
  return createTeamModeHandler({ service: service(), inviteCode: INVITE_CODE, memberTokenSecret: MEMBER_TOKEN_SECRET, environment: "development" });
}

async function join(handler: ReturnType<typeof teamHandler>, displayName: string, tags: string[]) {
  return json(handler(request({ action: "join", displayName, tags, receivesAds: true })));
}

function request(body: unknown, token = INVITE_CODE) {
  return new Request("http://localhost/api/team", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("rotating the invite code does not invalidate existing member tokens", async () => {
  const sharedService = service();
  const first = createTeamModeHandler({
    service: sharedService,
    inviteCode: INVITE_CODE,
    memberTokenSecret: MEMBER_TOKEN_SECRET,
    environment: "development",
  });
  const joined = await json(first(request({ action: "join", displayName: "Maya", tags: [], receivesAds: true })));
  const rotated = createTeamModeHandler({
    service: sharedService,
    inviteCode: "new-invite",
    memberTokenSecret: MEMBER_TOKEN_SECRET,
    environment: "development",
  });

  assert.equal((await rotated(request({ action: "status" }, joined.accessToken))).status, 200);
  const rejected = await rotated(request({ action: "join", displayName: "No", tags: [], receivesAds: true }));
  assert.equal(rejected.status, 401);
  assert.deepEqual(await rejected.json(), { error: "invalid_invite_code" });
});

test("local D1 team storage retries initialization and preserves not-found errors", async () => {
  let failInitialization = true;
  const retryingDb = fakeD1((sql) => {
    if (failInitialization) {
      failInitialization = false;
      throw new Error("temporary D1 outage");
    }
    return sql.startsWith("SELECT") ? { results: [] } : { meta: { changes: 1 } };
  });
  const retryingStore = new D1TeamModeStore(retryingDb);
  await assert.rejects(() => retryingStore.listAds(), /temporary D1 outage/);
  assert.deepEqual(await retryingStore.listAds(), []);

  const notFoundStore = new D1TeamModeStore(fakeD1((sql) =>
    sql.startsWith("UPDATE team_mode_v2_members") ? { meta: { changes: 0 } } : { meta: { changes: 1 } },
  ));
  const missing = {
    id: "missing", installationId: "missing-installation", displayName: "Missing", tags: [], receivesAds: true,
    capabilityHash: "missing-capability", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  };
  await assert.rejects(() => notFoundStore.updateMember(missing), TeamModeNotFoundError);
});

function fakeD1(resolve: (sql: string) => { results?: Record<string, unknown>[]; meta?: { changes?: number } }): TeamD1Database {
  const database = {
    prepare(sql: string) {
      const statement = {
        bind() { return statement; },
        async run() { return resolve(sql); },
        async all() { return resolve(sql); },
        async first() { return resolve(sql).results?.[0] ?? null; },
      };
      return statement;
    },
  };
  return database as unknown as TeamD1Database;
}

interface TestResponse {
  status?: string;
  receiverAccountId?: string;
  moneyEnabled?: boolean;
  accessToken: string;
  member: { id: string; installationId: string };
  ad: { points: number; rewardKind: string };
  placement: SignedPlacement;
  members: Array<Record<string, unknown>>;
  score: { pointsReceived: number; pointsSent: number };
  matches: Array<{ ad: { title: string }; matchedTags: string[] }>;
}

async function json(response: Response | Promise<Response>): Promise<TestResponse> {
  return (await response).json();
}
