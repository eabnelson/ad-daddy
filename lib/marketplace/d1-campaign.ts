import type {
  BrandVerificationRecord,
  BrandVerificationRepository,
  CampaignRecord,
  CampaignRepository,
} from "@ad-daddy/cli/campaign";

import type { BudgetReservation, CampaignBudgetSnapshot, CampaignBudgetStatus } from "./budget.ts";
import { BudgetUnavailableError } from "./budget-error.ts";

type Row = Record<string, unknown>;

export class D1CampaignRepository implements CampaignRepository {
  readonly #db: D1Database;
  constructor(db: D1Database) { this.#db = db; }

  async get(campaignId: string): Promise<CampaignRecord | undefined> {
    const row = await this.#db.prepare(`SELECT c.*, b.name AS brand_name, b.verified_domain AS verified_domain
      FROM campaigns c JOIN advertiser_brands b ON b.id = c.brand_id WHERE c.id = ?`).bind(campaignId).first<Row>();
    return row ? campaignFromRow(row) : undefined;
  }

  async put(campaign: CampaignRecord): Promise<void> {
    const audience = JSON.stringify({
      allowlistedDestinationHosts: campaign.allowlistedDestinationHosts,
      categories: campaign.categories, regions: campaign.regions, hosts: campaign.hosts,
      rewardTypes: campaign.rewardTypes, perUserFrequencyLimit: campaign.perUserFrequencyLimit,
    });
    const offer = JSON.stringify({
      guaranteedPlacementMinor: campaign.guaranteedPlacementMinor,
      ...(campaign.conversionBonusMinor === undefined ? {} : { conversionBonusMinor: campaign.conversionBonusMinor }),
    });
    const creative = JSON.stringify(campaign.creative);
    const values = [campaign.accountId, campaign.brand.verificationId, campaign.status, campaign.advertiserTermsVersion,
      campaign.destinationUrl, campaign.schedule.startsAt, campaign.schedule.endsAt, audience, offer, creative,
      campaign.conversionTerms, campaign.maximumSpendMinor, campaign.maximumBidMinor, campaign.dailyCapMinor,
      campaign.fundedMinor, campaign.termsAcceptedAt ?? null, campaign.activatedAt ?? null, campaign.closedAt ?? null,
      new Date().toISOString(), campaign.campaignId];
    const updated = await this.#db.prepare(`UPDATE campaigns SET account_id = ?, brand_id = ?, status = ?, advertiser_terms_version = ?,
      destination_url = ?, schedule_starts_at = ?, schedule_ends_at = ?, audience_json = ?, offer_json = ?, creative_json = ?,
      conversion_terms = ?, maximum_spend_minor = ?, maximum_bid_minor = ?, daily_cap_minor = ?, funded_minor = ?,
      terms_accepted_at = ?, activated_at = ?, closed_at = ?, updated_at = ? WHERE id = ? AND account_id = ?`)
      .bind(...values, campaign.accountId).run();
    if ((updated.meta.changes ?? 0) === 1) return;
    const existing = await this.get(campaign.campaignId);
    if (existing) throw new Error("Campaign belongs to another advertiser account");
    await this.#db.prepare(`INSERT INTO campaigns
      (id, account_id, brand_id, status, advertiser_terms_version, destination_url, schedule_starts_at, schedule_ends_at,
       audience_json, offer_json, creative_json, conversion_terms, maximum_spend_minor, maximum_bid_minor, daily_cap_minor,
       funded_minor, spent_minor, refunded_minor, terms_accepted_at, activated_at, closed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`)
      .bind(campaign.campaignId, ...values.slice(0, -1)).run();
  }
}

export class D1BrandVerificationRepository implements BrandVerificationRepository {
  readonly #db: D1Database;
  constructor(db: D1Database) { this.#db = db; }
  async get(verificationId: string): Promise<BrandVerificationRecord | undefined> {
    const row = await this.#db.prepare(`SELECT id AS verificationId, account_id AS accountId, verified_domain AS verifiedDomain,
      ownership_status AS ownershipStatus, COALESCE(verified_at, created_at) AS verifiedAt FROM advertiser_brands WHERE id = ?`).bind(verificationId).first<Row>();
    if (!row) return undefined;
    return {
      verificationId: text(row.verificationId), accountId: text(row.accountId), verifiedDomain: text(row.verifiedDomain),
      status: row.ownershipStatus === "verified" ? "active" : "revoked", verifiedAt: text(row.verifiedAt),
    };
  }
}

export class D1CampaignBudgetService {
  readonly #db: D1Database;
  constructor(db: D1Database) { this.#db = db; }

  async open(input: { campaignId: string; fundedMinor: number; dailyCapMinor: number }) {
    const result = await this.#db.prepare(`UPDATE campaigns SET funded_minor = ?, daily_cap_minor = ?, updated_at = ?
      WHERE id = ? AND (funded_minor = 0 OR funded_minor = ?)`).bind(
        input.fundedMinor, input.dailyCapMinor, new Date().toISOString(), input.campaignId, input.fundedMinor,
      ).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error("Campaign budget already exists or campaign is unknown");
    return this.snapshot(input.campaignId);
  }

  async reserve(campaignId: string, reservationId: string, amountMinor: number, now = new Date()): Promise<BudgetReservation> {
    const existing = await this.reservation(reservationId);
    if (existing) {
      if (existing.amountMinor !== amountMinor || existing.status === "released") throw new Error("Reservation idempotency key collision");
      return existing;
    }
    const day = now.toISOString().slice(0, 10);
    const result = await this.#db.prepare(`INSERT INTO campaign_budget_reservations
      (id, campaign_id, idempotency_key, amount_minor, budget_day, status)
      SELECT ?, c.id, ?, ?, ?, 'reserved' FROM campaigns c
      WHERE c.id = ? AND c.status = 'active'
        AND c.spent_minor + c.refunded_minor + ?
          + COALESCE((SELECT SUM(amount_minor) FROM campaign_budget_reservations WHERE campaign_id = c.id AND status = 'reserved'), 0)
          + COALESCE((SELECT SUM(amount_minor) FROM campaign_budget_holds WHERE campaign_id = c.id AND status = 'active'), 0) <= c.funded_minor
        AND ? + COALESCE((SELECT SUM(amount_minor) FROM campaign_budget_reservations WHERE campaign_id = c.id AND budget_day = ? AND status != 'released'), 0) <= c.daily_cap_minor`)
      .bind(reservationId, reservationId, amountMinor, day, campaignId, amountMinor, amountMinor, day).run();
    if ((result.meta.changes ?? 0) !== 1) throw new BudgetUnavailableError("Campaign budget is unavailable");
    return (await this.reservation(reservationId))!;
  }

  async release(campaignId: string, reservationId: string): Promise<BudgetReservation> {
    await this.#db.prepare(`UPDATE campaign_budget_reservations SET status = 'released', released_at = ?
      WHERE id = ? AND campaign_id = ? AND status = 'reserved'`).bind(new Date().toISOString(), reservationId, campaignId).run();
    const record = await this.reservation(reservationId);
    if (!record) throw new Error("Unknown reservation");
    if (record.status === "committed") throw new Error("Committed reservation cannot be released");
    return record;
  }

  async commit(campaignId: string, reservationId: string): Promise<BudgetReservation> {
    const now = new Date().toISOString();
    await this.#db.batch([
      this.#db.prepare(`UPDATE campaigns SET spent_minor = spent_minor +
        COALESCE((SELECT amount_minor FROM campaign_budget_reservations WHERE id = ? AND campaign_id = ? AND status = 'reserved'), 0), updated_at = ?
        WHERE id = ?`).bind(reservationId, campaignId, now, campaignId),
      this.#db.prepare(`UPDATE campaign_budget_reservations SET status = 'committed', committed_at = ?
        WHERE id = ? AND campaign_id = ? AND status = 'reserved'`).bind(now, reservationId, campaignId),
    ]);
    const record = await this.reservation(reservationId);
    if (!record || record.status !== "committed") throw new Error("Reservation is not active");
    return record;
  }

  async hold(campaignId: string, holdId: string, amountMinor: number) {
    const existing = await this.#db.prepare(`SELECT amount_minor AS amountMinor, status FROM campaign_budget_holds WHERE id = ?`).bind(holdId).first<Row>();
    if (existing) {
      if (number(existing.amountMinor) !== amountMinor) throw new Error("Hold idempotency key collision");
      return this.snapshot(campaignId);
    }
    const result = await this.#db.prepare(`INSERT INTO campaign_budget_holds (id, campaign_id, reason, amount_minor, status)
      SELECT ?, c.id, 'conversion', ?, 'active' FROM campaigns c WHERE c.id = ? AND c.status != 'closed'
        AND c.spent_minor + c.refunded_minor + ?
          + COALESCE((SELECT SUM(amount_minor) FROM campaign_budget_reservations WHERE campaign_id = c.id AND status = 'reserved'), 0)
          + COALESCE((SELECT SUM(amount_minor) FROM campaign_budget_holds WHERE campaign_id = c.id AND status = 'active'), 0) <= c.funded_minor`)
      .bind(holdId, amountMinor, campaignId, amountMinor).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error("Insufficient balance for hold");
    return this.snapshot(campaignId);
  }

  async commitHold(campaignId: string, holdId: string) {
    const row = await this.#db.prepare(`SELECT amount_minor AS amountMinor, status FROM campaign_budget_holds WHERE id = ? AND campaign_id = ?`).bind(holdId, campaignId).first<Row>();
    if (!row) throw new Error("Unknown campaign hold");
    if (row.status === "active") await this.#db.batch([
      this.#db.prepare(`UPDATE campaigns SET spent_minor = spent_minor + COALESCE((SELECT amount_minor
        FROM campaign_budget_holds WHERE id = ? AND campaign_id = ? AND status = 'active'), 0), updated_at = ? WHERE id = ?`)
        .bind(holdId, campaignId, new Date().toISOString(), campaignId),
      this.#db.prepare(`UPDATE campaign_budget_holds SET status = 'committed', committed_at = ? WHERE id = ? AND campaign_id = ? AND status = 'active'`)
        .bind(new Date().toISOString(), holdId, campaignId),
    ]);
    return this.snapshot(campaignId);
  }

  async releaseHold(campaignId: string, holdId: string) {
    await this.#db.prepare(`UPDATE campaign_budget_holds SET status = 'released', released_at = ? WHERE id = ? AND campaign_id = ? AND status = 'active'`)
      .bind(new Date().toISOString(), holdId, campaignId).run();
    return this.snapshot(campaignId);
  }

  async pause(campaignId: string) {
    const now = new Date().toISOString();
    await this.#db.batch([
      this.#db.prepare(`UPDATE campaigns SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'`).bind(now, campaignId),
      this.#db.prepare(`UPDATE campaign_budget_reservations SET status = 'released', released_at = ?
        WHERE campaign_id = ? AND status = 'reserved'
          AND NOT EXISTS (
            SELECT 1 FROM auction_decisions d
            JOIN auctions a ON a.id = d.auction_id
            JOIN opportunities o ON o.id = a.opportunity_id
            WHERE d.reservation_id = campaign_budget_reservations.id
              AND d.winner_bid_id IS NOT NULL AND o.state = 'won'
          )
          AND NOT EXISTS (
            SELECT 1 FROM placement_claims pc WHERE pc.reservation_id = campaign_budget_reservations.id
          )`).bind(now, campaignId),
    ]);
    return this.snapshot(campaignId);
  }

  async resume(campaignId: string) {
    const result = await this.#db.prepare(`UPDATE campaigns SET status = 'active', updated_at = ? WHERE id = ? AND status = 'paused'`).bind(new Date().toISOString(), campaignId).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error("Campaign cannot resume");
    return this.snapshot(campaignId);
  }

  async close(campaignId: string) {
    await this.#db.prepare(`UPDATE campaigns SET status = 'closed', closed_at = COALESCE(closed_at, ?), updated_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), new Date().toISOString(), campaignId).run();
    return this.snapshot(campaignId);
  }

  async withdraw(campaignId: string, refundId: string, amountMinor: number) {
    if (!refundId) throw new Error("Refund id is required");
    let withdrawal = await this.refundWithdrawal(refundId);
    if (withdrawal && (withdrawal.campaignId !== campaignId || withdrawal.amountMinor !== amountMinor)) {
      throw new Error("Refund idempotency key collision");
    }
    const now = new Date().toISOString();
    if (!withdrawal?.appliedAt) {
      try {
        await this.#db.batch([
          this.#db.prepare(`INSERT INTO campaign_refund_withdrawals (refund_id, campaign_id, amount_minor)
            SELECT ?, c.id, ? FROM campaigns c
            WHERE c.id = ? AND c.status = 'closed'
              AND ? = c.funded_minor - c.spent_minor - c.refunded_minor
                - COALESCE((SELECT SUM(amount_minor) FROM campaign_budget_reservations WHERE campaign_id = c.id AND status = 'reserved'), 0)
                - COALESCE((SELECT SUM(amount_minor) FROM campaign_budget_holds WHERE campaign_id = c.id AND status = 'active'), 0)
            ON CONFLICT(refund_id) DO NOTHING`).bind(refundId, amountMinor, campaignId, amountMinor),
          this.#db.prepare(`UPDATE campaigns SET refunded_minor = refunded_minor + ?, updated_at = ?
            WHERE id = ? AND EXISTS (
              SELECT 1 FROM campaign_refund_withdrawals w
              WHERE w.refund_id = ? AND w.campaign_id = campaigns.id AND w.amount_minor = ? AND w.applied_at IS NULL
            )`).bind(amountMinor, now, campaignId, refundId, amountMinor),
          this.#db.prepare(`UPDATE campaign_refund_withdrawals SET applied_at = ?
            WHERE refund_id = ? AND campaign_id = ? AND amount_minor = ? AND applied_at IS NULL`)
            .bind(now, refundId, campaignId, amountMinor),
        ]);
      } catch {
        // The durable marker below distinguishes an idempotent retry from a
        // competing campaign refund or an unavailable balance.
      }
      withdrawal = await this.refundWithdrawal(refundId);
    }
    if (!withdrawal || withdrawal.campaignId !== campaignId || withdrawal.amountMinor !== amountMinor || !withdrawal.appliedAt) {
      const campaignWithdrawal = await this.#db.prepare(`SELECT refund_id AS refundId FROM campaign_refund_withdrawals WHERE campaign_id = ?`)
        .bind(campaignId).first<{ refundId: string }>();
      if (campaignWithdrawal && campaignWithdrawal.refundId !== refundId) throw new Error("Campaign refund already prepared");
      throw new Error("Refund must equal the currently withdrawable campaign balance");
    }
    return this.snapshot(campaignId);
  }

  async balance(campaignId: string) { return this.snapshot(campaignId); }

  async snapshot(campaignId: string): Promise<CampaignBudgetSnapshot> {
    const campaign = await this.#db.prepare(`SELECT status, funded_minor AS fundedMinor, spent_minor AS spentMinor,
      refunded_minor AS refundedMinor, daily_cap_minor AS dailyCapMinor FROM campaigns WHERE id = ?`).bind(campaignId).first<Row>();
    if (!campaign) throw new Error("Unknown campaign budget");
    const reservations = await this.#db.prepare(`SELECT id AS reservationId, amount_minor AS amountMinor, budget_day AS day, status
      FROM campaign_budget_reservations WHERE campaign_id = ? ORDER BY created_at, id`).bind(campaignId).all<Row>();
    const holds = await this.#db.prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS heldMinor FROM campaign_budget_holds WHERE campaign_id = ? AND status = 'active'`).bind(campaignId).first<Row>();
    const history = (reservations.results ?? []).map(reservationFromRow);
    const reservedMinor = history.filter((item) => item.status === "reserved").reduce((total, item) => total + item.amountMinor, 0);
    const heldMinor = number(holds?.heldMinor ?? 0);
    const fundedMinor = number(campaign.fundedMinor);
    const spentMinor = number(campaign.spentMinor);
    const refundedMinor = number(campaign.refundedMinor);
    return Object.freeze({
      campaignId, status: budgetStatus(campaign.status), fundedMinor, spentMinor, reservedMinor, heldMinor, refundedMinor,
      withdrawableMinor: fundedMinor - spentMinor - reservedMinor - heldMinor - refundedMinor,
      dailyCapMinor: number(campaign.dailyCapMinor), history: Object.freeze(history),
    });
  }

  private async reservation(reservationId: string): Promise<BudgetReservation | undefined> {
    const row = await this.#db.prepare(`SELECT id AS reservationId, amount_minor AS amountMinor, budget_day AS day, status
      FROM campaign_budget_reservations WHERE id = ?`).bind(reservationId).first<Row>();
    return row ? reservationFromRow(row) : undefined;
  }

  private async refundWithdrawal(refundId: string): Promise<{ campaignId: string; amountMinor: number; appliedAt?: string } | undefined> {
    const row = await this.#db.prepare(`SELECT campaign_id AS campaignId, amount_minor AS amountMinor, applied_at AS appliedAt
      FROM campaign_refund_withdrawals WHERE refund_id = ?`).bind(refundId).first<Row>();
    if (!row) return undefined;
    return {
      campaignId: text(row.campaignId), amountMinor: number(row.amountMinor),
      ...(row.appliedAt === null ? {} : { appliedAt: text(row.appliedAt) }),
    };
  }
}

function campaignFromRow(row: Row): CampaignRecord {
  const audience = json(row.audience_json);
  const offer = json(row.offer_json);
  const creative = json(row.creative_json);
  return {
    campaignId: text(row.id), accountId: text(row.account_id), advertiserTermsVersion: text(row.advertiser_terms_version),
    brand: { name: text(row.brand_name), verifiedDomain: text(row.verified_domain), verificationId: text(row.brand_id) },
    destinationUrl: text(row.destination_url), schedule: { startsAt: text(row.schedule_starts_at), endsAt: text(row.schedule_ends_at) },
    allowlistedDestinationHosts: strings(audience.allowlistedDestinationHosts), categories: strings(audience.categories),
    regions: strings(audience.regions), hosts: strings(audience.hosts), rewardTypes: strings(audience.rewardTypes) as CampaignRecord["rewardTypes"],
    creative: { headline: text(creative.headline), body: text(creative.body) },
    maximumSpendMinor: number(row.maximum_spend_minor), maximumBidMinor: number(row.maximum_bid_minor), dailyCapMinor: number(row.daily_cap_minor),
    guaranteedPlacementMinor: number(offer.guaranteedPlacementMinor),
    ...(offer.conversionBonusMinor === undefined ? {} : { conversionBonusMinor: number(offer.conversionBonusMinor) }),
    conversionTerms: text(row.conversion_terms), perUserFrequencyLimit: number(audience.perUserFrequencyLimit),
    status: text(row.status) as CampaignRecord["status"], fundedMinor: number(row.funded_minor),
    ...(row.terms_accepted_at ? { termsAcceptedAt: text(row.terms_accepted_at) } : {}),
    ...(row.activated_at ? { activatedAt: text(row.activated_at) } : {}), ...(row.closed_at ? { closedAt: text(row.closed_at) } : {}),
  };
}

function reservationFromRow(row: Row): BudgetReservation {
  return { reservationId: text(row.reservationId), amountMinor: number(row.amountMinor), day: text(row.day), status: text(row.status) as BudgetReservation["status"] };
}
function budgetStatus(value: unknown): CampaignBudgetStatus {
  if (value === "active") return "active";
  if (value === "closed") return "closed";
  return "paused";
}
function json(value: unknown): Row { const parsed = JSON.parse(text(value)); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Durable campaign JSON is malformed"); return parsed as Row; }
function strings(value: unknown): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Durable campaign list is malformed"); return [...value]; }
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Durable campaign field is malformed"); return value; }
function number(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Durable campaign amount is malformed"); return value; }
