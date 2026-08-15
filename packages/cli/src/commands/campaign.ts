import type { RewardType } from "./profile.js";
import { findEligibleOpportunities, type OpportunityCandidate, type OpportunityView } from "./opportunity.js";

export type { OpportunityCandidate, OpportunityView } from "./opportunity.js";
export const ADVERTISER_TERMS_VERSION = "advertiser-terms/1";

export interface CampaignDraft {
  campaignId: string;
  accountId: string;
  advertiserTermsVersion: string;
  brand: { name: string; verifiedDomain: string; ownershipVerified: boolean };
  destinationUrl: string;
  schedule: { startsAt: string; endsAt: string };
  allowlistedDestinationHosts: readonly string[];
  categories: readonly string[];
  regions: readonly string[];
  hosts: readonly string[];
  rewardTypes: readonly RewardType[];
  creative: { headline: string; body: string };
  maximumSpendMinor: number;
  maximumBidMinor: number;
  dailyCapMinor: number;
  guaranteedPlacementMinor: number;
  conversionBonusMinor?: number;
  conversionTerms: string;
  perUserFrequencyLimit: number;
}

export interface CampaignRecord extends CampaignDraft {
  status: "draft" | "funding_pending" | "active" | "paused" | "closed";
  fundedMinor: number;
  termsAcceptedAt?: string;
  activatedAt?: string;
  closedAt?: string;
}

export interface CampaignApproval {
  accountId: string;
  approvedAt: string;
  expiresAt: string;
  purposes: readonly string[];
  approvedCampaignId: string;
  approvedMaximumSpendMinor: number;
  approvedDestinationUrl: string;
  approvedConversionTerms: string;
}

interface BudgetSnapshot { withdrawableMinor: number; }
interface BudgetService {
  open(input: { campaignId: string; fundedMinor: number; dailyCapMinor: number }): unknown;
  pause(campaignId: string): Promise<unknown>;
  resume(campaignId: string): Promise<unknown>;
  close(campaignId: string): Promise<BudgetSnapshot>;
  snapshot(campaignId: string): BudgetSnapshot;
  balance(campaignId: string): BudgetSnapshot;
  reserve(campaignId: string, reservationId: string, amountMinor: number, now?: Date): Promise<unknown>;
}

export interface CampaignRepository {
  get(campaignId: string): Promise<CampaignRecord | undefined>;
  put(campaign: CampaignRecord): Promise<void>;
}

export class MemoryCampaignRepository implements CampaignRepository {
  readonly #records = new Map<string, CampaignRecord>();
  async get(id: string) { const value = this.#records.get(id); return value ? structuredClone(value) : undefined; }
  async put(value: CampaignRecord) { this.#records.set(value.campaignId, structuredClone(value)); }
}

export class CampaignService {
  readonly #repository: CampaignRepository;
  readonly #budgets: BudgetService;
  constructor(repository: CampaignRepository, budgets: BudgetService) { this.#repository = repository; this.#budgets = budgets; }

  async prepare(input: CampaignDraft): Promise<CampaignRecord> {
    validateCampaign(input);
    const existing = await this.#repository.get(input.campaignId);
    if (existing?.status === "closed") throw new Error("Closed campaigns cannot be changed");
    if (existing && existing.accountId !== input.accountId) throw new Error("Campaign belongs to another advertiser account");
    if (existing && existing.status !== "draft") throw new Error(`Campaign cannot be edited after leaving draft status (${existing.status})`);
    const record: CampaignRecord = {
      ...structuredClone(input),
      status: existing?.status ?? "draft",
      fundedMinor: existing?.fundedMinor ?? 0,
      ...(existing?.termsAcceptedAt ? { termsAcceptedAt: existing.termsAcceptedAt } : {}),
      ...(existing?.activatedAt ? { activatedAt: existing.activatedAt } : {}),
    };
    await this.#repository.put(record);
    return structuredClone(record);
  }

  async fund(campaignId: string, amountMinor: number, approval: CampaignApproval, now = new Date()): Promise<CampaignRecord> {
    const campaign = await this.require(campaignId);
    assertApproval(campaign, approval, ["advertiser_verify", "terms_accept", "campaign_fund"], now);
    if (amountMinor !== campaign.maximumSpendMinor || approval.approvedMaximumSpendMinor !== amountMinor) throw new Error("Funding must match the human-approved maximum spend");
    if (campaign.fundedMinor === amountMinor && campaign.status === "funding_pending") return structuredClone(campaign);
    if (campaign.fundedMinor !== 0) throw new Error("Campaign is already funded");
    this.#budgets.open({ campaignId, fundedMinor: amountMinor, dailyCapMinor: campaign.dailyCapMinor });
    campaign.fundedMinor = amountMinor;
    campaign.status = "funding_pending";
    campaign.termsAcceptedAt = now.toISOString();
    await this.#repository.put(campaign);
    return structuredClone(campaign);
  }

  async activate(campaignId: string, approval: CampaignApproval | undefined, now = new Date()): Promise<CampaignRecord> {
    const campaign = await this.require(campaignId);
    if (!approval) throw new Error("Human approval is required for production activation");
    assertActivationReady(campaign);
    assertApproval(campaign, approval, ["advertiser_verify", "terms_accept", "campaign_fund", "production_activate"], now);
    if (Date.parse(campaign.schedule.endsAt) <= now.getTime()) throw new Error("Campaign schedule has already ended");
    if (campaign.fundedMinor < campaign.maximumSpendMinor || this.#budgets.balance(campaignId).withdrawableMinor <= 0) throw new Error("Campaign must be funded before activation");
    campaign.status = "active";
    campaign.activatedAt = now.toISOString();
    await this.#repository.put(campaign);
    return structuredClone(campaign);
  }

  async pause(campaignId: string): Promise<CampaignRecord> {
    const campaign = await this.require(campaignId);
    if (campaign.status !== "active") throw new Error("Only an active campaign can be paused");
    await this.#budgets.pause(campaignId);
    campaign.status = "paused";
    await this.#repository.put(campaign);
    return structuredClone(campaign);
  }

  async resume(campaignId: string): Promise<CampaignRecord> {
    const campaign = await this.require(campaignId);
    if (campaign.status !== "paused" || !campaign.activatedAt) throw new Error("Only a previously approved paused campaign can resume");
    assertActivationReady(campaign);
    await this.#budgets.resume(campaignId);
    campaign.status = "active";
    await this.#repository.put(campaign);
    return structuredClone(campaign);
  }

  async close(campaignId: string, approval: CampaignApproval, now = new Date()) {
    const campaign = await this.require(campaignId);
    assertApproval(campaign, approval, ["campaign_close"], now);
    const budget = await this.#budgets.close(campaignId);
    campaign.status = "closed";
    campaign.closedAt = now.toISOString();
    await this.#repository.put(campaign);
    return { campaign: structuredClone(campaign), withdrawableMinor: budget.withdrawableMinor };
  }

  async reserveBid(campaignId: string, reservationId: string, amountMinor: number, now = new Date()) {
    const campaign = await this.requireActive(campaignId, now);
    if (amountMinor > campaign.maximumBidMinor) throw new Error("Campaign bid ceiling exceeded");
    return this.#budgets.reserve(campaignId, reservationId, amountMinor, now);
  }

  async search(campaignId: string, candidates: readonly OpportunityCandidate[], now = new Date()): Promise<OpportunityView[]> {
    const campaign = await this.requireActive(campaignId, now);
    if (this.#budgets.balance(campaignId).withdrawableMinor <= 0) throw new Error("Campaign has no available funded budget");
    return findEligibleOpportunities(campaign, candidates, now);
  }

  async get(campaignId: string) { return this.require(campaignId); }

  private async require(campaignId: string) {
    const campaign = await this.#repository.get(campaignId);
    if (!campaign) throw new Error("Unknown campaign");
    return campaign;
  }
  private async requireActive(campaignId: string, now = new Date()) {
    const campaign = await this.require(campaignId);
    if (campaign.status !== "active") throw new Error(`Campaign is ${campaign.status}; active status is required`);
    assertActivationReady(campaign);
    if (Date.parse(campaign.schedule.startsAt) > now.getTime() || Date.parse(campaign.schedule.endsAt) <= now.getTime()) throw new Error("Campaign is outside its approved schedule");
    return campaign;
  }
}

function validateCampaign(input: CampaignDraft): void {
  const allowedKeys = new Set(["campaignId", "accountId", "advertiserTermsVersion", "brand", "destinationUrl", "allowlistedDestinationHosts", "schedule", "categories", "regions", "hosts", "rewardTypes", "creative", "maximumSpendMinor", "maximumBidMinor", "dailyCapMinor", "guaranteedPlacementMinor", "conversionBonusMinor", "conversionTerms", "perUserFrequencyLimit"]);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowedKeys.has(key))) throw new Error("Campaign contains unsupported fields");
  if (!input.brand || typeof input.brand !== "object" || Array.isArray(input.brand) || Object.keys(input.brand).some((key) => !["name", "verifiedDomain", "ownershipVerified"].includes(key)) || typeof input.brand.ownershipVerified !== "boolean") throw new Error("Campaign brand is invalid");
  if (!input.creative || typeof input.creative !== "object" || Array.isArray(input.creative) || Object.keys(input.creative).some((key) => !["headline", "body"].includes(key))) throw new Error("Campaign creative is invalid");
  if (!input.schedule || typeof input.schedule !== "object" || Array.isArray(input.schedule) || Object.keys(input.schedule).some((key) => !["startsAt", "endsAt"].includes(key))) throw new Error("Campaign schedule is invalid");
  for (const [name, value] of [["campaignId", input.campaignId], ["accountId", input.accountId], ["terms version", input.advertiserTermsVersion], ["brand name", input.brand.name], ["conversion terms", input.conversionTerms]] as const) {
    if (!value || value.length > 512) throw new Error(`${name} is required and bounded`);
  }
  if (input.advertiserTermsVersion !== ADVERTISER_TERMS_VERSION) throw new Error(`Advertiser terms ${ADVERTISER_TERMS_VERSION} must be accepted`);
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(input.brand.verifiedDomain)) throw new Error("Verified brand domain is invalid");
  const destination = parseDestination(input.destinationUrl);
  if (!input.allowlistedDestinationHosts.includes(destination.hostname) || !(destination.hostname === input.brand.verifiedDomain || destination.hostname.endsWith(`.${input.brand.verifiedDomain}`))) throw new Error("Destination must be allowlisted under the verified brand domain");
  if (!validStringList(input.allowlistedDestinationHosts, 20) || !validStringList(input.categories, 20) || !validStringList(input.regions, 20) || !validStringList(input.hosts, 10) || !Array.isArray(input.rewardTypes) || input.rewardTypes.length === 0 || input.rewardTypes.length > 3 || new Set(input.rewardTypes).size !== input.rewardTypes.length || input.rewardTypes.some((reward) => !["stablecoin", "credits", "discount"].includes(reward))) throw new Error("Campaign audience collections are invalid");
  const startsAt = Date.parse(input.schedule.startsAt);
  const endsAt = Date.parse(input.schedule.endsAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt >= endsAt) throw new Error("Campaign schedule must have valid ordered timestamps");
  if (!input.creative.headline.trim() || !input.creative.body.trim() || input.creative.headline.length > 120 || input.creative.body.length > 4_000) throw new Error("Campaign creative must be non-empty and bounded");
  for (const [name, value] of [["maximum spend", input.maximumSpendMinor], ["maximum bid", input.maximumBidMinor], ["daily cap", input.dailyCapMinor], ["placement reward", input.guaranteedPlacementMinor], ["frequency", input.perUserFrequencyLimit]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  }
  if (input.maximumBidMinor > input.maximumSpendMinor || input.dailyCapMinor > input.maximumSpendMinor || input.guaranteedPlacementMinor > input.maximumBidMinor) throw new Error("Campaign spending envelope is inconsistent");
  if (input.conversionBonusMinor !== undefined && (!Number.isSafeInteger(input.conversionBonusMinor) || input.conversionBonusMinor < 0 || input.conversionBonusMinor > input.maximumSpendMinor)) throw new Error("Conversion bonus must be a bounded non-negative safe integer");
}

function parseDestination(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Error("Destination must be an allowlisted HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Destination must be an allowlisted HTTPS URL");
  return url;
}
function assertActivationReady(campaign: CampaignRecord): void {
  if (!campaign.brand.ownershipVerified) throw new Error("Brand ownership must be verified");
  parseDestination(campaign.destinationUrl);
  if (!campaign.advertiserTermsVersion || !campaign.termsAcceptedAt) throw new Error("Versioned advertiser terms must be accepted");
}
function validStringList(input: readonly string[], maximum: number): boolean {
  return Array.isArray(input) && input.length > 0 && input.length <= maximum && new Set(input).size === input.length && input.every((value) => typeof value === "string" && value.length > 0 && value.length <= 128);
}
function assertApproval(campaign: CampaignRecord, approval: CampaignApproval, purposes: readonly string[], now: Date): void {
  const approvedAt = Date.parse(approval.approvedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  if (approval.accountId !== campaign.accountId || approval.approvedCampaignId !== campaign.campaignId || !purposes.every((purpose) => approval.purposes.includes(purpose)) || approval.approvedMaximumSpendMinor !== campaign.maximumSpendMinor || approval.approvedDestinationUrl !== campaign.destinationUrl || approval.approvedConversionTerms !== campaign.conversionTerms || !Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || approvedAt > now.getTime() || expiresAt <= now.getTime() || approvedAt >= expiresAt) {
    throw new Error("Recent human approval for campaign identity, money, destination, and conversion terms is required");
  }
}
