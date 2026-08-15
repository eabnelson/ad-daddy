import { createHash, verify, type KeyObject } from "node:crypto";

export function verifyInstallArtifact(artifact: {
  artifact: Uint8Array;
  sourceUrl: string;
  version: string;
  checksum: string;
  signature: string;
}, pinned: {
  origin: string;
  version: string;
  checksum: string;
  publicKey: KeyObject | string;
}): void {
  const url = new URL(artifact.sourceUrl);
  if (url.origin !== pinned.origin || url.protocol !== "https:") throw new Error("Install artifact origin does not match the pinned HTTPS origin");
  if (artifact.version !== pinned.version) throw new Error("Install artifact version does not match the pinned version");
  const actualChecksum = createHash("sha256").update(artifact.artifact).digest("hex");
  if (artifact.checksum !== pinned.checksum || actualChecksum !== pinned.checksum) throw new Error("Install artifact checksum does not match");
  let valid = false;
  try { valid = verify(null, artifact.artifact, pinned.publicKey, Buffer.from(artifact.signature, "base64")); } catch { valid = false; }
  if (!valid) throw new Error("Install artifact signature does not match");
}

export async function runVerifiedInstall(input: {
  artifact: Parameters<typeof verifyInstallArtifact>[0];
  pinned: Parameters<typeof verifyInstallArtifact>[1];
  enroll: () => Promise<void>;
  installScheduler: () => Promise<void>;
}): Promise<void> {
  verifyInstallArtifact(input.artifact, input.pinned);
  await input.enroll();
  await input.installScheduler();
}
