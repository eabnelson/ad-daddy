import { requireChatGPTUser } from "../../chatgpt-auth";

export default async function AdvertiserCampaignsPage() {
  await requireChatGPTUser("/advertiser/campaigns");
  return (
    <main className="settings-shell">
      <header><p>Advertiser campaign</p><h1>Give your agent a bounded brief.</h1></header>
      <p>Your agent can prepare targeting and search rotating opportunities. You approve the brand, destination, terms, maximum spend, conversion terms, activation, and closure.</p>
      <form action="/api/v1/campaigns" method="post">
        <fieldset>
          <legend>Campaign envelope</legend>
          <label>Verified brand domain<input name="brandDomain" type="url" placeholder="https://example.com" required /></label>
          <label>Maximum spend<input name="maximumSpendMinor" type="number" min="1" required /></label>
          <label>Maximum bid<input name="maximumBidMinor" type="number" min="1" required /></label>
          <label>Starts<input name="startsAt" type="datetime-local" required /></label>
          <label>Ends<input name="endsAt" type="datetime-local" required /></label>
          <label>Offer<select name="rewardType"><option value="stablecoin">Stablecoin</option><option value="credits">Credits</option><option value="discount">Discount</option></select></label>
        </fieldset>
        <button type="submit">Prepare for review</button>
      </form>
    </main>
  );
}
