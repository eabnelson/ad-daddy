import { placementDeliveryRepository } from "../../../../lib/marketplace/placement-registry.ts";
import type { PlacementDeliveryRepository } from "../../../../lib/marketplace/placement-delivery.ts";
import { lifecycleEvents, type LifecycleEventStore } from "../../../../lib/observability/events.ts";
import { campaignRuntime } from "../../../../lib/marketplace/campaign-registry.ts";

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
  source: ReportCampaignSource = campaignRuntime,
  operatorAccountIds: readonly string[] = operatorAccountsFromEnvironment(),
): CampaignReportAuthority {
  const operators = new Set(operatorAccountIds.filter(Boolean));
  return Object.freeze({
    async canReadCampaign(accountId: string, campaignId: string) {
      try {
        const campaign = await source.campaigns.get(campaignId);
        if (campaign.accountId !== accountId) return false;
        const verification = await source.brandVerifications.get(campaign.brand.verificationId);
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
  repository: PlacementDeliveryRepository = placementDeliveryRepository,
  events: LifecycleEventStore = lifecycleEvents,
  authority: CampaignReportAuthority = createCampaignReportAuthority(),
) {
  return async function handle(request: Request): Promise<Response> {
    const accountId = request.headers.get("oai-authenticated-user-id");
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
    const placements = await repository.listByCampaign(campaignId);
    return Response.json({ placements: placements.map((record) => ({
      placementId: record.placementId, campaignId: record.marketContext?.campaignId ?? null,
      status: record.status, spendMinor: record.marketContext?.grossAmountMinor ?? 0,
      renderedResponse: record.receipt && "output" in record.receipt ? record.receipt.output : null,
      receiptStatus: record.receipt ? "verified" : "unavailable",
      measurement: { sessionCreated: record.receipt ? "verified" : "unavailable", sessionOpen: "unavailable", creativeEngagement: "unavailable", conversion: "unavailable" },
    })) });
  };
}
export const GET = createReportHandler();

function operatorAccountsFromEnvironment(): readonly string[] {
  return (process.env.AD_DADDY_OPERATOR_ACCOUNT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
