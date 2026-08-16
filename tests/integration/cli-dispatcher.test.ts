import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url));

test("installed ad-daddy bin dispatches every documented command as machine-readable JSON", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-cli-"));
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    requests.push({ path: request.url ?? "", body });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/poll" ? { status: "no_placement" } : request.url === "/api/v1/opportunities" ? { items: [], nextCursor: null } : { campaign: body.campaign ?? { campaignId: body.campaignId, status: body.action } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const configPath = join(directory, "config.json");
  const setupPath = join(directory, "setup.json");
  await writeFile(setupPath, JSON.stringify({
    installationId: "installation_cli", accountId: "account_cli", role: "receiver",
    profile: { values: { projectDescriptions: ["Building a deploy agent"], acceptedRewardTypes: ["credits"] }, enabled: { projectDescriptions: true, acceptedRewardTypes: true } },
    cadenceMinutes: 5, termsVersion: "receiver-terms/2026-08-15", privacyVersion: "privacy/2026-08-15",
    hostDisclosure: { host: "Codex", consumesTurn: true },
  }));
  const env = {
    ...process.env,
    AD_DADDY_CONFIG_PATH: configPath,
    AD_DADDY_API_URL: base,
    AD_DADDY_POLL_URL: `${base}/poll`,
    AD_DADDY_MARKETPLACE_PUBLIC_KEY_PEM: "pinned-test-key",
    AD_DADDY_LOCAL_ROOT: directory,
    CODEX_THREAD_ID: "active-task",
  };

  const setup = await command(["setup", "--input", setupPath, "--activate", "--accept-disclosure", "--accept-terms", "--accept-privacy"], env);
  assert.equal(setup.result.status, "active");
  const profile = await command(["profile"], env);
  assert.deepEqual(profile.result.publishedFields, { projectDescriptions: ["Building a deploy agent"], acceptedRewardTypes: ["credits"] });
  const check = await command(["check"], env);
  assert.equal(check.result.status, "checked");
  assert.equal((check.result.delivery as { status: string }).status, "no_placement");
  assert.equal((await command(["advertiser", "--role", "advertiser"], env)).result.role, "advertiser");

  const campaign = {
    campaignId: "campaign_cli", accountId: "ignored", brand: { name: "Neon", verifiedDomain: "neon.tech", verificationId: "brand_neon" },
    destinationUrl: "https://neon.tech/offer", allowlistedDestinationHosts: ["neon.tech"], schedule: { startsAt: "2026-08-15T15:00:00.000Z", endsAt: "2026-08-16T15:00:00.000Z" },
    categories: ["database"], regions: ["US Northeast"], hosts: ["codex"], rewardTypes: ["credits"], creative: { headline: "Database", body: "Credits" },
    maximumSpendMinor: 1000, maximumBidMinor: 100, dailyCapMinor: 500, guaranteedPlacementMinor: 50, conversionBonusMinor: 0, conversionTerms: "Signup", perUserFrequencyLimit: 1,
  };
  await command(["campaign", "prepare", "--json", JSON.stringify(campaign)], env);
  const approvalInput = JSON.stringify({ campaignId: "campaign_cli", approvalId: "approval_cli" });
  for (const operation of ["fund", "approve", "pause", "close"]) await command(["campaign", operation, "--json", approvalInput], env);
  await command(["campaign", "token", "--json", JSON.stringify({
    campaignId: "campaign_cli", token: { scopes: ["opportunity:search", "bid:submit"], spendCeilingMinor: 500, bidCeilingMinor: 100, expiresAt: "2026-08-15T15:10:00.000Z" },
  })], { ...env, AD_DADDY_API_TOKEN: "account-agent-token" });
  await command(["search", "--json", JSON.stringify({ accountId: "account_cli", campaignId: "campaign_cli" })], env);
  await command(["bid", "--json", JSON.stringify({
    auctionId: "auction_cli", accountId: "account_cli", campaignId: "campaign_cli",
    bid: { bidId: "bid_cli", campaignId: "campaign_cli", rewardLane: "credits", grossMinor: 0, submittedAt: "2026-08-15T15:00:00.000Z" },
  })], { ...env, AD_DADDY_API_TOKEN: "campaign-agent-token" });
  await command(["placement", "--placement", "placement_cli"], { ...env, AD_DADDY_API_TOKEN: "account-agent-token" });
  await command(["placement", "--placement", "placement_cli", "--action", "report", "--confirm"], { ...env, AD_DADDY_API_TOKEN: "account-agent-token" });
  assert.deepEqual(requests.filter((item) => item.path === "/api/v1/campaigns").map((item) => item.body.action), ["prepare", "fund", "activate", "pause", "close", "issue_agent_token"]);
  assert.ok(requests.some((item) => item.path === "/api/v1/opportunities"));
  assert.ok(requests.some((item) => item.path === "/api/v1/auctions/auction_cli/bids"));
  assert.equal(requests.filter((item) => item.path === "/api/v1/placements/placement_cli/receipt").length, 2);

  assert.equal((await command(["pause"], env)).result.status, "paused");
  assert.equal((await command(["uninstall"], env)).result.status, "revoked");

  await assert.rejects(execute(cli, ["unknown"], { env }), (error: unknown) => {
    const failure = error as { code?: number; stderr?: string };
    assert.equal(failure.code, 1);
    assert.deepEqual(JSON.parse(failure.stderr ?? ""), { ok: false, command: "unknown", error: "Unknown command: unknown" });
    return true;
  });
});

async function command(args: string[], env: NodeJS.ProcessEnv): Promise<{ command: string; result: Record<string, unknown> }> {
  const { stdout, stderr } = await execute(cli, args, { env });
  assert.equal(stderr, "");
  const parsed = JSON.parse(stdout) as { ok: boolean; command: string; result: Record<string, unknown> };
  assert.equal(parsed.ok, true);
  return parsed;
}
