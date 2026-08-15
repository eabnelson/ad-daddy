import { campaignRuntime, type CampaignRuntime } from "../../../../../../lib/marketplace/campaign-registry.ts";
import { PAYMENT_REQUEST_LIMITS, parseBoundedJson, RequestLimitError } from "../../../../../../lib/http/request-limits.ts";
import type { RefundApproval } from "../../../../../../lib/payments/refunds.ts";
import { paymentRuntime, type PaymentRuntime } from "../../../../../../lib/payments/runtime.ts";

export function createRefundHandler(campaigns: CampaignRuntime = campaignRuntime, payments: PaymentRuntime = paymentRuntime) {
  return async function handle(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const accountId = request.headers.get("oai-authenticated-user-id");
    if (!accountId) return json(401, { error: "human_authentication_required" });
    const { id } = await context.params;
    const limit = payments.rateLimit.check([`refund-ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`, `refund-actor:${accountId}`, `refund-campaign:${id}`]);
    if (!limit.allowed) return rateLimited(limit.retryAfterSeconds);
    let body: { refundId: string; approval: RefundApproval };
    try { body = await parseBoundedJson(request, PAYMENT_REQUEST_LIMITS) as typeof body; }
    catch (error) { return limitError(error); }
    try {
      const campaign = await campaigns.campaigns.get(id);
      if (campaign.accountId !== accountId) return json(404, { error: "campaign_not_found" });
      const budget = payments.closedCampaigns.get(id);
      if (!budget || !campaign.closedAt) return json(409, { error: "closed_campaign_required" });
      payments.refunds.prepare({
        refundId: body.refundId, accountId, campaignId: id, campaignClosedAt: campaign.closedAt,
        budget, advertiserLedgerAccountId: `advertiser:${accountId}`, treasuryLedgerAccountId: "treasury:tempo",
        approval: body.approval,
      });
      return json(200, { refund: await payments.refunds.send(body.refundId) });
    } catch (error) { return json(409, { error: "refund_rejected", message: boundedError(error) }); }
  };
}
export const POST = createRefundHandler();
function json(status: number, body: unknown) { return Response.json(body, { status }); }
function rateLimited(seconds: number) { return Response.json({ error: "rate_limited", retryAfterSeconds: seconds }, { status: 429, headers: { "retry-after": String(seconds) } }); }
function limitError(error: unknown) { return error instanceof RequestLimitError ? json(error.status, { error: error.code }) : json(400, { error: "invalid_request" }); }
function boundedError(error: unknown) { return (error instanceof Error ? error.message : "Refund rejected").slice(0, 240); }
