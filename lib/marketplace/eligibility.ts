import type { ReceiverProfileFields, RewardType } from "../domain/types.ts";
import { findEligibleOpportunities as projectEligibleOpportunities, type OpportunityCandidate as CliOpportunityCandidate } from "@ad-daddy/cli/opportunity";

export interface CampaignEligibilityPolicy {
  campaignId: string;
  categories: readonly string[];
  regions: readonly string[];
  hosts: readonly string[];
  rewardTypes: readonly RewardType[];
}

export interface OpportunityCandidate {
  rotatingOpportunityId: string;
  category: string;
  region: string;
  host: string;
  acceptedRewardTypes: readonly RewardType[];
  consentVersion: number;
  currentConsentVersion: number;
  expiresAt: string;
  fields: ReceiverProfileFields;
  preBidExposure: Readonly<{ projectNames: boolean; publicRepositoryUrls: boolean }>;
  hasCashPayoutAddress?: boolean;
  receiverProfileId?: string;
  installationId?: string;
}

export interface EligibleOpportunity {
  opportunityId: string;
  expiresAt: string;
  category: string;
  region: string;
  host: string;
  rewardTypes: readonly RewardType[];
  requiresCashPayoutAddress: boolean;
  fields: ReceiverProfileFields;
  identityWarnings: readonly string[];
}

export function findEligibleOpportunities(
  campaign: CampaignEligibilityPolicy,
  candidates: readonly OpportunityCandidate[],
  now = new Date(),
): EligibleOpportunity[] {
  return projectEligibleOpportunities(campaign, candidates as readonly CliOpportunityCandidate[], now) as EligibleOpportunity[];
}
