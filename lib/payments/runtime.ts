import { FixedWindowRateLimiter } from "../http/rate-limit.ts";
import { D1CampaignBudgetService } from "../marketplace/d1-campaign.ts";
import { AttributionService, ConversionEvidenceVerifier } from "../marketplace/attribution.ts";
import { getPaymentCore, type PaymentBindings } from "./deposit-runtime.ts";
import { PayoutDestinationRegistry, PayoutService } from "./payouts.ts";
import { RefundApprovalRegistry, RefundHumanProofStore, RefundService } from "./refunds.ts";
import { SyntheticTempoClient, TEMPO_MODERATO_ALPHA_USD } from "./tempo-client.ts";

export async function createPaymentRuntime(bindings: PaymentBindings): Promise<PaymentRuntime> {
  const { createPaymentCore } = await import("./deposit-runtime.ts");
  return assemble(createPaymentCore(bindings));
}

let runtime: PaymentRuntime | undefined;
export async function getPaymentRuntime(): Promise<PaymentRuntime> {
  if (!runtime) runtime = assemble(await getPaymentCore());
  return runtime;
}

function assemble(core: Awaited<ReturnType<typeof getPaymentCore>>): PaymentRuntime {
  const tempo = new SyntheticTempoClient();
  const destinations = new PayoutDestinationRegistry(86_400_000, core.stateRepository);
  const conversionVerifier = new ConversionEvidenceVerifier();
  const refundProofs = new RefundHumanProofStore(core.refundApprovalRepository);
  const refundApprovals = new RefundApprovalRegistry(refundProofs);
  const budgets = new D1CampaignBudgetService(core.db);
  return Object.freeze({
    policy: core.policy,
    memoSalt: core.memoSalt,
    ledger: core.ledger,
    ledgerRepository: core.ledgerRepository,
    paymentStateRepository: core.stateRepository,
    tempo,
    deposits: core.deposits,
    operatorEvents: core.operatorEvents,
    destinations,
    payouts: new PayoutService({
      destinations, tempo, ledger: core.ledger, policy: core.policy, tokenAddress: TEMPO_MODERATO_ALPHA_USD,
      memoSalt: core.memoSalt, periodCeilingMinor: 100_000, repository: core.stateRepository,
    }),
    refundProofs,
    refundApprovals,
    refunds: new RefundService({
      tempo, ledger: core.ledger, policy: core.policy, tokenAddress: TEMPO_MODERATO_ALPHA_USD,
      memoSalt: core.memoSalt, budgets, approvals: refundApprovals, repository: core.stateRepository,
    }),
    conversionVerifier,
    attribution: new AttributionService(budgets, core.ledger, conversionVerifier, {
      durableAuthorityRequired: core.policy.environment === "production",
    }),
    rateLimit: new FixedWindowRateLimiter({ limit: 30, windowMs: 60_000, maxRetryAfterSeconds: 60 }),
  });
}

export interface PaymentRuntime {
  readonly policy: Awaited<ReturnType<typeof getPaymentCore>>["policy"];
  readonly memoSalt: string;
  readonly ledger: Awaited<ReturnType<typeof getPaymentCore>>["ledger"];
  readonly ledgerRepository: Awaited<ReturnType<typeof getPaymentCore>>["ledgerRepository"];
  readonly paymentStateRepository: Awaited<ReturnType<typeof getPaymentCore>>["stateRepository"];
  readonly tempo: SyntheticTempoClient;
  readonly deposits: Awaited<ReturnType<typeof getPaymentCore>>["deposits"];
  readonly operatorEvents: Awaited<ReturnType<typeof getPaymentCore>>["operatorEvents"];
  readonly destinations: PayoutDestinationRegistry;
  readonly payouts: PayoutService;
  readonly refundProofs: RefundHumanProofStore;
  readonly refundApprovals: RefundApprovalRegistry;
  readonly refunds: RefundService;
  readonly conversionVerifier: ConversionEvidenceVerifier;
  readonly attribution: AttributionService;
  readonly rateLimit: FixedWindowRateLimiter;
}
