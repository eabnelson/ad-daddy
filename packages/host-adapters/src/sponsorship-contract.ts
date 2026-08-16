import { createHash, verify } from "node:crypto";

import { canonicalJson, type SignedPlacement, validateSignedPlacement } from "./contract.js";

const SHA256 = /^[a-f0-9]{64}$/;

export type AdDaddyEnvironment = "test" | "development" | "staging" | "production";

export interface SponsorshipGrantPayload {
  protocolVersion: 1;
  claimId: string;
  receiverAccountId: string;
  receiverProfileId: string;
  installationId: string;
  deviceKeyThumbprint: string;
  consentVersion: number;
  opportunityId: string;
  placementId: string;
  campaignId: string;
  reservationId: string;
  rewardType: "stablecoin" | "credits" | "discount";
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
  hostVersion: string;
  policyVersion: string;
  surface: "sidebar_session" | "signed_html";
  audience: `ad-daddy:${AdDaddyEnvironment}`;
  nonce: string;
  displayedAt: string;
}

export interface SignedDisplayReceipt {
  algorithm: "ES256";
  payload: DisplayReceiptPayload;
  signature: string;
}

export interface ClaimedPlacementEnvelope {
  claimId: string;
  grant: SignedSponsorshipGrant;
  lease: SponsorshipDeliveryLease;
  placement: SignedPlacement;
}

export function validateClaimedPlacementEnvelope(
  envelope: ClaimedPlacementEnvelope,
  publicKeyPem: string,
  now = new Date(),
): SponsorshipGrantPayload {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("Claimed placement envelope is malformed");
  assertExactKeys(envelope, ["claimId", "grant", "lease", "placement"], "Claimed placement envelope");
  const grant = verifySponsorshipGrant(envelope.grant, publicKeyPem, now);
  const placement = validateSignedPlacement(envelope.placement, publicKeyPem, now);
  validateLease(envelope.lease, now);
  const creativeDigest = digest(envelope.placement);
  if (envelope.claimId !== grant.claimId || envelope.lease.claimId !== grant.claimId) throw new Error("Sponsorship grant is bound to a different claim");
  if (placement.placementId !== grant.placementId || envelope.lease.creativeDigest !== grant.creativeDigest || creativeDigest !== grant.creativeDigest) {
    throw new Error("Sponsorship creative does not match the signed grant");
  }
  if (envelope.lease.installationId !== grant.installationId || envelope.lease.deviceKeyThumbprint !== grant.deviceKeyThumbprint) {
    throw new Error("Sponsorship delivery lease is bound to a different device");
  }
  if (placement.payout.amountMinor !== grant.receiverAmountMinor || placement.payout.currency !== grant.currency) {
    throw new Error("Sponsorship placement economics do not match the signed grant");
  }
  return Object.freeze(structuredClone(grant));
}

export function verifySponsorshipGrant(
  grant: SignedSponsorshipGrant,
  publicKeyPem: string,
  now = new Date(),
): SponsorshipGrantPayload {
  validateGrant(grant);
  if (!verify(null, Buffer.from(canonicalJson(grant.payload)), publicKeyPem, Buffer.from(grant.signature, "base64url"))) {
    throw new Error("Sponsorship grant signature is invalid");
  }
  const { grantDigest, ...unsigned } = grant.payload;
  if (digest(unsigned) !== grantDigest) throw new Error("Sponsorship grant digest is invalid");
  if (Date.parse(grant.payload.issuedAt) > now.getTime() + 30_000) throw new Error("Sponsorship grant was issued in the future");
  if (Date.parse(grant.payload.expiresAt) <= now.getTime()) throw new Error("Sponsorship grant expired");
  return Object.freeze(structuredClone(grant.payload));
}

function validateGrant(grant: SignedSponsorshipGrant): void {
  const payload = grant?.payload;
  const amounts = [payload?.grossAmountMinor, payload?.receiverAmountMinor, payload?.operatorAmountMinor];
  if (grant?.algorithm !== "Ed25519" || !bounded(grant.keyId, 128) || !base64url(grant.signature, 32, 512) ||
    payload?.protocolVersion !== 1 || !bounded(payload.claimId, 256) || !bounded(payload.receiverAccountId, 256) ||
    !bounded(payload.receiverProfileId, 256) || !bounded(payload.installationId, 128) || !base64url(payload.deviceKeyThumbprint, 43, 43) ||
    !Number.isSafeInteger(payload.consentVersion) || payload.consentVersion < 1 || !bounded(payload.opportunityId, 256) ||
    !bounded(payload.placementId, 256) || !bounded(payload.campaignId, 256) || !bounded(payload.reservationId, 256) ||
    !["stablecoin", "credits", "discount"].includes(payload.rewardType) ||
    !amounts.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    payload.receiverAmountMinor + payload.operatorAmountMinor !== payload.grossAmountMinor || payload.currency !== "USD" ||
    !SHA256.test(payload.creativeDigest) || !Number.isSafeInteger(payload.eligibleBidderCount) || payload.eligibleBidderCount < 1 ||
    !SHA256.test(payload.grantDigest) || !validPeriod(payload.issuedAt, payload.expiresAt)) {
    throw new Error("Sponsorship grant is malformed");
  }
  assertExactKeys(grant, ["algorithm", "keyId", "payload", "signature"], "Sponsorship grant");
  assertExactKeys(payload, [
    "protocolVersion", "claimId", "receiverAccountId", "receiverProfileId", "installationId", "deviceKeyThumbprint",
    "consentVersion", "opportunityId", "placementId", "campaignId", "reservationId", "rewardType",
    "grossAmountMinor", "receiverAmountMinor", "operatorAmountMinor", "currency", "creativeDigest",
    "eligibleBidderCount", "grantDigest", "issuedAt", "expiresAt",
  ], "Sponsorship grant payload");
}

function validateLease(lease: SponsorshipDeliveryLease, now: Date): void {
  if (!lease || typeof lease !== "object" || Array.isArray(lease) || !bounded(lease.leaseId, 256) || !bounded(lease.claimId, 256) ||
    !bounded(lease.installationId, 128) || !base64url(lease.deviceKeyThumbprint, 43, 43) || !SHA256.test(lease.creativeDigest) ||
    !bounded(lease.policyVersion, 128) || lease.state !== "active" || !validPeriod(lease.issuedAt, lease.expiresAt) ||
    Date.parse(lease.issuedAt) > now.getTime() + 30_000 || Date.parse(lease.expiresAt) <= now.getTime()) {
    throw new Error("Sponsorship delivery lease is malformed or inactive");
  }
  assertExactKeys(lease, [
    "leaseId", "claimId", "installationId", "deviceKeyThumbprint", "creativeDigest", "policyVersion", "state", "issuedAt", "expiresAt",
  ], "Sponsorship delivery lease");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function base64url(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum && /^[A-Za-z0-9_-]+$/.test(value);
}

function validPeriod(issuedAt: unknown, expiresAt: unknown): issuedAt is string {
  return typeof issuedAt === "string" && typeof expiresAt === "string" && Number.isFinite(Date.parse(issuedAt)) &&
    Number.isFinite(Date.parse(expiresAt)) && Date.parse(issuedAt) < Date.parse(expiresAt);
}

function assertExactKeys(value: object, allowed: readonly string[], name: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).length !== allowedSet.size || Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new Error(`${name} contains unsupported or missing fields`);
  }
}
