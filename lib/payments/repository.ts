import type { DepositCommitment, DepositRecord } from "./deposits.ts";
import type { PayoutDestination, PayoutRecord } from "./payouts.ts";
import type { RefundBinding, RefundRecord } from "./refunds.ts";

export interface DurableRefundRecord {
  record: RefundRecord;
  binding: RefundBinding;
}

export interface PaymentStateRepository {
  getDepositCommitment(memo: string): Promise<DepositCommitment | undefined>;
  putDepositCommitment(commitment: DepositCommitment): Promise<DepositCommitment>;
  getDepositRecord(eventKey: string): Promise<DepositRecord | undefined>;
  getDepositRecordByMemo(memo: string): Promise<DepositRecord | undefined>;
  findCreditedCampaignDeposit(input: { campaignId: string; advertiserAccountId: string; amountMinor: number; tokenAddress: string }): Promise<DepositRecord | undefined>;
  putDepositRecord(record: DepositRecord): Promise<DepositRecord>;
  listPayoutDestinations(humanId: string): Promise<readonly PayoutDestination[]>;
  putPayoutDestination(humanId: string, destination: PayoutDestination): Promise<PayoutDestination>;
  getPayout(payoutId: string): Promise<PayoutRecord | undefined>;
  putPayout(record: PayoutRecord): Promise<PayoutRecord>;
  payoutTotalForPeriod(period: string): Promise<number>;
  getRefund(refundId: string): Promise<DurableRefundRecord | undefined>;
  getRefundByCampaign(campaignId: string): Promise<DurableRefundRecord | undefined>;
  putRefund(value: DurableRefundRecord): Promise<DurableRefundRecord>;
}

export class InMemoryPaymentStateRepository implements PaymentStateRepository {
  readonly #commitments = new Map<string, DepositCommitment>();
  readonly #deposits = new Map<string, DepositRecord>();
  readonly #destinations = new Map<string, PayoutDestination[]>();
  readonly #payouts = new Map<string, PayoutRecord>();
  readonly #refunds = new Map<string, DurableRefundRecord>();

  async getDepositCommitment(memo: string) { return clone(this.#commitments.get(memo.toLowerCase())); }
  async putDepositCommitment(commitment: DepositCommitment) {
    const key = commitment.memo.toLowerCase();
    const existing = this.#commitments.get(key);
    if (existing && canonical(existing) !== canonical(commitment)) throw new Error("Deposit memo commitment collision");
    if (!existing) this.#commitments.set(key, clone(commitment)!);
    return clone(existing ?? commitment)!;
  }
  async getDepositRecord(eventKey: string) { return clone(this.#deposits.get(eventKey)); }
  async getDepositRecordByMemo(memo: string) {
    return clone([...this.#deposits.values()].find((record) => record.memo.toLowerCase() === memo.toLowerCase() && record.status !== "quarantined"));
  }
  async findCreditedCampaignDeposit(input: { campaignId: string; advertiserAccountId: string; amountMinor: number; tokenAddress: string }) {
    return clone([...this.#deposits.values()].find((record) => record.status === "credited" && record.campaignId === input.campaignId &&
      record.advertiserAccountId === input.advertiserAccountId && record.amountMinor === input.amountMinor &&
      record.tokenAddress.toLowerCase() === input.tokenAddress.toLowerCase()));
  }
  async putDepositRecord(record: DepositRecord) {
    const existing = this.#deposits.get(record.eventKey);
    if (existing?.status === "reorged") return clone(existing)!;
    this.#deposits.set(record.eventKey, clone(record)!);
    return clone(record)!;
  }
  async listPayoutDestinations(humanId: string) { return clone(this.#destinations.get(humanId) ?? [])!; }
  async putPayoutDestination(humanId: string, destination: PayoutDestination) {
    const current = this.#destinations.get(humanId) ?? [];
    const existing = current.find((item) => item.address.toLowerCase() === destination.address.toLowerCase() && item.approvedAt === destination.approvedAt);
    if (!existing) current.push(clone(destination)!);
    this.#destinations.set(humanId, current);
    return clone(existing ?? destination)!;
  }
  async getPayout(payoutId: string) { return clone(this.#payouts.get(payoutId)); }
  async putPayout(record: PayoutRecord) {
    this.#payouts.set(record.payoutId, clone(record)!);
    return clone(record)!;
  }
  async payoutTotalForPeriod(period: string) {
    return [...this.#payouts.values()].filter((record) => record.queuedAt.startsWith(period)).reduce((total, record) => total + record.amountMinor, 0);
  }
  async getRefund(refundId: string) { return clone(this.#refunds.get(refundId)); }
  async getRefundByCampaign(campaignId: string) { return clone([...this.#refunds.values()].find((value) => value.record.campaignId === campaignId)); }
  async putRefund(value: DurableRefundRecord) {
    const existingForCampaign = [...this.#refunds.values()].find((stored) => stored.record.campaignId === value.record.campaignId);
    if (existingForCampaign && existingForCampaign.record.refundId !== value.record.refundId) throw new Error("Campaign refund already prepared");
    this.#refunds.set(value.record.refundId, clone(value)!);
    return clone(value)!;
  }
}

function canonical(value: unknown) {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
