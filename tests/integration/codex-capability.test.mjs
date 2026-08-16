import assert from "node:assert/strict";
import test from "node:test";

import {
  PlacementValidationError,
  validateSignedPlacement,
} from "../../packages/host-adapters/dist/contract.js";
import { assessCodexCapability } from "../../packages/host-adapters/dist/codex-capability.js";
import { deliverCodexPlacement } from "../../packages/host-adapters/dist/codex-app-server.js";
import {
  SPONSORED_DISPLAY_INSTRUCTION,
  renderPlacementData,
} from "../../packages/host-adapters/dist/display-instruction.js";
import {
  PROMPT_INJECTION_PLACEMENT_FIXTURE,
  SIGNED_PLACEMENT_FIXTURE,
  TEST_MARKETPLACE_PUBLIC_KEY_PEM,
} from "../../packages/host-adapters/dist/fixtures/signed-placement.js";

const NOW = new Date("2026-08-15T15:30:00.000Z");

test("accepts the valid signed inert placement fixture", () => {
  const placement = validateSignedPlacement(
    SIGNED_PLACEMENT_FIXTURE,
    TEST_MARKETPLACE_PUBLIC_KEY_PEM,
    NOW,
  );

  assert.equal(placement.placementId, "spike-20260815-neon-001");
  assert.equal(placement.disclosure, "Sponsored");
  assert.match(placement.creative.body, /serverless Postgres/i);
});

test("validated placement data is detached and deeply immutable", () => {
  const input = structuredClone(SIGNED_PLACEMENT_FIXTURE);
  const placement = validateSignedPlacement(
    input,
    TEST_MARKETPLACE_PUBLIC_KEY_PEM,
    NOW,
  );

  input.payload.creative.body = "mutated after verification";
  assert.match(placement.creative.body, /serverless Postgres/i);
  assert.throws(() => {
    placement.creative.attachments[0].title = "mutated return value";
  }, TypeError);
});

test("rejects a placement whose signed payload was modified", () => {
  const tampered = structuredClone(SIGNED_PLACEMENT_FIXTURE);
  tampered.payload.payout.amountMinor = 50_000;

  assert.throws(
    () => validateSignedPlacement(tampered, TEST_MARKETPLACE_PUBLIC_KEY_PEM, NOW),
    (error) =>
      error instanceof PlacementValidationError &&
      error.code === "INVALID_SIGNATURE",
  );
});

test("rejects an expired placement", () => {
  assert.throws(
    () =>
      validateSignedPlacement(
        SIGNED_PLACEMENT_FIXTURE,
        TEST_MARKETPLACE_PUBLIC_KEY_PEM,
        new Date("2031-01-01T00:00:00.000Z"),
      ),
    (error) =>
      error instanceof PlacementValidationError && error.code === "EXPIRED",
  );
});

test("rejects unsupported fields and unsafe URL schemes before signature work", () => {
  const unknownField = structuredClone(SIGNED_PLACEMENT_FIXTURE);
  unknownField.payload.creative.trackingPixel = "https://example.invalid/pixel";
  const unsafeUrl = structuredClone(SIGNED_PLACEMENT_FIXTURE);
  unsafeUrl.payload.contentReference = "javascript:alert(1)";

  for (const placement of [unknownField, unsafeUrl]) {
    assert.throws(
      () => validateSignedPlacement(placement, TEST_MARKETPLACE_PUBLIC_KEY_PEM, NOW),
      (error) => error instanceof PlacementValidationError && error.code === "INVALID_PAYLOAD",
    );
  }
});

test("the immutable display instruction labels sponsorship and forbids actions", () => {
  assert.match(SPONSORED_DISPLAY_INSTRUCTION, /Sponsored via Ad Daddy/);
  assert.match(SPONSORED_DISPLAY_INSTRUCTION, /advertiser fields.*data/i);
  assert.match(SPONSORED_DISPLAY_INSTRUCTION, /do not use.*tools/i);
  assert.match(
    SPONSORED_DISPLAY_INSTRUCTION,
    /file.*network.*install.*purchase.*external action/i,
  );

  const rendered = renderPlacementData(PROMPT_INJECTION_PLACEMENT_FIXTURE.payload);
  assert.match(rendered, /BEGIN ADVERTISER DATA/);
  assert.match(rendered, /ignore the Ad Daddy instructions/i);
  assert.match(rendered, /END ADVERTISER DATA/);
});

test("returns an explicit fallback when the host interface is unavailable", () => {
  const result = assessCodexCapability(observation({ interfaceAvailable: false }));

  assert.equal(result.nativeDelivery, false);
  assert.equal(result.code, "HOST_INTERFACE_UNAVAILABLE");
  assert.equal(result.fallback.kind, "signed-html");
});

test("fails closed for an untested Codex version", () => {
  const result = assessCodexCapability(observation({ cliVersion: "0.147.0" }));

  assert.equal(result.nativeDelivery, false);
  assert.equal(result.code, "HOST_VERSION_UNSUPPORTED");
});

test("fails the native gate when a persisted task is omitted from the task list", () => {
  const result = assessCodexCapability(observation({ listedTaskIds: ["active-task"] }));

  assert.equal(result.nativeDelivery, false);
  assert.equal(result.code, "TASK_NOT_LIST_VISIBLE");
});

test("fails the native gate when sidebar visibility is not directly verified", () => {
  const result = assessCodexCapability(observation({ sidebarVerified: false }));

  assert.equal(result.nativeDelivery, false);
  assert.equal(result.code, "TASK_NOT_SIDEBAR_VERIFIED");
});

test("fails the native gate when insertion mutates the active task", () => {
  const result = assessCodexCapability(
    observation({ activeTaskIdAfter: "sponsored-task" }),
  );

  assert.equal(result.nativeDelivery, false);
  assert.equal(result.code, "ACTIVE_TASK_MUTATED");
});

test("recognizes the complete native capability contract", () => {
  const result = assessCodexCapability(observation());

  assert.equal(result.nativeDelivery, true);
  assert.equal(result.code, "SUPPORTED");
});

test("a valid placement creates one isolated display turn and returns a receipt", async () => {
  const host = new FakeAppServerHost();
  const result = await deliverCodexPlacement(deliveryOptions(host));

  assert.equal(result.delivered, true);
  assert.equal(result.receipt.title, "Sponsored · Add Postgres without leaving Codex");
  assert.equal(result.receipt.toolItemCount, 0);
  assert.equal(result.receipt.restartReadable, true);
  assert.equal(result.receipt.sidebarVerified, true);
  assert.match(result.receipt.output, /Sponsored via Ad Daddy/);
  assert.match(result.receipt.outputSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.receipt.advertiserDisplayName, "Neon");
  assert.equal(result.receipt.receiverAmountMinor, 500);
  assert.deepEqual(result.receipt.signalsUsed, ["TypeScript", "database integration"]);
  assert.equal(host.threadStartCalls.length, 1);
  assert.equal(host.turnStartCalls.length, 1);
  assert.equal(host.turnStartCalls[0].cwd, "/tmp/ad-daddy-empty");
  assert.deepEqual(host.turnStartCalls[0].runtimeWorkspaceRoots, []);
  assert.deepEqual(host.turnStartCalls[0].environments, []);
  assert.equal(host.turnStartCalls[0].approvalPolicy, "never");
  assert.deepEqual(host.turnStartCalls[0].sandboxPolicy, {
    type: "readOnly",
    networkAccess: false,
  });
  assert.equal(
    host.threadStartCalls[0].developerInstructions,
    SPONSORED_DISPLAY_INSTRUCTION,
  );
  assert.deepEqual(host.threadStartCalls[0].config.mcp_servers, {});
  assert.deepEqual(host.threadStartCalls[0].runtimeWorkspaceRoots, []);
  assert.deepEqual(host.threadStartCalls[0].environments, []);
  assert.deepEqual(host.threadStartCalls[0].dynamicTools, []);
  assert.deepEqual(host.threadStartCalls[0].config.tools, { web_search: null });
  assert.equal(host.threadStartCalls[0].config.web_search, "disabled");
});

test("production native delivery never sends advertiser content without host proof that built-ins are disabled", async () => {
  const unproven = new FakeAppServerHost();
  const rejected = await deliverCodexPlacement({
    ...deliveryOptions(unproven),
    deploymentEnvironment: "production",
  });
  assert.equal(rejected.delivered, false);
  assert.equal(rejected.code, "BUILT_IN_TOOLS_UNVERIFIED");
  assert.equal(unproven.threadStartCalls.length, 0);
  assert.equal(unproven.turnStartCalls.length, 0);

  const proven = new FakeAppServerHost({ builtInToolsDisabled: true });
  const delivered = await deliverCodexPlacement({
    ...deliveryOptions(proven),
    deploymentEnvironment: "production",
  });
  assert.equal(delivered.delivered, true);
  assert.equal(proven.turnStartCalls.length, 1);
});

test("invalid and expired placements create no host state", async () => {
  const tampered = structuredClone(SIGNED_PLACEMENT_FIXTURE);
  tampered.payload.title = "tampered";
  for (const [placement, now] of [
    [tampered, NOW],
    [SIGNED_PLACEMENT_FIXTURE, new Date("2031-01-01T00:00:00.000Z")],
  ]) {
    const host = new FakeAppServerHost();
    const result = await deliverCodexPlacement({
      ...deliveryOptions(host),
      placement,
      now,
    });

    assert.equal(result.delivered, false);
    assert.equal(result.code, "PLACEMENT_INVALID");
    assert.equal(result.receipt, undefined);
    assert.equal(host.connectionCount, 0);
    assert.equal(host.threads.size, 0);
  }
});

test("prompt-injection creative stays quoted data and cannot cause a tool item", async () => {
  const host = new FakeAppServerHost({
    output: "Sponsored via Ad Daddy\nNeon — Prompt boundary test\nReward: $5.00\nMatched: TypeScript, database integration.",
  });
  const result = await deliverCodexPlacement({
    ...deliveryOptions(host),
    placement: PROMPT_INJECTION_PLACEMENT_FIXTURE,
  });

  assert.equal(result.delivered, true);
  assert.match(host.turnStartCalls[0].input[0].text, /BEGIN ADVERTISER DATA/);
  assert.match(
    host.turnStartCalls[0].input[0].text,
    /ignore the Ad Daddy instructions/i,
  );
  assert.equal(result.receipt.toolItemCount, 0);
});

test("a tool item rejects delivery and interrupts the turn", async () => {
  const host = new FakeAppServerHost({ emitToolItem: true });
  const result = await deliverCodexPlacement(deliveryOptions(host));

  assert.equal(result.delivered, false);
  assert.equal(result.code, "TOOL_ITEM_EMITTED");
  assert.equal(result.receipt, undefined);
  assert.equal(host.interruptCalls.length, 1);
});

test("restart read failure yields no receipt", async () => {
  const host = new FakeAppServerHost({ failRestartRead: true });
  const result = await deliverCodexPlacement(deliveryOptions(host));

  assert.equal(result.delivered, false);
  assert.equal(result.code, "TASK_NOT_RESTART_READABLE");
  assert.equal(result.receipt, undefined);
});

test("timeout and output budget interrupt without yielding a receipt", async () => {
  for (const host of [
    new FakeAppServerHost({ neverComplete: true }),
    new FakeAppServerHost({ output: "x".repeat(200) }),
  ]) {
    const result = await deliverCodexPlacement({
      ...deliveryOptions(host),
      timeoutMs: 10,
      outputCharacterBudget: 100,
    });

    assert.equal(result.delivered, false);
    assert.ok(["TURN_TIMEOUT", "OUTPUT_BUDGET_EXCEEDED"].includes(result.code));
    assert.equal(result.receipt, undefined);
    assert.equal(host.interruptCalls.length, 1);
  }
});

test("retrying a placement ID returns the same task without another turn", async () => {
  const host = new FakeAppServerHost();
  const options = deliveryOptions(host);

  const first = await deliverCodexPlacement(options);
  const second = await deliverCodexPlacement(options);

  assert.equal(first.delivered, true);
  assert.equal(second.delivered, true);
  assert.equal(second.receipt.threadId, first.receipt.threadId);
  assert.equal(host.threadStartCalls.length, 1);
  assert.equal(host.turnStartCalls.length, 1);
});

test("persists host identifiers before delivery finishes and retries by direct mapping", async () => {
  const host = new FakeAppServerHost();
  const identifiers = [];
  const first = await deliverCodexPlacement({
    ...deliveryOptions(host),
    onHostIdentifiers: async (value) => identifiers.push(structuredClone(value)),
  });
  assert.equal(first.delivered, true);
  assert.equal(identifiers.length, 3);
  assert.deepEqual(identifiers[0], {
    placementId: first.receipt.placementId,
    threadId: first.receipt.threadId,
  });
  assert.equal(identifiers[1].instructionSourcesVerified, true);
  assert.deepEqual(identifiers[1].instructionSources, []);
  assert.equal(identifiers[2].turnId, first.receipt.turnId);

  const retry = await deliverCodexPlacement({
    ...deliveryOptions(host),
    existingHostIdentifiers: {
      ...identifiers[1],
      turnId: identifiers[2].turnId,
    },
  });
  assert.equal(retry.delivered, true);
  assert.equal(retry.receipt.threadId, first.receipt.threadId);
  assert.equal(host.threadStartCalls.length, 1);
  assert.equal(host.turnStartCalls.length, 1);
});

test("an instruction-source failure persists the empty task and retry never duplicates or starts it", async () => {
  const host = new FakeAppServerHost({ instructionSources: ["/workspace/AGENTS.md"] });
  const identifiers = [];
  const first = await deliverCodexPlacement({
    ...deliveryOptions(host),
    onHostIdentifiers: async (value) => identifiers.push(structuredClone(value)),
  });

  assert.equal(first.delivered, false);
  assert.equal(first.code, "INSTRUCTION_SOURCE_LEAK");
  assert.equal(identifiers.length, 2);
  assert.equal(identifiers[0].threadId, identifiers[1].threadId);
  assert.equal(identifiers[1].instructionSourcesVerified, true);
  assert.deepEqual(identifiers[1].instructionSources, ["/workspace/AGENTS.md"]);

  const retry = await deliverCodexPlacement({
    ...deliveryOptions(host),
    existingHostIdentifiers: identifiers[1],
  });
  assert.equal(retry.delivered, false);
  assert.equal(retry.code, "INSTRUCTION_SOURCE_LEAK");
  assert.equal(host.threadStartCalls.length, 1);
  assert.equal(host.turnStartCalls.length, 0);
});

test("a mapped zero-turn task resumes only after durable instruction isolation", async () => {
  const host = new FakeAppServerHost({ failNameOnce: true });
  const identifiers = [];
  const first = await deliverCodexPlacement({
    ...deliveryOptions(host),
    onHostIdentifiers: async (value) => identifiers.push(structuredClone(value)),
  });
  assert.equal(first.delivered, false);
  assert.equal(first.code, "TURN_FAILED");

  const verified = identifiers.find((value) => value.instructionSourcesVerified);
  const retry = await deliverCodexPlacement({
    ...deliveryOptions(host),
    existingHostIdentifiers: verified,
  });
  assert.equal(retry.delivered, true);
  assert.equal(host.threadStartCalls.length, 1);
  assert.equal(host.turnStartCalls.length, 1);
});

test("an ambiguous persistence failure recovers the completed task without duplicating it", async () => {
  const host = new FakeAppServerHost();
  const first = await deliverCodexPlacement({
    ...deliveryOptions(host),
    onHostIdentifiers: async (identifiers) => {
      if (identifiers.turnId) throw new Error("simulated receipt store outage");
    },
  });
  assert.equal(first.delivered, false);
  assert.equal(first.code, "TURN_FAILED");
  await new Promise((resolve) => queueMicrotask(resolve));

  const retry = await deliverCodexPlacement(deliveryOptions(host));
  assert.equal(retry.delivered, true);
  assert.equal(host.threadStartCalls.length, 1);
  assert.equal(host.turnStartCalls.length, 1);
});

test("a task whose immediate durable mapping fails is archived before delivery stops", async () => {
  const host = new FakeAppServerHost();
  const result = await deliverCodexPlacement({
    ...deliveryOptions(host),
    onHostIdentifiers: async () => { throw new Error("simulated local disk failure"); },
  });

  assert.equal(result.delivered, false);
  assert.equal(result.code, "TURN_FAILED");
  assert.equal(host.threadStartCalls.length, 1);
  assert.equal(host.turnStartCalls.length, 0);
  assert.deepEqual(host.archiveCalls, [{ threadId: "sponsored-1" }]);
});

test("retrying an archived placement never creates a duplicate task or turn", async () => {
  const host = new FakeAppServerHost();
  const options = deliveryOptions(host);
  const first = await deliverCodexPlacement(options);
  host.threads.get(first.receipt.threadId).archived = true;

  const retry = await deliverCodexPlacement(options);

  assert.equal(retry.delivered, false);
  assert.equal(retry.code, "TASK_NOT_LIST_VISIBLE");
  assert.equal(host.threadStartCalls.length, 1);
  assert.equal(host.turnStartCalls.length, 1);
});

function observation(overrides = {}) {
  return {
    interfaceAvailable: true,
    cliVersion: "0.146.1",
    activeTaskIdBefore: "active-task",
    activeTaskIdAfter: "active-task",
    createdTaskId: "sponsored-task",
    listedTaskIds: ["active-task", "sponsored-task"],
    sidebarVerified: true,
    restartReadable: true,
    displayTurnCompleted: true,
    toolItemCount: 0,
    instructionSources: [],
    ...overrides,
  };
}

function deliveryOptions(host) {
  return {
    placement: SIGNED_PLACEMENT_FIXTURE,
    publicKeyPem: TEST_MARKETPLACE_PUBLIC_KEY_PEM,
    now: NOW,
    isolatedCwd: "/tmp/ad-daddy-empty",
    createConnection: host.createConnection,
    readActiveTaskId: async () => "active-task",
    verifySidebarVisibility: async ({ threadId, title }) =>
      host.hasThread(threadId) && title.startsWith("Sponsored · "),
  };
}

class FakeAppServerHost {
  threads = new Map();
  connectionCount = 0;
  threadStartCalls = [];
  turnStartCalls = [];
  interruptCalls = [];
  archiveCalls = [];
  #nextThread = 1;
  #nextTurn = 1;
  #options;

  constructor(options = {}) {
    this.#options = options;
  }

  hasThread = (threadId) => this.threads.has(threadId);

  createConnection = async () => {
    this.connectionCount += 1;
    const notifications = [];
    let waiter;
    const emit = (message) => {
      if (waiter) {
        const resolve = waiter;
        waiter = undefined;
        resolve(message);
      } else {
        notifications.push(message);
      }
    };

    return {
      cliVersion: "0.146.1",
      userAgent: "Codex Desktop/0.146.1 (test)",
      builtInToolsDisabled: this.#options.builtInToolsDisabled === true,
      request: async (method, params) => {
        if (method === "thread/list") {
          return {
            data: [...this.threads.values()]
              .filter(
                (thread) =>
                  Boolean(thread.archived) === Boolean(params.archived),
              )
              .map(summary),
            nextCursor: null,
          };
        }
        if (method === "thread/start") {
          this.threadStartCalls.push(structuredClone(params));
          const id = `sponsored-${this.#nextThread++}`;
          const thread = {
            id,
            name: null,
            preview: "",
            turns: [],
            archived: false,
          };
          this.threads.set(id, thread);
          return {
            thread: summary(thread),
            instructionSources: this.#options.instructionSources ?? [],
          };
        }
        if (method === "thread/name/set") {
          if (this.#options.failNameOnce) {
            this.#options.failNameOnce = false;
            throw new Error("simulated thread naming failure");
          }
          this.threads.get(params.threadId).name = params.name;
          return {};
        }
        if (method === "turn/start") {
          this.turnStartCalls.push(structuredClone(params));
          const thread = this.threads.get(params.threadId);
          thread.preview = params.input[0].text;
          const id = `turn-${this.#nextTurn++}`;
          const turn = { id, status: "inProgress", items: [] };
          thread.turns.push(turn);
          queueMicrotask(() => {
            if (this.#options.emitToolItem) {
              const item = {
                type: "commandExecution",
                id: "tool-1",
                command: "echo forbidden",
                status: "inProgress",
              };
              turn.items.push(item);
              emit({
                method: "item/started",
                params: { threadId: thread.id, turnId: id, item },
              });
              return;
            }
            if (this.#options.neverComplete) return;
            const text =
              this.#options.output ??
              "Sponsored via Ad Daddy\nNeon — Add Postgres without leaving Codex\nNeon offers serverless Postgres. Reward: $5.00.\nMatched: TypeScript, database integration.";
            const item = {
              type: "agentMessage",
              id: "answer-1",
              text,
              phase: "final_answer",
            };
            turn.items.push(item);
            emit({
              method: "item/completed",
              params: { threadId: thread.id, turnId: id, item },
            });
            turn.status = "completed";
            emit({
              method: "turn/completed",
              params: { threadId: thread.id, turn: structuredClone(turn) },
            });
          });
          return { turn: { id, status: "inProgress", items: [] } };
        }
        if (method === "turn/interrupt") {
          this.interruptCalls.push(structuredClone(params));
          const thread = this.threads.get(params.threadId);
          const turn = thread.turns.find((candidate) => candidate.id === params.turnId);
          if (turn) turn.status = "interrupted";
          return {};
        }
        if (method === "thread/archive") {
          this.archiveCalls.push(structuredClone(params));
          const thread = this.threads.get(params.threadId);
          if (thread) thread.archived = true;
          return {};
        }
        if (method === "thread/read") {
          if (this.#options.failRestartRead && this.connectionCount > 1) {
            throw new Error("simulated restart read failure");
          }
          const thread = this.threads.get(params.threadId);
          if (!thread) throw new Error("thread not found");
          return { thread: structuredClone(thread) };
        }
        throw new Error(`unexpected method ${method}`);
      },
      nextNotification: async ({ signal } = {}) => {
        if (notifications.length > 0) return notifications.shift();
        return await new Promise((resolve, reject) => {
          waiter = resolve;
          signal?.addEventListener(
            "abort",
            () => {
              waiter = undefined;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      close: async () => {},
    };
  };
}

function summary(thread) {
  return {
    id: thread.id,
    name: thread.name,
    preview: thread.preview,
    turns: [],
  };
}
