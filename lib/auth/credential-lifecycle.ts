import { ENVIRONMENTS, type AuditEvent, type Environment } from "../domain/types.ts";

export const CREDENTIAL_KINDS = [
  "installation",
  "campaign_agent",
  "marketplace_signing",
  "treasury_payment",
  "operator_admin",
  "integration",
] as const;

export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export interface ManagedCredential {
  credentialId: string;
  kind: CredentialKind;
  environment: Environment;
  keyId: string;
  scopes: readonly string[];
  publicMaterial: string;
  createdAt: string;
  status: "active" | "rotating" | "revoked" | "retired";
  retireAt?: string;
  revokedAt?: string;
}

type EnrollCredentialInput = Omit<ManagedCredential, "createdAt" | "status" | "retireAt" | "revokedAt"> & { now?: Date };

export class CredentialLifecycleService {
  readonly #byCredentialId = new Map<string, ManagedCredential>();
  readonly #byKeyId = new Map<string, ManagedCredential>();
  readonly #auditEvents: AuditEvent[] = [];

  get auditEvents(): readonly AuditEvent[] {
    return Object.freeze([...this.#auditEvents]);
  }

  enroll(input: EnrollCredentialInput): ManagedCredential {
    const now = input.now ?? new Date();
    if (!input.credentialId || !input.keyId || !input.publicMaterial) throw new Error("Credential ID, key ID, and public material are required");
    if (!CREDENTIAL_KINDS.includes(input.kind)) {
      throw new Error("Unsupported credential kind");
    }
    if (!ENVIRONMENTS.includes(input.environment)) throw new Error("Unsupported credential environment");
    if (this.#byCredentialId.has(input.credentialId) || this.#byKeyId.has(input.keyId)) throw new Error("Credential or key ID already exists");
    if (input.scopes.length === 0 || input.scopes.length > 20 || new Set(input.scopes).size !== input.scopes.length || input.scopes.some((scope) => !scope || scope.length > 128)) {
      throw new Error("Credentials require 1-20 unique least-privilege scopes");
    }
    const credential: ManagedCredential = {
      credentialId: input.credentialId,
      kind: input.kind,
      environment: input.environment,
      keyId: input.keyId,
      scopes: Object.freeze([...input.scopes]),
      publicMaterial: input.publicMaterial,
      createdAt: now.toISOString(),
      status: "active",
    };
    this.#byCredentialId.set(credential.credentialId, credential);
    this.#byKeyId.set(credential.keyId, credential);
    this.audit(credential, "credential.enrolled", now, {});
    return Object.freeze({ ...credential });
  }

  rotate(input: {
    credentialId: string;
    replacement: Omit<EnrollCredentialInput, "now">;
    overlapMs: number;
    now?: Date;
  }): ManagedCredential {
    const now = input.now ?? new Date();
    const current = this.requireById(input.credentialId);
    if (current.status !== "active") throw new Error("Only active credentials can rotate");
    if (!Number.isSafeInteger(input.overlapMs) || input.overlapMs < 0) throw new Error("overlapMs must be a non-negative safe integer");
    if (input.replacement.kind !== current.kind || input.replacement.environment !== current.environment) {
      throw new Error("Replacement must retain credential kind and environment");
    }
    const replacement = this.enroll({ ...input.replacement, now });
    current.status = "rotating";
    current.retireAt = new Date(now.getTime() + input.overlapMs).toISOString();
    this.audit(current, "credential.rotation_started", now, { replacementKeyId: replacement.keyId, retireAt: current.retireAt });
    return replacement;
  }

  revoke(credentialId: string, now = new Date(), reason: string): ManagedCredential {
    const credential = this.requireById(credentialId);
    if (credential.status === "revoked") return Object.freeze({ ...credential });
    credential.status = "revoked";
    credential.revokedAt = now.toISOString();
    this.audit(credential, "credential.revoked", now, { reason });
    return Object.freeze({ ...credential });
  }

  assertUsable(keyId: string, environment: Environment, scope: string, now = new Date()): ManagedCredential {
    const credential = this.#byKeyId.get(keyId);
    if (!credential) throw new Error("Unknown credential key");
    if (credential.environment !== environment) throw new Error("Credential environment mismatch");
    if (credential.status === "revoked" || credential.status === "retired") throw new Error(`Credential is ${credential.status}`);
    if (credential.status === "rotating" && credential.retireAt && Date.parse(credential.retireAt) <= now.getTime()) {
      credential.status = "retired";
      throw new Error("Credential is retired");
    }
    if (!credential.scopes.includes(scope)) throw new Error("Credential scope is not authorized");
    return Object.freeze({ ...credential });
  }

  private requireById(credentialId: string): ManagedCredential {
    const credential = this.#byCredentialId.get(credentialId);
    if (!credential) throw new Error("Unknown credential");
    return credential;
  }

  private audit(credential: ManagedCredential, action: string, now: Date, metadata: Record<string, string>): void {
    this.#auditEvents.push(Object.freeze({
      eventId: crypto.randomUUID(),
      accountId: "system",
      action,
      actorKind: "operator",
      resourceId: credential.credentialId,
      occurredAt: now.toISOString(),
      metadata: Object.freeze({ environment: credential.environment, keyId: credential.keyId, ...metadata }),
    }));
  }
}
