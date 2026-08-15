import { calculateRevenueSplit, LAUNCH_REVENUE_SPLIT } from "../payments/ledger.ts";
import type { RewardType } from "../domain/types.ts";

export interface AuctionBid {
  bidId: string;
  campaignId: string;
  grossMinor: number;
  rewardLane: RewardType;
  submittedAt: string;
}

export interface RankedAuctionBid extends AuctionBid {
  receiverMinor: number;
  operatorMinor: number;
}

export function validateAndPriceBid(
  bid: AuctionBid,
  policy: { rewardLane: RewardType; minimumTakeHomeMinor: number },
): RankedAuctionBid {
  for (const [name, value] of [["bidId", bid.bidId], ["campaignId", bid.campaignId]] as const) {
    if (!value || value.length > 128) throw new Error(`${name} must be non-empty and bounded`);
  }
  if (bid.rewardLane !== policy.rewardLane) throw new Error("Bid does not match the auction reward lane");
  if (!Number.isSafeInteger(bid.grossMinor) || bid.grossMinor < 0) throw new Error("Bid gross amount must be a non-negative safe integer");
  if (!Number.isSafeInteger(policy.minimumTakeHomeMinor) || policy.minimumTakeHomeMinor < 0) throw new Error("Take-home minimum must be a non-negative safe integer");
  const submittedAt = Date.parse(bid.submittedAt);
  if (!Number.isFinite(submittedAt)) throw new Error("Bid submission time is invalid");

  if (policy.rewardLane !== "stablecoin") {
    if (policy.minimumTakeHomeMinor !== 0) throw new Error("Non-cash reward lanes cannot satisfy a cash take-home minimum");
    if (bid.grossMinor !== 0) throw new Error("Credits and discounts cannot increase auction rank");
    return Object.freeze({ ...bid, receiverMinor: 0, operatorMinor: 0 });
  }

  if (bid.grossMinor < 1) throw new Error("Cash bids must be positive");
  const split = calculateRevenueSplit(bid.grossMinor, LAUNCH_REVENUE_SPLIT);
  if (split.receiverMinor < policy.minimumTakeHomeMinor) {
    throw new Error("Bid does not satisfy the receiver take-home minimum after the operator fee");
  }
  return Object.freeze({ ...bid, ...split });
}

export function rankEligibleBids(bids: readonly RankedAuctionBid[]): readonly RankedAuctionBid[] {
  return Object.freeze([...bids].sort((left, right) => {
    if (left.rewardLane === "stablecoin" && right.rewardLane === "stablecoin" && left.grossMinor !== right.grossMinor) {
      return right.grossMinor - left.grossMinor;
    }
    return left.campaignId.localeCompare(right.campaignId) || left.bidId.localeCompare(right.bidId);
  }));
}
