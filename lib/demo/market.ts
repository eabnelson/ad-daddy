export type DemoRewardType = "cash" | "credits" | "discounts";

export type DemoProfile = Readonly<{
  projectName: string;
  projectDescription: string;
  minimumTakeHomeMinor: number;
  acceptedRewards: readonly DemoRewardType[];
}>;

export type DemoSignalMatch = Readonly<{
  signal: "Project name" | "Project description";
  terms: readonly string[];
}>;

type DemoBidCreative = Readonly<{
  advertiserId: string;
  advertiserName: string;
  matchReason: string;
  matchedSignals: readonly DemoSignalMatch[];
  accent: string;
  headline: string;
  body: string;
  action: string;
}>;

export type DemoCashBid = DemoBidCreative & Readonly<{
  rewardType: "cash";
  grossAmountMinor: number;
  operatorFeeMinor: number;
  receiverTakeHomeMinor: number;
}>;

export type DemoNonCashBid = DemoBidCreative & Readonly<{
  rewardType: "credits" | "discounts";
  valueMinor: number;
}>;

export type DemoBid = DemoCashBid | DemoNonCashBid;

type DemoAuctionBase = Readonly<{ auctionId: string; bids: readonly DemoBid[] }>;
export type DemoFilledAuction = DemoAuctionBase & Readonly<{ status: "filled"; winner: DemoBid }>;
export type DemoNoFillAuction = DemoAuctionBase & Readonly<{
  status: "no_fill";
  reason: "minimum_not_met" | "reward_type_unavailable";
}>;
export type DemoAuction = DemoFilledAuction | DemoNoFillAuction;

type DemoCampaign = Omit<DemoBidCreative, "matchReason" | "matchedSignals"> & Readonly<{
  keywords: readonly string[];
  baseOfferMinor: number;
  contextualOfferMinor: number;
  contextualReason: string;
  generalReason: string;
  rewardTypes: readonly DemoRewardType[];
  nonCashValueMinor: Partial<Record<Exclude<DemoRewardType, "cash">, number>>;
}>;

const CAMPAIGNS: readonly DemoCampaign[] = [
  {
    advertiserId: "neon", advertiserName: "Neon", accent: "#80d6aa",
    keywords: ["postgres", "database", "sql", "cloudflare", "api"], baseOfferMinor: 42, contextualOfferMinor: 86,
    contextualReason: "Database infrastructure matches your stack", generalReason: "Developer infrastructure campaign",
    rewardTypes: ["cash", "credits"], headline: "Give your API a database that keeps up.",
    nonCashValueMinor: { credits: 1_000 },
    body: "Branch Postgres in seconds. Your agent gets a clean connection string and you keep shipping.",
    action: "Open the Neon setup brief",
  },
  {
    advertiserId: "resend", advertiserName: "Resend", accent: "#f1eee7",
    keywords: ["email", "receipt", "transactional", "notification", "api"], baseOfferMinor: 40, contextualOfferMinor: 72,
    contextualReason: "Your receipt flow may need transactional email", generalReason: "Developer tools campaign",
    rewardTypes: ["cash", "credits"], headline: "A receipt should arrive before doubt does.",
    nonCashValueMinor: { credits: 1_000 },
    body: "Add transactional email with an API your agent can explain in one sitting.", action: "See the email integration",
  },
  {
    advertiserId: "openrouter", advertiserName: "OpenRouter", accent: "#f2a65a",
    keywords: ["model", "ai", "agent", "llm", "typescript", "api"], baseOfferMinor: 39, contextualOfferMinor: 69,
    contextualReason: "Model routing fits your TypeScript API", generalReason: "AI builder campaign",
    rewardTypes: ["cash", "credits"], headline: "One API. The right model for every job.",
    nonCashValueMinor: { credits: 500 },
    body: "Compare speed, price, and quality without rewriting your agent stack.", action: "Compare model routes",
  },
  {
    advertiserId: "doordash", advertiserName: "DoorDash", accent: "#ff5a47", keywords: [],
    baseOfferMinor: 52, contextualOfferMinor: 52, contextualReason: "Builders need lunch too", generalReason: "Builders need lunch too",
    rewardTypes: ["cash", "discounts"], headline: "Your deploy can wait twelve minutes.",
    nonCashValueMinor: { discounts: 800 },
    body: "Take $8 off lunch while your tests finish. McDonald’s is 14 minutes away.", action: "Reveal the lunch offer",
  },
];

export function buildDemoAuction(profile: DemoProfile): DemoAuction {
  const bids: DemoBid[] = [];
  for (const campaign of CAMPAIGNS) {
    const rewardType = campaign.rewardTypes.find((reward) => profile.acceptedRewards.includes(reward));
    if (!rewardType) continue;
    const matchedSignals = findSignalMatches(profile, campaign.keywords);
    const contextual = matchedSignals.length > 0;
    const offerAmountMinor = contextual ? campaign.contextualOfferMinor : campaign.baseOfferMinor;
    const creative = {
      advertiserId: campaign.advertiserId, advertiserName: campaign.advertiserName,
      matchReason: contextual ? campaign.contextualReason : campaign.generalReason, matchedSignals,
      accent: campaign.accent, headline: campaign.headline, body: campaign.body, action: campaign.action,
    };

    if (rewardType !== "cash") {
      bids.push(Object.freeze({ ...creative, rewardType,
        valueMinor: campaign.nonCashValueMinor[rewardType] ?? offerAmountMinor }));
      continue;
    }
    const operatorFeeMinor = Math.floor(offerAmountMinor * 20 / 100);
    bids.push(Object.freeze({ ...creative, rewardType, grossAmountMinor: offerAmountMinor,
      operatorFeeMinor, receiverTakeHomeMinor: offerAmountMinor - operatorFeeMinor }));
  }
  bids.sort(compareBids);
  const displayedBids = bids.slice(0, 3);

  const winner = displayedBids.find((bid) => isEligible(bid, profile.minimumTakeHomeMinor));
  const auctionBase = { auctionId: "demo-auction-001", bids: Object.freeze(displayedBids) };
  if (winner) return Object.freeze({ ...auctionBase, status: "filled", winner });
  return Object.freeze({ ...auctionBase, status: "no_fill",
    reason: displayedBids.length === 0 ? "reward_type_unavailable" : "minimum_not_met" });
}

export function createSponsoredSession(auction: DemoFilledAuction) {
  const winner = auction.winner;
  return Object.freeze({
    id: `sponsored-${auction.auctionId}`, title: `Sponsored · ${winner.headline}`,
    disclosure: "Sponsored via Ad Daddy", advertiserName: winner.advertiserName, rewardType: winner.rewardType,
    rewardMinor: winner.rewardType === "cash" ? winner.receiverTakeHomeMinor : winner.valueMinor,
    matchedSignals: winner.matchedSignals, executionPolicy: "display-only" as const,
    headline: winner.headline, body: winner.body, action: winner.action, accent: winner.accent,
  });
}

function findSignalMatches(profile: DemoProfile, keywords: readonly string[]): readonly DemoSignalMatch[] {
  const signals = [["Project name", profile.projectName], ["Project description", profile.projectDescription]] as const;
  return Object.freeze(signals.flatMap(([signal, value]) => {
    const normalized = value.toLowerCase();
    const terms = keywords.filter((keyword) => normalized.includes(keyword));
    return terms.length === 0 ? [] : [Object.freeze({ signal, terms: Object.freeze(terms) })];
  }));
}

function isEligible(bid: DemoBid, minimumTakeHomeMinor: number): boolean {
  if (bid.rewardType === "cash") return bid.receiverTakeHomeMinor >= minimumTakeHomeMinor;
  return minimumTakeHomeMinor === 0;
}

function compareBids(left: DemoBid, right: DemoBid): number {
  const leftAmount = left.rewardType === "cash" ? left.grossAmountMinor : left.valueMinor;
  const rightAmount = right.rewardType === "cash" ? right.grossAmountMinor : right.valueMinor;
  return rightAmount - leftAmount || left.advertiserName.localeCompare(right.advertiserName);
}
