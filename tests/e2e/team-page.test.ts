import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("private team workspace makes the no-money sender and receiver loop self-serve", async () => {
  const [page, experience] = await Promise.all([
    readFile("app/team/page.tsx", "utf8"),
    readFile("app/team/team-experience.tsx", "utf8"),
  ]);
  const source = `${page}\n${experience}`;
  for (const phrase of [
    "Private team mode", "No real money", "Anyone can send. Anyone can receive.",
    "Invite code", "Ask your coordinator", "Send an ad", "Team points", "Set up my agent",
    "Update my profile", "Show my queued ads", "Create an ad",
    "Existing member token", "Open my workspace",
  ]) assert.match(source, new RegExp(phrase, "i"));
  assert.match(source, /setup --json/);
  assert.match(source, /\/api\/team/);
  assert.match(source, /\/ad-daddy\.md/);
  assert.match(source, /localStorage/);
  assert.match(source, /localStorage\.getItem\(STORAGE_KEY\)[\s\S]*commitSession/);
  assert.match(source, /sessionRef\.current\?\.memberAccessToken !== activeToken/);
  assert.match(source, /joinPendingRef\.current/);
  assert.match(source, /disabled=\{joining\}/);
  assert.match(source, /loads AD_DADDY_API_TOKEN from that local secret store/);
  assert.match(source, /heartbeat attached to this setup task every minute/i);
  assert.match(source, /not a standalone cron task/i);
  assert.match(source, /Creative stays inside its separate display-only sponsored task/);
  assert.doesNotMatch(source, /ad\.(?:title|body|advertiserName)/);
  assert.doesNotMatch(source, /--token '\$\{session\.memberAccessToken\}'/);
  const worker = await readFile("worker/index.ts", "utf8");
  assert.match(worker, /D1TeamModeStore/);
  assert.match(worker, /private_team_mode_is_development_only/);
  await access("public/TEAM-MODE.md");
});

test("the Vercel app exposes the minimal handoff, durable API, and agent-readable markdown", async () => {
  const [page, layout, teamPage, route, instructions, packageJson, rootPackage, vercelConfig, runbook] = await Promise.all([
    readFile("apps/vercel/app/page.tsx", "utf8"),
    readFile("apps/vercel/app/layout.tsx", "utf8"),
    readFile("apps/vercel/app/team/page.tsx", "utf8"),
    readFile("apps/vercel/app/api/team/route.ts", "utf8"),
    readFile("apps/vercel/app/ad-daddy.md/route.ts", "utf8"),
    readFile("apps/vercel/package.json", "utf8"),
    readFile("package.json", "utf8"),
    readFile("vercel.json", "utf8"),
    readFile("docs/VERCEL-TEAM-PROOF.md", "utf8"),
  ]);
  assert.match(page, /LandingPage/);
  assert.match(teamPage, /export \{ default \} from "\.\.\/\.\.\/\.\.\/\.\.\/app\/team\/page"/);
  assert.match(layout, /import \{ DM_Sans, Space_Mono \} from "next\/font\/google"/);
  assert.match(layout, /DM_Sans\(\{[\s\S]*variable: "--font-sans"[\s\S]*subsets: \["latin"\][\s\S]*\}\)/);
  assert.match(layout, /Space_Mono\(\{[\s\S]*variable: "--font-mono"[\s\S]*subsets: \["latin"\][\s\S]*weight: \["400", "700"\][\s\S]*\}\)/);
  assert.match(layout, /<body className=\{`\$\{sans\.variable\} \$\{mono\.variable\}`\}>/);
  assert.match(route, /PostgresTeamModeStore/);
  assert.match(route, /hosted_test/);
  assert.match(route, /DATABASE_URL/);
  assert.match(instructions, /export \{ GET \}/);
  assert.match(packageJson, /"next"/);
  assert.match(rootPackage, /"build:vercel": "npm run build --workspace @ad-daddy\/host-adapters && npm run build --workspace @ad-daddy\/vercel-web"/);
  assert.deepEqual(JSON.parse(vercelConfig), {
    $schema: "https://openapi.vercel.sh/vercel.json",
    framework: "nextjs",
    installCommand: "npm install",
    buildCommand: "npm run build:vercel",
    outputDirectory: "apps/vercel/.next",
  });
  assert.match(runbook, /distinct Neon branch[\s\S]*Preview[\s\S]*Production/i);
  assert.match(runbook, /Vercel Toolbar[\s\S]*Off[\s\S]*immutable static file upload/i);
});

test("team setup document delegates recurring polling and task creation to the receiver agent", async () => {
  const setup = await readFile("public/TEAM-MODE.md", "utf8");
  for (const phrase of [
    "no-money", "AD_DADDY_INVITE_CODE", "AD_DADDY_TEAM_KEY", "team actions", "team join",
    "team profile", "team advertiser", "team people", "team ads", "team check", "recurring",
    "AD DADDY: <sponsor message>", "optional diagnostic workspace", "local coordinator",
  ]) assert.match(setup, new RegExp(phrase, "i"));
  assert.match(setup, /may paste.*invite code.*conversation/i);
  assert.ok(setup.includes("[A-Za-z0-9_][A-Za-z0-9_-]{7,127}"));
  assert.match(setup, /use it once/i);
  assert.match(setup, /member-scoped capability.*remains private/i);
  assert.match(setup, /one combined question/i);
  assert.match(setup, /receiving on by default/i);
  assert.match(setup, /one-minute cadence/i);
  assert.match(setup, /heartbeat attached to the setup task/i);
  assert.match(setup, /not a standalone cron task/i);
  assert.match(setup, /Build my profile/);
  assert.match(setup, /Get ads/);
  assert.match(setup, /Send an ad/);
  assert.doesNotMatch(setup, /accept-disclosure|accept-terms|accept-privacy/);
  assert.doesNotMatch(setup, /paste.*member.*token/i);
  assert.match(setup, /--invite-code/);
  assert.match(setup, /--input -/);
  assert.match(setup, /send those bytes through stdin/i);
  assert.doesNotMatch(setup, /--json/);
});
