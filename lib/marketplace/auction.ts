import type { ConsentStatus, RewardType } from "../domain/types.ts";
import { rankEligibleBids, validateAndPriceBid, type AuctionBid, type RankedAuctionBid } from "./ranking.ts";
import { KeyedSerialExecutor } from "../runtime/keyed-serial.ts";
import { BudgetUnavailableError } from "./budget-error.ts";

export { BudgetUnavailableError } from "./budget-error.ts";

export type AuctionNoFillReason =
  | "no_eligible_bids"
  | "budget_unavailable"
  | "receiver_paused"
  | "receiver_revoked"
  | "stale_consent"
  | "frequency_limited";

export interface AuctionDefinition {
  auctionId: string;
  opportunityId: string;
  rewardLane: RewardType;
  consentVersion: number;
  minimumTakeHomeMinor: number;
  matchedSignalNames: readonly string[];
  closesAt: string;
}

export interface AuctionWinner extends RankedAuctionBid {
  reservationId?: string;
}

export interface AuctionDecision {
  decisionId: string;
  auctionId: string;
  opportunityId: string;
  decidedAt: string;
  eligibleBidderCount: number;
  winner?: AuctionWinner;
  noFillReason?: AuctionNoFillReason;
}

export interface AuctionHistory {
  definition: AuctionDefinition;
  bids: readonly RankedAuctionBid[];
  decisions: readonly AuctionDecision[];
}

interface AuctionRecord {
  definition: AuctionDefinition;
  bids: Map<string, RankedAuctionBid>;
  campaignIds: Set<string>;
  decision?: AuctionDecision;
}

export interface AuctionBudgetGateway {
  reserve(campaignId: string, reservationId: string, amountMinor: number, now?: Date): Promise<unknown>;
}

export interface AuctionClearance {
  now: Date;
  receiverStatus: ConsentStatus;
  currentConsentVersion: number;
  frequencyEligible?: boolean;
  eligibleCampaignIds?: readonly string[];
}

const MAX_AUCTION_BIDS = 100;

export class AuctionService {
  readonly #budgets: AuctionBudgetGateway;
  readonly #records = new Map<string, AuctionRecord>();
  readonly #serial = new KeyedSerialExecutor();

  constructor(budgets: AuctionBudgetGateway) { this.#budgets = budgets; }

  open(input: AuctionDefinition): AuctionHistory {
    validateDefinition(input);
    if (this.#records.has(input.auctionId)) throw new Error("Auction already exists");
    const definition = freezeDefinition(input);
    this.#records.set(input.auctionId, { definition, bids: new Map(), campaignIds: new Set() });
    return this.history(input.auctionId);
  }

  restore(input: { definition: AuctionDefinition; bids: readonly RankedAuctionBid[] }): AuctionHistory {
    validateDefinition(input.definition);
    if (this.#records.has(input.definition.auctionId)) throw new Error("Auction already exists");
    if (input.bids.length > MAX_AUCTION_BIDS) throw new Error("Auction bid limit exceeded");
    const definition = freezeDefinition(input.definition);
    const bids = new Map<string, RankedAuctionBid>();
    const campaignIds = new Set<string>();
    for (const stored of input.bids) {
      const priced = validateAndPriceBid(stored, definition);
      if (!sameRankedBid(priced, stored) || bids.has(priced.bidId) || campaignIds.has(priced.campaignId)) {
        throw new Error("Stored auction bid is invalid");
      }
      bids.set(priced.bidId, priced);
      campaignIds.add(priced.campaignId);
    }
    this.#records.set(definition.auctionId, { definition, bids, campaignIds });
    return this.history(definition.auctionId);
  }

  async bid(auctionId: string, input: AuctionBid, now = new Date()): Promise<RankedAuctionBid> {
    return this.#serial.run(auctionId, () => {
      const record = this.require(auctionId);
      if (record.decision) throw new Error("Auction is already decided");
      if (now.getTime() >= Date.parse(record.definition.closesAt)) throw new Error("Auction deadline has passed");
      const priced = validateAndPriceBid(input, record.definition);
      if (Date.parse(priced.submittedAt) > now.getTime()) throw new Error("Bid submission time cannot be in the future");
      const existing = record.bids.get(input.bidId);
      if (existing) {
        if (fingerprintBid(existing) !== fingerprintBid(priced)) throw new Error("Bid idempotency key collision");
        return existing;
      }
      if (record.campaignIds.has(priced.campaignId)) {
        throw new Error("A campaign may submit only one bid per auction");
      }
      if (record.bids.size >= MAX_AUCTION_BIDS) throw new Error("Auction bid limit exceeded");
      record.bids.set(priced.bidId, priced);
      record.campaignIds.add(priced.campaignId);
      return priced;
    });
  }

  async clear(
    auctionId: string,
    input: AuctionClearance,
  ): Promise<AuctionDecision> {
    return this.#serial.run(auctionId, async () => {
      const record = this.require(auctionId);
      if (record.decision) return record.decision;
      const closesAt = Date.parse(record.definition.closesAt);
      if (input.now.getTime() < closesAt) throw new Error("Auction deadline has not arrived");
      const eligibleCampaignIds = input.eligibleCampaignIds && new Set(input.eligibleCampaignIds);
      const ranked = rankEligibleBids([...record.bids.values()].filter((bid) => !eligibleCampaignIds || eligibleCampaignIds.has(bid.campaignId)));
      const noFillReason = receiverNoFillReason(record.definition, input);
      if (noFillReason) return this.decide(record, input.now, ranked.length, undefined, noFillReason);
      if (ranked.length === 0) return this.decide(record, input.now, 0, undefined, "no_eligible_bids");

      for (const bid of ranked) {
        if (record.definition.rewardLane !== "stablecoin") {
          return this.decide(record, input.now, ranked.length, Object.freeze({
            ...bid,
            reservationId: `offer:${record.definition.auctionId}:${bid.bidId}`,
          }));
        }
        const reservationId = `auction:${record.definition.auctionId}:bid:${bid.bidId}`;
        try {
          await this.#budgets.reserve(bid.campaignId, reservationId, bid.grossMinor, input.now);
          return this.decide(record, input.now, ranked.length, Object.freeze({ ...bid, reservationId }));
        } catch (error) {
          if (!(error instanceof BudgetUnavailableError)) throw error;
          // The next ranked bid may still have an available, independently
          // bounded campaign balance. Reservation failures reveal no balance.
        }
      }
      return this.decide(record, input.now, ranked.length, undefined, "budget_unavailable");
    });
  }

  history(auctionId: string): AuctionHistory {
    const record = this.require(auctionId);
    return Object.freeze({
      definition: record.definition,
      bids: Object.freeze([...record.bids.values()]),
      decisions: Object.freeze(record.decision ? [record.decision] : []),
    });
  }

  private decide(
    record: AuctionRecord,
    now: Date,
    bidderCount: number,
    winner?: AuctionWinner,
    noFillReason?: AuctionNoFillReason,
  ): AuctionDecision {
    const decision = Object.freeze({
      decisionId: `decision:${record.definition.auctionId}`,
      auctionId: record.definition.auctionId,
      opportunityId: record.definition.opportunityId,
      decidedAt: now.toISOString(),
      eligibleBidderCount: bidderCount,
      ...(winner ? { winner } : {}),
      ...(noFillReason ? { noFillReason } : {}),
    });
    record.decision = decision;
    return decision;
  }

  private require(auctionId: string): AuctionRecord {
    const record = this.#records.get(auctionId);
    if (!record) throw new Error("Unknown auction");
    return record;
  }

}

function validateDefinition(input: AuctionDefinition): void {
  for (const [name, value] of [["auctionId", input.auctionId], ["opportunityId", input.opportunityId]] as const) {
    if (!value || value.length > 128) throw new Error(`${name} must be non-empty and bounded`);
  }
  if (!["stablecoin", "credits", "discount"].includes(input.rewardLane)) throw new Error("Auction reward lane is invalid");
  if (!Number.isSafeInteger(input.consentVersion) || input.consentVersion < 1) throw new Error("Auction consent version must be positive");
  if (!Number.isSafeInteger(input.minimumTakeHomeMinor) || input.minimumTakeHomeMinor < 0) throw new Error("Auction take-home minimum is invalid");
  if (input.rewardLane !== "stablecoin" && input.minimumTakeHomeMinor !== 0) throw new Error("Non-cash auctions cannot satisfy a cash minimum");
  if (!Array.isArray(input.matchedSignalNames) || input.matchedSignalNames.length > 20 || new Set(input.matchedSignalNames).size !== input.matchedSignalNames.length || input.matchedSignalNames.some((value) => !value || value.length > 128)) throw new Error("Matched signal names are invalid");
  if (!Number.isFinite(Date.parse(input.closesAt))) throw new Error("Auction deadline is invalid");
}

function freezeDefinition(input: AuctionDefinition): AuctionDefinition {
  return Object.freeze({ ...input, matchedSignalNames: Object.freeze([...input.matchedSignalNames]) });
}

function receiverNoFillReason(
  definition: AuctionDefinition,
  input: Omit<AuctionClearance, "now">,
): AuctionNoFillReason | undefined {
  if (input.receiverStatus === "paused") return "receiver_paused";
  if (input.receiverStatus === "revoked") return "receiver_revoked";
  if (input.currentConsentVersion !== definition.consentVersion) return "stale_consent";
  if (input.frequencyEligible === false) return "frequency_limited";
  return undefined;
}

function fingerprintBid(bid: RankedAuctionBid): string {
  return JSON.stringify([bid.campaignId, bid.grossMinor, bid.rewardLane, bid.submittedAt]);
}

function sameRankedBid(left: RankedAuctionBid, right: RankedAuctionBid): boolean {
  return left.bidId === right.bidId && left.campaignId === right.campaignId && left.grossMinor === right.grossMinor &&
    left.rewardLane === right.rewardLane && left.submittedAt === right.submittedAt &&
    left.receiverMinor === right.receiverMinor && left.operatorMinor === right.operatorMinor;
}
