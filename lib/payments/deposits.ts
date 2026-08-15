import { KeyedSerialExecutor } from "../runtime/keyed-serial.ts";
import { LedgerService } from "./ledger.ts";
import { assertPaymentPolicy, type PaymentPolicyContext } from "./payment-policy.ts";
import { validateTempoAddress, validateTempoMemo, type TempoTransferEvent } from "./tempo-client.ts";

export interface DepositCommitment {
  commitmentId: string;
  campaignId: string;
  advertiserAccountId: string;
  advertiserLedgerAccountId: string;
  treasuryLedgerAccountId: string;
  amountMinor: number;
  memo: string;
  expectedSender?: string;
}

export interface DepositRecord {
  depositId: string;
  commitmentId?: string;
  campaignId?: string;
  eventKey: string;
  memo: string;
  amountMinor: number;
  status: "credited" | "quarantined" | "reorged";
  reason?: string;
  transactionHash: string;
  logIndex: number;
  policyVersion: string;
}

export class DepositService {
  readonly #commitments = new Map<string, DepositCommitment>();
  readonly #records = new Map<string, DepositRecord>();
  readonly #memoEvents = new Map<string, string>();
  readonly #serial = new KeyedSerialExecutor();
  readonly #ledger: LedgerService;
  readonly #policy: PaymentPolicyContext;
  readonly #treasuryAddress: string;

  constructor(
    ledger: LedgerService,
    policy: PaymentPolicyContext,
    treasuryAddress: string,
  ) {
    validateTempoAddress(treasuryAddress);
    this.#ledger = ledger;
    this.#policy = policy;
    this.#treasuryAddress = treasuryAddress;
  }

  register(input: DepositCommitment): DepositCommitment {
    validateTempoMemo(input.memo);
    assertPositive(input.amountMinor);
    if (input.expectedSender) validateTempoAddress(input.expectedSender);
    const existing = this.#commitments.get(input.memo.toLowerCase());
    if (existing && fingerprint(existing) !== fingerprint(input)) throw new Error("Deposit memo commitment collision");
    if (!existing) this.#commitments.set(input.memo.toLowerCase(), structuredClone(input));
    return structuredClone(existing ?? input);
  }

  process(event: TempoTransferEvent): Promise<DepositRecord> {
    const eventKey = `${event.chainId}:${event.transactionHash.toLowerCase()}:${event.logIndex}`;
    return this.#serial.run(eventKey, async () => {
      assertEvent(event);
      assertPaymentPolicy({ ...this.#policy, chainId: event.chainId, tokenAddress: event.tokenAddress });
      const existing = this.#records.get(eventKey);
      if (existing && existing.status === "reorged") return structuredClone(existing);
      const commitment = this.#commitments.get(event.memo.toLowerCase());
      if (!commitment) return this.store(eventKey, event, "quarantined", "unknown_memo");
      const priorEventKey = this.#memoEvents.get(event.memo.toLowerCase());
      if (priorEventKey && priorEventKey !== eventKey) return this.store(eventKey, event, "quarantined", "memo_replay");
      if (event.to.toLowerCase() !== this.#treasuryAddress.toLowerCase()) return this.store(eventKey, event, "quarantined", "wrong_treasury");
      if (commitment.expectedSender && event.from.toLowerCase() !== commitment.expectedSender.toLowerCase()) return this.store(eventKey, event, "quarantined", "wrong_sender");
      if (event.amountMinor !== commitment.amountMinor) return this.store(eventKey, event, "quarantined", "wrong_amount");
      this.#memoEvents.set(event.memo.toLowerCase(), eventKey);

      if (event.status === "reorged") {
        if (existing?.status === "credited") {
          await this.#ledger.post({
            transactionId: `deposit_reorg:${commitment.commitmentId}`,
            idempotencyKey: `tempo:deposit-reorg:${eventKey}`,
            kind: "refund",
            currency: "USDC",
            referenceId: commitment.commitmentId,
            chainReference: event.transactionHash,
            entries: [
              { accountId: commitment.treasuryLedgerAccountId, amountMinor: -event.amountMinor },
              { accountId: commitment.advertiserLedgerAccountId, amountMinor: event.amountMinor },
            ],
          });
        }
        return this.store(eventKey, event, "reorged", "chain_reorganization", commitment);
      }
      if (existing) return structuredClone(existing);
      await this.#ledger.post({
        transactionId: `deposit:${commitment.commitmentId}`,
        idempotencyKey: `tempo:deposit:${eventKey}`,
        kind: "deposit",
        currency: "USDC",
        referenceId: commitment.commitmentId,
        chainReference: event.transactionHash,
        entries: [
          { accountId: commitment.treasuryLedgerAccountId, amountMinor: event.amountMinor },
          { accountId: commitment.advertiserLedgerAccountId, amountMinor: -event.amountMinor },
        ],
      });
      return this.store(eventKey, event, "credited", undefined, commitment);
    });
  }

  private store(eventKey: string, event: TempoTransferEvent, status: DepositRecord["status"], reason?: string, commitment?: DepositCommitment) {
    const record: DepositRecord = Object.freeze({
      depositId: `deposit:${eventKey}`,
      ...(commitment ? { commitmentId: commitment.commitmentId, campaignId: commitment.campaignId } : {}),
      eventKey,
      memo: event.memo,
      amountMinor: event.amountMinor,
      status,
      ...(reason ? { reason } : {}),
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
      policyVersion: this.#policy.policyVersion,
    });
    this.#records.set(eventKey, record);
    return structuredClone(record);
  }
}

function assertEvent(event: TempoTransferEvent): void {
  validateTempoAddress(event.tokenAddress); validateTempoAddress(event.from); validateTempoAddress(event.to); validateTempoMemo(event.memo);
  if (!/^0x[a-f0-9]{64}$/i.test(event.transactionHash) || !Number.isSafeInteger(event.logIndex) || event.logIndex < 0 || !Number.isSafeInteger(event.blockNumber) || event.blockNumber < 0) throw new Error("Tempo transfer event is malformed");
  assertPositive(event.amountMinor);
  if (!['finalized', 'reorged'].includes(event.status)) throw new Error("Tempo event status is invalid");
}
function assertPositive(value: number) { if (!Number.isSafeInteger(value) || value < 1) throw new Error("Amount must be a positive safe integer"); }
function fingerprint(value: DepositCommitment) { return JSON.stringify(value); }
