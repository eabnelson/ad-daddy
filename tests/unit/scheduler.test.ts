import assert from "node:assert/strict";
import test from "node:test";

import { CheckCoordinator, evaluateCheckPolicy, schedulerSupport } from "../../packages/cli/dist/scheduler.js";
import { runManualCheck } from "../../packages/cli/dist/commands/check.js";
import { MemoryLocalStore } from "../../packages/cli/dist/local-store.js";

test("quiet hours and cadence prevent polls", () => {
  assert.deepEqual(evaluateCheckPolicy({ cadenceMinutes: 60, quietHours: { startHourLocal: 22, endHourLocal: 7 } }, {
    now: new Date(2026, 7, 15, 23),
    lastCheckedAt: undefined,
  }), { allowed: false, reason: "quiet_hours" });
  assert.deepEqual(evaluateCheckPolicy({ cadenceMinutes: 60 }, {
    now: new Date("2026-08-15T12:30:00Z"),
    lastCheckedAt: "2026-08-15T12:00:00.000Z",
  }), { allowed: false, reason: "cadence" });
  assert.deepEqual(evaluateCheckPolicy({ cadenceMinutes: 60, maxPerDay: 2 }, {
    now: new Date("2026-08-15T12:30:00Z"),
    placementsToday: 2,
  }), { allowed: false, reason: "frequency_cap" });
});

test("simultaneous checks coalesce into one poll", async () => {
  let polls = 0;
  const gate = new CheckCoordinator(async () => {
    polls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { status: "no_fill" as const };
  });
  const [a, b] = await Promise.all([gate.check(), gate.check()]);
  assert.equal(polls, 1);
  assert.deepEqual(a, b);
});

test("unsupported operating systems disclose manual-only delivery", () => {
  assert.deepEqual(schedulerSupport("linux"), {
    automaticDelivery: false,
    manualCommand: "ad-daddy check",
    message: "Automatic delivery is unavailable on linux; run ad-daddy check manually.",
  });
});

test("manual checks enforce the receiver's local daily frequency cap", async () => {
  const store = new MemoryLocalStore();
  await store.put({
    installationId: "installation_capped",
    accountId: "account_1",
    role: "receiver",
    profile: { values: {}, enabled: {} },
    publishedFields: { adFrequency: { maxPerDay: 2 } },
    cadenceMinutes: 60,
    termsVersion: "terms/v1",
    privacyVersion: "privacy/v1",
    consentVersion: 1,
    status: "active",
    hostDisclosure: { host: "Codex", consumesTurn: true },
  });
  let polls = 0;
  const result = await runManualCheck({
    installationId: "installation_capped",
    store,
    placementsToday: 2,
    poll: async () => {
      polls += 1;
    },
    now: new Date("2026-08-15T12:00:00.000Z"),
  });

  assert.deepEqual(result, { status: "skipped", reason: "frequency_cap" });
  assert.equal(polls, 0);
});

test("an eligible manual check hands the cleared response to the local delivery runtime", async () => {
  const store = new MemoryLocalStore();
  await store.put({
    installationId: "installation_live",
    accountId: "account_1",
    role: "receiver",
    profile: { values: {}, enabled: {} },
    publishedFields: {},
    cadenceMinutes: 60,
    termsVersion: "terms/v1",
    privacyVersion: "privacy/v1",
    consentVersion: 1,
    status: "active",
    hostDisclosure: { host: "Codex", consumesTurn: true },
  });
  const cleared = { placement: { payload: { placementId: "placement_1" } } };
  let delivered: unknown;

  const result = await runManualCheck({
    installationId: "installation_live",
    store,
    poll: async () => cleared,
    delivery: {
      deliver: async (response) => {
        delivered = response;
        return { status: "native", placementId: "placement_1" };
      },
    },
    now: new Date("2026-08-15T12:00:00.000Z"),
  });

  assert.equal(delivered, cleared);
  assert.deepEqual(result, {
    status: "checked",
    response: cleared,
    delivery: { status: "native", placementId: "placement_1" },
  });
});
