import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ReceiverSetupService, selectSetupRole } from "../../packages/cli/dist/commands/setup.js";
import { JsonLocalStore, MemoryLocalStore } from "../../packages/cli/dist/local-store.js";

const base = {
  installationId: "installation-1",
  accountId: "account-1",
  role: "receiver" as const,
  profile: {
    values: {
      coarseLocation: "US Northeast",
      projectDescriptions: ["Building an agent inbox"],
      acceptedRewardTypes: ["stablecoin", "credits", "discount"] as const,
      minimumTakeHomeMinor: 250,
    },
    enabled: {
      coarseLocation: false,
      projectDescriptions: true,
      acceptedRewardTypes: true,
      minimumTakeHomeMinor: true,
    },
  },
  cadenceMinutes: 60,
  termsVersion: "2026-08-15",
  privacyVersion: "2026-08-15",
  hostDisclosure: { host: "Codex", displayModel: "gpt-5.6-luna", consumesTurn: true as const },
};

test("role-first setup previews exact snapshot and requires disclosure acceptance", async () => {
  assert.deepEqual(selectSetupRole("receiver"), { role: "receiver", configureReceiver: true, configureAdvertiser: false });
  assert.deepEqual(selectSetupRole("advertiser"), { role: "advertiser", configureReceiver: false, configureAdvertiser: true });
  assert.deepEqual(selectSetupRole("both"), { role: "both", configureReceiver: true, configureAdvertiser: true });
  const store = new MemoryLocalStore();
  const setup = new ReceiverSetupService(store);
  const draft = await setup.prepare(base);
  assert.equal(draft.consentVersion, 1);
  assert.deepEqual(draft.publishedFields, {
    projectDescriptions: ["Building an agent inbox"],
    acceptedRewardTypes: ["stablecoin", "credits", "discount"],
    minimumTakeHomeMinor: 250,
  });
  assert.match(draft.activationDisclosure, /one Codex display turn.*gpt-5\.6-luna/i);
  await assert.rejects(setup.activate({ installationId: "installation-1", disclosureAccepted: false, termsAccepted: true, privacyAccepted: true }), /disclosure/i);
});

test("cash activation needs a payout address while credits-only does not", async () => {
  const store = new MemoryLocalStore();
  const setup = new ReceiverSetupService(store);
  await setup.prepare(base);
  await assert.rejects(setup.activate({ installationId: "installation-1", disclosureAccepted: true, termsAccepted: true, privacyAccepted: true }), /payout address/i);

  await setup.prepare({ ...base, profile: { values: { acceptedRewardTypes: ["credits"] as const }, enabled: { acceptedRewardTypes: true } } });
  await assert.doesNotReject(setup.activate({ installationId: "installation-1", disclosureAccepted: true, termsAccepted: true, privacyAccepted: true }));
});

test("rerun updates one installation; pause increments consent and stops checks", async () => {
  const store = new MemoryLocalStore();
  const revoked: number[] = [];
  const setup = new ReceiverSetupService(store, { revokeConsent: async (_id, version) => { revoked.push(version); } });
  await setup.prepare(base);
  await setup.prepare({ ...base, cadenceMinutes: 120 });
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.get("installation-1"))?.consentVersion, 2);
  await setup.pause("installation-1");
  assert.equal((await store.get("installation-1"))?.status, "paused");
  assert.equal((await store.get("installation-1"))?.consentVersion, 3);
  assert.deepEqual(revoked, [2]);
});

test("payout change stays pending until recent human approval", async () => {
  const store = new MemoryLocalStore();
  const setup = new ReceiverSetupService(store);
  const now = new Date();
  await setup.prepare({ ...base, verifiedPayout: { address: "0xold", approval: {
    accountId: "account-1", approvedAt: new Date(now.getTime() - 1_000).toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), purposes: ["payout_address_change"], approvedPayoutAddress: "0xold",
  } } });
  await setup.requestPayoutAddressChange("installation-1", "0xnew");
  assert.equal((await store.get("installation-1"))?.payoutAddress, "0xold");
  assert.equal((await store.get("installation-1"))?.pendingPayoutAddress, "0xnew");
  await assert.rejects(setup.approvePayoutAddressChange("installation-1", {
    accountId: "account-1", approvedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-01T00:05:00.000Z", purposes: ["payout_address_change"], approvedPayoutAddress: "0xnew",
  }, new Date("2026-08-15T00:00:00.000Z")), /expired|approval/i);
});

test("an agent cannot enroll an initial cash payout address without fresh human proof", async () => {
  const setup = new ReceiverSetupService(new MemoryLocalStore());
  await assert.rejects(setup.prepare({ ...base, verifiedPayout: { address: "0xagent", approval: {
    accountId: "account-1", approvedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-01T00:05:00.000Z", purposes: ["payout_address_change"], approvedPayoutAddress: "0xagent",
  } } }), /human|wallet/i);
});

test("pause leaves local checking stopped when remote revocation fails", async () => {
  const store = new MemoryLocalStore();
  const events: string[] = [];
  const setup = new ReceiverSetupService(store, {
    stopScheduler: async () => { events.push("scheduler_stopped"); },
    revokeConsent: async () => { events.push("remote_revoke"); throw new Error("offline"); },
  });
  await setup.prepare({ ...base, profile: { values: { acceptedRewardTypes: ["credits"] as const }, enabled: { acceptedRewardTypes: true } } });
  await assert.rejects(setup.pause("installation-1"), /offline/);
  assert.deepEqual(events, ["scheduler_stopped", "remote_revoke"]);
  assert.equal((await store.get("installation-1"))?.status, "paused");
});

test("JSON store serializes concurrent writes and rejects malformed records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-store-"));
  const path = join(directory, "config.json");
  const store = new JsonLocalStore(path);
  const source = new MemoryLocalStore();
  await new ReceiverSetupService(source).prepare(base);
  const first = (await source.get("installation-1"))!;
  await Promise.all([
    store.put(first),
    store.put({ ...first, installationId: "installation-2" }),
  ]);
  assert.equal((await store.list()).length, 2);
  await writeFile(path, JSON.stringify([{ installationId: "only-an-id" }]));
  await assert.rejects(store.list(), /malformed/i);
});
