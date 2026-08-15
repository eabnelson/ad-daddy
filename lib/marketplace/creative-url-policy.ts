export type CreativeUrlKind = "creative" | "destination";

export class CreativeUrlPolicyError extends Error {
  readonly code: "UNSAFE_URL" | "UNVERIFIED_DOMAIN";
  constructor(code: "UNSAFE_URL" | "UNVERIFIED_DOMAIN", message: string) {
    super(message);
    this.code = code;
    this.name = "CreativeUrlPolicyError";
  }
}

export interface CreativeUrlPolicy {
  creativeOrigins: readonly string[];
  verifiedDestinationDomains: readonly string[];
}

export function validateCreativeUrl(
  raw: string,
  kind: CreativeUrlKind,
  policy: CreativeUrlPolicy,
): URL {
  if (typeof raw !== "string" || raw.length > 2_048) {
    throw new CreativeUrlPolicyError("UNSAFE_URL", "Creative URL is missing or too long");
  }
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new CreativeUrlPolicyError("UNSAFE_URL", "Creative URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new CreativeUrlPolicyError("UNSAFE_URL", "Creative URLs require credential-free HTTPS");
  }
  if (kind === "creative") {
    const allowed = policy.creativeOrigins.some((origin) => {
      try { return new URL(origin).origin === url.origin; }
      catch { return false; }
    });
    if (!allowed) throw new CreativeUrlPolicyError("UNVERIFIED_DOMAIN", "Creative URL is outside the isolated creative origin");
    return url;
  }
  const hostname = url.hostname.toLowerCase();
  const allowed = policy.verifiedDestinationDomains.some((domain) => {
    const normalized = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
  if (!allowed) throw new CreativeUrlPolicyError("UNVERIFIED_DOMAIN", "Destination URL is outside the advertiser's verified domain");
  return url;
}

export function buildCreativeContentSecurityPolicy(input: {
  destinationOrigins: readonly string[];
}): string {
  const destinations = [...new Set(input.destinationOrigins.map((origin) => new URL(origin).origin))];
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src ${destinations.length > 0 ? destinations.join(" ") : "'none'"}`,
    `navigate-to ${destinations.length > 0 ? destinations.join(" ") : "'none'"}`,
  ].join("; ");
}
