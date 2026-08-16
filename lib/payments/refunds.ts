import type { CampaignBudgetSnapshot } from "../marketplace/budget.ts";
import { KeyedSerialExecutor } from "../runtime/keyed-serial.ts";
import { LedgerService } from "./ledger.ts";
import { assertPaymentPolicy, type PaymentPolicyContext } from "./payment-policy.ts";
import { InMemoryPaymentStateRepository, type PaymentStateRepository } from "./repository.ts";
import { opaqueTempoMemo, validateTempoAddress, type TempoClient } from "./tempo-client.ts";

const MAX_REFUND_PROOF_AGE_MS = 5 * 60_000;

export interface VerifiedRefundHumanProof {
  proofId: string;
  accountId: string;
  nonce: string;
  method: "passkey_and_wallet_signature";
  verifiedAt: string;
  expiresAt: string;
}

export interface RefundApprovalRecord {
  approvalId: string;
  accountId: string;
  campaignId: string;
  refundAddress: string;
  amountMinor: number;
  proofId: string;
  nonce: string;
  approvedAt: string;
  expiresAt: string;
  consumedByRefundId?: string;
  consumedAt?: string;
}

interface StoredRefundHumanProof extends VerifiedRefundHumanProof {
  consumedByApprovalId?: string;
  consumedAt?: string;
}

type RefundApprovalDraft = Omit<RefundApprovalRecord, "nonce" | "approvedAt">;

export interface RefundApprovalRepository {
  recordVerifiedProof(proof: VerifiedRefundHumanProof): Promise<VerifiedRefundHumanProof>;
  issueApproval(record: RefundApprovalDraft, now: Date): Promise<RefundApprovalRecord>;
  consumeApproval(
    approvalId: string,
    input: { accountId: string; campaignId: string; refundId: string },
    now: Date,
  ): Promise<RefundApprovalRecord>;
}

export class InMemoryRefundApprovalRepository implements RefundApprovalRepository {
  readonly #proofs = new Map<string, StoredRefundHumanProof>();
  readonly #proofNonces = new Set<string>();
  readonly #approvals = new Map<string, RefundApprovalRecord>();
  readonly #serial = new KeyedSerialExecutor();

  recordVerifiedProof(proof: VerifiedRefundHumanProof): Promise<VerifiedRefundHumanProof> {
    return this.#serial.run(`proof:${proof.proofId}`, () => {
      if (this.#proofs.has(proof.proofId) || this.#proofNonces.has(proof.nonce)) throw new Error("Refund human proof replay");
      const stored = Object.freeze({ ...proof });
      this.#proofs.set(proof.proofId, stored);
      this.#proofNonces.add(proof.nonce);
      return stored;
    });
  }

  issueApproval(record: RefundApprovalDraft, now: Date): Promise<RefundApprovalRecord> {
    return this.#serial.run(`proof:${record.proofId}`, () => {
      const proof = this.#proofs.get(record.proofId);
      if (!proof || proof.accountId !== record.accountId ||
        proof.consumedByApprovalId || Date.parse(proof.expiresAt) <= now.getTime()) {
        throw new Error("Fresh verified human proof is required");
      }
      if (Date.parse(record.expiresAt) > Date.parse(proof.expiresAt)) throw new Error("Refund approval cannot outlive its human proof");
      if (this.#approvals.has(record.approvalId)) throw new Error("Refund approval id collision");
      this.#proofs.set(proof.proofId, Object.freeze({
        ...proof,
        consumedByApprovalId: record.approvalId,
        consumedAt: now.toISOString(),
      }));
      const issued = Object.freeze({ ...record, nonce: proof.nonce, approvedAt: proof.verifiedAt });
      this.#approvals.set(record.approvalId, issued);
      return issued;
    });
  }

  consumeApproval(
    approvalId: string,
    input: { accountId: string; campaignId: string; refundId: string },
    now: Date,
  ): Promise<RefundApprovalRecord> {
    return this.#serial.run(`approval:${approvalId}`, () => {
      const record = this.#approvals.get(approvalId);
      if (!record || record.accountId !== input.accountId || record.campaignId !== input.campaignId) {
        throw new Error("Fresh server-issued refund approval is required");
      }
      if (record.consumedByRefundId) {
        if (record.consumedByRefundId !== input.refundId) throw new Error("Refund approval replay");
        return record;
      }
      if (Date.parse(record.expiresAt) <= now.getTime()) throw new Error("Fresh server-issued refund approval is required");
      const consumed = Object.freeze({ ...record, consumedByRefundId: input.refundId, consumedAt: now.toISOString() });
      this.#approvals.set(approvalId, consumed);
      return consumed;
    });
  }
}

/** Server-side sink for proofs already verified by the WebAuthn + wallet-signature boundary. */
export class RefundHumanProofStore {
  readonly repository: RefundApprovalRepository;

  constructor(repository: RefundApprovalRepository = new InMemoryRefundApprovalRepository()) {
    this.repository = repository;
  }

  recordVerifiedProof(proof: VerifiedRefundHumanProof, now = new Date()): Promise<VerifiedRefundHumanProof> {
    const verifiedAt = Date.parse(proof.verifiedAt);
    const expiresAt = Date.parse(proof.expiresAt);
    if (!proof.proofId || !proof.accountId || !proof.nonce || proof.method !== "passkey_and_wallet_signature" ||
      !Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || verifiedAt > now.getTime() ||
      now.getTime() - verifiedAt > MAX_REFUND_PROOF_AGE_MS || expiresAt <= now.getTime() ||
      expiresAt - verifiedAt > MAX_REFUND_PROOF_AGE_MS || verifiedAt >= expiresAt) {
      throw new Error("Verified passkey and wallet proof is required");
    }
    return this.repository.recordVerifiedProof(Object.freeze({ ...proof }));
  }
}

export class RefundApprovalRegistry {
  readonly #repository: RefundApprovalRepository;

  constructor(proofs: RefundHumanProofStore) { this.#repository = proofs.repository; }

  async issue(input: {
    proofId: string;
    accountId: string;
    campaignId: string;
    refundAddress: string;
    amountMinor: number;
    expiresAt: string;
  }, now = new Date()): Promise<RefundApprovalRecord> {
    validateTempoAddress(input.refundAddress);
    if (!input.campaignId || !Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1) throw new Error("Invalid refund approval binding");
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) throw new Error("Invalid refund approval expiry");
    const record: RefundApprovalDraft = Object.freeze({
      approvalId: crypto.randomUUID(),
      accountId: input.accountId,
      campaignId: input.campaignId,
      refundAddress: input.refundAddress,
      amountMinor: input.amountMinor,
      proofId: input.proofId,
      expiresAt: input.expiresAt,
    });
    return this.#repository.issueApproval(record, now);
  }

  consume(approvalId: string, input: { accountId: string; campaignId: string; refundId: string }, now: Date): Promise<RefundApprovalRecord> {
    return this.#repository.consumeApproval(approvalId, input, now);
  }
}

export interface RefundBudgetGateway {
  snapshot(campaignId: string): CampaignBudgetSnapshot | Promise<CampaignBudgetSnapshot>;
  withdraw(campaignId: string, refundId: string, amountMinor: number): Promise<CampaignBudgetSnapshot>;
}

export interface RefundRecord {
  refundId: string;
  campaignId: string;
  amountMinor: number;
  address: string;
  memo: string;
  status: "pending" | "failed" | "paid";
  reservedMinor: number;
  heldMinor: number;
  policyVersion: string;
  transactionHash?: string;
  failureReason?: string;
}

export interface RefundBinding {
  approvalId: string;
  accountId: string;
  advertiserLedgerAccountId: string;
  treasuryLedgerAccountId: string;
}

export class RefundService {
  readonly #serial = new KeyedSerialExecutor();
  readonly #tempo: TempoClient;
  readonly #ledger: LedgerService;
  readonly #policy: PaymentPolicyContext;
  readonly #tokenAddress: string;
  readonly #memoSalt: string;
  readonly #budgets: RefundBudgetGateway;
  readonly #approvals: RefundApprovalRegistry;
  readonly #repository: PaymentStateRepository;
  constructor(input: {
    tempo: TempoClient;
    ledger: LedgerService;
    policy: PaymentPolicyContext;
    tokenAddress: string;
    memoSalt: string;
    budgets: RefundBudgetGateway;
    approvals: RefundApprovalRegistry;
    repository?: PaymentStateRepository;
  }) {
    if (!input.memoSalt) throw new Error("Refund memo salt is required");
    this.#tempo = input.tempo; this.#ledger = input.ledger; this.#policy = input.policy;
    this.#tokenAddress = input.tokenAddress; this.#memoSalt = input.memoSalt;
    this.#budgets = input.budgets; this.#approvals = input.approvals;
    this.#repository = input.repository ?? new InMemoryPaymentStateRepository();
  }

  prepare(input: {
    refundId: string;
    approvalId: string;
    accountId: string;
    campaignId: string;
    advertiserLedgerAccountId: string;
    treasuryLedgerAccountId: string;
    now?: Date;
  }): Promise<RefundRecord> {
    return this.#serial.run(`prepare:${input.campaignId}`, async () => {
      if (![input.refundId, input.approvalId, input.accountId, input.campaignId,
        input.advertiserLedgerAccountId, input.treasuryLedgerAccountId].every((value) => typeof value === "string" && value.length > 0)) {
        throw new Error("Refund identifiers and ledger bindings are required");
      }
      const durable = await this.#repository.getRefund(input.refundId);
      if (durable) {
        const { record: existing, binding } = durable;
        if (existing.campaignId !== input.campaignId || binding.approvalId !== input.approvalId ||
          binding.accountId !== input.accountId || binding.advertiserLedgerAccountId !== input.advertiserLedgerAccountId ||
          binding.treasuryLedgerAccountId !== input.treasuryLedgerAccountId) {
          throw new Error("Refund idempotency collision");
        }
        return existing;
      }
      const prior = await this.#repository.getRefundByCampaign(input.campaignId);
      if (prior && prior.record.refundId !== input.refundId) throw new Error("Campaign refund already prepared");
      const now = input.now ?? new Date();
      const memo = opaqueTempoMemo("refund", input.refundId, this.#memoSalt);
      const approval = await this.#approvals.consume(input.approvalId, {
        accountId: input.accountId,
        campaignId: input.campaignId,
        refundId: input.refundId,
      }, now);
      const budget = await this.#budgets.snapshot(input.campaignId);
      if (budget.status !== "closed") throw new Error("Campaign must be closed before refund");
      await this.#budgets.withdraw(input.campaignId, input.refundId, approval.amountMinor);
      const record: RefundRecord = Object.freeze({
        refundId: input.refundId, campaignId: input.campaignId, amountMinor: approval.amountMinor,
        address: approval.refundAddress, memo,
        status: "pending", reservedMinor: budget.reservedMinor, heldMinor: budget.heldMinor,
        policyVersion: this.#policy.policyVersion,
      });
      const binding: RefundBinding = {
        approvalId: input.approvalId,
        accountId: input.accountId,
        advertiserLedgerAccountId: input.advertiserLedgerAccountId,
        treasuryLedgerAccountId: input.treasuryLedgerAccountId,
      };
      return (await this.#repository.putRefund({ record, binding })).record;
    });
  }

  send(refundId: string): Promise<RefundRecord> {
    return this.#serial.run(refundId, async () => {
      const durable = await this.#repository.getRefund(refundId);
      if (!durable) throw new Error("Unknown refund");
      const { record, binding } = durable;
      if (record.status === "paid") return record;
      assertPaymentPolicy({ ...this.#policy, chainId: this.#tempo.chainId, tokenAddress: this.#tokenAddress });
      try {
        const receipt = await this.#tempo.sendTransfer({ tokenAddress: this.#tokenAddress, to: record.address, amountMinor: record.amountMinor, memo: record.memo, feeSponsored: true });
        if (receipt.status !== "confirmed") throw new Error(receipt.failureReason ?? "Tempo refund failed");
        await this.#ledger.post({
          transactionId: `refund:${refundId}`, idempotencyKey: `tempo:refund:${record.memo}`,
          kind: "refund", currency: "USDC", referenceId: refundId, chainReference: receipt.transactionHash,
          entries: [
            { accountId: binding.advertiserLedgerAccountId, amountMinor: record.amountMinor },
            { accountId: binding.treasuryLedgerAccountId, amountMinor: -record.amountMinor },
          ],
        });
        const paid: RefundRecord = Object.freeze({ ...record, status: "paid", transactionHash: receipt.transactionHash, failureReason: undefined });
        return (await this.#repository.putRefund({ record: paid, binding })).record;
      } catch (error) {
        const failed: RefundRecord = Object.freeze({ ...record, status: "failed", failureReason: boundedError(error) });
        return (await this.#repository.putRefund({ record: failed, binding })).record;
      }
    });
  }
}

function boundedError(error: unknown) { return (error instanceof Error ? error.message : "Refund failed").slice(0, 240); }
