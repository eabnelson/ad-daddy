#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  CodexLocalDeliveryRuntime,
  JsonLocalDeliveryStateStore,
  environmentCodexHostAuthorization,
  type GenericPlacementReceipt,
} from "@ad-daddy/host-adapters";

import { prepareAdvertiserSetup } from "./commands/advertiser.js";
import { runManualCheck } from "./commands/check.js";
import { ADVERTISER_TERMS_VERSION } from "./commands/campaign.js";
import { ReceiverSetupService, type SetupInput } from "./commands/setup.js";
import { JsonLocalStore, type LocalInstallationConfig, type SetupRole } from "./local-store.js";
import { LaunchdScheduler, type LaunchdHost } from "./schedulers/launchd.js";

export const CLI_VERSION = "0.1.0";
const MAX_INPUT_BYTES = 131_072;
const execFile = promisify(execFileCallback);

export * from "./commands/check.js";
export * from "./commands/advertiser.js";
export * from "./commands/campaign.js";
export { findEligibleOpportunities } from "./commands/opportunity.js";
export * from "./commands/profile.js";
export * from "./commands/setup.js";
export * from "./install-integrity.js";
export * from "./local-store.js";
export * from "./scheduler.js";
export * from "./schedulers/launchd.js";

export function usage(): string {
  return [
    `Ad Daddy CLI ${CLI_VERSION}`,
    "setup      choose receiver, advertiser, or both and preview configuration",
    "profile    show the exact outbound receiver snapshot",
    "check      run one policy-gated manual ad check",
    "advertiser verify a brand and prepare agent campaign access",
    "campaign   prepare, fund, approve, pause, or close a bounded campaign",
    "search     retrieve rotating eligible opportunities for one campaign",
    "pause      stop checking before consent revocation",
    "uninstall  remove the scheduler before revoking the installation",
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
    const scheduler = makeScheduler(flags, dependencies, env);
    const setup = new ReceiverSetupService(store, { stopScheduler: scheduler ? (id) => scheduler.pause(id) : undefined });
    let result: unknown;

    if (command === "setup") {
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
          if (scheduler) await scheduler.install({ installationId: activated.installationId, cadenceMinutes: activated.cadenceMinutes });
          result = activated;
        } else result = prepared;
      }
    } else if (command === "profile") {
      const config = await oneInstallation(store, flags);
      result = { installationId: config.installationId, consentVersion: config.consentVersion, status: config.status, publishedFields: config.publishedFields };
    } else if (command === "check") {
      const config = await oneInstallation(store, flags);
      const pollUrl = flags.values.get("poll-url") ?? env.AD_DADDY_POLL_URL;
      if (!pollUrl) throw new Error("check requires --poll-url or AD_DADDY_POLL_URL");
      const delivery = config.status === "active"
        ? await createLocalDeliveryRuntime(config, flags, dependencies, env)
        : undefined;
      result = await runManualCheck({
        installationId: config.installationId,
        store,
        poll: async (publishedFields) => requestJson(pollUrl, {
          installationId: config.installationId,
          consentVersion: config.consentVersion,
          publishedFields,
        }, flags, dependencies, env),
        delivery,
      });
    } else if (command === "advertiser") {
      const input = flags.values.has("input") || flags.values.has("json") ? await readJsonInput(flags) : {};
      const role = stringProperty(input, "role") ?? flags.values.get("role") ?? "advertiser";
      result = prepareAdvertiserSetup(role as SetupRole);
    } else if (command === "campaign") {
      const operation = flags.positionals[0];
      if (!operation || !["prepare", "fund", "approve", "activate", "pause", "close"].includes(operation)) throw new Error("campaign requires prepare, fund, approve, activate, pause, or close");
      const input = await readJsonInput(flags);
      const action = operation === "approve" ? "activate" : operation;
      let payload: Record<string, unknown>;
      if (action === "prepare") {
        const campaign = recordProperty(input, "campaign") ?? requireRecord(input, "campaign draft");
        payload = { action, campaign: { ...campaign, advertiserTermsVersion: ADVERTISER_TERMS_VERSION } };
      } else {
        const campaignId = flags.values.get("campaign") ?? stringProperty(input, "campaignId");
        if (!campaignId) throw new Error("campaign operation requires --campaign or campaignId in the input");
        payload = { action, campaignId };
        const approval = recordProperty(input, "approval");
        if (approval) payload.approval = approval;
      }
      result = await requestJson(apiUrl(flags, env, "/api/v1/campaigns"), payload, flags, dependencies, env);
    } else if (command === "search") {
      const input = requireRecord(await readJsonInput(flags), "opportunity search");
      result = await requestJson(apiUrl(flags, env, "/api/v1/opportunities"), input, flags, dependencies, env);
    } else if (command === "pause") {
      const config = await oneInstallation(store, flags);
      result = await setup.pause(config.installationId);
    } else if (command === "uninstall") {
      const config = await oneInstallation(store, flags);
      if (scheduler) await scheduler.uninstall(config.installationId);
      result = await setup.revoke(config.installationId);
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

interface ParsedFlags { values: Map<string, string>; boolean: Set<string>; positionals: string[] }
function parseFlags(argv: readonly string[]): ParsedFlags {
  const values = new Map<string, string>();
  const boolean = new Set<string>();
  const positionals: string[] = [];
  const booleanNames = new Set(["help", "activate", "accept-disclosure", "accept-terms", "accept-privacy"]);
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
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") throw new Error("Ad Daddy API URLs must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("Ad Daddy API URLs cannot contain credentials");
  const token = flags.values.get("token") ?? env.AD_DADDY_API_TOKEN;
  const response = await (dependencies.fetch ?? globalThis.fetch)(parsed, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
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
function boundedMessage(error: unknown): string { return (error instanceof Error ? error.message : "Command failed").slice(0, 320); }

function makeScheduler(flags: ParsedFlags, dependencies: CliDependencies, env: NodeJS.ProcessEnv): LaunchdScheduler | undefined {
  if ((flags.values.get("scheduler") ?? env.AD_DADDY_SCHEDULER) !== "launchd") return undefined;
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("launchd scheduling is available only on macOS");
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  return new LaunchdScheduler(new NodeLaunchdHost(), {
    homeDirectory,
    executablePath: dependencies.executablePath ?? process.argv[1],
  });
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
  return new CodexLocalDeliveryRuntime({
    store: new JsonLocalDeliveryStateStore(statePath),
    marketplacePublicKeyPem,
    authorizeHost: environmentCodexHostAuthorization({
      receiverAccountId: config.accountId,
      installationId: config.installationId,
      isolatedCwd,
      environment: env,
      model: config.hostDisclosure.displayModel,
    }),
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

class NodeLaunchdHost implements LaunchdHost {
  async write(path: string, contents: string): Promise<void> { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, contents, { mode: 0o600 }); }
  async remove(path: string): Promise<void> { await rm(path, { force: true }); }
  async bootstrap(_label: string, path: string): Promise<void> { await execFile("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, path]); }
  async bootout(label: string): Promise<void> { await execFile("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${label}`]); }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) process.exitCode = await runCli(process.argv.slice(2));
