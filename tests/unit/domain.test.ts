import assert from "node:assert/strict";
import test from "node:test";

import {
  DomainValidationError,
  createConsentVersion,
  validateReceiverProfileSnapshot,
} from "../../lib/domain/schemas.ts";
import {
  invalidateForConsentChange,
  transitionPlacement,
} from "../../lib/domain/placement-state.ts";

const NOW = new Date("2026-08-15T16:00:00.000Z");

test("a profile snapshot publishes only allowlisted, consented summaries", () => {
  const snapshot = validateReceiverProfileSnapshot(
    {
      profileId: "profile_1",
      accountId: "account_1",
      installationId: "installation_1",
      consentVersion: 3,
      publishedAt: NOW.toISOString(),
      expiresAt: "2026-08-15T17:00:00.000Z",
      fields: {
        coarseLocation: "US-Northeast",
        privateRepoTechStacks: [["TypeScript", "Postgres", "React"]],
        adFrequency: { maxPerDay: 2 },
        acceptedRewardTypes: ["stablecoin", "credits"],
        minimumTakeHomeMinor: 250,
      },
    },
    NOW,
  );

  assert.deepEqual(snapshot.fields.privateRepoTechStacks, [
    ["TypeScript", "Postgres", "React"],
  ]);
  assert.equal(snapshot.consentVersion, 3);
});

test("profile snapshots reject private workspace data and unknown fields", () => {
  for (const fields of [
    { rawPrompts: ["secret"] },
    { privateRepoTechStacks: [["TypeScript", "/Users/erik/private"]] },
    { exactTokenUsage: 123_456 },
  ]) {
    assert.throws(
      () =>
        validateReceiverProfileSnapshot(
          {
            profileId: "profile_1",
            accountId: "account_1",
            installationId: "installation_1",
            consentVersion: 1,
            publishedAt: NOW.toISOString(),
            expiresAt: "2026-08-15T17:00:00.000Z",
            fields,
          },
          NOW,
        ),
      DomainValidationError,
    );
  }

  assert.throws(
    () => validateReceiverProfileSnapshot({
      profileId: "profile_1",
      accountId: "account_1",
      installationId: "installation_1",
      consentVersion: 1,
      publishedAt: NOW.toISOString(),
      expiresAt: "2026-08-15T17:00:00.000Z",
      fields: {},
      rawTranscript: "private",
    }, NOW),
    /rawTranscript/,
  );

  assert.throws(
    () => validateReceiverProfileSnapshot({
      profileId: "profile_1",
      accountId: "account_1",
      installationId: "installation_1",
      consentVersion: 1,
      publishedAt: NOW.toISOString(),
      expiresAt: "2026-08-15T17:00:00.000Z",
      fields: { adFrequency: { maxPerDay: 25 } },
    }, NOW),
    /maxPerDay/,
  );
});

test("consent updates are forward-only and invalidate stale open opportunities", () => {
  const updated = createConsentVersion({
    receiverId: "receiver_1",
    previousVersion: 4,
    acceptedAt: NOW.toISOString(),
    termsVersion: "receiver-terms/2026-08-15",
    privacyVersion: "privacy/2026-08-15",
    status: "active",
  });
  assert.equal(updated.version, 5);

  const invalidated = invalidateForConsentChange(
    {
      opportunityId: "opp_1",
      consentVersion: 4,
      state: "bidding",
    },
    updated.version,
  );
  assert.deepEqual(invalidated, {
    opportunityId: "opp_1",
    consentVersion: 4,
    state: "no_fill",
    invalidatedReason: "stale_consent",
  });
});

test("placement lifecycle accepts only explicit forward transitions", () => {
  const legal = [
    ["offered", "bidding"],
    ["offered", "no_fill"],
    ["bidding", "won"],
    ["bidding", "no_fill"],
    ["won", "delivered"],
    ["won", "expired"],
    ["delivered", "settled"],
    ["settled", "conversion_pending"],
    ["conversion_pending", "conversion_paid"],
    ["conversion_pending", "conversion_rejected"],
  ] as const;

  for (const [from, to] of legal) {
    assert.equal(transitionPlacement(from, to), to);
  }

  for (const [from, to] of [
    ["won", "bidding"],
    ["settled", "delivered"],
    ["no_fill", "offered"],
    ["conversion_paid", "conversion_pending"],
    ["offered", "delivered"],
  ] as const) {
    assert.throws(() => transitionPlacement(from, to), /Illegal placement transition/);
  }
});
