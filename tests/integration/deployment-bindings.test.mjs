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

  for (const environment of ["staging", "production"]) {
    const env = config.env[environment];
    assert.equal(env.services[0].binding, "AUCTION_SERVICE");
    assert.match(env.services[0].service, new RegExp(`${environment}$`));
    assert.equal(env.d1_databases[0].binding, "DB");
  }
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
