import { buildPublishedProfile, RECEIVER_FIELD_KEYS, type LocalInstallationConfig, type ReceiverFieldValues } from "@ad-daddy/cli";

import { D1DeviceProofRepository } from "../../../../../lib/auth/device-proof.ts";
import { D1ReceiverSettingsStore } from "../../../../../lib/marketplace/receiver-settings.ts";
import { authenticateSponsorshipRequest } from "../../../../../lib/marketplace/sponsorship-runtime.ts";
import type { Environment } from "../../../../../lib/domain/types.ts";

const MAX_BODY_BYTES = 16_384;

export function createReceiverProfileHandler(input?: { db: D1Database; environment: Environment; clock?: () => Date }) {
  return async function handle(request: Request): Promise<Response> {
    if (!["GET", "PUT"].includes(request.method)) return json(405, { error: "method_not_allowed" });
    try {
      const rawBody = request.method === "PUT" ? await boundedBody(request) : "";
      const active = input ?? await bindings();
      const clock = input?.clock ?? (() => new Date());
      const device = await authenticateSponsorshipRequest(request, rawBody, {
        proofs: new D1DeviceProofRepository(active.db), environment: active.environment, clock,
      });
      // A device may publish a new profile or reduce consent, but it cannot
      // reactivate a human-paused/revoked receiver without returning through
      // the authenticated human settings surface.
      const store = new D1ReceiverSettingsStore(active.db, { authority: "device" });
      if (request.method === "GET") {
        const stored = await store.get(device.installationId);
        if (!stored || stored.accountId !== device.accountId) return json(404, { error: "receiver_profile_not_found" });
        return json(200, publicConfig(stored));
      }
      const config = configFromBody(JSON.parse(rawBody), device.accountId, device.installationId, device.consentVersion);
      await store.put(config);
      return json(200, publicConfig(config));
    } catch (error) {
      return json(403, { error: "receiver_profile_publication_rejected", message: boundedMessage(error) });
    }
  };
}

export const PUT = createReceiverProfileHandler();
export const GET = PUT;

async function bindings(): Promise<{ db: D1Database; environment: Environment }> {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("D1 receiver profile binding is required");
  if (!["test", "development", "staging", "production"].includes(env.AD_DADDY_ENV)) throw new Error("Ad Daddy environment is invalid");
  return { db: env.DB, environment: env.AD_DADDY_ENV as Environment };
}

function configFromBody(value: unknown, accountId: string, installationId: string, consentVersion: number): LocalInstallationConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Receiver profile must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["status", "publishedFields", "cadenceMinutes", "termsVersion", "privacyVersion", "hostDisclosure"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("Receiver profile contains unsupported fields");
  if (!["active", "paused", "revoked"].includes(String(record.status))) throw new Error("Receiver profile status is invalid");
  if (!record.publishedFields || typeof record.publishedFields !== "object" || Array.isArray(record.publishedFields)) throw new Error("Published receiver fields are invalid");
  const publishedFields = record.publishedFields as ReceiverFieldValues;
  const enabled = Object.fromEntries(RECEIVER_FIELD_KEYS.map((key) => [key, publishedFields[key] !== undefined]));
  const validated = buildPublishedProfile({ values: publishedFields, enabled });
  const cadenceMinutes = Number(record.cadenceMinutes);
  if (!Number.isSafeInteger(cadenceMinutes) || cadenceMinutes < 5 || cadenceMinutes > 10_080) throw new Error("Receiver cadence is invalid");
  if (typeof record.termsVersion !== "string" || !record.termsVersion || record.termsVersion.length > 128 ||
    typeof record.privacyVersion !== "string" || !record.privacyVersion || record.privacyVersion.length > 128) throw new Error("Receiver contract version is invalid");
  const host = record.hostDisclosure as { host?: unknown; displayModel?: unknown; consumesTurn?: unknown } | undefined;
  if (!host || typeof host.host !== "string" || !host.host || host.host.length > 64 || host.consumesTurn !== true ||
    (host.displayModel !== undefined && (typeof host.displayModel !== "string" || host.displayModel.length > 128))) throw new Error("Receiver host disclosure is invalid");
  return {
    installationId, accountId, role: "receiver", profile: { values: validated, enabled }, publishedFields: validated,
    cadenceMinutes, termsVersion: record.termsVersion, privacyVersion: record.privacyVersion,
    consentVersion, status: record.status as LocalInstallationConfig["status"],
    hostDisclosure: { host: host.host, ...(host.displayModel ? { displayModel: host.displayModel as string } : {}), consumesTurn: true },
  };
}

async function boundedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("Receiver profile is too large");
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) throw new Error("Receiver profile is too large");
  return body;
}

function boundedMessage(error: unknown) { return (error instanceof Error ? error.message : "Receiver profile rejected").slice(0, 200); }
function json(status: number, value: unknown) { return Response.json(value, { status, headers: { "cache-control": "no-store" } }); }
function publicConfig(config: LocalInstallationConfig) {
  return {
    installationId: config.installationId, status: config.status, consentVersion: config.consentVersion,
    publishedFields: config.publishedFields, cadenceMinutes: config.cadenceMinutes,
    termsVersion: config.termsVersion, privacyVersion: config.privacyVersion, hostDisclosure: config.hostDisclosure,
  };
}
