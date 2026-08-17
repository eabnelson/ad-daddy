export const REQUEST_IDENTITY_ASSERTION_HEADER = "ad-daddy-identity-assertion";
export const VERIFIED_ACCOUNT_ID_HEADER = "x-ad-daddy-verified-account-id";
export const VERIFIED_ACCOUNT_EMAIL_HEADER = "x-ad-daddy-verified-account-email";
export const VERIFIED_ACCOUNT_NAME_HEADER = "x-ad-daddy-verified-account-name";

const ASSERTION_AUDIENCE = "ad-daddy-app";
const MAX_ASSERTION_LIFETIME_MS = 5 * 60_000;
const PUBLIC_IDENTITY_PREFIX = "oai-authenticated-user-";
const INTERNAL_IDENTITY_PREFIX = "x-ad-daddy-verified-account-";

interface RequestIdentityClaims {
  version: 1;
  audience: typeof ASSERTION_AUDIENCE;
  accountId: string;
  email?: string;
  fullName?: string;
  method: string;
  pathname: string;
  issuedAt: string;
  expiresAt: string;
}

export interface RequestIdentityInput {
  accountId: string;
  email?: string;
  fullName?: string;
  method: string;
  pathname: string;
  expiresAt: string;
}

/**
 * HMAC authority shared only with the deployment's trusted authentication
 * gateway. Assertions are short-lived and bound to one method and path so a
 * captured assertion cannot authenticate an unrelated request.
 */
export class RequestIdentityAssertionService {
  readonly #secret: Uint8Array;
  #key?: Promise<CryptoKey>;

  constructor(secret: string) {
    if (new TextEncoder().encode(secret).byteLength < 32) throw new Error("Request identity assertion secret must be at least 32 bytes");
    this.#secret = new TextEncoder().encode(secret);
  }

  async issue(input: RequestIdentityInput, now = new Date()): Promise<string> {
    validateIdentity(input.accountId, input.email, input.fullName);
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime() || expiresAt - now.getTime() > MAX_ASSERTION_LIFETIME_MS) {
      throw new Error("Request identity assertion must expire within 5 minutes");
    }
    const claims: RequestIdentityClaims = {
      version: 1,
      audience: ASSERTION_AUDIENCE,
      accountId: input.accountId,
      ...(input.email ? { email: input.email } : {}),
      ...(input.fullName ? { fullName: input.fullName } : {}),
      method: normalizedMethod(input.method),
      pathname: normalizedPathname(input.pathname),
      issuedAt: now.toISOString(),
      expiresAt: input.expiresAt,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${payload}.${await this.sign(payload)}`;
  }

  async verify(assertion: string, request: Request, now = new Date()): Promise<RequestIdentityClaims> {
    const [payload, signature, ...extra] = assertion.split(".");
    if (!payload || !signature || extra.length || assertion.length > 4_096) throw new Error("Invalid request identity assertion");
    const valid = await crypto.subtle.verify(
      "HMAC",
      await this.key(),
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(payload),
    );
    if (!valid) throw new Error("Invalid request identity assertion signature");
    let claims: RequestIdentityClaims;
    try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as RequestIdentityClaims; }
    catch { throw new Error("Invalid request identity assertion payload"); }
    const issuedAt = Date.parse(claims.issuedAt);
    const expiresAt = Date.parse(claims.expiresAt);
    if (
      claims.version !== 1 || claims.audience !== ASSERTION_AUDIENCE ||
      !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now.getTime() ||
      expiresAt <= now.getTime() || expiresAt - issuedAt > MAX_ASSERTION_LIFETIME_MS ||
      claims.method !== normalizedMethod(request.method) || claims.pathname !== new URL(request.url).pathname
    ) throw new Error("Request identity assertion is expired or has the wrong audience");
    validateIdentity(claims.accountId, claims.email, claims.fullName);
    return Object.freeze({ ...claims });
  }

  private async sign(payload: string): Promise<string> {
    return Buffer.from(await crypto.subtle.sign("HMAC", await this.key(), new TextEncoder().encode(payload))).toString("base64url");
  }

  private key(): Promise<CryptoKey> {
    this.#key ??= crypto.subtle.importKey("raw", this.#secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    return this.#key;
  }
}

/**
 * The only public-to-application identity boundary. It rejects spoofable
 * identity headers before dispatch and forwards only claims verified with the
 * deployment secret.
 */
export async function dispatchWithVerifiedRequestIdentity(
  request: Request,
  secret: string | undefined,
  dispatch: (verifiedRequest: Request) => Promise<Response>,
  now = new Date(),
): Promise<Response> {
  const headers = new Headers(request.headers);
  const assertion = headers.get(REQUEST_IDENTITY_ASSERTION_HEADER);
  const hasSpoofableIdentityHeader = [...headers.keys()].some(
    (name) => name.startsWith(PUBLIC_IDENTITY_PREFIX) || name.startsWith(INTERNAL_IDENTITY_PREFIX),
  );
  stripIdentityHeaders(headers);

  if (hasSpoofableIdentityHeader) return identityRejected();
  if (!assertion) return dispatch(new Request(request, { headers }));
  if (!secret) return identityRejected();

  try {
    const claims = await new RequestIdentityAssertionService(secret).verify(assertion, request, now);
    headers.set(VERIFIED_ACCOUNT_ID_HEADER, claims.accountId);
    if (claims.email) headers.set(VERIFIED_ACCOUNT_EMAIL_HEADER, claims.email);
    if (claims.fullName) headers.set(VERIFIED_ACCOUNT_NAME_HEADER, claims.fullName);
    return dispatch(new Request(request, { headers }));
  } catch {
    return identityRejected();
  }
}

export function verifiedAccountId(request: Request): string | undefined {
  return request.headers.get(VERIFIED_ACCOUNT_ID_HEADER) ?? undefined;
}

function stripIdentityHeaders(headers: Headers): void {
  for (const name of [...headers.keys()]) {
    if (name === REQUEST_IDENTITY_ASSERTION_HEADER || name.startsWith(PUBLIC_IDENTITY_PREFIX) || name.startsWith(INTERNAL_IDENTITY_PREFIX)) headers.delete(name);
  }
}

function identityRejected(): Response {
  return Response.json({ error: "verified_identity_required" }, { status: 401, headers: { "cache-control": "no-store" } });
}

function validateIdentity(accountId: string, email?: string, fullName?: string): void {
  if (!accountId || accountId.length > 128 || hasControlCharacter(accountId)) throw new Error("Invalid request identity account");
  if (email !== undefined && (!email || email.length > 254 || hasControlCharacter(email))) throw new Error("Invalid request identity email");
  if (fullName !== undefined && (!fullName || fullName.length > 256 || hasControlCharacter(fullName))) throw new Error("Invalid request identity name");
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

function normalizedMethod(method: string): string {
  const value = method.toUpperCase();
  if (!/^[A-Z]+$/.test(value)) throw new Error("Invalid request identity method");
  return value;
}

function normalizedPathname(pathname: string): string {
  if (!pathname.startsWith("/") || pathname.includes("?") || pathname.includes("#") || pathname.length > 2_048) throw new Error("Invalid request identity path");
  return pathname;
}
