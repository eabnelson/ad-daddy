import type { AuctionHistory, AuctionNoFillReason } from "./auction.ts";

export interface ReceiverDemandView {
  auctionId: string;
  bidderCount: number;
  status: "open" | "filled" | "no_fill";
  winningGrossMinor?: number;
  receiverTakeHomeMinor?: number;
  operatorFeeMinor?: number;
  matchedSignalNames: readonly string[];
  noFillReason?: AuctionNoFillReason;
  guidance: string;
}

export function buildReceiverDemandView(history: AuctionHistory): ReceiverDemandView {
  const decision = history.decisions[0];
  if (!decision) {
    return Object.freeze({
      auctionId: history.definition.auctionId,
      bidderCount: history.bids.length,
      status: "open",
      matchedSignalNames: Object.freeze([...history.definition.matchedSignalNames]),
      guidance: history.bids.length === 0 ? "No eligible bids yet." : "Eligible demand is building.",
    });
  }
  if (!decision.winner) {
    return Object.freeze({
      auctionId: history.definition.auctionId,
      bidderCount: decision.eligibleBidderCount,
      status: "no_fill",
      matchedSignalNames: Object.freeze([...history.definition.matchedSignalNames]),
      noFillReason: decision.noFillReason,
      guidance: guidanceForNoFill(decision.noFillReason),
    });
  }
  return Object.freeze({
    auctionId: history.definition.auctionId,
    bidderCount: decision.eligibleBidderCount,
    status: "filled",
    winningGrossMinor: decision.winner.grossMinor,
    receiverTakeHomeMinor: decision.winner.receiverMinor,
    operatorFeeMinor: decision.winner.operatorMinor,
    matchedSignalNames: Object.freeze([...history.definition.matchedSignalNames]),
    guidance: decision.eligibleBidderCount > 1 ? "Multiple eligible bidders competed for this placement." : "One eligible bidder met your terms.",
  });
}

function guidanceForNoFill(reason?: AuctionNoFillReason): string {
  if (reason === "budget_unavailable") return "Demand existed, but no campaign budget could be reserved.";
  if (reason === "stale_consent") return "Your profile changed before the auction cleared.";
  if (reason === "receiver_paused" || reason === "receiver_revoked") return "Delivery was stopped by your current preference state.";
  if (reason === "frequency_limited") return "Your delivery-frequency limit was reached before clearance.";
  return "No eligible bid met the active terms.";
}
