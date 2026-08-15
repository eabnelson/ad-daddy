export function buildCampaignPrepareRequest(form: FormData) {
  const verifiedDomain = text(form, "verifiedDomain").toLowerCase();
  const maximumSpendMinor = positiveInteger(form, "maximumSpendMinor");
  const maximumBidMinor = positiveInteger(form, "maximumBidMinor");
  return {
    action: "prepare" as const,
    campaign: {
      campaignId: optionalText(form, "campaignId") ?? `campaign_${crypto.randomUUID()}`,
      accountId: "resolved-by-server",
      advertiserTermsVersion: "advertiser-terms/1",
      brand: { name: text(form, "brandName"), verifiedDomain, verificationId: text(form, "verificationId") },
      destinationUrl: text(form, "destinationUrl"),
      allowlistedDestinationHosts: [verifiedDomain],
      schedule: { startsAt: iso(form, "startsAt"), endsAt: iso(form, "endsAt") },
      categories: list(form, "categories"),
      regions: list(form, "regions"),
      hosts: list(form, "hosts"),
      rewardTypes: form.getAll("rewardTypes").map(String),
      creative: { headline: text(form, "headline"), body: text(form, "body") },
      maximumSpendMinor,
      maximumBidMinor,
      dailyCapMinor: positiveInteger(form, "dailyCapMinor"),
      guaranteedPlacementMinor: positiveInteger(form, "guaranteedPlacementMinor"),
      conversionBonusMinor: nonNegativeInteger(form, "conversionBonusMinor"),
      conversionTerms: text(form, "conversionTerms"),
      perUserFrequencyLimit: positiveInteger(form, "perUserFrequencyLimit"),
    },
  };
}

function text(form: FormData, name: string): string {
  const value = String(form.get(name) ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function optionalText(form: FormData, name: string): string | undefined { return String(form.get(name) ?? "").trim() || undefined; }
function list(form: FormData, name: string): string[] {
  const values = text(form, name).split(",").map((value) => value.trim()).filter(Boolean);
  if (!values.length) throw new Error(`${name} is required`);
  return values;
}
function iso(form: FormData, name: string): string {
  const milliseconds = Date.parse(text(form, name));
  if (!Number.isFinite(milliseconds)) throw new Error(`${name} must be a valid time`);
  return new Date(milliseconds).toISOString();
}
function positiveInteger(form: FormData, name: string): number {
  const value = Number(text(form, name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
function nonNegativeInteger(form: FormData, name: string): number {
  const value = Number(text(form, name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
