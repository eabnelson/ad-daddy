import { KeyedSerialExecutor } from "../runtime/keyed-serial.ts";
import { LedgerService } from "./ledger.ts";
import { assertPaymentPolicy, type PaymentPolicyContext } from "./payment-policy.ts";
import { InMemoryPaymentStateRepository, type PaymentStateRepository } from "./repository.ts";
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
  advertiserAccountId?: string;
  eventKey: string;
  memo: string;
  amountMinor: number;
  tokenAddress: string;
  status: "credited" | "quarantined" | "reorged";
  reason?: string;
  transactionHash: string;
  logIndex: number;
  policyVersion: string;
}

export class DepositService {
  readonly #serial = new KeyedSerialExecutor();
  readonly #ledger: LedgerService;
  readonly #policy: PaymentPolicyContext;
  readonly #treasuryAddress: string;
  readonly #repository: PaymentStateRepository;

  constructor(
    ledger: LedgerService,
    policy: PaymentPolicyContext,
    treasuryAddress: string,
    repository: PaymentStateRepository = new InMemoryPaymentStateRepository(),
  ) {
    validateTempoAddress(treasuryAddress);
    this.#ledger = ledger;
    this.#policy = policy;
    this.#treasuryAddress = treasuryAddress;
    this.#repository = repository;
  }

  async register(input: DepositCommitment): Promise<DepositCommitment> {
    validateTempoMemo(input.memo);
    assertPositive(input.amountMinor);
    if (input.expectedSender) validateTempoAddress(input.expectedSender);
    const existing = await this.#repository.getDepositCommitment(input.memo);
    if (existing && fingerprint(existing) !== fingerprint(input)) throw new Error("Deposit memo commitment collision");
    return this.#repository.putDepositCommitment(input);
  }

  async process(event: TempoTransferEvent): Promise<DepositRecord> {
    const eventKey = `${event.chainId}:${event.transactionHash.toLowerCase()}:${event.logIndex}`;
    assertEvent(event);
    assertPaymentPolicy({ ...this.#policy, chainId: event.chainId, tokenAddress: event.tokenAddress });
    const knownCommitment = await this.#repository.getDepositCommitment(event.memo);
    const serialKey = knownCommitment ? `campaign:${knownCommitment.campaignId}` : `event:${eventKey}`;
    return this.#serial.run(serialKey, async () => {
      const existing = await this.#repository.getDepositRecord(eventKey);
      if (existing && existing.status === "reorged") return structuredClone(existing);
      const commitment = await this.#repository.getDepositCommitment(event.memo);
      if (!commitment) return this.store(eventKey, event, "quarantined", "unknown_memo");
      const priorEvent = await this.#repository.getDepositRecordByMemo(event.memo);
      if (priorEvent && priorEvent.eventKey !== eventKey) return this.store(eventKey, event, "quarantined", "memo_replay");
      if (event.to.toLowerCase() !== this.#treasuryAddress.toLowerCase()) return this.store(eventKey, event, "quarantined", "wrong_treasury");
      if (commitment.expectedSender && event.from.toLowerCase() !== commitment.expectedSender.toLowerCase()) return this.store(eventKey, event, "quarantined", "wrong_sender");
      if (event.amountMinor !== commitment.amountMinor) return this.store(eventKey, event, "quarantined", "wrong_amount");
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

  async requireCreditedCampaignDeposit(input: { campaignId: string; advertiserAccountId: string; amountMinor: number }): Promise<{ depositId: string }> {
    return this.#findCreditedCampaignDeposit(input);
  }

  withCreditedCampaignDeposit<T>(input: { campaignId: string; advertiserAccountId: string; amountMinor: number }, action: () => Promise<T>): Promise<T> {
    return this.#serial.run(`campaign:${input.campaignId}`, async () => {
      await this.#findCreditedCampaignDeposit(input);
      return action();
    });
  }

  async #findCreditedCampaignDeposit(input: { campaignId: string; advertiserAccountId: string; amountMinor: number }): Promise<{ depositId: string }> {
    const match = await this.#repository.findCreditedCampaignDeposit({ ...input, tokenAddress: this.#policy.tokenAddress });
    if (!match) throw new Error("A credited, unreorged deposit for this account, campaign, asset, and exact maximum spend is required");
    return { depositId: match.depositId };
  }

  private async store(eventKey: string, event: TempoTransferEvent, status: DepositRecord["status"], reason?: string, commitment?: DepositCommitment) {
    const record: DepositRecord = Object.freeze({
      depositId: `deposit:${eventKey}`,
      ...(commitment ? { commitmentId: commitment.commitmentId, campaignId: commitment.campaignId } : {}),
      ...(commitment ? { advertiserAccountId: commitment.advertiserAccountId } : {}),
      eventKey,
      memo: event.memo,
      amountMinor: event.amountMinor,
      tokenAddress: event.tokenAddress,
      status,
      ...(reason ? { reason } : {}),
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
      policyVersion: this.#policy.policyVersion,
    });
    return this.#repository.putDepositRecord(record);
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
