import assert from "node:assert/strict";
import test from "node:test";

import { LaunchdScheduler } from "../../packages/cli/dist/schedulers/launchd.js";

class FakeLaunchd {
  files = new Map<string, string>();
  loaded = new Set<string>();
  async write(path: string, contents: string) { this.files.set(path, contents); }
  async remove(path: string) { this.files.delete(path); }
  async bootstrap(label: string) { this.loaded.add(label); }
  async bootout(label: string) { this.loaded.delete(label); }
}

test("preview/install/restart/upgrade/pause/uninstall leave exactly one or zero jobs", async () => {
  const host = new FakeLaunchd();
  const scheduler = new LaunchdScheduler(host, { homeDirectory: "/tmp/user", executablePath: "/opt/ad-daddy" });
  const preview = scheduler.preview({ installationId: "receiver-1", cadenceMinutes: 30 });
  assert.match(preview.plist, /StartInterval/);
  assert.match(preview.plist, /1800/);
  await scheduler.install({ installationId: "receiver-1", cadenceMinutes: 30 });
  await scheduler.restart({ installationId: "receiver-1", cadenceMinutes: 30 });
  await scheduler.install({ installationId: "receiver-1", cadenceMinutes: 60 });
  assert.equal(host.files.size, 1);
  assert.equal(host.loaded.size, 1);
  assert.match([...host.files.values()][0]!, /3600/);
  await scheduler.pause("receiver-1");
  assert.equal(host.loaded.size, 0);
  await scheduler.uninstall("receiver-1");
  assert.equal(host.files.size, 0);
});
