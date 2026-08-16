import { requireChatGPTUser } from "../../chatgpt-auth";
import { RECEIVER_FIELD_KEYS, type ReceiverFieldKey } from "@ad-daddy/cli";

const FIELD_LABELS: Record<ReceiverFieldKey, string> = {
  coarseLocation: "Coarse location",
  projectNames: "Project names",
  publicRepositoryUrls: "Public GitHub repositories",
  privateRepoTechStacks: "Private repo stack (derived locally)",
  projectDescriptions: "Project descriptions",
  adFrequency: "Ad frequency",
  subscriptionTier: "Subscription tier",
  tokenUsageRange: "Token usage range",
  totalSessionRange: "Total session range",
  acceptedRewardTypes: "Stablecoin, credits, or discounts",
  minimumTakeHomeMinor: "Minimum cash take-home",
};

export default async function ReceiverSettingsPage() {
  await requireChatGPTUser("/receiver/settings");
  return (
    <main className="settings-shell">
      <header><p>Receiver profile</p><h1>Only share what you choose.</h1></header>
      <form action="/api/receiver/settings" method="post">
        <fieldset>
          <legend>Published snapshot</legend>
          {RECEIVER_FIELD_KEYS.map((name) => (
            <label key={name}><input type="checkbox" name={`enabled.${name}`} /> {FIELD_LABELS[name]}</label>
          ))}
          <label>Coarse location<input name="coarseLocation" placeholder="US Northeast" /></label>
          <label>Project names<input name="projectNames" placeholder="Agent inbox, API monitor" /></label>
          <label>Public GitHub repositories<input name="publicRepositoryUrls" placeholder="https://github.com/example/public-repo" /></label>
          <label>Private repo technologies<input name="privateRepoTechStacks" placeholder="React, TypeScript, Postgres" /></label>
          <label>Project descriptions<textarea name="projectDescriptions" placeholder="One description per line" /></label>
          <label>Subscription tier<input name="subscriptionTier" placeholder="Pro" /></label>
          <label>Token usage range<input name="tokenUsageRange" placeholder="1M-5M / month" /></label>
          <label>Total session range<input name="totalSessionRange" placeholder="100-500" /></label>
          <label>Minimum cash take-home<input name="minimumTakeHomeMinor" type="number" min="0" /></label>
          <label>Rewards<select name="rewardType" multiple defaultValue={["stablecoin"]}><option value="stablecoin">Stablecoin</option><option value="credits">Credits</option><option value="discount">Discount</option></select></label>
        </fieldset>
        <fieldset>
          <legend>Delivery</legend>
          <label>Cadence (minutes)<input name="cadenceMinutes" type="number" min="5" defaultValue="60" /></label>
          <label>Maximum ads per day<input name="maxAdsPerDay" type="number" min="1" max="24" defaultValue="2" /></label>
          <label>Quiet hours<input name="quietHours" placeholder="22:00–07:00" /></label>
          <p>Native ads use one display turn in a separate sponsored session. The selected model is shown before activation.</p>
        </fieldset>
        <div className="settings-actions">
          <button type="submit" name="intent" value="preview">Preview exact snapshot</button>
          <label><input type="checkbox" name="acceptDisclosure" /> I accept the sponsored display-turn disclosure.</label>
          <label><input type="checkbox" name="acceptTerms" /> I accept the receiver terms.</label>
          <label><input type="checkbox" name="acceptPrivacy" /> I accept the privacy contract.</label>
          <button type="submit" name="intent" value="activate">Save and activate</button>
          <button type="submit" name="intent" value="pause">Pause immediately</button>
          <button type="submit" name="intent" value="revoke">Revoke</button>
        </div>
      </form>
    </main>
  );
}
