import type { OpportunityState, PlacementState } from "./types.ts";

const TRANSITIONS: Readonly<Record<PlacementState, readonly PlacementState[]>> = {
  offered: ["bidding", "no_fill"],
  bidding: ["won", "no_fill"],
  won: ["delivered", "expired"],
  delivered: ["settled"],
  settled: ["conversion_pending"],
  conversion_pending: ["conversion_paid", "conversion_rejected"],
  conversion_paid: [],
  conversion_rejected: [],
  no_fill: [],
  expired: [],
};

export function transitionPlacement<TTo extends PlacementState>(from: PlacementState, to: TTo): TTo {
  if (!TRANSITIONS[from].includes(to)) throw new Error(`Illegal placement transition: ${from} -> ${to}`);
  return to;
}

export function invalidateForConsentChange(
  opportunity: OpportunityState,
  currentConsentVersion: number,
): OpportunityState {
  if (opportunity.consentVersion === currentConsentVersion) return opportunity;
  if (opportunity.state === "no_fill") return opportunity;
  transitionPlacement(opportunity.state, "no_fill");
  return Object.freeze({
    ...opportunity,
    state: "no_fill",
    invalidatedReason: "stale_consent",
  });
}

export function invalidateForReceiverControl(
  opportunity: OpportunityState,
  reason: "receiver_paused" | "receiver_revoked",
): OpportunityState {
  if (opportunity.state === "no_fill") return opportunity;
  transitionPlacement(opportunity.state, "no_fill");
  return Object.freeze({ ...opportunity, state: "no_fill", invalidatedReason: reason });
}
