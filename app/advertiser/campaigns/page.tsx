import { requireChatGPTUser } from "../../chatgpt-auth";
import { CampaignForm } from "./campaign-form";

export default async function AdvertiserCampaignsPage() {
  await requireChatGPTUser("/advertiser/campaigns");
  return (
    <main className="settings-shell">
      <header><p>Advertiser campaign</p><h1>Give your agent a bounded brief.</h1></header>
      <p>Your agent can prepare targeting and search rotating opportunities. You approve the brand, destination, terms, maximum spend, conversion terms, activation, and closure.</p>
      <CampaignForm />
    </main>
  );
}
