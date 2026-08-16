import { getPlacementDeliveryRepository } from "../../../../lib/marketplace/placement-registry.ts";
import {
  PlacementPaginationError,
  assertPageInput,
  type PlacementDeliveryRepository,
  type PlacementPageInput,
} from "../../../../lib/marketplace/placement-delivery.ts";
import { lifecycleEvents, type LifecycleEventStore } from "../../../../lib/observability/events.ts";
import { getCampaignRuntime } from "../../../../lib/marketplace/campaign-registry.ts";
import { authenticateAccountRequest } from "../../../../lib/auth/account-agent-token.ts";

interface ReportCampaignSource {
  campaigns: {
    get(campaignId: string): Promise<{
      accountId: string;
      brand: { verificationId: string; verifiedDomain: string };
    }>;
  };
  brandVerifications: {
    get(verificationId: string): Promise<{
      accountId: string;
      verifiedDomain: string;
      status: "active" | "revoked";
    } | undefined>;
  };
}

export interface CampaignReportAuthority {
  canReadCampaign(accountId: string, campaignId: string): Promise<boolean>;
  isOperator(accountId: string): boolean;
}

export function createCampaignReportAuthority(
  source?: ReportCampaignSource,
  operatorAccountIds: readonly string[] = operatorAccountsFromEnvironment(),
): CampaignReportAuthority {
  const operators = new Set(operatorAccountIds.filter(Boolean));
  return Object.freeze({
    async canReadCampaign(accountId: string, campaignId: string) {
      try {
        const activeSource = source ?? await getCampaignRuntime();
        const campaign = await activeSource.campaigns.get(campaignId);
        if (campaign.accountId !== accountId) return false;
        const verification = await activeSource.brandVerifications.get(campaign.brand.verificationId);
        return verification?.status === "active" &&
          verification.accountId === accountId &&
          verification.verifiedDomain.toLowerCase() === campaign.brand.verifiedDomain.toLowerCase();
      } catch {
        return false;
      }
    },
    isOperator(accountId: string) { return operators.has(accountId); },
  });
}

export function createReportHandler(
  repository?: PlacementDeliveryRepository,
  events: LifecycleEventStore = lifecycleEvents,
  authority: CampaignReportAuthority = createCampaignReportAuthority(),
) {
  return async function handle(request: Request): Promise<Response> {
    const activeRepository = repository ?? await getPlacementDeliveryRepository();
    const accountId = await authenticateAccountRequest(request, "report:read");
    if (!accountId) return Response.json({ error: "human_authentication_required" }, { status: 401 });
    const campaignId = new URL(request.url).searchParams.get("campaignId");
    if (!campaignId) {
      if (!authority.isOperator(accountId)) return Response.json({ error: "campaign_id_required" }, { status: 400 });
      return Response.json({ aggregate: events.aggregate() });
    }
    if (campaignId.length > 128) return Response.json({ error: "invalid_campaign_id" }, { status: 400 });
    if (!await authority.canReadCampaign(accountId, campaignId)) {
      return Response.json({ error: "campaign_not_found" }, { status: 404 });
    }
    try {
      const page = await activeRepository.listByCampaign(campaignId, placementPageInput(request));
      return Response.json({ placements: page.placements.map((record) => ({
        placementId: record.placementId, campaignId: record.marketContext?.campaignId ?? null,
        status: record.status, spendMinor: record.marketContext?.grossAmountMinor ?? 0,
        renderedResponse: record.receipt && "output" in record.receipt ? record.receipt.output : null,
        receiptStatus: record.receipt ? "verified" : "unavailable",
        measurement: { sessionCreated: record.receipt ? "verified" : "unavailable", sessionOpen: "unavailable", creativeEngagement: "unavailable", conversion: "unavailable" },
      })), nextCursor: page.nextCursor });
    } catch (error) {
      if (error instanceof PlacementPaginationError) return Response.json({ error: "invalid_pagination" }, { status: 400 });
      throw error;
    }
  };
}
export const GET = createReportHandler();

function operatorAccountsFromEnvironment(): readonly string[] {
  return (process.env.AD_DADDY_OPERATOR_ACCOUNT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function placementPageInput(request: Request): PlacementPageInput {
  const url = new URL(request.url);
  const input = {
    limit: Number(url.searchParams.get("limit") ?? 50),
    ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") ?? "" } : {}),
  };
  assertPageInput(input);
  return input;
}
