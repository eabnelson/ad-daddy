import type { AuditEvent, HumanApproval } from "../domain/types.ts";
import { assertRecentHumanApproval } from "./authorize.ts";

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
