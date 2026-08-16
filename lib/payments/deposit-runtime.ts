import { OperatorEventEnvelopeService } from "../auth/operator-event-envelope.ts";
import { D1LedgerRepository, D1PaymentStateRepository, D1RefundApprovalRepository } from "./d1-repositories.ts";
import { DepositService } from "./deposits.ts";
import { LedgerService } from "./ledger.ts";
import type { PaymentPolicyContext } from "./payment-policy.ts";
import { TEMPO_MODERATO_ALPHA_USD, TEMPO_MODERATO_CHAIN_ID } from "./tempo-client.ts";

export interface PaymentBindings {
  DB: D1Database;
  AD_DADDY_ENV: string;
  AD_DADDY_MEMO_SALT: string;
  AD_DADDY_PAYMENT_EVENT_SECRET: string;
}

export function deployedEnvironment(value: string | undefined): "test" | "staging" | "production" {
  if (value === "test" || value === "staging") return value;
  return "production";
}

export function createPaymentCore(bindings: PaymentBindings) {
  if (!bindings.DB) throw new Error("D1 payment binding is required");
  const memoSalt = requireSecret(bindings.AD_DADDY_MEMO_SALT, "AD_DADDY_MEMO_SALT");
  const operatorSecret = requireSecret(bindings.AD_DADDY_PAYMENT_EVENT_SECRET, "AD_DADDY_PAYMENT_EVENT_SECRET");
  const environment = deployedEnvironment(bindings.AD_DADDY_ENV);
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
  const ledgerRepository = new D1LedgerRepository(bindings.DB);
  const ledger = new LedgerService(ledgerRepository);
  const stateRepository = new D1PaymentStateRepository(bindings.DB, policy.policyVersion);
  const refundApprovalRepository = new D1RefundApprovalRepository(bindings.DB);
  return Object.freeze({
    db: bindings.DB, policy, memoSalt, ledgerRepository, ledger, stateRepository, refundApprovalRepository,
    deposits: new DepositService(ledger, policy, `0x${"1".repeat(40)}`, stateRepository),
    operatorEvents: new OperatorEventEnvelopeService(operatorSecret),
  });
}

let deployedCore: ReturnType<typeof createPaymentCore> | undefined;
export async function getPaymentCore() {
  if (deployedCore) return deployedCore;
  const { env } = await import("cloudflare:workers");
  deployedCore = createPaymentCore(env as unknown as PaymentBindings);
  return deployedCore;
}

export const paymentDeposits = Object.freeze({
  async requireCreditedCampaignDeposit(input: { campaignId: string; advertiserAccountId: string; amountMinor: number }) {
    return (await getPaymentCore()).deposits.requireCreditedCampaignDeposit(input);
  },
  async withCreditedCampaignDeposit<T>(input: { campaignId: string; advertiserAccountId: string; amountMinor: number }, action: () => Promise<T>) {
    return (await getPaymentCore()).deposits.withCreditedCampaignDeposit(input, action);
  },
});

function requireSecret(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value.length < 32) throw new Error(`${name} must be a stable secret binding of at least 32 characters`);
  return value;
}
