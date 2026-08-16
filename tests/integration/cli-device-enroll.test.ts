import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli, type CliDependencies } from "../../packages/cli/dist/index.js";
import type { DeviceCredential, DeviceKeyProvider } from "../../packages/cli/dist/device-key.js";
import { JsonLocalStore } from "../../packages/cli/dist/local-store.js";

test("CLI prepares a non-exportable device identity and attaches it only after durable enrollment", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ad-daddy-enroll-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.json");
  const provider = await fakeMacProvider();
  const requests: Array<{ path: string; body: Record<string, unknown>; proof: string | null }> = [];
  const dependencies: CliDependencies = {
    homeDirectory: directory,
    platform: "darwin",
    deviceKeyProvider: provider,
    env: { ...process.env, AD_DADDY_CONFIG_PATH: configPath, AD_DADDY_API_URL: "https://ad.daddy" },
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push({ path: new URL(request.url).pathname, body: init?.body ? JSON.parse(String(init.body)) : {}, proof: request.headers.get("x-ad-daddy-device-proof") });
      if (request.method === "GET") return Response.json({
        installationId: "install_cli", status: "active", consentVersion: 1,
        publishedFields: { acceptedRewardTypes: ["credits"] }, cadenceMinutes: 30,
        termsVersion: "terms/v1", privacyVersion: "privacy/v1", hostDisclosure: { host: "Codex", consumesTurn: true },
      });
      return Response.json({ installationId: "install_cli", accountId: "account_cli", status: "active" }, { status: request.method === "PUT" ? 200 : 201 });
    }) as typeof globalThis.fetch,
  };
  const setup = {
    installationId: "install_cli", accountId: "account_cli", role: "receiver",
    profile: { values: { acceptedRewardTypes: ["credits"] }, enabled: { acceptedRewardTypes: true } },
    cadenceMinutes: 30, termsVersion: "terms/v1", privacyVersion: "privacy/v1",
    hostDisclosure: { host: "Codex", consumesTurn: true },
  };
  assert.equal((await command(["setup", "--json", JSON.stringify(setup), "--activate", "--accept-disclosure", "--accept-terms", "--accept-privacy"], dependencies)).code, 0);
  const automatic = await command(["profile"], {
    ...dependencies,
    env: { ...dependencies.env, NODE_ENV: dependencies.env?.NODE_ENV ?? "test", AD_DADDY_SCHEDULER: "launchd" },
  });
  assert.equal(automatic.code, 1);
  assert.match(String(automatic.error.error), /Automatic background delivery is unavailable/);
  const prepared = await command(["enroll", "prepare"], dependencies);
  assert.equal(prepared.code, 0);
  assert.equal(prepared.result.keyThumbprint, provider.credential.keyThumbprint);
  assert.equal((await new JsonLocalStore(configPath).get("install_cli"))?.deviceCredential, undefined);

  const complete = await command(["enroll", "complete", "--json", JSON.stringify({ grantToken: "grant-token-from-human" })], dependencies);
  assert.equal(complete.code, 0);
  assert.equal((await command(["profile", "sync"], dependencies)).code, 0);
  assert.deepEqual(requests.map(({ path, body }) => ({ path, body })), [{
    path: "/api/v1/installations/enroll", body: {
      grantToken: "grant-token-from-human", installationId: "install_cli", hostKind: "codex", algorithm: "ES256",
      keyVersion: 1, publicJwk: provider.credential.publicJwk, keyThumbprint: provider.credential.keyThumbprint,
    },
  }, {
    path: "/api/v1/receiver/profile", body: {
      status: "active", publishedFields: { acceptedRewardTypes: ["credits"] }, cadenceMinutes: 30,
      termsVersion: "terms/v1", privacyVersion: "privacy/v1", hostDisclosure: { host: "Codex", consumesTurn: true },
    },
  }, { path: "/api/v1/receiver/profile", body: {} }]);
  assert.equal(requests[0].proof, null);
  assert.ok(requests[1].proof, "receiver profile publication must be signed by the enrolled device");
  assert.ok(requests[2].proof, "receiver profile sync must be signed by the enrolled device");
  assert.deepEqual((await new JsonLocalStore(configPath).get("install_cli"))?.deviceCredential, {
    credentialReference: provider.credential.credentialReference,
    keyThumbprint: provider.credential.keyThumbprint,
    algorithm: "ES256", keyVersion: 1, provider: "macos-keychain",
  });
});

async function command(args: string[], dependencies: CliDependencies) {
  let output = "";
  let error = "";
  const code = await runCli(args, { ...dependencies, stdout: (value) => { output += value; }, stderr: (value) => { error += value; } });
  if (code !== 0) return { code, error: JSON.parse(error) as Record<string, unknown>, result: {} as Record<string, unknown> };
  const parsed = JSON.parse(output) as { result: Record<string, unknown> };
  return { code, error: {}, result: parsed.result };
}

async function fakeMacProvider(): Promise<DeviceKeyProvider & { credential: DeviceCredential }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const thumbprintBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ crv: "P-256", kty: "EC", x: publicJwk.x, y: publicJwk.y })));
  const credential: DeviceCredential = {
    credentialReference: "keychain_ref_install_cli", publicJwk,
    keyThumbprint: Buffer.from(thumbprintBytes).toString("base64url"), algorithm: "ES256", keyVersion: 1,
    provider: "macos-keychain", productionCapable: true,
  };
  return {
    credential,
    async createOrLoad() { return credential; },
    async sign(_reference, payload) {
      const message = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
      return new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, message));
    },
    assertProductionEnrollment() {},
  };
}
