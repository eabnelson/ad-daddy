import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  CodexLocalDeliveryRuntime,
  JsonLocalDeliveryStateStore,
  type AuthorizedCodexHostContext,
  type CodexAppServerConnection,
  type ClearedPlacementEnvelope,
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
      presentFallback: async () => { fallbackPresentations += 1; },
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

interface RuntimeThread {
  id: string;
  name: string | null;
  preview: string;
  turns: Array<{ id: string; status: string; items: unknown[] }>;
}

class RuntimeHost {
  readonly #threads = new Map<string, RuntimeThread>();
  readonly #instructionSources: string[];
  threadStartCount = 0;
  turnStartCount = 0;

  constructor(options: { instructionSources?: string[] } = {}) {
    this.#instructionSources = options.instructionSources ?? [];
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
              text: "Sponsored via Ad Daddy\nNeon — Add Postgres without leaving Codex\nReward: $5.00\nMatched: TypeScript, database integration",
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
