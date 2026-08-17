import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

import {
  PlacementValidationError,
  type PlacementPayload,
  type SignedPlacement,
  validateSignedPlacement,
} from "./contract.js";
import {
  SIGNED_HTML_FALLBACK,
  assessCodexCapability,
  CODEX_NATIVE_DELIVERY_VERSIONS,
  type CodexCapabilityCode,
} from "./codex-capability.js";
import {
  SPONSORED_DISPLAY_INSTRUCTION,
  renderPlacementData,
} from "./display-instruction.js";

export const CODEX_DISPLAY_BUDGET_V1 = Object.freeze({
  version: 1 as const,
  timeoutMs: 45_000,
  outputCharacterBudget: 4_000,
});
const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
]);
const DISABLED_CODEX_FEATURES = [
  "apps",
  "plugins",
  "browser_use",
  "computer_use",
  "image_generation",
  "multi_agent",
  "workspace_dependencies",
] as const;

export type CodexDeliveryFailureCode =
  | Exclude<CodexCapabilityCode, "SUPPORTED">
  | "PLACEMENT_INVALID"
  | "TURN_TIMEOUT"
  | "OUTPUT_BUDGET_EXCEEDED"
  | "TURN_FAILED"
  | "EXISTING_TURN_INCOMPLETE"
  | "DISPLAY_OUTPUT_INVALID"
  | "BUILT_IN_TOOLS_UNVERIFIED"
  | "PRIVATE_TEAM_MODE_FORBIDDEN";

export interface CodexDeliveryReceipt {
  placementId: string;
  threadId: string;
  turnId: string;
  title: string;
  output: string;
  outputSha256: string;
  advertiserDisplayName: string;
  receiverAmountMinor: number;
  currency: "USD";
  signalsUsed: readonly string[];
  toolItemCount: number;
  cliVersion: string;
  userAgent: string | null;
  model: string | null;
  isolatedCwd: string;
  activeTaskIdBefore: string;
  activeTaskIdAfter: string;
  listedAfterRestart: boolean;
  restartReadable: boolean;
  sidebarVerified: boolean;
  instructionSources: string[];
  budgetVersion: 1;
  /** Proof-only local team tasks are never eligible for monetary settlement. */
  privateTeamPoc?: true;
}

export type CodexDeliveryResult =
  | {
      delivered: true;
      code: "SUPPORTED";
      receipt: CodexDeliveryReceipt;
      fallback: typeof SIGNED_HTML_FALLBACK;
    }
  | {
      delivered: false;
      code: CodexDeliveryFailureCode;
      reason: string;
      receipt?: never;
      fallback: typeof SIGNED_HTML_FALLBACK;
    };

export interface AppServerNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface CodexAppServerConnection {
  cliVersion: string;
  userAgent: string | null;
  allowedInstructionSources?: string[];
  /** Set only by a host adapter that can prove all built-in tools are unavailable. */
  builtInToolsDisabled?: boolean;
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  nextNotification(options?: { signal?: AbortSignal }): Promise<AppServerNotification>;
  close(): Promise<void>;
}

export interface DeliverCodexPlacementOptions {
  placement: SignedPlacement;
  publicKeyPem: string;
  isolatedCwd: string;
  createConnection: () => Promise<CodexAppServerConnection>;
  readActiveTaskId: () => Promise<string | null>;
  verifySidebarVisibility?: (input: {
    threadId: string;
    title: string;
  }) => Promise<boolean>;
  now?: Date;
  model?: string;
  timeoutMs?: number;
  outputCharacterBudget?: number;
  deploymentEnvironment?: "development" | "test" | "staging" | "production";
  existingHostIdentifiers?: {
    threadId: string;
    turnId?: string;
    instructionSourcesVerified?: boolean;
    instructionSources?: string[];
  };
  onHostIdentifiers?: (input: {
    placementId: string;
    threadId: string;
    turnId?: string;
    instructionSourcesVerified?: boolean;
    instructionSources?: string[];
  }) => Promise<void>;
}

interface ThreadItem {
  type?: string;
  id?: string;
  text?: string;
  phase?: string | null;
}

interface TurnRecord {
  id: string;
  status: string;
  items?: ThreadItem[];
}

interface ThreadRecord {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  turns?: TurnRecord[];
}

interface ThreadListPage {
  data: ThreadRecord[];
  nextCursor?: string | null;
}

export function deliverCodexPlacement(
  options: DeliverCodexPlacementOptions,
): Promise<CodexDeliveryResult> {
  return deliverCodexPlacementInternal(options, false);
}

/**
 * Private, no-money proof mode for a trusted team running the same repository.
 * It keeps the isolated/read-only/no-network task contract, but does not claim
 * that the host can prove every built-in tool is disabled.
 */
export function deliverPrivateTeamCodexPlacement(
  options: DeliverCodexPlacementOptions,
): Promise<CodexDeliveryResult> {
  return deliverCodexPlacementInternal(options, true);
}

async function deliverCodexPlacementInternal(
  options: DeliverCodexPlacementOptions,
  privateTeamPoc: boolean,
): Promise<CodexDeliveryResult> {
  let payload;
  try {
    payload = validateSignedPlacement(
      options.placement,
      options.publicKeyPem,
      options.now,
    );
  } catch (error) {
    if (error instanceof PlacementValidationError) {
      return failure("PLACEMENT_INVALID", `${error.code}: ${error.message}`);
    }
    throw error;
  }

  if (privateTeamPoc && (options.deploymentEnvironment !== "development" || payload.payout.amountMinor !== 0)) {
    return failure(
      "PRIVATE_TEAM_MODE_FORBIDDEN",
      "Private team mode requires an explicit development environment and accepts zero-money placements only.",
    );
  }

  let activeTaskIdBefore: string | null;
  try {
    activeTaskIdBefore = await options.readActiveTaskId();
  } catch {
    activeTaskIdBefore = null;
  }
  if (!activeTaskIdBefore) {
    return failure(
      "ACTIVE_TASK_UNVERIFIABLE",
      "The integration cannot directly read the active task before insertion.",
    );
  }
  let connection: CodexAppServerConnection;
  try {
    connection = await options.createConnection();
  } catch (error) {
    return failure(
      "HOST_INTERFACE_UNAVAILABLE",
      error instanceof Error ? error.message : "Codex App Server is unavailable.",
    );
  }
  if (connection.builtInToolsDisabled !== true && !privateTeamPoc) {
    await connection.close();
    return failure(
      "BUILT_IN_TOOLS_UNVERIFIED",
      "Native delivery requires host-provided proof that every built-in tool is disabled.",
    );
  }

  const title = `AD DADDY: ${payload.title}`;
  let thread: ThreadRecord | null = null;
  let instructionSources: string[] = [];
  let unexpectedInstructionSources: string[] = [];
  let turnId: string | null = null;
  let output = "";
  let toolItemCount = 0;

  try {
    if (options.existingHostIdentifiers) {
      thread = await readThread(connection, options.existingHostIdentifiers.threadId);
    } else {
      const discovered = await findPlacementThread(connection, payload.placementId);
      thread = discovered ? await readThread(connection, discovered.id) : null;
    }
    if (thread && thread.name !== title) {
      await connection.request("thread/name/set", {
        threadId: thread.id,
        name: title,
      });
      thread = { ...thread, name: title };
    }
    let needsDisplayTurn = false;
    if (thread) {
      const existing = thread;
      const turns = existing.turns ?? [];
      if (turns[0]?.id) {
        // A restarted client may have persisted the task ID just before the
        // host accepted a display turn. Persist the recovered turn ID before
        // any later validation failure so the caller cannot open a fallback
        // surface for content that may already be visible.
        await options.onHostIdentifiers?.({
          placementId: payload.placementId,
          threadId: existing.id,
          turnId: turns[0].id,
        });
      }
      if (turns.length === 0) {
        if (!options.existingHostIdentifiers?.instructionSourcesVerified) {
          return failure(
            "EXISTING_TURN_INCOMPLETE",
            "The placement owns an empty task whose instruction isolation was not durably verified; retry will not create a second task or start a turn.",
          );
        }
        const persistedSources =
          options.existingHostIdentifiers.instructionSources ?? [];
        if (persistedSources.length > 0) {
          return failure(
            "INSTRUCTION_SOURCE_LEAK",
            `Codex loaded unexpected instruction files into the dedicated sponsored task: ${persistedSources.join(", ")}`,
          );
        }
        // A prior attempt can fail after thread/start but before turn/start. The
        // caller-owned mapping makes that empty task recoverable without
        // creating a second sponsored task.
        thread = existing;
        needsDisplayTurn = true;
      } else if (turns.length !== 1 || turns[0]?.status !== "completed") {
        return failure(
          "EXISTING_TURN_INCOMPLETE",
          "The placement already owns a task whose single display turn did not complete; retry will not start a second turn.",
        );
      }
      if (!needsDisplayTurn) {
        const inspected = inspectTurn(turns[0]!);
        if (inspected.toolItemCount > 0) {
          return failure(
            "TOOL_ITEM_EMITTED",
            "The existing sponsored display turn contains a forbidden tool item.",
          );
        }
        turnId = turns[0]!.id;
        output = inspected.output;
        toolItemCount = inspected.toolItemCount;
      }
    } else {
      const started = await connection.request<{
        thread: ThreadRecord;
        instructionSources?: string[];
      }>("thread/start", {
        cwd: options.isolatedCwd,
        runtimeWorkspaceRoots: [],
        environments: [],
        dynamicTools: [],
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: false,
        serviceName: "ad-daddy",
        model: options.model,
        developerInstructions: SPONSORED_DISPLAY_INSTRUCTION,
        config: toolFreeConfig(),
      });
      thread = started.thread;
      // Persist the task as soon as the host creates it. Every operation below
      // this line can fail, and a zero-turn task has no placement marker for
      // discovery through thread/list.
      try {
        await options.onHostIdentifiers?.({
          placementId: payload.placementId,
          threadId: thread.id,
        });
      } catch (error) {
        await safelyArchive(connection, thread.id);
        throw error;
      }
      instructionSources = started.instructionSources ?? [];
      unexpectedInstructionSources = instructionSources.filter(
        (source) => !connection.allowedInstructionSources?.includes(source),
      );
      await options.onHostIdentifiers?.({
        placementId: payload.placementId,
        threadId: thread.id,
        instructionSourcesVerified: true,
        instructionSources: unexpectedInstructionSources,
      });
      if (unexpectedInstructionSources.length > 0) {
        return failure(
          "INSTRUCTION_SOURCE_LEAK",
          `Codex loaded unexpected instruction files into the dedicated sponsored task: ${unexpectedInstructionSources.join(", ")}`,
        );
      }
      needsDisplayTurn = true;
    }

    if (needsDisplayTurn && thread) {
      await connection.request("thread/name/set", {
        threadId: thread.id,
        name: title,
      });
      const startedTurn = await connection.request<{ turn: TurnRecord }>(
        "turn/start",
        {
          threadId: thread.id,
          input: [{ type: "text", text: renderPlacementData(payload) }],
          cwd: options.isolatedCwd,
          runtimeWorkspaceRoots: [],
          environments: [],
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          model: options.model,
        },
      );
      turnId = startedTurn.turn.id;
      await options.onHostIdentifiers?.({
        placementId: payload.placementId,
        threadId: thread.id,
        turnId,
      });

      const watched = await watchDisplayTurn(connection, thread.id, turnId, {
        timeoutMs: options.timeoutMs ?? CODEX_DISPLAY_BUDGET_V1.timeoutMs,
        outputCharacterBudget:
          options.outputCharacterBudget ??
          CODEX_DISPLAY_BUDGET_V1.outputCharacterBudget,
      });
      if (!watched.completed) {
        await safelyInterrupt(connection, thread.id, turnId);
        return failure(watched.code, watched.reason);
      }
      output = watched.output;
      toolItemCount = watched.toolItemCount;
    }
  } catch (error) {
    return failure(
      thread ? "TURN_FAILED" : "HOST_INTERFACE_UNAVAILABLE",
      error instanceof Error ? error.message : "Codex App Server request failed.",
    );
  } finally {
    await connection.close();
  }

  if (!thread || !turnId) {
    return failure("TASK_NOT_CREATED", "Codex did not return a sponsored task and turn.");
  }
  const missingDisplayField = requiredDisplayFields(payload).find(
    (field) => !output.toLocaleLowerCase().includes(field.toLocaleLowerCase()),
  );
  if (!output.startsWith("Sponsored via Ad Daddy") || missingDisplayField) {
    return failure(
      "DISPLAY_OUTPUT_INVALID",
      missingDisplayField
        ? `The display response omitted required placement field: ${missingDisplayField}`
        : "The display response omitted the required Ad Daddy sponsorship disclosure.",
    );
  }

  let restartConnection: CodexAppServerConnection;
  try {
    restartConnection = await options.createConnection();
  } catch (error) {
    return failure(
      "TASK_NOT_RESTART_READABLE",
      error instanceof Error ? error.message : "App Server restart failed.",
    );
  }

  let restartReadable = false;
  let listedTaskIds: string[] = [];
  try {
    const [restartedThread, listed] = await Promise.all([
      readThread(restartConnection, thread.id),
      isThreadListed(restartConnection, thread.id, title),
    ]);
    restartReadable = restartedThread.id === thread.id;
    listedTaskIds = listed ? [thread.id] : [];
  } catch {
    restartReadable = false;
  } finally {
    await restartConnection.close();
  }

  let activeTaskIdAfter: string | null;
  try {
    activeTaskIdAfter = await options.readActiveTaskId();
  } catch {
    activeTaskIdAfter = null;
  }
  let sidebarVerified =
    CODEX_NATIVE_DELIVERY_VERSIONS.includes(connection.cliVersion) &&
    listedTaskIds.includes(thread.id);
  if (options.verifySidebarVisibility) {
    try {
      sidebarVerified = await options.verifySidebarVisibility({
        threadId: thread.id,
        title,
      });
    } catch {
      sidebarVerified = false;
    }
  }
  const capability = assessCodexCapability({
    interfaceAvailable: true,
    cliVersion: connection.cliVersion,
    activeTaskIdBefore,
    activeTaskIdAfter,
    createdTaskId: thread.id,
    listedTaskIds,
    sidebarVerified,
    restartReadable,
    displayTurnCompleted: true,
    toolItemCount,
    instructionSources: unexpectedInstructionSources,
  });
  if (!capability.nativeDelivery) {
    return failure(
      capability.code as Exclude<CodexCapabilityCode, "SUPPORTED">,
      capability.reason,
    );
  }

  return {
    delivered: true,
    code: "SUPPORTED",
    fallback: SIGNED_HTML_FALLBACK,
    receipt: {
      placementId: payload.placementId,
      threadId: thread.id,
      turnId,
      title,
      output,
      outputSha256: createHash("sha256").update(output).digest("hex"),
      advertiserDisplayName: payload.advertiser.displayName,
      receiverAmountMinor: payload.payout.amountMinor,
      currency: payload.payout.currency,
      signalsUsed: Object.freeze([...payload.signalsUsed]),
      toolItemCount,
      cliVersion: connection.cliVersion,
      userAgent: connection.userAgent,
      model: options.model ?? null,
      isolatedCwd: options.isolatedCwd,
      activeTaskIdBefore,
      activeTaskIdAfter: activeTaskIdAfter!,
      listedAfterRestart: listedTaskIds.includes(thread.id),
      restartReadable,
      sidebarVerified,
      instructionSources,
      budgetVersion: CODEX_DISPLAY_BUDGET_V1.version,
      ...(privateTeamPoc ? { privateTeamPoc: true as const } : {}),
    },
  };
}

function requiredDisplayFields(payload: PlacementPayload): readonly string[] {
  return [
    payload.advertiser.displayName,
    payload.title,
    ...(payload.nonCashReward
      ? [`${payload.nonCashReward.amount}`, payload.nonCashReward.label]
      : [`${(payload.payout.amountMinor / 100).toFixed(2)}`]),
    ...payload.signalsUsed,
  ];
}

export interface SpawnCodexAppServerOptions {
  command?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
}

export async function createCodexAppServerConnection(
  options: SpawnCodexAppServerOptions = {},
): Promise<CodexAppServerConnection> {
  const command = options.command ?? "codex";
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("App Server request timeout must be a positive integer.");
  }
  const child = spawn(
    command,
    [
      "app-server",
      "--stdio",
      ...DISABLED_CODEX_FEATURES.flatMap((feature) => ["--disable", feature]),
      "-c",
      "mcp_servers={}",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const rpc = new StdioRpcConnection(child, requestTimeoutMs);
  let initialized: { userAgent?: string; codexHome?: string };
  try {
    initialized = await rpc.request<{ userAgent?: string; codexHome?: string }>("initialize", {
      clientInfo: {
        name: "ad_daddy",
        title: "Ad Daddy sponsored display",
        version: options.clientVersion ?? "0.1.0",
      },
      // runtimeWorkspaceRoots is required to prove the sponsored task has no
      // inherited workspace, and App Server gates that field behind this
      // explicit client capability.
      capabilities: { experimentalApi: true },
    });
  } catch (error) {
    await rpc.close();
    throw error;
  }
  rpc.notify("initialized", {});
  const versionMatch = initialized.userAgent?.match(/(?:Codex Desktop|codex-cli)\/([^\s]+)/);
  return {
    cliVersion: versionMatch?.[1] ?? "unknown",
    userAgent: initialized.userAgent ?? null,
    allowedInstructionSources: initialized.codexHome
      ? [`${initialized.codexHome}/AGENTS.md`]
      : [],
    request: rpc.request,
    nextNotification: rpc.nextNotification,
    close: rpc.close,
  };
}

async function watchDisplayTurn(
  connection: CodexAppServerConnection,
  threadId: string,
  turnId: string,
  limits: { timeoutMs: number; outputCharacterBudget: number },
): Promise<
  | { completed: true; output: string; toolItemCount: number }
  | {
      completed: false;
      code: "TURN_TIMEOUT" | "OUTPUT_BUDGET_EXCEEDED" | "TOOL_ITEM_EMITTED" | "TURN_FAILED";
      reason: string;
    }
> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Sponsored display turn timed out.")),
    limits.timeoutMs,
  );
  let output = "";

  try {
    while (true) {
      let notification: AppServerNotification;
      try {
        notification = await connection.nextNotification({
          signal: controller.signal,
        });
      } catch {
        return {
          completed: false,
          code: "TURN_TIMEOUT",
          reason: "The sponsored display turn exceeded its versioned timeout.",
        };
      }
      const params = notification.params ?? {};
      if (params.threadId !== threadId) continue;
      const item = asItem(params.item);
      if (item && TOOL_ITEM_TYPES.has(item.type ?? "")) {
        return {
          completed: false,
          code: "TOOL_ITEM_EMITTED",
          reason: `The display turn emitted forbidden item type ${item.type}.`,
        };
      }
      if (notification.method === "item/agentMessage/delta") {
        const delta = typeof params.delta === "string" ? params.delta : "";
        output += delta;
        if (output.length > limits.outputCharacterBudget) {
          return {
            completed: false,
            code: "OUTPUT_BUDGET_EXCEEDED",
            reason: "The sponsored display response exceeded its versioned output budget.",
          };
        }
      }
      if (
        notification.method === "item/completed" &&
        item?.type === "agentMessage" &&
        item.phase === "final_answer"
      ) {
        output = item.text ?? output;
        if (output.length > limits.outputCharacterBudget) {
          return {
            completed: false,
            code: "OUTPUT_BUDGET_EXCEEDED",
            reason: "The sponsored display response exceeded its versioned output budget.",
          };
        }
      }
      if (notification.method === "turn/completed") {
        const turn = params.turn as TurnRecord | undefined;
        if (turn?.id !== turnId) continue;
        if (turn.status !== "completed") {
          return {
            completed: false,
            code: "TURN_FAILED",
            reason: `The sponsored display turn ended with status ${turn.status}.`,
          };
        }
        const inspected = inspectTurn(turn);
        const finalOutput = output || inspected.output;
        if (finalOutput.length > limits.outputCharacterBudget) {
          return {
            completed: false,
            code: "OUTPUT_BUDGET_EXCEEDED",
            reason: "The sponsored display response exceeded its versioned output budget.",
          };
        }
        if (inspected.toolItemCount > 0) {
          return {
            completed: false,
            code: "TOOL_ITEM_EMITTED",
            reason: "The completed sponsored display turn contains a forbidden tool item.",
          };
        }
        return { completed: true, output: finalOutput, toolItemCount: 0 };
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function findPlacementThread(
  connection: CodexAppServerConnection,
  placementId: string,
): Promise<ThreadRecord | null> {
  const markers = [
    `"placementId": "${placementId}"`,
    `Placement ID: ${placementId}`,
  ];
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    do {
      // The placement ID is stable across display-title changes, so retries
      // can recover tasks created by an older adapter without duplicating them.
      const page = await listThreadPage(connection, cursor, archived, placementId);
      const found = page.data.find((candidate) =>
        markers.some((marker) => candidate.preview?.includes(marker)),
      );
      if (found) return found;
      cursor = page.nextCursor ?? null;
    } while (cursor);
  }
  return null;
}

async function isThreadListed(
  connection: CodexAppServerConnection,
  threadId: string,
  title: string,
): Promise<boolean> {
  let cursor: string | null = null;
  do {
    const page = await listThreadPage(connection, cursor, false, title);
    if (page.data.some((thread) => thread.id === threadId)) return true;
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return false;
}

function listThreadPage(
  connection: CodexAppServerConnection,
  cursor: string | null,
  archived: boolean,
  searchTerm: string,
): Promise<ThreadListPage> {
  return connection.request("thread/list", {
    cursor,
    limit: 100,
    sortKey: "created_at",
    sortDirection: "desc",
    sourceKinds: ["cli", "vscode"],
    archived,
    useStateDbOnly: false,
    searchTerm,
  });
}

async function readThread(
  connection: CodexAppServerConnection,
  threadId: string,
): Promise<ThreadRecord> {
  const result = await connection.request<{ thread: ThreadRecord }>(
    "thread/read",
    { threadId, includeTurns: true },
  );
  return result.thread;
}

function inspectTurn(turn: TurnRecord): {
  output: string;
  toolItemCount: number;
} {
  const items = turn.items ?? [];
  let output = "";
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "agentMessage" && item.phase === "final_answer") {
      output = item.text ?? "";
      break;
    }
  }
  return {
    output,
    toolItemCount: items.filter((item) => TOOL_ITEM_TYPES.has(item.type ?? ""))
      .length,
  };
}

function asItem(value: unknown): ThreadItem | null {
  return value && typeof value === "object" ? (value as ThreadItem) : null;
}

function toolFreeConfig(): Record<string, unknown> {
  return {
    project_doc_max_bytes: 0,
    project_doc_fallback_filenames: [],
    mcp_servers: {},
    web_search: "disabled",
    apps: { _default: { enabled: false } },
    features: Object.fromEntries(
      DISABLED_CODEX_FEATURES.map((feature) => [feature, false]),
    ),
  };
}

async function safelyInterrupt(
  connection: CodexAppServerConnection,
  threadId: string,
  turnId: string,
): Promise<void> {
  try {
    await connection.request("turn/interrupt", { threadId, turnId });
  } catch {
    // Delivery already fails closed; interruption is best-effort after host failure.
  }
}

async function safelyArchive(
  connection: CodexAppServerConnection,
  threadId: string,
): Promise<void> {
  try {
    await connection.request("thread/archive", { threadId });
  } catch {
    // If durable identifier persistence fails, hiding the orphaned zero-turn
    // task is best-effort. Delivery still fails closed and yields no receipt.
  }
}

function failure(
  code: CodexDeliveryFailureCode,
  reason: string,
): CodexDeliveryResult {
  return {
    delivered: false,
    code,
    reason,
    fallback: SIGNED_HTML_FALLBACK,
  };
}

type ChildProcess = ReturnType<typeof spawn>;

class StdioRpcConnection {
  readonly request: <T = unknown>(method: string, params: unknown) => Promise<T>;
  readonly nextNotification: (options?: {
    signal?: AbortSignal;
  }) => Promise<AppServerNotification>;
  readonly close: () => Promise<void>;
  readonly notify: (method: string, params: unknown) => void;

  #child: ChildProcess;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  #notifications: AppServerNotification[] = [];
  #notificationWaiters: Array<{
    resolve: (value: AppServerNotification) => void;
    reject: (reason: unknown) => void;
  }> = [];
  #stderr = "";
  #closed = false;
  readonly #requestTimeoutMs: number;

  constructor(child: ChildProcess, requestTimeoutMs: number) {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error("App Server request timeout must be a positive integer.");
    }
    this.#child = child;
    this.#requestTimeoutMs = requestTimeoutMs;
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => this.#receive(line));
    child.stderr?.on("data", (chunk) => {
      this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-65_536);
    });
    child.on("error", (error) => this.#failAll(error));
    child.on("exit", (code) => {
      if (!this.#closed) {
        this.#failAll(
          new Error(
            `Codex App Server exited with code ${String(code)}. ${this.#stderr}`.trim(),
          ),
        );
      }
    });

    this.request = <T>(method: string, params: unknown): Promise<T> => {
      const id = this.#nextId++;
      return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`Codex App Server request timed out: ${method}`));
        }, this.#requestTimeoutMs);
        this.#pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value as T);
          },
          reject: (reason) => {
            clearTimeout(timeout);
            reject(reason);
          },
        });
        try {
          this.#write({ id, method, params });
        } catch (error) {
          this.#pending.delete(id);
          clearTimeout(timeout);
          reject(error);
        }
      });
    };
    this.notify = (method, params) => this.#write({ method, params });
    this.nextNotification = ({ signal } = {}) => {
      const queued = this.#notifications.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<AppServerNotification>((resolve, reject) => {
        const waiters = this.#notificationWaiters;
        function cleanup() {
          signal?.removeEventListener("abort", onAbort);
        }
        const waiter: {
          resolve: (value: AppServerNotification) => void;
          reject: (reason: unknown) => void;
        } = {
          resolve: (value: AppServerNotification) => {
            cleanup();
            resolve(value);
          },
          reject: (reason: unknown) => {
            cleanup();
            reject(reason);
          },
        };
        const onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          cleanup();
          reject(signal?.reason);
        };
        waiters.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    };
    this.close = async () => {
      this.#closed = true;
      this.#failAll(new Error("Codex App Server connection closed."));
      child.stdin?.end();
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        function finish() {
          if (settled) return;
          settled = true;
          clearTimeout(terminateTimer);
          clearTimeout(forceTimer);
          child.removeListener("exit", finish);
          resolve();
        }
        const terminateTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        const forceTimer = setTimeout(finish, 2_000);
        child.once("exit", finish);
        child.kill("SIGTERM");
      });
    };
  }

  #write(message: unknown): void {
    if (this.#closed || !this.#child.stdin?.writable) {
      throw new Error("Codex App Server connection is closed.");
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.#failAll(new Error(`Invalid App Server JSON: ${line}`));
      return;
    }
    if (typeof message.id === "number" && !("method" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    const notification: AppServerNotification = {
      method: message.method,
      params:
        message.params && typeof message.params === "object"
          ? (message.params as Record<string, unknown>)
          : undefined,
    };
    if (typeof message.id === "number") {
      this.#write({
        id: message.id,
        error: {
          code: -32000,
          message: "Ad Daddy display sessions do not permit tools or interaction.",
        },
      });
    }
    const waiter = this.#notificationWaiters.shift();
    if (waiter) waiter.resolve(notification);
    else if (this.#notifications.length < 1_024) {
      this.#notifications.push(notification);
    } else {
      this.#failAll(new Error("Codex App Server notification budget exceeded."));
      this.#child.kill("SIGTERM");
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const waiter of this.#notificationWaiters) waiter.reject(error);
    this.#notificationWaiters = [];
    this.#notifications = [];
  }
}
