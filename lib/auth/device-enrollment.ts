import type { AuditEvent, HumanApproval } from "../domain/types.ts";
import { assertRecentHumanApproval } from "./authorize.ts";
import { deviceKeyThumbprint } from "./device-proof.ts";

interface EnrollmentGrant {
  grantId: string;
  accountId: string;
  installationId: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface DeviceInstallation {
  installationId: string;
  accountId: string;
  publicKey: string;
  keyVersion: number;
  status: "active" | "revoked";
  enrolledAt: string;
  revokedAt?: string;
}

export class DeviceEnrollmentService {
  readonly #grants = new Map<string, EnrollmentGrant>();
  readonly #pendingGrantByInstallationId = new Map<string, string>();
  readonly #devices = new Map<string, DeviceInstallation>();
  readonly #auditEvents: AuditEvent[] = [];

  get auditEvents(): readonly AuditEvent[] {
    return Object.freeze([...this.#auditEvents]);
  }

  issueGrant(input: {
    grantId: string;
    accountId: string;
    installationId: string;
    expiresAt: string;
    approval: HumanApproval;
    now?: Date;
  }): EnrollmentGrant {
    const now = input.now ?? new Date();
    assertRecentHumanApproval(input.approval, input.accountId, "device_enroll", now);
    if (this.#grants.has(input.grantId)) throw new Error("Enrollment grant already exists");
    if (this.#devices.has(input.installationId)) throw new Error("Installation already enrolled");
    const pendingGrantId = this.#pendingGrantByInstallationId.get(input.installationId);
    const pendingGrant = pendingGrantId ? this.#grants.get(pendingGrantId) : undefined;
    if (pendingGrant && !pendingGrant.consumedAt && Date.parse(pendingGrant.expiresAt) > now.getTime()) {
      throw new Error("Installation already has a pending enrollment grant");
    }
    if (Date.parse(input.expiresAt) <= now.getTime()) throw new Error("Enrollment grant must expire in the future");
    const grant = { grantId: input.grantId, accountId: input.accountId, installationId: input.installationId, expiresAt: input.expiresAt };
    this.#grants.set(input.grantId, grant);
    this.#pendingGrantByInstallationId.set(input.installationId, input.grantId);
    this.audit(input.accountId, "device.enrollment_grant_issued", input.installationId, now, { grantId: input.grantId });
    return Object.freeze({ ...grant });
  }

  consumeGrant(input: {
    grantId: string;
    accountId: string;
    installationId: string;
    publicKey: string;
    now?: Date;
  }): DeviceInstallation {
    const now = input.now ?? new Date();
    const grant = this.#grants.get(input.grantId);
    if (!grant) throw new Error("Unknown enrollment grant");
    if (grant.consumedAt) throw new Error("Enrollment grant already consumed");
    if (Date.parse(grant.expiresAt) <= now.getTime()) throw new Error("Enrollment grant expired");
    if (grant.accountId !== input.accountId || grant.installationId !== input.installationId) throw new Error("Enrollment grant scope mismatch");
    if (this.#devices.has(input.installationId)) throw new Error("Installation already enrolled");
    grant.consumedAt = now.toISOString();
    this.#pendingGrantByInstallationId.delete(input.installationId);
    const device: DeviceInstallation = {
      installationId: input.installationId,
      accountId: input.accountId,
      publicKey: input.publicKey,
      keyVersion: 1,
      status: "active",
      enrolledAt: now.toISOString(),
    };
    this.#devices.set(device.installationId, device);
    this.audit(device.accountId, "device.enrolled", device.installationId, now, { keyVersion: 1 });
    return Object.freeze({ ...device });
  }

  rotateKey(installationId: string, publicKey: string, approval: HumanApproval, now = new Date()): DeviceInstallation {
    const device = this.requireDevice(installationId);
    if (device.status === "revoked") throw new Error("Installation is revoked");
    assertRecentHumanApproval(approval, device.accountId, "device_rotate", now);
    device.publicKey = publicKey;
    device.keyVersion += 1;
    this.audit(device.accountId, "device.key_rotated", installationId, now, { keyVersion: device.keyVersion });
    return Object.freeze({ ...device });
  }

  revoke(installationId: string, approval: HumanApproval, now = new Date()): DeviceInstallation {
    const device = this.requireDevice(installationId);
    assertRecentHumanApproval(approval, device.accountId, "device_revoke", now);
    if (device.status === "revoked") return Object.freeze({ ...device });
    device.status = "revoked";
    device.revokedAt = now.toISOString();
    this.audit(device.accountId, "device.revoked", installationId, now, { keyVersion: device.keyVersion });
    return Object.freeze({ ...device });
  }

  assertCanOpenOpportunity(installationId: string): void {
    this.assertActive(installationId, "open an opportunity");
  }

  assertCanSubmitReceipt(installationId: string): void {
    this.assertActive(installationId, "submit a receipt");
  }

  canReadFinancialHistory(installationId: string, humanAccountId: string): boolean {
    return this.requireDevice(installationId).accountId === humanAccountId;
  }

  private assertActive(installationId: string, action: string): void {
    if (this.requireDevice(installationId).status !== "active") throw new Error(`revoked installation cannot ${action}`);
  }

  private requireDevice(installationId: string): DeviceInstallation {
    const device = this.#devices.get(installationId);
    if (!device) throw new Error("Unknown installation");
    return device;
  }

  private audit(accountId: string, action: string, resourceId: string, now: Date, metadata: Record<string, string | number>): void {
    this.#auditEvents.push(Object.freeze({
      eventId: crypto.randomUUID(),
      accountId,
      action,
      actorKind: "human",
      resourceId,
      occurredAt: now.toISOString(),
      metadata: Object.freeze({ ...metadata }),
    }));
  }
}

export interface DurableEnrollmentGrant {
  grantId: string;
  accountId: string;
  installationId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  consumedAt?: string;
}

export interface DurableDeviceInstallation {
  installationId: string;
  accountId: string;
  hostKind: string;
  algorithm: "ES256";
  publicJwk: JsonWebKey;
  keyThumbprint: string;
  keyVersion: number;
  status: "active" | "revoked";
  enrolledAt: string;
}

export interface DeviceEnrollmentRepository {
  findPendingGrant(installationId: string, now: string): Promise<DurableEnrollmentGrant | undefined>;
  createGrant(grant: DurableEnrollmentGrant): Promise<void>;
  findGrantByTokenHash(tokenHash: string): Promise<DurableEnrollmentGrant | undefined>;
  findInstallation(installationId: string): Promise<DurableDeviceInstallation | undefined>;
  consumeGrantAndEnroll(input: {
    grant: DurableEnrollmentGrant;
    installation: DurableDeviceInstallation;
    consumedAt: string;
  }): Promise<DurableDeviceInstallation>;
}

export class MemoryDeviceEnrollmentRepository implements DeviceEnrollmentRepository {
  readonly #grants = new Map<string, DurableEnrollmentGrant>();
  readonly #installations = new Map<string, DurableDeviceInstallation>();

  get debugGrants(): readonly DurableEnrollmentGrant[] {
    return Object.freeze([...this.#grants.values()].map((value) => structuredClone(value)));
  }

  get debugInstallations(): readonly DurableDeviceInstallation[] {
    return Object.freeze([...this.#installations.values()].map((value) => structuredClone(value)));
  }

  async findPendingGrant(installationId: string, now: string): Promise<DurableEnrollmentGrant | undefined> {
    const grant = [...this.#grants.values()].find((candidate) =>
      candidate.installationId === installationId && !candidate.consumedAt && Date.parse(candidate.expiresAt) > Date.parse(now));
    return grant ? structuredClone(grant) : undefined;
  }

  async createGrant(grant: DurableEnrollmentGrant): Promise<void> {
    if (this.#grants.has(grant.tokenHash)) throw new Error("Enrollment grant already exists");
    this.#grants.set(grant.tokenHash, structuredClone(grant));
  }

  async findGrantByTokenHash(tokenHash: string): Promise<DurableEnrollmentGrant | undefined> {
    const grant = this.#grants.get(tokenHash);
    return grant ? structuredClone(grant) : undefined;
  }

  async findInstallation(installationId: string): Promise<DurableDeviceInstallation | undefined> {
    const installation = this.#installations.get(installationId);
    return installation ? structuredClone(installation) : undefined;
  }

  async consumeGrantAndEnroll(input: {
    grant: DurableEnrollmentGrant;
    installation: DurableDeviceInstallation;
    consumedAt: string;
  }): Promise<DurableDeviceInstallation> {
    const current = this.#grants.get(input.grant.tokenHash);
    if (!current || current.grantId !== input.grant.grantId) throw new Error("Unknown enrollment grant");
    if (current.consumedAt) throw new Error("Enrollment grant already consumed");
    if (Date.parse(current.expiresAt) <= Date.parse(input.consumedAt)) throw new Error("Enrollment grant expired");
    if (this.#installations.has(input.installation.installationId)) throw new Error("Installation already enrolled");
    current.consumedAt = input.consumedAt;
    this.#installations.set(input.installation.installationId, structuredClone(input.installation));
    return structuredClone(input.installation);
  }
}

export class D1DeviceEnrollmentRepository implements DeviceEnrollmentRepository {
  readonly #db: D1Database;

  constructor(db: D1Database) { this.#db = db; }

  async findPendingGrant(installationId: string, now: string): Promise<DurableEnrollmentGrant | undefined> {
    const row = await this.#db.prepare(`SELECT id AS grantId, account_id AS accountId, installation_id AS installationId,
      token_hash AS tokenHash, expires_at AS expiresAt, created_at AS createdAt, consumed_at AS consumedAt
      FROM device_enrollment_grants WHERE installation_id = ? AND consumed_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`).bind(installationId, now).first<Record<string, unknown>>();
    return row ? grantFromRow(row) : undefined;
  }

  async createGrant(grant: DurableEnrollmentGrant): Promise<void> {
    await this.#db.prepare(`INSERT INTO device_enrollment_grants
      (id, account_id, installation_id, token_hash, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)`).bind(
      grant.grantId, grant.accountId, grant.installationId, grant.tokenHash, grant.expiresAt, grant.createdAt,
    ).run();
  }

  async findGrantByTokenHash(tokenHash: string): Promise<DurableEnrollmentGrant | undefined> {
    const row = await this.#db.prepare(`SELECT id AS grantId, account_id AS accountId, installation_id AS installationId,
      token_hash AS tokenHash, expires_at AS expiresAt, created_at AS createdAt, consumed_at AS consumedAt
      FROM device_enrollment_grants WHERE token_hash = ?`).bind(tokenHash).first<Record<string, unknown>>();
    return row ? grantFromRow(row) : undefined;
  }

  async findInstallation(installationId: string): Promise<DurableDeviceInstallation | undefined> {
    const row = await this.#db.prepare(`SELECT i.id AS installationId, i.account_id AS accountId, i.host_kind AS hostKind,
      i.status, i.created_at AS enrolledAt, k.algorithm, k.public_jwk_json AS publicJwkJson,
      k.key_thumbprint AS keyThumbprint, k.key_version AS keyVersion
      FROM installations i JOIN installation_device_keys k ON k.installation_id = i.id AND k.key_version = i.key_version
      WHERE i.id = ?`).bind(installationId).first<Record<string, unknown>>();
    return row ? installationFromRow(row) : undefined;
  }

  async consumeGrantAndEnroll(input: {
    grant: DurableEnrollmentGrant;
    installation: DurableDeviceInstallation;
    consumedAt: string;
  }): Promise<DurableDeviceInstallation> {
    const publicJwkJson = JSON.stringify(input.installation.publicJwk);
    try {
      const results = await this.#db.batch([
        this.#db.prepare(`UPDATE device_enrollment_grants SET consumed_at = ?
          WHERE id = ? AND token_hash = ? AND account_id = ? AND installation_id = ?
          AND consumed_at IS NULL AND expires_at > ?`).bind(
          input.consumedAt, input.grant.grantId, input.grant.tokenHash, input.grant.accountId,
          input.grant.installationId, input.consumedAt,
        ),
        this.#db.prepare(`INSERT INTO installations
          (id, account_id, public_key, key_version, host_kind, status, created_at)
          SELECT ?, ?, ?, ?, ?, 'active', ? FROM device_enrollment_grants
          WHERE id = ? AND token_hash = ? AND consumed_at = ?`).bind(
          input.installation.installationId, input.installation.accountId, publicJwkJson,
          input.installation.keyVersion, input.installation.hostKind, input.installation.enrolledAt,
          input.grant.grantId, input.grant.tokenHash, input.consumedAt,
        ),
        this.#db.prepare(`INSERT INTO installation_device_keys
          (installation_id, key_version, algorithm, public_jwk_json, key_thumbprint, status, enrolled_at)
          SELECT ?, ?, 'ES256', ?, ?, 'active', ? FROM installations WHERE id = ?`).bind(
          input.installation.installationId, input.installation.keyVersion, publicJwkJson,
          input.installation.keyThumbprint, input.installation.enrolledAt,
          input.installation.installationId,
        ),
        this.#db.prepare(`INSERT INTO audit_events
          (id, account_id, actor_kind, actor_id, action, resource_kind, resource_id, metadata_json, occurred_at)
          SELECT ?, ?, 'installation', ?, 'device.enrolled', 'installation', ?, ?, ?
          FROM installation_device_keys
          WHERE installation_id = ? AND key_version = ? AND key_thumbprint = ?`).bind(
          crypto.randomUUID(), input.installation.accountId, input.installation.installationId,
          input.installation.installationId,
          JSON.stringify({ algorithm: "ES256", keyVersion: input.installation.keyVersion, keyThumbprint: input.installation.keyThumbprint }),
          input.installation.enrolledAt,
          input.installation.installationId, input.installation.keyVersion, input.installation.keyThumbprint,
        ),
      ]);
      if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1 || results[3]?.meta.changes !== 1) {
        throw new Error("Enrollment transaction did not mutate every required row");
      }
    } catch {
      throw new Error("Durable device enrollment failed atomically");
    }
    return structuredClone(input.installation);
  }
}

export class DurableDeviceEnrollmentService {
  readonly #repository: DeviceEnrollmentRepository;
  readonly #grantTtlMs: number;
  readonly #randomBytes: () => Uint8Array;

  constructor(repository: DeviceEnrollmentRepository, input: { grantTtlMs?: number; randomBytes?: () => Uint8Array } = {}) {
    this.#repository = repository;
    this.#grantTtlMs = input.grantTtlMs ?? 5 * 60_000;
    this.#randomBytes = input.randomBytes ?? (() => crypto.getRandomValues(new Uint8Array(32)));
    if (!Number.isSafeInteger(this.#grantTtlMs) || this.#grantTtlMs < 30_000 || this.#grantTtlMs > 10 * 60_000) {
      throw new Error("Enrollment grant TTL must be between 30 seconds and 10 minutes");
    }
  }

  async issueGrant(input: { accountId: string; installationId: string; keyThumbprint: string; approval: HumanApproval; now?: Date }) {
    const now = input.now ?? new Date();
    boundedId(input.accountId, "account ID");
    boundedId(input.installationId, "installation ID");
    assertThumbprint(input.keyThumbprint);
    assertRecentHumanApproval(input.approval, input.accountId, "device_enroll", now);
    if (await this.#repository.findInstallation(input.installationId)) throw new Error("Installation already enrolled");
    if (await this.#repository.findPendingGrant(input.installationId, now.toISOString())) {
      throw new Error("Installation already has a pending enrollment grant");
    }
    const grantToken = encodeBase64Url(this.#randomBytes());
    if (grantToken.length < 43) throw new Error("Enrollment token entropy is insufficient");
    const grant: DurableEnrollmentGrant = Object.freeze({
      grantId: crypto.randomUUID(),
      accountId: input.accountId,
      installationId: input.installationId,
      tokenHash: await boundTokenHash(grantToken, input.keyThumbprint),
      expiresAt: new Date(now.getTime() + this.#grantTtlMs).toISOString(),
      createdAt: now.toISOString(),
    });
    await this.#repository.createGrant(grant);
    return Object.freeze({ grantToken, grantId: grant.grantId, expiresAt: grant.expiresAt });
  }

  async enroll(input: {
    grantToken: string;
    installationId: string;
    hostKind: string;
    algorithm: string;
    keyVersion: number;
    publicJwk: JsonWebKey;
    keyThumbprint: string;
    now?: Date;
  }): Promise<DurableDeviceInstallation> {
    const now = input.now ?? new Date();
    boundedToken(input.grantToken);
    boundedId(input.installationId, "installation ID");
    boundedHostKind(input.hostKind);
    if (input.algorithm !== "ES256") throw new Error("Production device enrollment requires ES256");
    if (input.keyVersion !== 1) throw new Error("Initial device key version must be 1");
    assertPublicJwk(input.publicJwk);
    await assertImportablePublicJwk(input.publicJwk);
    assertThumbprint(input.keyThumbprint);
    const calculatedThumbprint = await deviceKeyThumbprint(input.publicJwk);
    if (calculatedThumbprint !== input.keyThumbprint) throw new Error("Device public key thumbprint mismatch");
    const tokenHash = await boundTokenHash(input.grantToken, input.keyThumbprint);
    const grant = await this.#repository.findGrantByTokenHash(tokenHash);
    if (!grant) throw new Error("Unknown enrollment grant or key scope mismatch");
    if (grant.installationId !== input.installationId) throw new Error("Enrollment grant installation scope mismatch");
    if (grant.consumedAt) throw new Error("Enrollment grant already consumed");
    if (Date.parse(grant.expiresAt) <= now.getTime()) throw new Error("Enrollment grant expired");
    if (await this.#repository.findInstallation(input.installationId)) throw new Error("Installation already enrolled");
    const installation: DurableDeviceInstallation = Object.freeze({
      installationId: input.installationId,
      accountId: grant.accountId,
      hostKind: input.hostKind,
      algorithm: "ES256",
      publicJwk: Object.freeze({ kty: "EC", crv: "P-256", x: input.publicJwk.x, y: input.publicJwk.y }),
      keyThumbprint: input.keyThumbprint,
      keyVersion: 1,
      status: "active",
      enrolledAt: now.toISOString(),
    });
    return this.#repository.consumeGrantAndEnroll({ grant, installation, consumedAt: now.toISOString() });
  }
}

function grantFromRow(row: Record<string, unknown>): DurableEnrollmentGrant {
  return {
    grantId: requiredString(row.grantId), accountId: requiredString(row.accountId),
    installationId: requiredString(row.installationId), tokenHash: requiredString(row.tokenHash),
    expiresAt: requiredString(row.expiresAt), createdAt: requiredString(row.createdAt),
    ...(typeof row.consumedAt === "string" ? { consumedAt: row.consumedAt } : {}),
  };
}

function installationFromRow(row: Record<string, unknown>): DurableDeviceInstallation {
  const algorithm = requiredString(row.algorithm);
  if (algorithm !== "ES256") throw new Error("Durable device algorithm is invalid");
  return {
    installationId: requiredString(row.installationId), accountId: requiredString(row.accountId),
    hostKind: requiredString(row.hostKind), algorithm, publicJwk: JSON.parse(requiredString(row.publicJwkJson)) as JsonWebKey,
    keyThumbprint: requiredString(row.keyThumbprint), keyVersion: requiredInteger(row.keyVersion),
    status: requiredString(row.status) as DurableDeviceInstallation["status"], enrolledAt: requiredString(row.enrolledAt),
  };
}

async function boundTokenHash(token: string, keyThumbprint: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${token}\u0000${keyThumbprint}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function boundedToken(value: string): void {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) throw new Error("Enrollment grant token is invalid");
}

function boundedId(value: string, name: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error(`${name} is invalid`);
}

function boundedHostKind(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new Error("Host kind is invalid");
}

function assertThumbprint(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Device key thumbprint is invalid");
}

function assertPublicJwk(jwk: JsonWebKey): void {
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x) ||
    typeof jwk.y !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(jwk.y) || jwk.d !== undefined) {
    throw new Error("Device key must be an EC P-256 public JWK without private material");
  }
}

async function assertImportablePublicJwk(jwk: JsonWebKey): Promise<void> {
  try {
    await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    throw new Error("Device key must contain valid P-256 public coordinates");
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Durable enrollment row is malformed");
  return value;
}

function requiredInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Durable enrollment row is malformed");
  return value;
}
