import type { SponsorshipClaimService } from "./sponsorship-claims.ts";
import { KeyedSerialExecutor } from "../runtime/keyed-serial.ts";

export type SettlementReviewDecision = "settled" | "released";

export interface SettlementReviewApprovalRepository {
  approve(input: { claimId: string; operatorAccountId: string; resolution: SettlementReviewDecision; approvedAt: string }): Promise<number>;
  getResolution(claimId: string): Promise<SettlementReviewDecision | undefined>;
  acquireResolution(input: { claimId: string; resolution: SettlementReviewDecision; decidedAt: string }): Promise<SettlementReviewDecision>;
}

export class MemorySettlementReviewApprovalRepository implements SettlementReviewApprovalRepository {
  readonly #records = new Map<string, Map<string, SettlementReviewDecision>>();
  readonly #resolutions = new Map<string, SettlementReviewDecision>();
  readonly #serial = new KeyedSerialExecutor();

  async approve(input: { claimId: string; operatorAccountId: string; resolution: SettlementReviewDecision }): Promise<number> {
    const records = this.#records.get(input.claimId) ?? new Map<string, SettlementReviewDecision>();
    const existing = records.get(input.operatorAccountId);
    if (existing && existing !== input.resolution) throw new Error("An operator cannot change a settlement-review decision");
    records.set(input.operatorAccountId, input.resolution);
    this.#records.set(input.claimId, records);
    return [...records.values()].filter((resolution) => resolution === input.resolution).length;
  }

  async getResolution(claimId: string) { return this.#resolutions.get(claimId); }

  acquireResolution(input: { claimId: string; resolution: SettlementReviewDecision }): Promise<SettlementReviewDecision> {
    return this.#serial.run(input.claimId, () => {
      const existing = this.#resolutions.get(input.claimId);
      if (existing && existing !== input.resolution) throw new Error("Settlement review already has the opposite durable resolution");
      if (!existing) this.#resolutions.set(input.claimId, input.resolution);
      return existing ?? input.resolution;
    });
  }
}

export class D1SettlementReviewApprovalRepository implements SettlementReviewApprovalRepository {
  readonly #db: D1Database;
  constructor(db: D1Database) { this.#db = db; }

  async approve(input: { claimId: string; operatorAccountId: string; resolution: SettlementReviewDecision; approvedAt: string }): Promise<number> {
    await this.#db.prepare(`INSERT OR IGNORE INTO settlement_review_approvals
      (claim_id, operator_account_id, resolution, approved_at) VALUES (?, ?, ?, ?)`)
      .bind(input.claimId, input.operatorAccountId, input.resolution, input.approvedAt).run();
    const existing = await this.#db.prepare(`SELECT resolution FROM settlement_review_approvals
      WHERE claim_id = ? AND operator_account_id = ?`).bind(input.claimId, input.operatorAccountId).first<{ resolution: string }>();
    if (existing?.resolution !== input.resolution) throw new Error("An operator cannot change a settlement-review decision");
    const count = await this.#db.prepare(`SELECT COUNT(*) AS approvalCount FROM settlement_review_approvals
      WHERE claim_id = ? AND resolution = ?`).bind(input.claimId, input.resolution).first<{ approvalCount: number }>();
    return count?.approvalCount ?? 0;
  }

  async getResolution(claimId: string): Promise<SettlementReviewDecision | undefined> {
    const row = await this.#db.prepare(`SELECT p.state, pc.settlement_review_started_at AS reviewStartedAt FROM placements p
      JOIN placement_claims pc ON pc.placement_id = p.id WHERE pc.id = ?`)
      .bind(claimId).first<{ state: string; reviewStartedAt: string | null }>();
    if (!row?.reviewStartedAt || row.state === "settlement_review") return undefined;
    if (["delivered", "settled"].includes(row.state)) return "settled";
    if (["cancelled", "expired"].includes(row.state)) return "released";
    return undefined;
  }

  async acquireResolution(input: { claimId: string; resolution: SettlementReviewDecision; decidedAt: string }): Promise<SettlementReviewDecision> {
    const placementState = input.resolution === "settled" ? "delivered" : "cancelled";
    await this.#db.prepare(`UPDATE placements SET state = ?, updated_at = ?
      WHERE id = (SELECT placement_id FROM placement_claims WHERE id = ? AND state = 'settlement_review')
        AND state = 'settlement_review'`).bind(placementState, input.decidedAt, input.claimId).run();
    const acquired = await this.getResolution(input.claimId);
    if (!acquired) throw new Error("Settlement review is unavailable");
    if (acquired !== input.resolution) throw new Error("Settlement review already has the opposite durable resolution");
    return acquired;
  }
}

export class SettlementReviewService {
  readonly #claims: SponsorshipClaimService;
  readonly #approvals: SettlementReviewApprovalRepository;
  constructor(claims: SponsorshipClaimService, approvals: SettlementReviewApprovalRepository) {
    this.#claims = claims;
    this.#approvals = approvals;
  }

  async approve(input: { claimId: string; operatorAccountId: string; resolution: SettlementReviewDecision; now?: Date }) {
    const now = input.now ?? new Date();
    const existingResolution = await this.#approvals.getResolution(input.claimId);
    if (existingResolution && existingResolution !== input.resolution) {
      throw new Error("Settlement review already has the opposite durable resolution");
    }
    const review = await this.#claims.settlementReviewStatus(input.claimId);
    if (!review.available) {
      if (existingResolution) return { status: existingResolution, approvalCount: 2 } as const;
      throw new Error("Settlement review is unavailable");
    }
    if (input.resolution === "settled" && !review.hasVerifiedReceipt) throw new Error("A verified display receipt is required to settle");
    const approvalCount = await this.#approvals.approve({ ...input, approvedAt: now.toISOString() });
    if (approvalCount < 2) return { status: "pending_second_operator" as const, approvalCount };
    const resolution = await this.#approvals.acquireResolution({ claimId: input.claimId, resolution: input.resolution, decidedAt: now.toISOString() });
    const resolved = await this.#claims.resolveSettlementReview(input.claimId, resolution, now);
    return { status: resolved.status, approvalCount };
  }
}
