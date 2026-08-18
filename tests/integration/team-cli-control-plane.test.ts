import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { CodexAppServerConnection } from "../../packages/host-adapters/dist/index.js";
import { runCli } from "../../packages/cli/dist/index.js";
import { runTeamControl } from "../../packages/cli/dist/team-control.js";
import { MemoryTeamModeStore, TeamModeService } from "../../lib/team-mode/service.ts";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url));

test("team CLI is a complete agent-first control plane with a private local capability", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-team-cli-"));
  const contextPath = join(directory, "team.json");
  const configPath = join(directory, "config.json");
  const requests: Array<{ authorization: string; body: Record<string, unknown> }> = [];
  let member = {
    id: "team_member_erik",
    installationId: "team_install_erik",
    displayName: "Erik",
    tags: ["typescript", "postgres"],
    receivesAds: false,
    createdAt: "2026-08-18T12:00:00.000Z",
    updatedAt: "2026-08-18T12:00:00.000Z",
  };
  const members = [member, {
    id: "team_member_maya",
    displayName: "Maya",
    tags: ["typescript", "design"],
    receivesAds: true,
    createdAt: "2026-08-18T12:00:00.000Z",
    updatedAt: "2026-08-18T12:00:00.000Z",
  }];
  const ads: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    const authorization = request.headers.authorization ?? "";
    requests.push({ authorization, body });
    response.setHeader("content-type", "application/json");
    if (body.action === "join") {
      assert.equal(authorization, "Bearer iloveads");
      response.statusCode = 201;
      response.end(JSON.stringify({ member, accessToken: "member.private.capability", publicKeyPem: "pinned-team-public-key" }));
      return;
    }
    assert.equal(authorization, "Bearer member.private.capability");
    if (body.action === "profile") member = { ...member, ...body, action: undefined } as typeof member;
    if (body.action === "create_ad") ads.push({
      id: "team_ad_1", advertiserMemberId: member.id, advertiserName: member.displayName,
      title: body.title, body: body.body, targetTags: body.targetTags, points: body.points,
    });
    if (body.action === "browse_ads") {
      response.end(JSON.stringify({ matches: [{
        adId: "team_ad_other", targetTags: ["typescript"], points: 20, rewardKind: "team_points",
        createdAt: "2026-08-18T12:00:00.000Z", matchedTags: ["typescript"], matchCount: 1,
      }] }));
      return;
    }
    if (body.action === "profile_status") {
      response.end(JSON.stringify({ member }));
      return;
    }
    if (body.action === "people") {
      response.end(JSON.stringify({ people: members.filter((candidate) => candidate.id !== member.id && candidate.receivesAds) }));
      return;
    }
    if (body.action === "advertiser_profile") {
      response.end(JSON.stringify({ moneyEnabled: false, rewardKind: "team_points", member, ads, eligibleReceiverCount: 1 }));
      return;
    }
    if (body.action === "my_ads") {
      response.end(JSON.stringify({ ads }));
      return;
    }
    response.end(JSON.stringify({
      moneyEnabled: false, rewardKind: "team_points", member, members,
      ads: ads.map((ad) => ({
        adId: ad.id, targetTags: ad.targetTags, points: ad.points, rewardKind: "team_points",
        createdAt: "2026-08-18T12:00:00.000Z",
      })),
      deliveries: [], score: { pointsReceived: 0, pointsSent: 0 }, publicKeyPem: "pinned-team-public-key",
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const env = {
    ...process.env,
    AD_DADDY_TEAM_CONFIG_PATH: contextPath,
    AD_DADDY_CONFIG_PATH: configPath,
    CODEX_THREAD_ID: "receiver-setup-task",
  };

  const actions = await command(["team", "actions"], env);
  const actionCatalog = (actions.result as { actions: Array<{ name: string; command: string; input?: string }> }).actions;
  assert.deepEqual(actionCatalog.map((action) => action.name), [
    "join", "status", "profile.show", "profile.update", "advertiser.show", "people.list",
    "ads.browse", "ads.mine", "ads.send", "receiver.setup", "receiver.pause", "receiver.resume", "check",
  ]);
  const joinAction = actionCatalog.find((action) => action.name === "join");
  assert.equal(joinAction?.command, "team join --url <COORDINATOR_URL> --invite-code <INVITE_CODE> --input -");
  assert.equal(joinAction?.input, "displayName, tags, receivesAds as JSON on stdin");

  const joinInput = JSON.stringify({ displayName: "Erik", tags: ["typescript", "postgres"], receivesAds: true });
  await assert.rejects(
    command(["team", "join", "--url", origin, "--invite-code", "unsafe'code;", "--json", joinInput], env),
    /invite code must be 8-128 characters, start with a letter, number, or underscore/,
  );
  await assert.rejects(
    command(["team", "join", "--url", origin, "--invite-code", "--invite1", "--json", joinInput], env),
    /--invite-code requires a value/,
  );
  assert.equal(requests.length, 0, "unsafe invite codes must fail before contacting the coordinator");

  await assert.rejects(command(["team", "join", "--url", origin, "--invite-code", "iloveads", "--json", JSON.stringify({
    action: "status", displayName: "Erik", tags: ["typescript", "postgres"], receivesAds: true,
  })], env), /unsupported field: action/);
  assert.equal(requests.length, 0, "invalid join input must fail before contacting the coordinator");

  const joined = await commandWithStdin(
    ["team", "join", "--url", origin, "--invite-code", "iloveads", "--input", "-"],
    env,
    JSON.stringify({ displayName: "Erik", tags: ["typescript", "postgres"], receivesAds: false }),
  );
  assert.equal((joined.result as { member: { id: string } }).member.id, member.id);
  assert.doesNotMatch(String(joined.result.next), /receiver setup/, "advertiser-only join must not recommend receiver activation");
  assert.equal(JSON.stringify(joined), JSON.stringify(joined).replace(/member\.private\.capability/g, ""), "member token must not be printed");
  const stored = JSON.parse(await readFile(contextPath, "utf8")) as { memberToken: string; origin: string };
  assert.equal(stored.memberToken, "member.private.capability");
  assert.equal(stored.origin, origin);
  assert.equal((await stat(contextPath)).mode & 0o777, 0o600);

  const requestsAfterJoin = requests.length;
  await assert.rejects(command(["team", "join", "--url", origin, "--invite-code", "iloveads", "--json", JSON.stringify({
    displayName: "Duplicate", tags: [], receivesAds: true,
  })], env), /identity is already configured.*team status/);
  assert.equal(requests.length, requestsAfterJoin, "repeat join must fail before contacting the coordinator");
  assert.equal((JSON.parse(await readFile(contextPath, "utf8")) as { memberToken: string }).memberToken, "member.private.capability");

  if (process.platform !== "win32") {
    await chmod(contextPath, 0o644);
    const requestsBeforePermissionCheck = requests.length;
    await assert.rejects(command(["team", "profile", "show"], env), /Team context permissions must be 0600/);
    assert.equal(requests.length, requestsBeforePermissionCheck, "an overexposed capability must fail before network access");
    await chmod(contextPath, 0o600);
  }

  assert.equal(((await command(["team", "profile", "show"], env)).result as { displayName: string }).displayName, "Erik");
  const people = (await command(["team", "people", "list"], env)).result as { people: Array<{ id: string }> };
  assert.deepEqual(people.people.map((person) => person.id), ["team_member_maya"]);
  assert.equal(((await command(["team", "advertiser", "show"], env)).result as { ads: unknown[] }).ads.length, 0);
  assert.equal(((await command(["team", "ads", "browse"], env)).result as { matches: unknown[] }).matches.length, 1);

  await command(["team", "profile", "update", "--confirm", "--json", JSON.stringify({ tags: ["typescript", "postgres", "ai"] })], env);
  await assert.rejects(command(["team", "profile", "update", "--confirm", "--json", JSON.stringify({ action: "create_ad", tags: [] })], env), /unsupported field: action/);
  await assert.rejects(command(["team", "ads", "send", "--json", JSON.stringify({ title: "Postgres preview", body: "Try the schema explorer.", targetTags: ["typescript"], points: 40 })], env), /requires --confirm/);
  await assert.rejects(command(["team", "ads", "send", "--confirm", "--json", JSON.stringify({ action: "profile", title: "Postgres preview", body: "Try the schema explorer.", targetTags: ["typescript"], points: 40 })], env), /unsupported field: action/);
  await command(["team", "ads", "send", "--confirm", "--json", JSON.stringify({ title: "Postgres preview", body: "Try the schema explorer.", targetTags: ["typescript"], points: 40 })], env);
  assert.equal(((await command(["team", "ads", "mine"], env)).result as { ads: unknown[] }).ads.length, 1);

  const preview = await command(["team", "receiver", "setup", "--cadence", "15"], env);
  assert.equal(preview.result.status, "draft");
  assert.match(String(preview.result.activationDisclosure), /separate sponsored session and never runs advertiser actions/);
  assert.equal(preview.result.termsVersion, "receiver-terms/2026-08-15");
  assert.equal(preview.result.privacyVersion, "privacy/2026-08-15");
  assert.deepEqual(preview.result.receiverHost, {
    host: "Codex", supported: true,
    reason: "This Codex task provides the active-task authorization required to prove a new sponsored task does not replace the current task.",
  });
  const receiver = await command(["team", "receiver", "setup", "--confirm"], env);
  assert.equal((receiver.result as { local: { installation: { status: string } } }).local.installation.status, "active");
  assert.equal(((await command(["team", "profile", "show"], env)).result as { receivesAds: boolean }).receivesAds, true,
    "successful receiver activation must opt an advertiser-only remote profile into receiving");
  await command(["team", "receiver", "pause", "--confirm"], env);
  const resumePreview = await command(["team", "receiver", "resume"], env);
  assert.equal(resumePreview.result.status, "draft");
  assert.match(String(resumePreview.result.activationDisclosure), /separate sponsored session/);
  const unsupportedEnv: NodeJS.ProcessEnv = { ...env };
  delete unsupportedEnv.CODEX_THREAD_ID;
  await assert.rejects(command(["team", "receiver", "resume", "--confirm"], unsupportedEnv), /Native receiver delivery is not supported in this host yet/);
  assert.equal(((await command(["team", "profile", "show"], env)).result as { receivesAds: boolean }).receivesAds, false);
  await command(["team", "receiver", "resume", "--confirm"], env);

  const authorized = requests.filter((request) => request.body.action !== "join");
  assert.ok(authorized.length > 0);
  assert.ok(authorized.every((request) => request.authorization === "Bearer member.private.capability"));
});

test("receiver pause and resume compensate the other side when synchronization fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-team-sync-"));
  const contextPath = join(directory, "team.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(contextPath, JSON.stringify({
    version: 1,
    origin: "https://ads.example.com",
    memberToken: "member.private.capability",
    memberId: "team_member_erik",
    installationId: "team_install_erik",
    publicKeyPem: "pinned-team-public-key",
  }));
  await chmod(contextPath, 0o600);

  let receivesAds = true;
  const remoteTransitions: boolean[] = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { action: string; receivesAds?: boolean };
    if (body.action === "profile_status") return jsonResponse({ member: testMember(receivesAds) });
    if (body.action === "profile") {
      receivesAds = Boolean(body.receivesAds);
      remoteTransitions.push(receivesAds);
      return jsonResponse({ member: testMember(receivesAds) });
    }
    throw new Error(`unexpected action ${body.action}`);
  };
  const noop = async () => ({});

  await assert.rejects(runTeamControl({
    values: new Map(), boolean: new Set(["confirm"]), positionals: ["receiver", "pause"],
  }, {
    env: { ...process.env }, contextPath, fetch: fetch as typeof globalThis.fetch, readInput: noop,
    receiver: {
      setupPreview: noop, setupActivate: noop, resumePreview: noop, resumeActivate: noop, check: noop,
      pause: async () => { throw new Error("local pause failed"); },
    },
  }), /local pause failed/);
  assert.equal(receivesAds, true);
  assert.deepEqual(remoteTransitions, [false, true], "failed local pause must restore the coordinator state");

  receivesAds = false;
  let localPaused = false;
  const failingResumeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { action: string; receivesAds?: boolean };
    if (body.action === "profile_status") return jsonResponse({ member: testMember(false) });
    if (body.action === "profile" && body.receivesAds === true) return jsonResponse({ error: "outage" }, 503);
    throw new Error(`unexpected action ${body.action}`);
  };
  await assert.rejects(runTeamControl({
    values: new Map(), boolean: new Set(["confirm"]),
    positionals: ["receiver", "resume"],
  }, {
    env: { ...process.env }, contextPath, fetch: failingResumeFetch as typeof globalThis.fetch, readInput: noop,
    receiver: {
      setupPreview: noop, setupActivate: noop, resumePreview: noop, resumeActivate: async () => ({ status: "active" }), check: noop,
      pause: async () => { localPaused = true; return { status: "paused" }; },
    },
  }), /coordinator rejected the request \(503\): outage/);
  assert.equal(localPaused, true, "failed remote resume must pause the local receiver again");
});

test("team check uses stored identity to display one signed task before acknowledging it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-team-check-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const service = new TeamModeService(new MemoryTeamModeStore(), {
    keyId: "team_check", privateKeyPem, publicKeyPem,
  });
  const sender = await service.join({ displayName: "Sender", tags: ["typescript"], receivesAds: false });
  const receiver = await service.join({ displayName: "Receiver", tags: ["typescript"], receivesAds: true });
  await service.createAd({
    memberKey: sender.memberKey, title: "Team database", body: "A database preview for the team.",
    targetTags: ["typescript"], points: 20,
  });
  const contextPath = join(directory, "team.json");
  const configPath = join(directory, "config.json");
  await writeFile(contextPath, JSON.stringify({
    version: 1, origin: "https://ads.example.com", memberToken: receiver.memberKey,
    memberId: receiver.member.id, installationId: receiver.member.installationId, publicKeyPem,
  }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify([{
    installationId: receiver.member.installationId, accountId: receiver.member.id, role: "both",
    profile: { values: {}, enabled: {} }, publishedFields: {}, cadenceMinutes: 15,
    termsVersion: "receiver-terms/2026-08-15", privacyVersion: "privacy/2026-08-15",
    consentVersion: 1, status: "active", hostDisclosure: { host: "Codex", consumesTurn: true },
  }]), { mode: 0o600 });
  let acknowledgements = 0;
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${receiver.memberKey}`);
    const body = JSON.parse(String(init?.body)) as { action?: string; installationId?: string; deliveryId?: string };
    if (body.action === "ack") {
      acknowledgements += 1;
      return jsonResponse(await service.acknowledge({ memberKey: receiver.memberKey, deliveryId: body.deliveryId }));
    }
    return jsonResponse(await service.poll({ memberKey: receiver.memberKey, installationId: body.installationId }));
  };
  const host = new TeamCheckHost();
  const output: string[] = [];
  const errors: string[] = [];
  const exit = await runCli(["team", "check"], {
    env: {
      NODE_ENV: process.env.NODE_ENV ?? "test",
      AD_DADDY_TEAM_CONFIG_PATH: contextPath,
      AD_DADDY_CONFIG_PATH: configPath,
      AD_DADDY_LOCAL_ROOT: directory,
      CODEX_THREAD_ID: "scheduled-receiver-check",
    },
    homeDirectory: directory,
    fetch: fetch as typeof globalThis.fetch,
    stdout: (value) => output.push(value),
    stderr: (value) => errors.push(value),
    codexConnectionFactory: host.createConnection,
  });

  assert.equal(exit, 0, errors.join(""));
  assert.equal(host.threadStartCount, 1);
  assert.equal(host.turnStartCount, 1);
  assert.equal(acknowledgements, 1, "coordinator acknowledgement must happen only after verified display");
  const result = JSON.parse(output.join("")) as { result: { delivery: { status: string } } };
  assert.equal(result.result.delivery.status, "native");
});

function testMember(receivesAds: boolean) {
  return {
    id: "team_member_erik", installationId: "team_install_erik", displayName: "Erik", tags: [], receivesAds,
    createdAt: "2026-08-18T12:00:00.000Z", updatedAt: "2026-08-18T12:00:00.000Z",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface TeamCheckThread {
  id: string;
  name: string | null;
  preview: string;
  turns: Array<{ id: string; status: string; items: unknown[] }>;
}

class TeamCheckHost {
  readonly #threads = new Map<string, TeamCheckThread>();
  threadStartCount = 0;
  turnStartCount = 0;

  createConnection = async (): Promise<CodexAppServerConnection> => {
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    let waiter: ((value: { method: string; params: Record<string, unknown> }) => void) | undefined;
    const emit = (notification: { method: string; params: Record<string, unknown> }) => {
      if (waiter) { const resolve = waiter; waiter = undefined; resolve(notification); }
      else notifications.push(notification);
    };
    return {
      cliVersion: "0.146.1",
      userAgent: "Codex Desktop/0.146.1 (team check integration)",
      allowedInstructionSources: [],
      builtInToolsDisabled: true,
      request: async <T>(method: string, value: unknown): Promise<T> => {
        const params = value as { threadId?: string; name?: string; input?: Array<{ text: string }> };
        if (method === "thread/list") return { data: [...this.#threads.values()].map(teamCheckSummary), nextCursor: null } as T;
        if (method === "thread/start") {
          this.threadStartCount += 1;
          const thread: TeamCheckThread = { id: `sponsored-${this.threadStartCount}`, name: null, preview: "", turns: [] };
          this.#threads.set(thread.id, thread);
          return { thread: teamCheckSummary(thread), instructionSources: [] } as T;
        }
        if (method === "thread/name/set") { this.#threads.get(params.threadId!)!.name = params.name!; return {} as T; }
        if (method === "turn/start") {
          this.turnStartCount += 1;
          const thread = this.#threads.get(params.threadId!)!;
          thread.preview = params.input![0]!.text;
          const turn = { id: "display-turn", status: "inProgress", items: [] as unknown[] };
          thread.turns.push(turn);
          queueMicrotask(() => {
            const item = {
              type: "agentMessage", id: "answer", phase: "final_answer",
              text: "Sponsored via Ad Daddy\nSender — Team database\nReward: 20 team points\nMatched: typescript",
            };
            turn.items.push(item);
            emit({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item } });
            turn.status = "completed";
            emit({ method: "turn/completed", params: { threadId: thread.id, turn: structuredClone(turn) } });
          });
          return { turn } as T;
        }
        if (method === "thread/read") {
          const thread = this.#threads.get(params.threadId!);
          if (!thread) throw new Error("thread missing");
          return { thread: structuredClone(thread) } as T;
        }
        if (method === "turn/interrupt") return {} as T;
        throw new Error(`Unexpected App Server method ${method}`);
      },
      nextNotification: async () => notifications.shift() ?? new Promise((resolve) => { waiter = resolve; }),
      close: async () => {},
    };
  };
}

function teamCheckSummary(thread: TeamCheckThread) {
  return { id: thread.id, name: thread.name, preview: thread.preview, turns: [] };
}

async function command(args: string[], env: NodeJS.ProcessEnv): Promise<{ command: string; result: Record<string, unknown> }> {
  try {
    const { stdout, stderr } = await execute(cli, args, { env });
    assert.equal(stderr, "");
    const parsed = JSON.parse(stdout) as { ok: boolean; command: string; result: Record<string, unknown> };
    assert.equal(parsed.ok, true);
    return parsed;
  } catch (error) {
    const failure = error as { stderr?: string };
    const parsed = JSON.parse(failure.stderr ?? "{}") as { error?: string };
    throw new Error(parsed.error ?? "CLI command failed");
  }
}

async function commandWithStdin(args: string[], env: NodeJS.ProcessEnv, input: string): Promise<{ command: string; result: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      const parsed = JSON.parse(code === 0 ? stdout : stderr) as {
        ok?: boolean; command?: string; result?: Record<string, unknown>; error?: string;
      };
      if (code !== 0) { reject(new Error(parsed.error ?? "CLI command failed")); return; }
      assert.equal(parsed.ok, true);
      resolve({ command: parsed.command!, result: parsed.result! });
    });
    child.stdin.end(input);
  });
}
