const TOKEN_SCOPES = new Set(["campaign:read", "opportunity:search", "bid:submit"]);

export interface CampaignTokenClaims {
  tokenId: string;
  accountId: string;
  campaignId: string;
  scopes: readonly string[];
  spendCeilingMinor: number;
  bidCeilingMinor: number;
  issuedAt: string;
  expiresAt: string;
}

export interface VerifiedCampaignAuthorization { readonly claims: CampaignTokenClaims; }
interface SpendAuthorizationResult {
  claims: CampaignTokenClaims;
  authorizedMinor: number;
  remainingMinor: number;
  newlyAuthorized: boolean;
}

export class CampaignTokenService {
  readonly #secret: Uint8Array;
  readonly #revoked = new Map<string, number>();
  readonly #spend = new Map<string, { usedMinor: number; expiresAt: number; idempotency: Map<string, { amountMinor: number; committed: boolean }> }>();
  readonly #expiries = new Map<string, number>();
  readonly #verified = new WeakSet<VerifiedCampaignAuthorization>();
  #key?: Promise<CryptoKey>;
  #operations = 0;
  constructor(secret: string) {
    if (new TextEncoder().encode(secret).byteLength < 32) throw new Error("Campaign token secret must be at least 32 bytes");
    this.#secret = new TextEncoder().encode(secret);
  }

  async issue(input: Omit<CampaignTokenClaims, "issuedAt">, now = new Date()): Promise<string> {
    this.purgeExpired(now.getTime());
    validateText(input.tokenId, "tokenId");
    validateText(input.accountId, "accountId");
    validateText(input.campaignId, "campaignId");
    if (input.scopes.length === 0 || input.scopes.length > 3 || new Set(input.scopes).size !== input.scopes.length || input.scopes.some((scope) => !TOKEN_SCOPES.has(scope))) {
      throw new Error("Campaign token contains an invalid scope");
    }
    assertCeiling(input.spendCeilingMinor, "spend ceiling");
    assertCeiling(input.bidCeilingMinor, "bid ceiling");
    if (input.bidCeilingMinor > input.spendCeilingMinor && input.spendCeilingMinor !== 0) throw new Error("Bid ceiling cannot exceed spend ceiling");
    const expires = Date.parse(input.expiresAt);
    if (!Number.isFinite(expires) || expires <= now.getTime() || expires - now.getTime() > 15 * 60_000) throw new Error("Campaign token expiry must be within 15 minutes");
    if ((this.#expiries.get(input.tokenId) ?? 0) > now.getTime()) throw new Error("Campaign token id is already active");
    this.#revoked.delete(input.tokenId);
    this.#spend.delete(input.tokenId);
    this.#expiries.set(input.tokenId, expires);
    const claims: CampaignTokenClaims = Object.freeze({ ...input, scopes: Object.freeze([...input.scopes]), issuedAt: now.toISOString() });
    const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
    return `${payload}.${await this.sign(payload)}`;
  }

  async verify(
    token: string,
    request: { accountId: string; campaignId: string; scope: string; requestedSpendMinor?: number; requestedBidMinor?: number },
    now = new Date(),
  ): Promise<CampaignTokenClaims> {
    this.purgeExpired(now.getTime());
    if (token.length > 4096) throw new Error("Invalid campaign token");
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Invalid campaign token");
    const key = await this.key();
    let signature: Uint8Array;
    try { signature = base64UrlDecode(parts[1]); }
    catch { throw new Error("Invalid campaign token"); }
    const valid = await crypto.subtle.verify("HMAC", key, signature as BufferSource, new TextEncoder().encode(parts[0]));
    if (!valid) throw new Error("Invalid campaign token signature");
    let claims: CampaignTokenClaims;
    try { claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]))) as CampaignTokenClaims; }
    catch { throw new Error("Invalid campaign token payload"); }
    this.validateClaims(claims, now);
    if (this.#revoked.has(claims.tokenId)) throw new Error("Campaign token is revoked");
    if (claims.accountId !== request.accountId) throw new Error("Campaign token account mismatch");
    if (claims.campaignId !== request.campaignId) throw new Error("Campaign token cannot access another campaign");
    if (!claims.scopes.includes(request.scope)) throw new Error("Campaign token scope is not granted");
    if (request.requestedSpendMinor !== undefined && request.requestedSpendMinor > claims.spendCeilingMinor) throw new Error("Campaign token spend ceiling exceeded");
    if (request.requestedBidMinor !== undefined && request.requestedBidMinor > claims.bidCeilingMinor) throw new Error("Campaign token bid ceiling exceeded");
    return Object.freeze({ ...claims, scopes: Object.freeze([...claims.scopes]) });
  }

  async authorize(
    token: string,
    request: Parameters<CampaignTokenService["verify"]>[1],
    now = new Date(),
  ): Promise<VerifiedCampaignAuthorization> {
    const authorization = Object.freeze({ claims: await this.verify(token, request, now) });
    this.#verified.add(authorization);
    return authorization;
  }

  revoke(tokenId: string, now = new Date()): void {
    this.purgeExpired(now.getTime());
    this.#revoked.set(tokenId, this.#expiries.get(tokenId) ?? now.getTime() + 15 * 60_000);
  }

  async authorizeSpend(
    token: string,
    request: { accountId: string; campaignId: string; amountMinor: number; bidMinor: number; idempotencyKey: string },
    now = new Date(),
  ): Promise<SpendAuthorizationResult> {
    const authorization = await this.authorize(token, {
      accountId: request.accountId,
      campaignId: request.campaignId,
      scope: "bid:submit",
      requestedSpendMinor: request.amountMinor,
      requestedBidMinor: request.bidMinor,
    }, now);
    return this.authorizeVerifiedSpend(authorization, request, now);
  }

  authorizeVerifiedSpend(
    authorization: VerifiedCampaignAuthorization,
    request: { accountId: string; campaignId: string; amountMinor: number; bidMinor: number; idempotencyKey: string },
    now = new Date(),
  ): SpendAuthorizationResult {
    if (!this.#verified.has(authorization)) throw new Error("Campaign token authorization context is invalid");
    if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor < 1 || !Number.isSafeInteger(request.bidMinor) || request.bidMinor < 0 || !request.idempotencyKey || request.idempotencyKey.length > 256) throw new Error("Campaign token spend request is invalid");
    const claims = authorization.claims;
    this.validateClaims(claims, now);
    if (this.#revoked.has(claims.tokenId)) throw new Error("Campaign token is revoked");
    if (claims.accountId !== request.accountId || claims.campaignId !== request.campaignId || !claims.scopes.includes("bid:submit")) throw new Error("Campaign token authorization context does not match the spend request");
    if (request.amountMinor > claims.spendCeilingMinor || request.bidMinor > claims.bidCeilingMinor) throw new Error("Campaign token spend ceiling exceeded");
    const expiresAt = Date.parse(claims.expiresAt);
    const state = this.#spend.get(claims.tokenId) ?? { usedMinor: 0, expiresAt, idempotency: new Map<string, { amountMinor: number; committed: boolean }>() };
    const existing = state.idempotency.get(request.idempotencyKey);
    if (existing !== undefined) {
      if (existing.amountMinor !== request.amountMinor) throw new Error("Campaign token spend idempotency collision");
      return { claims, authorizedMinor: existing.amountMinor, remainingMinor: claims.spendCeilingMinor - state.usedMinor, newlyAuthorized: false };
    }
    if (state.usedMinor + request.amountMinor > claims.spendCeilingMinor) throw new Error("Campaign token spend ceiling exceeded");
    state.usedMinor += request.amountMinor;
    state.idempotency.set(request.idempotencyKey, { amountMinor: request.amountMinor, committed: false });
    this.#spend.set(claims.tokenId, state);
    return { claims, authorizedMinor: request.amountMinor, remainingMinor: claims.spendCeilingMinor - state.usedMinor, newlyAuthorized: true };
  }

  commitVerifiedSpend(authorization: VerifiedCampaignAuthorization, idempotencyKey: string): void {
    const entry = this.spendEntry(authorization, idempotencyKey);
    if (entry) entry.committed = true;
  }

  releaseVerifiedSpend(authorization: VerifiedCampaignAuthorization, idempotencyKey: string): void {
    const claims = authorization.claims;
    const entry = this.spendEntry(authorization, idempotencyKey);
    if (!entry || entry.committed) return;
    const state = this.#spend.get(claims.tokenId)!;
    state.usedMinor -= entry.amountMinor;
    state.idempotency.delete(idempotencyKey);
    if (state.idempotency.size === 0) this.#spend.delete(claims.tokenId);
  }

  private spendEntry(authorization: VerifiedCampaignAuthorization, idempotencyKey: string) {
    if (!this.#verified.has(authorization)) throw new Error("Campaign token authorization context is invalid");
    if (!idempotencyKey || idempotencyKey.length > 256) throw new Error("Campaign token spend request is invalid");
    return this.#spend.get(authorization.claims.tokenId)?.idempotency.get(idempotencyKey);
  }

  private async sign(payload: string): Promise<string> {
    const key = await this.key();
    return base64UrlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
  }

  private key(): Promise<CryptoKey> {
    this.#key ??= crypto.subtle.importKey("raw", this.#secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    return this.#key;
  }

  private purgeExpired(now: number): void {
    this.#operations += 1;
    if (this.#operations % 256 !== 0) return;
    for (const [tokenId, expiresAt] of this.#expiries) if (expiresAt <= now) this.#expiries.delete(tokenId);
    for (const [tokenId, expiresAt] of this.#revoked) if (expiresAt <= now) this.#revoked.delete(tokenId);
    for (const [tokenId, state] of this.#spend) if (state.expiresAt <= now) this.#spend.delete(tokenId);
  }

  private validateClaims(claims: CampaignTokenClaims, now: Date): void {
    const expiresAt = Date.parse(claims?.expiresAt);
    const issuedAt = Date.parse(claims?.issuedAt);
    if (!claims || typeof claims !== "object" || !Array.isArray(claims.scopes) || claims.scopes.length === 0 || new Set(claims.scopes).size !== claims.scopes.length || claims.scopes.some((scope) => !TOKEN_SCOPES.has(scope))) throw new Error("Invalid campaign token claims");
    validateText(claims.tokenId, "tokenId"); validateText(claims.accountId, "accountId"); validateText(claims.campaignId, "campaignId");
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) throw new Error("Campaign token is expired");
    if (!Number.isFinite(issuedAt) || issuedAt > now.getTime()) throw new Error("Invalid campaign token issue time");
    assertCeiling(claims.spendCeilingMinor, "spend ceiling");
    assertCeiling(claims.bidCeilingMinor, "bid ceiling");
    if (claims.bidCeilingMinor > claims.spendCeilingMinor && claims.spendCeilingMinor !== 0) throw new Error("Invalid campaign token claims");
  }
}

function validateText(value: string, name: string): void { if (!value || value.length > 128) throw new Error(`${name} is invalid`); }
function assertCeiling(value: number, name: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`); }
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
