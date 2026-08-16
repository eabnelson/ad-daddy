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

export interface VerifiedCampaignAuthorization { readonly claims: CampaignTokenClaims; readonly tokenHash: string; }
interface SpendAuthorizationResult {
  claims: CampaignTokenClaims;
  authorizedMinor: number;
  remainingMinor: number;
  newlyAuthorized: boolean;
}

export interface CampaignTokenState {
  claims: Omit<CampaignTokenClaims, "issuedAt">;
  tokenHash: string;
  spentMinor: number;
  revokedAt?: string;
}

export interface CampaignTokenStore {
  register(state: CampaignTokenState, now: Date): Promise<void>;
  get(tokenId: string): Promise<CampaignTokenState | undefined>;
  revoke(tokenId: string, now: Date): Promise<void>;
  authorizeSpend(input: { tokenId: string; tokenHash: string; amountMinor: number; idempotencyKey: string; now: Date }): Promise<{ newlyAuthorized: boolean; usedMinor: number }>;
  commitSpend(tokenId: string, idempotencyKey: string, now: Date): Promise<void>;
  releaseSpend(tokenId: string, idempotencyKey: string, now: Date): Promise<void>;
}

interface MemoryTokenRecord extends CampaignTokenState {
  idempotency: Map<string, { amountMinor: number; status: "authorized" | "committed" | "released" }>;
}

export class MemoryCampaignTokenStore implements CampaignTokenStore {
  readonly #records = new Map<string, MemoryTokenRecord>();

  async register(state: CampaignTokenState, now: Date): Promise<void> {
    void now;
    const existing = this.#records.get(state.claims.tokenId);
    if (existing) throw new Error("Campaign token id is already active");
    this.#records.set(state.claims.tokenId, { ...structuredClone(state), idempotency: new Map() });
  }

  async get(tokenId: string): Promise<CampaignTokenState | undefined> {
    const record = this.#records.get(tokenId);
    return record ? structuredClone({ claims: record.claims, tokenHash: record.tokenHash, spentMinor: record.spentMinor, ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}) }) : undefined;
  }

  async revoke(tokenId: string, now: Date): Promise<void> {
    const record = this.#records.get(tokenId);
    if (record) record.revokedAt = now.toISOString();
  }

  async authorizeSpend(input: { tokenId: string; tokenHash: string; amountMinor: number; idempotencyKey: string; now: Date }) {
    const record = this.#records.get(input.tokenId);
    assertActiveStoreRecord(record, input.tokenHash, input.now);
    const existing = record.idempotency.get(input.idempotencyKey);
    if (existing) {
      if (existing.amountMinor !== input.amountMinor || existing.status === "released") throw new Error("Campaign token spend idempotency collision");
      return { newlyAuthorized: false, usedMinor: record.spentMinor };
    }
    if (record.spentMinor + input.amountMinor > record.claims.spendCeilingMinor) throw new Error("Campaign token spend ceiling exceeded");
    record.spentMinor += input.amountMinor;
    record.idempotency.set(input.idempotencyKey, { amountMinor: input.amountMinor, status: "authorized" });
    return { newlyAuthorized: true, usedMinor: record.spentMinor };
  }

  async commitSpend(tokenId: string, idempotencyKey: string): Promise<void> {
    const entry = this.#records.get(tokenId)?.idempotency.get(idempotencyKey);
    if (entry?.status === "authorized") entry.status = "committed";
  }

  async releaseSpend(tokenId: string, idempotencyKey: string): Promise<void> {
    const record = this.#records.get(tokenId);
    const entry = record?.idempotency.get(idempotencyKey);
    if (!record || !entry || entry.status !== "authorized") return;
    record.spentMinor -= entry.amountMinor;
    entry.status = "released";
  }
}

export class CampaignTokenService {
  readonly #secret: Uint8Array;
  readonly #store: CampaignTokenStore;
  readonly #verified = new WeakSet<VerifiedCampaignAuthorization>();
  #key?: Promise<CryptoKey>;
  constructor(secret: string, store: CampaignTokenStore = new MemoryCampaignTokenStore()) {
    if (new TextEncoder().encode(secret).byteLength < 32) throw new Error("Campaign token secret must be at least 32 bytes");
    this.#secret = new TextEncoder().encode(secret);
    this.#store = store;
  }

  async issue(input: Omit<CampaignTokenClaims, "issuedAt">, now = new Date()): Promise<string> {
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
    const claims: CampaignTokenClaims = Object.freeze({ ...input, scopes: Object.freeze([...input.scopes]), issuedAt: now.toISOString() });
    const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
    const token = `${payload}.${await this.sign(payload)}`;
    await this.#store.register({ claims: input, tokenHash: await sha256(token), spentMinor: 0 }, now);
    return token;
  }

  async verify(
    token: string,
    request: { accountId: string; campaignId: string; scope: string; requestedSpendMinor?: number; requestedBidMinor?: number },
    now = new Date(),
  ): Promise<CampaignTokenClaims> {
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
    const state = await this.#store.get(claims.tokenId);
    assertActiveStoreRecord(state, await sha256(token), now);
    assertStoredClaims(state.claims, claims);
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
    const authorization = Object.freeze({ claims: await this.verify(token, request, now), tokenHash: await sha256(token) });
    this.#verified.add(authorization);
    return authorization;
  }

  async revoke(tokenId: string, now = new Date()): Promise<void> {
    await this.#store.revoke(tokenId, now);
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

  async authorizeVerifiedSpend(
    authorization: VerifiedCampaignAuthorization,
    request: { accountId: string; campaignId: string; amountMinor: number; bidMinor: number; idempotencyKey: string },
    now = new Date(),
  ): Promise<SpendAuthorizationResult> {
    if (!this.#verified.has(authorization)) throw new Error("Campaign token authorization context is invalid");
    if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor < 1 || !Number.isSafeInteger(request.bidMinor) || request.bidMinor < 0 || !request.idempotencyKey || request.idempotencyKey.length > 256) throw new Error("Campaign token spend request is invalid");
    const claims = authorization.claims;
    this.validateClaims(claims, now);
    if (claims.accountId !== request.accountId || claims.campaignId !== request.campaignId || !claims.scopes.includes("bid:submit")) throw new Error("Campaign token authorization context does not match the spend request");
    if (request.amountMinor > claims.spendCeilingMinor || request.bidMinor > claims.bidCeilingMinor) throw new Error("Campaign token spend ceiling exceeded");
    const authorized = await this.#store.authorizeSpend({ tokenId: claims.tokenId, tokenHash: authorization.tokenHash, amountMinor: request.amountMinor, idempotencyKey: request.idempotencyKey, now });
    return { claims, authorizedMinor: request.amountMinor, remainingMinor: claims.spendCeilingMinor - authorized.usedMinor, newlyAuthorized: authorized.newlyAuthorized };
  }

  async commitVerifiedSpend(authorization: VerifiedCampaignAuthorization, idempotencyKey: string, now = new Date()): Promise<void> {
    this.assertVerifiedSpendContext(authorization, idempotencyKey);
    await this.#store.commitSpend(authorization.claims.tokenId, idempotencyKey, now);
  }

  async releaseVerifiedSpend(authorization: VerifiedCampaignAuthorization, idempotencyKey: string, now = new Date()): Promise<void> {
    this.assertVerifiedSpendContext(authorization, idempotencyKey);
    await this.#store.releaseSpend(authorization.claims.tokenId, idempotencyKey, now);
  }

  private assertVerifiedSpendContext(authorization: VerifiedCampaignAuthorization, idempotencyKey: string): void {
    if (!this.#verified.has(authorization)) throw new Error("Campaign token authorization context is invalid");
    if (!idempotencyKey || idempotencyKey.length > 256) throw new Error("Campaign token spend request is invalid");
  }

  private async sign(payload: string): Promise<string> {
    const key = await this.key();
    return base64UrlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
  }

  private key(): Promise<CryptoKey> {
    this.#key ??= crypto.subtle.importKey("raw", this.#secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    return this.#key;
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
function assertActiveStoreRecord<T extends CampaignTokenState>(record: T | undefined, tokenHash: string, now: Date): asserts record is T {
  if (!record || record.tokenHash !== tokenHash) throw new Error("Campaign token is not active");
  if (record.revokedAt) throw new Error("Campaign token is revoked");
  if (Date.parse(record.claims.expiresAt) <= now.getTime()) throw new Error("Campaign token is expired");
}
function assertStoredClaims(stored: Omit<CampaignTokenClaims, "issuedAt">, claims: CampaignTokenClaims): void {
  if (stored.tokenId !== claims.tokenId || stored.accountId !== claims.accountId || stored.campaignId !== claims.campaignId ||
    stored.spendCeilingMinor !== claims.spendCeilingMinor || stored.bidCeilingMinor !== claims.bidCeilingMinor ||
    stored.expiresAt !== claims.expiresAt || JSON.stringify(stored.scopes) !== JSON.stringify(claims.scopes)) {
    throw new Error("Campaign token durable authority mismatch");
  }
}
async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
