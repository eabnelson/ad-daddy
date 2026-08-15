import {
  MemoryLocalStore,
  RECEIVER_FIELD_KEYS,
  ReceiverSetupService,
  type LocalStore,
  type ReceiverFieldKey,
  type ReceiverFieldSelection,
  type ReceiverFieldValues,
} from "@ad-daddy/cli";

const MAX_FORM_BYTES = 16_384;
const TERMS_VERSION = "receiver-terms/2026-08-15";
const PRIVACY_VERSION = "privacy/2026-08-15";
const ALLOWED_FORM_KEYS = new Set([
  "intent", "cadenceMinutes", "quietHours", "coarseLocation", "projectNames",
  "publicRepositoryUrls", "privateRepoTechStacks", "projectDescriptions", "maxAdsPerDay",
  "subscriptionTier", "tokenUsageRange", "totalSessionRange", "rewardType", "minimumTakeHomeMinor",
  ...RECEIVER_FIELD_KEYS.map((key) => `enabled.${key}`),
]);

export interface ReceiverSettingsRuntime {
  store: LocalStore;
  setup: ReceiverSetupService;
}

const store = new MemoryLocalStore();
export const receiverSettingsRuntime: ReceiverSettingsRuntime = {
  store,
  setup: new ReceiverSetupService(store),
};

export function createReceiverSettingsHandler(runtime: ReceiverSettingsRuntime = receiverSettingsRuntime) {
  return async function handle(request: Request): Promise<Response> {
    const accountId = request.headers.get("oai-authenticated-user-id");
    if (!accountId) return json(401, { error: "human_authentication_required" });
    const origin = request.headers.get("origin");
    if (request.method !== "GET" && origin && origin !== new URL(request.url).origin) return json(403, { error: "cross_origin_submission_rejected" });
    const installationId = installationIdFor(accountId);

    if (request.method === "GET") {
      const config = await runtime.store.get(installationId);
      return config
        ? json(200, { installationId, status: config.status, consentVersion: config.consentVersion, publishedFields: config.publishedFields })
        : json(404, { error: "receiver_configuration_not_found" });
    }

    let form: URLSearchParams;
    try { form = await parseBoundedForm(request); }
    catch (error) { return json(400, { error: "invalid_receiver_settings", message: boundedMessage(error) }); }
    const intent = form.get("intent");
    try {
      if (intent === "preview") {
        const config = await runtime.setup.prepare({
          installationId,
          accountId,
          role: "receiver",
          profile: profileFrom(form),
          cadenceMinutes: integer(form.get("cadenceMinutes"), "cadenceMinutes", 5, 10_080),
          termsVersion: TERMS_VERSION,
          privacyVersion: PRIVACY_VERSION,
          hostDisclosure: { host: "Codex", consumesTurn: true },
        });
        return json(200, {
          intent,
          installationId,
          status: config.status,
          consentVersion: config.consentVersion,
          publishedFields: config.publishedFields,
          activationDisclosure: config.activationDisclosure,
        });
      }
      if (intent === "pause") {
        await requireOwnedConfiguration(runtime, installationId, accountId);
        const config = await runtime.setup.pause(installationId);
        return json(200, { intent, installationId, status: config.status, consentVersion: config.consentVersion });
      }
      if (intent === "revoke") {
        await requireOwnedConfiguration(runtime, installationId, accountId);
        const config = await runtime.setup.revoke(installationId);
        return json(200, { intent, installationId, status: config.status, consentVersion: config.consentVersion });
      }
      return json(400, { error: "unsupported_receiver_intent" });
    } catch (error) {
      return json(409, { error: "receiver_settings_rejected", message: boundedMessage(error) });
    }
  };
}

export const GET = createReceiverSettingsHandler();
export const POST = createReceiverSettingsHandler();

async function parseBoundedForm(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/x-www-form-urlencoded") throw new Error("Expected a URL-encoded form");
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FORM_BYTES) throw new Error("Receiver settings form is too large");
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_FORM_BYTES) throw new Error("Receiver settings form is too large");
  const form = new URLSearchParams(body);
  if ([...form.keys()].length > 40 || [...form.keys()].some((key) => !ALLOWED_FORM_KEYS.has(key))) throw new Error("Receiver settings contain unsupported fields");
  for (const value of form.values()) if (value.length > 1_024) throw new Error("Receiver setting is too long");
  return form;
}

function profileFrom(form: URLSearchParams): { values: ReceiverFieldValues; enabled: ReceiverFieldSelection } {
  const enabled: ReceiverFieldSelection = {};
  for (const key of RECEIVER_FIELD_KEYS) enabled[key] = form.get(`enabled.${key}`) === "on";
  const values: ReceiverFieldValues = {};
  put(values, "coarseLocation", optional(form.get("coarseLocation")));
  put(values, "projectNames", list(form.get("projectNames")));
  put(values, "publicRepositoryUrls", list(form.get("publicRepositoryUrls")));
  const technologies = list(form.get("privateRepoTechStacks"));
  put(values, "privateRepoTechStacks", technologies?.length ? [technologies] : undefined);
  put(values, "projectDescriptions", list(form.get("projectDescriptions"), "\n"));
  put(values, "subscriptionTier", optional(form.get("subscriptionTier")));
  put(values, "tokenUsageRange", optional(form.get("tokenUsageRange")));
  put(values, "totalSessionRange", optional(form.get("totalSessionRange")));
  const rewards = form.getAll("rewardType").filter(Boolean) as NonNullable<ReceiverFieldValues["acceptedRewardTypes"]>;
  put(values, "acceptedRewardTypes", rewards.length ? rewards : undefined);
  const minimum = optionalInteger(form.get("minimumTakeHomeMinor"), "minimumTakeHomeMinor", 0, Number.MAX_SAFE_INTEGER);
  put(values, "minimumTakeHomeMinor", minimum);
  const maxPerDay = optionalInteger(form.get("maxAdsPerDay"), "maxAdsPerDay", 1, 24);
  const quiet = quietHours(form.get("quietHours"));
  if (maxPerDay !== undefined) values.adFrequency = { maxPerDay, ...(quiet ? { quietHours: quiet } : {}) };
  return { values, enabled };
}

function installationIdFor(accountId: string): string {
  return `web:${accountId}`;
}
async function requireOwnedConfiguration(runtime: ReceiverSettingsRuntime, installationId: string, accountId: string): Promise<void> {
  const config = await runtime.store.get(installationId);
  if (!config || config.accountId !== accountId) throw new Error("Unknown installation");
}
function optional(value: string | null): string | undefined { const trimmed = value?.trim(); return trimmed || undefined; }
function list(value: string | null, separator = ","): string[] | undefined {
  const items = value?.split(separator).map((item) => item.trim()).filter(Boolean);
  return items?.length ? items : undefined;
}
function integer(value: string | null, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be ${minimum}-${maximum}`);
  return parsed;
}
function optionalInteger(value: string | null, name: string, minimum: number, maximum: number): number | undefined {
  return optional(value) === undefined ? undefined : integer(value, name, minimum, maximum);
}
function quietHours(value: string | null): { startHourLocal: number; endHourLocal: number } | undefined {
  const normalized = optional(value);
  if (!normalized) return undefined;
  const match = /^(\d{1,2})(?::\d{2})?\s*[-–]\s*(\d{1,2})(?::\d{2})?$/.exec(normalized);
  if (!match) throw new Error("quietHours must look like 22:00-07:00");
  return { startHourLocal: integer(match[1], "quietHours start", 0, 23), endHourLocal: integer(match[2], "quietHours end", 0, 23) };
}
function put<K extends ReceiverFieldKey>(target: ReceiverFieldValues, key: K, value: ReceiverFieldValues[K] | undefined): void {
  if (value !== undefined) Object.assign(target, { [key]: value });
}
function boundedMessage(error: unknown): string { return (error instanceof Error ? error.message : "Request rejected").slice(0, 240); }
function json(status: number, body: unknown): Response { return Response.json(body, { status, headers: { "cache-control": "no-store" } }); }
