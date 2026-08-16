import { createHash } from "node:crypto";

export type ApprovalCapabilityPurpose =
  | "device_enroll"
  | "campaign_fund"
  | "campaign_activate"
  | "campaign_close";

export interface ApprovalCapabilityRecord {
  approvalId: string;
  accountId: string;
  purpose: ApprovalCapabilityPurpose;
  resourceFingerprint: string;
  approvedAt: string;
  expiresAt: string;
  consumedBy?: string;
  consumedAt?: string;
}

export interface ApprovalCapabilityRepository {
  putVerified(record: ApprovalCapabilityRecord): Promise<void>;
  consume(input: {
    approvalId: string;
    accountId: string;
    purpose: ApprovalCapabilityPurpose;
    resourceFingerprint: string;
    useId: string;
    now: Date;
  }): Promise<ApprovalCapabilityRecord>;
}

export class MemoryApprovalCapabilityRepository implements ApprovalCapabilityRepository {
  readonly #records = new Map<string, ApprovalCapabilityRecord>();

  async putVerified(record: ApprovalCapabilityRecord): Promise<void> {
    assertRecord(record);
    if (this.#records.has(record.approvalId)) throw new Error("Approval capability id collision");
    this.#records.set(record.approvalId, structuredClone(record));
  }

  async consume(input: Parameters<ApprovalCapabilityRepository["consume"]>[0]): Promise<ApprovalCapabilityRecord> {
    const record = this.#records.get(input.approvalId);
    assertConsumable(record, input);
    if (!record!.consumedBy) {
      record!.consumedBy = input.useId;
      record!.consumedAt = input.now.toISOString();
    }
    return structuredClone(record!);
  }
}

export class D1ApprovalCapabilityRepository implements ApprovalCapabilityRepository {
  readonly #db: D1Database;
  constructor(db: D1Database) { this.#db = db; }

  async putVerified(record: ApprovalCapabilityRecord): Promise<void> {
    assertRecord(record);
    await this.#db.prepare(`INSERT INTO human_approval_capabilities
      (id, account_id, purpose, resource_fingerprint, approved_at, expires_at, consumed_by, consumed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        record.approvalId, record.accountId, record.purpose, record.resourceFingerprint,
        record.approvedAt, record.expiresAt, record.consumedBy ?? null, record.consumedAt ?? null,
      ).run();
  }

  async consume(input: Parameters<ApprovalCapabilityRepository["consume"]>[0]): Promise<ApprovalCapabilityRecord> {
    const current = await this.get(input.approvalId);
    assertConsumable(current, input);
    if (!current!.consumedBy) {
      await this.#db.prepare(`UPDATE human_approval_capabilities SET consumed_by = ?, consumed_at = ?
        WHERE id = ? AND consumed_by IS NULL`).bind(input.useId, input.now.toISOString(), input.approvalId).run();
    }
    const consumed = await this.get(input.approvalId);
    assertConsumable(consumed, input);
    return consumed!;
  }

  private async get(approvalId: string): Promise<ApprovalCapabilityRecord | undefined> {
    const row = await this.#db.prepare(`SELECT id AS approvalId, account_id AS accountId, purpose,
      resource_fingerprint AS resourceFingerprint, approved_at AS approvedAt, expires_at AS expiresAt,
      consumed_by AS consumedBy, consumed_at AS consumedAt
      FROM human_approval_capabilities WHERE id = ?`).bind(approvalId).first<Record<string, unknown>>();
    if (!row) return undefined;
    return {
      approvalId: text(row.approvalId), accountId: text(row.accountId),
      purpose: text(row.purpose) as ApprovalCapabilityPurpose,
      resourceFingerprint: text(row.resourceFingerprint), approvedAt: text(row.approvedAt), expiresAt: text(row.expiresAt),
      ...(row.consumedBy ? { consumedBy: text(row.consumedBy), consumedAt: text(row.consumedAt) } : {}),
    };
  }
}

export function approvalResourceFingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function assertConsumable(record: ApprovalCapabilityRecord | undefined, input: Parameters<ApprovalCapabilityRepository["consume"]>[0]): void {
  if (!record || record.accountId !== input.accountId || record.purpose !== input.purpose ||
    record.resourceFingerprint !== input.resourceFingerprint || Date.parse(record.approvedAt) > input.now.getTime() ||
    Date.parse(record.expiresAt) <= input.now.getTime()) {
    throw new Error("Fresh server-issued human approval capability is required");
  }
  if (record.consumedBy && record.consumedBy !== input.useId) throw new Error("Human approval capability replay");
}

function assertRecord(record: ApprovalCapabilityRecord): void {
  if (!record.approvalId || !record.accountId || !record.resourceFingerprint ||
    !["device_enroll", "campaign_fund", "campaign_activate", "campaign_close"].includes(record.purpose) ||
    !Number.isFinite(Date.parse(record.approvedAt)) || !Number.isFinite(Date.parse(record.expiresAt)) ||
    Date.parse(record.approvedAt) >= Date.parse(record.expiresAt)) throw new Error("Approval capability is invalid");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Durable approval capability is malformed");
  return value;
}
