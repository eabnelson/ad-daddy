import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ReceiverFieldSelection, ReceiverFieldValues } from "./commands/profile.js";

export type SetupRole = "receiver" | "advertiser" | "both";

export interface LocalInstallationConfig {
  installationId: string;
  accountId: string;
  role: SetupRole;
  profile: { values: ReceiverFieldValues; enabled: ReceiverFieldSelection };
  publishedFields: ReceiverFieldValues;
  cadenceMinutes: number;
  termsVersion: string;
  privacyVersion: string;
  consentVersion: number;
  status: "draft" | "active" | "paused" | "revoked";
  payoutAddress?: string;
  pendingPayoutAddress?: string;
  hostDisclosure: { host: string; displayModel?: string; consumesTurn: true };
  deviceCredential?: {
    credentialReference: string;
    keyThumbprint: string;
    algorithm: "ES256";
    keyVersion: number;
    provider: "macos-keychain";
  };
  lastCheckedAt?: string;
}

export interface LocalStore {
  get(installationId: string): Promise<LocalInstallationConfig | undefined>;
  put(config: LocalInstallationConfig): Promise<void>;
  list(): Promise<readonly LocalInstallationConfig[]>;
}

export class MemoryLocalStore implements LocalStore {
  readonly #records = new Map<string, LocalInstallationConfig>();
  async get(id: string) { const value = this.#records.get(id); return value ? structuredClone(value) : undefined; }
  async put(config: LocalInstallationConfig) { this.#records.set(config.installationId, structuredClone(config)); }
  async list() { return [...this.#records.values()].map((value) => structuredClone(value)); }
}

export class JsonLocalStore implements LocalStore {
  readonly #path: string;
  #writeTail: Promise<void> = Promise.resolve();
  constructor(path: string) { this.#path = path; }
  async get(id: string) { await this.#writeTail; return (await this.readRaw()).find((value) => value.installationId === id); }
  async list() { await this.#writeTail; return this.readRaw(); }
  async put(config: LocalInstallationConfig) {
    assertLocalConfig(config);
    const operation = this.#writeTail.then(async () => {
      const records = await this.readRaw();
      const index = records.findIndex((value) => value.installationId === config.installationId);
      if (index === -1) records.push(structuredClone(config)); else records[index] = structuredClone(config);
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.#path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.#path);
    });
    this.#writeTail = operation.then(() => undefined, () => undefined);
    await operation;
  }
  private async readRaw(): Promise<LocalInstallationConfig[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Local configuration must be an array");
      for (const config of parsed) assertLocalConfig(config);
      return parsed as LocalInstallationConfig[];
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

function assertLocalConfig(input: unknown): asserts input is LocalInstallationConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Malformed local installation record");
  const value = input as Partial<LocalInstallationConfig>;
  if (typeof value.installationId !== "string" || !value.installationId || typeof value.accountId !== "string" || !value.accountId || !["receiver", "advertiser", "both"].includes(value.role ?? "") || !["draft", "active", "paused", "revoked"].includes(value.status ?? "") || !Number.isSafeInteger(value.consentVersion) || (value.consentVersion ?? 0) < 1 || !value.profile || !value.publishedFields) {
    throw new Error("Malformed local installation record");
  }
  if (value.deviceCredential && (
    typeof value.deviceCredential.credentialReference !== "string" || !/^[A-Za-z0-9_-]{8,512}$/.test(value.deviceCredential.credentialReference) ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.deviceCredential.keyThumbprint) ||
    value.deviceCredential.algorithm !== "ES256" || !Number.isSafeInteger(value.deviceCredential.keyVersion) ||
    value.deviceCredential.keyVersion < 1 || value.deviceCredential.provider !== "macos-keychain"
  )) throw new Error("Malformed local device credential reference");
}
