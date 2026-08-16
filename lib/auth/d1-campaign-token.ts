import type { CampaignTokenState, CampaignTokenStore } from "./campaign-token.ts";

type Row = Record<string, unknown>;

export class D1CampaignTokenStore implements CampaignTokenStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async register(state: CampaignTokenState, now: Date): Promise<void> {
    void now;
    const existing = await this.get(state.claims.tokenId);
    if (existing) throw new Error("Campaign token id is already active");
    await this.#db.prepare(`INSERT INTO campaign_agent_tokens
      (id, account_id, campaign_id, token_hash, scopes_json, spend_ceiling_minor, spent_minor, bid_ceiling_minor, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)
      `).bind(
        state.claims.tokenId, state.claims.accountId, state.claims.campaignId, state.tokenHash,
        JSON.stringify(state.claims.scopes), state.claims.spendCeilingMinor, state.claims.bidCeilingMinor,
        state.claims.expiresAt,
      ).run();
    const stored = await this.get(state.claims.tokenId);
    if (!stored || stored.tokenHash !== state.tokenHash) throw new Error("Campaign token id is already active");
  }

  async get(tokenId: string): Promise<CampaignTokenState | undefined> {
    const row = await this.#db.prepare(`SELECT id, account_id AS accountId, campaign_id AS campaignId, token_hash AS tokenHash,
      scopes_json AS scopesJson, spend_ceiling_minor AS spendCeilingMinor, spent_minor AS spentMinor,
      bid_ceiling_minor AS bidCeilingMinor, expires_at AS expiresAt, revoked_at AS revokedAt
      FROM campaign_agent_tokens WHERE id = ?`).bind(tokenId).first<Row>();
    if (!row) return undefined;
    const scopes = JSON.parse(text(row.scopesJson)) as unknown;
    if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) throw new Error("Durable campaign token scopes are malformed");
    return {
      claims: {
        tokenId: text(row.id), accountId: text(row.accountId), campaignId: text(row.campaignId), scopes,
        spendCeilingMinor: integer(row.spendCeilingMinor), bidCeilingMinor: integer(row.bidCeilingMinor), expiresAt: text(row.expiresAt),
      },
      tokenHash: text(row.tokenHash), spentMinor: integer(row.spentMinor),
      ...(row.revokedAt ? { revokedAt: text(row.revokedAt) } : {}),
    };
  }

  async revoke(tokenId: string, now: Date): Promise<void> {
    await this.#db.prepare(`UPDATE campaign_agent_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`)
      .bind(now.toISOString(), tokenId).run();
  }

  async authorizeSpend(input: { tokenId: string; tokenHash: string; amountMinor: number; idempotencyKey: string; now: Date }) {
    const existing = await this.#db.prepare(`SELECT amount_minor AS amountMinor, status FROM campaign_agent_token_spends
      WHERE token_id = ? AND idempotency_key = ?`).bind(input.tokenId, input.idempotencyKey).first<Row>();
    if (existing) {
      if (integer(existing.amountMinor) !== input.amountMinor || existing.status === "released") throw new Error("Campaign token spend idempotency collision");
      return { newlyAuthorized: false, usedMinor: (await this.require(input.tokenId)).spentMinor };
    }
    const now = input.now.toISOString();
    const results = await this.#db.batch([
      this.#db.prepare(`INSERT INTO campaign_agent_token_spends (token_id, idempotency_key, amount_minor, status)
        SELECT id, ?, ?, 'authorized' FROM campaign_agent_tokens
        WHERE id = ? AND token_hash = ? AND revoked_at IS NULL AND expires_at > ?
          AND spent_minor + ? <= spend_ceiling_minor`).bind(
            input.idempotencyKey, input.amountMinor, input.tokenId, input.tokenHash, now, input.amountMinor,
          ),
      this.#db.prepare(`UPDATE campaign_agent_tokens SET spent_minor = spent_minor + ?
        WHERE id = ? AND token_hash = ? AND revoked_at IS NULL AND expires_at > ?
          AND spent_minor + ? <= spend_ceiling_minor
          AND EXISTS (SELECT 1 FROM campaign_agent_token_spends s WHERE s.token_id = campaign_agent_tokens.id
            AND s.idempotency_key = ? AND s.amount_minor = ? AND s.status = 'authorized')`).bind(
              input.amountMinor, input.tokenId, input.tokenHash, now, input.amountMinor, input.idempotencyKey, input.amountMinor,
            ),
    ]);
    if (changes(results[0]) !== 1 || changes(results[1]) !== 1) throw new Error("Campaign token spend ceiling exceeded");
    return { newlyAuthorized: true, usedMinor: (await this.require(input.tokenId)).spentMinor };
  }

  async commitSpend(tokenId: string, idempotencyKey: string, now: Date): Promise<void> {
    await this.#db.prepare(`UPDATE campaign_agent_token_spends SET status = 'committed', committed_at = ?
      WHERE token_id = ? AND idempotency_key = ? AND status = 'authorized'`).bind(now.toISOString(), tokenId, idempotencyKey).run();
  }

  async releaseSpend(tokenId: string, idempotencyKey: string, now: Date): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`UPDATE campaign_agent_tokens SET spent_minor = spent_minor - COALESCE((SELECT amount_minor
        FROM campaign_agent_token_spends WHERE token_id = ? AND idempotency_key = ? AND status = 'authorized'), 0)
        WHERE id = ?`).bind(tokenId, idempotencyKey, tokenId),
      this.#db.prepare(`UPDATE campaign_agent_token_spends SET status = 'released', released_at = ?
        WHERE token_id = ? AND idempotency_key = ? AND status = 'authorized'`).bind(now.toISOString(), tokenId, idempotencyKey),
    ]);
  }

  private async require(tokenId: string): Promise<CampaignTokenState> {
    const state = await this.get(tokenId);
    if (!state) throw new Error("Campaign token is not active");
    return state;
  }
}

function changes(value: unknown): number {
  const result = value as { meta?: { changes?: unknown } };
  return typeof result?.meta?.changes === "number" ? result.meta.changes : 0;
}
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Durable campaign token field is malformed"); return value; }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Durable campaign token amount is malformed"); return value; }
