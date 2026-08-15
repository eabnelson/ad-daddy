import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

import { canonicalJson, type SignedPlacement } from "@ad-daddy/host-adapters";
import type { ClaimState, ConsentStatus, Environment, RewardType } from "../domain/types.ts";
import { KeyedSerialExecutor } from "../runtime/keyed-serial.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_RETRY_AFTER_SECONDS = 5;

export interface SponsorshipDeviceIdentity {
  accountId: string;
  installationId: string;
  consentVersion: number;
  deviceKeyThumbprint: string;
  devicePublicJwk: JsonWebKey;
}

export interface SponsorshipReceiver {
  accountId: string;
  receiverProfileId: string;
  installationId: string;
  consentVersion: number;
  status: ConsentStatus;
}

export interface SponsorshipOpportunity {
  opportunityId: string;
  auctionId: string;
  receiverProfileId: string;
  installationId: string;
  consentVersion: number;
  openedAt: string;
  expiresAt: string;
}

export type SponsorshipOutcome =
  | { status: "pending"; opportunityId: string; auctionId: string }
  | { status: "no_fill"; opportunityId: string; auctionId: string; reason: string }
  | {
      status: "winner";
      opportunityId: string;
      auctionId: string;
      placementId: string;
      campaignId: string;
      reservationId: string;
      eligibleBidderCount: number;
      rewardType: RewardType;
      grossAmountMinor: number;
      receiverAmountMinor: number;
      operatorAmountMinor: number;
      currency: "USD";
      signedPlacement: SignedPlacement;
    };

export interface SponsorshipGrantPayload {
  protocolVersion: 1;
  receiverAccountId: string;
  receiverProfileId: string;
  installationId: string;
  deviceKeyThumbprint: string;
  consentVersion: number;
  opportunityId: string;
  placementId: string;
  campaignId: string;
  reservationId: string;
  rewardType: RewardType;
  grossAmountMinor: number;
  receiverAmountMinor: number;
  operatorAmountMinor: number;
  currency: "USD";
  creativeDigest: string;
  eligibleBidderCount: number;
  grantDigest: string;
  issuedAt: string;
  expiresAt: string;
}

export interface SignedSponsorshipGrant {
  algorithm: "Ed25519";
  keyId: string;
  payload: SponsorshipGrantPayload;
  signature: string;
}

export interface SponsorshipClaimRecord {
  claimId: string;
  placementId: string;
  opportunityId: string;
  reservationId: string;
  receiverProfileId: string;
  installationId: string;
  consentVersion: number;
  deviceKeyThumbprint: string;
  creativeDigest: string;
  state: ClaimState;
  grant: SignedSponsorshipGrant;
  issuedAt: string;
  expiresAt: string;
}

export interface SponsorshipDeliveryLease {
  leaseId: string;
  claimId: string;
  installationId: string;
  deviceKeyThumbprint: string;
  creativeDigest: string;
  policyVersion: string;
  state: "active" | "displayed" | "expired" | "cancelled";
  issuedAt: string;
  expiresAt: string;
}

export interface DisplayReceiptPayload {
  protocolVersion: 1;
  claimId: string;
  grantDigest: string;
  reservationId: string;
  placementId: string;
  creativeDigest: string;
  installationId: string;
  deviceKeyThumbprint: string;
  hostKind: "codex" | "claude" | "signed-html";
  hostSessionId: string;
  hostTurnId?: string;
  outputSha256: string;
  adapterVersion: string;
  policyVersion: string;
  surface: "sidebar_session";
  audience: `ad-daddy:${Environment}`;
  nonce: string;
  displayedAt: string;
}

export interface SignedDisplayReceipt {
  algorithm: "ES256";
  payload: DisplayReceiptPayload;
  signature: string;
}

export interface ReceiptAcceptance {
  receiptDigest: string;
  firstSurface: boolean;
  settlementState: "pending" | "settled";
}

export interface ExpiredUnclaimedReservation {
  opportunityId: string;
  campaignId: string;
  reservationId: string;
}

export interface SponsorshipClaimRepository {
  getReceiver(installationId: string): Promise<SponsorshipReceiver | undefined>;
  getOpportunity(opportunityId: string): Promise<SponsorshipOpportunity | undefined>;
  openOrGetOpportunity(receiver: SponsorshipReceiver, now: Date): Promise<SponsorshipOpportunity>;
  getOutcome(opportunityId: string): Promise<SponsorshipOutcome>;
  getClaim(claimId: string): Promise<SponsorshipClaimRecord | undefined>;
  createOrGetClaim(record: SponsorshipClaimRecord): Promise<SponsorshipClaimRecord>;
  assertRedeemable(claim: SponsorshipClaimRecord, now: Date): Promise<SponsorshipOutcome & { status: "winner" }>;
  assertSettlementOutcome(claim: SponsorshipClaimRecord): Promise<SponsorshipOutcome & { status: "winner" }>;
  issueOrGetLease(claim: SponsorshipClaimRecord, lease: SponsorshipDeliveryLease): Promise<SponsorshipDeliveryLease>;
  getLease(claimId: string): Promise<SponsorshipDeliveryLease | undefined>;
  acceptReceipt(input: {
    claim: SponsorshipClaimRecord;
    lease: SponsorshipDeliveryLease;
    receipt: SignedDisplayReceipt;
    receiptDigest: string;
    now: Date;
    graceExpiresAt: string;
    settlementReviewDeadlineAt: string;
  }): Promise<ReceiptAcceptance>;
  markSettled(claimId: string, settledAt: string): Promise<void>;
  listExpirable(now: Date, deliveryLeaseReviewBefore: Date): Promise<readonly SponsorshipClaimRecord[]>;
  listExpiredUnclaimedReservations(now: Date): Promise<readonly ExpiredUnclaimedReservation[]>;
  expireUnclaimedOpportunity(opportunityId: string, now: Date): Promise<boolean>;
  cancelExpired(claimId: string, now: Date): Promise<boolean>;
  moveToSettlementReview(claimId: string, now: Date): Promise<boolean>;
  markReservationReleased(reservationId: string): Promise<void>;
}

export interface SponsorshipSettlementGateway {
  settle(input: {
    claim: SponsorshipClaimRecord;
    outcome: SponsorshipOutcome & { status: "winner" };
    receipt: SignedDisplayReceipt;
  }): Promise<void>;
  release(input: { campaignId: string; reservationId: string; claimId: string }): Promise<void>;
}

export type NextSponsorshipResult =
  | { status: "pending"; opportunityId: string; retryAfterSeconds: number }
  | { status: "no_fill"; opportunityId: string; retryAfterSeconds: number }
  | { status: "ready"; claimId: string; grant: SignedSponsorshipGrant };

export class SponsorshipClaimService {
  readonly #repository: SponsorshipClaimRepository;
  readonly #keyId: string;
  readonly #privateKeyPem: string;
  readonly #claimTtlMs: number;
  readonly #leaseTtlMs: number;
  readonly #receiptGraceMs: number;
  readonly #settlementReviewMs: number;
  readonly #settlement: SponsorshipSettlementGateway;
  readonly #environment: Environment;

  constructor(repository: SponsorshipClaimRepository, input: {
    keyId: string;
    privateKeyPem: string;
    claimTtlMs: number;
    leaseTtlMs: number;
    receiptGraceMs: number;
    settlementReviewMs: number;
    settlement: SponsorshipSettlementGateway;
    environment?: Environment;
  }) {
    this.#repository = repository;
    this.#keyId = bounded(input.keyId, "grant key ID");
    this.#privateKeyPem = input.privateKeyPem;
    createPrivateKey(this.#privateKeyPem);
    this.#claimTtlMs = duration(input.claimTtlMs, "claim TTL", 30_000, 86_400_000);
    this.#leaseTtlMs = duration(input.leaseTtlMs, "lease TTL", 1_000, this.#claimTtlMs);
    this.#receiptGraceMs = duration(input.receiptGraceMs, "receipt grace", 1_000, 604_800_000);
    this.#settlementReviewMs = duration(input.settlementReviewMs, "settlement review", 1_000, 2_592_000_000);
    this.#settlement = input.settlement;
    this.#environment = input.environment ?? "test";
  }

  async next(device: SponsorshipDeviceIdentity, now = new Date(), opportunityId?: string): Promise<NextSponsorshipResult> {
    const receiver = await this.#assertReceiver(device);
    const opportunity = opportunityId
      ? await this.#repository.getOpportunity(bounded(opportunityId, "opportunity ID"))
      : await this.#repository.openOrGetOpportunity(receiver, now);
    if (!opportunity || opportunity.receiverProfileId !== receiver.receiverProfileId || opportunity.installationId !== receiver.installationId ||
      opportunity.consentVersion !== receiver.consentVersion) throw new Error("Sponsorship opportunity is bound to a different installation or consent version");
    if (Date.parse(opportunity.expiresAt) <= now.getTime()) {
      return Object.freeze({ status: "no_fill", opportunityId: opportunity.opportunityId, retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS });
    }
    const outcome = await this.#repository.getOutcome(opportunity.opportunityId);
    if (outcome.status === "pending") {
      return Object.freeze({ status: "pending", opportunityId: opportunity.opportunityId, retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS });
    }
    if (outcome.status === "no_fill") {
      return Object.freeze({ status: "no_fill", opportunityId: opportunity.opportunityId, retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS });
    }
    validateWinner(outcome);
    const creativeDigest = digest(outcome.signedPlacement);
    const issuedAt = now.toISOString();
    const expiryTime = Math.min(now.getTime() + this.#claimTtlMs, Date.parse(outcome.signedPlacement.payload.expiresAt));
    if (!Number.isFinite(expiryTime) || expiryTime <= now.getTime()) throw new Error("Winning sponsorship creative already expired");
    const expiresAt = new Date(expiryTime).toISOString();
    const claimId = crypto.randomUUID();
    const grant = signGrant({
      protocolVersion: 1,
      receiverAccountId: receiver.accountId,
      receiverProfileId: receiver.receiverProfileId,
      installationId: receiver.installationId,
      deviceKeyThumbprint: device.deviceKeyThumbprint,
      consentVersion: receiver.consentVersion,
      opportunityId: outcome.opportunityId,
      placementId: outcome.placementId,
      campaignId: outcome.campaignId,
      reservationId: outcome.reservationId,
      rewardType: outcome.rewardType,
      grossAmountMinor: outcome.grossAmountMinor,
      receiverAmountMinor: outcome.receiverAmountMinor,
      operatorAmountMinor: outcome.operatorAmountMinor,
      currency: outcome.currency,
      creativeDigest,
      eligibleBidderCount: outcome.eligibleBidderCount,
      issuedAt,
      expiresAt,
    }, { keyId: this.#keyId, privateKeyPem: this.#privateKeyPem });
    const stored = await this.#repository.createOrGetClaim({
      claimId, placementId: outcome.placementId, opportunityId: outcome.opportunityId,
      reservationId: outcome.reservationId, receiverProfileId: receiver.receiverProfileId,
      installationId: receiver.installationId, consentVersion: receiver.consentVersion,
      deviceKeyThumbprint: device.deviceKeyThumbprint, creativeDigest, state: "claimed",
      grant, issuedAt, expiresAt,
    });
    this.#assertClaimDevice(stored, device);
    if (!["claimed", "delivery_leased"].includes(stored.state) || Date.parse(stored.expiresAt) <= now.getTime()) {
      return Object.freeze({ status: "no_fill", opportunityId: opportunity.opportunityId, retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS });
    }
    return Object.freeze({ status: "ready", claimId: stored.claimId, grant: stored.grant });
  }

  async creative(claimId: string, device: SponsorshipDeviceIdentity, now = new Date()): Promise<{
    claimId: string;
    grant: SignedSponsorshipGrant;
    lease: SponsorshipDeliveryLease;
    placement: SignedPlacement;
  }> {
    const claim = await this.#requireClaim(claimId);
    this.#assertClaimDevice(claim, device);
    await this.#assertReceiver(device);
    if (Date.parse(claim.expiresAt) <= now.getTime() || ["consumed", "expired", "cancelled", "settlement_review"].includes(claim.state)) {
      throw new Error("Sponsorship claim expired or is unavailable");
    }
    const outcome = await this.#repository.assertRedeemable(claim, now);
    const creativeDigest = digest(outcome.signedPlacement);
    if (creativeDigest !== claim.creativeDigest) throw new Error("Sponsorship creative digest changed after grant");
    if (Date.parse(outcome.signedPlacement.payload.expiresAt) <= now.getTime()) throw new Error("Winning sponsorship creative expired");
    const lease = await this.#repository.issueOrGetLease(claim, {
      leaseId: crypto.randomUUID(), claimId: claim.claimId, installationId: claim.installationId,
      deviceKeyThumbprint: claim.deviceKeyThumbprint, creativeDigest, policyVersion: "pull/v1", state: "active",
      issuedAt: now.toISOString(), expiresAt: new Date(Math.min(Date.parse(claim.expiresAt), now.getTime() + this.#leaseTtlMs)).toISOString(),
    });
    return Object.freeze({ claimId: claim.claimId, grant: claim.grant, lease, placement: outcome.signedPlacement });
  }

  async receipt(claimId: string, device: SponsorshipDeviceIdentity, receipt: SignedDisplayReceipt, now = new Date()): Promise<{ status: "settled" }> {
    const claim = await this.#requireClaim(claimId);
    this.#assertClaimDevice(claim, device);
    const lease = await this.#repository.getLease(claimId);
    if (!lease || lease.installationId !== device.installationId || lease.deviceKeyThumbprint !== device.deviceKeyThumbprint) {
      throw new Error("Active device-bound delivery lease required");
    }
    if (["expired", "cancelled"].includes(lease.state)) {
      throw new Error("Active device-bound delivery lease required");
    }
    const receiptDigest = verifyDisplayReceipt(receipt, device.devicePublicJwk, now);
    if (receipt.payload.audience !== `ad-daddy:${this.#environment}`) throw new Error("Display receipt audience is invalid");
    assertReceiptBinding(receipt.payload, claim, lease);
    const leaseExpiresAt = Date.parse(lease.expiresAt);
    const displayedAt = Date.parse(receipt.payload.displayedAt);
    if (displayedAt < Date.parse(lease.issuedAt) - 30_000 || displayedAt > leaseExpiresAt + 30_000) {
      throw new Error("Display receipt falls outside the delivery lease");
    }
    const graceExpiresAtMs = leaseExpiresAt + this.#receiptGraceMs;
    if (lease.state === "active" && now.getTime() >= graceExpiresAtMs) throw new Error("Receipt recovery grace period expired");
    const outcome = await this.#repository.assertSettlementOutcome(claim);
    const accepted = await this.#repository.acceptReceipt({
      claim, lease, receipt, receiptDigest, now,
      graceExpiresAt: new Date(graceExpiresAtMs).toISOString(),
      settlementReviewDeadlineAt: new Date(graceExpiresAtMs + this.#settlementReviewMs).toISOString(),
    });
    if (!accepted.firstSurface && accepted.receiptDigest !== receiptDigest) throw new Error("A different first verified surface already won");
    if (accepted.settlementState !== "settled") {
      await this.#settlement.settle({ claim, outcome, receipt });
      await this.#repository.markSettled(claim.claimId, now.toISOString());
    }
    return Object.freeze({ status: "settled" });
  }

  async expire(now = new Date()): Promise<void> {
    const deliveryLeaseReviewBefore = new Date(now.getTime() - this.#receiptGraceMs);
    for (const claim of await this.#repository.listExpirable(now, deliveryLeaseReviewBefore)) {
      if (["delivery_leased", "displayed_pending_receipt", "consumed"].includes(claim.state)) {
        await this.#repository.moveToSettlementReview(claim.claimId, now);
        continue;
      }
      const outcome = await this.#repository.assertSettlementOutcome(claim);
      if (await this.#repository.cancelExpired(claim.claimId, now)) {
        await this.#settlement.release({ campaignId: outcome.campaignId, reservationId: claim.reservationId, claimId: claim.claimId });
        await this.#repository.markReservationReleased(claim.reservationId);
      }
    }
    for (const winner of await this.#repository.listExpiredUnclaimedReservations(now)) {
      if (await this.#repository.expireUnclaimedOpportunity(winner.opportunityId, now)) {
        await this.#settlement.release({ campaignId: winner.campaignId, reservationId: winner.reservationId, claimId: `unclaimed:${winner.opportunityId}` });
        await this.#repository.markReservationReleased(winner.reservationId);
      }
    }
  }

  async #assertReceiver(device: SponsorshipDeviceIdentity): Promise<SponsorshipReceiver> {
    const receiver = await this.#repository.getReceiver(device.installationId);
    if (!receiver || receiver.accountId !== device.accountId) throw new Error("Active receiver installation required");
    if (receiver.status !== "active" || receiver.consentVersion !== device.consentVersion) throw new Error("Active consent version required");
    return receiver;
  }

  async #requireClaim(claimId: string) {
    const claim = await this.#repository.getClaim(bounded(claimId, "claim ID"));
    if (!claim) throw new Error("Sponsorship claim not found");
    return claim;
  }

  #assertClaimDevice(claim: SponsorshipClaimRecord, device: SponsorshipDeviceIdentity): void {
    if (claim.installationId !== device.installationId || claim.deviceKeyThumbprint !== device.deviceKeyThumbprint || claim.consentVersion !== device.consentVersion) {
      throw new Error("Sponsorship claim is bound to a different device or consent version");
    }
    if (claim.grant.payload.receiverAccountId !== device.accountId) throw new Error("Sponsorship claim is bound to a different receiver account");
  }
}

type MemoryReceiver = SponsorshipReceiver;
interface MemoryRecovery { receiptDigest: string; settlementState: "pending" | "settled" | "settlement_review"; graceExpiresAt?: string; settlementReviewDeadlineAt?: string; }

export class MemorySponsorshipClaimRepository implements SponsorshipClaimRepository {
  readonly #receivers = new Map<string, MemoryReceiver>();
  readonly #opportunities = new Map<string, SponsorshipOpportunity>();
  readonly #opportunityByBucket = new Map<string, string>();
  readonly #outcomes = new Map<string, SponsorshipOutcome>();
  readonly #claims = new Map<string, SponsorshipClaimRecord>();
  readonly #claimByOpportunity = new Map<string, string>();
  readonly #leases = new Map<string, SponsorshipDeliveryLease>();
  readonly #recoveries = new Map<string, MemoryRecovery>();
  readonly #expiredUnclaimed = new Map<string, ExpiredUnclaimedReservation>();
  readonly #releasedReservations = new Set<string>();
  readonly #serial = new KeyedSerialExecutor();
  readonly #opportunityBucketMs: number;
  readonly #opportunityTtlMs: number;

  constructor(input: { receivers?: readonly SponsorshipReceiver[]; opportunityWindowMs?: number; opportunityTtlMs?: number } = {}) {
    for (const receiver of input.receivers ?? []) this.#receivers.set(receiver.installationId, structuredClone(receiver));
    this.#opportunityBucketMs = input.opportunityWindowMs ?? 60_000;
    this.#opportunityTtlMs = input.opportunityTtlMs ?? this.#opportunityBucketMs;
  }

  get opportunityCount() { return this.#opportunities.size; }
  get claimCount() { return this.#claims.size; }

  pause(installationId: string) {
    const receiver = this.#receivers.get(installationId);
    if (receiver) receiver.status = "paused";
  }

  setOutcome(opportunityId: string, outcome: SponsorshipOutcome) {
    if (!this.#opportunities.has(opportunityId)) throw new Error("Unknown sponsorship opportunity");
    if (outcome.opportunityId !== opportunityId) throw new Error("Outcome opportunity mismatch");
    this.#outcomes.set(opportunityId, structuredClone(outcome));
  }

  async getReceiver(installationId: string) { return clone(this.#receivers.get(installationId)); }

  async getOpportunity(opportunityId: string) { return clone(this.#opportunities.get(opportunityId)); }

  async openOrGetOpportunity(receiver: SponsorshipReceiver, now: Date): Promise<SponsorshipOpportunity> {
    const active = [...this.#opportunities.values()]
      .filter((value) => value.installationId === receiver.installationId && value.consentVersion === receiver.consentVersion &&
        Date.parse(value.expiresAt) > now.getTime() && ["pending", "winner"].includes(this.#outcomes.get(value.opportunityId)?.status ?? ""))
      .sort((left, right) => right.openedAt.localeCompare(left.openedAt))[0];
    if (active) return clone(active)!;
    const bucket = Math.floor(now.getTime() / this.#opportunityBucketMs);
    const key = `${receiver.installationId}:${receiver.consentVersion}:${bucket}`;
    return this.#serial.run(key, () => {
      const existingId = this.#opportunityByBucket.get(key);
      if (existingId) return clone(this.#opportunities.get(existingId))!;
      const opportunityId = `opportunity:${receiver.installationId}:${receiver.consentVersion}:${bucket}`;
      const value: SponsorshipOpportunity = Object.freeze({
        opportunityId, auctionId: `auction:${opportunityId}`, receiverProfileId: receiver.receiverProfileId,
        installationId: receiver.installationId, consentVersion: receiver.consentVersion,
        openedAt: now.toISOString(), expiresAt: new Date(now.getTime() + this.#opportunityTtlMs).toISOString(),
      });
      this.#opportunityByBucket.set(key, opportunityId);
      this.#opportunities.set(opportunityId, value);
      this.#outcomes.set(opportunityId, { status: "pending", opportunityId, auctionId: value.auctionId });
      return clone(value)!;
    });
  }

  async getOutcome(opportunityId: string): Promise<SponsorshipOutcome> {
    const outcome = this.#outcomes.get(opportunityId);
    if (!outcome) throw new Error("Unknown sponsorship opportunity");
    return clone(outcome)!;
  }

  async getClaim(claimId: string) { return clone(this.#claims.get(claimId)); }

  async createOrGetClaim(record: SponsorshipClaimRecord): Promise<SponsorshipClaimRecord> {
    return this.#serial.run(record.opportunityId, () => {
      const existingId = this.#claimByOpportunity.get(record.opportunityId);
      if (existingId) {
        const existing = this.#claims.get(existingId)!;
        if (claimFingerprint(existing) !== claimFingerprint(record)) throw new Error("Sponsorship claim idempotency collision");
        return clone(existing)!;
      }
      const opportunity = this.#opportunities.get(record.opportunityId);
      const outcome = this.#outcomes.get(record.opportunityId);
      if (!opportunity || Date.parse(opportunity.expiresAt) <= Date.parse(record.issuedAt) || outcome?.status !== "winner" ||
        outcome.reservationId !== record.reservationId || this.#releasedReservations.has(record.reservationId)) {
        throw new Error("Winning reservation expired before claim persistence");
      }
      this.#claims.set(record.claimId, clone(record)!);
      this.#claimByOpportunity.set(record.opportunityId, record.claimId);
      return clone(record)!;
    });
  }

  async assertRedeemable(claim: SponsorshipClaimRecord, now: Date): Promise<SponsorshipOutcome & { status: "winner" }> {
    const receiver = this.#receivers.get(claim.installationId);
    if (!receiver || receiver.status !== "active" || receiver.consentVersion !== claim.consentVersion) throw new Error("Active consent version required");
    const outcome = this.#outcomes.get(claim.opportunityId);
    if (!outcome || outcome.status !== "winner" || outcome.placementId !== claim.placementId || outcome.reservationId !== claim.reservationId) {
      throw new Error("Winning reservation is no longer redeemable");
    }
    if (Date.parse(claim.expiresAt) <= now.getTime()) throw new Error("Sponsorship claim expired");
    return clone(outcome)!;
  }

  async assertSettlementOutcome(claim: SponsorshipClaimRecord): Promise<SponsorshipOutcome & { status: "winner" }> {
    const outcome = this.#outcomes.get(claim.opportunityId);
    if (!outcome || outcome.status !== "winner" || outcome.placementId !== claim.placementId || outcome.reservationId !== claim.reservationId) {
      throw new Error("Winning settlement outcome is unavailable");
    }
    return clone(outcome)!;
  }

  async issueOrGetLease(claim: SponsorshipClaimRecord, lease: SponsorshipDeliveryLease): Promise<SponsorshipDeliveryLease> {
    return this.#serial.run(claim.claimId, () => {
      const existing = this.#leases.get(claim.claimId);
      if (existing) return clone(existing)!;
      this.#leases.set(claim.claimId, clone(lease)!);
      const current = this.#claims.get(claim.claimId)!;
      current.state = "delivery_leased";
      return clone(lease)!;
    });
  }

  async getLease(claimId: string) { return clone(this.#leases.get(claimId)); }

  async acceptReceipt(input: {
    claim: SponsorshipClaimRecord; lease: SponsorshipDeliveryLease; receipt: SignedDisplayReceipt; receiptDigest: string;
    now: Date; graceExpiresAt: string; settlementReviewDeadlineAt: string;
  }): Promise<ReceiptAcceptance> {
    return this.#serial.run(input.claim.claimId, () => {
      const existing = this.#recoveries.get(input.claim.claimId);
      if (existing) {
        if (existing.receiptDigest !== input.receiptDigest) throw new Error("A different first verified surface already won");
        if (existing.settlementState === "settlement_review") throw new Error("Receipt recovery requires settlement review");
        if (existing.settlementState !== "settled" && existing.graceExpiresAt && Date.parse(existing.graceExpiresAt) <= input.now.getTime()) {
          throw new Error("Receipt recovery grace period expired");
        }
        return { receiptDigest: existing.receiptDigest, firstSurface: false, settlementState: existing.settlementState };
      }
      this.#recoveries.set(input.claim.claimId, { receiptDigest: input.receiptDigest, settlementState: "pending", graceExpiresAt: input.graceExpiresAt, settlementReviewDeadlineAt: input.settlementReviewDeadlineAt });
      this.#claims.get(input.claim.claimId)!.state = "consumed";
      this.#leases.get(input.claim.claimId)!.state = "displayed";
      return { receiptDigest: input.receiptDigest, firstSurface: true, settlementState: "pending" };
    });
  }

  async markSettled(claimId: string): Promise<void> {
    const recovery = this.#recoveries.get(claimId);
    if (!recovery) throw new Error("Receipt recovery is missing");
    recovery.settlementState = "settled";
  }

  async listExpirable(now: Date, deliveryLeaseReviewBefore: Date) {
    return [...this.#claims.values()].filter((claim) => {
      const recovery = this.#recoveries.get(claim.claimId);
      const lease = this.#leases.get(claim.claimId);
      return (["claimed", "expired", "cancelled"].includes(claim.state) && Date.parse(claim.expiresAt) <= now.getTime() &&
          !this.#releasedReservations.has(claim.reservationId)) ||
        (claim.state === "delivery_leased" && lease !== undefined && Date.parse(lease.expiresAt) <= deliveryLeaseReviewBefore.getTime()) ||
        (claim.state === "displayed_pending_receipt" && Date.parse(claim.expiresAt) <= now.getTime()) ||
        (claim.state === "consumed" && recovery?.settlementState === "pending" && recovery.graceExpiresAt !== undefined && Date.parse(recovery.graceExpiresAt) <= now.getTime());
    }).map((claim) => clone(claim)!);
  }

  async listExpiredUnclaimedReservations(now: Date): Promise<readonly ExpiredUnclaimedReservation[]> {
    const newlyExpired = [...this.#opportunities.values()].flatMap((opportunity) => {
      const outcome = this.#outcomes.get(opportunity.opportunityId);
      return Date.parse(opportunity.expiresAt) <= now.getTime() && !this.#claimByOpportunity.has(opportunity.opportunityId) &&
        outcome?.status === "winner" && !this.#releasedReservations.has(outcome.reservationId)
        ? [{ opportunityId: opportunity.opportunityId, campaignId: outcome.campaignId, reservationId: outcome.reservationId }]
        : [];
    });
    return [...newlyExpired, ...this.#expiredUnclaimed.values()].filter((value) => !this.#releasedReservations.has(value.reservationId));
  }

  async expireUnclaimedOpportunity(opportunityId: string): Promise<boolean> {
    return this.#serial.run(opportunityId, () => {
      const opportunity = this.#opportunities.get(opportunityId);
      if (!opportunity || this.#claimByOpportunity.has(opportunityId)) return false;
      const pending = this.#expiredUnclaimed.get(opportunityId);
      if (pending) return !this.#releasedReservations.has(pending.reservationId);
      const outcome = this.#outcomes.get(opportunityId);
      if (!outcome || outcome.status !== "winner") return false;
      this.#expiredUnclaimed.set(opportunityId, {
        opportunityId,
        campaignId: outcome.campaignId,
        reservationId: outcome.reservationId,
      });
      this.#outcomes.set(opportunityId, { status: "no_fill", opportunityId, auctionId: opportunity.auctionId, reason: "expired_unclaimed" });
      return true;
    });
  }

  async cancelExpired(claimId: string): Promise<boolean> {
    return this.#serial.run(claimId, () => {
      const claim = this.#claims.get(claimId);
      if (!claim || ["consumed", "delivery_leased", "displayed_pending_receipt", "settlement_review"].includes(claim.state) ||
        this.#releasedReservations.has(claim.reservationId)) return false;
      if (!["cancelled", "expired"].includes(claim.state)) claim.state = "expired";
      const lease = this.#leases.get(claimId);
      if (lease) lease.state = "expired";
      return true;
    });
  }

  async moveToSettlementReview(claimId: string): Promise<boolean> {
    const claim = this.#claims.get(claimId);
    if (!claim || !["delivery_leased", "displayed_pending_receipt", "consumed"].includes(claim.state)) return false;
    claim.state = "settlement_review";
    const recovery = this.#recoveries.get(claimId);
    if (recovery) recovery.settlementState = "settlement_review";
    return true;
  }

  async markReservationReleased(reservationId: string): Promise<void> {
    this.#releasedReservations.add(reservationId);
  }

  async recordDisplayedPendingReceipt(claimId: string, receiptDigest: string, now: Date): Promise<void> {
    void now;
    const claim = this.#claims.get(claimId);
    if (!claim) throw new Error("Unknown sponsorship claim");
    claim.state = "displayed_pending_receipt";
    this.#recoveries.set(claimId, { receiptDigest, settlementState: "pending" });
  }
}

export function signDisplayReceipt(payload: DisplayReceiptPayload, privateKeyPem: string): SignedDisplayReceipt {
  validateReceiptShape(payload);
  return Object.freeze({
    algorithm: "ES256" as const,
    payload: structuredClone(payload),
    signature: sign("sha256", Buffer.from(canonicalJson(payload)), { key: privateKeyPem, dsaEncoding: "ieee-p1363" }).toString("base64url"),
  });
}

export function verifyDisplayReceipt(receipt: SignedDisplayReceipt, publicJwk: JsonWebKey, now = new Date()): string {
  if (receipt?.algorithm !== "ES256" || typeof receipt.signature !== "string") throw new Error("Signed display receipt is malformed");
  validateReceiptShape(receipt.payload);
  if (Date.parse(receipt.payload.displayedAt) > now.getTime() + 30_000) throw new Error("Display receipt time is in the future");
  const valid = verify("sha256", Buffer.from(canonicalJson(receipt.payload)), {
    key: createPublicKey({ key: publicJwk as import("node:crypto").JsonWebKey, format: "jwk" }), dsaEncoding: "ieee-p1363",
  }, Buffer.from(receipt.signature, "base64url"));
  if (!valid) throw new Error("Display receipt signature is invalid");
  return digest(receipt.payload);
}

function signGrant(payload: Omit<SponsorshipGrantPayload, "grantDigest">, key: { keyId: string; privateKeyPem: string }): SignedSponsorshipGrant {
  const grantDigest = digest(payload);
  const complete = Object.freeze({ ...payload, grantDigest });
  return Object.freeze({
    algorithm: "Ed25519" as const,
    keyId: key.keyId,
    payload: complete,
    signature: sign(null, Buffer.from(canonicalJson(complete)), key.privateKeyPem).toString("base64url"),
  });
}

export function verifySponsorshipGrant(grant: SignedSponsorshipGrant, publicKeyPem: string, now = new Date()): SponsorshipGrantPayload {
  validateGrantShape(grant);
  if (!verify(null, Buffer.from(canonicalJson(grant.payload)), publicKeyPem, Buffer.from(grant.signature, "base64url"))) {
    throw new Error("Sponsorship grant signature is invalid");
  }
  const { grantDigest, ...unsigned } = grant.payload;
  if (digest(unsigned) !== grantDigest) throw new Error("Sponsorship grant digest is invalid");
  if (Date.parse(grant.payload.issuedAt) > now.getTime() + 30_000) throw new Error("Sponsorship grant was issued in the future");
  if (Date.parse(grant.payload.expiresAt) <= now.getTime()) throw new Error("Sponsorship grant expired");
  return structuredClone(grant.payload);
}

function validateGrantShape(grant: SignedSponsorshipGrant): void {
  const payload = grant?.payload;
  const amounts = [payload?.grossAmountMinor, payload?.receiverAmountMinor, payload?.operatorAmountMinor];
  if (grant?.algorithm !== "Ed25519" || !bounded(grant.keyId, "grant key ID") ||
    typeof grant.signature !== "string" || grant.signature.length < 32 || grant.signature.length > 512 || !/^[A-Za-z0-9_-]+$/.test(grant.signature) ||
    payload?.protocolVersion !== 1 || !bounded(payload.receiverAccountId, "receiver account ID") ||
    !bounded(payload.receiverProfileId, "receiver profile ID") || !bounded(payload.installationId, "installation ID") ||
    !bounded(payload.deviceKeyThumbprint, "device thumbprint") || !Number.isSafeInteger(payload.consentVersion) || payload.consentVersion < 1 ||
    !bounded(payload.opportunityId, "opportunity ID") || !bounded(payload.placementId, "placement ID") ||
    !bounded(payload.campaignId, "campaign ID") || !bounded(payload.reservationId, "reservation ID") ||
    !["stablecoin", "credits", "discount"].includes(payload.rewardType) ||
    !amounts.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    payload.receiverAmountMinor + payload.operatorAmountMinor !== payload.grossAmountMinor || payload.currency !== "USD" ||
    !SHA256.test(payload.creativeDigest) || !Number.isSafeInteger(payload.eligibleBidderCount) || payload.eligibleBidderCount < 1 ||
    !SHA256.test(payload.grantDigest) || !Number.isFinite(Date.parse(payload.issuedAt)) ||
    !Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.issuedAt) >= Date.parse(payload.expiresAt)) {
    throw new Error("Sponsorship grant is malformed");
  }
  assertOnlyKeys(grant, ["algorithm", "keyId", "payload", "signature"], "Sponsorship grant");
  assertOnlyKeys(payload, [
    "protocolVersion", "receiverAccountId", "receiverProfileId", "installationId", "deviceKeyThumbprint",
    "consentVersion", "opportunityId", "placementId", "campaignId", "reservationId", "rewardType",
    "grossAmountMinor", "receiverAmountMinor", "operatorAmountMinor", "currency", "creativeDigest",
    "eligibleBidderCount", "grantDigest", "issuedAt", "expiresAt",
  ], "Sponsorship grant payload");
}

function assertReceiptBinding(payload: DisplayReceiptPayload, claim: SponsorshipClaimRecord, lease: SponsorshipDeliveryLease): void {
  if (payload.claimId !== claim.claimId || payload.grantDigest !== claim.grant.payload.grantDigest ||
    payload.reservationId !== claim.reservationId || payload.placementId !== claim.placementId ||
    payload.creativeDigest !== claim.creativeDigest || payload.installationId !== claim.installationId ||
    payload.deviceKeyThumbprint !== claim.deviceKeyThumbprint || payload.policyVersion !== lease.policyVersion ||
    payload.surface !== "sidebar_session") throw new Error("Display receipt does not match the device-bound claim and lease");
}

function validateReceiptShape(payload: DisplayReceiptPayload): void {
  if (payload?.protocolVersion !== 1 || !bounded(payload.claimId, "claim ID") || !bounded(payload.grantDigest, "grant digest") ||
    !bounded(payload.reservationId, "reservation ID") || !bounded(payload.placementId, "placement ID") ||
    !SHA256.test(payload.creativeDigest) || !bounded(payload.installationId, "installation ID") ||
    !bounded(payload.deviceKeyThumbprint, "device thumbprint") || !["codex", "claude", "signed-html"].includes(payload.hostKind) ||
    !bounded(payload.hostSessionId, "host session ID") || (payload.hostTurnId !== undefined && !bounded(payload.hostTurnId, "host turn ID")) ||
    !SHA256.test(payload.outputSha256) || !bounded(payload.adapterVersion, "adapter version") ||
    !bounded(payload.policyVersion, "policy version") || payload.surface !== "sidebar_session" ||
    !/^ad-daddy:(test|development|staging|production)$/.test(payload.audience) || !bounded(payload.nonce, "receipt nonce") ||
    !Number.isFinite(Date.parse(payload.displayedAt))) throw new Error("Display receipt payload is malformed");
  assertOnlyKeys(payload, [
    "protocolVersion", "claimId", "grantDigest", "reservationId", "placementId", "creativeDigest",
    "installationId", "deviceKeyThumbprint", "hostKind", "hostSessionId", "hostTurnId", "outputSha256",
    "adapterVersion", "policyVersion", "surface", "audience", "nonce", "displayedAt",
  ], "Display receipt payload");
}

function validateWinner(outcome: SponsorshipOutcome & { status: "winner" }): void {
  if (!outcome.reservationId || !outcome.campaignId || !outcome.placementId || outcome.signedPlacement.payload.placementId !== outcome.placementId ||
    !Number.isSafeInteger(outcome.eligibleBidderCount) || outcome.eligibleBidderCount < 1 ||
    ![outcome.grossAmountMinor, outcome.receiverAmountMinor, outcome.operatorAmountMinor].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    outcome.receiverAmountMinor + outcome.operatorAmountMinor !== outcome.grossAmountMinor ||
    outcome.signedPlacement.payload.payout.amountMinor !== outcome.receiverAmountMinor) throw new Error("Winning sponsorship outcome is malformed");
}

function claimFingerprint(claim: SponsorshipClaimRecord) {
  return JSON.stringify([claim.placementId, claim.opportunityId, claim.reservationId, claim.receiverProfileId, claim.installationId,
    claim.consentVersion, claim.deviceKeyThumbprint, claim.creativeDigest]);
}

function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function bounded(value: string, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new Error(`${name} must be non-empty and bounded`);
  return value;
}
function duration(value: number, name: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is outside the supported range`);
  return value;
}
function assertOnlyKeys(value: object, allowed: readonly string[], name: string): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error(`${name} contains an unsupported field`);
}
function clone<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : structuredClone(value); }
