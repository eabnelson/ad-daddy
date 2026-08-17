import { verifiedAccountId } from "./verified-request-identity.ts";

export type AccountAgentScope = "campaign:manage" | "placement:read" | "placement:act" | "report:read";

interface AccountAgentClaims {
  version: 1;
  tokenId: string;
  accountId: string;
  scopes: AccountAgentScope[];
  issuedAt: string;
  expiresAt: string;
}

export class AccountAgentTokenService {
  readonly #secret: Uint8Array;
  #key?: Promise<CryptoKey>;
  constructor(secret: string) {
    if (new TextEncoder().encode(secret).byteLength < 32) throw new Error("Account agent token secret must be at least 32 bytes");
    this.#secret = new TextEncoder().encode(secret);
  }

  async issue(input: { accountId: string; scopes: AccountAgentScope[]; expiresAt: string }, now = new Date()): Promise<string> {
    if (!input.accountId || input.accountId.length > 128 || input.scopes.length === 0 || input.scopes.some((scope) => !SCOPES.has(scope))) throw new Error("Account agent token request is invalid");
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime() || expiresAt - now.getTime() > 15 * 60_000) throw new Error("Account agent token must expire within 15 minutes");
    const claims: AccountAgentClaims = {
      version: 1, tokenId: crypto.randomUUID(), accountId: input.accountId, scopes: [...new Set(input.scopes)],
      issuedAt: now.toISOString(), expiresAt: input.expiresAt,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${payload}.${await this.sign(payload)}`;
  }

  async verify(token: string, scope: AccountAgentScope, now = new Date()): Promise<AccountAgentClaims> {
    const [payload, signature, ...extra] = token.split(".");
    if (!payload || !signature || extra.length || token.length > 4_096) throw new Error("Invalid account agent token");
    const valid = await crypto.subtle.verify("HMAC", await this.key(), Buffer.from(signature, "base64url"), new TextEncoder().encode(payload));
    if (!valid) throw new Error("Invalid account agent token signature");
    let claims: AccountAgentClaims;
    try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AccountAgentClaims; }
    catch { throw new Error("Invalid account agent token payload"); }
    if (claims.version !== 1 || !claims.accountId || !Array.isArray(claims.scopes) || !claims.scopes.includes(scope) ||
      claims.scopes.some((candidate) => !SCOPES.has(candidate)) || Date.parse(claims.issuedAt) > now.getTime() || Date.parse(claims.expiresAt) <= now.getTime()) {
      throw new Error("Account agent token is expired or lacks scope");
    }
    return Object.freeze({ ...claims, scopes: [...claims.scopes] });
  }

  private async sign(payload: string) {
    return Buffer.from(await crypto.subtle.sign("HMAC", await this.key(), new TextEncoder().encode(payload))).toString("base64url");
  }
  private key() {
    this.#key ??= crypto.subtle.importKey("raw", this.#secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    return this.#key;
  }
}

const SCOPES = new Set<AccountAgentScope>(["campaign:manage", "placement:read", "placement:act", "report:read"]);

let deployed: AccountAgentTokenService | undefined;
async function deployedService() {
  if (deployed) return deployed;
  const { env } = await import("cloudflare:workers");
  if (!env.AD_DADDY_ACCOUNT_AGENT_TOKEN_SECRET) throw new Error("Account agent token secret binding is required");
  deployed = new AccountAgentTokenService(env.AD_DADDY_ACCOUNT_AGENT_TOKEN_SECRET);
  return deployed;
}

export async function authenticateAccountRequest(request: Request, scope: AccountAgentScope): Promise<string | undefined> {
  const human = verifiedAccountId(request);
  if (human) return human;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const service = await deployedService();
  return authenticateAccountBearer(authorization.slice(7), scope, service);
}

export async function authenticateAccountBearer(
  token: string,
  scope: AccountAgentScope,
  service: AccountAgentTokenService,
): Promise<string | undefined> {
  try {
    return (await service.verify(token, scope)).accountId;
  } catch {
    return undefined;
  }
}

export async function issueDeployedAccountAgentToken(accountId: string, scopes: AccountAgentScope[], expiresAt: string) {
  return (await deployedService()).issue({ accountId, scopes, expiresAt });
}
