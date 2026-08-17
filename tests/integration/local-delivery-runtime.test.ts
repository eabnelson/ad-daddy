import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  CodexLocalDeliveryRuntime,
  canonicalJson,
  JsonLocalDeliveryStateStore,
  type AuthorizedCodexHostContext,
  type CodexAppServerConnection,
  type ClearedPlacementEnvelope,
  type ClaimedPlacementEnvelope,
} from "../../packages/host-adapters/dist/index.js";
import {
  SIGNED_PLACEMENT_FIXTURE,
  TEST_MARKETPLACE_PUBLIC_KEY_PEM,
} from "../../packages/host-adapters/dist/fixtures/signed-placement.js";
import { runManualCheck } from "../../packages/cli/dist/commands/check.js";
import { MemoryLocalStore } from "../../packages/cli/dist/local-store.js";

const NOW = new Date("2026-08-15T15:30:00.000Z");

test("a cleared placement uses the receiver-authorized Codex context and survives a runtime restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-delivery-"));
  try {
    const statePath = join(directory, "deliveries.json");
    const host = new RuntimeHost();
    const firstRuntime = runtime(new JsonLocalDeliveryStateStore(statePath), host);
    const first = await firstRuntime.deliver(envelope(), NOW);

    assert.equal(first.status, "native");
    assert.equal(host.threadStartCount, 1);
    assert.equal(host.turnStartCount, 1);
    assert.equal(first.record.hostSessionId, "sponsored-1");

    const restartedRuntime = runtime(new JsonLocalDeliveryStateStore(statePath), host);
    const retry = await restartedRuntime.deliver(envelope(), NOW);
    assert.equal(retry.status, "native");
    assert.equal(retry.record.hostSessionId, first.record.hostSessionId);
    assert.equal(host.threadStartCount, 1);
    assert.equal(host.turnStartCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a device-bound claimed placement reaches the host only after grant and lease verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-delivery-"));
  try {
    const marketplace = generateKeyPairSync("ed25519");
    const privateKeyPem = marketplace.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem = marketplace.publicKey.export({ type: "spki", format: "pem" }).toString();
    const claimed = claimedEnvelope(privateKeyPem);
    const host = new RuntimeHost();
    const delivery = new CodexLocalDeliveryRuntime({
      store: new JsonLocalDeliveryStateStore(join(directory, "deliveries.json")),
      marketplacePublicKeyPem: publicKeyPem,
      authorizeHost: async () => host.context(),
      presentFallback: async () => {},
    });
    const result = await delivery.deliver(claimed, NOW);
    assert.equal(result.status, "native");
    assert.equal(result.status === "native" && result.record.claimId, claimed.claimId);
    assert.equal(host.threadStartCount, 1);

    const rejectedHost = new RuntimeHost();
    const rejected = new CodexLocalDeliveryRuntime({
      store: new JsonLocalDeliveryStateStore(join(directory, "rejected.json")), marketplacePublicKeyPem: publicKeyPem,
      authorizeHost: async () => rejectedHost.context(), presentFallback: async () => {},
    });
    await assert.rejects(rejected.deliver({ ...claimed, claimId: "claim_tampered" }, NOW), /different claim/);
    assert.equal(rejectedHost.threadStartCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("instruction isolation failure records one empty task and presents the signed fallback once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-delivery-"));
  try {
    const host = new RuntimeHost({ instructionSources: ["/workspace/AGENTS.md"] });
    let fallbackPresentations = 0;
    const statePath = join(directory, "deliveries.json");
    const createRuntime = () => new CodexLocalDeliveryRuntime({
      store: new JsonLocalDeliveryStateStore(statePath),
      marketplacePublicKeyPem: TEST_MARKETPLACE_PUBLIC_KEY_PEM,
      authorizeHost: async () => host.context(),
      presentFallback: async (receipt) => {
        fallbackPresentations += 1;
        return {
          verified: true,
          displayedAt: NOW.toISOString(),
          outputSha256: createHash("sha256").update(canonicalJson(receipt)).digest("hex"),
        };
      },
    });

    const first = await createRuntime().deliver(envelope(), NOW);
    const retry = await createRuntime().deliver(envelope(), NOW);

    assert.equal(first.status, "fallback");
    assert.equal(retry.status, "fallback");
    assert.equal(first.record.nativeFailureCode, "INSTRUCTION_SOURCE_LEAK");
    assert.equal(host.threadStartCount, 1);
    assert.equal(host.turnStartCount, 0);
    assert.equal(fallbackPresentations, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unverified built-in tool isolation uses signed HTML without starting a native task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-delivery-"));
  try {
    const host = new RuntimeHost({ builtInToolsDisabled: false });
    let fallbackPresentations = 0;
    const delivery = new CodexLocalDeliveryRuntime({
      store: new JsonLocalDeliveryStateStore(join(directory, "deliveries.json")),
      marketplacePublicKeyPem: TEST_MARKETPLACE_PUBLIC_KEY_PEM,
      authorizeHost: async () => host.context(),
      presentFallback: async (receipt) => {
        fallbackPresentations += 1;
        return {
          verified: true,
          displayedAt: NOW.toISOString(),
          outputSha256: createHash("sha256").update(canonicalJson(receipt)).digest("hex"),
        };
      },
    });

    const result = await delivery.deliver(envelope(), NOW);

    assert.equal(result.status, "fallback");
    assert.equal(result.record.nativeFailureCode, "BUILT_IN_TOOLS_UNVERIFIED");
    assert.equal(host.threadStartCount, 0);
    assert.equal(host.turnStartCount, 0);
    assert.equal(fallbackPresentations, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writing fallback metadata is not a verified signed-HTML display and cannot produce a receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-delivery-"));
  try {
    const host = new RuntimeHost({ instructionSources: ["/workspace/AGENTS.md"] });
    const store = new JsonLocalDeliveryStateStore(join(directory, "deliveries.json"));
    const delivery = new CodexLocalDeliveryRuntime({
      store,
      marketplacePublicKeyPem: TEST_MARKETPLACE_PUBLIC_KEY_PEM,
      authorizeHost: async () => host.context(),
      presentFallback: async () => undefined,
    });

    await assert.rejects(delivery.deliver(envelope(), NOW), /fallback.*not verified|verified.*fallback/i);
    const persisted = await store.get(envelope().placement.payload.placementId);
    assert.equal(persisted?.status, "pending");
    assert.equal(persisted?.receipt, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a native failure after a display turn starts suppresses fallback to prevent a second surface", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-delivery-"));
  try {
    const host = new RuntimeHost({ output: "This response is missing the required sponsored fields." });
    let fallbackPresentations = 0;
    const store = new JsonLocalDeliveryStateStore(join(directory, "deliveries.json"));
    const delivery = new CodexLocalDeliveryRuntime({
      store,
      marketplacePublicKeyPem: TEST_MARKETPLACE_PUBLIC_KEY_PEM,
      authorizeHost: async () => host.context(),
      presentFallback: async () => { fallbackPresentations += 1; },
    });

    await assert.rejects(delivery.deliver(envelope(), NOW), /fallback.*suppressed|may already be visible/i);
    assert.equal(host.threadStartCount, 1);
    assert.equal(host.turnStartCount, 1);
    assert.equal(fallbackPresentations, 0);
    const persisted = await store.get(envelope().placement.payload.placementId);
    assert.equal(persisted?.status, "pending");
    assert.ok(persisted?.hostTurnId);
    assert.equal(persisted?.receipt, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart recovery persists an existing display turn before suppressing a fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-delivery-"));
  try {
    const host = new RuntimeHost({
      seedCompletedThread: true,
      output: "This existing response is missing the required sponsored fields.",
    });
    let fallbackPresentations = 0;
    const store = new JsonLocalDeliveryStateStore(join(directory, "deliveries.json"));
    const source = envelope();
    await store.put({
      placementId: source.placement.payload.placementId,
      receiverAccountId: source.receiverAccountId,
      installationId: source.installationId,
      signedPlacementSha256: createHash("sha256").update(canonicalJson(source.placement)).digest("hex"),
      status: "pending",
      hostSessionId: "sponsored-existing",
      hostInstructionSourcesVerified: true,
      hostInstructionSources: [],
      updatedAt: NOW.toISOString(),
    });
    const delivery = new CodexLocalDeliveryRuntime({
      store,
      marketplacePublicKeyPem: TEST_MARKETPLACE_PUBLIC_KEY_PEM,
      authorizeHost: async () => host.context(),
      presentFallback: async () => { fallbackPresentations += 1; },
    });

    await assert.rejects(delivery.deliver(source, NOW), /fallback.*suppressed|may already be visible/i);
    assert.equal(fallbackPresentations, 0);
    assert.equal((await store.get(source.placement.payload.placementId))?.hostTurnId, "display-turn");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a placement for another receiver cannot touch the local host", async () => {
  const host = new RuntimeHost();
  const runtime = new CodexLocalDeliveryRuntime({
    store: new JsonLocalDeliveryStateStore(join(tmpdir(), `ad-daddy-unused-${crypto.randomUUID()}.json`)),
    marketplacePublicKeyPem: TEST_MARKETPLACE_PUBLIC_KEY_PEM,
    authorizeHost: async () => host.context(),
    presentFallback: async () => {},
  });

  await assert.rejects(
    runtime.deliver({ ...envelope(), receiverAccountId: "receiver_other" }, NOW),
    /does not belong to this authorized installation/,
  );
  assert.equal(host.threadStartCount, 0);
});

test("the live manual-check path turns a cleared poll response into one sponsored Codex task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-delivery-"));
  try {
    const store = new MemoryLocalStore();
    await store.put({
      installationId: "installation_1",
      accountId: "receiver_1",
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
    const host = new RuntimeHost();
    const result = await runManualCheck({
      installationId: "installation_1",
      store,
      poll: async () => envelope(),
      delivery: runtime(
        new JsonLocalDeliveryStateStore(join(directory, "deliveries.json")),
        host,
      ),
      now: NOW,
    });

    assert.equal(result.status, "checked");
    assert.equal(result.delivery.status, "native");
    assert.equal(host.threadStartCount, 1);
    assert.equal(host.turnStartCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runtime(store: JsonLocalDeliveryStateStore, host: RuntimeHost) {
  return new CodexLocalDeliveryRuntime({
    store,
    marketplacePublicKeyPem: TEST_MARKETPLACE_PUBLIC_KEY_PEM,
    authorizeHost: async () => host.context(),
    presentFallback: async () => {},
  });
}

function envelope(): ClearedPlacementEnvelope {
  return {
    receiverAccountId: "receiver_1",
    installationId: "installation_1",
    placement: structuredClone(SIGNED_PLACEMENT_FIXTURE),
  };
}

function claimedEnvelope(privateKeyPem: string): ClaimedPlacementEnvelope {
  const payload = structuredClone(SIGNED_PLACEMENT_FIXTURE.payload);
  payload.issuedAt = new Date(NOW.getTime() - 1_000).toISOString();
  payload.expiresAt = new Date(NOW.getTime() + 60_000).toISOString();
  const placement = {
    algorithm: "Ed25519" as const, keyId: "marketplace_test", payload,
    signature: sign(null, Buffer.from(canonicalJson(payload)), privateKeyPem).toString("base64url"),
  };
  const creativeDigest = createHash("sha256").update(canonicalJson(placement)).digest("hex");
  const unsigned = {
    protocolVersion: 1 as const, claimId: "claim_local", receiverAccountId: "receiver_1", receiverProfileId: "profile_1",
    installationId: "installation_1", deviceKeyThumbprint: "a".repeat(43), consentVersion: 1,
    opportunityId: "opportunity_1", placementId: placement.payload.placementId, campaignId: "campaign_1", reservationId: "reservation_1",
    rewardType: "stablecoin" as const, grossAmountMinor: 625, receiverAmountMinor: 500, operatorAmountMinor: 125,
    currency: "USD" as const, creativeDigest, eligibleBidderCount: 2, issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  };
  const grantPayload = { ...unsigned, grantDigest: createHash("sha256").update(canonicalJson(unsigned)).digest("hex") };
  return {
    claimId: unsigned.claimId,
    grant: {
      algorithm: "Ed25519", keyId: "marketplace_test", payload: grantPayload,
      signature: sign(null, Buffer.from(canonicalJson(grantPayload)), privateKeyPem).toString("base64url"),
    },
    lease: {
      leaseId: "lease_local", claimId: unsigned.claimId, installationId: unsigned.installationId,
      deviceKeyThumbprint: unsigned.deviceKeyThumbprint, creativeDigest, policyVersion: "pull/v1", state: "active",
      issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 15_000).toISOString(),
    },
    placement,
  };
}

interface RuntimeThread {
  id: string;
  name: string | null;
  preview: string;
  turns: Array<{ id: string; status: string; items: unknown[] }>;
}

class RuntimeHost {
  readonly #threads = new Map<string, RuntimeThread>();
  readonly #instructionSources: string[];
  readonly #output: string;
  readonly #builtInToolsDisabled: boolean;
  threadStartCount = 0;
  turnStartCount = 0;

  constructor(options: { instructionSources?: string[]; output?: string; seedCompletedThread?: boolean; builtInToolsDisabled?: boolean } = {}) {
    this.#instructionSources = options.instructionSources ?? [];
    this.#output = options.output ?? "Sponsored via Ad Daddy\nNeon — Add Postgres without leaving Codex\nReward: $5.00\nMatched: TypeScript, database integration";
    this.#builtInToolsDisabled = options.builtInToolsDisabled ?? true;
    if (options.seedCompletedThread) {
      this.#threads.set("sponsored-existing", {
        id: "sponsored-existing",
        name: "AD DADDY: Add Postgres without leaving Codex",
        preview: this.#output,
        turns: [{
          id: "display-turn",
          status: "completed",
          items: [{ type: "agentMessage", id: "answer", phase: "final_answer", text: this.#output }],
        }],
      });
    }
  }

  context(): AuthorizedCodexHostContext {
    return {
      receiverAccountId: "receiver_1",
      installationId: "installation_1",
      isolatedCwd: "/tmp/ad-daddy-empty",
      createConnection: this.createConnection,
      readActiveTaskId: async () => "active-task",
      verifySidebarVisibility: async ({ threadId }) => this.#threads.has(threadId),
    };
  }

  createConnection = async (): Promise<CodexAppServerConnection> => {
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    let waiter: ((value: { method: string; params: Record<string, unknown> }) => void) | undefined;
    const emit = (notification: { method: string; params: Record<string, unknown> }) => {
      if (waiter) {
        const resolve = waiter;
        waiter = undefined;
        resolve(notification);
      } else notifications.push(notification);
    };
    return {
      cliVersion: "0.146.1",
      userAgent: "Codex Desktop/0.146.1 (local runtime test)",
      allowedInstructionSources: [],
      builtInToolsDisabled: this.#builtInToolsDisabled,
      request: async <T>(method: string, value: unknown): Promise<T> => {
        const params = value as { threadId?: string; name?: string; input?: Array<{ text: string }>; archived?: boolean };
        if (method === "thread/list") {
          return { data: [...this.#threads.values()].map(summary), nextCursor: null } as T;
        }
        if (method === "thread/start") {
          this.threadStartCount += 1;
          const thread: RuntimeThread = { id: `sponsored-${this.threadStartCount}`, name: null, preview: "", turns: [] };
          this.#threads.set(thread.id, thread);
          return { thread: summary(thread), instructionSources: this.#instructionSources } as T;
        }
        if (method === "thread/name/set") {
          this.#threads.get(params.threadId!)!.name = params.name!;
          return {} as T;
        }
        if (method === "turn/start") {
          this.turnStartCount += 1;
          const thread = this.#threads.get(params.threadId!)!;
          thread.preview = params.input![0]!.text;
          const turn = { id: "display-turn", status: "inProgress", items: [] as unknown[] };
          thread.turns.push(turn);
          queueMicrotask(() => {
            const item = {
              type: "agentMessage",
              id: "answer",
              phase: "final_answer",
              text: this.#output,
            };
            turn.items.push(item);
            emit({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item } });
            turn.status = "completed";
            emit({ method: "turn/completed", params: { threadId: thread.id, turn: structuredClone(turn) } });
          });
          return { turn } as T;
        }
        if (method === "thread/read") {
          const thread = this.#threads.get(params.threadId!);
          if (!thread) throw new Error("thread missing");
          return { thread: structuredClone(thread) } as T;
        }
        if (method === "turn/interrupt") return {} as T;
        throw new Error(`Unexpected App Server method ${method}`);
      },
      nextNotification: async () => notifications.shift() ?? new Promise((resolve) => { waiter = resolve; }),
      close: async () => {},
    };
  };
}

function summary(thread: RuntimeThread) {
  return { id: thread.id, name: thread.name, preview: thread.preview, turns: [] };
}
