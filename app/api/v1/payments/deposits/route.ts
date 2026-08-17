import { PAYMENT_REQUEST_LIMITS, parseBoundedJson, RequestLimitError } from "../../../../../lib/http/request-limits.ts";
import { opaqueTempoMemo, type TempoTransferEvent } from "../../../../../lib/payments/tempo-client.ts";
import { getPaymentRuntime, type PaymentRuntime } from "../../../../../lib/payments/runtime.ts";
import { getCampaignRuntime, type CampaignRuntime } from "../../../../../lib/marketplace/campaign-registry.ts";
import type { PaymentEventEnvelope } from "../../../../../lib/auth/operator-event-envelope.ts";
import { verifiedAccountId } from "../../../../../lib/auth/verified-request-identity.ts";

type DepositBody =
  | { action: "prepare"; campaignId: string; amountMinor: number; expectedSender?: string }
  | { action: "observe_finalized_event"; envelope: PaymentEventEnvelope };

export function createDepositHandler(injectedRuntime?: PaymentRuntime, campaigns?: CampaignRuntime) {
  return async function handle(request: Request): Promise<Response> {
    const runtime = injectedRuntime ?? await getPaymentRuntime();
    const campaignState = campaigns ?? await getCampaignRuntime();
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const ipLimit = runtime.rateLimit.check([`deposit-ip:${ip}`]);
    if (!ipLimit.allowed) return rateLimited(ipLimit.retryAfterSeconds);
    let body: DepositBody;
    try { body = await parseBoundedJson(request, PAYMENT_REQUEST_LIMITS) as DepositBody; }
    catch (error) { return limitError(error); }
    try {
      if (body?.action === "prepare") {
        const accountId = verifiedAccountId(request);
        if (!accountId) return json(401, { error: "human_authentication_required" });
        const actorLimit = runtime.rateLimit.check([`deposit-actor:${accountId}`, `deposit-campaign:${body.campaignId}`]);
        if (!actorLimit.allowed) return rateLimited(actorLimit.retryAfterSeconds);
        if (!Number.isSafeInteger(body.amountMinor) || body.amountMinor < 1) return json(400, { error: "invalid_deposit_amount" });
        const campaign = await campaignState.campaigns.get(body.campaignId);
        if (campaign.accountId !== accountId) return json(404, { error: "campaign_not_found" });
        if (campaign.maximumSpendMinor !== body.amountMinor) return json(400, { error: "deposit_must_match_campaign_maximum" });
        const memo = opaqueTempoMemo("deposit", `${accountId}:${body.campaignId}:${body.amountMinor}`, runtime.memoSalt);
        const commitment = await runtime.deposits.register({
          commitmentId: `campaign:${body.campaignId}:deposit`, campaignId: body.campaignId,
          advertiserAccountId: accountId, advertiserLedgerAccountId: `advertiser:${accountId}`,
          treasuryLedgerAccountId: "treasury:tempo", amountMinor: body.amountMinor,
          memo, expectedSender: body.expectedSender,
        });
        return json(201, { commitment, chainId: runtime.policy.chainId, tokenAddress: runtime.policy.tokenAddress });
      }
      if (body?.action === "observe_finalized_event") {
        if (request.headers.has("oai-operator-scope")) return json(403, { error: "private_payment_event_capability_required" });
        let event: TempoTransferEvent;
        try { event = runtime.operatorEvents.verify(body.envelope); }
        catch { return json(403, { error: "private_payment_event_capability_required" }); }
        const eventLimit = runtime.rateLimit.check([`deposit-memo:${event.memo}`]);
        if (!eventLimit.allowed) return rateLimited(eventLimit.retryAfterSeconds);
        return json(200, { deposit: await runtime.deposits.process(event) });
      }
      return json(400, { error: "invalid_deposit_action" });
    } catch (error) { return json(409, { error: "deposit_rejected", message: boundedError(error) }); }
  };
}

export const POST = createDepositHandler();
function json(status: number, body: unknown) { return Response.json(body, { status }); }
function rateLimited(seconds: number) { return Response.json({ error: "rate_limited", retryAfterSeconds: seconds }, { status: 429, headers: { "retry-after": String(seconds) } }); }
function limitError(error: unknown) { return error instanceof RequestLimitError ? json(error.status, { error: error.code }) : json(400, { error: "invalid_request" }); }
function boundedError(error: unknown) { return (error instanceof Error ? error.message : "Deposit rejected").slice(0, 240); }
