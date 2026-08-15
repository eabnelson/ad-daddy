import { createHmac, timingSafeEqual } from "node:crypto";

import { calculateRevenueSplit, LAUNCH_REVENUE_SPLIT, LedgerService } from "../payments/ledger.ts";

export interface SignedConversionEvidence {
  eventId: string;
  provider: string;
  keyId: string;
  campaignId: string;
  placementId: string;
  evidenceType: string;
  amountMinor: number;
  occurredAt: string;
  signature: string;
}

interface ConversionBudgetGateway {
  hold(campaignId: string, holdId: string, amountMinor: number): Promise<unknown>;
  commitHold(campaignId: string, holdId: string): Promise<unknown>;
  releaseHold(campaignId: string, holdId: string): Promise<unknown>;
}

export interface ConversionTerms {
  placementId: string;
  campaignId: string;
  receiverLedgerAccountId: string;
  advertiserLedgerAccountId: string;
  operatorLedgerAccountId: string;
  evidenceType: string;
  bonusGrossMinor: number;
  claimDeadline: string;
  disputeHoldMs: number;
  policyVersion: string;
}

export interface ConversionRecord {
  placementId: string;
  campaignId: string;
  holdId: string;
  status: "awaiting_evidence" | "pending" | "paid" | "rejected";
  eventId?: string;
  releaseAt?: string;
  transactionId?: string;
  receiverMinor: number;
  operatorMinor: number;
  reason?: string;
  policyVersion: string;
}

export class ConversionEvidenceVerifier {
  readonly #keys = new Map<string, string>();
  allow(provider: string, keyId: string, secret: string): void {
    if (!provider || provider === "advertiser" || !keyId || secret.length < 32) throw new Error("Allowlisted conversion provider key is invalid");
    this.#keys.set(`${provider}:${keyId}`, secret);
  }
  sign(input: Omit<SignedConversionEvidence, "signature">): SignedConversionEvidence {
    const secret = this.#keys.get(`${input.provider}:${input.keyId}`);
    if (!secret) throw new Error("Unknown conversion evidence provider");
    return { ...input, signature: hmac(input, secret) };
  }
  verify(input: SignedConversionEvidence): void {
    const secret = this.#keys.get(`${input.provider}:${input.keyId}`);
    if (!secret) throw new Error("Conversion evidence provider is not allowlisted");
    const expected = Buffer.from(hmac(withoutSignature(input), secret), "base64url");
    const actual = Buffer.from(input.signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Conversion evidence signature is invalid");
  }
}

export class AttributionService {
  readonly #terms = new Map<string, ConversionTerms>();
  readonly #records = new Map<string, ConversionRecord>();
  readonly #eventIds = new Map<string, string>();
  readonly #budgets: ConversionBudgetGateway;
  readonly #ledger: LedgerService;
  readonly #verifier: ConversionEvidenceVerifier;
  constructor(budgets: ConversionBudgetGateway, ledger: LedgerService, verifier: ConversionEvidenceVerifier) {
    this.#budgets = budgets; this.#ledger = ledger; this.#verifier = verifier;
  }

  async open(input: ConversionTerms): Promise<ConversionRecord> {
    assertTerms(input);
    const existing = this.#records.get(input.placementId);
    if (existing) {
      if (JSON.stringify(this.#terms.get(input.placementId)) !== JSON.stringify(input)) throw new Error("Conversion hold idempotency collision");
      return existing;
    }
    const split = calculateRevenueSplit(input.bonusGrossMinor, LAUNCH_REVENUE_SPLIT);
    const holdId = `conversion:${input.placementId}`;
    await this.#budgets.hold(input.campaignId, holdId, input.bonusGrossMinor);
    this.#terms.set(input.placementId, structuredClone(input));
    const record: ConversionRecord = Object.freeze({
      placementId: input.placementId, campaignId: input.campaignId, holdId,
      status: "awaiting_evidence", receiverMinor: split.receiverMinor,
      operatorMinor: split.operatorMinor, policyVersion: input.policyVersion,
    });
    this.#records.set(input.placementId, record);
    return record;
  }

  submit(input: SignedConversionEvidence, now = new Date()): ConversionRecord {
    this.#verifier.verify(input);
    const terms = this.#terms.get(input.placementId);
    const record = this.#records.get(input.placementId);
    if (!terms || !record) throw new Error("Unknown conversion hold");
    if (input.campaignId !== terms.campaignId || input.evidenceType !== terms.evidenceType || input.amountMinor !== terms.bonusGrossMinor) throw new Error("Conversion evidence does not match campaign terms");
    const occurredAt = Date.parse(input.occurredAt);
    if (!Number.isFinite(occurredAt) || occurredAt > now.getTime() || occurredAt > Date.parse(terms.claimDeadline) || now.getTime() > Date.parse(terms.claimDeadline)) throw new Error("Conversion evidence is outside the claim window");
    const priorPlacement = this.#eventIds.get(input.eventId);
    if (priorPlacement && priorPlacement !== input.placementId) throw new Error("Conversion evidence replay detected");
    if (record.eventId) {
      if (record.eventId !== input.eventId) throw new Error("Placement already has conversion evidence");
      return record;
    }
    this.#eventIds.set(input.eventId, input.placementId);
    const pending: ConversionRecord = Object.freeze({
      ...record, status: "pending", eventId: input.eventId,
      releaseAt: new Date(now.getTime() + terms.disputeHoldMs).toISOString(),
    });
    this.#records.set(input.placementId, pending);
    return pending;
  }

  async settle(placementId: string, now = new Date()): Promise<ConversionRecord> {
    const terms = this.#terms.get(placementId);
    const record = this.#records.get(placementId);
    if (!terms || !record) throw new Error("Unknown conversion hold");
    if (record.status === "paid") return record;
    if (record.status !== "pending" || !record.releaseAt || Date.parse(record.releaseAt) > now.getTime()) throw new Error("Conversion dispute hold has not cleared");
    await this.#budgets.commitHold(terms.campaignId, record.holdId);
    const transactionId = `conversion_settlement:${placementId}`;
    await this.#ledger.post({
      transactionId,
      idempotencyKey: `conversion:${placementId}:${record.eventId}`,
      kind: "conversion_settlement", currency: "USDC", referenceId: placementId,
      splitVersion: LAUNCH_REVENUE_SPLIT.version,
      entries: [
        { accountId: terms.advertiserLedgerAccountId, amountMinor: -terms.bonusGrossMinor },
        { accountId: terms.receiverLedgerAccountId, amountMinor: record.receiverMinor },
        { accountId: terms.operatorLedgerAccountId, amountMinor: record.operatorMinor },
      ],
    });
    const paid: ConversionRecord = Object.freeze({ ...record, status: "paid", transactionId });
    this.#records.set(placementId, paid);
    return paid;
  }

  async reject(placementId: string, reason: string): Promise<ConversionRecord> {
    const terms = this.#terms.get(placementId);
    const record = this.#records.get(placementId);
    if (!terms || !record || record.status === "paid") throw new Error("Conversion cannot be rejected");
    await this.#budgets.releaseHold(terms.campaignId, record.holdId);
    const rejected: ConversionRecord = Object.freeze({ ...record, status: "rejected", reason: reason.slice(0, 240) });
    this.#records.set(placementId, rejected);
    return rejected;
  }
}

function hmac(input: Omit<SignedConversionEvidence, "signature">, secret: string): string {
  return createHmac("sha256", secret).update(JSON.stringify([
    input.eventId, input.provider, input.keyId, input.campaignId, input.placementId,
    input.evidenceType, input.amountMinor, input.occurredAt,
  ])).digest("base64url");
}
function withoutSignature(input: SignedConversionEvidence): Omit<SignedConversionEvidence, "signature"> {
  const unsigned: Partial<SignedConversionEvidence> = { ...input };
  delete unsigned.signature;
  return unsigned as Omit<SignedConversionEvidence, "signature">;
}
function assertTerms(input: ConversionTerms) {
  if (!input.placementId || !input.campaignId || !input.evidenceType || !input.policyVersion || !Number.isSafeInteger(input.bonusGrossMinor) || input.bonusGrossMinor < 1 || !Number.isSafeInteger(input.disputeHoldMs) || input.disputeHoldMs < 0 || !Number.isFinite(Date.parse(input.claimDeadline))) throw new Error("Conversion terms are invalid");
}
