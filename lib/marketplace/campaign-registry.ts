import { CampaignTokenService } from "../auth/campaign-token.ts";
import { FixedWindowRateLimiter } from "../http/rate-limit.ts";
import { CampaignService, MemoryBrandVerificationRepository, MemoryCampaignRepository, type OpportunityCandidate } from "@ad-daddy/cli/campaign";
import { CampaignBudgetService } from "./budget.ts";
import { paymentDeposits } from "../payments/deposit-runtime.ts";

const budgets = new CampaignBudgetService();
const brandVerifications = new MemoryBrandVerificationRepository();
const campaigns = new CampaignService(new MemoryCampaignRepository(), budgets, brandVerifications, paymentDeposits);
const tokens = new CampaignTokenService(`runtime-${crypto.randomUUID()}-${crypto.randomUUID()}`);

export const campaignRuntime = Object.freeze({
  budgets,
  campaigns,
  brandVerifications,
  tokens,
  campaignRateLimit: new FixedWindowRateLimiter({ limit: 30, windowMs: 60_000, maxRetryAfterSeconds: 60 }),
  opportunityRateLimit: new FixedWindowRateLimiter({ limit: 60, windowMs: 60_000, maxRetryAfterSeconds: 60 }),
  async listCandidates(campaignId: string): Promise<readonly OpportunityCandidate[]> {
    void campaignId;
    // D1-backed inventory is attached at the API boundary in deployment. Empty
    // inventory fails closed instead of exposing profile records directly.
    return [];
  },
});

export type CampaignRuntime = typeof campaignRuntime;
