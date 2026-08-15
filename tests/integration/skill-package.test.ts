import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const skillRoot = new URL("../../packages/ad-daddy-skill/", import.meta.url);

test("portable skill metadata and referenced setup files are complete", async () => {
  const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");
  const metadata = await readFile(new URL("agents/openai.yaml", skillRoot), "utf8");

  assert.match(skill, /^---\nname: ad-daddy-skill\ndescription: .+\n---/);
  assert.match(skill, /receiver, advertiser, or both/i);
  assert.match(skill, /credits and discounts pass through at 100%/i);
  assert.match(metadata, /\$ad-daddy-skill/);

  for (const reference of skill.matchAll(/\]\((references\/[^)]+)\)/g)) {
    await access(new URL(reference[1], skillRoot));
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
