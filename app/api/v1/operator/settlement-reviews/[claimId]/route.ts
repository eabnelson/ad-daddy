import { parseBoundedJson, RequestLimitError } from "../../../../../../lib/http/request-limits.ts";
import {
  D1SettlementReviewApprovalRepository,
  SettlementReviewService,
  type SettlementReviewApprovalRepository,
  type SettlementReviewDecision,
} from "../../../../../../lib/marketplace/settlement-review.ts";
import {
  deployedSponsorshipRuntime,
  sponsorshipRequestRateLimit,
  type SponsorshipRuntime,
} from "../../../../../../lib/marketplace/sponsorship-runtime.ts";

const LIMITS = { maxBytes: 1_024, maxDepth: 2, maxCollectionItems: 4, maxStringLength: 32 } as const;

export function createSettlementReviewHandler(
  runtime?: SponsorshipRuntime,
  approvalRepository?: SettlementReviewApprovalRepository,
  operatorAccountIds?: readonly string[],
) {
  return async function handle(request: Request, context: { params: Promise<{ claimId: string }> }): Promise<Response> {
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    const operatorAccountId = request.headers.get("oai-authenticated-user-id");
    const operators = new Set((operatorAccountIds ?? await deployedOperators()).filter(Boolean));
    if (!operatorAccountId || !operators.has(operatorAccountId)) return Response.json({ error: "operator_authentication_required" }, { status: 403 });
    const limit = sponsorshipRequestRateLimit.check([`settlement-review-operator:${operatorAccountId}`]);
    if (!limit.allowed) return Response.json({ error: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds }, { status: 429 });
    const { claimId } = await context.params;
    if (!claimId || claimId.length > 256) return Response.json({ error: "settlement_review_not_found" }, { status: 404 });
    try {
      const body = await parseBoundedJson(request, LIMITS) as { resolution?: SettlementReviewDecision };
      if (body.resolution !== "settled" && body.resolution !== "released") throw new Error("A settlement-review resolution is required");
      const activeRuntime = runtime ?? await deployedSponsorshipRuntime();
      const approvals = approvalRepository ?? await deployedApprovals();
      const result = await new SettlementReviewService(activeRuntime.service, approvals).approve({
        claimId, operatorAccountId, resolution: body.resolution, now: activeRuntime.clock(),
      });
      return Response.json(result, { status: result.status === "pending_second_operator" ? 202 : 200, headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof RequestLimitError) return Response.json({ error: error.code }, { status: error.status });
      return Response.json({ error: "settlement_review_rejected", message: (error instanceof Error ? error.message : "Request rejected").slice(0, 180) }, { status: 409 });
    }
  };
}

let approvals: SettlementReviewApprovalRepository | undefined;
async function deployedApprovals() {
  if (approvals) return approvals;
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("D1 settlement-review binding is required");
  approvals = new D1SettlementReviewApprovalRepository(env.DB);
  return approvals;
}

async function deployedOperators() {
  const { env } = await import("cloudflare:workers");
  return (env.AD_DADDY_OPERATOR_ACCOUNT_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

export const POST = createSettlementReviewHandler();
