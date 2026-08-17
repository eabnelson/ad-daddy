import { issueDeployedAccountAgentToken, type AccountAgentScope } from "../../../../lib/auth/account-agent-token.ts";
import { parseBoundedJson } from "../../../../lib/http/request-limits.ts";
import { verifiedAccountId } from "../../../../lib/auth/verified-request-identity.ts";

const LIMITS = { maxBytes: 4_096, maxDepth: 3, maxCollectionItems: 8, maxStringLength: 128 } as const;

type TokenIssuer = (accountId: string, scopes: AccountAgentScope[], expiresAt: string) => Promise<string>;

export function createAccountAgentTokenHandler(issueToken: TokenIssuer = issueDeployedAccountAgentToken) {
  return async function handle(request: Request): Promise<Response> {
    const accountId = verifiedAccountId(request);
    if (!accountId) return Response.json({ error: "human_authentication_required" }, { status: 401 });
    try {
      const body = await parseBoundedJson(request, LIMITS) as { scopes?: AccountAgentScope[]; expiresAt?: string };
      if (!Array.isArray(body.scopes) || typeof body.expiresAt !== "string") throw new Error("Token scope and expiry are required");
      const token = await issueToken(accountId, body.scopes, body.expiresAt);
      return Response.json({ token, expiresAt: body.expiresAt }, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
      return Response.json({ error: "account_agent_token_rejected", message: (error instanceof Error ? error.message : "Request rejected").slice(0, 160) }, { status: 400 });
    }
  };
}

export const POST = createAccountAgentTokenHandler();
