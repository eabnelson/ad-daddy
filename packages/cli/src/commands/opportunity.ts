import type { RewardType } from "./profile.js";

export interface OpportunityCampaignPolicy {
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
  fields: Record<string, unknown>;
  preBidExposure: Readonly<{ projectNames: boolean; publicRepositoryUrls: boolean }>;
  hasCashPayoutAddress?: boolean;
}

export interface OpportunityView {
  opportunityId: string;
  expiresAt: string;
  category: string;
  region: string;
  host: string;
  rewardTypes: readonly RewardType[];
  fields: Record<string, unknown>;
  identityWarnings: readonly string[];
  requiresCashPayoutAddress: boolean;
}

const PRE_BID_FIELD_KEYS = [
  "coarseLocation", "privateRepoTechStacks", "projectDescriptions", "adFrequency",
  "subscriptionTier", "tokenUsageRange", "totalSessionRange", "acceptedRewardTypes", "minimumTakeHomeMinor",
] as const;

export function findEligibleOpportunities(
  campaign: OpportunityCampaignPolicy,
  candidates: readonly OpportunityCandidate[],
  now = new Date(),
): OpportunityView[] {
  if (candidates.length > 2_000) throw new Error("Opportunity search exceeded the bounded candidate scan");
  const seen = new Set<string>();
  const results: OpportunityView[] = [];
  for (const candidate of candidates) {
    if (!candidate.rotatingOpportunityId || seen.has(candidate.rotatingOpportunityId)) continue;
    seen.add(candidate.rotatingOpportunityId);
    const expiry = Date.parse(candidate.expiresAt);
    if (candidate.consentVersion !== candidate.currentConsentVersion || !Number.isFinite(expiry) || expiry <= now.getTime()) continue;
    if (!campaign.categories.includes(candidate.category) || !campaign.regions.includes(candidate.region) || !campaign.hosts.includes(candidate.host)) continue;
    let rewardTypes = campaign.rewardTypes.filter((reward) => candidate.acceptedRewardTypes.includes(reward));
    if (!candidate.hasCashPayoutAddress) rewardTypes = rewardTypes.filter((reward) => reward !== "stablecoin");
    if (rewardTypes.length === 0) continue;

    const fields: Record<string, unknown> = {};
    for (const key of PRE_BID_FIELD_KEYS) {
      if (candidate.fields[key] !== undefined) fields[key] = structuredClone(candidate.fields[key]);
    }
    const identityWarnings: string[] = [];
    exposeIdentifyingField(candidate, fields, identityWarnings, "projectNames");
    exposeIdentifyingField(candidate, fields, identityWarnings, "publicRepositoryUrls");
    results.push(Object.freeze({
      opportunityId: candidate.rotatingOpportunityId,
      expiresAt: candidate.expiresAt,
      category: candidate.category,
      region: candidate.region,
      host: candidate.host,
      rewardTypes: Object.freeze([...rewardTypes]),
      fields: Object.freeze(fields),
      identityWarnings: Object.freeze(identityWarnings),
      requiresCashPayoutAddress: rewardTypes.includes("stablecoin"),
    }));
  }
  return results;
}

function exposeIdentifyingField(
  candidate: OpportunityCandidate,
  fields: Record<string, unknown>,
  warnings: string[],
  key: "projectNames" | "publicRepositoryUrls",
): void {
  if (!candidate.preBidExposure[key] || candidate.fields[key] === undefined) return;
  fields[key] = structuredClone(candidate.fields[key]);
  warnings.push(`${key} may directly identify the receiver`);
}
