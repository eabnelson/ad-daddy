import type { AuditEvent, HumanApproval } from "../domain/types.ts";
import { assertRecentHumanApproval } from "./authorize.ts";

export interface PlatformIdentity {
  provider: "chatgpt" | "github";
  subject: string;
}

export interface Passkey {
  credentialId: string;
  publicKey: string;
  counter: number;
}

export interface AccountRecovery {
  recoveryId: string;
  accountId: string;
  requestedAt: string;
  sensitiveChangesBlockedUntil: string;
  status: "pending" | "completed" | "cancelled";
}

export interface AccountIdentityServiceOptions {
  recoveryMaxAttempts: number;
  recoveryWindowMs: number;
  recoveryCoolingOffMs: number;
  notify(accountId: string, recovery: AccountRecovery): void;
}

export class AccountIdentityService {
  readonly #identities = new Map<string, PlatformIdentity[]>();
  readonly #identityOwners = new Map<string, string>();
  readonly #passkeys = new Map<string, Passkey[]>();
  readonly #passkeyOwners = new Map<string, string>();
  readonly #recoveries = new Map<string, AccountRecovery>();
  readonly #recoveryAttempts = new Map<string, number[]>();
  readonly #auditEvents: AuditEvent[] = [];
  readonly #options: AccountIdentityServiceOptions;

  constructor(options: AccountIdentityServiceOptions) {
    if (!Number.isInteger(options.recoveryMaxAttempts) || options.recoveryMaxAttempts < 1) throw new Error("recoveryMaxAttempts must be a positive integer");
    if (options.recoveryWindowMs <= 0 || options.recoveryCoolingOffMs <= 0) throw new Error("Recovery time windows must be positive");
    this.#options = options;
  }

  get auditEvents(): readonly AuditEvent[] {
    return Object.freeze([...this.#auditEvents]);
  }

  linkPlatformIdentity(accountId: string, identity: PlatformIdentity, approval: HumanApproval, now = new Date()): void {
    assertRecentHumanApproval(approval, accountId, "identity_link", now);
    const identityKey = `${identity.provider}:${identity.subject}`;
    const owner = this.#identityOwners.get(identityKey);
    if (owner && owner !== accountId) throw new Error("Platform identity is linked to another account");
    const identities = this.#identities.get(accountId) ?? [];
    if (identities.some((candidate) => candidate.provider === identity.provider && candidate.subject === identity.subject)) return;
    identities.push(Object.freeze({ ...identity }));
    this.#identities.set(accountId, identities);
    this.#identityOwners.set(identityKey, accountId);
    this.audit(accountId, "identity.linked", `${identity.provider}:${identity.subject}`, now, { provider: identity.provider });
  }

  addPasskey(accountId: string, passkey: Passkey, approval: HumanApproval, now = new Date()): void {
    assertRecentHumanApproval(approval, accountId, "passkey_add", now);
    if (!Number.isSafeInteger(passkey.counter) || passkey.counter < 0) throw new Error("Passkey counter must be a non-negative integer");
    const passkeys = this.#passkeys.get(accountId) ?? [];
    const owner = this.#passkeyOwners.get(passkey.credentialId);
    if (owner && owner !== accountId) throw new Error("Passkey is enrolled to another account");
    if (passkeys.some((candidate) => candidate.credentialId === passkey.credentialId)) throw new Error("Passkey already enrolled");
    passkeys.push(Object.freeze({ ...passkey }));
    this.#passkeys.set(accountId, passkeys);
    this.#passkeyOwners.set(passkey.credentialId, accountId);
    this.audit(accountId, "passkey.added", passkey.credentialId, now, {});
  }

  requestRecovery(accountId: string, now = new Date()): AccountRecovery {
    const pending = this.#recoveries.get(accountId);
    if (pending?.status === "pending") throw new Error("Account recovery is already pending");
    const cutoff = now.getTime() - this.#options.recoveryWindowMs;
    const attempts = (this.#recoveryAttempts.get(accountId) ?? []).filter((timestamp) => timestamp > cutoff);
    if (attempts.length >= this.#options.recoveryMaxAttempts) throw new Error("Account recovery is rate-limited");
    attempts.push(now.getTime());
    this.#recoveryAttempts.set(accountId, attempts);
    const recovery = Object.freeze({
      recoveryId: crypto.randomUUID(),
      accountId,
      requestedAt: now.toISOString(),
      sensitiveChangesBlockedUntil: new Date(now.getTime() + this.#options.recoveryCoolingOffMs).toISOString(),
      status: "pending" as const,
    });
    this.#recoveries.set(accountId, recovery);
    this.audit(accountId, "recovery.requested", recovery.recoveryId, now, { blockedUntil: recovery.sensitiveChangesBlockedUntil });
    this.#options.notify(accountId, recovery);
    return recovery;
  }

  assertSensitiveChangesAllowed(accountId: string, now = new Date()): void {
    const recovery = this.#recoveries.get(accountId);
    if (recovery && Date.parse(recovery.sensitiveChangesBlockedUntil) > now.getTime()) {
      throw new Error(`Sensitive changes are cooling off until ${recovery.sensitiveChangesBlockedUntil}`);
    }
  }

  resolveRecovery(
    accountId: string,
    recoveryId: string,
    status: "completed" | "cancelled",
    now = new Date(),
  ): AccountRecovery {
    const current = this.#recoveries.get(accountId);
    if (!current || current.recoveryId !== recoveryId || current.status !== "pending") {
      throw new Error("No matching pending account recovery");
    }
    const resolved = Object.freeze({ ...current, status });
    this.#recoveries.set(accountId, resolved);
    this.audit(accountId, `recovery.${status}`, recoveryId, now, {});
    return resolved;
  }

  private audit(
    accountId: string,
    action: string,
    resourceId: string,
    now: Date,
    metadata: Record<string, string | number | boolean | null>,
  ): void {
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
