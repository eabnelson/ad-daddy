import { signPlacement } from "./signing-keys.ts";
import {
  SponsorshipClaimService,
  type ReceiptAcceptance,
  type SignedDisplayReceipt,
  type SponsorshipClaimRecord,
  type SponsorshipClaimRepository,
  type SponsorshipDeliveryLease,
  type ExpiredUnclaimedReservation,
  type SponsorshipOpportunity,
  type SponsorshipOutcome,
  type SponsorshipReceiver,
  type SponsorshipSettlementGateway,
} from "./sponsorship-claims.ts";
import type { AuctionGateway } from "./auction-gateway.ts";
import { cloudflareAuctionGateway } from "./auction-gateway.ts";
import type { AuctionDefinition } from "./auction.ts";
import { D1LedgerRepository } from "../payments/d1-repositories.ts";
import { LedgerService, LAUNCH_REVENUE_SPLIT } from "../payments/ledger.ts";
import {
  D1DeviceProofRepository,
  sha256BodyDigest,
  verifyDeviceProof,
  type DeviceProofRepository,
  type SignedDeviceProof,
} from "../auth/device-proof.ts";
import type { SponsorshipDeviceIdentity } from "./sponsorship-claims.ts";
import type { Environment, RewardType } from "../domain/types.ts";

type Row = Record<string, unknown>;
const OPPORTUNITY_BUCKET_MS = 60_000;
const OPPORTUNITY_TTL_MS = 5 * 60_000;
const AUCTION_WINDOW_MS = 15_000;

export interface SponsorshipRuntime {
  service: SponsorshipClaimService;
  proofs: DeviceProofRepository;
  environment: Environment;
  clock: () => Date;
}

export async function authenticateSponsorshipRequest(
  request: Request,
  rawBody: string,
  runtime: SponsorshipRuntime,
): Promise<SponsorshipDeviceIdentity> {
  const encoded = request.headers.get("x-ad-daddy-device-proof");
  if (!encoded || encoded.length > 16_384) throw new Error("Bounded device proof header required");
  let proof: SignedDeviceProof;
  try { proof = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SignedDeviceProof; }
  catch { throw new Error("Device proof header is malformed"); }
  const url = new URL(request.url);
  const verified = await verifyDeviceProof({
    proof,
    expected: {
      method: request.method,
      target: `${url.pathname}${url.search}`,
      environment: runtime.environment,
      bodyDigest: await sha256BodyDigest(rawBody),
    },
    repository: runtime.proofs,
    now: runtime.clock(),
  });
  return Object.freeze({
    accountId: verified.key.accountId,
    installationId: proof.envelope.installationId,
    consentVersion: proof.envelope.consentVersion,
    deviceKeyThumbprint: proof.envelope.keyThumbprint,
    devicePublicJwk: verified.key.publicJwk,
  });
}

export class D1SponsorshipClaimRepository implements SponsorshipClaimRepository {
  readonly #db: D1Database;
  readonly #auctionGateway: AuctionGateway;
  readonly #placementSigning: { keyId: string; privateKeyPem: string };
  readonly #clock: () => Date;
  readonly #creativeOrigin: string;

  constructor(db: D1Database, input: { auctionGateway: AuctionGateway; keyId: string; privateKeyPem: string; clock?: () => Date; creativeOrigin?: string }) {
    this.#db = db;
    this.#auctionGateway = input.auctionGateway;
    this.#placementSigning = { keyId: input.keyId, privateKeyPem: input.privateKeyPem };
    this.#clock = input.clock ?? (() => new Date());
    this.#creativeOrigin = new URL(input.creativeOrigin ?? "https://creative.ad-daddy.com").origin;
  }

  async getReceiver(installationId: string): Promise<SponsorshipReceiver | undefined> {
    const row = await this.#db.prepare(`SELECT rp.account_id AS accountId, rp.id AS receiverProfileId,
      rp.installation_id AS installationId, rp.current_consent_version AS consentVersion, rcv.status
      FROM receiver_profiles rp JOIN installations i ON i.id = rp.installation_id
      JOIN receiver_consent_versions rcv ON rcv.receiver_profile_id = rp.id AND rcv.version = rp.current_consent_version
      WHERE rp.installation_id = ? AND i.status = 'active'`).bind(installationId).first<Row>();
    return row ? {
      accountId: text(row.accountId), receiverProfileId: text(row.receiverProfileId), installationId: text(row.installationId),
      consentVersion: integer(row.consentVersion), status: text(row.status) as SponsorshipReceiver["status"],
    } : undefined;
  }

  async getOpportunity(opportunityId: string): Promise<SponsorshipOpportunity | undefined> {
    const row = await this.#db.prepare(`SELECT id AS opportunityId, receiver_profile_id AS receiverProfileId,
      installation_id AS installationId, consent_version AS consentVersion, opened_at AS openedAt, expires_at AS expiresAt
      FROM opportunities WHERE id = ?`).bind(opportunityId).first<Row>();
    return row ? { opportunityId: text(row.opportunityId), auctionId: `auction:${text(row.opportunityId)}`,
      receiverProfileId: text(row.receiverProfileId), installationId: text(row.installationId), consentVersion: integer(row.consentVersion),
      openedAt: text(row.openedAt), expiresAt: text(row.expiresAt) } : undefined;
  }

  async openOrGetOpportunity(receiver: SponsorshipReceiver, now: Date): Promise<SponsorshipOpportunity> {
    const proposedOpenedAt = now.toISOString();
    const proposedExpiresAt = new Date(now.getTime() + OPPORTUNITY_TTL_MS).toISOString();
    const profile = await this.#db.prepare(`SELECT published_fields_json AS fieldsJson FROM profile_snapshots
      WHERE receiver_profile_id = ? AND consent_version = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY published_at DESC LIMIT 1`).bind(receiver.receiverProfileId, receiver.consentVersion, proposedOpenedAt).first<{ fieldsJson: string }>();
    if (!profile) throw new Error("Active published receiver profile required");
    const fields = safeRecord(JSON.parse(profile.fieldsJson));
    const minimumTakeHomeMinor = safeInteger(fields.minimumTakeHomeMinor, 0);
    const rewardLane = rewardType(fields.acceptedRewardTypes);
    const matchedSignals = signalNames(fields);
    const active = await this.#db.prepare(`SELECT id FROM opportunities
      WHERE receiver_profile_id = ? AND installation_id = ? AND consent_version = ?
        AND state IN ('bidding', 'won') AND expires_at > ?
      ORDER BY opened_at DESC LIMIT 1`)
      .bind(receiver.receiverProfileId, receiver.installationId, receiver.consentVersion, proposedOpenedAt).first<{ id: string }>();
    const bucket = Math.floor(now.getTime() / OPPORTUNITY_BUCKET_MS);
    const opportunityId = active?.id ?? `pull:${receiver.installationId}:${receiver.consentVersion}:${bucket}`;
    const auctionId = `auction:${opportunityId}`;
    if (!active) {
      await this.#db.prepare(`INSERT INTO opportunities
        (id, rotating_opportunity_id, receiver_profile_id, installation_id, consent_version, state, opened_at, expires_at)
        VALUES (?, ?, ?, ?, ?, 'bidding', ?, ?) ON CONFLICT(rotating_opportunity_id) DO NOTHING`)
        .bind(opportunityId, opportunityId, receiver.receiverProfileId, receiver.installationId, receiver.consentVersion, proposedOpenedAt, proposedExpiresAt).run();
    }
    const persisted = await this.#db.prepare(`SELECT id, receiver_profile_id AS receiverProfileId, installation_id AS installationId,
      consent_version AS consentVersion, opened_at AS openedAt, expires_at AS expiresAt FROM opportunities WHERE rotating_opportunity_id = ?`)
      .bind(opportunityId).first<Row>();
    if (!persisted || text(persisted.id) !== opportunityId || text(persisted.receiverProfileId) !== receiver.receiverProfileId ||
      text(persisted.installationId) !== receiver.installationId || integer(persisted.consentVersion) !== receiver.consentVersion) {
      throw new Error("Sponsorship opportunity coalescing collision");
    }
    const openedAt = text(persisted.openedAt);
    const expiresAt = text(persisted.expiresAt);
    const definition: AuctionDefinition = {
      auctionId, opportunityId, rewardLane, consentVersion: receiver.consentVersion,
      minimumTakeHomeMinor, matchedSignalNames: matchedSignals,
      closesAt: new Date(Math.min(Date.parse(expiresAt), Date.parse(openedAt) + AUCTION_WINDOW_MS)).toISOString(),
    };
    const response = await this.#auctionGateway.open(definition);
    if (!response.ok) throw new Error(`Auction open failed (${response.status})`);
    return { opportunityId, auctionId, receiverProfileId: receiver.receiverProfileId, installationId: receiver.installationId,
      consentVersion: receiver.consentVersion, openedAt, expiresAt };
  }

  async getOutcome(opportunityId: string): Promise<SponsorshipOutcome> {
    const row = await this.#db.prepare(`SELECT a.id AS auctionId, a.matched_signal_names_json AS matchedSignalsJson,
      d.winner_bid_id AS winnerBidId,
      d.reservation_id AS reservationId, d.eligible_bidder_count AS eligibleBidderCount, d.no_fill_reason AS noFillReason,
      b.campaign_id AS campaignId, b.reward_lane AS rewardType, b.gross_amount_minor AS grossAmountMinor,
      b.receiver_amount_minor AS receiverAmountMinor, b.operator_amount_minor AS operatorAmountMinor,
      c.status AS campaignStatus, c.destination_url AS destinationUrl, c.creative_json AS creativeJson,
      c.schedule_ends_at AS campaignEndsAt, br.id AS advertiserId, br.name AS advertiserName,
      r.status AS reservationStatus, r.amount_minor AS reservationAmountMinor
      FROM auctions a LEFT JOIN auction_decisions d ON d.auction_id = a.id
      LEFT JOIN auction_bids b ON b.id = d.winner_bid_id LEFT JOIN campaigns c ON c.id = b.campaign_id
      LEFT JOIN advertiser_brands br ON br.id = c.brand_id LEFT JOIN campaign_budget_reservations r ON r.id = d.reservation_id
      WHERE a.opportunity_id = ?`).bind(opportunityId).first<Row>();
    if (!row) throw new Error("Sponsorship auction not found");
    const auctionId = text(row.auctionId);
    if (row.winnerBidId === null && row.noFillReason === null) return { status: "pending", opportunityId, auctionId };
    if (row.winnerBidId === null) return { status: "no_fill", opportunityId, auctionId, reason: text(row.noFillReason) };
    if (!row.reservationId || row.reservationStatus !== "reserved" || row.campaignStatus !== "active" || row.reservationAmountMinor !== row.grossAmountMinor) {
      return { status: "no_fill", opportunityId, auctionId, reason: "winner_unavailable" };
    }
    const placementId = `placement:${opportunityId}`;
    const existing = await this.#db.prepare("SELECT signed_placement_json AS signedPlacementJson FROM placements WHERE id = ?")
      .bind(placementId).first<{ signedPlacementJson: string | null }>();
    let signedPlacement;
    if (existing?.signedPlacementJson) signedPlacement = JSON.parse(existing.signedPlacementJson);
    else {
      const creative = safeRecord(JSON.parse(text(row.creativeJson)));
      const issuedAt = this.#clock().toISOString();
      signedPlacement = signPlacement({
        protocolVersion: 1, placementId,
        advertiser: { id: text(row.advertiserId), displayName: text(row.advertiserName) },
        title: typeof creative.headline === "string" ? creative.headline.slice(0, 120) : "A sponsored tool for your project",
        contentReference: `${this.#creativeOrigin}/creative/${encodeURIComponent(placementId)}`,
        destinationUrl: text(row.destinationUrl), disclosure: "Sponsored",
        payout: { amountMinor: integer(row.receiverAmountMinor), currency: "USD" }, signalsUsed: stringArray(row.matchedSignalsJson, 20, 80),
        creative: { body: typeof creative.body === "string" ? creative.body.slice(0, 4_000) : "Sponsored via Ad Daddy", attachments: [] },
        issuedAt, expiresAt: text(row.campaignEndsAt),
      }, this.#placementSigning);
      await this.#db.batch([
        this.#db.prepare(`INSERT OR IGNORE INTO revenue_split_versions
          (version, receiver_basis_points, operator_basis_points, effective_at) VALUES (?, ?, ?, ?)`)
          .bind(LAUNCH_REVENUE_SPLIT.version, LAUNCH_REVENUE_SPLIT.receiverBasisPoints, LAUNCH_REVENUE_SPLIT.operatorBasisPoints, issuedAt),
        this.#db.prepare(`INSERT OR IGNORE INTO placements
          (id, opportunity_id, consent_version, revenue_split_version, state, idempotency_key,
           gross_amount_minor, receiver_amount_minor, operator_amount_minor, currency, signed_placement_json, delivery_status)
          SELECT ?, o.id, o.consent_version, ?, 'won', ?, ?, ?, ?, 'USD', ?, 'ready'
          FROM opportunities o WHERE o.id = ?`)
          .bind(placementId, LAUNCH_REVENUE_SPLIT.version, `pull:${opportunityId}`, integer(row.grossAmountMinor),
            integer(row.receiverAmountMinor), integer(row.operatorAmountMinor), JSON.stringify(signedPlacement), opportunityId),
      ]);
      const persisted = await this.#db.prepare("SELECT signed_placement_json AS signedPlacementJson FROM placements WHERE id = ?")
        .bind(placementId).first<{ signedPlacementJson: string | null }>();
      if (!persisted?.signedPlacementJson) throw new Error("Winning placement was not persisted");
      signedPlacement = JSON.parse(persisted.signedPlacementJson);
    }
    return {
      status: "winner", opportunityId, auctionId, placementId, campaignId: text(row.campaignId),
      reservationId: text(row.reservationId), eligibleBidderCount: integer(row.eligibleBidderCount),
      rewardType: text(row.rewardType) as RewardType, grossAmountMinor: integer(row.grossAmountMinor),
      receiverAmountMinor: integer(row.receiverAmountMinor), operatorAmountMinor: integer(row.operatorAmountMinor),
      currency: "USD", signedPlacement,
    };
  }

  async getClaim(claimId: string) {
    const row = await this.#db.prepare(`${CLAIM_SELECT} WHERE pc.id = ?`).bind(claimId).first<Row>();
    return row ? claim(row) : undefined;
  }

  async createOrGetClaim(record: SponsorshipClaimRecord): Promise<SponsorshipClaimRecord> {
    await this.#db.prepare(`INSERT INTO placement_claims
      (id, placement_id, opportunity_id, reservation_id, receiver_profile_id, installation_id, consent_version,
       device_key_thumbprint, creative_digest, state, grant_json, issued_at, expires_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ? FROM opportunities o
      JOIN placements p ON p.id = ? AND p.opportunity_id = o.id AND p.state = 'won'
      JOIN auctions a ON a.opportunity_id = o.id
      JOIN auction_decisions d ON d.auction_id = a.id
      JOIN auction_bids b ON b.id = d.winner_bid_id
      JOIN campaign_budget_reservations r ON r.id = d.reservation_id AND r.campaign_id = b.campaign_id
      WHERE o.id = ? AND o.state = 'won' AND o.receiver_profile_id = ? AND o.installation_id = ?
        AND o.consent_version = ? AND o.expires_at > ? AND d.reservation_id = ?
        AND b.campaign_id = ? AND r.status = 'reserved' AND r.amount_minor = ? AND p.gross_amount_minor = ?
      ON CONFLICT(opportunity_id) DO NOTHING`)
      .bind(record.claimId, record.placementId, record.opportunityId, record.reservationId, record.receiverProfileId,
        record.installationId, record.consentVersion, record.deviceKeyThumbprint, record.creativeDigest,
        JSON.stringify(record.grant), record.issuedAt, record.expiresAt, record.placementId, record.opportunityId,
        record.receiverProfileId, record.installationId, record.consentVersion, record.issuedAt, record.reservationId,
        record.grant.payload.campaignId, record.grant.payload.grossAmountMinor, record.grant.payload.grossAmountMinor).run();
    const storedRow = await this.#db.prepare(`${CLAIM_SELECT} WHERE pc.opportunity_id = ?`).bind(record.opportunityId).first<Row>();
    if (!storedRow) throw new Error("Sponsorship claim persistence failed");
    const stored = claim(storedRow);
    if (claimBinding(stored) !== claimBinding(record)) throw new Error("Sponsorship claim idempotency collision");
    await this.#db.prepare("UPDATE placements SET state = 'claimed', updated_at = ? WHERE id = ? AND state = 'won'")
      .bind(record.issuedAt, record.placementId).run();
    return stored;
  }

  async assertRedeemable(value: SponsorshipClaimRecord, now: Date): Promise<SponsorshipOutcome & { status: "winner" }> {
    const receiver = await this.getReceiver(value.installationId);
    if (!receiver || receiver.status !== "active" || receiver.consentVersion !== value.consentVersion) throw new Error("Active consent version required");
    const outcome = await this.getOutcome(value.opportunityId);
    if (outcome.status !== "winner" || outcome.placementId !== value.placementId || outcome.reservationId !== value.reservationId ||
      Date.parse(value.expiresAt) <= now.getTime()) throw new Error("Winning reservation is no longer redeemable");
    return outcome;
  }

  async assertSettlementOutcome(value: SponsorshipClaimRecord): Promise<SponsorshipOutcome & { status: "winner" }> {
    const row = await this.#db.prepare(`SELECT a.id AS auctionId, b.campaign_id AS campaignId, b.reward_lane AS rewardType,
      b.gross_amount_minor AS grossAmountMinor, b.receiver_amount_minor AS receiverAmountMinor,
      b.operator_amount_minor AS operatorAmountMinor, d.eligible_bidder_count AS eligibleBidderCount,
      d.reservation_id AS reservationId, r.amount_minor AS reservationAmountMinor, r.status AS reservationStatus,
      p.signed_placement_json AS signedPlacementJson
      FROM placement_claims pc JOIN auctions a ON a.opportunity_id = pc.opportunity_id
      JOIN auction_decisions d ON d.auction_id = a.id JOIN auction_bids b ON b.id = d.winner_bid_id
      JOIN campaign_budget_reservations r ON r.id = d.reservation_id JOIN placements p ON p.id = pc.placement_id
      WHERE pc.id = ?`).bind(value.claimId).first<Row>();
    if (!row || text(row.reservationId) !== value.reservationId || !["reserved", "committed"].includes(text(row.reservationStatus)) ||
      integer(row.reservationAmountMinor) !== integer(row.grossAmountMinor)) throw new Error("Winning settlement outcome is unavailable");
    return {
      status: "winner", opportunityId: value.opportunityId, auctionId: text(row.auctionId), placementId: value.placementId,
      campaignId: text(row.campaignId), reservationId: value.reservationId, eligibleBidderCount: integer(row.eligibleBidderCount),
      rewardType: text(row.rewardType) as RewardType, grossAmountMinor: integer(row.grossAmountMinor),
      receiverAmountMinor: integer(row.receiverAmountMinor), operatorAmountMinor: integer(row.operatorAmountMinor), currency: "USD",
      signedPlacement: JSON.parse(text(row.signedPlacementJson)),
    };
  }

  async issueOrGetLease(value: SponsorshipClaimRecord, lease: SponsorshipDeliveryLease): Promise<SponsorshipDeliveryLease> {
    await this.#db.prepare(`INSERT INTO placement_delivery_leases
      (id, claim_id, installation_id, device_key_thumbprint, creative_digest, policy_version, state, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?) ON CONFLICT(claim_id) DO NOTHING`)
      .bind(lease.leaseId, lease.claimId, lease.installationId, lease.deviceKeyThumbprint, lease.creativeDigest,
        lease.policyVersion, lease.issuedAt, lease.expiresAt).run();
    const row = await this.#db.prepare(`${LEASE_SELECT} WHERE claim_id = ?`).bind(value.claimId).first<Row>();
    if (!row) throw new Error("Delivery lease persistence failed");
    const stored = deliveryLease(row);
    if (stored.installationId !== value.installationId || stored.deviceKeyThumbprint !== value.deviceKeyThumbprint || stored.creativeDigest !== value.creativeDigest) {
      throw new Error("Delivery lease device binding collision");
    }
    await this.#db.batch([
      this.#db.prepare("UPDATE placement_claims SET state = 'delivery_leased' WHERE id = ? AND state = 'claimed'").bind(value.claimId),
      this.#db.prepare("UPDATE placements SET state = 'delivery_leased', updated_at = ? WHERE id = ? AND state IN ('won', 'claimed')").bind(lease.issuedAt, value.placementId),
    ]);
    return stored;
  }

  async getLease(claimId: string) {
    const row = await this.#db.prepare(`${LEASE_SELECT} WHERE claim_id = ?`).bind(claimId).first<Row>();
    return row ? deliveryLease(row) : undefined;
  }

  async acceptReceipt(input: {
    claim: SponsorshipClaimRecord; lease: SponsorshipDeliveryLease; receipt: SignedDisplayReceipt; receiptDigest: string;
    now: Date; graceExpiresAt: string; settlementReviewDeadlineAt: string;
  }): Promise<ReceiptAcceptance> {
    const inserted = await this.#db.prepare(`INSERT INTO placement_receipt_recovery
      (claim_id, placement_id, lease_id, display_receipt_digest, state, policy_version, resolution_authority,
       displayed_at, grace_expires_at, settlement_review_deadline_at, receipt_submitted_at)
      VALUES (?, ?, ?, ?, 'submitted', ?, 'operator_dual_control', ?, ?, ?, ?) ON CONFLICT(claim_id) DO NOTHING`)
      .bind(input.claim.claimId, input.claim.placementId, input.lease.leaseId, input.receiptDigest, input.lease.policyVersion,
        input.receipt.payload.displayedAt, input.graceExpiresAt, input.settlementReviewDeadlineAt, input.now.toISOString()).run();
    const row = await this.#db.prepare("SELECT display_receipt_digest AS receiptDigest, state, grace_expires_at AS graceExpiresAt FROM placement_receipt_recovery WHERE claim_id = ?")
      .bind(input.claim.claimId).first<{ receiptDigest: string; state: string; graceExpiresAt: string }>();
    if (!row) throw new Error("Receipt recovery persistence failed");
    if (row.receiptDigest !== input.receiptDigest) throw new Error("A different first verified surface already won");
    if (row.state === "settlement_review") throw new Error("Receipt recovery requires settlement review");
    if (row.state !== "settled" && Date.parse(row.graceExpiresAt) <= input.now.getTime()) throw new Error("Receipt recovery grace period expired");
    await this.#db.batch([
      this.#db.prepare("UPDATE placement_claims SET state = 'consumed', consumed_at = COALESCE(consumed_at, ?) WHERE id = ? AND state IN ('claimed', 'delivery_leased', 'displayed_pending_receipt', 'consumed')")
        .bind(input.now.toISOString(), input.claim.claimId),
      this.#db.prepare("UPDATE placement_delivery_leases SET state = 'displayed', displayed_at = COALESCE(displayed_at, ?) WHERE claim_id = ? AND state IN ('active', 'displayed')")
        .bind(input.receipt.payload.displayedAt, input.claim.claimId),
      this.#db.prepare(`UPDATE placements SET state = 'delivered', delivery_status = 'delivered', host_kind = ?,
        host_session_id = ?, host_turn_id = ?, host_receipt_json = ?, rendered_response_sha256 = ?, updated_at = ? WHERE id = ? AND state IN ('claimed', 'delivery_leased', 'delivered')`)
        .bind(input.receipt.payload.hostKind, input.receipt.payload.hostSessionId, input.receipt.payload.hostTurnId ?? null,
          JSON.stringify(input.receipt), input.receipt.payload.outputSha256, input.now.toISOString(), input.claim.placementId),
    ]);
    return { receiptDigest: row.receiptDigest, firstSurface: (inserted.meta.changes ?? 0) === 1, settlementState: row.state === "settled" ? "settled" : "pending" };
  }

  async markSettled(claimId: string, settledAt: string) {
    await this.#db.batch([
      this.#db.prepare("UPDATE placement_receipt_recovery SET state = 'settled', resolved_at = ? WHERE claim_id = ? AND state IN ('submitted', 'settled')").bind(settledAt, claimId),
      this.#db.prepare("UPDATE placements SET state = 'settled', updated_at = ? WHERE id = (SELECT placement_id FROM placement_claims WHERE id = ?)").bind(settledAt, claimId),
    ]);
  }

  async listExpirable(now: Date, deliveryLeaseReviewBefore: Date) {
    const rows = await this.#db.prepare(`${CLAIM_SELECT}
      JOIN campaign_budget_reservations cbr ON cbr.id = pc.reservation_id
      LEFT JOIN placement_delivery_leases pdl ON pdl.claim_id = pc.id
      LEFT JOIN placement_receipt_recovery prr ON prr.claim_id = pc.id
      WHERE (pc.state IN ('claimed', 'expired', 'cancelled') AND pc.expires_at <= ? AND cbr.status = 'reserved')
         OR (pc.state = 'delivery_leased' AND pdl.expires_at <= ?)
         OR (pc.state = 'displayed_pending_receipt' AND pc.expires_at <= ?)
         OR (pc.state = 'consumed' AND prr.state = 'submitted' AND prr.grace_expires_at <= ?)`)
      .bind(now.toISOString(), deliveryLeaseReviewBefore.toISOString(), now.toISOString(), now.toISOString()).all<Row>();
    return rows.results.map(claim);
  }

  async listExpiredUnclaimedReservations(now: Date): Promise<readonly ExpiredUnclaimedReservation[]> {
    const rows = await this.#db.prepare(`SELECT o.id AS opportunityId, b.campaign_id AS campaignId, d.reservation_id AS reservationId
      FROM opportunities o JOIN auctions a ON a.opportunity_id = o.id JOIN auction_decisions d ON d.auction_id = a.id
      JOIN auction_bids b ON b.id = d.winner_bid_id JOIN campaign_budget_reservations r ON r.id = d.reservation_id
      LEFT JOIN placement_claims pc ON pc.opportunity_id = o.id
      WHERE ((o.state = 'won' AND o.expires_at <= ?)
          OR (o.state = 'expired' AND o.invalidated_reason = 'unclaimed_expiry'))
        AND pc.id IS NULL AND r.status = 'reserved'`)
      .bind(now.toISOString()).all<Row>();
    return rows.results.map((row) => ({ opportunityId: text(row.opportunityId), campaignId: text(row.campaignId), reservationId: text(row.reservationId) }));
  }

  async expireUnclaimedOpportunity(opportunityId: string, now: Date): Promise<boolean> {
    const result = await this.#db.prepare(`UPDATE opportunities SET state = 'expired', invalidated_reason = 'unclaimed_expiry'
      WHERE id = ? AND state IN ('won', 'expired') AND expires_at <= ?
        AND (state = 'won' OR invalidated_reason = 'unclaimed_expiry')
        AND NOT EXISTS (SELECT 1 FROM placement_claims WHERE opportunity_id = ?)`)
      .bind(opportunityId, now.toISOString(), opportunityId).run();
    if ((result.meta.changes ?? 0) !== 1) return false;
    await this.#db.prepare(`UPDATE placements SET state = 'expired', delivery_status = 'expired', updated_at = ?
      WHERE opportunity_id = ? AND state = 'won'`).bind(now.toISOString(), opportunityId).run();
    return true;
  }

  async cancelExpired(claimId: string, now: Date) {
    const result = await this.#db.prepare(`UPDATE placement_claims SET state = 'expired', cancelled_at = COALESCE(cancelled_at, ?)
      WHERE id = ? AND state IN ('claimed', 'expired', 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM placement_receipt_recovery WHERE claim_id = placement_claims.id)`)
      .bind(now.toISOString(), claimId).run();
    if ((result.meta.changes ?? 0) === 1) {
      await this.#db.batch([
        this.#db.prepare("UPDATE placement_delivery_leases SET state = 'expired' WHERE claim_id = ? AND state = 'active'").bind(claimId),
        this.#db.prepare("UPDATE placements SET state = 'expired', delivery_status = 'expired', updated_at = ? WHERE id = (SELECT placement_id FROM placement_claims WHERE id = ?)").bind(now.toISOString(), claimId),
      ]);
      return true;
    }
    return false;
  }

  async moveToSettlementReview(claimId: string, now: Date) {
    const result = await this.#db.prepare("UPDATE placement_claims SET state = 'settlement_review' WHERE id = ? AND state IN ('delivery_leased', 'displayed_pending_receipt', 'consumed')").bind(claimId).run();
    if ((result.meta.changes ?? 0) === 1) {
      await this.#db.batch([
        this.#db.prepare("UPDATE placement_receipt_recovery SET state = 'settlement_review' WHERE claim_id = ? AND state IN ('submitted', 'pending')").bind(claimId),
        this.#db.prepare("UPDATE placements SET state = 'settlement_review', updated_at = ? WHERE id = (SELECT placement_id FROM placement_claims WHERE id = ?)").bind(now.toISOString(), claimId),
      ]);
      return true;
    }
    return false;
  }

  async markReservationReleased(reservationId: string): Promise<void> {
    const reservation = await this.#db.prepare("SELECT status FROM campaign_budget_reservations WHERE id = ?")
      .bind(reservationId).first<{ status: string }>();
    if (reservation?.status !== "released") throw new Error("Campaign reservation release did not persist");
  }
}

export class D1SponsorshipSettlementGateway implements SponsorshipSettlementGateway {
  readonly #db: D1Database;
  readonly #ledger: LedgerService;
  constructor(db: D1Database) { this.#db = db; this.#ledger = new LedgerService(new D1LedgerRepository(db)); }

  async settle(input: { claim: SponsorshipClaimRecord; outcome: SponsorshipOutcome & { status: "winner" }; receipt: SignedDisplayReceipt }) {
    if (input.outcome.rewardType !== "stablecoin") throw new Error("Receiver pull settlement currently supports stablecoin auctions only");
    const reservation = await this.#db.prepare("SELECT status, amount_minor AS amountMinor FROM campaign_budget_reservations WHERE id = ? AND campaign_id = ?")
      .bind(input.claim.reservationId, input.outcome.campaignId).first<{ status: string; amountMinor: number }>();
    if (reservation?.amountMinor !== input.outcome.grossAmountMinor) throw new Error("Winning reservation amount does not match auction economics");
    if (reservation?.status === "reserved") {
      const settledAt = new Date().toISOString();
      await this.#db.batch([
        this.#db.prepare(`UPDATE campaigns SET spent_minor = spent_minor + ?, updated_at = ? WHERE id = ?
          AND EXISTS (SELECT 1 FROM campaign_budget_reservations WHERE id = ? AND campaign_id = ? AND status = 'reserved')`)
          .bind(input.outcome.grossAmountMinor, settledAt, input.outcome.campaignId, input.claim.reservationId, input.outcome.campaignId),
        this.#db.prepare("UPDATE campaign_budget_reservations SET status = 'committed', committed_at = ? WHERE id = ? AND campaign_id = ? AND status = 'reserved'")
          .bind(settledAt, input.claim.reservationId, input.outcome.campaignId),
      ]);
    } else if (reservation?.status !== "committed") throw new Error("Winning reservation is not available for settlement");
    const campaign = await this.#db.prepare("SELECT account_id AS accountId FROM campaigns WHERE id = ?")
      .bind(input.outcome.campaignId).first<{ accountId: string }>();
    if (!campaign) throw new Error("Campaign settlement authority is missing");
    await this.#ledger.post({
      transactionId: `placement_settlement:${input.claim.placementId}`,
      idempotencyKey: `placement:${input.claim.placementId}:base:${LAUNCH_REVENUE_SPLIT.version}`,
      kind: "placement_settlement", currency: "USDC", referenceId: input.claim.placementId, splitVersion: LAUNCH_REVENUE_SPLIT.version,
      entries: [
        { accountId: `advertiser:${campaign.accountId}`, amountMinor: -input.outcome.grossAmountMinor },
        { accountId: `receiver:${input.claim.grant.payload.receiverAccountId}`, amountMinor: input.outcome.receiverAmountMinor },
        { accountId: "operator:ad-daddy", amountMinor: input.outcome.operatorAmountMinor },
      ],
    });
  }

  async release(input: { campaignId: string; reservationId: string; claimId: string }) {
    const unclaimedOpportunityId = input.claimId.startsWith("unclaimed:") ? input.claimId.slice("unclaimed:".length) : undefined;
    await this.#db.prepare(`UPDATE campaign_budget_reservations SET status = 'released', released_at = ?
      WHERE id = ? AND campaign_id = ? AND status = 'reserved'
        AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM placement_claims WHERE opportunity_id = ?))`)
      .bind(new Date().toISOString(), input.reservationId, input.campaignId, unclaimedOpportunityId ?? null, unclaimedOpportunityId ?? null).run();
  }
}

let cachedRuntime: SponsorshipRuntime | undefined;

export async function deployedSponsorshipRuntime(): Promise<SponsorshipRuntime> {
  if (cachedRuntime) return cachedRuntime;
  const { env } = await import("cloudflare:workers");
  if (!env.DB || !env.AD_DADDY_SPONSORSHIP_SIGNING_PRIVATE_KEY || !env.AD_DADDY_SPONSORSHIP_SIGNING_KEY_ID) {
    throw new Error("Sponsorship D1 and signing secret bindings are required");
  }
  const repository = new D1SponsorshipClaimRepository(env.DB, {
    auctionGateway: cloudflareAuctionGateway,
    keyId: env.AD_DADDY_SPONSORSHIP_SIGNING_KEY_ID,
    privateKeyPem: env.AD_DADDY_SPONSORSHIP_SIGNING_PRIVATE_KEY,
    creativeOrigin: "https://creative.ad-daddy.com",
  });
  cachedRuntime = {
    environment: env.AD_DADDY_ENV,
    clock: () => new Date(),
    proofs: new D1DeviceProofRepository(env.DB),
    service: new SponsorshipClaimService(repository, {
      keyId: env.AD_DADDY_SPONSORSHIP_SIGNING_KEY_ID,
      privateKeyPem: env.AD_DADDY_SPONSORSHIP_SIGNING_PRIVATE_KEY,
      claimTtlMs: 15 * 60_000, leaseTtlMs: 60_000, receiptGraceMs: 24 * 60 * 60_000,
      settlementReviewMs: 7 * 24 * 60 * 60_000, settlement: new D1SponsorshipSettlementGateway(env.DB),
      environment: env.AD_DADDY_ENV,
    }),
  };
  return cachedRuntime;
}

const CLAIM_SELECT = `SELECT pc.id AS claimId, pc.placement_id AS placementId, pc.opportunity_id AS opportunityId,
  pc.reservation_id AS reservationId, pc.receiver_profile_id AS receiverProfileId, pc.installation_id AS installationId,
  pc.consent_version AS consentVersion, pc.device_key_thumbprint AS deviceKeyThumbprint, pc.creative_digest AS creativeDigest,
  pc.state, pc.grant_json AS grantJson, pc.issued_at AS issuedAt, pc.expires_at AS expiresAt FROM placement_claims pc`;
const LEASE_SELECT = `SELECT id AS leaseId, claim_id AS claimId, installation_id AS installationId,
  device_key_thumbprint AS deviceKeyThumbprint, creative_digest AS creativeDigest, policy_version AS policyVersion,
  state, issued_at AS issuedAt, expires_at AS expiresAt FROM placement_delivery_leases`;

function claim(row: Row): SponsorshipClaimRecord {
  return { claimId: text(row.claimId), placementId: text(row.placementId), opportunityId: text(row.opportunityId),
    reservationId: text(row.reservationId), receiverProfileId: text(row.receiverProfileId), installationId: text(row.installationId),
    consentVersion: integer(row.consentVersion), deviceKeyThumbprint: text(row.deviceKeyThumbprint), creativeDigest: text(row.creativeDigest),
    state: text(row.state) as SponsorshipClaimRecord["state"], grant: JSON.parse(text(row.grantJson)), issuedAt: text(row.issuedAt), expiresAt: text(row.expiresAt) };
}
function deliveryLease(row: Row): SponsorshipDeliveryLease {
  return { leaseId: text(row.leaseId), claimId: text(row.claimId), installationId: text(row.installationId),
    deviceKeyThumbprint: text(row.deviceKeyThumbprint), creativeDigest: text(row.creativeDigest), policyVersion: text(row.policyVersion),
    state: text(row.state) as SponsorshipDeliveryLease["state"], issuedAt: text(row.issuedAt), expiresAt: text(row.expiresAt) };
}
function claimBinding(value: SponsorshipClaimRecord) { return JSON.stringify([value.placementId, value.opportunityId, value.reservationId, value.receiverProfileId, value.installationId, value.consentVersion, value.deviceKeyThumbprint, value.creativeDigest]); }
function text(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("Durable sponsorship row is malformed"); return value; }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Durable sponsorship row is malformed"); return value; }
function safeRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function safeInteger(value: unknown, fallback: number) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback; }
function stringArray(value: unknown, maximumItems: number, maximumLength: number): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || parsed.length > maximumItems || !parsed.every((item) => typeof item === "string" && item.length > 0 && item.length <= maximumLength)) {
    throw new Error("Durable sponsorship list is malformed");
  }
  return [...new Set(parsed)];
}
function rewardType(value: unknown): RewardType {
  if (Array.isArray(value) && value.includes("stablecoin")) return "stablecoin";
  throw new Error("Receiver pull auctions currently require the stablecoin reward lane");
}
function signalNames(fields: Record<string, unknown>): string[] {
  const values = [fields.coarseLocation, ...(Array.isArray(fields.privateRepoTechStacks) ? fields.privateRepoTechStacks.flat() : [])];
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 80))].slice(0, 20);
}
