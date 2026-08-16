import { getCampaignRuntime, type CampaignRuntime } from "../../../../../../lib/marketplace/campaign-registry.ts";
import { PAYMENT_REQUEST_LIMITS, parseBoundedJson, RequestLimitError } from "../../../../../../lib/http/request-limits.ts";
import { getPaymentRuntime, type PaymentRuntime } from "../../../../../../lib/payments/runtime.ts";

export function createRefundHandler(campaigns?: CampaignRuntime, injectedPayments?: PaymentRuntime) {
  return async function handle(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const payments = injectedPayments ?? await getPaymentRuntime();
    const campaignState = campaigns ?? await getCampaignRuntime();
    const accountId = request.headers.get("oai-authenticated-user-id");
    if (!accountId) return json(401, { error: "human_authentication_required" });
    const { id } = await context.params;
    const limit = payments.rateLimit.check([`refund-ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`, `refund-actor:${accountId}`, `refund-campaign:${id}`]);
    if (!limit.allowed) return rateLimited(limit.retryAfterSeconds);
    let body: { refundId: string; approvalId: string };
    try { body = await parseBoundedJson(request, PAYMENT_REQUEST_LIMITS) as typeof body; }
    catch (error) { return limitError(error); }
    try {
      const campaign = await campaignState.campaigns.get(id);
      if (campaign.accountId !== accountId) return json(404, { error: "campaign_not_found" });
      if (!campaign.closedAt || (await campaignState.budgets.snapshot(id)).status !== "closed") return json(409, { error: "closed_campaign_required" });
      await payments.refunds.prepare({
        refundId: body.refundId, approvalId: body.approvalId, accountId, campaignId: id,
        advertiserLedgerAccountId: `advertiser:${accountId}`, treasuryLedgerAccountId: "treasury:tempo",
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
