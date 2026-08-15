import { KeyedSerialExecutor } from "../runtime/keyed-serial.ts";
import type { CampaignBudgetSnapshot } from "../marketplace/budget.ts";
import { LedgerService } from "./ledger.ts";
import { assertPaymentPolicy, type PaymentPolicyContext } from "./payment-policy.ts";
import { opaqueTempoMemo, validateTempoAddress, type TempoClient } from "./tempo-client.ts";

export interface RefundApproval {
  accountId: string;
  campaignId: string;
  refundAddress: string;
  amountMinor: number;
  approvedAt: string;
  expiresAt: string;
  purposes: readonly string[];
  recentAuthentication: boolean;
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

export class RefundService {
  readonly #records = new Map<string, RefundRecord>();
  readonly #bindings = new Map<string, { accountId: string; advertiserLedgerAccountId: string; treasuryLedgerAccountId: string }>();
  readonly #serial = new KeyedSerialExecutor();
  readonly #tempo: TempoClient;
  readonly #ledger: LedgerService;
  readonly #policy: PaymentPolicyContext;
  readonly #tokenAddress: string;
  readonly #memoSalt: string;
  constructor(input: { tempo: TempoClient; ledger: LedgerService; policy: PaymentPolicyContext; tokenAddress: string; memoSalt: string }) {
    this.#tempo = input.tempo; this.#ledger = input.ledger; this.#policy = input.policy;
    this.#tokenAddress = input.tokenAddress; this.#memoSalt = input.memoSalt;
  }

  prepare(input: {
    refundId: string;
    accountId: string;
    campaignId: string;
    campaignClosedAt: string;
    budget: CampaignBudgetSnapshot;
    advertiserLedgerAccountId: string;
    treasuryLedgerAccountId: string;
    approval: RefundApproval;
    now?: Date;
  }): RefundRecord {
    const now = input.now ?? new Date();
    const existing = this.#records.get(input.refundId);
    if (existing) {
      const binding = this.#bindings.get(input.refundId);
      if (!binding || existing.campaignId !== input.campaignId || existing.amountMinor !== input.approval.amountMinor ||
        existing.address.toLowerCase() !== input.approval.refundAddress.toLowerCase() || binding?.accountId !== input.accountId ||
        binding.advertiserLedgerAccountId !== input.advertiserLedgerAccountId || binding.treasuryLedgerAccountId !== input.treasuryLedgerAccountId) {
        throw new Error("Refund idempotency collision");
      }
      return existing;
    }
    assertApproval(input, now);
    if (input.budget.status !== "closed" || !Number.isFinite(Date.parse(input.campaignClosedAt))) throw new Error("Campaign must be closed before refund");
    if (input.budget.campaignId !== input.campaignId || input.budget.withdrawableMinor !== input.approval.amountMinor || input.approval.amountMinor < 1) throw new Error("Refund must equal the currently withdrawable campaign balance");
    const record: RefundRecord = Object.freeze({
      refundId: input.refundId, campaignId: input.campaignId, amountMinor: input.approval.amountMinor,
      address: input.approval.refundAddress, memo: opaqueTempoMemo("refund", input.refundId, this.#memoSalt),
      status: "pending", reservedMinor: input.budget.reservedMinor, heldMinor: input.budget.heldMinor,
      policyVersion: this.#policy.policyVersion,
    });
    this.#records.set(input.refundId, record);
    this.#bindings.set(input.refundId, {
      accountId: input.accountId,
      advertiserLedgerAccountId: input.advertiserLedgerAccountId,
      treasuryLedgerAccountId: input.treasuryLedgerAccountId,
    });
    return record;
  }

  send(refundId: string): Promise<RefundRecord> {
    return this.#serial.run(refundId, async () => {
      const record = this.#records.get(refundId);
      if (!record) throw new Error("Unknown refund");
      if (record.status === "paid") return record;
      const binding = this.#bindings.get(refundId);
      if (!binding) throw new Error("Refund ledger binding is missing");
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
        this.#records.set(refundId, paid); return paid;
      } catch (error) {
        const failed: RefundRecord = Object.freeze({ ...record, status: "failed", failureReason: boundedError(error) });
        this.#records.set(refundId, failed); return failed;
      }
    });
  }
}

function assertApproval(input: {
  accountId: string; campaignId: string; approval: RefundApproval;
}, now: Date) {
  const approval = input.approval;
  validateTempoAddress(approval.refundAddress);
  const approvedAt = Date.parse(approval.approvedAt); const expiresAt = Date.parse(approval.expiresAt);
  if (approval.accountId !== input.accountId || approval.campaignId !== input.campaignId || !approval.recentAuthentication ||
    !["campaign_close", "refund_address", "refund_amount"].every((purpose) => approval.purposes.includes(purpose)) ||
    !Number.isSafeInteger(approval.amountMinor) || approval.amountMinor < 1 || !Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || approvedAt > now.getTime() || expiresAt <= now.getTime()) {
    throw new Error("Recent human approval of refund address and exact amount is required");
  }
}
function boundedError(error: unknown) { return (error instanceof Error ? error.message : "Refund failed").slice(0, 240); }
