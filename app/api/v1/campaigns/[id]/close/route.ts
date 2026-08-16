import { consumeCampaignApproval } from "../../route.ts";
import type { ApprovalCapabilityRepository } from "../../../../../../lib/auth/approval-capability.ts";
import { getCampaignRuntime, type CampaignRuntime } from "../../../../../../lib/marketplace/campaign-registry.ts";
import { PAYMENT_REQUEST_LIMITS, parseBoundedJson, RequestLimitError } from "../../../../../../lib/http/request-limits.ts";
import { getPaymentRuntime, type PaymentRuntime } from "../../../../../../lib/payments/runtime.ts";

export function createCloseCampaignHandler(campaigns?: CampaignRuntime, injectedPayments?: PaymentRuntime, approvals?: ApprovalCapabilityRepository) {
  return async function handle(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const payments = injectedPayments ?? await getPaymentRuntime();
    const campaignState = campaigns ?? await getCampaignRuntime();
    const accountId = request.headers.get("oai-authenticated-user-id");
    if (!accountId) return json(401, { error: "human_authentication_required" });
    const { id } = await context.params;
    const limit = payments.rateLimit.check([`close-ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`, `close-actor:${accountId}`, `close-campaign:${id}`]);
    if (!limit.allowed) return rateLimited(limit.retryAfterSeconds);
    let approvalId: string | undefined;
    try { approvalId = (await parseBoundedJson(request, PAYMENT_REQUEST_LIMITS) as { approvalId?: string }).approvalId; }
    catch (error) { return limitError(error); }
    try {
      const campaign = await campaignState.campaigns.get(id);
      if (campaign.accountId !== accountId) return json(404, { error: "campaign_not_found" });
      const approval = await consumeCampaignApproval(approvalId, "campaign_close", campaign, accountId, approvals);
      const closed = await campaignState.campaigns.close(id, approval);
      const budget = await campaignState.budgets.snapshot(id);
      return json(200, { ...closed, budget });
    } catch (error) { return json(409, { error: "campaign_close_rejected", message: boundedError(error) }); }
  };
}
export const POST = createCloseCampaignHandler();
function json(status: number, body: unknown) { return Response.json(body, { status }); }
function rateLimited(seconds: number) { return Response.json({ error: "rate_limited", retryAfterSeconds: seconds }, { status: 429, headers: { "retry-after": String(seconds) } }); }
function limitError(error: unknown) { return error instanceof RequestLimitError ? json(error.status, { error: error.code }) : json(400, { error: "invalid_request" }); }
function boundedError(error: unknown) { return (error instanceof Error ? error.message : "Campaign close rejected").slice(0, 240); }
