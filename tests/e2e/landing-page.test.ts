import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { copySetupPrompt, createSetupPrompt } from "../../app/landing-prompt.ts";

test("the public launch is a minimal branded agent handoff", async () => {
  const [page, hostedPage, experience, promptSource, brand, brandImages, brandImageFont, fontLicense, css, hostedLayout, og, icon] = await Promise.all([
    readFile("app/page.tsx", "utf8"),
    readFile("apps/vercel/app/page.tsx", "utf8"),
    readFile("app/landing-page.tsx", "utf8"),
    readFile("app/landing-prompt.ts", "utf8"),
    readFile("app/brand.tsx", "utf8"),
    readFile("app/brand-images.tsx", "utf8"),
    readFile("app/fonts/anton-subset.ts", "utf8"),
    readFile("app/fonts/anton-OFL.txt", "utf8"),
    readFile("app/globals.css", "utf8"),
    readFile("apps/vercel/app/layout.tsx", "utf8"),
    readFile("apps/vercel/app/opengraph-image.tsx", "utf8"),
    readFile("apps/vercel/app/icon.tsx", "utf8"),
  ]);
  assert.match(page, /LandingPage/);
  assert.match(hostedPage, /LandingPage/);
  assert.match(page, /initialSetupUrl=\{getSetupUrl\(\)\}/);
  assert.match(page, /NEXT_PUBLIC_AD_DADDY_URL/);
  assert.match(hostedPage, /initialSetupUrl=\{setupUrl\}/);
  assert.match(hostedPage, /https:\/\/ad-daddy-team\.vercel\.app\/ad-daddy\.md/);
  for (const phrase of ["Earn while you build", "TELL", "YOUR AGENT"]) {
    assert.match(experience, new RegExp(phrase));
  }
  assert.match(promptSource, /Help me setup Ad Daddy/);
  assert.match(brand, />AD</);
  assert.match(brand, />DADDY</);
  assert.match(experience, /\/ad-daddy\.md/);
  assert.match(experience, /copySetupPrompt/);
  assert.match(experience, /COPY MANUALLY/);
  assert.doesNotMatch(experience, /Try the demo|Private team|Join the network/);
  assert.match(css, /\.brand-ad\s*\{[^}]*color:\s*var\(--brand-red\)/);
  assert.match(css, /\.brand-daddy\s*\{[^}]*color:\s*var\(--ink\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /font-family: Impact/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(hostedLayout, /brandMetadata/);
  assert.match(brand, /AD DADDY/);
  assert.match(brand, /Earn while you build/);
  assert.match(og, /brandOpenGraphImage/);
  assert.match(icon, /brandIconImage/);
  assert.match(brandImages, /background:\s*"#000000"/);
  assert.match(brandImages, />AD</);
  assert.match(brandImages, />DADDY</);
  assert.match(brandImages, />A</);
  assert.match(brandImages, />D</);
  assert.match(brandImages, /fonts:\s*\[BRAND_IMAGE_FONT\]/);
  assert.doesNotMatch(brandImages, /Arial Narrow|Impact/);
  assert.match(brandImageFont, /AD_DADDY_DISPLAY_FONT/);
  assert.match(fontLicense, /SIL OPEN FONT LICENSE Version 1\.1/);
  await access("public/AD-DADDY.md");
});

test("the setup prompt preserves the exact handoff copy and an absolute URL", () => {
  assert.equal(
    createSetupPrompt("https://ad-daddy-team.vercel.app/ad-daddy.md"),
    "Help me setup Ad Daddy https://ad-daddy-team.vercel.app/ad-daddy.md",
  );
  assert.throws(() => createSetupPrompt("/ad-daddy.md"), /Invalid URL/);
  assert.throws(() => createSetupPrompt("file:///ad-daddy.md"), /HTTP or HTTPS/);
});

test("copying reports success, missing support, and rejected permissions", async () => {
  let copiedText = "";
  const prompt = createSetupPrompt("https://example.com/ad-daddy.md");

  assert.equal(await copySetupPrompt(prompt, () => ({
    async writeText(text) {
      copiedText = text;
    },
  })), true);
  assert.equal(copiedText, prompt);
  assert.equal(await copySetupPrompt(prompt, () => undefined), false);
  assert.equal(await copySetupPrompt(prompt, () => ({
    async writeText() {
      throw new Error("clipboard permission denied");
    },
  })), false);
  assert.equal(await copySetupPrompt(prompt, () => {
    throw new Error("clipboard getter unavailable");
  }), false);
});

test("the setup document covers both roles, native session disclosure, and production payment gates", async () => {
  const setup = await readFile("public/AD-DADDY.md", "utf8");
  for (const required of [
    "## Receiver", "## Advertiser", "## Sponsored sessions", "Every field defaults off",
    "separate sponsored session", "80/20 cash split", "human-approved payout address",
    "funded payout ladder", "Earned on placement", "Optional actions never reduce",
    "one-time background opt-in", "polls on the receiver's schedule", "appears automatically",
  ]) assert.match(setup, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});
