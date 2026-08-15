import { createHash } from "node:crypto";
import { KeyedSerialExecutor } from "../runtime/keyed-serial.ts";
import { LedgerService } from "./ledger.ts";
import { assertPaymentPolicy, type PaymentPolicyContext } from "./payment-policy.ts";
import { InMemoryPaymentStateRepository, type PaymentStateRepository } from "./repository.ts";
import {
  opaqueTempoMemo,
  validateTempoAddress,
  type TempoClient,
  type TempoTransferReceipt,
} from "./tempo-client.ts";

export interface PayoutDestinationApproval {
  humanId: string;
  address: string;
  approvedAt: string;
  expiresAt: string;
  purpose: "payout_destination";
  proofVerified: boolean;
}

export interface PayoutDestination {
  destinationId: string;
  address: string;
  approvedAt: string;
  activatesAt: string;
}

export class PayoutDestinationRegistry {
  readonly #repository: PaymentStateRepository;
  readonly changeDelayMs: number;
  constructor(changeDelayMs: number, repository: PaymentStateRepository = new InMemoryPaymentStateRepository()) {
    if (!Number.isSafeInteger(changeDelayMs) || changeDelayMs < 0) throw new Error("Payout address change delay is invalid");
    this.changeDelayMs = changeDelayMs;
    this.#repository = repository;
  }
  async enroll(approval: PayoutDestinationApproval, now = new Date()): Promise<PayoutDestination> {
    validateTempoAddress(approval.address);
    const approvedAt = Date.parse(approval.approvedAt);
    const expiresAt = Date.parse(approval.expiresAt);
    if (!approval.proofVerified || approval.purpose !== "payout_destination" || !Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || approvedAt > now.getTime() || expiresAt <= now.getTime()) throw new Error("Fresh human payout destination approval is required");
    const current = await this.#repository.listPayoutDestinations(approval.humanId);
    const replay = current.find((item) => item.address.toLowerCase() === approval.address.toLowerCase() && item.approvedAt === approval.approvedAt);
    if (replay) return replay;
    const activatesAt = new Date(approvedAt + (current.length === 0 ? 0 : this.changeDelayMs)).toISOString();
    const destination = Object.freeze({
      destinationId: `destination:${createHash("sha256").update(`${approval.humanId}\0${approval.address.toLowerCase()}\0${approval.approvedAt}`).digest("hex")}`,
      address: approval.address, approvedAt: approval.approvedAt, activatesAt,
    });
    return this.#repository.putPayoutDestination(approval.humanId, destination);
  }
  async resolve(humanId: string, now = new Date()): Promise<PayoutDestination> {
    const eligible = (await this.#repository.listPayoutDestinations(humanId)).filter((item) => Date.parse(item.activatesAt) <= now.getTime());
    const destination = eligible.at(-1);
    if (!destination) throw new Error("No verified payout destination is active");
    return destination;
  }
}

export interface PayoutRecord {
  payoutId: string;
  receiverHumanId: string;
  receiverLedgerAccountId: string;
  treasuryLedgerAccountId: string;
  destination: string;
  destinationId: string;
  amountMinor: number;
  memo: string;
  status: "queued" | "failed" | "paid";
  policyVersion: string;
  queuedAt: string;
  transactionHash?: string;
  failureReason?: string;
}

export class PayoutService {
  readonly #serial = new KeyedSerialExecutor();
  readonly #destinations: PayoutDestinationRegistry;
  readonly #tempo: TempoClient;
  readonly #ledger: LedgerService;
  readonly #policy: PaymentPolicyContext;
  readonly #tokenAddress: string;
  readonly #memoSalt: string;
  readonly #periodCeilingMinor: number;
  readonly #repository: PaymentStateRepository;
  constructor(input: {
    destinations: PayoutDestinationRegistry;
    tempo: TempoClient;
    ledger: LedgerService;
    policy: PaymentPolicyContext;
    tokenAddress: string;
    memoSalt: string;
    periodCeilingMinor: number;
    repository?: PaymentStateRepository;
  }) {
    this.#destinations = input.destinations; this.#tempo = input.tempo; this.#ledger = input.ledger;
    this.#policy = input.policy; this.#tokenAddress = input.tokenAddress; this.#memoSalt = input.memoSalt;
    this.#periodCeilingMinor = input.periodCeilingMinor;
    this.#repository = input.repository ?? new InMemoryPaymentStateRepository();
    if (!Number.isSafeInteger(input.periodCeilingMinor) || input.periodCeilingMinor < 1) throw new Error("Payout period ceiling is invalid");
  }

  queue(input: {
    payoutId: string;
    receiverHumanId: string;
    receiverLedgerAccountId: string;
    treasuryLedgerAccountId: string;
    amountMinor: number;
    now?: Date;
    humanApprovedCeilingOverride?: boolean;
  }): Promise<PayoutRecord> {
    return this.#serial.run(input.payoutId, async () => {
      const now = input.now ?? new Date();
      assertAmount(input.amountMinor);
      const existing = await this.#repository.getPayout(input.payoutId);
      if (existing) {
        if (existing.amountMinor !== input.amountMinor || existing.receiverHumanId !== input.receiverHumanId ||
          existing.receiverLedgerAccountId !== input.receiverLedgerAccountId || existing.treasuryLedgerAccountId !== input.treasuryLedgerAccountId) throw new Error("Payout idempotency collision");
        return existing;
      }
      const destination = await this.#destinations.resolve(input.receiverHumanId, now);
      const period = now.toISOString().slice(0, 10);
      const total = await this.#repository.payoutTotalForPeriod(period);
      if (total + input.amountMinor > this.#periodCeilingMinor && !input.humanApprovedCeilingOverride) throw new Error("Payout batch exceeds the treasury period ceiling");
      const record: PayoutRecord = Object.freeze({
        payoutId: input.payoutId, receiverHumanId: input.receiverHumanId,
        receiverLedgerAccountId: input.receiverLedgerAccountId,
        treasuryLedgerAccountId: input.treasuryLedgerAccountId,
        destination: destination.address, destinationId: destination.destinationId, amountMinor: input.amountMinor,
        memo: opaqueTempoMemo("payout", input.payoutId, this.#memoSalt),
        status: "queued", policyVersion: this.#policy.policyVersion, queuedAt: now.toISOString(),
      });
      return this.#repository.putPayout(record);
    });
  }

  send(payoutId: string): Promise<PayoutRecord> {
    return this.#serial.run(payoutId, async () => {
      const record = await this.#repository.getPayout(payoutId);
      if (!record) throw new Error("Unknown payout");
      if (record.status === "paid") return record;
      assertPaymentPolicy({ ...this.#policy, chainId: this.#tempo.chainId, tokenAddress: this.#tokenAddress });
      let receipt: TempoTransferReceipt;
      try {
        receipt = await this.#tempo.sendTransfer({
          tokenAddress: this.#tokenAddress, to: record.destination,
          amountMinor: record.amountMinor, memo: record.memo, feeSponsored: true,
        });
      } catch (error) {
        const failed: PayoutRecord = Object.freeze({ ...record, status: "failed", failureReason: boundedError(error) });
        return this.#repository.putPayout(failed);
      }
      if (receipt.status !== "confirmed") {
        const failed: PayoutRecord = Object.freeze({ ...record, status: "failed", failureReason: receipt.failureReason ?? "Tempo transfer failed" });
        return this.#repository.putPayout(failed);
      }
      await this.#ledger.post({
        transactionId: `payout:${payoutId}`, idempotencyKey: `tempo:payout:${record.memo}`,
        kind: "payout", currency: "USDC", referenceId: payoutId,
        chainReference: receipt.transactionHash,
        entries: [
          { accountId: record.receiverLedgerAccountId, amountMinor: -record.amountMinor },
          { accountId: record.treasuryLedgerAccountId, amountMinor: record.amountMinor },
        ],
      });
      const paid: PayoutRecord = Object.freeze({ ...record, status: "paid", transactionHash: receipt.transactionHash, failureReason: undefined });
      return this.#repository.putPayout(paid);
    });
  }
}

function assertAmount(value: number) { if (!Number.isSafeInteger(value) || value < 1) throw new Error("Payout amount must be a positive safe integer"); }
function boundedError(error: unknown) { return (error instanceof Error ? error.message : "Payout failed").slice(0, 240); }
