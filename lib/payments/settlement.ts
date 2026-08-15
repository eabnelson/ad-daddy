import { createHash } from "node:crypto";

import type { CodexDeliveryReceipt } from "@ad-daddy/host-adapters";
import type { RewardType } from "../domain/types.ts";
import { calculateRevenueSplit, LAUNCH_REVENUE_SPLIT, LedgerService } from "./ledger.ts";

interface SettlementBudgetGateway {
  commit(campaignId: string, reservationId: string): Promise<unknown>;
}

export interface BaseSettlementInput {
  placementId: string;
  campaignId: string;
  reservationId: string;
  rewardType: RewardType;
  grossAmountMinor: number;
  receiverAmountMinor: number;
  operatorAmountMinor: number;
  advertiserLedgerAccountId: string;
  receiverLedgerAccountId: string;
  operatorLedgerAccountId: string;
  receiverHumanId: string;
  installationId: string;
  receipt: CodexDeliveryReceipt;
  policyVersion: string;
  now?: Date;
}

export interface BaseSettlementRecord {
  placementId: string;
  status: "settled" | "non_cash";
  rewardType: RewardType;
  transactionId?: string;
  grossAmountMinor: number;
  receiverAmountMinor: number;
  operatorAmountMinor: number;
  renderedResponseSha256?: string;
  policyVersion: string;
  settledAt: string;
}

export class RewardVelocityGuard {
  readonly #human = new Map<string, number>();
  readonly #installation = new Map<string, number>();
  readonly #placements = new Set<string>();
  readonly perHumanDailyMinor: number;
  readonly perInstallationDailyMinor: number;
  constructor(
    perHumanDailyMinor: number,
    perInstallationDailyMinor: number,
  ) {
    assertPositive(perHumanDailyMinor); assertPositive(perInstallationDailyMinor);
    this.perHumanDailyMinor = perHumanDailyMinor;
    this.perInstallationDailyMinor = perInstallationDailyMinor;
  }
  reserve(input: { placementId: string; humanId: string; installationId: string; amountMinor: number; now: Date }): void {
    if (this.#placements.has(input.placementId)) return;
    const day = input.now.toISOString().slice(0, 10);
    const humanKey = `${day}:${input.humanId}`;
    const installationKey = `${day}:${input.installationId}`;
    const humanTotal = this.#human.get(humanKey) ?? 0;
    const installationTotal = this.#installation.get(installationKey) ?? 0;
    if (humanTotal + input.amountMinor > this.perHumanDailyMinor || installationTotal + input.amountMinor > this.perInstallationDailyMinor) {
      throw new Error("Reward velocity anomaly hold required");
    }
    this.#human.set(humanKey, humanTotal + input.amountMinor);
    this.#installation.set(installationKey, installationTotal + input.amountMinor);
    this.#placements.add(input.placementId);
  }
}

export class SettlementService {
  readonly #records = new Map<string, BaseSettlementRecord>();
  readonly #ledger: LedgerService;
  readonly #budgets: SettlementBudgetGateway;
  readonly #velocity: RewardVelocityGuard;
  constructor(
    ledger: LedgerService,
    budgets: SettlementBudgetGateway,
    velocity: RewardVelocityGuard,
  ) {
    this.#ledger = ledger;
    this.#budgets = budgets;
    this.#velocity = velocity;
  }

  async settleBase(input: BaseSettlementInput): Promise<BaseSettlementRecord> {
    const existing = this.#records.get(input.placementId);
    if (existing) {
      if (settlementFingerprint(existing) !== inputFingerprint(input)) throw new Error("Placement settlement idempotency collision");
      return existing;
    }
    const now = input.now ?? new Date();
    if (input.rewardType !== "stablecoin") {
      if (input.grossAmountMinor !== 0 || input.receiverAmountMinor !== 0 || input.operatorAmountMinor !== 0) throw new Error("Non-cash rewards cannot enter the stablecoin ledger");
      const record = Object.freeze({
        placementId: input.placementId, status: "non_cash" as const, rewardType: input.rewardType,
        grossAmountMinor: 0, receiverAmountMinor: 0, operatorAmountMinor: 0,
        policyVersion: input.policyVersion, settledAt: now.toISOString(),
      });
      this.#records.set(input.placementId, record);
      return record;
    }
    validateReceipt(input);
    const split = calculateRevenueSplit(input.grossAmountMinor, LAUNCH_REVENUE_SPLIT);
    if (split.receiverMinor !== input.receiverAmountMinor || split.operatorMinor !== input.operatorAmountMinor) throw new Error("Settlement economics do not match the active revenue split");
    this.#velocity.reserve({
      placementId: input.placementId,
      humanId: input.receiverHumanId,
      installationId: input.installationId,
      amountMinor: input.receiverAmountMinor,
      now,
    });
    await this.#budgets.commit(input.campaignId, input.reservationId);
    const transactionId = `placement_settlement:${input.placementId}`;
    await this.#ledger.post({
      transactionId,
      idempotencyKey: `placement:${input.placementId}:base:${LAUNCH_REVENUE_SPLIT.version}`,
      kind: "placement_settlement",
      currency: "USDC",
      referenceId: input.placementId,
      splitVersion: LAUNCH_REVENUE_SPLIT.version,
      entries: [
        { accountId: input.advertiserLedgerAccountId, amountMinor: -input.grossAmountMinor },
        { accountId: input.receiverLedgerAccountId, amountMinor: input.receiverAmountMinor },
        { accountId: input.operatorLedgerAccountId, amountMinor: input.operatorAmountMinor },
      ],
    });
    const record: BaseSettlementRecord = Object.freeze({
      placementId: input.placementId, status: "settled", rewardType: input.rewardType,
      transactionId, grossAmountMinor: input.grossAmountMinor,
      receiverAmountMinor: input.receiverAmountMinor, operatorAmountMinor: input.operatorAmountMinor,
      renderedResponseSha256: input.receipt.outputSha256,
      policyVersion: input.policyVersion, settledAt: now.toISOString(),
    });
    this.#records.set(input.placementId, record);
    return record;
  }
}

function validateReceipt(input: BaseSettlementInput): void {
  const receipt = input.receipt;
  const computedHash = createHash("sha256").update(receipt.output).digest("hex");
  if (receipt.placementId !== input.placementId || receipt.outputSha256 !== computedHash ||
    receipt.receiverAmountMinor !== input.receiverAmountMinor || receipt.currency !== "USD" ||
    receipt.toolItemCount !== 0 || !receipt.sidebarVerified || !receipt.restartReadable || !receipt.listedAfterRestart ||
    receipt.activeTaskIdBefore !== receipt.activeTaskIdAfter || !receipt.output.startsWith("Sponsored via Ad Daddy")) {
    throw new Error("Verified sponsored render receipt is required for base settlement");
  }
}
function assertPositive(value: number) { if (!Number.isSafeInteger(value) || value < 1) throw new Error("Velocity limits must be positive safe integers"); }
function settlementFingerprint(value: BaseSettlementRecord) { return JSON.stringify([value.rewardType, value.grossAmountMinor, value.receiverAmountMinor, value.operatorAmountMinor, value.policyVersion]); }
function inputFingerprint(value: BaseSettlementInput) { return JSON.stringify([value.rewardType, value.grossAmountMinor, value.receiverAmountMinor, value.operatorAmountMinor, value.policyVersion]); }
