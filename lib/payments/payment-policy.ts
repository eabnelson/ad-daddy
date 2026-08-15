import type { Environment } from "../domain/types.ts";

export interface PaymentPolicyContext {
  environment: Environment;
  policyVersion: string;
  chainId: number;
  tokenAddress: string;
  allowlistedChainId: number;
  allowlistedTokenAddress: string;
  productionFundsEnabled: boolean;
  approvals: {
    legal: boolean;
    custody: boolean;
    dataProtection: boolean;
    designPartners: boolean;
  };
}

export function assertPaymentPolicy(input: PaymentPolicyContext): void {
  if (!input.policyVersion || input.policyVersion.length > 128) throw new Error("Payment policy version is required");
  if (input.chainId !== input.allowlistedChainId || input.tokenAddress.toLowerCase() !== input.allowlistedTokenAddress.toLowerCase()) {
    throw new Error("Payment asset is not allowlisted");
  }
  if (input.environment === "production" && (!input.productionFundsEnabled || Object.values(input.approvals).some((approved) => !approved))) {
    throw new Error("Production funds are disabled until every launch approval is recorded");
  }
}
