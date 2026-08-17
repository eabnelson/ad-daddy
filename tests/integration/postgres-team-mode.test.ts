import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { newDb } from "pg-mem";

import { createTeamModeHandler } from "../../app/api/team/route.ts";
import { PostgresTeamModeStore, type TeamPostgresQuery } from "../../lib/team-mode/postgres-store.ts";
import { TeamModeService } from "../../lib/team-mode/service.ts";

test("hosted Postgres team state survives a new service instance", async () => {
  const database = newDb({ noAstCoverageCheck: true });
  const adapter = database.adapters.createPg();
  const client = new adapter.Client();
  await client.connect();
  const query: TeamPostgresQuery = async <T extends Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) => {
    return (await client.query(text, [...parameters])).rows as T[];
  };
  const signing = keys();
  const first = new TeamModeService(new PostgresTeamModeStore(query), signing);
  const advertiser = await first.join({ displayName: "Maya", tags: ["postgres"], receivesAds: true });
  const receiver = await first.join({ displayName: "Theo", tags: ["typescript", "postgres"], receivesAds: true });
  await first.createAd({
    memberKey: advertiser.memberKey,
    title: "Schema preview",
    body: "A useful preview for Postgres builders.",
    targetTags: ["postgres"],
    points: 75,
  });

  const matches = await first.browseAds(receiver.memberKey);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].matchedTags, ["postgres"]);
  const claimed = await first.poll({ memberKey: receiver.memberKey, installationId: receiver.member.installationId });
  if (!("placement" in claimed) || !claimed.placement) assert.fail("Expected a hosted placement");
  await first.acknowledge({ memberKey: receiver.memberKey, deliveryId: claimed.placement.payload.placementId });

  const restarted = new TeamModeService(new PostgresTeamModeStore(query), signing);
  const status = await restarted.status(receiver.memberKey);
  assert.equal(status.members.length, 2);
  assert.equal(status.ads.length, 1);
  assert.equal(status.score.pointsReceived, 75);
  assert.equal((await restarted.browseAds(receiver.memberKey)).length, 0);
  await client.end();
});

test("hosted initialization retries after a transient failure and reports it as unavailable", async () => {
  const database = newDb({ noAstCoverageCheck: true });
  const adapter = database.adapters.createPg();
  const client = new adapter.Client();
  await client.connect();
  let failOnce = true;
  const query: TeamPostgresQuery = async <T extends Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) => {
    if (failOnce) { failOnce = false; throw new Error("temporary database outage"); }
    return (await client.query(text, [...parameters])).rows as T[];
  };
  const handler = createTeamModeHandler({
    service: new TeamModeService(new PostgresTeamModeStore(query), keys()),
    inviteCode: "test-invite-code",
    memberTokenSecret: "week-one-member-token-secret",
    environment: "hosted_test",
  });
  const request = () => new Request("https://ads.example.com/api/team", {
    method: "POST",
    headers: { authorization: "Bearer test-invite-code", "content-type": "application/json" },
    body: JSON.stringify({ action: "join", displayName: "Retry", tags: [], receivesAds: true }),
  });
  const failed = await handler(request());
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "team_mode_unavailable" });
  assert.equal((await handler(request())).status, 201);
  await client.end();
});

test("hosted acknowledgement uses the same not-found contract as local storage", async () => {
  const database = newDb({ noAstCoverageCheck: true });
  const adapter = database.adapters.createPg();
  const client = new adapter.Client();
  await client.connect();
  const query: TeamPostgresQuery = async <T extends Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) =>
    (await client.query(text, [...parameters])).rows as T[];
  const service = new TeamModeService(new PostgresTeamModeStore(query), keys());
  const joined = await service.join({ displayName: "Receiver", tags: [], receivesAds: true });
  await assert.rejects(() => service.acknowledge({ memberKey: joined.memberKey, deliveryId: "missing" }), /Unknown team delivery/);
  await client.end();
});

test("hosted proof caps ads per member before bounded discovery can hide newer ads", async () => {
  const database = newDb({ noAstCoverageCheck: true });
  const adapter = database.adapters.createPg();
  const client = new adapter.Client();
  await client.connect();
  const query: TeamPostgresQuery = async <T extends Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) =>
    (await client.query(text, [...parameters])).rows as T[];
  const service = new TeamModeService(new PostgresTeamModeStore(query), keys());
  const sender = await service.join({ displayName: "Bounded sender", tags: [], receivesAds: true });
  for (let index = 0; index < 20; index += 1) {
    await service.createAd({
      memberKey: sender.memberKey,
      title: `Ad ${index + 1}`,
      body: "A bounded private-team message.",
      targetTags: [],
      points: index,
    });
  }
  await assert.rejects(() => service.createAd({
    memberKey: sender.memberKey,
    title: "Ad 21",
    body: "This exceeds the explicit proof-network limit.",
    targetTags: [],
    points: 21,
  }), /at most 20 ads/);
  assert.equal((await service.status(sender.memberKey)).ads.length, 20);
  await client.end();
});

test("hosted duplicate writes do not leak member or network capacity", async () => {
  const database = newDb({ noAstCoverageCheck: true });
  const adapter = database.adapters.createPg();
  const client = new adapter.Client();
  await client.connect();
  const query: TeamPostgresQuery = async <T extends Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) =>
    (await client.query(text, [...parameters])).rows as T[];
  const store = new PostgresTeamModeStore(query);
  const service = new TeamModeService(store, keys());
  const sender = await service.join({ displayName: "Atomic sender", tags: [], receivesAds: true });
  const ad = await service.createAd({
    memberKey: sender.memberKey,
    title: "One ad",
    body: "A single durable team message.",
    targetTags: [],
    points: 10,
  });

  await assert.rejects(() => store.createAd(ad), /could not be created/);
  const capacity = await query<{ scope: string; used: number }>(
    "SELECT scope, used FROM team_mode_v2_capacity ORDER BY scope",
  );
  assert.deepEqual(capacity, [{ scope: "ads", used: 1 }, { scope: "members", used: 1 }]);
  assert.deepEqual(await query("SELECT member_id, used FROM team_mode_v2_member_ad_counts"), [
    { member_id: sender.member.id, used: 1 },
  ]);
  await client.end();
});

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    keyId: "team_postgres_test",
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
