import {
  canonicalDeviceProofEnvelope,
  normalizeDeviceProofTarget,
  sha256DeviceProofBody,
  type DeviceProofEnvelope,
} from "@ad-daddy/host-adapters";

import type { Environment } from "../domain/types.ts";

const ENVELOPE_KEYS = [
  "method",
  "target",
  "audience",
  "bodyDigest",
  "installationId",
  "consentVersion",
  "keyThumbprint",
  "nonce",
  "issuedAt",
  "expiresAt",
] as const;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_MAX_PROOF_LIFETIME_MS = 5 * 60 * 1_000;
const CLOCK_SKEW_MS = 30_000;

export type { DeviceProofEnvelope } from "@ad-daddy/host-adapters";

export interface SignedDeviceProof {
  envelope: DeviceProofEnvelope;
  signature: string;
}

export interface EnrolledDeviceKey {
  installationId: string;
  accountId: string;
  keyVersion: number;
  publicJwk: JsonWebKey;
  thumbprint: string;
  algorithm: string;
  status: "active" | "revoked" | "retired";
}

export interface DeviceNonceUse {
  installationId: string;
  nonce: string;
  canonicalRequestSha256: string;
  firstUsedAt: string;
  expiresAt: string;
}

export type ConsumeNonceResult =
  | { status: "new"; use: DeviceNonceUse }
  | { status: "identical_replay"; use: DeviceNonceUse }
  | { status: "conflict"; use: DeviceNonceUse };

export interface DeviceProofRepository {
  findDeviceKey(installationId: string, thumbprint: string): Promise<EnrolledDeviceKey | undefined>;
  consumeNonce(input: DeviceNonceUse & { accountId: string }): Promise<ConsumeNonceResult>;
}

export interface MemoryDeviceProofStore {
  nonces: Map<string, DeviceNonceUse>;
  auditEvents: Array<{ action: string; installationId: string; nonce: string; occurredAt: string }>;
}

export class DeviceProofError extends Error {
  constructor(message: string) {
    super(`Device proof ${message}`);
    this.name = "DeviceProofError";
  }
}

export class MemoryDeviceProofRepository implements DeviceProofRepository {
  readonly #keys = new Map<string, EnrolledDeviceKey>();
  readonly #store: MemoryDeviceProofStore;

  constructor(input: {
    keys?: readonly EnrolledDeviceKey[];
    store?: Map<unknown, unknown> | MemoryDeviceProofStore;
  } = {}) {
    this.#store = isMemoryStore(input.store)
      ? input.store
      : {
          nonces: (input.store as Map<string, DeviceNonceUse> | undefined) ?? new Map(),
          auditEvents: [],
        };
    for (const key of input.keys ?? []) this.#keys.set(deviceKeyId(key.installationId, key.thumbprint), structuredClone(key));
  }

  get auditEvents(): readonly MemoryDeviceProofStore["auditEvents"][number][] {
    return Object.freeze(this.#store.auditEvents.map((event) => Object.freeze({ ...event })));
  }

  async findDeviceKey(installationId: string, thumbprint: string): Promise<EnrolledDeviceKey | undefined> {
    const key = this.#keys.get(deviceKeyId(installationId, thumbprint));
    return key ? structuredClone(key) : undefined;
  }

  async consumeNonce(input: DeviceNonceUse & { accountId: string }): Promise<ConsumeNonceResult> {
    const id = nonceId(input.installationId, input.nonce);
    const existing = this.#store.nonces.get(id);
    if (!existing) {
      const use = nonceUse(input);
      this.#store.nonces.set(id, use);
      return { status: "new", use: structuredClone(use) };
    }
    if (existing.canonicalRequestSha256 === input.canonicalRequestSha256) {
      return { status: "identical_replay", use: structuredClone(existing) };
    }
    this.#store.auditEvents.push({
      action: "device_proof.nonce_conflict",
      installationId: input.installationId,
      nonce: input.nonce,
      occurredAt: input.firstUsedAt,
    });
    return { status: "conflict", use: structuredClone(existing) };
  }
}

export class D1DeviceProofRepository implements DeviceProofRepository {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async findDeviceKey(installationId: string, thumbprint: string): Promise<EnrolledDeviceKey | undefined> {
    const row = await this.#db.prepare(`SELECT k.installation_id AS installationId, i.account_id AS accountId,
      k.key_version AS keyVersion, k.public_jwk_json AS publicJwkJson, k.key_thumbprint AS thumbprint,
      k.algorithm, k.status FROM installation_device_keys k JOIN installations i ON i.id = k.installation_id
      WHERE k.installation_id = ? AND k.key_thumbprint = ? AND i.status = 'active'`)
      .bind(installationId, thumbprint)
      .first<Record<string, unknown>>();
    if (!row) return undefined;
    return {
      installationId: requiredString(row.installationId),
      accountId: requiredString(row.accountId),
      keyVersion: requiredInteger(row.keyVersion),
      publicJwk: JSON.parse(requiredString(row.publicJwkJson)) as JsonWebKey,
      thumbprint: requiredString(row.thumbprint),
      algorithm: requiredString(row.algorithm),
      status: requiredString(row.status) as EnrolledDeviceKey["status"],
    };
  }

  async consumeNonce(input: DeviceNonceUse & { accountId: string }): Promise<ConsumeNonceResult> {
    const result = await this.#db.prepare(`INSERT OR IGNORE INTO device_proof_nonces
      (installation_id, nonce, canonical_request_sha256, first_used_at, expires_at)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(input.installationId, input.nonce, input.canonicalRequestSha256, input.firstUsedAt, input.expiresAt)
      .run();
    const existing = await this.#db.prepare(`SELECT installation_id AS installationId, nonce,
      canonical_request_sha256 AS canonicalRequestSha256, first_used_at AS firstUsedAt, expires_at AS expiresAt
      FROM device_proof_nonces WHERE installation_id = ? AND nonce = ?`)
      .bind(input.installationId, input.nonce)
      .first<Record<string, unknown>>();
    if (!existing) throw new DeviceProofError("nonce persistence failed");
    const use: DeviceNonceUse = {
      installationId: requiredString(existing.installationId),
      nonce: requiredString(existing.nonce),
      canonicalRequestSha256: requiredString(existing.canonicalRequestSha256),
      firstUsedAt: requiredString(existing.firstUsedAt),
      expiresAt: requiredString(existing.expiresAt),
    };
    if (result.meta.changes === 1) return { status: "new", use };
    if (use.canonicalRequestSha256 === input.canonicalRequestSha256) {
      return { status: "identical_replay", use };
    }
    await this.#db.prepare(`INSERT INTO audit_events
      (id, account_id, actor_kind, actor_id, action, resource_kind, resource_id, metadata_json, occurred_at)
      VALUES (?, ?, 'installation', ?, 'device_proof.nonce_conflict', 'device_nonce', ?, ?, ?)`)
      .bind(
        crypto.randomUUID(),
        input.accountId,
        input.installationId,
        input.nonce,
        JSON.stringify({ canonicalRequestSha256: input.canonicalRequestSha256 }),
        input.firstUsedAt,
      )
      .run();
    return { status: "conflict", use };
  }
}

export async function verifyDeviceProof(input: {
  proof: SignedDeviceProof;
  expected: {
    method: string;
    target: string;
    environment: Environment;
    bodyDigest: string;
  };
  repository: DeviceProofRepository;
  now?: Date;
  maxProofLifetimeMs?: number;
}): Promise<{ key: EnrolledDeviceKey; replay: boolean; canonicalRequestSha256: string }> {
  const now = input.now ?? new Date();
  const envelope = validateEnvelope(input.proof.envelope);
  const normalizedExpectedTarget = normalizeRequestTarget(input.expected.target);
  if (envelope.method !== input.expected.method.toUpperCase()) throw new DeviceProofError("method mismatch");
  if (envelope.target !== normalizedExpectedTarget) throw new DeviceProofError("target mismatch");
  if (envelope.audience !== `ad-daddy:${input.expected.environment}`) throw new DeviceProofError("audience mismatch");
  if (envelope.bodyDigest !== input.expected.bodyDigest) throw new DeviceProofError("body digest mismatch");
  validateTimeWindow(envelope, now, input.maxProofLifetimeMs ?? DEFAULT_MAX_PROOF_LIFETIME_MS);

  const key = await input.repository.findDeviceKey(envelope.installationId, envelope.keyThumbprint);
  if (!key || key.status !== "active" || key.algorithm !== "ES256") {
    throw new DeviceProofError("requires an active ES256 device key");
  }
  const calculatedThumbprint = await deviceKeyThumbprint(key.publicJwk);
  if (calculatedThumbprint !== key.thumbprint || key.thumbprint !== envelope.keyThumbprint) {
    throw new DeviceProofError("key thumbprint mismatch");
  }

  const canonical = canonicalizeDeviceProofEnvelope(envelope);
  const signature = decodeBase64Url(input.proof.signature, "signature", 64);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    key.publicJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    toArrayBuffer(signature),
    new TextEncoder().encode(canonical),
  );
  if (!valid) throw new DeviceProofError("signature is invalid");

  const canonicalRequestSha256 = await sha256Hex(canonical);
  const nonce = await input.repository.consumeNonce({
    installationId: envelope.installationId,
    accountId: key.accountId,
    nonce: envelope.nonce,
    canonicalRequestSha256,
    firstUsedAt: now.toISOString(),
    expiresAt: envelope.expiresAt,
  });
  if (nonce.status === "conflict") throw new DeviceProofError("nonce replay changed request bytes");
  return Object.freeze({ key, replay: nonce.status === "identical_replay", canonicalRequestSha256 });
}

export function canonicalizeDeviceProofEnvelope(envelope: DeviceProofEnvelope): string {
  const value = validateEnvelope(envelope);
  return canonicalDeviceProofEnvelope(value);
}

export function normalizeRequestTarget(target: string): string {
  try {
    return normalizeDeviceProofTarget(target);
  } catch {
    throw new DeviceProofError("target must be a bounded origin-relative URL without a fragment");
  }
}

export async function sha256BodyDigest(body: string | Uint8Array): Promise<string> {
  return sha256DeviceProofBody(body);
}

export async function deviceKeyThumbprint(jwk: JsonWebKey): Promise<string> {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new DeviceProofError("public JWK must be an EC P-256 key");
  }
  const canonical = JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y });
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))));
}

function validateEnvelope(input: DeviceProofEnvelope): DeviceProofEnvelope {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DeviceProofError("envelope must be an object");
  const keys = Object.keys(input);
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((key) => !(ENVELOPE_KEYS as readonly string[]).includes(key))) {
    throw new DeviceProofError("envelope fields are not canonical");
  }
  if (!METHODS.has(input.method)) throw new DeviceProofError("method is unsupported or non-canonical");
  const target = normalizeRequestTarget(input.target);
  if (target !== input.target) throw new DeviceProofError("target is not canonical");
  if (!/^ad-daddy:(test|development|staging|production)$/.test(input.audience)) throw new DeviceProofError("audience is invalid");
  if (!SHA256_HEX.test(input.bodyDigest)) throw new DeviceProofError("body digest is invalid");
  boundedIdentifier(input.installationId, "installation ID", 128);
  if (!Number.isSafeInteger(input.consentVersion) || input.consentVersion < 1) throw new DeviceProofError("consent version must be a positive safe integer");
  boundedBase64Url(input.keyThumbprint, "key thumbprint", 43, 43);
  boundedBase64Url(input.nonce, "nonce", 22, 128);
  if (!validIso(input.issuedAt) || !validIso(input.expiresAt)) throw new DeviceProofError("timestamps must be ISO instants");
  return input;
}

function validateTimeWindow(envelope: DeviceProofEnvelope, now: Date, maxLifetimeMs: number): void {
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1 || maxLifetimeMs > DEFAULT_MAX_PROOF_LIFETIME_MS) {
    throw new DeviceProofError("maximum lifetime is invalid");
  }
  const issuedAt = Date.parse(envelope.issuedAt);
  const expiresAt = Date.parse(envelope.expiresAt);
  if (issuedAt > now.getTime() + CLOCK_SKEW_MS) throw new DeviceProofError("issue time is in the future");
  if (expiresAt <= now.getTime()) throw new DeviceProofError("expired");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maxLifetimeMs) throw new DeviceProofError("lifetime is invalid");
}

async function sha256Hex(value: string): Promise<string> {
  return sha256BodyDigest(value);
}

function boundedIdentifier(value: unknown, name: string, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new DeviceProofError(`${name} is invalid`);
  }
}

function boundedBase64Url(value: unknown, name: string, minimum: number, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || !BASE64URL.test(value)) {
    throw new DeviceProofError(`${name} is invalid`);
  }
}

function validIso(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 32 || Number.isNaN(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function decodeBase64Url(value: string, name: string, expectedBytes: number): Uint8Array {
  boundedBase64Url(value, name, 1, 512);
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new DeviceProofError(`${name} is invalid`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== expectedBytes) throw new DeviceProofError(`${name} has an invalid length`);
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function deviceKeyId(installationId: string, thumbprint: string): string {
  return `${installationId}:${thumbprint}`;
}

function nonceId(installationId: string, nonce: string): string {
  return `${installationId}:${nonce}`;
}

function nonceUse(input: DeviceNonceUse): DeviceNonceUse {
  return Object.freeze({
    installationId: input.installationId,
    nonce: input.nonce,
    canonicalRequestSha256: input.canonicalRequestSha256,
    firstUsedAt: input.firstUsedAt,
    expiresAt: input.expiresAt,
  });
}

function isMemoryStore(input: unknown): input is MemoryDeviceProofStore {
  return Boolean(input && typeof input === "object" && "nonces" in input && "auditEvents" in input);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new DeviceProofError("durable key row is malformed");
  return value;
}

function requiredInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new DeviceProofError("durable key row is malformed");
  return value;
}
