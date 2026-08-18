import {
  claimExpired,
  TEAM_EARN_PER_DISPLAYED_AD,
  TEAM_STARTING_POINTS,
  teamSendCost,
  TeamModeInfrastructureError,
  TeamModeNotFoundError,
  type TeamAd,
  type TeamAdRecipient,
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
      ), point_account AS (
        INSERT INTO team_mode_v2_point_balances (member_id, balance, credits_applied)
        SELECT id, $10::INTEGER, 0 FROM inserted RETURNING member_id
      ), capacity_updated AS (
        UPDATE team_mode_v2_capacity SET used = used + 1
        WHERE scope = 'members' AND EXISTS (SELECT 1 FROM inserted) RETURNING used
      ) SELECT id FROM inserted`, [
        value.id, value.installationId, value.displayName, JSON.stringify(value.tags), value.receivesAds,
        value.createdAt, value.updatedAt, value.capabilityHash, TEAM_MEMBER_LIMIT, TEAM_STARTING_POINTS,
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

  async createAd(value: TeamAd, recipients: TeamAdRecipient[]) {
    await this.ready();
    const cost = teamSendCost(recipients.length);
    const recipientSelects = recipients.map((_, index) => `${index === 0 ? "SELECT" : "UNION ALL SELECT"}
          inserted.id, $${13 + index * 2}, $${14 + index * 2} FROM inserted`).join("\n        ");
    const rows = await this.#query(`WITH locked_member AS (
        SELECT id FROM team_mode_v2_members WHERE id = $2 FOR UPDATE
      ), member_capacity AS (
        SELECT used FROM team_mode_v2_member_ad_counts
        WHERE member_id = $2 AND used < $10 FOR UPDATE
      ), network_capacity AS (
        SELECT capacity.used FROM team_mode_v2_capacity capacity, member_capacity
        WHERE capacity.scope = 'ads' AND capacity.used < $11 FOR UPDATE
      ), earned_credits AS (
        SELECT COUNT(*)::INTEGER AS total FROM team_mode_v2_delivery_receipts receipts
        INNER JOIN team_mode_v2_deliveries deliveries ON deliveries.id = receipts.delivery_id
        WHERE deliveries.receiver_member_id = $2
      ), charged AS (
        UPDATE team_mode_v2_point_balances SET
          balance = balance + (SELECT total FROM earned_credits) - credits_applied - $12::INTEGER,
          credits_applied = (SELECT total FROM earned_credits)
        WHERE member_id = $2
          AND balance + (SELECT total FROM earned_credits) - credits_applied >= $12::INTEGER
          AND EXISTS (SELECT 1 FROM locked_member)
          AND EXISTS (SELECT 1 FROM member_capacity)
          AND EXISTS (SELECT 1 FROM network_capacity)
          AND NOT EXISTS (SELECT 1 FROM team_mode_v2_ads WHERE id = $1)
        RETURNING member_id
      ), inserted AS (
        INSERT INTO team_mode_v2_ads
        (id, advertiser_member_id, advertiser_name, title, body, target_tags_json, points, active, created_at)
        SELECT $1, $2, $3, $4, $5, $6::jsonb, $7::INTEGER, $8::BOOLEAN, $9
        FROM charged
        ON CONFLICT DO NOTHING RETURNING id
      ), queued AS (
        INSERT INTO team_mode_v2_ad_recipients (ad_id, receiver_member_id, queued_at)
        ${recipientSelects}
        RETURNING receiver_member_id
      ), member_updated AS (
        UPDATE team_mode_v2_member_ad_counts SET used = used + 1
        WHERE member_id = $2 AND EXISTS (SELECT 1 FROM inserted) RETURNING used
      ), network_updated AS (
        UPDATE team_mode_v2_capacity SET used = used + 1
        WHERE scope = 'ads' AND EXISTS (SELECT 1 FROM inserted) RETURNING used
      ) SELECT id, (SELECT COUNT(*) FROM queued)::INTEGER AS queued_count FROM inserted`, [
        value.id, value.advertiserMemberId, value.advertiserName, value.title, value.body,
        JSON.stringify(value.targetTags), value.points, value.active, value.createdAt,
        TEAM_ADS_PER_MEMBER_LIMIT, TEAM_AD_LIMIT, cost,
        ...recipients.flatMap((recipient) => [recipient.receiverMemberId, recipient.queuedAt]),
    ]);
    if (rows.length !== 1 || Number(rows[0]?.queued_count) !== recipients.length) {
      const limits = (await this.#query<{ member_used: number; network_used: number }>(`SELECT
        (SELECT used FROM team_mode_v2_member_ad_counts WHERE member_id = $1) AS member_used,
        (SELECT used FROM team_mode_v2_capacity WHERE scope = 'ads') AS network_used`, [value.advertiserMemberId]))[0];
      if (Number(limits?.member_used) >= TEAM_ADS_PER_MEMBER_LIMIT) {
        throw new Error(`Each member may create at most ${TEAM_ADS_PER_MEMBER_LIMIT} ads in this proof`);
      }
      if (Number(limits?.network_used) >= TEAM_AD_LIMIT) {
        throw new Error(`This proof network is limited to ${TEAM_AD_LIMIT} ads`);
      }
      if ((await this.#query("SELECT id FROM team_mode_v2_ads WHERE id = $1", [value.id])).length > 0) {
        throw new Error("Team ad could not be created");
      }
      const pointRows = await this.#query<{ balance: number }>(
        `SELECT points.balance
          + COALESCE((SELECT COUNT(*)::INTEGER FROM team_mode_v2_delivery_receipts receipts
            INNER JOIN team_mode_v2_deliveries deliveries ON deliveries.id = receipts.delivery_id
            WHERE deliveries.receiver_member_id = $1), 0)
          - points.credits_applied AS balance
          FROM team_mode_v2_point_balances points WHERE member_id = $1`,
        [value.advertiserMemberId],
      );
      const balance = Number(pointRows[0]?.balance);
      if (Number.isFinite(balance) && balance < cost) {
        throw new Error(`This ad costs ${cost} points, but only ${balance} are available`);
      }
      throw new Error("Team ad could not be created");
    }
  }

  async listAds() {
    await this.ready();
    const rows = await this.#query("SELECT * FROM team_mode_v2_ads ORDER BY created_at ASC LIMIT 1000");
    return rows.map(ad).filter((value): value is TeamAd => Boolean(value));
  }

  async listAdRecipients() {
    await this.ready();
    const rows = await this.#query("SELECT * FROM team_mode_v2_ad_recipients ORDER BY queued_at ASC LIMIT 5000");
    return rows.map(adRecipient).filter((value): value is TeamAdRecipient => Boolean(value));
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
    const [ads, pendingRows] = await Promise.all([
      this.listAds(),
      this.#query(`SELECT d.*, 'pending' AS delivery_status, d.delivered_at AS effective_delivered_at
        FROM team_mode_v2_deliveries d
        LEFT JOIN team_mode_v2_delivery_receipts r ON r.delivery_id = d.id
        WHERE d.receiver_member_id = $1 AND r.delivery_id IS NULL
        ORDER BY d.delivered_at ASC LIMIT 1`, [receiver.id]),
    ]);
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

    const queued = (await this.#query(`SELECT recipients.* FROM team_mode_v2_ad_recipients recipients
      INNER JOIN team_mode_v2_ads ads ON ads.id = recipients.ad_id
      LEFT JOIN team_mode_v2_deliveries deliveries
        ON deliveries.ad_id = recipients.ad_id AND deliveries.receiver_member_id = recipients.receiver_member_id
      WHERE recipients.receiver_member_id = $1 AND ads.active = TRUE AND deliveries.id IS NULL
      ORDER BY recipients.queued_at ASC LIMIT 1`, [receiver.id]))[0];
    const queuedAd = queued ? ads.find((ad) => ad.id === text(queued.ad_id)) : undefined;

    if (queuedAd) {
      const claimed: TeamDelivery = {
        id: `team_delivery_${crypto.randomUUID()}`,
        adId: queuedAd.id,
        receiverMemberId: receiver.id,
        installationId: receiver.installationId,
        points: TEAM_EARN_PER_DISPLAYED_AD,
        matchedTags: [],
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
      if (inserted.length === 1) return { ad: queuedAd, delivery: claimed };
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
  `CREATE TABLE IF NOT EXISTS team_mode_v2_point_balances (
    member_id TEXT PRIMARY KEY REFERENCES team_mode_v2_members(id) ON DELETE CASCADE,
    balance INTEGER NOT NULL CHECK (balance >= 0), credits_applied INTEGER NOT NULL DEFAULT 0 CHECK (credits_applied >= 0)
  )`,
  `INSERT INTO team_mode_v2_point_balances (member_id, balance, credits_applied)
    SELECT id, ${TEAM_STARTING_POINTS}, 0 FROM team_mode_v2_members ON CONFLICT DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS team_mode_v2_ads (
    id TEXT PRIMARY KEY, advertiser_member_id TEXT NOT NULL REFERENCES team_mode_v2_members(id), advertiser_name TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL, target_tags_json JSONB NOT NULL, points INTEGER NOT NULL CHECK (points >= 0),
    active BOOLEAN NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS team_mode_v2_ad_recipients (
    ad_id TEXT NOT NULL REFERENCES team_mode_v2_ads(id) ON DELETE CASCADE,
    receiver_member_id TEXT NOT NULL REFERENCES team_mode_v2_members(id) ON DELETE CASCADE,
    queued_at TEXT NOT NULL, PRIMARY KEY (ad_id, receiver_member_id)
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

const MEMBER_SELECT = `SELECT m.*, points.balance + COALESCE(earned.total, 0) - points.credits_applied AS points_balance
  FROM team_mode_v2_members m
  INNER JOIN team_mode_v2_point_balances points ON points.member_id = m.id
  LEFT JOIN (
    SELECT deliveries.receiver_member_id, COUNT(*)::INTEGER AS total
    FROM team_mode_v2_delivery_receipts receipts
    INNER JOIN team_mode_v2_deliveries deliveries ON deliveries.id = receipts.delivery_id
    GROUP BY deliveries.receiver_member_id
  ) earned ON earned.receiver_member_id = m.id`;

function member(row: Record<string, unknown> | undefined): TeamMember | undefined {
  if (!row) return undefined;
  return {
    id: text(row.id), installationId: text(row.installation_id), displayName: text(row.display_name),
    tags: texts(row.tags_json), receivesAds: row.receives_ads === true, pointsBalance: integer(row.points_balance),
    createdAt: text(row.created_at), updatedAt: text(row.updated_at),
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

function adRecipient(row: Record<string, unknown> | undefined): TeamAdRecipient | undefined {
  if (!row) return undefined;
  return { adId: text(row.ad_id), receiverMemberId: text(row.receiver_member_id), queuedAt: text(row.queued_at) };
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
