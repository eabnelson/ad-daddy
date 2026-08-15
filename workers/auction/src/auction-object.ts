import { AuctionService, type AuctionDecision, type AuctionDefinition } from "../../../lib/marketplace/auction.ts";
import type { AuctionBid, RankedAuctionBid } from "../../../lib/marketplace/ranking.ts";
import { buildReceiverDemandView } from "../../../lib/marketplace/demand.ts";
import type { ConsentStatus } from "../../../lib/domain/types.ts";

interface StorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(timestamp: number): Promise<void>;
}
interface DurableObjectStateLike { storage: StorageLike; }
interface D1ResultLike { meta?: { changes?: number }; }
interface D1StatementLike { bind(...values: unknown[]): D1StatementLike; run(): Promise<D1ResultLike>; first<T>(): Promise<T | null>; }
interface D1Like { prepare(query: string): D1StatementLike; }
interface AuctionEnvironment { DB: D1Like; }
interface StoredAuction { definition: AuctionDefinition; bids: RankedAuctionBid[]; decision?: AuctionDecision; }

export class AuctionObject {
  readonly #state: DurableObjectStateLike;
  readonly #env: AuctionEnvironment;
  #tail = Promise.resolve();
  #service?: AuctionService;

  constructor(state: DurableObjectStateLike, env: AuctionEnvironment) { this.#state = state; this.#env = env; }

  fetch(request: Request): Promise<Response> {
    return this.serialize(() => this.handle(request));
  }

  alarm(): Promise<void> {
    return this.serialize(() => this.runAlarm());
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#tail.then(operation);
    this.#tail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async runAlarm(): Promise<void> {
    const stored = await this.#state.storage.get<StoredAuction>("auction");
    if (!stored || stored.decision) return;
    const status = await this.#env.DB.prepare(
      `SELECT rp.current_consent_version AS currentConsentVersion, rcv.status AS receiverStatus,
        COALESCE((SELECT COUNT(*) FROM placements p JOIN opportunities prior ON prior.id = p.opportunity_id WHERE prior.receiver_profile_id = rp.id AND date(p.created_at) = date('now')), 0)
          < COALESCE(json_extract(ps.published_fields_json, '$.adFrequency.maxPerDay'), 1) AS frequencyEligible
       FROM opportunities o
       JOIN receiver_profiles rp ON rp.id = o.receiver_profile_id
       JOIN receiver_consent_versions rcv ON rcv.receiver_profile_id = rp.id AND rcv.version = rp.current_consent_version
       LEFT JOIN profile_snapshots ps ON ps.receiver_profile_id = rp.id AND ps.consent_version = rp.current_consent_version
       WHERE o.id = ?`,
    ).bind(stored.definition.opportunityId).first<{ currentConsentVersion: number; receiverStatus: ConsentStatus; frequencyEligible: number }>();
    await this.clear(stored, {
      now: new Date(),
      receiverStatus: status?.receiverStatus ?? "revoked",
      currentConsentVersion: status?.currentConsentVersion ?? -1,
      frequencyEligible: status?.frequencyEligible === 1,
    });
  }

  private async handle(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const stored = await this.#state.storage.get<StoredAuction>("auction");
      return stored ? Response.json(receiverSafeHistory(stored)) : Response.json({ error: "auction_not_found" }, { status: 404 });
    }
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    const url = new URL(request.url);
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
    try {
      if (url.pathname.endsWith("/open")) return this.open(body as AuctionDefinition);
      const stored = await this.#state.storage.get<StoredAuction>("auction");
      if (!stored) return Response.json({ error: "auction_not_found" }, { status: 404 });
      if (url.pathname.endsWith("/bids")) return this.bid(stored, body as AuctionBid);
      if (url.pathname.endsWith("/clear")) return Response.json(await this.clear(stored, body as Parameters<AuctionService["clear"]>[1]));
      return Response.json({ error: "unknown_action" }, { status: 404 });
    } catch (error) {
      return Response.json({ error: "auction_request_rejected", message: boundedMessage(error) }, { status: 409 });
    }
  }

  private async open(definition: AuctionDefinition): Promise<Response> {
    const existing = await this.#state.storage.get<StoredAuction>("auction");
    if (existing) {
      if (JSON.stringify(existing.definition) !== JSON.stringify(definition)) throw new Error("Auction idempotency collision");
      await this.persistAuction(existing.definition);
      return Response.json(receiverSafeHistory(existing));
    }
    const service = new AuctionService(new D1BudgetGateway(this.#env.DB));
    const opened = service.open(definition);
    this.#service = service;
    const stored: StoredAuction = { definition: opened.definition, bids: [] };
    await this.persistAuction(opened.definition);
    await this.#state.storage.put("auction", stored);
    await this.#state.storage.setAlarm(Date.parse(definition.closesAt));
    return Response.json(receiverSafeHistory(stored), { status: 201 });
  }

  private async bid(stored: StoredAuction, bid: AuctionBid): Promise<Response> {
    if (stored.decision) throw new Error("Auction is already decided");
    const service = this.serviceFor(stored);
    const accepted = await service.bid(stored.definition.auctionId, bid);
    const next = service.history(stored.definition.auctionId);
    await this.persistBid(stored.definition.auctionId, accepted);
    await this.#state.storage.put("auction", { definition: next.definition, bids: [...next.bids] });
    return Response.json({ accepted: true, bidId: accepted.bidId }, { status: 201 });
  }

  private async clear(stored: StoredAuction, input: Parameters<AuctionService["clear"]>[1]): Promise<AuctionDecision> {
    if (stored.decision) return stored.decision;
    const service = this.serviceFor(stored);
    const decision = await service.clear(stored.definition.auctionId, { ...input, now: new Date(input.now) });
    await this.persistDecision(decision);
    const latest = await this.#state.storage.get<StoredAuction>("auction");
    if (!latest) throw new Error("Auction storage disappeared during clearance");
    if (latest.decision) return latest.decision;
    await this.#state.storage.put("auction", { ...latest, decision });
    return decision;
  }

  private serviceFor(stored: StoredAuction): AuctionService {
    if (this.#service) return this.#service;
    const service = new AuctionService(new D1BudgetGateway(this.#env.DB));
    service.restore(stored);
    this.#service = service;
    return service;
  }

  private async persistAuction(definition: AuctionDefinition): Promise<void> {
    const insertion = await this.#env.DB.prepare(`
      INSERT INTO auctions (id, opportunity_id, reward_lane, consent_version, minimum_take_home_minor, matched_signal_names_json, status, closes_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
      ON CONFLICT(id) DO NOTHING
    `).bind(
      definition.auctionId, definition.opportunityId, definition.rewardLane, definition.consentVersion,
      definition.minimumTakeHomeMinor, JSON.stringify(definition.matchedSignalNames), definition.closesAt,
    ).run();
    if ((insertion.meta?.changes ?? 0) === 1) return;
    const persisted = await this.#env.DB.prepare("SELECT opportunity_id AS opportunityId, reward_lane AS rewardLane, consent_version AS consentVersion, minimum_take_home_minor AS minimumTakeHomeMinor, matched_signal_names_json AS matchedSignals, closes_at AS closesAt FROM auctions WHERE id = ?")
      .bind(definition.auctionId).first<{ opportunityId: string; rewardLane: string; consentVersion: number; minimumTakeHomeMinor: number; matchedSignals: string; closesAt: string }>();
    const expected = JSON.stringify([definition.opportunityId, definition.rewardLane, definition.consentVersion, definition.minimumTakeHomeMinor, JSON.stringify(definition.matchedSignalNames), definition.closesAt]);
    const actual = persisted && JSON.stringify([persisted.opportunityId, persisted.rewardLane, persisted.consentVersion, persisted.minimumTakeHomeMinor, persisted.matchedSignals, persisted.closesAt]);
    if (actual !== expected) throw new Error("Auction persistence collision");
  }

  private async persistBid(auctionId: string, bid: RankedAuctionBid): Promise<void> {
    const insertion = await this.#env.DB.prepare(`
      INSERT INTO auction_bids (id, auction_id, campaign_id, reward_lane, gross_amount_minor, receiver_amount_minor, operator_amount_minor, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).bind(bid.bidId, auctionId, bid.campaignId, bid.rewardLane, bid.grossMinor, bid.receiverMinor, bid.operatorMinor, bid.submittedAt).run();
    if ((insertion.meta?.changes ?? 0) === 1) return;
    const persisted = await this.#env.DB.prepare("SELECT auction_id AS auctionId, campaign_id AS campaignId, reward_lane AS rewardLane, gross_amount_minor AS grossMinor, receiver_amount_minor AS receiverMinor, operator_amount_minor AS operatorMinor, submitted_at AS submittedAt FROM auction_bids WHERE id = ?")
      .bind(bid.bidId).first<{ auctionId: string; campaignId: string; rewardLane: string; grossMinor: number; receiverMinor: number; operatorMinor: number; submittedAt: string }>();
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify({
      auctionId, campaignId: bid.campaignId, rewardLane: bid.rewardLane, grossMinor: bid.grossMinor,
      receiverMinor: bid.receiverMinor, operatorMinor: bid.operatorMinor, submittedAt: bid.submittedAt,
    })) {
      throw new Error("Bid persistence collision");
    }
  }

  private async persistDecision(decision: AuctionDecision): Promise<void> {
    const insertion = await this.#env.DB.prepare(`
      INSERT INTO auction_decisions (id, auction_id, winner_bid_id, reservation_id, eligible_bidder_count, no_fill_reason, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(auction_id) DO NOTHING
    `).bind(
      decision.decisionId, decision.auctionId, decision.winner?.bidId ?? null,
      decision.winner?.reservationId ?? null, decision.eligibleBidderCount,
      decision.noFillReason ?? null, decision.decidedAt,
    ).run();
    await this.#env.DB.prepare("UPDATE auctions SET status = 'decided', decided_at = ? WHERE id = ?")
      .bind(decision.decidedAt, decision.auctionId).run();
    await this.#env.DB.prepare("UPDATE opportunities SET state = ? WHERE id = ?")
      .bind(decision.winner ? "won" : "no_fill", decision.opportunityId).run();
    if ((insertion.meta?.changes ?? 0) === 1) return;
    const persisted = await this.#env.DB.prepare("SELECT id, winner_bid_id AS winnerBidId, reservation_id AS reservationId, eligible_bidder_count AS eligibleBidderCount, no_fill_reason AS noFillReason, decided_at AS decidedAt FROM auction_decisions WHERE auction_id = ?")
      .bind(decision.auctionId).first<{ id: string; winnerBidId: string | null; reservationId: string | null; eligibleBidderCount: number; noFillReason: string | null; decidedAt: string }>();
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify({
      id: decision.decisionId,
      winnerBidId: decision.winner?.bidId ?? null,
      reservationId: decision.winner?.reservationId ?? null,
      eligibleBidderCount: decision.eligibleBidderCount,
      noFillReason: decision.noFillReason ?? null,
      decidedAt: decision.decidedAt,
    })) throw new Error("Auction decision persistence collision");
  }
}

class D1BudgetGateway {
  readonly #db: D1Like;
  constructor(db: D1Like) { this.#db = db; }
  async reserve(campaignId: string, reservationId: string, amountMinor: number, now = new Date()) {
    const day = now.toISOString().slice(0, 10);
    const result = await this.#db.prepare(`
      INSERT INTO campaign_budget_reservations (id, campaign_id, idempotency_key, amount_minor, budget_day, status)
      SELECT ?, c.id, ?, ?, ?, 'reserved' FROM campaigns c
      WHERE c.id = ? AND c.status = 'active' AND c.schedule_starts_at <= ? AND c.schedule_ends_at > ?
        AND c.spent_minor + ?
          + COALESCE((SELECT SUM(amount_minor) FROM campaign_budget_reservations WHERE campaign_id = c.id AND status = 'reserved'), 0)
          + COALESCE((SELECT SUM(amount_minor) FROM campaign_budget_holds WHERE campaign_id = c.id AND status = 'active'), 0) <= c.funded_minor
        AND ? + COALESCE((SELECT SUM(amount_minor) FROM campaign_budget_reservations WHERE campaign_id = c.id AND budget_day = ? AND status <> 'released'), 0) <= c.daily_cap_minor
      ON CONFLICT(campaign_id, idempotency_key) DO NOTHING
    `).bind(reservationId, reservationId, amountMinor, day, campaignId, now.toISOString(), now.toISOString(), amountMinor, amountMinor, day).run();
    if ((result.meta?.changes ?? 0) === 1) return { reservationId, amountMinor, day, status: "reserved" as const };
    const existing = await this.#db.prepare("SELECT amount_minor AS amountMinor, budget_day AS day, status FROM campaign_budget_reservations WHERE campaign_id = ? AND idempotency_key = ?")
      .bind(campaignId, reservationId).first<{ amountMinor: number; day: string; status: "reserved" | "released" | "committed" }>();
    if (existing?.amountMinor === amountMinor && existing.status !== "released") return { reservationId, ...existing };
    throw new Error("Campaign budget reservation unavailable");
  }
}

function receiverSafeHistory(stored: StoredAuction) {
  return buildReceiverDemandView({
    definition: stored.definition,
    bids: stored.bids,
    decisions: stored.decision ? [stored.decision] : [],
  });
}
function boundedMessage(error: unknown) { return (error instanceof Error ? error.message : "Request rejected").slice(0, 240); }
