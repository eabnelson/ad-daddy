import {
  claimExpired,
  rankEligibleAds,
  TeamModeNotFoundError,
  type TeamAd,
  type TeamDelivery,
  type TeamMember,
  type TeamModeStore,
} from "./service.ts";

interface D1Result<T = Record<string, unknown>> { results?: T[]; meta?: { changes?: number } }
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface TeamD1Database {
  prepare(sql: string): D1Statement;
}

/** Local/private-team persistence. These proof-only tables never touch money. */
export class D1TeamModeStore implements TeamModeStore {
  readonly #db: TeamD1Database;
  #ready?: Promise<void>;

  constructor(db: TeamD1Database) {
    this.#db = db;
  }

  async createMember(member: TeamMember) {
    await this.ready();
    await this.#db.prepare(`INSERT INTO team_mode_v2_members
      (id, installation_id, display_name, tags_json, receives_ads, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
        member.id, member.installationId, member.displayName, JSON.stringify(member.tags), member.receivesAds ? 1 : 0,
        member.createdAt, member.updatedAt,
      ).run();
    await this.#db.prepare(`INSERT INTO team_mode_v2_member_capabilities (member_id, capability_hash) VALUES (?, ?)`)
      .bind(member.id, member.capabilityHash).run();
  }

  async getMemberByCapabilityHash(capabilityHash: string) {
    await this.ready();
    return member(await this.#db.prepare(`${MEMBER_SELECT} WHERE c.capability_hash = ?`).bind(capabilityHash).first());
  }

  async updateMember(value: TeamMember) {
    await this.ready();
    const result = await this.#db.prepare(`UPDATE team_mode_v2_members SET display_name = ?, tags_json = ?, receives_ads = ?, updated_at = ? WHERE id = ?`).bind(
      value.displayName, JSON.stringify(value.tags), value.receivesAds ? 1 : 0, value.updatedAt, value.id,
    ).run();
    if (result.meta?.changes !== 1) throw new TeamModeNotFoundError("Unknown team member");
  }

  async listMembers() {
    await this.ready();
    const rows = await this.#db.prepare(`${MEMBER_SELECT} ORDER BY m.created_at ASC LIMIT 500`).all();
    return (rows.results ?? []).map(member).filter((value): value is TeamMember => Boolean(value));
  }

  async createAd(value: TeamAd) {
    await this.ready();
    await this.#db.prepare(`INSERT INTO team_mode_v2_ads
      (id, advertiser_member_id, advertiser_name, title, body, target_tags_json, points, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        value.id, value.advertiserMemberId, value.advertiserName, value.title, value.body,
        JSON.stringify(value.targetTags), value.points, value.active ? 1 : 0, value.createdAt,
      ).run();
  }

  async listAds() {
    await this.ready();
    const rows = await this.#db.prepare("SELECT * FROM team_mode_v2_ads ORDER BY created_at ASC LIMIT 1000").all();
    return (rows.results ?? []).map(ad).filter((value): value is TeamAd => Boolean(value));
  }

  async listDeliveries() {
    await this.ready();
    const rows = await this.#db.prepare(`SELECT d.*,
      CASE WHEN r.delivery_id IS NULL THEN 'pending' ELSE 'displayed' END AS delivery_status,
      COALESCE(r.displayed_at, d.delivered_at) AS effective_delivered_at
      FROM team_mode_v2_deliveries d LEFT JOIN team_mode_v2_delivery_receipts r ON r.delivery_id = d.id
      ORDER BY d.delivered_at ASC LIMIT 5000`).all();
    return (rows.results ?? []).map(delivery).filter((value): value is TeamDelivery => Boolean(value));
  }

  async claimNext(receiver: TeamMember, now: Date) {
    if (!receiver.receivesAds) return undefined;
    const [ads, deliveries] = await Promise.all([this.listAds(), this.listDeliveries()]);
    const pending = deliveries.find((item) => item.receiverMemberId === receiver.id && item.status === "pending");
    if (pending) {
      if (!claimExpired(pending, now)) {
        const pendingAd = ads.find((item) => item.id === pending.adId && item.active);
        if (pendingAd) return { ad: pendingAd, delivery: pending };
      }
      await this.#db.prepare(`DELETE FROM team_mode_v2_deliveries WHERE id = ? AND receiver_member_id = ?
        AND NOT EXISTS (SELECT 1 FROM team_mode_v2_delivery_receipts WHERE delivery_id = ?)`)
        .bind(pending.id, receiver.id, pending.id).run();
      await this.#db.prepare("DELETE FROM team_mode_v2_pending_receivers WHERE receiver_member_id = ? AND delivery_id = ?")
        .bind(receiver.id, pending.id).run();
    }
    await this.#db.prepare(`DELETE FROM team_mode_v2_pending_receivers WHERE receiver_member_id = ? AND NOT EXISTS (
      SELECT 1 FROM team_mode_v2_deliveries d LEFT JOIN team_mode_v2_delivery_receipts r ON r.delivery_id = d.id
      WHERE d.id = team_mode_v2_pending_receivers.delivery_id AND r.delivery_id IS NULL
    )`).bind(receiver.id).run();
    const deliveredAdIds = new Set(deliveries
      .filter((item) => item.receiverMemberId === receiver.id && item.id !== pending?.id)
      .map((item) => item.adId));
    const eligible = rankEligibleAds(ads, receiver, deliveredAdIds);
    for (const candidate of eligible) {
      const claimed: TeamDelivery = {
        id: `team_delivery_${crypto.randomUUID()}`, adId: candidate.ad.id, receiverMemberId: receiver.id,
        installationId: receiver.installationId, points: candidate.ad.points, matchedTags: candidate.matchedTags,
        deliveredAt: now.toISOString(),
        status: "pending",
      };
      const guard = await this.#db.prepare(`INSERT OR IGNORE INTO team_mode_v2_pending_receivers
        (receiver_member_id, delivery_id) VALUES (?, ?)`).bind(receiver.id, claimed.id).run();
      if (guard.meta?.changes !== 1) return undefined;
      const result = await this.#db.prepare(`INSERT OR IGNORE INTO team_mode_v2_deliveries
        (id, ad_id, receiver_member_id, installation_id, points, matched_tags_json, delivered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
          claimed.id, claimed.adId, claimed.receiverMemberId, claimed.installationId, claimed.points,
          JSON.stringify(claimed.matchedTags), claimed.deliveredAt,
        ).run();
      if (result.meta?.changes === 1) return { ad: candidate.ad, delivery: claimed };
      await this.#db.prepare("DELETE FROM team_mode_v2_pending_receivers WHERE receiver_member_id = ? AND delivery_id = ?")
        .bind(receiver.id, claimed.id).run();
    }
    return undefined;
  }

  async acknowledgeDelivery(receiver: TeamMember, deliveryId: string, now: Date) {
    await this.ready();
    const result = await this.#db.prepare(`INSERT OR IGNORE INTO team_mode_v2_delivery_receipts
      (delivery_id, receiver_member_id, displayed_at)
      SELECT id, receiver_member_id, ? FROM team_mode_v2_deliveries WHERE id = ? AND receiver_member_id = ?`)
      .bind(now.toISOString(), deliveryId, receiver.id).run();
    const existing = await this.#db.prepare(`SELECT d.*,
      CASE WHEN r.delivery_id IS NULL THEN 'pending' ELSE 'displayed' END AS delivery_status,
      COALESCE(r.displayed_at, d.delivered_at) AS effective_delivered_at
      FROM team_mode_v2_deliveries d LEFT JOIN team_mode_v2_delivery_receipts r ON r.delivery_id = d.id
      WHERE d.id = ? AND d.receiver_member_id = ?`).bind(deliveryId, receiver.id).first();
    if (result.meta?.changes !== 1 && !existing) throw new TeamModeNotFoundError("Unknown team delivery");
    const value = delivery(existing);
    if (!value) throw new TeamModeNotFoundError("Unknown team delivery");
    await this.#db.prepare("DELETE FROM team_mode_v2_pending_receivers WHERE receiver_member_id = ? AND delivery_id = ?")
      .bind(receiver.id, deliveryId).run();
    return value;
  }

  private async initialize() {
    // V2 intentionally starts a clean proof network because V1 had no
    // recoverable member capabilities. Old proof tables remain inert.
    await this.#db.prepare(`CREATE TABLE IF NOT EXISTS team_mode_v2_members (
        id TEXT PRIMARY KEY, installation_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        tags_json TEXT NOT NULL, receives_ads INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`).run();
    await this.#db.prepare(`CREATE TABLE IF NOT EXISTS team_mode_v2_member_capabilities (
        member_id TEXT PRIMARY KEY, capability_hash TEXT NOT NULL UNIQUE
      )`).run();
    await this.#db.prepare(`CREATE TABLE IF NOT EXISTS team_mode_v2_ads (
        id TEXT PRIMARY KEY, advertiser_member_id TEXT NOT NULL, advertiser_name TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, target_tags_json TEXT NOT NULL, points INTEGER NOT NULL,
        active INTEGER NOT NULL, created_at TEXT NOT NULL
      )`).run();
    await this.#db.prepare(`CREATE TABLE IF NOT EXISTS team_mode_v2_deliveries (
        id TEXT PRIMARY KEY, ad_id TEXT NOT NULL, receiver_member_id TEXT NOT NULL, installation_id TEXT NOT NULL,
        points INTEGER NOT NULL, matched_tags_json TEXT NOT NULL, delivered_at TEXT NOT NULL,
        UNIQUE(ad_id, receiver_member_id)
      )`).run();
    await this.#db.prepare(`CREATE TABLE IF NOT EXISTS team_mode_v2_delivery_receipts (
        delivery_id TEXT PRIMARY KEY, receiver_member_id TEXT NOT NULL, displayed_at TEXT NOT NULL
      )`).run();
    await this.#db.prepare(`CREATE TABLE IF NOT EXISTS team_mode_v2_pending_receivers (
        receiver_member_id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL UNIQUE
      )`).run();
  }

  private ready(): Promise<void> {
    const pending = this.#ready ?? this.initialize();
    this.#ready = pending;
    return pending.catch((error) => {
      if (this.#ready === pending) this.#ready = undefined;
      throw error;
    });
  }
}

const MEMBER_SELECT = `SELECT m.*, c.capability_hash FROM team_mode_v2_members m
  INNER JOIN team_mode_v2_member_capabilities c ON c.member_id = m.id`;

function member(row: Record<string, unknown> | null): TeamMember | undefined {
  if (!row) return undefined;
  return {
    id: string(row.id), installationId: string(row.installation_id), displayName: string(row.display_name),
    tags: strings(row.tags_json), receivesAds: row.receives_ads === 1, createdAt: string(row.created_at), updatedAt: string(row.updated_at),
    capabilityHash: string(row.capability_hash),
  };
}
function ad(row: Record<string, unknown> | null): TeamAd | undefined {
  if (!row) return undefined;
  return {
    id: string(row.id), advertiserMemberId: string(row.advertiser_member_id), advertiserName: string(row.advertiser_name),
    title: string(row.title), body: string(row.body), targetTags: strings(row.target_tags_json), points: integer(row.points),
    rewardKind: "team_points", active: row.active === 1, createdAt: string(row.created_at),
  };
}
function delivery(row: Record<string, unknown> | null): TeamDelivery | undefined {
  if (!row) return undefined;
  return {
    id: string(row.id), adId: string(row.ad_id), receiverMemberId: string(row.receiver_member_id),
    installationId: string(row.installation_id), points: integer(row.points), matchedTags: strings(row.matched_tags_json),
    deliveredAt: string(row.effective_delivered_at ?? row.delivered_at), status: row.delivery_status === "displayed" ? "displayed" : "pending",
  };
}
function string(value: unknown) { if (typeof value !== "string" || !value) throw new Error("Malformed private team row"); return value; }
function integer(value: unknown) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw new Error("Malformed private team row"); return number; }
function strings(value: unknown) { const parsed: unknown = JSON.parse(string(value)); if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("Malformed private team row"); return parsed as string[]; }
