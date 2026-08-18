import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryDeviceKeyProvider, ReceiverSetupService, createDeviceProofHeader } from "../../packages/cli/dist/index.js";
import { createReceiverProfileHandler } from "../../app/api/v1/receiver/profile/route.ts";
import { D1OpportunityCandidateRepository } from "../../lib/marketplace/d1-opportunity-candidates.ts";
import { D1ReceiverSettingsStore } from "../../lib/marketplace/receiver-settings.ts";
import { D1ReceiverAdvertiserBlockRepository } from "../../lib/marketplace/blocking.ts";
import { D1SponsorshipClaimRepository } from "../../lib/marketplace/sponsorship-runtime.ts";
import { createMigratedD1 } from "../helpers/sqlite-d1.ts";

const NOW = new Date("2026-08-15T20:00:00.000Z");

test("receiver consent and published snapshot survive runtime reconstruction and revoke immediately", async (t) => {
  const migrated = createMigratedD1();
  t.after(migrated.close);
  const db = migrated.database;
  await seedInstallation(db, "receiver_1", "install_1");
  const first = new D1ReceiverSettingsStore(db);
  const setup = new ReceiverSetupService(first);
  const draft = await setup.prepare(receiverSetup("receiver_1", "install_1"));
  assert.equal(draft.status, "draft");
  const active = await setup.activate({ installationId: "install_1", disclosureAccepted: true, termsAccepted: true, privacyAccepted: true });
  assert.equal(active.consentVersion, 1);

  const restarted = new D1ReceiverSettingsStore(db);
  assert.deepEqual((await restarted.get("install_1"))?.publishedFields, {
    coarseLocation: "US Northeast", privateRepoTechStacks: [["Postgres"]], projectNames: ["Inbox Agent"],
    acceptedRewardTypes: ["credits"], minimumTakeHomeMinor: 100,
  });
  const snapshot = await db.prepare(`SELECT rp.status, rp.current_consent_version AS consentVersion,
    rcv.status AS consentStatus, ps.revoked_at AS revokedAt FROM receiver_profiles rp
    JOIN receiver_consent_versions rcv ON rcv.receiver_profile_id = rp.id AND rcv.version = rp.current_consent_version
    JOIN profile_snapshots ps ON ps.receiver_profile_id = rp.id AND ps.consent_version = rp.current_consent_version
    WHERE rp.installation_id = ?`).bind("install_1").first<Record<string, unknown>>();
  assert.deepEqual({ ...snapshot }, { status: "active", consentVersion: 1, consentStatus: "active", revokedAt: null });

  const revoked = await new ReceiverSetupService(restarted).revoke("install_1");
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.consentVersion, 2);
  assert.equal((await db.prepare("SELECT status FROM receiver_profiles WHERE installation_id = ?").bind("install_1").first<{ status: string }>())?.status, "revoked");
  assert.ok((await db.prepare("SELECT revoked_at AS revokedAt FROM profile_snapshots WHERE receiver_profile_id = ?").bind("receiver:install_1").first<{ revokedAt: string }>())?.revokedAt);
});

test("durable consent is exactly-next and snapshots are immutable; only a human session can reactivate", async (t) => {
  const migrated = createMigratedD1();
  t.after(migrated.close);
  const db = migrated.database;
  await seedInstallation(db, "receiver_chain", "install_chain");
  const humanStore = new D1ReceiverSettingsStore(db, { authority: "human_session" });
  const setup = new ReceiverSetupService(humanStore);
  await setup.prepare(receiverSetup("receiver_chain", "install_chain"));
  const active = await setup.activate({ installationId: "install_chain", disclosureAccepted: true, termsAccepted: true, privacyAccepted: true });

  await assert.rejects(
    humanStore.put({ ...active, publishedFields: { ...active.publishedFields, coarseLocation: "US West" } }),
    /immutable.*snapshot/i,
  );
  await assert.rejects(humanStore.put({ ...active, consentVersion: 3 }), /exactly one/i);

  const paused = await setup.pause("install_chain");
  assert.equal(paused.consentVersion, 2);
  const reactivated = { ...paused, status: "active" as const, consentVersion: 3 };
  await assert.rejects(
    new D1ReceiverSettingsStore(db, { authority: "device" }).put(reactivated),
    /fresh human authority/i,
  );
  await assert.doesNotReject(humanStore.put(reactivated));
  assert.equal((await humanStore.get("install_chain"))?.status, "active");
  const snapshots = await db.prepare(`SELECT consent_version AS consentVersion, published_fields_json AS fields,
    revoked_at AS revokedAt FROM profile_snapshots WHERE receiver_profile_id = ? ORDER BY consent_version`)
    .bind("receiver:install_chain").all<Record<string, unknown>>();
  assert.equal(snapshots.results.length, 2);
  assert.ok(snapshots.results[0]?.revokedAt);
  assert.equal(snapshots.results[1]?.revokedAt, null);
});

test("D1 candidate discovery returns consented matches and a durable receiver block removes future inventory", async (t) => {
  const migrated = createMigratedD1();
  t.after(migrated.close);
  const db = migrated.database;
  await seedInstallation(db, "receiver_2", "install_2");
  const setup = new ReceiverSetupService(new D1ReceiverSettingsStore(db));
  await setup.prepare(receiverSetup("receiver_2", "install_2"));
  await setup.activate({ installationId: "install_2", disclosureAccepted: true, termsAccepted: true, privacyAccepted: true });
  await db.prepare("INSERT INTO human_accounts (id, status) VALUES ('advertiser_1', 'active')").run();
  await db.prepare(`INSERT INTO advertiser_brands
    (id, account_id, name, verified_domain, ownership_status, verified_at)
    VALUES ('brand_1', 'advertiser_1', 'Neon', 'neon.tech', 'verified', ?)`).bind(NOW.toISOString()).run();
  await db.prepare(`INSERT INTO campaigns
    (id, account_id, brand_id, status, advertiser_terms_version, destination_url, schedule_starts_at, schedule_ends_at,
     audience_json, offer_json, creative_json, conversion_terms, maximum_spend_minor, maximum_bid_minor, daily_cap_minor,
     funded_minor, spent_minor, refunded_minor, terms_accepted_at, activated_at)
    VALUES ('campaign_1', 'advertiser_1', 'brand_1', 'active', 'advertiser-terms/1', 'https://neon.tech', ?, ?, ?, '{}', '{}',
      'signup', 1000, 100, 500, 1000, 0, 0, ?, ?)`)
    .bind(new Date(NOW.getTime() - 60_000).toISOString(), new Date(NOW.getTime() + 3_600_000).toISOString(), JSON.stringify({
      categories: ["database"], regions: ["US Northeast"], hosts: ["codex"], rewardTypes: ["credits"],
    }), NOW.toISOString(), NOW.toISOString()).run();
  await db.prepare(`INSERT INTO opportunities
    (id, rotating_opportunity_id, receiver_profile_id, installation_id, consent_version, state, opened_at, expires_at)
    VALUES ('opportunity_1', 'rotation_1', 'receiver:install_2', 'install_2', 1, 'bidding', ?, ?)`)
    .bind(NOW.toISOString(), new Date(NOW.getTime() + 300_000).toISOString()).run();

  const candidates = new D1OpportunityCandidateRepository(db);
  const [candidate] = await candidates.list("campaign_1", NOW);
  assert.equal(candidate.rotatingOpportunityId, "opportunity_1");
  assert.equal(JSON.stringify(candidate).includes("rotation_1"), false, "private coalescing keys never leave candidate storage");
  assert.equal(candidate.category, "database");
  assert.equal(candidate.region, "US Northeast");
  assert.equal(candidate.host, "codex");
  assert.deepEqual(candidate.acceptedRewardTypes, ["credits"]);

  for (let index = 2; index <= 121; index += 1) {
    const suffix = String(index).padStart(3, "0");
    await db.prepare(`INSERT INTO opportunities
      (id, rotating_opportunity_id, receiver_profile_id, installation_id, consent_version, state, opened_at, expires_at)
      VALUES (?, ?, 'receiver:install_2', 'install_2', 1, 'bidding', ?, ?)`).bind(
        `opp_opaque_${suffix}`, `private_coalesce_${suffix}`, NOW.toISOString(), new Date(NOW.getTime() + 300_000).toISOString(),
      ).run();
  }
  const pagedCandidates = await candidates.list("campaign_1", NOW);
  assert.equal(pagedCandidates.length, 121, "eligible rows after the first SQL page remain discoverable");
  assert.ok(pagedCandidates.some((item) => item.rotatingOpportunityId === "opp_opaque_121"));

  const blocks = new D1ReceiverAdvertiserBlockRepository(db);
  await blocks.block("receiver_2", "brand_1");
  assert.equal(await blocks.isBlocked("receiver_2", "brand_1"), true);
  assert.deepEqual(await new D1OpportunityCandidateRepository(db).list("campaign_1", NOW), []);
});

test("D1 pull opportunities expose random IDs while private digests coalesce retries", async (t) => {
  const migrated = createMigratedD1();
  t.after(migrated.close);
  const db = migrated.database;
  await seedInstallation(db, "receiver_opaque", "install_secret_name");
  const setup = new ReceiverSetupService(new D1ReceiverSettingsStore(db));
  await setup.prepare(receiverSetup("receiver_opaque", "install_secret_name"));
  await setup.activate({ installationId: "install_secret_name", disclosureAccepted: true, termsAccepted: true, privacyAccepted: true });
  const opened: unknown[] = [];
  const repository = new D1SponsorshipClaimRepository(db, {
    auctionGateway: {
      async ownsOpportunity() { return false; }, async ownsAuction() { return false; },
      async open(definition) { opened.push(definition); return Response.json({}); },
      async read() { return Response.json({}); }, async bid() { return Response.json({}); },
    },
    keyId: "unused", privateKeyPem: "unused", clock: () => NOW,
  });
  const receiver = await repository.getReceiver("install_secret_name");
  assert.ok(receiver);
  const first = await repository.openOrGetOpportunity(receiver, NOW);
  const retry = await repository.openOrGetOpportunity(receiver, NOW);
  assert.equal(retry.opportunityId, first.opportunityId);
  assert.match(first.opportunityId, /^opp_[0-9a-f-]{36}$/i);
  assert.equal(first.opportunityId.includes("install_secret_name"), false);
  assert.equal(first.opportunityId.includes(":1:"), false);
  const row = await db.prepare("SELECT rotating_opportunity_id AS coalescingKey FROM opportunities WHERE id = ?")
    .bind(first.opportunityId).first<{ coalescingKey: string }>();
  assert.match(row?.coalescingKey ?? "", /^private_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(row?.coalescingKey, first.opportunityId);
  assert.equal(opened.length, 2, "idempotent open is forwarded with the same opaque auction identity");
});

test("an enrolled receiver device can publish consent, while unsigned profile writes fail closed", async (t) => {
  const migrated = createMigratedD1();
  t.after(migrated.close);
  const db = migrated.database;
  const provider = new InMemoryDeviceKeyProvider();
  const credential = await provider.createOrLoad("install_signed");
  await seedInstallation(db, "receiver_signed", "install_signed");
  await db.prepare(`INSERT INTO installation_device_keys
    (installation_id, key_version, algorithm, public_jwk_json, key_thumbprint, status, enrolled_at)
    VALUES ('install_signed', 1, 'ES256', ?, ?, 'active', ?)`)
    .bind(JSON.stringify(credential.publicJwk), credential.keyThumbprint, NOW.toISOString()).run();
  const body = JSON.stringify({
    status: "active", publishedFields: { coarseLocation: "US Northeast", acceptedRewardTypes: ["credits"] },
    cadenceMinutes: 1, termsVersion: "terms/v1", privacyVersion: "privacy/v1",
    hostDisclosure: { host: "Codex", consumesTurn: true },
  });
  const target = "/api/v1/receiver/profile";
  const proof = await createDeviceProofHeader({
    provider, credentialReference: credential.credentialReference, installationId: "install_signed", consentVersion: 1,
    keyThumbprint: credential.keyThumbprint, environment: "test", method: "PUT", target, body, now: NOW,
  });
  const handler = createReceiverProfileHandler({ db, environment: "test", clock: () => NOW });
  const unsigned = await handler(new Request(`https://ad.daddy${target}`, { method: "PUT", headers: { "content-type": "application/json" }, body }));
  assert.equal(unsigned.status, 403);
  const published = await handler(new Request(`https://ad.daddy${target}`, {
    method: "PUT", headers: { "content-type": "application/json", "x-ad-daddy-device-proof": proof }, body,
  }));
  assert.equal(published.status, 200);
  assert.equal((await new D1ReceiverSettingsStore(db).get("install_signed"))?.status, "active");
  const getProof = await createDeviceProofHeader({
    provider, credentialReference: credential.credentialReference, installationId: "install_signed", consentVersion: 1,
    keyThumbprint: credential.keyThumbprint, environment: "test", method: "GET", target, body: "", now: NOW,
  });
  const synced = await handler(new Request(`https://ad.daddy${target}`, { method: "GET", headers: { "x-ad-daddy-device-proof": getProof } }));
  assert.equal(synced.status, 200);
  assert.deepEqual((await synced.json() as { publishedFields: unknown }).publishedFields, { coarseLocation: "US Northeast", acceptedRewardTypes: ["credits"] });

  const humanStore = new D1ReceiverSettingsStore(db, { authority: "human_session" });
  await new ReceiverSetupService(humanStore).pause("install_signed");
  const reactivationProof = await createDeviceProofHeader({
    provider, credentialReference: credential.credentialReference, installationId: "install_signed", consentVersion: 3,
    keyThumbprint: credential.keyThumbprint, environment: "test", method: "PUT", target, body, now: NOW,
  });
  const deviceReactivation = await handler(new Request(`https://ad.daddy${target}`, {
    method: "PUT", headers: { "content-type": "application/json", "x-ad-daddy-device-proof": reactivationProof }, body,
  }));
  assert.equal(deviceReactivation.status, 403);
  assert.match((await deviceReactivation.json() as { message: string }).message, /human authority/i);
});

function receiverSetup(accountId: string, installationId: string) {
  return {
    installationId, accountId, role: "receiver" as const,
    profile: {
      values: {
        coarseLocation: "US Northeast", privateRepoTechStacks: [["Postgres"]], projectNames: ["Inbox Agent"],
        acceptedRewardTypes: ["credits"] as const, minimumTakeHomeMinor: 100,
      },
      enabled: { coarseLocation: true, privateRepoTechStacks: true, projectNames: true, acceptedRewardTypes: true, minimumTakeHomeMinor: true },
    },
    cadenceMinutes: 30, termsVersion: "terms/v1", privacyVersion: "privacy/v1",
    hostDisclosure: { host: "Codex", consumesTurn: true as const },
  };
}

async function seedInstallation(db: D1Database, accountId: string, installationId: string) {
  await db.prepare("INSERT INTO human_accounts (id, status) VALUES (?, 'active')").bind(accountId).run();
  await db.prepare(`INSERT INTO installations
    (id, account_id, public_key, key_version, host_kind, status, created_at)
    VALUES (?, ?, '{}', 1, 'codex', 'active', ?)`).bind(installationId, accountId, NOW.toISOString()).run();
}
