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
    recipientMemberIds: [receiver.member.id],
  });

  const matches = await first.browseAds(receiver.memberKey);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].queuedForYou, true);
  const claimed = await first.poll({ memberKey: receiver.memberKey, installationId: receiver.member.installationId });
  if (!("placement" in claimed) || !claimed.placement) assert.fail("Expected a hosted placement");
  await first.acknowledge({ memberKey: receiver.memberKey, deliveryId: claimed.placement.payload.placementId });

  const restarted = new TeamModeService(new PostgresTeamModeStore(query), signing);
  const status = await restarted.status(receiver.memberKey);
  assert.equal(status.members.length, 2);
  assert.equal(status.ads.length, 1);
  assert.equal(status.score.pointsReceived, 1);
  assert.equal(status.economy.balance, 51);
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
  const receiver = await service.join({ displayName: "Bounded receiver", tags: [], receivesAds: true });
  for (let index = 0; index < 20; index += 1) {
    await service.createAd({
      memberKey: sender.memberKey,
      title: `Ad ${index + 1}`,
      body: "A bounded private-team message.",
      recipientMemberIds: [receiver.member.id],
    });
  }
  assert.equal((await service.status(sender.memberKey)).economy.balance, 30);
  await assert.rejects(() => service.createAd({
    memberKey: sender.memberKey,
    title: "Ad 21",
    body: "This exceeds the explicit proof-network limit.",
    recipientMemberIds: [receiver.member.id],
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
  const receiver = await service.join({ displayName: "Atomic receiver", tags: [], receivesAds: true });
  const created = await service.createAd({
    memberKey: sender.memberKey,
    title: "One ad",
    body: "A single durable team message.",
    recipientMemberIds: [receiver.member.id],
  });

  await assert.rejects(() => store.createAd(created.ad, [{
    adId: created.ad.id, receiverMemberId: receiver.member.id, queuedAt: created.ad.createdAt,
  }]), /could not be created/);
  assert.equal((await service.status(sender.memberKey)).economy.balance, 49, "a duplicate write must not spend another point");
  const capacity = await query<{ scope: string; used: number }>(
    "SELECT scope, used FROM team_mode_v2_capacity ORDER BY scope",
  );
  assert.deepEqual(capacity, [{ scope: "ads", used: 1 }, { scope: "members", used: 2 }]);
  const counts = await query<{ member_id: string; used: number }>("SELECT member_id, used FROM team_mode_v2_member_ad_counts");
  assert.deepEqual(Object.fromEntries(counts.map((row) => [row.member_id, row.used])), {
    [sender.member.id]: 1,
    [receiver.member.id]: 0,
  });
  await client.end();
});

test("hosted point charging allows only one concurrent send when one can be afforded", async () => {
  const database = newDb({ noAstCoverageCheck: true });
  const adapter = database.adapters.createPg();
  const firstClient = new adapter.Client();
  const secondClient = new adapter.Client();
  await Promise.all([firstClient.connect(), secondClient.connect()]);
  const firstQuery: TeamPostgresQuery = async <T extends Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) =>
    (await firstClient.query(text, [...parameters])).rows as T[];
  const secondQuery: TeamPostgresQuery = async <T extends Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) =>
    (await secondClient.query(text, [...parameters])).rows as T[];
  const signing = keys();
  const first = new TeamModeService(new PostgresTeamModeStore(firstQuery), signing);
  const sender = await first.join({ displayName: "Concurrent sender", tags: [], receivesAds: true });
  const receivers = await Promise.all(["One", "Two", "Three"].map((displayName) =>
    first.join({ displayName, tags: [], receivesAds: true })));
  const allRecipients = receivers.map((receiver) => receiver.member.id);
  for (let index = 0; index < 16; index += 1) {
    await first.createAd({
      memberKey: sender.memberKey,
      title: `Balance setup ${index + 1}`,
      body: "A private team test message.",
      recipientMemberIds: allRecipients,
    });
  }

  const second = new TeamModeService(new PostgresTeamModeStore(secondQuery), signing);
  const results = await Promise.allSettled([
    first.createAd({
      memberKey: sender.memberKey,
      title: "Concurrent send A",
      body: "Only one concurrent send can spend the final points.",
      recipientMemberIds: allRecipients.slice(0, 2),
    }),
    second.createAd({
      memberKey: sender.memberKey,
      title: "Concurrent send B",
      body: "Only one concurrent send can spend the final points.",
      recipientMemberIds: allRecipients.slice(1),
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await first.status(sender.memberKey)).economy.balance, 0);
  await Promise.all([firstClient.end(), secondClient.end()]);
});

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    keyId: "team_postgres_test",
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
