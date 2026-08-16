import type { OpportunityCandidate } from "@ad-daddy/cli/campaign";
import { matchStoredOpportunity, parseStoredCampaignAudience, record } from "./audience-eligibility.ts";

type Row = Record<string, unknown>;
const SCAN_PAGE_SIZE = 100;
const MAX_CANDIDATE_SCAN = 2_000;

export class D1OpportunityCandidateRepository {
  readonly #db: D1Database;
  constructor(db: D1Database) { this.#db = db; }

  async list(campaignId: string, now = new Date()): Promise<readonly OpportunityCandidate[]> {
    const campaign = await this.#db.prepare(`SELECT audience_json AS audienceJson, brand_id AS brandId
      FROM campaigns WHERE id = ?`).bind(campaignId).first<Row>();
    if (!campaign) throw new Error("Unknown campaign");
    const audience = parseStoredCampaignAudience(JSON.parse(text(campaign.audienceJson)));
    const instant = now.toISOString();
    const candidates: OpportunityCandidate[] = [];
    let scanned = 0;
    let afterOpenedAt = "";
    let afterId = "";
    while (scanned < MAX_CANDIDATE_SCAN) {
      const pageSize = Math.min(SCAN_PAGE_SIZE, MAX_CANDIDATE_SCAN - scanned);
      const rows = await this.#db.prepare(`SELECT o.id AS opportunityId, o.opened_at AS openedAt,
        o.consent_version AS consentVersion, rp.current_consent_version AS currentConsentVersion,
        o.expires_at AS expiresAt, i.host_kind AS host, ps.published_fields_json AS fieldsJson,
        CASE WHEN EXISTS (SELECT 1 FROM payout_destinations pd WHERE pd.account_id = rp.account_id
          AND pd.activates_at <= ? AND pd.superseded_at IS NULL) THEN 1 ELSE 0 END AS hasCashPayoutAddress
        FROM opportunities o JOIN receiver_profiles rp ON rp.id = o.receiver_profile_id
        JOIN receiver_consent_versions rcv ON rcv.receiver_profile_id = rp.id AND rcv.version = rp.current_consent_version
        JOIN installations i ON i.id = o.installation_id
        JOIN profile_snapshots ps ON ps.receiver_profile_id = rp.id AND ps.consent_version = o.consent_version
        WHERE o.state IN ('offered', 'bidding') AND o.expires_at > ?
          AND rp.status = 'active' AND rcv.status = 'active' AND i.status = 'active'
          AND ps.revoked_at IS NULL AND ps.expires_at > ?
          AND NOT EXISTS (SELECT 1 FROM receiver_advertiser_blocks rb
            WHERE rb.receiver_account_id = rp.account_id AND rb.advertiser_id = ?)
          AND (o.opened_at > ? OR (o.opened_at = ? AND o.id > ?))
        ORDER BY o.opened_at, o.id LIMIT ?`)
        .bind(instant, instant, instant, text(campaign.brandId), afterOpenedAt, afterOpenedAt, afterId, pageSize).all<Row>();
      const page = rows.results ?? [];
      for (const row of page) {
        const fields = record(JSON.parse(text(row.fieldsJson)));
        const match = matchStoredOpportunity(audience, { fields, host: text(row.host) });
        if (!match) continue;
        candidates.push(Object.freeze({
          rotatingOpportunityId: text(row.opportunityId), category: match.category, region: match.region, host: match.host,
          acceptedRewardTypes: match.rewardTypes, consentVersion: integer(row.consentVersion),
          currentConsentVersion: integer(row.currentConsentVersion), expiresAt: text(row.expiresAt), fields: structuredClone(fields),
          preBidExposure: Object.freeze({ projectNames: fields.projectNames !== undefined, publicRepositoryUrls: fields.publicRepositoryUrls !== undefined }),
          hasCashPayoutAddress: row.hasCashPayoutAddress === 1,
        }));
      }
      scanned += page.length;
      if (page.length < pageSize) break;
      const last = page[page.length - 1];
      afterOpenedAt = text(last.openedAt);
      afterId = text(last.opportunityId);
    }
    return Object.freeze(candidates);
  }
}
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Durable opportunity field is malformed"); return value; }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Durable opportunity version is malformed"); return value; }
