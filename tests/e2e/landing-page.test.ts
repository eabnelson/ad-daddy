import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const instruction = "tell your agent to get setup with Ad Daddy and start earning before you build";

test("the public launch surface contains one instruction and one working setup link", async () => {
  const [page, html, css] = await Promise.all([
    readFile("app/page.tsx", "utf8"),
    readFile("outputs/ad-daddy.html", "utf8"),
    readFile("app/globals.css", "utf8"),
  ]);
  assert.match(page.replace(/<[^>]+>/g, ""), new RegExp(instruction));
  assert.equal((page.match(/<a\b/g) ?? []).length, 1);
  assert.match(page, /href="\/AD-DADDY\.md"/);
  assert.match(html.replace(/<[^>]+>/g, ""), new RegExp(instruction));
  assert.equal((html.match(/<a\b/g) ?? []).length, 1);
  assert.match(html, /href="AD-DADDY\.md"/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media \(max-width: 620px\)/);
  await Promise.all([access("public/AD-DADDY.md"), access("outputs/AD-DADDY.md")]);
});

test("the setup document covers both roles, native session disclosure, and production payment gates", async () => {
  const setup = await readFile("public/AD-DADDY.md", "utf8");
  for (const required of [
    "## Receiver", "## Advertiser", "## Sponsored sessions", "Every field defaults off",
    "separate sponsored session", "80/20 cash split", "human-approved payout address",
  ]) assert.match(setup, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});
