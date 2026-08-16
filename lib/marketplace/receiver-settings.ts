import type { LocalInstallationConfig, LocalStore } from "@ad-daddy/cli";

type Row = Record<string, unknown>;
export type ReceiverSettingsAuthority = "human_session" | "device";

/** Durable receiver consent shared by the human settings surface and receiver pull runtime. */
export class D1ReceiverSettingsStore implements LocalStore {
  readonly #db: D1Database;
  readonly #authority: ReceiverSettingsAuthority;

  constructor(db: D1Database, input: { authority?: ReceiverSettingsAuthority } = {}) {
    this.#db = db;
    this.#authority = input.authority ?? "device";
  }

  async installationForAccount(accountId: string): Promise<string | undefined> {
    const row = await this.#db.prepare(`SELECT id FROM installations
      WHERE account_id = ? AND status = 'active' ORDER BY created_at DESC, id LIMIT 1`)
      .bind(accountId).first<{ id: string }>();
    return row?.id;
  }

  async get(installationId: string): Promise<LocalInstallationConfig | undefined> {
    const row = await this.#db.prepare(`SELECT config_json AS configJson FROM receiver_profiles WHERE installation_id = ?`)
      .bind(installationId).first<Row>();
    return row ? configFromJson(row.configJson) : undefined;
  }

  async list(): Promise<readonly LocalInstallationConfig[]> {
    const rows = await this.#db.prepare("SELECT config_json AS configJson FROM receiver_profiles ORDER BY updated_at, id").all<Row>();
    return Object.freeze((rows.results ?? []).map((row) => configFromJson(row.configJson)));
  }

  async put(config: LocalInstallationConfig): Promise<void> {
    assertConfig(config);
    const installation = await this.#db.prepare("SELECT account_id AS accountId FROM installations WHERE id = ?")
      .bind(config.installationId).first<Row>();
    if (!installation || installation.accountId !== config.accountId) throw new Error("Installation belongs to another account or is not enrolled");
    const profileId = `receiver:${config.installationId}`;
    const existing = await this.#db.prepare(`SELECT current_consent_version AS consentVersion, status
      FROM receiver_profiles WHERE installation_id = ?`).bind(config.installationId).first<Row>();
    const currentVersion = existing ? integer(existing.consentVersion) : 0;
    const currentStatus = existing?.status as LocalInstallationConfig["status"] | undefined;
    const now = new Date().toISOString();
    if (config.consentVersion < 1) throw new Error("Receiver consent version is invalid");
    if (config.status === "draft" && config.consentVersion !== currentVersion + 1) {
      throw new Error("Receiver draft must target exactly the next consent version");
    }
    if (config.status !== "draft" && config.consentVersion < currentVersion) throw new Error("Receiver consent cannot move backwards");
    if (config.status !== "draft" && config.consentVersion > currentVersion && config.consentVersion !== currentVersion + 1) {
      throw new Error("Receiver consent must advance exactly one version");
    }
    if (config.status === "active" && ["paused", "revoked"].includes(currentStatus ?? "") && this.#authority !== "human_session") {
      throw new Error("Fresh human authority is required to reactivate receiver consent");
    }

    const profileVersion = config.status === "draft" ? currentVersion : config.consentVersion;
    const profileStatus = config.status === "draft" && currentVersion > 0 ? currentStatus! : config.status;
    const statements = [
      this.#db.prepare(`INSERT INTO receiver_profiles
        (id, account_id, installation_id, status, current_consent_version, config_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(installation_id) DO UPDATE SET status = excluded.status,
          current_consent_version = excluded.current_consent_version, config_json = excluded.config_json, updated_at = excluded.updated_at
        WHERE receiver_profiles.account_id = excluded.account_id`)
        .bind(profileId, config.accountId, config.installationId, profileStatus, profileVersion, JSON.stringify(config), now),
    ];
    if (config.status !== "draft" && config.consentVersion > currentVersion) {
      statements.push(this.#db.prepare(`INSERT INTO receiver_consent_versions
        (receiver_profile_id, version, previous_version, status, terms_version, privacy_version, consented_fields_json, accepted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(profileId, config.consentVersion, currentVersion || null, config.status, config.termsVersion, config.privacyVersion,
          JSON.stringify(Object.keys(config.publishedFields).sort()), now));
    } else if (config.status !== "draft" && config.consentVersion === currentVersion) {
      const durable = await this.#db.prepare(`SELECT status, terms_version AS termsVersion,
        privacy_version AS privacyVersion, consented_fields_json AS consentedFieldsJson
        FROM receiver_consent_versions
        WHERE receiver_profile_id = ? AND version = ?`).bind(profileId, currentVersion).first<Row>();
      const consentedFields = JSON.stringify(Object.keys(config.publishedFields).sort());
      if (!durable || durable.status !== config.status || durable.termsVersion !== config.termsVersion ||
        durable.privacyVersion !== config.privacyVersion || stableJson(durable.consentedFieldsJson) !== stableJson(consentedFields)) {
        throw new Error("Immutable receiver consent payload mismatch");
      }
      if (config.status === "active") {
        const snapshot = await this.#db.prepare(`SELECT published_fields_json AS publishedFieldsJson
          FROM profile_snapshots WHERE receiver_profile_id = ? AND consent_version = ?`)
          .bind(profileId, currentVersion).first<Row>();
        if (!snapshot || stableJson(snapshot.publishedFieldsJson) !== stableJson(JSON.stringify(config.publishedFields))) {
          throw new Error("Immutable receiver profile snapshot mismatch");
        }
      }
    }
    if (config.status !== "draft" && config.consentVersion > currentVersion) {
      statements.push(this.#db.prepare(`UPDATE profile_snapshots SET revoked_at = COALESCE(revoked_at, ?)
        WHERE receiver_profile_id = ? AND revoked_at IS NULL`).bind(now, profileId));
    }
    if (config.status === "active" && config.consentVersion > currentVersion) {
      statements.push(this.#db.prepare(`INSERT INTO profile_snapshots
        (id, receiver_profile_id, consent_version, published_fields_json, published_at, expires_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
        `)
        .bind(`snapshot:${profileId}:${config.consentVersion}`, profileId, config.consentVersion,
          JSON.stringify(config.publishedFields), now, new Date(Date.parse(now) + 30 * 86_400_000).toISOString()));
    }
    await this.#db.batch(statements);
  }

  async markCheckedIfCurrent(installationId: string, consentVersion: number, checkedAt: string): Promise<boolean> {
    const config = await this.get(installationId);
    if (!config || config.status !== "active" || config.consentVersion !== consentVersion) return false;
    const result = await this.#db.prepare(`UPDATE receiver_profiles SET config_json = ?, updated_at = ?
      WHERE installation_id = ? AND current_consent_version = ? AND status = 'active'`)
      .bind(JSON.stringify({ ...config, lastCheckedAt: checkedAt }), checkedAt, installationId, consentVersion).run();
    return (result.meta.changes ?? 0) === 1;
  }
}

function configFromJson(value: unknown): LocalInstallationConfig {
  if (typeof value !== "string") throw new Error("Durable receiver configuration is malformed");
  const parsed: unknown = JSON.parse(value);
  assertConfig(parsed);
  return structuredClone(parsed);
}

function assertConfig(value: unknown): asserts value is LocalInstallationConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Durable receiver configuration is malformed");
  const config = value as Partial<LocalInstallationConfig>;
  if (typeof config.installationId !== "string" || !config.installationId || typeof config.accountId !== "string" || !config.accountId ||
    !["receiver", "advertiser", "both"].includes(config.role ?? "") || !["draft", "active", "paused", "revoked"].includes(config.status ?? "") ||
    !Number.isSafeInteger(config.consentVersion) || (config.consentVersion ?? 0) < 1 || !config.profile || !config.publishedFields ||
    typeof config.termsVersion !== "string" || typeof config.privacyVersion !== "string" || !config.hostDisclosure) {
    throw new Error("Durable receiver configuration is malformed");
  }
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Durable receiver version is malformed");
  return value;
}

function stableJson(value: unknown): string {
  if (typeof value !== "string") throw new Error("Durable receiver consent JSON is malformed");
  return canonicalJson(JSON.parse(value));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
