import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const skillRoot = new URL("../../packages/ad-daddy-skill/", import.meta.url);

test("portable skill metadata and referenced setup files are complete", async () => {
  const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");
  const metadata = await readFile(new URL("agents/openai.yaml", skillRoot), "utf8");

  assert.match(skill, /^---\nname: ad-daddy-skill\ndescription: .+\n---/);
  assert.match(skill, /receiver, advertiser, or both/i);
  assert.match(skill, /team actions/i);
  assert.match(skill, /profile\.show|profile show/i);
  assert.match(skill, /advertiser\.show|advertiser show/i);
  assert.match(skill, /people\.list|people list/i);
  assert.match(skill, /ads\.send|ads send/i);
  assert.match(skill, /receiver\.setup|receiver setup/i);
  assert.match(skill, /one combined confirmation/i);
  assert.match(skill, /receiver setup --confirm/);
  assert.match(skill, /receiving on by default/i);
  assert.match(skill, /1, 5, 15, or 60 minutes/i);
  assert.match(skill, /heartbeat attached to the setup task/i);
  assert.match(skill, /not a standalone cron task/i);
  assert.doesNotMatch(skill, /accept-disclosure|accept-terms|accept-privacy/);
  assert.match(skill, /supported only from a Codex task/i);
  assert.match(skill, /browser/i);
  assert.match(skill, /may paste.*invite code.*conversation/i);
  assert.match(skill, /--invite-code/);
  assert.match(skill, /--invite-code <INVITE_CODE> --input -/);
  assert.match(skill, /--input -/);
  assert.match(skill, /profile JSON through stdin/i);
  assert.match(skill, /never interpolate human-provided profile values into a shell command/i);
  assert.match(skill, /every JSON mutation body through stdin with `--input -`/i);
  assert.match(skill, /profile or ad copy into shell commands/i);
  assert.ok(skill.includes("[A-Za-z0-9_][A-Za-z0-9_-]{7,127}"));
  assert.match(skill, /use it once/i);
  assert.match(skill, /write it to files or recurring tasks/i);
  assert.match(skill, /member capability.*private/i);
  assert.match(skill, /Build my profile/);
  assert.match(skill, /Get ads/);
  assert.match(skill, /Send an ad/);
  assert.match(skill, /authorizes the current workspace/);
  assert.match(skill, /Anything you want removed\?/);
  assert.match(skill, /50 starting points/i);
  assert.match(skill, /1 point to queue an ad for one selected teammate/i);
  assert.match(skill, /recipientMemberIds/);
  assert.match(skill, /will appear on their next receiver checks/i);
  assert.match(metadata, /\$ad-daddy-skill/);

  for (const reference of skill.matchAll(/\]\((references\/[^)]+)\)/g)) {
    const referenceUrl = new URL(reference[1], skillRoot);
    await access(referenceUrl);
    const referenceText = await readFile(referenceUrl, "utf8");
    if (reference[1].endsWith("setup.md")) {
      assert.match(referenceText, /may paste.*invite code.*conversation/i);
      assert.match(referenceText, /--invite-code/);
      assert.match(referenceText, /--invite-code <INVITE_CODE> --input -/);
      assert.match(referenceText, /--input -/);
      assert.match(referenceText, /profile JSON through stdin/i);
      assert.ok(referenceText.includes("[A-Za-z0-9_][A-Za-z0-9_-]{7,127}"));
      assert.match(referenceText, /use it once/i);
      assert.match(referenceText, /member capability is private/i);
      assert.match(referenceText, /receiving on by default/i);
      assert.match(referenceText, /1, 5, 15, or 60 minutes/i);
      assert.match(referenceText, /50 starting points/i);
      assert.match(referenceText, /recipientMemberIds/);
    }
  }
});

test("the HTTPS-served setup document fails closed without signed artifacts", async () => {
  const setup = await readFile(
    new URL("../../public/AD-DADDY.md", import.meta.url),
    "utf8",
  );

  assert.match(setup, /official HTTPS origin.*version.*checksum.*signature/i);
  assert.match(setup, /local draft only.*not active/i);
  assert.match(setup, /80\/20 cash split.*pass through at 100%/i);
});
