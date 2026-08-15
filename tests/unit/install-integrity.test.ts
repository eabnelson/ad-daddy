import assert from "node:assert/strict";
import test from "node:test";

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { runVerifiedInstall, verifyInstallArtifact } from "../../packages/cli/dist/install-integrity.js";

test("accepts a pinned artifact only when origin, version, checksum, and signature match", () => {
  const artifact = Buffer.from("portable Ad Daddy skill v0.1.0");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const checksum = createHash("sha256").update(artifact).digest("hex");
  const signature = sign(null, artifact, privateKey).toString("base64");
  assert.doesNotThrow(() => verifyInstallArtifact({ artifact, sourceUrl: "https://ad-daddy.example/releases/skill-0.1.0.tgz", version: "0.1.0", checksum, signature }, {
    origin: "https://ad-daddy.example",
    version: "0.1.0",
    checksum,
    publicKey,
  }));
});

test("integrity failure occurs before any enrollment or scheduler mutation", () => {
  const artifact = Buffer.from("tampered");
  const { publicKey } = generateKeyPairSync("ed25519");
  assert.throws(() => verifyInstallArtifact({ artifact, sourceUrl: "https://evil.example/skill.tgz", version: "latest", checksum: "00", signature: "bad" }, {
    origin: "https://ad-daddy.example",
    version: "0.1.0",
    checksum: "00",
    publicKey,
  }), /origin/i);
});

test("rejects version, checksum, and signature mismatches independently", () => {
  const artifact = Buffer.from("portable Ad Daddy skill v0.1.0");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const checksum = createHash("sha256").update(artifact).digest("hex");
  const signature = sign(null, artifact, privateKey).toString("base64");
  const pinned = { origin: "https://ad-daddy.example", version: "0.1.0", checksum, publicKey };
  const good = { artifact, sourceUrl: "https://ad-daddy.example/releases/skill.tgz", version: "0.1.0", checksum, signature };
  assert.throws(() => verifyInstallArtifact({ ...good, version: "0.2.0" }, pinned), /version/i);
  assert.throws(() => verifyInstallArtifact({ ...good, checksum: "00" }, pinned), /checksum/i);
  assert.throws(() => verifyInstallArtifact({ ...good, signature: "AAAA" }, pinned), /signature/i);
});

test("verified install gates enrollment and scheduler mutation", async () => {
  const artifact = Buffer.from("tampered");
  const { publicKey } = generateKeyPairSync("ed25519");
  const effects: string[] = [];
  await assert.rejects(runVerifiedInstall({
    artifact: { artifact, sourceUrl: "https://evil.example/skill.tgz", version: "0.1.0", checksum: "00", signature: "bad" },
    pinned: { origin: "https://ad-daddy.example", version: "0.1.0", checksum: "00", publicKey },
    enroll: async () => { effects.push("enroll"); },
    installScheduler: async () => { effects.push("scheduler"); },
  }), /origin/i);
  assert.deepEqual(effects, []);
});
