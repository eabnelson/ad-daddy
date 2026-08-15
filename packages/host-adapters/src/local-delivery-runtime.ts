import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createCodexAppServerConnection,
  deliverCodexPlacement,
  type CodexAppServerConnection,
  type CodexDeliveryReceipt,
} from "./codex-app-server.js";
import { canonicalJson, type SignedPlacement, validateSignedPlacement } from "./contract.js";
import { deliverGenericPlacement, type GenericPlacementReceipt } from "./generic.js";

export interface ClearedPlacementEnvelope {
  receiverAccountId: string;
  installationId: string;
  placement: SignedPlacement;
}

export interface AuthorizedCodexHostContext {
  receiverAccountId: string;
  installationId: string;
  isolatedCwd: string;
  model?: string;
  createConnection: () => Promise<CodexAppServerConnection>;
  readActiveTaskId: () => Promise<string | null>;
  verifySidebarVisibility?: (input: { threadId: string; title: string }) => Promise<boolean>;
}

export interface LocalDeliveryRecord {
  placementId: string;
  receiverAccountId: string;
  installationId: string;
  signedPlacementSha256: string;
  status: "pending" | "native" | "fallback";
  hostSessionId?: string;
  hostTurnId?: string;
  hostInstructionSourcesVerified?: boolean;
  hostInstructionSources?: string[];
  nativeFailureCode?: string;
  receipt?: CodexDeliveryReceipt | GenericPlacementReceipt;
  updatedAt: string;
}

export interface LocalDeliveryStateStore {
  get(placementId: string): Promise<LocalDeliveryRecord | undefined>;
  put(record: LocalDeliveryRecord): Promise<void>;
}

/** Durable, user-owned state for local host task identifiers and receipts. */
export class JsonLocalDeliveryStateStore implements LocalDeliveryStateStore {
  readonly #path: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    if (!path.trim()) throw new Error("A local delivery state path is required");
    this.#path = path;
  }

  async get(placementId: string): Promise<LocalDeliveryRecord | undefined> {
    await this.#writeTail;
    return clone((await this.read()).find((record) => record.placementId === placementId));
  }

  async put(record: LocalDeliveryRecord): Promise<void> {
    assertDeliveryRecord(record);
    const operation = this.#writeTail.then(async () => {
      const records = await this.read();
      const index = records.findIndex((candidate) => candidate.placementId === record.placementId);
      if (index === -1) records.push(clone(record)!);
      else records[index] = clone(record)!;
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.#path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.#path);
    });
    this.#writeTail = operation.then(() => undefined, () => undefined);
    await operation;
  }

  private async read(): Promise<LocalDeliveryRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Local delivery state must be an array");
      for (const record of parsed) assertDeliveryRecord(record);
      return parsed as LocalDeliveryRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

export type LocalPlacementDeliveryResult =
  | { status: "no_placement" }
  | { status: "native" | "fallback"; record: LocalDeliveryRecord };

/**
 * Receiver-side application path from a cleared signed placement to one host
 * task or the signed HTML fallback. Host authority comes only from the local
 * installation, never from the marketplace response.
 */
export class CodexLocalDeliveryRuntime {
  readonly #store: LocalDeliveryStateStore;
  readonly #marketplacePublicKeyPem: string;
  readonly #authorizeHost: (
    placement: ClearedPlacementEnvelope,
  ) => Promise<AuthorizedCodexHostContext>;
  readonly #presentFallback: (receipt: GenericPlacementReceipt) => Promise<void>;
  readonly #inFlight = new Map<string, Promise<LocalPlacementDeliveryResult>>();

  constructor(input: {
    store: LocalDeliveryStateStore;
    marketplacePublicKeyPem: string;
    authorizeHost: (
      placement: ClearedPlacementEnvelope,
    ) => Promise<AuthorizedCodexHostContext>;
    presentFallback: (receipt: GenericPlacementReceipt) => Promise<void>;
  }) {
    if (!input.marketplacePublicKeyPem.trim()) {
      throw new Error("A pinned marketplace public key is required");
    }
    this.#store = input.store;
    this.#marketplacePublicKeyPem = input.marketplacePublicKeyPem;
    this.#authorizeHost = input.authorizeHost;
    this.#presentFallback = input.presentFallback;
  }

  async deliver(response: unknown, now = new Date()): Promise<LocalPlacementDeliveryResult> {
    const envelope = parseClearedPlacementEnvelope(response);
    if (!envelope) return { status: "no_placement" };
    const placementId = envelope.placement.payload.placementId;
    const active = this.#inFlight.get(placementId);
    if (active) return active;
    const delivery = this.deliverOnce(envelope, now).finally(() => {
      this.#inFlight.delete(placementId);
    });
    this.#inFlight.set(placementId, delivery);
    return delivery;
  }

  private async deliverOnce(
    envelope: ClearedPlacementEnvelope,
    now: Date,
  ): Promise<LocalPlacementDeliveryResult> {
    const payload = validateSignedPlacement(
      envelope.placement,
      this.#marketplacePublicKeyPem,
      now,
    );
    const host = await this.#authorizeHost(envelope);
    if (
      host.receiverAccountId !== envelope.receiverAccountId ||
      host.installationId !== envelope.installationId
    ) {
      throw new Error("Cleared placement does not belong to this authorized installation");
    }

    const signedPlacementSha256 = createHash("sha256")
      .update(canonicalJson(envelope.placement))
      .digest("hex");
    let record = await this.#store.get(payload.placementId);
    if (record) {
      if (
        record.receiverAccountId !== envelope.receiverAccountId ||
        record.installationId !== envelope.installationId ||
        record.signedPlacementSha256 !== signedPlacementSha256
      ) {
        throw new Error("Local placement idempotency collision");
      }
      if (record.receipt) return { status: record.status as "native" | "fallback", record };
    } else {
      record = {
        placementId: payload.placementId,
        receiverAccountId: envelope.receiverAccountId,
        installationId: envelope.installationId,
        signedPlacementSha256,
        status: "pending",
        updatedAt: now.toISOString(),
      };
      await this.#store.put(record);
    }

    // Never re-enter a task known to have loaded an unexpected instruction
    // source. The signed fallback is the only safe surface for this placement.
    if (record.nativeFailureCode !== "INSTRUCTION_SOURCE_LEAK") {
      const native = await deliverCodexPlacement({
        placement: envelope.placement,
        publicKeyPem: this.#marketplacePublicKeyPem,
        isolatedCwd: host.isolatedCwd,
        createConnection: host.createConnection,
        readActiveTaskId: host.readActiveTaskId,
        verifySidebarVisibility: host.verifySidebarVisibility,
        model: host.model,
        now,
        existingHostIdentifiers: record.hostSessionId
          ? {
              threadId: record.hostSessionId,
              turnId: record.hostTurnId,
              instructionSourcesVerified: record.hostInstructionSourcesVerified,
              instructionSources: record.hostInstructionSources,
            }
          : undefined,
        onHostIdentifiers: async (identifiers) => {
          record = {
            ...record!,
            hostSessionId: identifiers.threadId,
            hostTurnId: identifiers.turnId ?? record!.hostTurnId,
            hostInstructionSourcesVerified:
              identifiers.instructionSourcesVerified ?? record!.hostInstructionSourcesVerified,
            hostInstructionSources:
              identifiers.instructionSources ?? record!.hostInstructionSources,
            updatedAt: new Date().toISOString(),
          };
          await this.#store.put(record);
        },
      });
      if (native.delivered) {
        record = {
          ...record,
          status: "native",
          hostSessionId: native.receipt.threadId,
          hostTurnId: native.receipt.turnId,
          nativeFailureCode: undefined,
          receipt: native.receipt,
          updatedAt: new Date().toISOString(),
        };
        await this.#store.put(record);
        return { status: "native", record };
      }
      record = {
        ...record,
        nativeFailureCode: native.code,
        updatedAt: new Date().toISOString(),
      };
      await this.#store.put(record);
    }

    const fallback = deliverGenericPlacement({
      placement: envelope.placement,
      publicKeyPem: this.#marketplacePublicKeyPem,
      creativeUrl: payload.contentReference,
      now,
    });
    if (!fallback.delivered) throw new Error(fallback.reason);
    await this.#presentFallback(fallback.receipt);
    record = {
      ...record,
      status: "fallback",
      receipt: fallback.receipt,
      updatedAt: new Date().toISOString(),
    };
    await this.#store.put(record);
    return { status: "fallback", record };
  }
}

export function environmentCodexHostAuthorization(input: {
  receiverAccountId: string;
  installationId: string;
  isolatedCwd: string;
  environment?: NodeJS.ProcessEnv;
  model?: string;
}): (placement: ClearedPlacementEnvelope) => Promise<AuthorizedCodexHostContext> {
  const environment = input.environment ?? process.env;
  return async () => {
    return {
      receiverAccountId: input.receiverAccountId,
      installationId: input.installationId,
      isolatedCwd: input.isolatedCwd,
      model: input.model,
      createConnection: () => createCodexAppServerConnection(),
      readActiveTaskId: async () => environment.CODEX_THREAD_ID ?? null,
    };
  };
}

function parseClearedPlacementEnvelope(value: unknown): ClearedPlacementEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ClearedPlacementEnvelope> & { status?: unknown };
  if (candidate.status === "no_fill" || candidate.status === "no_placement") return null;
  if (!("placement" in candidate)) return null;
  if (
    typeof candidate.receiverAccountId !== "string" ||
    !candidate.receiverAccountId ||
    candidate.receiverAccountId.length > 128 ||
    typeof candidate.installationId !== "string" ||
    !candidate.installationId ||
    candidate.installationId.length > 128 ||
    !candidate.placement
  ) {
    throw new Error("Cleared placement envelope is invalid");
  }
  return candidate as ClearedPlacementEnvelope;
}

function assertDeliveryRecord(value: unknown): asserts value is LocalDeliveryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed local delivery record");
  }
  const record = value as Partial<LocalDeliveryRecord>;
  if (
    typeof record.placementId !== "string" ||
    !record.placementId ||
    typeof record.receiverAccountId !== "string" ||
    !record.receiverAccountId ||
    typeof record.installationId !== "string" ||
    !record.installationId ||
    !/^[a-f0-9]{64}$/.test(record.signedPlacementSha256 ?? "") ||
    !["pending", "native", "fallback"].includes(record.status ?? "") ||
    !Number.isFinite(Date.parse(record.updatedAt ?? ""))
  ) {
    throw new Error("Malformed local delivery record");
  }
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
