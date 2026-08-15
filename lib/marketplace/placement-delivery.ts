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
  hostInstructionSourcesVerified?: boolean;
  hostInstructionSources?: string[];
  receipt?: CodexDeliveryReceipt | GenericPlacementReceipt;
  lastFailureCode?: string;
  receiverAction?: PlacementReceiverAction;
  marketContext?: {
    campaignId: string;
    eligibleBidderCount: number;
    rewardType: "stablecoin" | "credits" | "discount";
    grossAmountMinor: number;
    receiverAmountMinor: number;
    operatorAmountMinor: number;
  };
  updatedAt: string;
}

export interface PlacementDeliveryRepository {
  get(placementId: string): Promise<PlacementDeliveryRecord | undefined>;
  put(record: PlacementDeliveryRecord): Promise<void>;
  listByReceiver(receiverAccountId: string): Promise<readonly PlacementDeliveryRecord[]>;
  listByAdvertiser(advertiserId: string): Promise<readonly PlacementDeliveryRecord[]>;
  listByCampaign(campaignId: string): Promise<readonly PlacementDeliveryRecord[]>;
}

export class MemoryPlacementDeliveryRepository implements PlacementDeliveryRepository {
  readonly #records = new Map<string, PlacementDeliveryRecord>();
  async get(placementId: string) { return clone(this.#records.get(placementId)); }
  async put(record: PlacementDeliveryRecord) { this.#records.set(record.placementId, clone(record)!); }
  async listByReceiver(receiverAccountId: string) {
    return [...this.#records.values()].filter((record) => record.receiverAccountId === receiverAccountId).map((record) => clone(record)!);
  }
  async listByAdvertiser(advertiserId: string) {
    return [...this.#records.values()].filter((record) => record.validatedCreative.payload.advertiser.id === advertiserId).map((record) => clone(record)!);
  }
  async listByCampaign(campaignId: string) {
    return [...this.#records.values()].filter((record) => record.marketContext?.campaignId === campaignId).map((record) => clone(record)!);
  }
}

export class PlacementDeliveryService {
  readonly #serial: KeyedSerialExecutor;
  readonly #repository: PlacementDeliveryRepository;
  readonly #signingKeys: MarketplaceSigningKeys;
  readonly #creativePolicy: CreativeValidationPolicy;
  readonly #advertiserPolicy?: { assertAllowed(receiverAccountId: string, advertiserId: string): void };

  constructor(
    repository: PlacementDeliveryRepository,
    signingKeys: MarketplaceSigningKeys,
    creativePolicy: CreativeValidationPolicy,
    advertiserPolicy?: { assertAllowed(receiverAccountId: string, advertiserId: string): void },
  ) {
    this.#repository = repository;
    this.#serial = serialFor(repository);
    this.#signingKeys = signingKeys;
    this.#creativePolicy = creativePolicy;
    this.#advertiserPolicy = advertiserPolicy;
  }

  async prepare(input: {
    receiverAccountId: string;
    placement: SignedPlacement;
    marketContext?: PlacementDeliveryRecord["marketContext"];
    now?: Date;
  }): Promise<PlacementDeliveryRecord> {
    const now = input.now ?? new Date();
    return this.#serial.run(input.placement.payload.placementId, async () => {
      const existing = await this.#repository.get(input.placement.payload.placementId);
      if (existing) {
        if (existing.receiverAccountId !== input.receiverAccountId ||
          fingerprint(existing.signedPlacement) !== fingerprint(input.placement) ||
          fingerprint(existing.marketContext) !== fingerprint(input.marketContext)) {
          throw new Error("Placement idempotency collision");
        }
        return existing;
      }
      const verified = this.#signingKeys.verifyWithKey(input.placement, now);
      this.#advertiserPolicy?.assertAllowed(input.receiverAccountId, verified.payload.advertiser.id);
      const validatedCreative = validateCreative(verified.payload, this.#creativePolicy);
      const record: PlacementDeliveryRecord = {
        placementId: verified.payload.placementId,
        receiverAccountId: input.receiverAccountId,
        signedPlacement: input.placement,
        validatedCreative,
        ...(input.marketContext ? { marketContext: validateMarketContext(input.marketContext, verified.payload.payout.amountMinor) } : {}),
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
          ? {
              threadId: record.hostSessionId,
              turnId: record.hostTurnId,
              instructionSourcesVerified: record.hostInstructionSourcesVerified,
              instructionSources: record.hostInstructionSources,
            }
          : undefined,
        onHostIdentifiers: async (ids) => {
          record = {
            ...record,
            hostSessionId: ids.threadId,
            hostTurnId: ids.turnId ?? record.hostTurnId,
            hostInstructionSourcesVerified:
              ids.instructionSourcesVerified ?? record.hostInstructionSourcesVerified,
            hostInstructionSources:
              ids.instructionSources ?? record.hostInstructionSources,
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
      if (["blocked", "reported", "expired"].includes(record.status)) {
        throw new Error(`Placement cannot be delivered while ${record.status}`);
      }
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
    return applyPlacementReceiverAction(this.#repository, placementId, receiverAccountId, action, now);
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

const repositorySerializers = new WeakMap<PlacementDeliveryRepository, KeyedSerialExecutor>();

function serialFor(repository: PlacementDeliveryRepository): KeyedSerialExecutor {
  let serial = repositorySerializers.get(repository);
  if (!serial) {
    serial = new KeyedSerialExecutor();
    repositorySerializers.set(repository, serial);
  }
  return serial;
}

export function applyPlacementReceiverAction(
  repository: PlacementDeliveryRepository,
  placementId: string,
  receiverAccountId: string,
  action: PlacementReceiverAction,
  now = new Date(),
): Promise<PlacementDeliveryRecord> {
  return serialFor(repository).run(placementId, async () => {
    const record = await repository.get(placementId);
    if (!record || record.receiverAccountId !== receiverAccountId) throw new Error("Placement not found");
    const updated: PlacementDeliveryRecord = {
      ...record,
      status: action === "report" ? "reported" : "blocked",
      receiverAction: action,
      updatedAt: now.toISOString(),
    };
    await repository.put(updated);
    return clone(updated)!;
  });
}

function fingerprint(value: unknown): string { return JSON.stringify(value); }
function clone<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : structuredClone(value); }

function validateMarketContext(context: NonNullable<PlacementDeliveryRecord["marketContext"]>, displayedReceiverMinor: number) {
  if (!context.campaignId || context.campaignId.length > 128 || !Number.isSafeInteger(context.eligibleBidderCount) || context.eligibleBidderCount < 1 ||
    ![context.grossAmountMinor, context.receiverAmountMinor, context.operatorAmountMinor].every((amount) => Number.isSafeInteger(amount) && amount >= 0) ||
    context.receiverAmountMinor + context.operatorAmountMinor !== context.grossAmountMinor || context.receiverAmountMinor !== displayedReceiverMinor ||
    !["stablecoin", "credits", "discount"].includes(context.rewardType)) throw new Error("Placement market context is invalid");
  if (context.rewardType !== "stablecoin" && context.grossAmountMinor !== 0) throw new Error("Non-cash market context cannot enter cash economics");
  return structuredClone(context);
}
