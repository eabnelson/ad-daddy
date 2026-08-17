import {
  claimExpired,
  rankEligibleAds,
  TeamModeInfrastructureError,
  TeamModeNotFoundError,
  type TeamAd,
  type TeamDelivery,
  type TeamMember,
  type TeamModeStore,
} from "./service.ts";

export type TeamPostgresQuery = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  parameters?: readonly unknown[],
) => Promise<T[]>;

const TEAM_MEMBER_LIMIT = 25;
const TEAM_AD_LIMIT = 100;
const TEAM_ADS_PER_MEMBER_LIMIT = 20;

/** Durable store for the Vercel-hosted, no-money team proof. */
export class PostgresTeamModeStore implements TeamModeStore {
  readonly #query: TeamPostgresQuery;
  #ready?: Promise<void>;

  constructor(query: TeamPostgresQuery) {
    this.#query = async (text, parameters) => {
      try { return await query(text, parameters); }
      catch (error) { throw new TeamModeInfrastructureError("Hosted team storage is temporarily unavailable", { cause: error }); }
    };
  }

  async createMember(value: TeamMember) {
    await this.ready();
    const rows = await this.#query(`WITH available AS (
        SELECT used FROM team_mode_v2_capacity
        WHERE scope = 'members' AND used < $9 FOR UPDATE
      ), inserted AS (
        INSERT INTO team_mode_v2_members
        (id, installation_id, display_name, tags_json, receives_ads, created_at, updated_at, capability_hash)
        SELECT $1, $2, $3, $4::jsonb, $5, $6, $7, $8 FROM available
        ON CONFLICT DO NOTHING RETURNING id
      ), member_counter AS (
        INSERT INTO team_mode_v2_member_ad_counts (member_id, used)
        SELECT id, 0 FROM inserted RETURNING member_id
      ), capacity_updated AS (
        UPDATE team_mode_v2_capacity SET used = used + 1
        WHERE scope = 'members' AND EXISTS (SELECT 1 FROM inserted) RETURNING used
      ) SELECT id FROM inserted`, [
        value.id, value.installationId, value.displayName, JSON.stringify(value.tags), value.receivesAds,
        value.createdAt, value.updatedAt, value.capabilityHash, TEAM_MEMBER_LIMIT,
      ]);
    if (rows.length !== 1) {
      const capacity = (await this.#query<{ used: number }>(
        "SELECT used FROM team_mode_v2_capacity WHERE scope = 'members'",
      ))[0];
      if (Number(capacity?.used) >= TEAM_MEMBER_LIMIT) {
        throw new Error(`This proof network is limited to ${TEAM_MEMBER_LIMIT} members`);
      }
      throw new Error("Team member identity already exists");
    }
  }

  async getMemberByCapabilityHash(capabilityHash: string) {
    await this.ready();
    return member((await this.#query(`${MEMBER_SELECT} WHERE m.capability_hash = $1`, [capabilityHash]))[0]);
  }

  async updateMember(value: TeamMember) {
    await this.ready();
    const rows = await this.#query(`UPDATE team_mode_v2_members
      SET display_name = $1, tags_json = $2::jsonb, receives_ads = $3, updated_at = $4
      WHERE id = $5 RETURNING id`, [
      value.displayName, JSON.stringify(value.tags), value.receivesAds, value.updatedAt, value.id,
    ]);
    if (rows.length !== 1) throw new Error("Unknown team member");
  }

  async listMembers() {
    await this.ready();
    const rows = await this.#query(`${MEMBER_SELECT} ORDER BY m.created_at ASC LIMIT 500`);
    return rows.map(member).filter((value): value is TeamMember => Boolean(value));
  }

  async createAd(value: TeamAd) {
    await this.ready();
    const rows = await this.#query(`WITH member_capacity AS (
        SELECT used FROM team_mode_v2_member_ad_counts
        WHERE member_id = $2 AND used < $10 FOR UPDATE
      ), network_capacity AS (
        SELECT capacity.used FROM team_mode_v2_capacity capacity, member_capacity
        WHERE capacity.scope = 'ads' AND capacity.used < $11 FOR UPDATE
      ), inserted AS (
        INSERT INTO team_mode_v2_ads
        (id, advertiser_member_id, advertiser_name, title, body, target_tags_json, points, active, created_at)
        SELECT $1, $2, $3, $4, $5, $6::jsonb, $7::INTEGER, $8::BOOLEAN, $9
        FROM member_capacity, network_capacity
        ON CONFLICT DO NOTHING RETURNING id
      ), member_updated AS (
        UPDATE team_mode_v2_member_ad_counts SET used = used + 1
        WHERE member_id = $2 AND EXISTS (SELECT 1 FROM inserted) RETURNING used
      ), network_updated AS (
        UPDATE team_mode_v2_capacity SET used = used + 1
        WHERE scope = 'ads' AND EXISTS (SELECT 1 FROM inserted) RETURNING used
      ) SELECT id FROM inserted`, [
        value.id, value.advertiserMemberId, value.advertiserName, value.title, value.body,
        JSON.stringify(value.targetTags), value.points, value.active, value.createdAt,
        TEAM_ADS_PER_MEMBER_LIMIT, TEAM_AD_LIMIT,
      ]);
    if (rows.length !== 1) {
      const limits = (await this.#query<{ member_used: number; network_used: number }>(`SELECT
        (SELECT used FROM team_mode_v2_member_ad_counts WHERE member_id = $1) AS member_used,
        (SELECT used FROM team_mode_v2_capacity WHERE scope = 'ads') AS network_used`, [value.advertiserMemberId]))[0];
      if (Number(limits?.member_used) >= TEAM_ADS_PER_MEMBER_LIMIT) {
        throw new Error(`Each member may create at most ${TEAM_ADS_PER_MEMBER_LIMIT} ads in this proof`);
      }
      if (Number(limits?.network_used) >= TEAM_AD_LIMIT) {
        throw new Error(`This proof network is limited to ${TEAM_AD_LIMIT} ads`);
      }
      throw new Error("Team ad could not be created");
    }
  }

  async listAds() {
    await this.ready();
    const rows = await this.#query("SELECT * FROM team_mode_v2_ads ORDER BY created_at ASC LIMIT 1000");
    return rows.map(ad).filter((value): value is TeamAd => Boolean(value));
  }

  async listDeliveries() {
    await this.ready();
    const rows = await this.#query(`SELECT d.*,
      CASE WHEN r.delivery_id IS NULL THEN 'pending' ELSE 'displayed' END AS delivery_status,
      COALESCE(r.displayed_at, d.delivered_at) AS effective_delivered_at
      FROM team_mode_v2_deliveries d
      LEFT JOIN team_mode_v2_delivery_receipts r ON r.delivery_id = d.id
      ORDER BY d.delivered_at ASC LIMIT 5000`);
    return rows.map(delivery).filter((value): value is TeamDelivery => Boolean(value));
  }

  async claimNext(receiver: TeamMember, now: Date) {
    await this.ready();
    if (!receiver.receivesAds) return undefined;
    const [ads, receiverDeliveryRows, pendingRows] = await Promise.all([
      this.listAds(),
      this.#query(`SELECT d.*,
        CASE WHEN r.delivery_id IS NULL THEN 'pending' ELSE 'displayed' END AS delivery_status,
        COALESCE(r.displayed_at, d.delivered_at) AS effective_delivered_at
        FROM team_mode_v2_deliveries d
        LEFT JOIN team_mode_v2_delivery_receipts r ON r.delivery_id = d.id
        WHERE d.receiver_member_id = $1 ORDER BY d.delivered_at ASC LIMIT 1000`, [receiver.id]),
      this.#query(`SELECT d.*, 'pending' AS delivery_status, d.delivered_at AS effective_delivered_at
        FROM team_mode_v2_deliveries d
        LEFT JOIN team_mode_v2_delivery_receipts r ON r.delivery_id = d.id
        WHERE d.receiver_member_id = $1 AND r.delivery_id IS NULL
        ORDER BY d.delivered_at ASC LIMIT 1`, [receiver.id]),
    ]);
    const deliveries = receiverDeliveryRows.map(delivery).filter((value): value is TeamDelivery => Boolean(value));
    const pending = delivery(pendingRows[0]);
    if (pending && !claimExpired(pending, now)) {
      const pendingAd = ads.find((item) => item.id === pending.adId && item.active);
      if (pendingAd) return { ad: pendingAd, delivery: pending };
    }
    if (pending) {
      await this.#query(`DELETE FROM team_mode_v2_deliveries d
        WHERE d.id = $1 AND d.receiver_member_id = $2
          AND NOT EXISTS (SELECT 1 FROM team_mode_v2_delivery_receipts r WHERE r.delivery_id = d.id)`, [pending.id, receiver.id]);
      await this.#query("DELETE FROM team_mode_v2_pending_receivers WHERE receiver_member_id = $1 AND delivery_id = $2", [receiver.id, pending.id]);
    }
    await this.#query(`DELETE FROM team_mode_v2_pending_receivers WHERE receiver_member_id = $1
      AND delivery_id NOT IN (
        SELECT d.id FROM team_mode_v2_deliveries d
        LEFT JOIN team_mode_v2_delivery_receipts r ON r.delivery_id = d.id
        WHERE r.delivery_id IS NULL
      )`, [receiver.id]);

    const deliveredAdIds = new Set(deliveries
      .filter((item) => item.receiverMemberId === receiver.id && item.id !== pending?.id)
      .map((item) => item.adId));
    const eligible = rankEligibleAds(ads, receiver, deliveredAdIds);

    for (const candidate of eligible) {
      const claimed: TeamDelivery = {
        id: `team_delivery_${crypto.randomUUID()}`,
        adId: candidate.ad.id,
        receiverMemberId: receiver.id,
        installationId: receiver.installationId,
        points: candidate.ad.points,
        matchedTags: candidate.matchedTags,
        deliveredAt: now.toISOString(),
        status: "pending",
      };
      const guard = await this.#query(`INSERT INTO team_mode_v2_pending_receivers (receiver_member_id, delivery_id)
        VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING receiver_member_id`, [receiver.id, claimed.id]);
      if (guard.length !== 1) return undefined;
      const inserted = await this.#query(`INSERT INTO team_mode_v2_deliveries
        (id, ad_id, receiver_member_id, installation_id, points, matched_tags_json, delivered_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        ON CONFLICT DO NOTHING RETURNING id`, [
        claimed.id, claimed.adId, claimed.receiverMemberId, claimed.installationId, claimed.points,
        JSON.stringify(claimed.matchedTags), claimed.deliveredAt,
      ]);
      if (inserted.length === 1) return { ad: candidate.ad, delivery: claimed };
      await this.#query("DELETE FROM team_mode_v2_pending_receivers WHERE receiver_member_id = $1 AND delivery_id = $2", [receiver.id, claimed.id]);
    }
    return undefined;
  }

  async acknowledgeDelivery(receiver: TeamMember, deliveryId: string, now: Date) {
    await this.ready();
    await this.#query(`INSERT INTO team_mode_v2_delivery_receipts (delivery_id, receiver_member_id, displayed_at)
      SELECT id, receiver_member_id, $1 FROM team_mode_v2_deliveries
      WHERE id = $2 AND receiver_member_id = $3 ON CONFLICT DO NOTHING`, [now.toISOString(), deliveryId, receiver.id]);
    const existing = (await this.#query(`SELECT d.*,
      CASE WHEN r.delivery_id IS NULL THEN 'pending' ELSE 'displayed' END AS delivery_status,
      COALESCE(r.displayed_at, d.delivered_at) AS effective_delivered_at
      FROM team_mode_v2_deliveries d
      LEFT JOIN team_mode_v2_delivery_receipts r ON r.delivery_id = d.id
      WHERE d.id = $1 AND d.receiver_member_id = $2`, [deliveryId, receiver.id]))[0];
    const value = delivery(existing);
    if (!value || value.status !== "displayed") throw new TeamModeNotFoundError("Unknown team delivery");
    await this.#query("DELETE FROM team_mode_v2_pending_receivers WHERE receiver_member_id = $1 AND delivery_id = $2", [receiver.id, deliveryId]);
    return value;
  }

  private async initialize() {
    for (const statement of TEAM_POSTGRES_SCHEMA) await this.#query(statement);
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

export const TEAM_POSTGRES_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS team_mode_v2_capacity (
    scope TEXT PRIMARY KEY, used INTEGER NOT NULL CHECK (used >= 0)
  )`,
  `INSERT INTO team_mode_v2_capacity (scope, used) VALUES ('members', 0), ('ads', 0) ON CONFLICT DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS team_mode_v2_members (
    id TEXT PRIMARY KEY, installation_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    tags_json JSONB NOT NULL, receives_ads BOOLEAN NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    capability_hash TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS team_mode_v2_member_ad_counts (
    member_id TEXT PRIMARY KEY REFERENCES team_mode_v2_members(id) ON DELETE CASCADE,
    used INTEGER NOT NULL CHECK (used >= 0)
  )`,
  `CREATE TABLE IF NOT EXISTS team_mode_v2_ads (
    id TEXT PRIMARY KEY, advertiser_member_id TEXT NOT NULL REFERENCES team_mode_v2_members(id), advertiser_name TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL, target_tags_json JSONB NOT NULL, points INTEGER NOT NULL CHECK (points >= 0),
    active BOOLEAN NOT NULL, created_at TEXT NOT NULL
  )`,
  `INSERT INTO team_mode_v2_member_ad_counts (member_id, used)
    SELECT m.id, COUNT(a.id)::INTEGER FROM team_mode_v2_members m
    LEFT JOIN team_mode_v2_ads a ON a.advertiser_member_id = m.id
    GROUP BY m.id ON CONFLICT DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS team_mode_v2_deliveries (
    id TEXT PRIMARY KEY, ad_id TEXT NOT NULL REFERENCES team_mode_v2_ads(id), receiver_member_id TEXT NOT NULL REFERENCES team_mode_v2_members(id),
    installation_id TEXT NOT NULL, points INTEGER NOT NULL CHECK (points >= 0), matched_tags_json JSONB NOT NULL,
    delivered_at TEXT NOT NULL, UNIQUE(ad_id, receiver_member_id)
  )`,
  `CREATE TABLE IF NOT EXISTS team_mode_v2_delivery_receipts (
    delivery_id TEXT PRIMARY KEY REFERENCES team_mode_v2_deliveries(id) ON DELETE CASCADE,
    receiver_member_id TEXT NOT NULL REFERENCES team_mode_v2_members(id), displayed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS team_mode_v2_pending_receivers (
    receiver_member_id TEXT PRIMARY KEY REFERENCES team_mode_v2_members(id) ON DELETE CASCADE,
    delivery_id TEXT NOT NULL UNIQUE
  )`,
] as const;

const MEMBER_SELECT = "SELECT m.* FROM team_mode_v2_members m";

function member(row: Record<string, unknown> | undefined): TeamMember | undefined {
  if (!row) return undefined;
  return {
    id: text(row.id), installationId: text(row.installation_id), displayName: text(row.display_name),
    tags: texts(row.tags_json), receivesAds: row.receives_ads === true, createdAt: text(row.created_at), updatedAt: text(row.updated_at),
    capabilityHash: text(row.capability_hash),
  };
}

function ad(row: Record<string, unknown> | undefined): TeamAd | undefined {
  if (!row) return undefined;
  return {
    id: text(row.id), advertiserMemberId: text(row.advertiser_member_id), advertiserName: text(row.advertiser_name),
    title: text(row.title), body: text(row.body), targetTags: texts(row.target_tags_json), points: integer(row.points),
    rewardKind: "team_points", active: row.active === true, createdAt: text(row.created_at),
  };
}

function delivery(row: Record<string, unknown> | undefined): TeamDelivery | undefined {
  if (!row) return undefined;
  return {
    id: text(row.id), adId: text(row.ad_id), receiverMemberId: text(row.receiver_member_id),
    installationId: text(row.installation_id), points: integer(row.points), matchedTags: texts(row.matched_tags_json),
    deliveredAt: text(row.effective_delivered_at ?? row.delivered_at), status: row.delivery_status === "displayed" ? "displayed" : "pending",
  };
}

function text(value: unknown) {
  if (typeof value !== "string" || !value) throw new Error("Malformed hosted team row");
  return value;
}

function integer(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Malformed hosted team row");
  return parsed;
}

function texts(value: unknown) {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("Malformed hosted team row");
  return parsed as string[];
}
