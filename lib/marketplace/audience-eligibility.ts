import type { RewardType } from "../domain/types.ts";

export interface StoredCampaignAudience {
  categories: readonly string[];
  regions: readonly string[];
  hosts: readonly string[];
  rewardTypes: readonly RewardType[];
}

export interface StoredOpportunityAudience {
  fields: Record<string, unknown>;
  host: string;
  rewardLane?: RewardType;
}

export function parseStoredCampaignAudience(value: unknown): StoredCampaignAudience {
  const source = record(value);
  return Object.freeze({
    categories: Object.freeze(strings(source.categories)),
    regions: Object.freeze(strings(source.regions)),
    hosts: Object.freeze(strings(source.hosts).map(normalize)),
    rewardTypes: Object.freeze(rewards(source.rewardTypes)),
  });
}

export function matchStoredOpportunity(
  campaign: StoredCampaignAudience,
  opportunity: StoredOpportunityAudience,
): { category: string; region: string; host: string; rewardTypes: readonly RewardType[] } | undefined {
  const host = normalize(opportunity.host);
  const region = typeof opportunity.fields.coarseLocation === "string"
    ? campaign.regions.find((candidate) => normalize(candidate) === normalize(opportunity.fields.coarseLocation as string))
    : undefined;
  const category = matchCategory(campaign.categories, opportunity.fields);
  let rewardTypes = rewards(opportunity.fields.acceptedRewardTypes)
    .filter((reward) => campaign.rewardTypes.includes(reward));
  if (opportunity.rewardLane) rewardTypes = rewardTypes.filter((reward) => reward === opportunity.rewardLane);
  if (!category || !region || !campaign.hosts.includes(host) || rewardTypes.length === 0) return undefined;
  return Object.freeze({ category, region, host, rewardTypes: Object.freeze(rewardTypes) });
}

function matchCategory(categories: readonly string[], fields: Record<string, unknown>): string | undefined {
  const signals = new Set<string>();
  const stacks = fields.privateRepoTechStacks;
  if (Array.isArray(stacks)) {
    for (const stack of stacks) if (Array.isArray(stack)) {
      for (const item of stack) if (typeof item === "string") signals.add(normalize(item));
    }
  }
  const descriptions = fields.projectDescriptions;
  if (Array.isArray(descriptions)) {
    for (const description of descriptions) if (typeof description === "string") {
      for (const word of description.split(/[^a-z0-9]+/i)) if (word) signals.add(normalize(word));
    }
  }
  const databaseSignals = ["postgres", "postgresql", "drizzle", "prisma", "redis", "database"];
  return categories.find((category) => {
    const normalized = normalize(category);
    return signals.has(normalized) || (normalized === "database" && databaseSignals.some((signal) => signals.has(signal)));
  });
}

export function rewards(value: unknown): RewardType[] {
  return strings(value).filter((item): item is RewardType => ["stablecoin", "credits", "discount"].includes(item));
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Durable audience JSON is malformed");
  return value as Record<string, unknown>;
}

function normalize(value: string): string { return value.trim().toLowerCase(); }
