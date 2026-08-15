import { campaignRuntime, type CampaignRuntime } from "../../../../lib/marketplace/campaign-registry.ts";
import { CAMPAIGN_REQUEST_LIMITS, parseBoundedJson, RequestLimitError } from "../../../../lib/http/request-limits.ts";
import type { CampaignApproval, CampaignDraft } from "../../../../packages/cli/src/commands/campaign.ts";

interface CampaignRequestBody {
  action: "prepare" | "fund" | "activate" | "pause" | "close" | "issue_agent_token";
  campaign?: CampaignDraft;
  campaignId?: string;
  amountMinor?: number;
  approval?: CampaignApproval;
  token?: { scopes: readonly string[]; spendCeilingMinor: number; bidCeilingMinor: number; expiresAt: string };
}

export function createCampaignHandler(runtime: CampaignRuntime = campaignRuntime) {
  return async function handle(request: Request): Promise<Response> {
    const accountId = request.headers.get("oai-authenticated-user-id");
    if (!accountId) return response(401, { error: "human_authentication_required" });
    const ip = clientIp(request);
    const initialLimit = runtime.campaignRateLimit.check([`actor:${accountId}`, `ip:${ip}`]);
    if (!initialLimit.allowed) return rateLimited(initialLimit.retryAfterSeconds);
    let body: CampaignRequestBody;
    try {
      const parsed = await parseBoundedJson(request, CAMPAIGN_REQUEST_LIMITS);
      if (!isRecord(parsed) || typeof parsed.action !== "string") return response(400, { error: "invalid_campaign_request" });
      body = parsed as unknown as CampaignRequestBody;
    }
    catch (error) { return limitError(error); }
    const campaignId = body.campaignId ?? body.campaign?.campaignId;
    if (!campaignId || campaignId.length > 128) return response(400, { error: "campaign_id_required" });
    const resourceLimit = runtime.campaignRateLimit.check([`campaign:${campaignId}`]);
    if (!resourceLimit.allowed) return rateLimited(resourceLimit.retryAfterSeconds);
    try {
      if (body.action === "prepare") {
        if (!body.campaign) return response(400, { error: "campaign_required" });
        const campaign = await runtime.campaigns.prepare({ ...body.campaign, accountId });
        return response(201, { campaign });
      }
      const current = await runtime.campaigns.get(campaignId);
      if (current.accountId !== accountId) return response(404, { error: "campaign_not_found" });
      if (body.action === "fund") {
        if (!body.approval || body.amountMinor === undefined) return response(403, { error: "verified_human_funding_approval_required" });
        return response(200, { campaign: await runtime.campaigns.fund(campaignId, body.amountMinor, body.approval) });
      }
      if (body.action === "activate") {
        if (!body.approval) return response(403, { error: "verified_human_activation_approval_required" });
        return response(200, { campaign: await runtime.campaigns.activate(campaignId, body.approval) });
      }
      if (body.action === "pause") return response(200, { campaign: await runtime.campaigns.pause(campaignId) });
      if (body.action === "close") {
        if (!body.approval) return response(403, { error: "verified_human_close_approval_required" });
        return response(200, await runtime.campaigns.close(campaignId, body.approval));
      }
      if (body.action === "issue_agent_token") {
        if (!body.token || current.status !== "active") return response(409, { error: "active_campaign_required" });
        if (body.token.spendCeilingMinor > current.maximumSpendMinor || body.token.bidCeilingMinor > current.maximumBidMinor) return response(400, { error: "token_ceiling_exceeds_campaign" });
        const token = await runtime.tokens.issue({
          tokenId: crypto.randomUUID(), accountId, campaignId,
          scopes: body.token.scopes,
          spendCeilingMinor: body.token.spendCeilingMinor,
          bidCeilingMinor: body.token.bidCeilingMinor,
          expiresAt: body.token.expiresAt,
        });
        return response(201, { token, expiresAt: body.token.expiresAt });
      }
      return response(400, { error: "unknown_action" });
    } catch (error) {
      return response(409, { error: "campaign_request_rejected", message: boundedMessage(error) });
    }
  };
}

export const POST = createCampaignHandler();

function clientIp(request: Request) { return request.headers.get("cf-connecting-ip") ?? "unknown"; }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function boundedMessage(error: unknown) { return (error instanceof Error ? error.message : "Request rejected").slice(0, 240); }
function response(status: number, body: unknown, headers?: HeadersInit) { return Response.json(body, { status, headers }); }
function rateLimited(seconds: number) { return response(429, { error: "rate_limited", retryAfterSeconds: seconds }, { "retry-after": String(seconds) }); }
function limitError(error: unknown) {
  if (error instanceof RequestLimitError) return response(error.status, { error: error.code, message: error.message.slice(0, 160) });
  return response(400, { error: "invalid_request" });
}
