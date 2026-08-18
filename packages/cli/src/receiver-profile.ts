import { createDeviceProofHeader, type AdDaddyEnvironment, type DeviceKeyProvider } from "./device-key.js";
import type { LocalInstallationConfig } from "./local-store.js";
import { buildPublishedProfile, RECEIVER_FIELD_KEYS } from "./commands/profile.js";

type ReceiverProfileSync = Pick<LocalInstallationConfig, "status" | "consentVersion" | "publishedFields" | "cadenceMinutes" | "termsVersion" | "privacyVersion" | "hostDisclosure">;

export async function publishReceiverProfile(input: {
  config: LocalInstallationConfig;
  provider: DeviceKeyProvider;
  environment: AdDaddyEnvironment;
  apiBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  now?: Date;
}): Promise<unknown> {
  const credential = input.config.deviceCredential;
  if (!credential) throw new Error("Receiver profile publication requires an enrolled device");
  if (input.config.status === "draft") throw new Error("Activate receiver consent before publication");
  const target = "/api/v1/receiver/profile";
  const body = JSON.stringify({
    status: input.config.status,
    publishedFields: input.config.publishedFields,
    cadenceMinutes: input.config.cadenceMinutes,
    termsVersion: input.config.termsVersion,
    privacyVersion: input.config.privacyVersion,
    hostDisclosure: input.config.hostDisclosure,
  });
  const proof = await createDeviceProofHeader({
    provider: input.provider, credentialReference: credential.credentialReference,
    installationId: input.config.installationId, consentVersion: input.config.consentVersion,
    keyThumbprint: credential.keyThumbprint, environment: input.environment,
    method: "PUT", target, body, now: input.now,
  });
  const base = safeBaseUrl(input.apiBaseUrl);
  const response = await (input.fetch ?? globalThis.fetch)(new URL(target, base), {
    method: "PUT", headers: { "content-type": "application/json", "x-ad-daddy-device-proof": proof }, body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 65_536) throw new Error("Receiver profile response is too large");
  let result: unknown;
  try { result = JSON.parse(text); } catch { throw new Error("Ad Daddy returned malformed receiver profile JSON"); }
  if (!response.ok) throw new Error(`Ad Daddy rejected receiver profile publication (${response.status}): ${message(result)}`);
  return result;
}

export async function fetchReceiverProfile(input: {
  config: LocalInstallationConfig;
  provider: DeviceKeyProvider;
  environment: AdDaddyEnvironment;
  apiBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  now?: Date;
}): Promise<ReceiverProfileSync> {
  const credential = input.config.deviceCredential;
  if (!credential) throw new Error("Receiver profile sync requires an enrolled device");
  const target = "/api/v1/receiver/profile";
  const proof = await createDeviceProofHeader({
    provider: input.provider, credentialReference: credential.credentialReference,
    installationId: input.config.installationId, consentVersion: input.config.consentVersion,
    keyThumbprint: credential.keyThumbprint, environment: input.environment,
    method: "GET", target, body: "", now: input.now,
  });
  const base = safeBaseUrl(input.apiBaseUrl);
  const response = await (input.fetch ?? globalThis.fetch)(new URL(target, base), {
    method: "GET", headers: { "x-ad-daddy-device-proof": proof }, signal: AbortSignal.timeout(30_000),
  });
  const value = await responseJson(response);
  if (!response.ok) throw new Error(`Ad Daddy rejected receiver profile sync (${response.status}): ${message(value)}`);
  return validateRemoteProfile(value);
}

function safeBaseUrl(value: string): URL {
  const url = new URL(value.endsWith("/") ? value : `${value}/`);
  if ((url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) || url.username || url.password) {
    throw new Error("Ad Daddy API URL must be credential-free HTTPS");
  }
  return url;
}

function message(value: unknown): string {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const detail = typeof record?.message === "string" ? record.message : typeof record?.error === "string" ? record.error : "request rejected";
  return detail.slice(0, 200);
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 65_536) throw new Error("Receiver profile response is too large");
  try { return JSON.parse(text); } catch { throw new Error("Ad Daddy returned malformed receiver profile JSON"); }
}

function validateRemoteProfile(value: unknown): ReceiverProfileSync {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ad Daddy returned a malformed receiver profile");
  const record = value as Record<string, unknown>;
  if (!["active", "paused", "revoked"].includes(String(record.status)) || !Number.isSafeInteger(record.consentVersion) || (record.consentVersion as number) < 1 ||
    !record.publishedFields || typeof record.publishedFields !== "object" || Array.isArray(record.publishedFields) ||
    !Number.isSafeInteger(record.cadenceMinutes) || (record.cadenceMinutes as number) < 1 || typeof record.termsVersion !== "string" ||
    typeof record.privacyVersion !== "string" || !record.hostDisclosure || typeof record.hostDisclosure !== "object") {
    throw new Error("Ad Daddy returned a malformed receiver profile");
  }
  const publishedFields = record.publishedFields as LocalInstallationConfig["publishedFields"];
  const enabled = Object.fromEntries(RECEIVER_FIELD_KEYS.map((key) => [key, publishedFields[key] !== undefined]));
  const validatedFields = buildPublishedProfile({ values: publishedFields, enabled });
  const host = record.hostDisclosure as { host?: unknown; displayModel?: unknown; consumesTurn?: unknown };
  if (typeof host.host !== "string" || !host.host || host.host.length > 64 || host.consumesTurn !== true ||
    (host.displayModel !== undefined && (typeof host.displayModel !== "string" || host.displayModel.length > 128))) {
    throw new Error("Ad Daddy returned a malformed receiver host disclosure");
  }
  return { ...(record as unknown as ReceiverProfileSync), publishedFields: validatedFields };
}
