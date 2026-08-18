import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface TeamMemberContext {
  id: string;
  installationId: string;
  displayName: string;
  tags: string[];
  receivesAds: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TeamLocalIdentity {
  version: 1;
  origin: string;
  memberToken: string;
  memberId: string;
  installationId: string;
  publicKeyPem: string;
}

interface TeamCommandFlags {
  values: Map<string, string>;
  boolean: Set<string>;
  positionals: string[];
}

interface TeamReceiverControls {
  setupPreview(context: TeamLocalIdentity, cadenceMinutes: number): Promise<unknown>;
  setupActivate(context: TeamLocalIdentity, acceptance: TeamReceiverAcceptance): Promise<unknown>;
  pause(context: TeamLocalIdentity): Promise<unknown>;
  resumePreview(context: TeamLocalIdentity): Promise<unknown>;
  resumeActivate(context: TeamLocalIdentity, acceptance: TeamReceiverAcceptance): Promise<unknown>;
  check(context: TeamLocalIdentity): Promise<unknown>;
}

interface TeamReceiverAcceptance {
  disclosureAccepted: true;
  termsAccepted: true;
  privacyAccepted: true;
}

interface TeamControlDependencies {
  fetch?: typeof globalThis.fetch;
  env: NodeJS.ProcessEnv;
  contextPath: string;
  readInput(): Promise<unknown>;
  receiver: TeamReceiverControls;
}

const ACTIONS = [
  { name: "join", command: "team join --url <COORDINATOR_URL> --invite-code <INVITE_CODE> --input -", mutates: true, input: "displayName, tags, receivesAds as JSON on stdin" },
  { name: "status", command: "team status", mutates: false },
  { name: "profile.show", command: "team profile show", mutates: false },
  { name: "profile.update", command: "team profile update --confirm --input -", mutates: true, input: "displayName?, tags?, receivesAds? as JSON on stdin" },
  { name: "advertiser.show", command: "team advertiser show", mutates: false },
  { name: "people.list", command: "team people list", mutates: false },
  { name: "ads.browse", command: "team ads browse", mutates: false },
  { name: "ads.mine", command: "team ads mine", mutates: false },
  { name: "ads.send", command: "team ads send --confirm --input -", mutates: true, input: "title, body, targetTags, points as JSON on stdin" },
  { name: "receiver.setup", command: "team receiver setup", mutates: true, input: "preview with --cadence; activate with --confirm" },
  { name: "receiver.pause", command: "team receiver pause --confirm", mutates: true },
  { name: "receiver.resume", command: "team receiver resume", mutates: true, input: "preview first; activate with --confirm" },
  { name: "check", command: "team check", mutates: false },
] as const;

export async function runTeamControl(
  flags: TeamCommandFlags,
  dependencies: TeamControlDependencies,
): Promise<unknown> {
  const [resource = "actions", operation] = flags.positionals;
  if (resource === "actions") return { actions: ACTIONS };
  const store = new JsonTeamContextStore(dependencies.contextPath);

  if (resource === "join") {
    const existing = await store.readIfPresent();
    if (existing) {
      throw new Error(`An Ad Daddy team identity is already configured for ${existing.memberId}; run \`ad-daddy team status\` to continue with it`);
    }
    const origin = normalizeOrigin(required(flags.values.get("url") ?? dependencies.env.AD_DADDY_TEAM_URL, "team join requires --url or AD_DADDY_TEAM_URL"));
    const inviteCode = validInviteCode(required(flags.values.get("invite-code") ?? dependencies.env.AD_DADDY_INVITE_CODE, "team join requires --invite-code or AD_DADDY_INVITE_CODE"));
    const input = exactInput(await dependencies.readInput(), "team join", ["displayName", "tags", "receivesAds"]);
    const response = requireRecord(await teamRequest(origin, inviteCode, { ...input, action: "join" }, dependencies.fetch), "team join response");
    const member = teamMember(response.member);
    const context: TeamLocalIdentity = {
      version: 1,
      origin,
      memberToken: boundedString(response.accessToken, "accessToken", 8, 512),
      memberId: member.id,
      installationId: member.installationId,
      publicKeyPem: boundedString(response.publicKeyPem, "publicKeyPem", 8, 16_384),
    };
    await store.write(context);
    const next = member.receivesAds
      ? "Run `ad-daddy team receiver setup` to preview the exact receiver disclosure and current contracts."
      : "Receiving is off. If the human later chooses to receive sponsored tasks, run `ad-daddy team profile update --confirm --input -` and send the serialized changes through stdin.";
    return { member, origin, contextStored: true, next };
  }

  const context = await store.read();
  const status = async () => safeStatus(await teamRequest(context.origin, context.memberToken, { action: "status" }, dependencies.fetch));

  if (resource === "status") return status();
  if (resource === "profile" && (operation ?? "show") === "show") {
    const response = requireRecord(await teamRequest(context.origin, context.memberToken, { action: "profile_status" }, dependencies.fetch), "profile response");
    return response.member;
  }
  if (resource === "profile" && operation === "update") {
    requireConfirmation(flags, "team profile update");
    const changes = exactInput(await dependencies.readInput(), "profile update", ["displayName", "tags", "receivesAds"]);
    const updated = requireRecord(await teamRequest(context.origin, context.memberToken, {
      ...changes,
      action: "profile",
    }, dependencies.fetch), "profile response");
    return updated.member;
  }
  if (resource === "advertiser" && (operation ?? "show") === "show") {
    return teamRequest(context.origin, context.memberToken, { action: "advertiser_profile" }, dependencies.fetch);
  }
  if (resource === "people" && (operation ?? "list") === "list") {
    return teamRequest(context.origin, context.memberToken, { action: "people" }, dependencies.fetch);
  }
  if (resource === "ads" && operation === "browse") {
    return safeBrowse(await teamRequest(context.origin, context.memberToken, { action: "browse_ads" }, dependencies.fetch));
  }
  if (resource === "ads" && operation === "mine") {
    return teamRequest(context.origin, context.memberToken, { action: "my_ads" }, dependencies.fetch);
  }
  if (resource === "ads" && operation === "send") {
    requireConfirmation(flags, "team ads send");
    const input = exactInput(await dependencies.readInput(), "team ad", ["title", "body", "targetTags", "points"]);
    return teamRequest(context.origin, context.memberToken, { ...input, action: "create_ad" }, dependencies.fetch);
  }
  if (resource === "receiver" && operation === "setup") {
    if (!flags.boolean.has("confirm")) {
      return dependencies.receiver.setupPreview(context, cadence(flags.values.get("cadence")));
    }
    const current = await memberProfile(context, dependencies.fetch);
    const local = await dependencies.receiver.setupActivate(context, receiverAcceptance(flags, "team receiver setup"));
    try {
      const member = current.receivesAds ? current : await updateReceiving(context, true, dependencies.fetch);
      return { local, member };
    } catch (error) {
      await compensateLocal(() => dependencies.receiver.pause(context), "Receiver activation failed and local rollback also failed", error);
    }
  }
  if (resource === "receiver" && operation === "pause") {
    requireConfirmation(flags, "team receiver pause");
    const current = await memberProfile(context, dependencies.fetch);
    const member = current.receivesAds ? await updateReceiving(context, false, dependencies.fetch) : current;
    try {
      const local = await dependencies.receiver.pause(context);
      return { local, member };
    } catch (error) {
      if (current.receivesAds) {
        await compensateRemote(() => updateReceiving(context, true, dependencies.fetch), "Receiver pause failed and coordinator rollback also failed", error);
      }
      throw error;
    }
  }
  if (resource === "receiver" && operation === "resume") {
    if (!flags.boolean.has("confirm")) return dependencies.receiver.resumePreview(context);
    const current = await memberProfile(context, dependencies.fetch);
    const local = await dependencies.receiver.resumeActivate(context, receiverAcceptance(flags, "team receiver resume"));
    try {
      const member = current.receivesAds ? current : await updateReceiving(context, true, dependencies.fetch);
      return { local, member };
    } catch (error) {
      await compensateLocal(() => dependencies.receiver.pause(context), "Receiver resume failed and local rollback also failed", error);
    }
  }
  if (resource === "check") return dependencies.receiver.check(context);
  throw new Error("team requires actions, join, status, profile show|update, advertiser show, people list, ads browse|mine|send, receiver setup|pause|resume, or check");
}

async function memberProfile(context: TeamLocalIdentity, fetchImplementation?: typeof globalThis.fetch): Promise<TeamMemberContext> {
  const response = requireRecord(await teamRequest(context.origin, context.memberToken, { action: "profile_status" }, fetchImplementation), "profile response");
  return teamMember(response.member);
}

async function updateReceiving(context: TeamLocalIdentity, receivesAds: boolean, fetchImplementation?: typeof globalThis.fetch): Promise<TeamMemberContext> {
  const response = requireRecord(await teamRequest(context.origin, context.memberToken, {
    action: "profile", receivesAds,
  }, fetchImplementation), "profile response");
  return teamMember(response.member);
}

async function compensateLocal(rollback: () => Promise<unknown>, message: string, cause: unknown): Promise<never> {
  try { await rollback(); }
  catch (rollbackError) { throw new Error(`${message}: ${errorMessage(rollbackError)}. Original error: ${errorMessage(cause)}`); }
  throw cause;
}

async function compensateRemote(rollback: () => Promise<unknown>, message: string, cause: unknown): Promise<never> {
  try { await rollback(); }
  catch (rollbackError) { throw new Error(`${message}: ${errorMessage(rollbackError)}. Original error: ${errorMessage(cause)}`); }
  throw cause;
}

class JsonTeamContextStore {
  readonly #path: string;
  constructor(path: string) { this.#path = path; }

  async read(): Promise<TeamLocalIdentity> {
    const context = await this.readIfPresent();
    if (!context) throw new Error("No team identity is configured; run `ad-daddy team join` first");
    return context;
  }

  async readIfPresent(): Promise<TeamLocalIdentity | undefined> {
    let raw: string;
    try {
      const file = await stat(this.#path);
      if (process.platform !== "win32" && (file.mode & 0o077) !== 0) throw new Error("Team context permissions must be 0600");
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return teamContext(JSON.parse(raw) as unknown);
  }

  async write(context: TeamLocalIdentity): Promise<void> {
    teamContext(context);
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.#path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

async function teamRequest(origin: string, token: string, body: Record<string, unknown>, fetchImplementation = globalThis.fetch): Promise<unknown> {
  const response = await fetchImplementation(new URL("/api/team", origin), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  let value: unknown;
  try { value = await response.json(); }
  catch { value = { error: "non_json_response" }; }
  if (!response.ok) {
    const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    throw new Error(`Ad Daddy team coordinator rejected the request (${response.status}): ${String(record.message ?? record.error ?? "request rejected").slice(0, 240)}`);
  }
  return value;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("Team coordinator must use HTTPS or loopback");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Team coordinator URL must be an origin without credentials, path, query, or fragment");
  return url.origin;
}

function teamContext(value: unknown): TeamLocalIdentity {
  const record = requireRecord(value, "team context");
  if (record.version !== 1) throw new Error("Unsupported team context version");
  return {
    version: 1,
    origin: normalizeOrigin(boundedString(record.origin, "origin", 1, 2_048)),
    memberToken: boundedString(record.memberToken, "memberToken", 8, 512),
    memberId: boundedString(record.memberId, "member id", 1, 128),
    installationId: boundedString(record.installationId, "installation id", 1, 128),
    publicKeyPem: boundedString(record.publicKeyPem, "publicKeyPem", 8, 16_384),
  };
}

function teamMember(value: unknown): TeamMemberContext {
  const record = requireRecord(value, "team member");
  return {
    id: boundedString(record.id, "member id", 1, 128),
    installationId: boundedString(record.installationId, "installation id", 1, 128),
    displayName: boundedString(record.displayName, "display name", 1, 60),
    tags: array(record.tags, "tags").map((tag) => boundedString(tag, "tag", 1, 32)),
    receivesAds: boolean(record.receivesAds, "receivesAds"),
    createdAt: isoDate(record.createdAt, "createdAt"),
    updatedAt: isoDate(record.updatedAt, "updatedAt"),
  };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactInput(value: unknown, name: string, allowedKeys: readonly string[]): Record<string, unknown> {
  const record = requireRecord(value, name);
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`${name} contains unsupported field: ${unexpected}`);
  return record;
}

function safeStatus(value: unknown): Record<string, unknown> {
  const status = requireRecord(value, "team status");
  return {
    ...status,
    ads: array(status.ads, "team status ads").map((ad) => safeAdSummary(ad, "team status ad")),
  };
}

function safeBrowse(value: unknown): { matches: Array<Record<string, unknown>> } {
  const response = requireRecord(value, "team ad browse response");
  return {
    matches: array(response.matches, "team ad matches").map((match) => {
      const record = requireRecord(match, "team ad match");
      return {
        ...safeAdSummary(record, "team ad match"),
        matchedTags: safeTags(record.matchedTags, "matchedTags"),
        matchCount: integer(record.matchCount, "matchCount", 0, 20),
      };
    }),
  };
}

function safeAdSummary(value: unknown, name: string): Record<string, unknown> {
  const record = requireRecord(value, name);
  if (record.rewardKind !== "team_points") throw new Error(`${name} rewardKind is invalid`);
  return {
    adId: boundedString(record.adId, "adId", 1, 128),
    targetTags: safeTags(record.targetTags, "targetTags"),
    points: integer(record.points, "points", 0, 10_000),
    rewardKind: "team_points",
    createdAt: isoDate(record.createdAt, "createdAt"),
  };
}

function safeTags(value: unknown, name: string): string[] {
  const values = array(value, name);
  if (values.length > 20) throw new Error(`${name} has too many entries`);
  return values.map((tag) => boundedString(tag, "tag", 1, 32));
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function boundedString(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new Error(`${name} is invalid`);
  return value;
}

function isoDate(value: unknown, name: string): string {
  const text = boundedString(value, name, 1, 64);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${name} is invalid`);
  return text;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} is invalid`);
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${name} is invalid`);
  return value as number;
}

function cadence(value: string | undefined): number {
  const parsed = Number(value ?? "15");
  if (!Number.isSafeInteger(parsed) || parsed < 5 || parsed > 1_440) throw new Error("--cadence must be an integer from 5 to 1440 minutes");
  return parsed;
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function requireConfirmation(flags: TeamCommandFlags, action: string): void {
  if (!flags.boolean.has("confirm")) throw new Error(`${action} requires --confirm`);
}

function receiverAcceptance(flags: TeamCommandFlags, action: string): TeamReceiverAcceptance {
  requireConfirmation(flags, action);
  return { disclosureAccepted: true, termsAccepted: true, privacyAccepted: true };
}

function validInviteCode(value: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{7,127}$/.test(value)) {
    throw new Error("invite code must be 8-128 characters, start with a letter, number, or underscore, and use only letters, numbers, underscores, or hyphens");
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown failure";
}
