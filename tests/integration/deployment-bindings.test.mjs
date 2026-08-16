import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("root workspace owns every runtime package", async () => {
  const packageJson = await readJson("package.json");

  assert.deepEqual(packageJson.workspaces, [
    "packages/cli",
    "packages/host-adapters",
    "workers/auction",
  ]);
  assert.equal(typeof packageJson.scripts.typecheck, "string");
  assert.equal(typeof packageJson.scripts["test:packages"], "string");
  assert.equal(typeof packageJson.scripts["test:deployment"], "string");
});

test("app binds the private auction worker in every environment", async () => {
  const config = await readJson("wrangler.app.jsonc");

  assert.equal(config.workers_dev, false);
  assert.equal(config.main, "./dist/server/index.js");
  assert.equal(config.no_bundle, true);
  assert.equal(config.assets.directory, "./dist/client");
  assert.equal(config.services[0].binding, "AUCTION_SERVICE");
  assert.equal(config.services[0].service, "ad-daddy-auction");
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.d1_databases[0].migrations_dir, "drizzle");
  assert.equal(config.vars.AD_DADDY_ENV, "test");
  assert.equal(config.vars.AD_DADDY_MEMO_SALT, undefined, "memo salt must be supplied as a Wrangler secret, never plaintext vars");
  assert.equal(config.vars.AD_DADDY_PAYMENT_EVENT_SECRET, undefined, "payment event authentication must be supplied as a Wrangler secret");
  assert.equal(config.vars.AD_DADDY_SPONSORSHIP_SIGNING_PRIVATE_KEY, undefined, "sponsorship signing key must be supplied as a Wrangler secret");
  assert.equal(config.vars.AD_DADDY_SPONSORSHIP_SIGNING_KEY_ID, undefined, "sponsorship key identity must be supplied out of band");
  assert.equal(config.vars.AD_DADDY_CAMPAIGN_TOKEN_SECRET, undefined, "campaign token authority must be supplied as a Wrangler secret");
  assert.equal(config.vars.AD_DADDY_ACCOUNT_AGENT_TOKEN_SECRET, undefined, "account agent token authority must be supplied as a Wrangler secret");
  assert.equal(config.vars.AD_DADDY_LAUNCH_POLICY_JSON, undefined, "launch policy must be supplied as a reviewed deployment secret");
  assert.equal(config.vars.AD_DADDY_OPERATOR_ACCOUNT_IDS, undefined, "operator identities must be supplied out of band");
  assert.deepEqual(config.triggers.crons, ["* * * * *"]);

  for (const environment of ["staging", "production"]) {
    const env = config.env[environment];
    assert.equal(env.services[0].binding, "AUCTION_SERVICE");
    assert.match(env.services[0].service, new RegExp(`${environment}$`));
    assert.equal(env.d1_databases[0].binding, "DB");
    assert.equal(env.d1_databases[0].migrations_dir, "drizzle");
    assert.equal(env.vars.AD_DADDY_ENV, environment);
    assert.equal(env.vars.AD_DADDY_MEMO_SALT, undefined, "memo salt must not be committed to deployment config");
    assert.equal(env.vars.AD_DADDY_PAYMENT_EVENT_SECRET, undefined, "payment event secret must not be committed to deployment config");
    assert.equal(env.vars.AD_DADDY_SPONSORSHIP_SIGNING_PRIVATE_KEY, undefined, "sponsorship signing key must not be committed to deployment config");
    assert.equal(env.vars.AD_DADDY_SPONSORSHIP_SIGNING_KEY_ID, undefined, "sponsorship key identity must not be committed to deployment config");
    assert.equal(env.vars.AD_DADDY_CAMPAIGN_TOKEN_SECRET, undefined, "campaign token secret must not be committed to deployment config");
    assert.equal(env.vars.AD_DADDY_ACCOUNT_AGENT_TOKEN_SECRET, undefined, "account agent token secret must not be committed to deployment config");
    assert.equal(env.vars.AD_DADDY_LAUNCH_POLICY_JSON, undefined, "launch policy must not be committed without deployment approval");
    assert.equal(env.vars.AD_DADDY_OPERATOR_ACCOUNT_IDS, undefined, "operator identities must not be committed to deployment config");
    assert.deepEqual(env.triggers.crons, ["* * * * *"]);
  }
  const workerBindings = await readFile("worker-configuration.d.ts", "utf8");
  assert.match(workerBindings, /AD_DADDY_MEMO_SALT: string/);
  assert.match(workerBindings, /AD_DADDY_PAYMENT_EVENT_SECRET: string/);
  assert.match(workerBindings, /AD_DADDY_SPONSORSHIP_SIGNING_PRIVATE_KEY: string/);
  assert.match(workerBindings, /AD_DADDY_SPONSORSHIP_SIGNING_KEY_ID: string/);
  assert.match(workerBindings, /AD_DADDY_CAMPAIGN_TOKEN_SECRET: string/);
  assert.match(workerBindings, /AD_DADDY_ACCOUNT_AGENT_TOKEN_SECRET: string/);
  assert.match(workerBindings, /AD_DADDY_LAUNCH_POLICY_JSON: string/);
  assert.match(workerBindings, /AD_DADDY_OPERATOR_ACCOUNT_IDS: string/);
  assert.match(workerBindings, /AD_DADDY_ENV: "test" \| "staging" \| "production"/);
});

test("auction worker exports a durable object with isolated bindings", async () => {
  const config = await readJson("workers/auction/wrangler.jsonc");

  assert.equal(config.workers_dev, false);
  assert.equal(config.durable_objects.bindings[0].name, "AUCTION_OBJECT");
  assert.equal(config.durable_objects.bindings[0].class_name, "AuctionObject");
  assert.deepEqual(config.migrations, [
    { tag: "v1", new_sqlite_classes: ["AuctionObject"] },
  ]);

  const databaseIds = new Set([config.d1_databases[0].database_id]);
  for (const environment of ["staging", "production"]) {
    const env = config.env[environment];
    assert.equal(env.durable_objects.bindings[0].name, "AUCTION_OBJECT");
    assert.equal(env.d1_databases[0].binding, "DB");
    databaseIds.add(env.d1_databases[0].database_id);
  }
  assert.equal(databaseIds.size, 3);
});
