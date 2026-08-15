import type { SignedPlacement } from "../contract.js";

export const TEST_MARKETPLACE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAEJPL/ASmGiqxbbsspRvIcbk2dtGM1nR7mFKHfO7YQ6I=
-----END PUBLIC KEY-----
`;

export const SIGNED_PLACEMENT_FIXTURE: SignedPlacement = {
  algorithm: "Ed25519",
  keyId: "test-marketplace-2026-08",
  payload: {
    protocolVersion: 1,
    placementId: "spike-20260815-neon-001",
    advertiser: {
      id: "adv_neon_test",
      displayName: "Neon",
    },
    title: "Add Postgres without leaving Codex",
    contentReference:
      "https://example.invalid/ad-daddy/placements/spike-20260815-neon-001",
    disclosure: "Sponsored",
    payout: {
      amountMinor: 500,
      currency: "USD",
    },
    signalsUsed: ["TypeScript", "database integration"],
    issuedAt: "2026-08-15T15:00:00.000Z",
    expiresAt: "2030-08-16T15:00:00.000Z",
  },
  signature:
    "odSyo7xtz2RoXStyfGQybz-XFJW-mowqruXm3paf3yCPNnI0kIO0tAIRL20S6k31g8oW8i1IHmbbBrK3RDoLCA",
};
