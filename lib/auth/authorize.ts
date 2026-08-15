import type { HumanApproval, HumanApprovalPurpose } from "../domain/types.ts";

export type AuthorizationAction =
  | "profile:read"
  | "profile:write"
  | "profile:private:read"
  | "financial_history:read"
  | "opportunity:open"
  | "receipt:submit"
  | "campaign:read"
  | "campaign:write"
  | "opportunity:search"
  | "bid:submit"
  | "placement:sign"
  | "payout:execute"
  | "audit:read"
  | "hold:apply";

export type Actor =
  | { kind: "human"; accountId: string }
  | { kind: "installation"; accountId: string; installationId: string }
  | { kind: "campaign_agent"; accountId: string; campaignId: string; scopes: readonly AuthorizationAction[] }
  | { kind: "marketplace_signer"; environment: string; scopes: readonly AuthorizationAction[] }
  | { kind: "treasury_payment"; environment: string; scopes: readonly AuthorizationAction[] }
  | { kind: "operator_admin"; accountId: string; scopes: readonly AuthorizationAction[] };

export type Resource =
  | { kind: "profile"; accountId: string; profileId: string }
  | { kind: "installation"; accountId: string; installationId: string }
  | { kind: "campaign"; accountId: string; campaignId: string }
  | { kind: "financial_history"; accountId: string }
  | { kind: "placement"; accountId: string; placementId: string; installationId?: string; campaignId?: string }
  | { kind: "system"; environment: string; resourceId: string };

export interface AuthorizationRequest {
  actor: Actor;
  action: AuthorizationAction;
  resource: Resource;
}

export class AuthorizationError extends Error {
  constructor(message = "Actor is not authorized for this resource") {
    super(message);
    this.name = "AuthorizationError";
  }
}

function sameAccount(actor: Extract<Actor, { accountId: string }>, resource: Resource): boolean {
  return "accountId" in resource && actor.accountId === resource.accountId;
}

export function authorize(request: AuthorizationRequest): void {
  const { actor, action, resource } = request;
  let allowed = false;

  if (actor.kind === "human") {
    allowed = sameAccount(actor, resource) && [
      "profile:read",
      "profile:write",
      "profile:private:read",
      "financial_history:read",
      "campaign:read",
      "campaign:write",
    ].includes(action);
  } else if (actor.kind === "installation") {
    allowed =
      sameAccount(actor, resource) &&
      resource.kind === "installation" &&
      resource.installationId === actor.installationId &&
      ["profile:read", "opportunity:open", "receipt:submit"].includes(action);
  } else if (actor.kind === "campaign_agent") {
    allowed =
      actor.scopes.includes(action) &&
      resource.kind === "campaign" &&
      sameAccount(actor, resource) &&
      resource.campaignId === actor.campaignId &&
      ["campaign:read", "opportunity:search", "bid:submit"].includes(action);
  } else if (actor.kind === "marketplace_signer") {
    allowed = resource.kind === "system" && resource.environment === actor.environment && action === "placement:sign" && actor.scopes.includes(action);
  } else if (actor.kind === "treasury_payment") {
    allowed = resource.kind === "system" && resource.environment === actor.environment && action === "payout:execute" && actor.scopes.includes(action);
  } else if (actor.kind === "operator_admin") {
    allowed = actor.scopes.includes(action) && ["audit:read", "hold:apply"].includes(action);
  }

  if (!allowed) throw new AuthorizationError();
}

export function assertRecentHumanApproval(
  approval: HumanApproval,
  accountId: string,
  purpose: HumanApprovalPurpose,
  now = new Date(),
): void {
  const approvedAt = Date.parse(approval.approvedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  if (
    approval.accountId !== accountId ||
    !Array.isArray(approval.purposes) ||
    !approval.purposes.includes(purpose) ||
    !Number.isFinite(approvedAt) ||
    !Number.isFinite(expiresAt) ||
    approvedAt > now.getTime() ||
    expiresAt <= now.getTime() ||
    approvedAt >= expiresAt
  ) {
    throw new AuthorizationError(`Recent human approval for ${purpose} is required`);
  }
}
