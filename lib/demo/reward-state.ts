import type { DemoActionReward } from "./market.ts";

export type DemoCashRewardState = Readonly<{
  balanceMinor: number;
  completedActionIds: readonly DemoActionReward["id"][];
  creditedPlacementIds: readonly string[];
}>;

export const INITIAL_DEMO_CASH_REWARDS: DemoCashRewardState = Object.freeze({
  balanceMinor: 0,
  completedActionIds: Object.freeze([]),
  creditedPlacementIds: Object.freeze([]),
});

export function creditDemoPlacement(
  state: DemoCashRewardState,
  placementId: string,
  receiverTakeHomeMinor: number,
): DemoCashRewardState {
  if (state.creditedPlacementIds.includes(placementId)) return state;
  return Object.freeze({
    ...state,
    balanceMinor: state.balanceMinor + receiverTakeHomeMinor,
    creditedPlacementIds: Object.freeze([...state.creditedPlacementIds, placementId]),
  });
}

export function creditDemoAction(
  state: DemoCashRewardState,
  reward: DemoActionReward,
): DemoCashRewardState {
  if (state.completedActionIds.includes(reward.id)) return state;
  return Object.freeze({
    ...state,
    balanceMinor: state.balanceMinor + reward.receiverTakeHomeMinor,
    completedActionIds: Object.freeze([...state.completedActionIds, reward.id]),
  });
}
