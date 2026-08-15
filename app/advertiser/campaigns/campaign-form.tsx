"use client";

import { useState, type FormEvent } from "react";
import { buildCampaignPrepareRequest } from "./campaign-request";

export function CampaignForm() {
  const [result, setResult] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setResult("");
    try {
      const form = new FormData(event.currentTarget);
      const request = buildCampaignPrepareRequest(form);
      const response = await fetch("/api/v1/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const body = await response.json() as { campaign?: { campaignId?: string }; message?: string; error?: string };
      if (!response.ok) throw new Error(body.message ?? body.error ?? "Campaign preparation failed");
      setResult(`Prepared ${body.campaign?.campaignId ?? request.campaign.campaignId} for human review.`);
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Campaign preparation failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <fieldset>
        <legend>Campaign envelope</legend>
        <label>Campaign ID<input name="campaignId" placeholder="Generated if blank" /></label>
        <label>Verified brand name<input name="brandName" required maxLength={120} /></label>
        <label>Verified brand domain<input name="verifiedDomain" placeholder="example.com" required /></label>
        <label>Brand verification ID<input name="verificationId" required /></label>
        <label>Destination URL<input name="destinationUrl" type="url" placeholder="https://example.com/offer" required /></label>
        <label>Audience categories<input name="categories" defaultValue="developer-tools" required /></label>
        <label>Regions<input name="regions" defaultValue="US Northeast" required /></label>
        <label>Agent hosts<input name="hosts" defaultValue="codex" required /></label>
        <label>Starts<input name="startsAt" type="datetime-local" required /></label>
        <label>Ends<input name="endsAt" type="datetime-local" required /></label>
        <label>Offers<select name="rewardTypes" multiple defaultValue={["stablecoin"]} required><option value="stablecoin">Stablecoin</option><option value="credits">Credits</option><option value="discount">Discount</option></select></label>
        <label>Headline<input name="headline" required maxLength={120} /></label>
        <label>Body<textarea name="body" required maxLength={4000} /></label>
        <label>Maximum spend (minor units)<input name="maximumSpendMinor" type="number" min="1" required /></label>
        <label>Maximum bid<input name="maximumBidMinor" type="number" min="1" required /></label>
        <label>Daily cap<input name="dailyCapMinor" type="number" min="1" required /></label>
        <label>Guaranteed placement reward<input name="guaranteedPlacementMinor" type="number" min="1" required /></label>
        <label>Conversion bonus<input name="conversionBonusMinor" type="number" min="0" defaultValue="0" required /></label>
        <label>Conversion terms<textarea name="conversionTerms" required maxLength={512} /></label>
        <label>Per-user frequency limit<input name="perUserFrequencyLimit" type="number" min="1" defaultValue="1" required /></label>
        <label><input name="advertiserTermsAccepted" type="checkbox" required /> Accept advertiser terms for this draft</label>
      </fieldset>
      <button type="submit" disabled={submitting}>{submitting ? "Preparing…" : "Prepare for review"}</button>
      <p aria-live="polite">{result}</p>
    </form>
  );
}
