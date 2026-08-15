const fields = [
  ["coarseLocation", "Coarse location"],
  ["projectNames", "Project names"],
  ["publicRepositoryUrls", "Public GitHub repositories"],
  ["privateRepoTechStacks", "Private repo stack (derived locally)"],
  ["projectDescriptions", "Project descriptions"],
  ["adFrequency", "Ad frequency"],
  ["subscriptionTier", "Subscription tier"],
  ["tokenUsageRange", "Token usage range"],
  ["totalSessionRange", "Total session range"],
  ["acceptedRewardTypes", "Stablecoin, credits, or discounts"],
  ["minimumTakeHomeMinor", "Minimum cash take-home"],
] as const;

export default async function ReceiverSettingsPage() {
  await requireChatGPTUser("/receiver/settings");
  return (
    <main className="settings-shell">
      <header><p>Receiver profile</p><h1>Only share what you choose.</h1></header>
      <form action="/api/receiver/settings" method="post">
        <fieldset>
          <legend>Published snapshot</legend>
          {fields.map(([name, label]) => (
            <label key={name}><input type="checkbox" name={`enabled.${name}`} /> <span>{label}</span></label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Delivery</legend>
          <label>Cadence (minutes)<input name="cadenceMinutes" type="number" min="5" defaultValue="60" /></label>
          <label>Quiet hours<input name="quietHours" placeholder="22:00–07:00" /></label>
          <p>Native ads use one display turn in a separate sponsored session. The selected model is shown before activation.</p>
        </fieldset>
        <div className="settings-actions">
          <button type="submit" name="intent" value="preview">Preview exact snapshot</button>
          <button type="submit" name="intent" value="pause">Pause immediately</button>
          <button type="submit" name="intent" value="revoke">Revoke</button>
        </div>
      </form>
    </main>
  );
}
import { requireChatGPTUser } from "../../chatgpt-auth";
