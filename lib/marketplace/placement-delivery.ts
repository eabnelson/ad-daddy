import {
  deliverCodexPlacement,
  deliverGenericPlacement,
  type CodexDeliveryReceipt,
  type DeliverCodexPlacementOptions,
  type GenericPlacementReceipt,
  type SignedPlacement,
} from "@ad-daddy/host-adapters";
import { KeyedSerialExecutor } from "../runtime/keyed-serial.ts";
import {
  validateCreative,
  type CreativeValidationPolicy,
  type ValidatedCreative,
} from "./creative.ts";
import { MarketplaceSigningKeys } from "./signing-keys.ts";

export type PlacementDeliveryStatus =
  | "verifying"
  | "ready"
  | "displaying"
  | "delivered"
  | "fallback"
  | "expired"
  | "blocked"
  | "reported";

export type PlacementReceiverAction = "hide" | "block_advertiser" | "report";

export interface PlacementDeliveryRecord {
  placementId: string;
  receiverAccountId: string;
  signedPlacement: SignedPlacement;
  validatedCreative: ValidatedCreative;
  status: PlacementDeliveryStatus;
  hostKind?: "codex" | "signed-html";
  hostSessionId?: string;
  hostTurnId?: string;
  receipt?: CodexDeliveryReceipt | GenericPlacementReceipt;
  lastFailureCode?: string;
  receiverAction?: PlacementReceiverAction;
  updatedAt: string;
}

export interface PlacementDeliveryRepository {
  get(placementId: string): Promise<PlacementDeliveryRecord | undefined>;
  put(record: PlacementDeliveryRecord): Promise<void>;
}

export class MemoryPlacementDeliveryRepository implements PlacementDeliveryRepository {
  readonly #records = new Map<string, PlacementDeliveryRecord>();
  async get(placementId: string) { return clone(this.#records.get(placementId)); }
  async put(record: PlacementDeliveryRecord) { this.#records.set(record.placementId, clone(record)!); }
}

export class PlacementDeliveryService {
  readonly #serial = new KeyedSerialExecutor();
  readonly #repository: PlacementDeliveryRepository;
  readonly #signingKeys: MarketplaceSigningKeys;
  readonly #creativePolicy: CreativeValidationPolicy;

  constructor(
    repository: PlacementDeliveryRepository,
    signingKeys: MarketplaceSigningKeys,
    creativePolicy: CreativeValidationPolicy,
  ) {
    this.#repository = repository;
    this.#signingKeys = signingKeys;
    this.#creativePolicy = creativePolicy;
  }

  async prepare(input: {
    receiverAccountId: string;
    placement: SignedPlacement;
    now?: Date;
  }): Promise<PlacementDeliveryRecord> {
    const now = input.now ?? new Date();
    return this.#serial.run(input.placement.payload.placementId, async () => {
      const existing = await this.#repository.get(input.placement.payload.placementId);
      if (existing) {
        if (existing.receiverAccountId !== input.receiverAccountId ||
          fingerprint(existing.signedPlacement) !== fingerprint(input.placement)) {
          throw new Error("Placement idempotency collision");
        }
        return existing;
      }
      const verified = this.#signingKeys.verifyWithKey(input.placement, now);
      const validatedCreative = validateCreative(verified.payload, this.#creativePolicy);
      const record: PlacementDeliveryRecord = {
        placementId: verified.payload.placementId,
        receiverAccountId: input.receiverAccountId,
        signedPlacement: input.placement,
        validatedCreative,
        status: "ready",
        updatedAt: now.toISOString(),
      };
      await this.#repository.put(record);
      return clone(record)!;
    });
  }

  async deliverCodex(
    placementId: string,
    options: Omit<DeliverCodexPlacementOptions, "placement" | "publicKeyPem" | "existingHostIdentifiers" | "onHostIdentifiers">,
  ): Promise<PlacementDeliveryRecord> {
    return this.#serial.run(placementId, async () => {
      let record = this.require(await this.#repository.get(placementId));
      if (record.receipt && record.status === "delivered") return record;
      if (["blocked", "reported", "expired"].includes(record.status)) {
        throw new Error(`Placement cannot be delivered while ${record.status}`);
      }
      const key = this.#signingKeys.verifyWithKey(record.signedPlacement, options.now);
      validateCreative(key.payload, this.#creativePolicy);
      record = { ...record, status: "displaying", hostKind: "codex", updatedAt: (options.now ?? new Date()).toISOString() };
      await this.#repository.put(record);
      const result = await deliverCodexPlacement({
        ...options,
        placement: record.signedPlacement,
        publicKeyPem: key.publicKeyPem,
        existingHostIdentifiers: record.hostSessionId
          ? { threadId: record.hostSessionId, turnId: record.hostTurnId }
          : undefined,
        onHostIdentifiers: async (ids) => {
          record = {
            ...record,
            hostSessionId: ids.threadId,
            hostTurnId: ids.turnId ?? record.hostTurnId,
            updatedAt: new Date().toISOString(),
          };
          await this.#repository.put(record);
        },
      });
      if (result.delivered) {
        record = {
          ...record,
          status: "delivered",
          hostSessionId: result.receipt.threadId,
          hostTurnId: result.receipt.turnId,
          receipt: result.receipt,
          lastFailureCode: undefined,
          updatedAt: new Date().toISOString(),
        };
      } else {
        record = {
          ...record,
          status: result.code === "PLACEMENT_INVALID" ? "expired" : "ready",
          lastFailureCode: result.code,
          updatedAt: new Date().toISOString(),
        };
      }
      await this.#repository.put(record);
      return clone(record)!;
    });
  }

  async deliverFallback(placementId: string, creativeUrl: string, now = new Date()): Promise<PlacementDeliveryRecord> {
    return this.#serial.run(placementId, async () => {
      const record = this.require(await this.#repository.get(placementId));
      if (record.receipt) return record;
      const key = this.#signingKeys.verifyWithKey(record.signedPlacement, now);
      const result = deliverGenericPlacement({ placement: record.signedPlacement, publicKeyPem: key.publicKeyPem, creativeUrl, now });
      if (!result.delivered) throw new Error(result.reason);
      const updated: PlacementDeliveryRecord = {
        ...record,
        status: "fallback",
        hostKind: "signed-html",
        receipt: result.receipt,
        updatedAt: now.toISOString(),
      };
      await this.#repository.put(updated);
      return clone(updated)!;
    });
  }

  async receiverAction(placementId: string, receiverAccountId: string, action: PlacementReceiverAction, now = new Date()) {
    return this.#serial.run(placementId, async () => {
      const record = this.require(await this.#repository.get(placementId));
      if (record.receiverAccountId !== receiverAccountId) throw new Error("Placement not found");
      const updated: PlacementDeliveryRecord = {
        ...record,
        status: action === "report" ? "reported" : "blocked",
        receiverAction: action,
        updatedAt: now.toISOString(),
      };
      await this.#repository.put(updated);
      return clone(updated)!;
    });
  }

  async receipt(placementId: string, receiverAccountId: string): Promise<PlacementDeliveryRecord> {
    const record = this.require(await this.#repository.get(placementId));
    if (record.receiverAccountId !== receiverAccountId) throw new Error("Placement not found");
    return record;
  }

  private require(record: PlacementDeliveryRecord | undefined): PlacementDeliveryRecord {
    if (!record) throw new Error("Placement not found");
    return record;
  }
}

function fingerprint(value: unknown): string { return JSON.stringify(value); }
function clone<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : structuredClone(value); }
