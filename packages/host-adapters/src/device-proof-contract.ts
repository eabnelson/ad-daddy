import type { AdDaddyEnvironment } from "./sponsorship-contract.js";

export interface DeviceProofEnvelope {
  method: string;
  target: string;
  audience: `ad-daddy:${AdDaddyEnvironment}`;
  bodyDigest: string;
  installationId: string;
  consentVersion: number;
  keyThumbprint: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export function canonicalDeviceProofEnvelope(envelope: DeviceProofEnvelope): string {
  return JSON.stringify({
    method: envelope.method,
    target: envelope.target,
    audience: envelope.audience,
    bodyDigest: envelope.bodyDigest,
    installationId: envelope.installationId,
    consentVersion: envelope.consentVersion,
    keyThumbprint: envelope.keyThumbprint,
    nonce: envelope.nonce,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
  });
}

export function normalizeDeviceProofTarget(target: string): string {
  if (typeof target !== "string" || target.length < 1 || target.length > 2_048 ||
    !target.startsWith("/") || target.startsWith("//") || target.includes("#")) {
    throw new Error("Device proof target is invalid");
  }
  const url = new URL(target, "https://device-proof.invalid");
  const entries = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    compareCodePoints(leftKey, rightKey) || compareCodePoints(leftValue, rightValue));
  const query = new URLSearchParams(entries).toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

export async function sha256DeviceProofBody(body: string | Uint8Array): Promise<string> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
