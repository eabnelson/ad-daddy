#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CodexLocalDeliveryRuntime,
  JsonLocalDeliveryStateStore,
  environmentCodexHostAuthorization,
  type CodexAppServerConnection,
  type GenericPlacementReceipt,
} from "@ad-daddy/host-adapters";

import { prepareAdvertiserSetup } from "./commands/advertiser.js";
import { runManualCheck } from "./commands/check.js";
import { ADVERTISER_TERMS_VERSION } from "./commands/campaign.js";
import type { ReceiverFieldSelection } from "./commands/profile.js";
import { ReceiverSetupService, type SetupInput } from "./commands/setup.js";
import { MacOSDeviceKeyProvider, type AdDaddyEnvironment, type DeviceKeyProvider } from "./device-key.js";
import { JsonLocalStore, type LocalInstallationConfig, type SetupRole } from "./local-store.js";
import { fetchReceiverProfile, publishReceiverProfile } from "./receiver-profile.js";
import { JsonSponsorshipPullStateStore, SponsorshipPullClient } from "./sponsorship-pull.js";
import { runTeamControl, type TeamLocalIdentity } from "./team-control.js";

export const CLI_VERSION = "0.1.0";
const MAX_INPUT_BYTES = 131_072;

export * from "./commands/check.js";
export * from "./commands/advertiser.js";
export * from "./commands/campaign.js";
export { findEligibleOpportunities } from "./commands/opportunity.js";
export * from "./commands/profile.js";
export * from "./commands/setup.js";
export * from "./install-integrity.js";
export * from "./device-key.js";
export * from "./local-store.js";
export * from "./scheduler.js";
export * from "./schedulers/launchd.js";
export * from "./sponsorship-pull.js";

export function usage(): string {
  return [
    `Ad Daddy CLI ${CLI_VERSION}`,
    "setup      choose receiver, advertiser, or both and preview configuration",
    "profile    show, publish, or sync the receiver snapshot",
    "enroll     prepare or complete receiver device enrollment",
    "check      run one policy-gated manual ad check",
    "advertiser verify a brand and prepare agent campaign access",
    "campaign   prepare, fund, approve, pause, close, or issue a bounded agent token",
    "search     retrieve rotating eligible opportunities for one campaign",
    "bid        submit one bounded campaign-agent bid",
    "placement  read, hide, block, or report one sponsored placement",
    "pause      stop checking before consent revocation",
    "uninstall  revoke the local installation",
    "team       join and operate the private team proof through the agent",
  ].join("\n");
}

export interface CliDependencies {
  fetch?: typeof globalThis.fetch;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  executablePath?: string;
  deviceKeyProvider?: DeviceKeyProvider;
  /** Test/embedded-host seam; the installed CLI uses the local Codex App Server. */
  codexConnectionFactory?: () => Promise<CodexAppServerConnection>;
}

/** Runs one command and always emits a single JSON document. */
export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value: string) => process.stderr.write(value));
  const env = dependencies.env ?? process.env;
  const command = argv[0];
  try {
    const flags = parseFlags(argv.slice(1));
    if (!command || command === "help" || flags.boolean.has("help")) {
      stdout(`${JSON.stringify({ ok: true, command: "help", version: CLI_VERSION, usage: usage().split("\n") })}\n`);
      return 0;
    }
    const store = new JsonLocalStore(flags.values.get("config") ?? env.AD_DADDY_CONFIG_PATH ?? join(dependencies.homeDirectory ?? homedir(), ".ad-daddy", "config.json"));
    if (flags.values.has("scheduler") || env.AD_DADDY_SCHEDULER) {
      throw new Error("Automatic background delivery is unavailable in this MVP; use ad-daddy check");
    }
    const setup = new ReceiverSetupService(store);
    let result: unknown;

    if (command === "team") {
      const contextPath = flags.values.get("team-config") ?? env.AD_DADDY_TEAM_CONFIG_PATH ?? join(dependencies.homeDirectory ?? homedir(), ".ad-daddy", "team.json");
      result = await runTeamControl(flags, {
        fetch: dependencies.fetch,
        env,
        contextPath,
        readInput: () => readJsonInput(flags),
        receiver: {
          setupPreview: async (context, cadenceMinutes) => {
            const prepared = await setup.prepare(teamReceiverInput(context, cadenceMinutes));
            return { ...prepared, receiverHost: teamReceiverHostCapability(env), next: "Show this exact disclosure and both contract versions before asking for activation acceptance." };
          },
          setupActivate: async (context, acceptance) => {
            assertTeamReceiverHostCapability(env);
            await requireTeamReceiverDraft(store, context.installationId, "setup");
            const installation = await setup.activate({ installationId: context.installationId, ...acceptance });
            return { installation, next: "Create a host-native recurring task that runs `ad-daddy team check` at the approved cadence." };
          },
          pause: async (context) => setup.pause(context.installationId),
          resumePreview: async (context) => {
            const current = await store.get(context.installationId);
            const prepared = await setup.prepare(teamReceiverInput(context, current?.cadenceMinutes ?? 15));
            return { ...prepared, receiverHost: teamReceiverHostCapability(env), next: "Show this exact disclosure and both contract versions before asking for fresh resume acceptance." };
          },
          resumeActivate: async (context, acceptance) => {
            assertTeamReceiverHostCapability(env);
            await requireTeamReceiverDraft(store, context.installationId, "resume");
            return setup.activate({ installationId: context.installationId, ...acceptance });
          },
          check: async (context) => runTeamCheck(context, flags, dependencies, env),
        },
      });
    } else if (command === "setup") {
      const input = await readJsonInput(flags) as SetupInput;
      assertInstallationId(input.installationId);
      if (input.role === "advertiser") {
        result = prepareAdvertiserSetup(input.role);
      } else {
        const prepared = await setup.prepare(input);
        if (flags.boolean.has("activate")) {
          const activated = await setup.activate({
            installationId: prepared.installationId,
            disclosureAccepted: flags.boolean.has("accept-disclosure"),
            termsAccepted: flags.boolean.has("accept-terms"),
            privacyAccepted: flags.boolean.has("accept-privacy"),
          });
          result = activated;
        } else result = prepared;
      }
    } else if (command === "profile") {
      const config = await oneInstallation(store, flags);
      const operation = flags.positionals[0] ?? "show";
      if (operation === "show") result = { installationId: config.installationId, consentVersion: config.consentVersion, status: config.status, publishedFields: config.publishedFields };
      else if (operation === "publish") result = await publishConfig(config, flags, dependencies, env);
      else if (operation === "sync") result = await syncConfig(config, store, flags, dependencies, env);
      else throw new Error("profile requires show, publish, or sync");
    } else if (command === "check") {
      result = await executeCheck(store, flags, dependencies, env);
    } else if (command === "enroll") {
      const operation = flags.positionals[0];
      if (!operation || !["prepare", "complete"].includes(operation)) throw new Error("enroll requires prepare or complete");
      const config = await oneInstallation(store, flags);
      const provider = dependencies.deviceKeyProvider ?? new MacOSDeviceKeyProvider({ platform: dependencies.platform });
      provider.assertProductionEnrollment();
      const credential = await provider.createOrLoad(config.installationId);
      if (operation === "prepare") {
        result = {
          installationId: config.installationId,
          accountId: config.accountId,
          keyThumbprint: credential.keyThumbprint,
          algorithm: credential.algorithm,
          next: "Have the authenticated human approve this installation and issue an enrollment grant for the exact thumbprint, then run enroll complete.",
        };
      } else {
        const input = requireRecord(await readJsonInput(flags), "device enrollment");
        const grantToken = stringProperty(input, "grantToken");
        if (!grantToken) throw new Error("enroll complete requires grantToken");
        const enrolled = await requestJson(apiUrl(flags, env, "/api/v1/installations/enroll"), {
          grantToken,
          installationId: config.installationId,
          hostKind: config.hostDisclosure.host.toLowerCase(),
          algorithm: credential.algorithm,
          keyVersion: credential.keyVersion,
          publicJwk: credential.publicJwk,
          keyThumbprint: credential.keyThumbprint,
        }, flags, dependencies, env);
        const attached = await setup.attachDeviceCredential(config.installationId, credential);
        const published = attached.status === "active" ? await publishConfig(attached, flags, dependencies, env) : undefined;
        result = { enrolled, installationId: attached.installationId, deviceCredential: attached.deviceCredential, ...(published ? { published } : {}) };
      }
    } else if (command === "advertiser") {
      const input = flags.values.has("input") || flags.values.has("json") ? await readJsonInput(flags) : {};
      const role = stringProperty(input, "role") ?? flags.values.get("role") ?? "advertiser";
      result = prepareAdvertiserSetup(role as SetupRole);
    } else if (command === "campaign") {
      const operation = flags.positionals[0];
      if (!operation || !["prepare", "fund", "approve", "activate", "pause", "close", "token"].includes(operation)) throw new Error("campaign requires prepare, fund, approve, activate, pause, close, or token");
      const input = await readJsonInput(flags);
      const action = operation === "approve" ? "activate" : operation === "token" ? "issue_agent_token" : operation;
      let payload: Record<string, unknown>;
      if (action === "prepare") {
        const campaign = recordProperty(input, "campaign") ?? requireRecord(input, "campaign draft");
        payload = { action, campaign: { ...campaign, advertiserTermsVersion: ADVERTISER_TERMS_VERSION } };
      } else if (action === "issue_agent_token") {
        const record = requireRecord(input, "campaign token");
        const campaignId = flags.values.get("campaign") ?? stringProperty(record, "campaignId");
        if (!campaignId) throw new Error("campaign token requires --campaign or campaignId in the input");
        payload = { action, campaignId, token: recordProperty(record, "token") ?? record };
      } else {
        const campaignId = flags.values.get("campaign") ?? stringProperty(input, "campaignId");
        if (!campaignId) throw new Error("campaign operation requires --campaign or campaignId in the input");
        payload = { action, campaignId };
        const approvalId = stringProperty(input, "approvalId");
        if (approvalId) payload.approvalId = approvalId;
      }
      result = await requestJson(apiUrl(flags, env, "/api/v1/campaigns"), payload, flags, dependencies, env);
    } else if (command === "search") {
      const input = requireRecord(await readJsonInput(flags), "opportunity search");
      result = await requestJson(apiUrl(flags, env, "/api/v1/opportunities"), input, flags, dependencies, env);
    } else if (command === "bid") {
      const input = requireRecord(await readJsonInput(flags), "campaign bid");
      const auctionId = stringProperty(input, "auctionId");
      if (!auctionId || !/^[A-Za-z0-9:_-]{1,128}$/.test(auctionId)) throw new Error("bid requires a bounded auctionId");
      const bid = recordProperty(input, "bid");
      if (!bid) throw new Error("bid requires a bid object");
      result = await requestJson(apiUrl(flags, env, `/api/v1/auctions/${encodeURIComponent(auctionId)}/bids`), {
        accountId: stringProperty(input, "accountId"), campaignId: stringProperty(input, "campaignId"), bid,
      }, flags, dependencies, env);
    } else if (command === "placement") {
      const placementId = flags.values.get("placement");
      const action = flags.values.get("action") ?? "read";
      if (!placementId || !/^[A-Za-z0-9:_-]{1,128}$/.test(placementId)) throw new Error("placement requires --placement <id>");
      if (!["read", "hide", "block_advertiser", "report"].includes(action)) throw new Error("placement --action must be read, hide, block_advertiser, or report");
      if (["block_advertiser", "report"].includes(action) && !flags.boolean.has("confirm")) throw new Error(`${action} requires --confirm`);
      const url = apiUrl(flags, env, `/api/v1/placements/${encodeURIComponent(placementId)}/receipt`);
      result = action === "read"
        ? await requestApiJson(url, "GET", undefined, flags, dependencies, env)
        : await requestApiJson(url, "POST", { action }, flags, dependencies, env);
    } else if (command === "pause") {
      const config = await oneInstallation(store, flags);
      const paused = await setup.pause(config.installationId);
      const published = paused.deviceCredential ? await publishConfig(paused, flags, dependencies, env) : undefined;
      result = published ? { ...paused, published } : paused;
    } else if (command === "uninstall") {
      const config = await oneInstallation(store, flags);
      const revoked = await setup.revoke(config.installationId);
      const published = revoked.deviceCredential ? await publishConfig(revoked, flags, dependencies, env) : undefined;
      result = published ? { ...revoked, published } : revoked;
    } else {
      throw new Error(`Unknown command: ${command}`);
    }

    stdout(`${JSON.stringify({ ok: true, command, result })}\n`);
    return 0;
  } catch (error) {
    stderr(`${JSON.stringify({ ok: false, command: command ?? null, error: boundedMessage(error) })}\n`);
    return 1;
  }
}

function teamReceiverInput(context: TeamLocalIdentity, cadenceMinutes: number): SetupInput {
  return {
    installationId: context.installationId,
    accountId: context.memberId,
    role: "both",
    profile: { values: {}, enabled: {} },
    cadenceMinutes,
    termsVersion: "receiver-terms/2026-08-15",
    privacyVersion: "privacy/2026-08-15",
    hostDisclosure: { host: "Codex", consumesTurn: true },
  };
}

function teamReceiverHostCapability(env: NodeJS.ProcessEnv): { host: "Codex"; supported: boolean; reason: string } {
  const supported = Boolean(env.CODEX_THREAD_ID);
  return {
    host: "Codex",
    supported,
    reason: supported
      ? "This Codex task provides the active-task authorization required to prove a new sponsored task does not replace the current task."
      : "Native receiver delivery is not supported in this host yet. Run receiver activation from a Codex task; advertiser and profile commands remain available here.",
  };
}

function assertTeamReceiverHostCapability(env: NodeJS.ProcessEnv): void {
  const capability = teamReceiverHostCapability(env);
  if (!capability.supported) throw new Error(capability.reason);
}

async function requireTeamReceiverDraft(store: JsonLocalStore, installationId: string, operation: "setup" | "resume"): Promise<void> {
  const config = await store.get(installationId);
  if (config?.status !== "draft") {
    throw new Error(`Receiver ${operation} requires a fresh preview first; run \`ad-daddy team receiver ${operation}\` without --confirm and show the returned disclosure and contract versions`);
  }
}

async function runTeamCheck(
  context: TeamLocalIdentity,
  sourceFlags: ParsedFlags,
  dependencies: CliDependencies,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const endpoint = new URL("/api/team", context.origin).toString();
  const flags: ParsedFlags = {
    boolean: new Set(sourceFlags.boolean),
    positionals: [],
    values: new Map(sourceFlags.values),
  };
  flags.values.set("installation", context.installationId);
  flags.values.set("poll-url", endpoint);
  flags.values.set("token", context.memberToken);
  flags.values.set("marketplace-public-key", context.publicKeyPem);
  const store = new JsonLocalStore(flags.values.get("config") ?? env.AD_DADDY_CONFIG_PATH ?? join(dependencies.homeDirectory ?? homedir(), ".ad-daddy", "config.json"));
  return executeCheck(store, flags, dependencies, {
    ...env,
    AD_DADDY_ENV: "development",
    AD_DADDY_PRIVATE_TEAM_MODE: "1",
  });
}

async function executeCheck(
  store: JsonLocalStore,
  flags: ParsedFlags,
  dependencies: CliDependencies,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  let config = await oneInstallation(store, flags);
  if (config.deviceCredential && (flags.values.get("api-url") ?? env.AD_DADDY_API_URL)) {
    config = await syncConfig(config, store, flags, dependencies, env);
  }
  const delivery = config.status === "active"
    ? await createLocalDeliveryRuntime(config, flags, dependencies, env)
    : undefined;
  if (config.deviceCredential) {
    if (!delivery) throw new Error("Active local delivery capability is required before fetching sponsorship inventory");
    const apiBaseUrl = flags.values.get("api-url") ?? env.AD_DADDY_API_URL;
    if (!apiBaseUrl) throw new Error("check requires --api-url or AD_DADDY_API_URL");
    const marketplacePublicKeyPem = flags.values.get("marketplace-public-key") ?? env.AD_DADDY_MARKETPLACE_PUBLIC_KEY_PEM;
    if (!marketplacePublicKeyPem) throw new Error("check requires the pinned AD_DADDY_MARKETPLACE_PUBLIC_KEY_PEM");
    const localRoot = flags.values.get("local-root") ?? env.AD_DADDY_LOCAL_ROOT ?? join(dependencies.homeDirectory ?? homedir(), ".ad-daddy");
    const pull = new SponsorshipPullClient({
      identity: sponsorshipIdentity(config),
      environment: adDaddyEnvironment(env),
      provider: dependencies.deviceKeyProvider ?? new MacOSDeviceKeyProvider({ platform: dependencies.platform }),
      marketplacePublicKeyPem,
      apiBaseUrl,
      fetch: dependencies.fetch,
      state: new JsonSponsorshipPullStateStore(flags.values.get("pull-state") ?? env.AD_DADDY_PULL_STATE_PATH ?? join(localRoot, "sponsorship-pull.json")),
      delivery,
      readCurrentIdentity: async () => {
        const current = await store.get(config.installationId);
        return current?.deviceCredential ? { ...sponsorshipIdentity(current), status: current.status } : undefined;
      },
      adapterVersion: `ad-daddy-cli/${CLI_VERSION}`,
    });
    return runManualCheck({ installationId: config.installationId, store, poll: (_publishedFields, now) => pull.check(now) });
  }
  const pollUrl = flags.values.get("poll-url") ?? env.AD_DADDY_POLL_URL;
  if (!pollUrl) throw new Error("check requires an enrolled device or the explicit legacy poll URL");
  const checked = await runManualCheck({
    installationId: config.installationId,
    store,
    poll: async (publishedFields) => requestJson(pollUrl, {
      installationId: config.installationId,
      consentVersion: config.consentVersion,
      publishedFields,
    }, flags, dependencies, env),
    delivery,
  });
  if (env.AD_DADDY_PRIVATE_TEAM_MODE === "1" && checked.status === "checked" && "delivery" in checked &&
    (checked.delivery?.status === "native" || checked.delivery?.status === "fallback")) {
    const deliveryId = teamPlacementId(checked.response);
    await requestJson(pollUrl, { action: "ack", deliveryId }, flags, dependencies, env);
  }
  return checked;
}

interface ParsedFlags { values: Map<string, string>; boolean: Set<string>; positionals: string[] }
function parseFlags(argv: readonly string[]): ParsedFlags {
  const values = new Map<string, string>();
  const boolean = new Set<string>();
  const positionals: string[] = [];
  const booleanNames = new Set(["help", "activate", "accept-disclosure", "accept-terms", "accept-privacy", "confirm"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    const name = token.slice(2);
    if (!name || values.has(name) || boolean.has(name)) throw new Error(`Duplicate or invalid flag: ${token}`);
    if (booleanNames.has(name)) { boolean.add(name); continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} requires a value`);
    values.set(name, value);
    index += 1;
  }
  return { values, boolean, positionals };
}

async function readJsonInput(flags: ParsedFlags): Promise<unknown> {
  const inline = flags.values.get("json");
  const inputPath = flags.values.get("input");
  if ((inline ? 1 : 0) + (inputPath ? 1 : 0) !== 1) throw new Error("Command requires exactly one of --input <file> or --json <JSON>");
  const source = inline ?? await readInputFile(inputPath!);
  if (Buffer.byteLength(source, "utf8") > MAX_INPUT_BYTES) throw new Error("JSON input exceeds 128 KiB");
  try { return JSON.parse(source) as unknown; }
  catch { throw new Error("Input must be valid JSON"); }
}
async function readInputFile(path: string): Promise<string> {
  if (path !== "-") return readFile(path, "utf8");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    chunks.push(buffer);
    total += buffer.length;
    if (total > MAX_INPUT_BYTES) throw new Error("JSON input exceeds 128 KiB");
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function oneInstallation(store: JsonLocalStore, flags: ParsedFlags): Promise<LocalInstallationConfig> {
  const requested = flags.values.get("installation");
  if (requested) {
    const config = await store.get(requested);
    if (!config) throw new Error("Unknown installation");
    return config;
  }
  const records = await store.list();
  if (records.length !== 1) throw new Error("Select one installation with --installation");
  return records[0];
}

async function requestJson(url: string, body: unknown, flags: ParsedFlags, dependencies: CliDependencies, env: NodeJS.ProcessEnv): Promise<unknown> {
  return requestApiJson(url, "POST", body, flags, dependencies, env);
}

async function requestApiJson(url: string, method: "GET" | "POST", body: unknown, flags: ParsedFlags, dependencies: CliDependencies, env: NodeJS.ProcessEnv): Promise<unknown> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") throw new Error("Ad Daddy API URLs must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("Ad Daddy API URLs cannot contain credentials");
  const token = flags.values.get("token") ?? env.AD_DADDY_API_TOKEN;
  const response = await (dependencies.fetch ?? globalThis.fetch)(parsed, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  let responseBody: unknown;
  try { responseBody = await response.json(); }
  catch { responseBody = { error: "non_json_response" }; }
  if (!response.ok) throw new Error(`Ad Daddy API rejected the request (${response.status}): ${boundedRemoteMessage(responseBody)}`);
  return responseBody;
}

function apiUrl(flags: ParsedFlags, env: NodeJS.ProcessEnv, path: string): string {
  const base = flags.values.get("api-url") ?? env.AD_DADDY_API_URL;
  if (!base) throw new Error("Command requires --api-url or AD_DADDY_API_URL");
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}
function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a JSON object`);
  return value as Record<string, unknown>;
}
function recordProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  const parent = requireRecord(value, "input");
  const child = parent[key];
  return child === undefined ? undefined : requireRecord(child, key);
}
function stringProperty(value: unknown, key: string): string | undefined {
  const candidate = requireRecord(value, "input")[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || !candidate) throw new Error(`${key} must be a non-empty string`);
  return candidate;
}
function boundedRemoteMessage(value: unknown): string {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const message = record && (typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : undefined);
  return (message ?? "request rejected").slice(0, 240);
}
function teamPlacementId(value: unknown): string {
  const placement = recordProperty(value, "placement");
  const payload = placement ? recordProperty(placement, "payload") : undefined;
  const placementId = payload?.placementId;
  if (typeof placementId !== "string" || !placementId) throw new Error("Private team placement is missing its delivery ID");
  return placementId;
}
function boundedMessage(error: unknown): string { return (error instanceof Error ? error.message : "Command failed").slice(0, 320); }

function sponsorshipIdentity(config: LocalInstallationConfig) {
  if (!config.deviceCredential) throw new Error("Receiver device enrollment is required");
  return {
    receiverAccountId: config.accountId,
    installationId: config.installationId,
    consentVersion: config.consentVersion,
    credentialReference: config.deviceCredential.credentialReference,
    deviceKeyThumbprint: config.deviceCredential.keyThumbprint,
  };
}

function adDaddyEnvironment(env: NodeJS.ProcessEnv): AdDaddyEnvironment {
  const value = env.AD_DADDY_ENV ?? "test";
  if (!(["test", "development", "staging", "production"] as const).includes(value as AdDaddyEnvironment)) throw new Error("AD_DADDY_ENV is invalid");
  return value as AdDaddyEnvironment;
}

async function publishConfig(config: LocalInstallationConfig, flags: ParsedFlags, dependencies: CliDependencies, env: NodeJS.ProcessEnv) {
  const apiBaseUrl = flags.values.get("api-url") ?? env.AD_DADDY_API_URL;
  if (!apiBaseUrl) throw new Error("profile publication requires --api-url or AD_DADDY_API_URL");
  return publishReceiverProfile({
    config, provider: dependencies.deviceKeyProvider ?? new MacOSDeviceKeyProvider({ platform: dependencies.platform }),
    environment: adDaddyEnvironment(env), apiBaseUrl, fetch: dependencies.fetch,
  });
}

async function syncConfig(config: LocalInstallationConfig, store: JsonLocalStore, flags: ParsedFlags, dependencies: CliDependencies, env: NodeJS.ProcessEnv) {
  const apiBaseUrl = flags.values.get("api-url") ?? env.AD_DADDY_API_URL;
  if (!apiBaseUrl) throw new Error("profile sync requires --api-url or AD_DADDY_API_URL");
  const remote = await fetchReceiverProfile({
    config, provider: dependencies.deviceKeyProvider ?? new MacOSDeviceKeyProvider({ platform: dependencies.platform }),
    environment: adDaddyEnvironment(env), apiBaseUrl, fetch: dependencies.fetch,
  });
  const enabled = Object.fromEntries(Object.keys(remote.publishedFields).map((key) => [key, true])) as ReceiverFieldSelection;
  const synced: LocalInstallationConfig = {
    ...config, ...remote, profile: { values: remote.publishedFields, enabled },
    deviceCredential: config.deviceCredential,
  };
  await store.put(synced);
  return synced;
}

async function createLocalDeliveryRuntime(
  config: LocalInstallationConfig,
  flags: ParsedFlags,
  dependencies: CliDependencies,
  env: NodeJS.ProcessEnv,
): Promise<CodexLocalDeliveryRuntime> {
  assertInstallationId(config.installationId);
  const marketplacePublicKeyPem = flags.values.get("marketplace-public-key") ?? env.AD_DADDY_MARKETPLACE_PUBLIC_KEY_PEM;
  if (!marketplacePublicKeyPem) throw new Error("check requires the pinned AD_DADDY_MARKETPLACE_PUBLIC_KEY_PEM");
  if (!env.CODEX_THREAD_ID) throw new Error("check requires CODEX_THREAD_ID for receiver-authorized Codex delivery");
  const localRoot = flags.values.get("local-root") ?? env.AD_DADDY_LOCAL_ROOT ?? join(dependencies.homeDirectory ?? homedir(), ".ad-daddy");
  const isolatedCwd = flags.values.get("isolated-cwd") ?? env.AD_DADDY_ISOLATED_CWD ?? join(localRoot, "isolated", config.installationId);
  const statePath = flags.values.get("delivery-state") ?? env.AD_DADDY_DELIVERY_STATE_PATH ?? join(localRoot, "deliveries.json");
  const fallbackPath = flags.values.get("fallback-receipt") ?? env.AD_DADDY_FALLBACK_RECEIPT_PATH ?? join(localRoot, "fallback-receipt.json");
  await mkdir(isolatedCwd, { recursive: true, mode: 0o700 });
  const authorizeHost = environmentCodexHostAuthorization({
    receiverAccountId: config.accountId,
    installationId: config.installationId,
    isolatedCwd,
    environment: env,
    model: config.hostDisclosure.displayModel,
    privateTeamPoc: env.AD_DADDY_PRIVATE_TEAM_MODE === "1",
  });
  return new CodexLocalDeliveryRuntime({
    store: new JsonLocalDeliveryStateStore(statePath),
    marketplacePublicKeyPem,
    authorizeHost: dependencies.codexConnectionFactory
      ? async (placement) => ({ ...(await authorizeHost(placement)), createConnection: dependencies.codexConnectionFactory! })
      : authorizeHost,
    presentFallback: (receipt) => writeFallbackReceipt(fallbackPath, receipt),
  });
}

function assertInstallationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error("installationId must use 1-64 letters, numbers, underscores, or hyphens");
}

async function writeFallbackReceipt(path: string, receipt: GenericPlacementReceipt): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ sponsoredBy: "Ad Daddy", receipt }, null, 2)}\n`, { mode: 0o600 });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invokedPath)) process.exitCode = await runCli(process.argv.slice(2));
