import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  canonicalJson,
  type ClaimedPlacementEnvelope,
  type LocalPlacementDeliveryResult,
  type SignedSponsorshipGrant,
  type SignedDisplayReceipt,
  type SponsorshipDeliveryLease,
  validateClaimedPlacementEnvelope,
  verifySponsorshipGrant,
  type SignedPlacement,
} from "@ad-daddy/host-adapters";

import {
  createDeviceProofHeader,
  signCanonicalPayload,
  type AdDaddyEnvironment,
  type DeviceKeyProvider,
} from "./device-key.js";

const MAX_RESPONSE_BYTES = 262_144;

export interface LocalSponsorshipIdentity {
  receiverAccountId: string;
  installationId: string;
  consentVersion: number;
  credentialReference: string;
  deviceKeyThumbprint: string;
}

export interface LocalSponsorshipPullState {
  installationId: string;
  opportunityId?: string;
  claimId?: string;
  grant?: SignedSponsorshipGrant;
  lease?: SponsorshipDeliveryLease;
  placement?: SignedPlacement;
  signedReceipt?: SignedDisplayReceipt;
  updatedAt: string;
}

interface CreativeFetchedPullState extends LocalSponsorshipPullState {
  claimId: string;
  grant: SignedSponsorshipGrant;
  lease: SponsorshipDeliveryLease;
  placement: SignedPlacement;
}

export interface SponsorshipPullStateStore {
  get(installationId: string): Promise<LocalSponsorshipPullState | undefined>;
  put(state: LocalSponsorshipPullState): Promise<void>;
  remove(installationId: string): Promise<void>;
  tryExclusive?<T>(installationId: string, operation: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }>;
}

export class JsonSponsorshipPullStateStore implements SponsorshipPullStateStore {
  readonly #path: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    if (!path.trim()) throw new Error("A sponsorship pull state path is required");
    this.#path = path;
  }

  async get(installationId: string) {
    await this.#writeTail;
    return clone((await this.read()).find((state) => state.installationId === installationId));
  }

  async put(state: LocalSponsorshipPullState): Promise<void> {
    assertPullState(state);
    await this.write((states) => {
      const index = states.findIndex((candidate) => candidate.installationId === state.installationId);
      if (index === -1) states.push(clone(state)!);
      else states[index] = clone(state)!;
      return true;
    });
  }

  async remove(installationId: string): Promise<void> {
    await this.write((states) => {
      const index = states.findIndex((candidate) => candidate.installationId === installationId);
      if (index === -1) return false;
      states.splice(index, 1);
      return true;
    });
  }

  async tryExclusive<T>(installationId: string, operation: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
    const lockPath = `${this.#path}.${installationId}.lock`;
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    const token = crypto.randomUUID();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if (!await removeAbandonedLock(lockPath)) return { acquired: false };
        return this.tryExclusive(installationId, operation);
      }
      throw error;
    } finally {
      await handle?.close();
    }
    let value: T | undefined;
    let operationError: unknown;
    try {
      value = await operation();
    } catch (error) {
      operationError = error;
    }
    let cleanupError: unknown;
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
      if (current.token === token) await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError = error;
    }
    if (operationError) throw operationError;
    if (cleanupError) throw cleanupError;
    return { acquired: true, value: value as T };
  }

  private async write(mutate: (states: LocalSponsorshipPullState[]) => boolean): Promise<void> {
    const operation = this.#writeTail.then(async () => {
      const states = await this.read();
      if (!mutate(states)) return;
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.#path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(states, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.#path);
    });
    this.#writeTail = operation.then(() => undefined, () => undefined);
    await operation;
  }

  private async read(): Promise<LocalSponsorshipPullState[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Local sponsorship state must be an array");
      for (const state of parsed) assertPullState(state);
      return parsed as LocalSponsorshipPullState[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

async function removeAbandonedLock(lockPath: string): Promise<boolean> {
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    if (!Number.isSafeInteger(lock.pid) || (lock.pid as number) < 1) return false;
    try {
      process.kill(lock.pid as number, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
    await unlink(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export type SponsorshipPullResult =
  | { status: "busy"; reason: "check_already_running" }
  | { status: "pending" | "no_fill"; opportunityId: string; retryAfterSeconds: number }
  | { status: "cancelled"; claimId: string; reason: "local_consent_changed" }
  | { status: "settled"; claimId: string; recoveredReceipt: true }
  | { status: "settled"; claimId: string; delivery: LocalPlacementDeliveryResult; recoveredReceipt: false };

export class SponsorshipPullClient {
  readonly #identity: LocalSponsorshipIdentity;
  readonly #environment: AdDaddyEnvironment;
  readonly #provider: DeviceKeyProvider;
  readonly #marketplacePublicKeyPem: string;
  readonly #baseUrl: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #state: SponsorshipPullStateStore;
  readonly #delivery: {
    deliver(response: ClaimedPlacementEnvelope, now?: Date): Promise<LocalPlacementDeliveryResult>;
    recover?(placementId: string): Promise<LocalPlacementDeliveryResult>;
  };
  readonly #readCurrentIdentity: () => Promise<(LocalSponsorshipIdentity & { status: string }) | undefined>;
  readonly #adapterVersion: string;
  readonly #clock: () => Date;

  constructor(input: {
    identity: LocalSponsorshipIdentity;
    environment: AdDaddyEnvironment;
    provider: DeviceKeyProvider;
    marketplacePublicKeyPem: string;
    apiBaseUrl: string;
    fetch?: typeof globalThis.fetch;
    state: SponsorshipPullStateStore;
    delivery: {
      deliver(response: ClaimedPlacementEnvelope, now?: Date): Promise<LocalPlacementDeliveryResult>;
      recover?(placementId: string): Promise<LocalPlacementDeliveryResult>;
    };
    readCurrentIdentity: () => Promise<(LocalSponsorshipIdentity & { status: string }) | undefined>;
    adapterVersion?: string;
    clock?: () => Date;
  }) {
    this.#identity = validatedIdentity(input.identity);
    this.#environment = input.environment;
    this.#provider = input.provider;
    if (!input.marketplacePublicKeyPem.trim()) throw new Error("A pinned marketplace public key is required");
    this.#marketplacePublicKeyPem = input.marketplacePublicKeyPem;
    this.#baseUrl = safeBaseUrl(input.apiBaseUrl);
    this.#fetch = input.fetch ?? globalThis.fetch;
    this.#state = input.state;
    this.#delivery = input.delivery;
    this.#readCurrentIdentity = input.readCurrentIdentity;
    this.#adapterVersion = input.adapterVersion ?? "ad-daddy-cli/0.1.0";
    this.#clock = input.clock ?? (() => new Date());
  }

  async check(now = new Date()): Promise<SponsorshipPullResult> {
    if (this.#state.tryExclusive) {
      const result = await this.#state.tryExclusive(this.#identity.installationId, () => this.checkOnce(now));
      return result.acquired ? result.value : { status: "busy", reason: "check_already_running" };
    }
    return this.checkOnce(now);
  }

  private async checkOnce(now: Date): Promise<SponsorshipPullResult> {
    let state = await this.#state.get(this.#identity.installationId) ?? this.emptyState(now);
    let creativeValidated = false;
    if (state.signedReceipt) {
      const claimId = required(state.claimId, "pending receipt claim ID");
      await this.submitPersistedReceipt(claimId, state.signedReceipt);
      await this.#state.remove(this.#identity.installationId);
      return { status: "settled", claimId, recoveredReceipt: true };
    }
    if (!state.claimId || !state.grant) {
      const next = await this.request("POST", "/api/v1/sponsorships/next", JSON.stringify(state.opportunityId ? { opportunityId: state.opportunityId } : {}), now);
      const nextRecord = record(next, "sponsorship fetch response");
      if (nextRecord.status === "pending" || nextRecord.status === "no_fill") {
        const opportunityId = boundedString(nextRecord.opportunityId, "opportunity ID", 256);
        const retryAfterSeconds = safeRetry(nextRecord.retryAfterSeconds);
        if (nextRecord.status === "pending") {
          state = { ...this.emptyState(now), opportunityId };
          await this.#state.put(state);
        } else await this.#state.remove(this.#identity.installationId);
        return { status: nextRecord.status, opportunityId, retryAfterSeconds };
      }
      if (nextRecord.status !== "ready") throw new Error("Sponsorship fetch response has an unknown status");
      const claimId = boundedString(nextRecord.claimId, "claim ID", 256);
      const grant = nextRecord.grant as SignedSponsorshipGrant;
      const payload = verifySponsorshipGrant(grant, this.#marketplacePublicKeyPem, now);
      this.assertGrantIdentity(claimId, payload);
      state = { ...this.emptyState(now), opportunityId: payload.opportunityId, claimId, grant: clone(grant)! };
      await this.#state.put(state);
    }
    if (!state.lease || !state.placement) {
      const claimId = required(state.claimId, "claim ID");
      const creative = record(await this.request("GET", `/api/v1/sponsorships/${encodeURIComponent(claimId)}/creative`, "", now), "sponsorship creative response");
      const envelope: ClaimedPlacementEnvelope = {
        claimId: boundedString(creative.claimId, "claim ID", 256),
        grant: creative.grant as SignedSponsorshipGrant,
        lease: creative.lease as SponsorshipDeliveryLease,
        placement: creative.placement as SignedPlacement,
      };
      const payload = validateClaimedPlacementEnvelope(envelope, this.#marketplacePublicKeyPem, now);
      this.assertGrantIdentity(claimId, payload);
      if (canonicalJson(envelope.grant) !== canonicalJson(state.grant)) throw new Error("Creative response changed the signed sponsorship grant");
      state = { ...state, lease: clone(envelope.lease)!, placement: clone(envelope.placement)!, updatedAt: now.toISOString() };
      await this.#state.put(state);
      creativeValidated = true;
    }
    const creativeState = requireCreativeState(state);
    const claimId = creativeState.claimId;
    const current = await this.#readCurrentIdentity();
    if (!sameActiveIdentity(current, this.#identity)) {
      await this.request("DELETE", `/api/v1/sponsorships/${encodeURIComponent(claimId)}/creative`, "", now);
      await this.#state.remove(this.#identity.installationId);
      return { status: "cancelled", claimId, reason: "local_consent_changed" };
    }
    const envelope: ClaimedPlacementEnvelope = {
      claimId,
      grant: creativeState.grant,
      lease: creativeState.lease,
      placement: creativeState.placement,
    };
    if (!creativeValidated && this.#delivery.recover) {
      const recovered = await this.#delivery.recover(envelope.placement.payload.placementId);
      if (recovered.status !== "no_placement") {
        const displayedAt = recovered.record.displayedAt ? new Date(recovered.record.displayedAt) : this.#clock();
        const signedReceipt = await this.createReceipt(envelope, recovered, displayedAt);
        await this.#state.put({ ...state, signedReceipt, updatedAt: this.#clock().toISOString() });
        await this.submitPersistedReceipt(claimId, signedReceipt);
        await this.#state.remove(this.#identity.installationId);
        return { status: "settled", claimId, recoveredReceipt: true };
      }
    }
    if (!creativeValidated) validateClaimedPlacementEnvelope(envelope, this.#marketplacePublicKeyPem, now);
    const delivery = await this.#delivery.deliver(envelope, now);
    if (delivery.status === "no_placement") throw new Error("Claimed sponsorship produced no local placement");
    const displayedAt = delivery.record.displayedAt ? new Date(delivery.record.displayedAt) : this.#clock();
    const signedReceipt = await this.createReceipt(envelope, delivery, displayedAt);
    state = { ...state, signedReceipt, updatedAt: displayedAt.toISOString() };
    await this.#state.put(state);
    await this.submitPersistedReceipt(claimId, signedReceipt);
    await this.#state.remove(this.#identity.installationId);
    return { status: "settled", claimId, delivery, recoveredReceipt: false };
  }

  private async submitPersistedReceipt(claimId: string, receipt: SignedDisplayReceipt): Promise<void> {
    try {
      await this.submitReceipt(claimId, receipt, this.#clock());
    } catch (error) {
      if (error instanceof SponsorshipRequestError && error.terminal) {
        await this.#state.remove(this.#identity.installationId);
      }
      throw error;
    }
  }

  private async request(method: string, target: string, body: string, now: Date): Promise<unknown> {
    const proof = await createDeviceProofHeader({
      provider: this.#provider,
      credentialReference: this.#identity.credentialReference,
      installationId: this.#identity.installationId,
      consentVersion: this.#identity.consentVersion,
      keyThumbprint: this.#identity.deviceKeyThumbprint,
      environment: this.#environment,
      method,
      target,
      body,
      now,
    });
    const response = await this.#fetch(new URL(target, this.#baseUrl), {
      method,
      headers: { "x-ad-daddy-device-proof": proof, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Ad Daddy response is too large");
    const text = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error("Ad Daddy returned malformed JSON"); }
    if (!response.ok) throw new SponsorshipRequestError(response.status, remoteCode(value), remoteMessage(value));
    return value;
  }

  private async submitReceipt(claimId: string, receipt: SignedDisplayReceipt, now: Date): Promise<void> {
    const result = record(await this.request("POST", `/api/v1/sponsorships/${encodeURIComponent(claimId)}/receipt`, JSON.stringify(receipt), now), "receipt response");
    if (result.status !== "settled") throw new Error("Sponsorship receipt did not settle");
  }

  private async createReceipt(
    envelope: ClaimedPlacementEnvelope,
    delivery: Exclude<LocalPlacementDeliveryResult, { status: "no_placement" }>,
    now: Date,
  ): Promise<SignedDisplayReceipt> {
    const host = hostReceipt(delivery);
    const payload: SignedDisplayReceipt["payload"] = {
      protocolVersion: 1,
      claimId: envelope.claimId,
      grantDigest: envelope.grant.payload.grantDigest,
      reservationId: envelope.grant.payload.reservationId,
      placementId: envelope.grant.payload.placementId,
      creativeDigest: envelope.grant.payload.creativeDigest,
      installationId: this.#identity.installationId,
      deviceKeyThumbprint: this.#identity.deviceKeyThumbprint,
      hostKind: host.hostKind,
      hostSessionId: host.hostSessionId,
      ...(host.hostTurnId ? { hostTurnId: host.hostTurnId } : {}),
      outputSha256: host.outputSha256,
      adapterVersion: this.#adapterVersion,
      hostVersion: host.hostVersion,
      policyVersion: envelope.lease.policyVersion,
      surface: host.hostKind === "signed-html" ? "signed_html" : "sidebar_session",
      audience: `ad-daddy:${this.#environment}`,
      nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url"),
      displayedAt: now.toISOString(),
    };
    return {
      algorithm: "ES256",
      payload,
      signature: await signCanonicalPayload(this.#provider, this.#identity.credentialReference, canonicalJson(payload)),
    };
  }

  private assertGrantIdentity(claimId: string, payload: ReturnType<typeof verifySponsorshipGrant>): void {
    if (payload.claimId !== claimId || payload.receiverAccountId !== this.#identity.receiverAccountId ||
      payload.installationId !== this.#identity.installationId || payload.consentVersion !== this.#identity.consentVersion ||
      payload.deviceKeyThumbprint !== this.#identity.deviceKeyThumbprint) {
      throw new Error("Sponsorship grant is bound to a different receiver installation");
    }
  }

  private emptyState(now: Date): LocalSponsorshipPullState {
    return { installationId: this.#identity.installationId, updatedAt: now.toISOString() };
  }
}

function hostReceipt(delivery: Exclude<LocalPlacementDeliveryResult, { status: "no_placement" }>) {
  const receipt = delivery.record.receipt;
  if (!receipt) throw new Error("Local delivery completed without a durable host receipt");
  if ("threadId" in receipt) {
    return { hostKind: "codex" as const, hostSessionId: receipt.threadId, hostTurnId: receipt.turnId, outputSha256: receipt.outputSha256, hostVersion: receipt.cliVersion };
  }
  if (!delivery.record.fallbackOutputSha256) throw new Error("Signed-HTML fallback lacks verified presentation evidence");
  return {
    hostKind: "signed-html" as const,
    hostSessionId: `signed-html:${receipt.placementId}`,
    outputSha256: delivery.record.fallbackOutputSha256,
    hostVersion: "signed-html/v1",
  };
}

function sameActiveIdentity(current: (LocalSponsorshipIdentity & { status: string }) | undefined, expected: LocalSponsorshipIdentity): boolean {
  return current?.status === "active" && current.receiverAccountId === expected.receiverAccountId && current.installationId === expected.installationId &&
    current.consentVersion === expected.consentVersion && current.credentialReference === expected.credentialReference &&
    current.deviceKeyThumbprint === expected.deviceKeyThumbprint;
}

function validatedIdentity(identity: LocalSponsorshipIdentity): LocalSponsorshipIdentity {
  if (!identity || !bounded(identity.receiverAccountId, 256) || !/^[A-Za-z0-9_-]{1,64}$/.test(identity.installationId) ||
    !Number.isSafeInteger(identity.consentVersion) || identity.consentVersion < 1 || !bounded(identity.credentialReference, 512) ||
    !/^[A-Za-z0-9_-]{43}$/.test(identity.deviceKeyThumbprint)) throw new Error("Local sponsorship identity is invalid");
  return Object.freeze({ ...identity });
}

function safeBaseUrl(value: string): URL {
  const url = new URL(value.endsWith("/") ? value : `${value}/`);
  if ((url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) || url.username || url.password) {
    throw new Error("Ad Daddy API URL must be credential-free HTTPS");
  }
  return url;
}

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("Ad Daddy response is too large");
        throw new Error("Ad Daddy response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function assertPullState(value: unknown): asserts value is LocalSponsorshipPullState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed local sponsorship state");
  const state = value as Partial<LocalSponsorshipPullState>;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(state.installationId ?? "") || !Number.isFinite(Date.parse(state.updatedAt ?? "")) ||
    (state.opportunityId !== undefined && !bounded(state.opportunityId, 256)) ||
    (state.claimId !== undefined && !bounded(state.claimId, 256)) ||
    ((state.claimId === undefined) !== (state.grant === undefined)) ||
    ((state.lease === undefined) !== (state.placement === undefined)) ||
    (state.lease !== undefined && state.grant === undefined) ||
    (state.signedReceipt !== undefined && state.placement === undefined)) {
    throw new Error("Malformed local sponsorship state");
  }
}

function requireCreativeState(state: LocalSponsorshipPullState): CreativeFetchedPullState {
  if (!state.claimId || !state.grant || !state.lease || !state.placement) {
    throw new Error("Local sponsorship creative state is incomplete");
  }
  return state as CreativeFetchedPullState;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (!bounded(value, maximum)) throw new Error(`${name} is invalid`);
  return value;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is missing`);
  return value;
}

function safeRetry(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 300) throw new Error("Sponsorship retry guidance is invalid");
  return value as number;
}

function remoteMessage(value: unknown): string {
  const response = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  return (response && typeof response.message === "string" ? response.message : "request rejected").slice(0, 240);
}

function remoteCode(value: unknown): string | undefined {
  const response = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  return response && typeof response.error === "string" ? response.error : undefined;
}

class SponsorshipRequestError extends Error {
  readonly terminal: boolean;
  constructor(status: number, code: string | undefined, message: string) {
    super(`Ad Daddy rejected sponsorship request (${status}): ${message}`);
    this.name = "SponsorshipRequestError";
    this.terminal = (status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 425 && status !== 429) ||
      ["receipt_recovery_expired", "settlement_review_required", "different_first_surface", "claim_cancelled"].includes(code ?? "") ||
      /grace period expired|settlement review|different first verified surface|claim is cancelled/i.test(message);
  }
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
