import type { CampaignService } from "./campaign.js";

export function prepareAdvertiserSetup(role: "receiver" | "advertiser" | "both") {
  if (role === "receiver") throw new Error("Advertiser setup requires advertiser or both role");
  return Object.freeze({ role, next: "verify brand ownership and prepare a bounded campaign" });
}

export class AdvertiserAgentService {
  readonly #campaigns: CampaignService;
  constructor(campaigns: CampaignService) { this.#campaigns = campaigns; }
  async search(campaignId: string, candidates: Parameters<CampaignService["search"]>[1], now = new Date()) {
    return this.#campaigns.search(campaignId, candidates, now);
  }
  async prepareBid(campaignId: string, opportunityId: string, amountMinor: number) {
    const campaign = await this.#campaigns.get(campaignId);
    if (campaign.status !== "active") throw new Error("Campaign must be active before bidding");
    if (amountMinor > campaign.maximumBidMinor) throw new Error("Bid exceeds the human-approved campaign ceiling");
    return Object.freeze({ campaignId, opportunityId, amountMinor, requiresHumanConfirmation: false });
  }
}
