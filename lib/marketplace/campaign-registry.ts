import { CampaignTokenService } from "../auth/campaign-token.ts";
import { D1CampaignTokenStore } from "../auth/d1-campaign-token.ts";
import { FixedWindowRateLimiter } from "../http/rate-limit.ts";
import { CampaignService, MemoryBrandVerificationRepository, MemoryCampaignRepository, type OpportunityCandidate } from "@ad-daddy/cli/campaign";
import { CampaignBudgetService } from "./budget.ts";
import { D1BrandVerificationRepository, D1CampaignBudgetService, D1CampaignRepository } from "./d1-campaign.ts";
import { createPaymentCore, type PaymentBindings } from "../payments/deposit-runtime.ts";
import { D1OpportunityCandidateRepository } from "./d1-opportunity-candidates.ts";

export interface CampaignBindings extends PaymentBindings {
  AD_DADDY_CAMPAIGN_TOKEN_SECRET: string;
}

export function createMemoryCampaignRuntime() {
  const budgets = new CampaignBudgetService();
  const brandVerifications = new MemoryBrandVerificationRepository();
  const funding = {
    async requireCreditedCampaignDeposit() { return { depositId: "memory-deposit" }; },
    async withCreditedCampaignDeposit<T>(_input: unknown, action: () => Promise<T>) { return action(); },
  };
  return buildRuntime({
    budgets,
    brandVerifications,
    campaigns: new CampaignService(new MemoryCampaignRepository(), budgets, brandVerifications, funding),
    tokenSecret: "memory-campaign-token-secret-at-least-32-bytes",
  });
}

export function createCampaignRuntime(bindings: CampaignBindings) {
  if (!bindings.DB) throw new Error("D1 campaign binding is required");
  if (typeof bindings.AD_DADDY_CAMPAIGN_TOKEN_SECRET !== "string" || bindings.AD_DADDY_CAMPAIGN_TOKEN_SECRET.length < 32) {
    throw new Error("AD_DADDY_CAMPAIGN_TOKEN_SECRET must be a stable secret binding of at least 32 characters");
  }
  const budgets = new D1CampaignBudgetService(bindings.DB);
  const brandVerifications = new D1BrandVerificationRepository(bindings.DB);
  const payment = createPaymentCore(bindings);
  return buildRuntime({
    budgets,
    brandVerifications,
    campaigns: new CampaignService(new D1CampaignRepository(bindings.DB), budgets, brandVerifications, payment.deposits),
    tokenSecret: bindings.AD_DADDY_CAMPAIGN_TOKEN_SECRET,
    tokenStore: new D1CampaignTokenStore(bindings.DB),
    candidates: new D1OpportunityCandidateRepository(bindings.DB),
  });
}

function buildRuntime(input: {
  budgets: CampaignBudgetService | D1CampaignBudgetService;
  brandVerifications: MemoryBrandVerificationRepository | D1BrandVerificationRepository;
  campaigns: CampaignService;
  tokenSecret: string;
  tokenStore?: ConstructorParameters<typeof CampaignTokenService>[1];
  candidates?: D1OpportunityCandidateRepository;
}) {
  return Object.freeze({
    budgets: input.budgets,
    campaigns: input.campaigns,
    brandVerifications: input.brandVerifications,
    tokens: new CampaignTokenService(input.tokenSecret, input.tokenStore),
    campaignRateLimit: new FixedWindowRateLimiter({ limit: 30, windowMs: 60_000, maxRetryAfterSeconds: 60 }),
    opportunityRateLimit: new FixedWindowRateLimiter({ limit: 60, windowMs: 60_000, maxRetryAfterSeconds: 60 }),
    async listCandidates(campaignId: string): Promise<readonly OpportunityCandidate[]> {
      return input.candidates?.list(campaignId) ?? [];
    },
  });
}

export const campaignRuntime = createMemoryCampaignRuntime();
export type CampaignRuntime = ReturnType<typeof createMemoryCampaignRuntime> | ReturnType<typeof createCampaignRuntime>;

let deployedRuntime: ReturnType<typeof createCampaignRuntime> | undefined;
export async function getCampaignRuntime(): Promise<ReturnType<typeof createCampaignRuntime>> {
  if (deployedRuntime) return deployedRuntime;
  const { env } = await import("cloudflare:workers");
  deployedRuntime = createCampaignRuntime(env as unknown as CampaignBindings);
  return deployedRuntime;
}
