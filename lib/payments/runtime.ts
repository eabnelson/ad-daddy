import { FixedWindowRateLimiter } from "../http/rate-limit.ts";
import { campaignRuntime } from "../marketplace/campaign-registry.ts";
import { AttributionService, ConversionEvidenceVerifier } from "../marketplace/attribution.ts";
import { DepositService } from "./deposits.ts";
import { InMemoryLedgerRepository, LedgerService } from "./ledger.ts";
import { PayoutDestinationRegistry, PayoutService } from "./payouts.ts";
import { RefundService } from "./refunds.ts";
import {
  SyntheticTempoClient,
  TEMPO_MODERATO_ALPHA_USD,
  TEMPO_MODERATO_CHAIN_ID,
} from "./tempo-client.ts";
import type { CampaignBudgetSnapshot } from "../marketplace/budget.ts";
import type { PaymentPolicyContext } from "./payment-policy.ts";

const environment = process.env.AD_DADDY_ENV === "production" ? "production" : "test";
const policy: PaymentPolicyContext = Object.freeze({
  environment,
  policyVersion: "closed-beta-payments/v1",
  chainId: TEMPO_MODERATO_CHAIN_ID,
  tokenAddress: TEMPO_MODERATO_ALPHA_USD,
  allowlistedChainId: TEMPO_MODERATO_CHAIN_ID,
  allowlistedTokenAddress: TEMPO_MODERATO_ALPHA_USD,
  productionFundsEnabled: false,
  approvals: Object.freeze({ legal: false, custody: false, dataProtection: false, designPartners: false }),
});
const ledgerRepository = new InMemoryLedgerRepository();
const ledger = new LedgerService(ledgerRepository);
const tempo = new SyntheticTempoClient();
const memoSalt = process.env.AD_DADDY_MEMO_SALT ?? `runtime-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const destinations = new PayoutDestinationRegistry(86_400_000);
const conversionVerifier = new ConversionEvidenceVerifier();

export const paymentRuntime = Object.freeze({
  policy,
  memoSalt,
  ledger,
  ledgerRepository,
  tempo,
  deposits: new DepositService(ledger, policy, `0x${"1".repeat(40)}`),
  destinations,
  payouts: new PayoutService({ destinations, tempo, ledger, policy, tokenAddress: TEMPO_MODERATO_ALPHA_USD, memoSalt, periodCeilingMinor: 100_000 }),
  refunds: new RefundService({ tempo, ledger, policy, tokenAddress: TEMPO_MODERATO_ALPHA_USD, memoSalt }),
  conversionVerifier,
  attribution: new AttributionService(campaignRuntime.budgets, ledger, conversionVerifier),
  closedCampaigns: new Map<string, CampaignBudgetSnapshot>(),
  rateLimit: new FixedWindowRateLimiter({ limit: 30, windowMs: 60_000, maxRetryAfterSeconds: 60 }),
});

export type PaymentRuntime = typeof paymentRuntime;
