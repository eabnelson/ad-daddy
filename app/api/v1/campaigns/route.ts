import { getCampaignRuntime, type CampaignRuntime } from "../../../../lib/marketplace/campaign-registry.ts";
import { CAMPAIGN_REQUEST_LIMITS, parseBoundedJson, RequestLimitError } from "../../../../lib/http/request-limits.ts";
import type { CampaignApproval, CampaignDraft } from "@ad-daddy/cli/campaign";
import {
  approvalResourceFingerprint,
  D1ApprovalCapabilityRepository,
  type ApprovalCapabilityPurpose,
  type ApprovalCapabilityRepository,
} from "../../../../lib/auth/approval-capability.ts";
import { authenticateAccountRequest } from "../../../../lib/auth/account-agent-token.ts";

interface CampaignRequestBody {
  action: "prepare" | "fund" | "activate" | "pause" | "close" | "issue_agent_token";
  campaign?: CampaignDraft;
  campaignId?: string;
  approvalId?: string;
  token?: { scopes: readonly string[]; spendCeilingMinor: number; bidCeilingMinor: number; expiresAt: string };
}

export function createCampaignHandler(runtime?: CampaignRuntime, injectedApprovals?: ApprovalCapabilityRepository) {
  return async function handle(request: Request): Promise<Response> {
    const activeRuntime = runtime ?? await getCampaignRuntime();
    const accountId = await authenticateAccountRequest(request, "campaign:manage");
    if (!accountId) return response(401, { error: "human_authentication_required" });
    const ip = clientIp(request);
    const initialLimit = activeRuntime.campaignRateLimit.check([`actor:${accountId}`, `ip:${ip}`]);
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
    const resourceLimit = activeRuntime.campaignRateLimit.check([`campaign:${campaignId}`]);
    if (!resourceLimit.allowed) return rateLimited(resourceLimit.retryAfterSeconds);
    try {
      if (body.action === "prepare") {
        if (!body.campaign) return response(400, { error: "campaign_required" });
        const campaign = await activeRuntime.campaigns.prepare({ ...body.campaign, accountId });
        return response(201, { campaign });
      }
      const current = await activeRuntime.campaigns.get(campaignId);
      if (current.accountId !== accountId) return response(404, { error: "campaign_not_found" });
      if (body.action === "fund") {
        const approval = await consumeCampaignApproval(body.approvalId, "campaign_fund", current, accountId, injectedApprovals);
        return response(200, { campaign: await activeRuntime.campaigns.fund(campaignId, approval) });
      }
      if (body.action === "activate") {
        const approval = await consumeCampaignApproval(body.approvalId, "campaign_activate", current, accountId, injectedApprovals);
        return response(200, { campaign: await activeRuntime.campaigns.activate(campaignId, approval) });
      }
      if (body.action === "pause") return response(200, { campaign: await activeRuntime.campaigns.pause(campaignId) });
      if (body.action === "close") {
        const approval = await consumeCampaignApproval(body.approvalId, "campaign_close", current, accountId, injectedApprovals);
        return response(200, await activeRuntime.campaigns.close(campaignId, approval));
      }
      if (body.action === "issue_agent_token") {
        if (!body.token || current.status !== "active") return response(409, { error: "active_campaign_required" });
        if (body.token.spendCeilingMinor > current.maximumSpendMinor || body.token.bidCeilingMinor > current.maximumBidMinor) return response(400, { error: "token_ceiling_exceeds_campaign" });
        const token = await activeRuntime.tokens.issue({
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

export async function consumeCampaignApproval(
  approvalId: string | undefined,
  purpose: ApprovalCapabilityPurpose,
  campaign: CampaignDraft,
  accountId: string,
  injected?: ApprovalCapabilityRepository,
): Promise<CampaignApproval> {
  if (!approvalId) throw new Error("A server-issued human approval capability is required");
  const now = new Date();
  const approvals = injected ?? await deployedApprovals();
  const record = await approvals.consume({
    approvalId, accountId, purpose,
    resourceFingerprint: approvalResourceFingerprint(campaignApprovalBinding(campaign)),
    useId: `${purpose}:${campaign.campaignId}`,
    now,
  });
  const purposes = purpose === "campaign_fund"
    ? ["advertiser_verify", "terms_accept", "campaign_fund"]
    : purpose === "campaign_activate"
      ? ["advertiser_verify", "terms_accept", "campaign_fund", "production_activate"]
      : ["campaign_close"];
  return {
    accountId,
    approvedAt: record.approvedAt,
    expiresAt: record.expiresAt,
    purposes,
    approvedCampaignId: campaign.campaignId,
    approvedMaximumSpendMinor: campaign.maximumSpendMinor,
    approvedDestinationUrl: campaign.destinationUrl,
    approvedConversionTerms: campaign.conversionTerms,
  };
}

export function campaignApprovalBinding(campaign: CampaignDraft) {
  return {
    campaignId: campaign.campaignId,
    maximumSpendMinor: campaign.maximumSpendMinor,
    destinationUrl: campaign.destinationUrl,
    conversionTerms: campaign.conversionTerms,
    advertiserTermsVersion: campaign.advertiserTermsVersion,
  };
}

let cachedApprovals: ApprovalCapabilityRepository | undefined;
async function deployedApprovals(): Promise<ApprovalCapabilityRepository> {
  if (cachedApprovals) return cachedApprovals;
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("D1 approval capability binding is required");
  cachedApprovals = new D1ApprovalCapabilityRepository(env.DB);
  return cachedApprovals;
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
