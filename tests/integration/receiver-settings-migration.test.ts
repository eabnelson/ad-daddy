import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("migration 0015 aborts before schema mutation when legacy receiver profiles need an operator decision", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    const migrations = readdirSync(resolve("drizzle")).filter((file) => file.endsWith(".sql")).sort();
    for (const file of migrations.filter((file) => file < "0015_")) {
      sqlite.exec(readFileSync(resolve("drizzle", file), "utf8"));
    }
    sqlite.exec("INSERT INTO human_accounts (id, status) VALUES ('legacy_receiver', 'active')");
    sqlite.exec(`INSERT INTO installations (id, account_id, public_key, host_kind, status)
      VALUES ('legacy_installation', 'legacy_receiver', '{}', 'codex', 'active')`);
    sqlite.exec(`INSERT INTO receiver_profiles
      (id, account_id, installation_id, status, current_consent_version)
      VALUES ('legacy_profile', 'legacy_receiver', 'legacy_installation', 'active', 0)`);

    const migration = readFileSync(resolve("drizzle/0015_mysterious_garia.sql"), "utf8");
    assert.throws(() => sqlite.exec(migration), /receiver_profiles_must_be_empty_before_0015|CHECK constraint failed/i);
    const columns = sqlite.prepare("PRAGMA table_info(receiver_profiles)").all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "config_json"), false);
    assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'campaign_refund_withdrawals'").get(), undefined);
  } finally {
    sqlite.close();
  }
});
