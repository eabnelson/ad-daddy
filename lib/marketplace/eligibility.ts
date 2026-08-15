import type { ReceiverProfileFields, RewardType } from "../domain/types.ts";

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

const PUBLIC_FIELD_KEYS = [
  "coarseLocation",
  "privateRepoTechStacks",
  "projectDescriptions",
  "adFrequency",
  "subscriptionTier",
  "tokenUsageRange",
  "totalSessionRange",
  "acceptedRewardTypes",
  "minimumTakeHomeMinor",
] as const satisfies readonly (keyof ReceiverProfileFields)[];

export function findEligibleOpportunities(
  campaign: CampaignEligibilityPolicy,
  candidates: readonly OpportunityCandidate[],
  now = new Date(),
): EligibleOpportunity[] {
  if (candidates.length > 100) throw new Error("Opportunity search is limited to 100 candidates per page");
  const seen = new Set<string>();
  const results: EligibleOpportunity[] = [];
  for (const candidate of candidates) {
    if (!candidate.rotatingOpportunityId || seen.has(candidate.rotatingOpportunityId)) continue;
    seen.add(candidate.rotatingOpportunityId);
    if (candidate.consentVersion !== candidate.currentConsentVersion) continue;
    if (!Number.isFinite(Date.parse(candidate.expiresAt)) || Date.parse(candidate.expiresAt) <= now.getTime()) continue;
    if (!campaign.categories.includes(candidate.category)) continue;
    if (!campaign.regions.includes(candidate.region)) continue;
    if (!campaign.hosts.includes(candidate.host)) continue;
    let rewardTypes = campaign.rewardTypes.filter((reward) => candidate.acceptedRewardTypes.includes(reward));
    if (!candidate.hasCashPayoutAddress) rewardTypes = rewardTypes.filter((reward) => reward !== "stablecoin");
    if (rewardTypes.length === 0) continue;
    const needsCash = rewardTypes.includes("stablecoin");

    const fields: ReceiverProfileFields = {};
    for (const key of PUBLIC_FIELD_KEYS) {
      const value = candidate.fields[key];
      if (value !== undefined) Object.assign(fields, { [key]: structuredClone(value) });
    }
    const identityWarnings: string[] = [];
    if (candidate.preBidExposure.projectNames && candidate.fields.projectNames !== undefined) {
      fields.projectNames = structuredClone(candidate.fields.projectNames);
      identityWarnings.push("projectNames may directly identify the receiver");
    }
    if (candidate.preBidExposure.publicRepositoryUrls && candidate.fields.publicRepositoryUrls !== undefined) {
      fields.publicRepositoryUrls = structuredClone(candidate.fields.publicRepositoryUrls);
      identityWarnings.push("publicRepositoryUrls may directly identify the receiver");
    }
    results.push(Object.freeze({
      opportunityId: candidate.rotatingOpportunityId,
      expiresAt: candidate.expiresAt,
      category: candidate.category,
      region: candidate.region,
      host: candidate.host,
      rewardTypes: Object.freeze([...rewardTypes]),
      requiresCashPayoutAddress: needsCash,
      fields: Object.freeze(fields),
      identityWarnings: Object.freeze(identityWarnings),
    }));
  }
  return results;
}
