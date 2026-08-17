import { calculateRevenueSplit, LAUNCH_REVENUE_SPLIT } from "../payments/ledger.ts";

export type DemoRewardType = "cash" | "credits" | "discounts";

export type DemoMarketContext = Readonly<{
  projectName: string;
  projectDescription: string;
  sharedSignalCount: number;
}>;

export type DemoProfile = DemoMarketContext & Readonly<{
  minimumTakeHomeMinor: number;
  acceptedRewards: readonly DemoRewardType[];
}>;

export const DEMO_FREQUENCIES = Object.freeze({
  manual: Object.freeze({ label: "Only when I ask", slots: 1 }),
  weekly: Object.freeze({ label: "1 per week", slots: 4 }),
  twice_weekly: Object.freeze({ label: "2 per week", slots: 8 }),
  daily: Object.freeze({ label: "1 per day", slots: 30 }),
  three_daily: Object.freeze({ label: "3 per day", slots: 90 }),
  eight_daily: Object.freeze({ label: "8 per day", slots: 240 }),
  every_session: Object.freeze({ label: "Every eligible session", slots: 600 }),
} as const);

export type DemoFrequencyId = keyof typeof DEMO_FREQUENCIES;

export function isDemoFrequencyId(value: string): value is DemoFrequencyId {
  return Object.hasOwn(DEMO_FREQUENCIES, value);
}

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
  profileBoostMinor: number;
  profileBoostTakeHomeMinor: number;
  actionRewards: readonly DemoActionReward[];
}>;

export type DemoActionReward = Readonly<{
  id: "open_brief" | "activate" | "paid_conversion";
  label: string;
  description: string;
  verification: string;
  grossAmountMinor: number;
  operatorFeeMinor: number;
  receiverTakeHomeMinor: number;
}>;

export type DemoNonCashBid = DemoBidCreative & Readonly<{
  rewardType: "credits" | "discounts";
  baseValueMinor: number;
  valueMinor: number;
  profileBoostValueMinor: number;
}>;

export type DemoBid = DemoCashBid | DemoNonCashBid;

type DemoAuctionBase = Readonly<{ auctionId: string; bids: readonly DemoBid[] }>;
export type DemoFilledAuction = DemoAuctionBase & Readonly<{ status: "filled"; winner: DemoBid }>;
export type DemoNoFillAuction = DemoAuctionBase & Readonly<{
  status: "no_fill";
  reason: "minimum_not_met" | "reward_type_unavailable";
}>;
export type DemoAuction = DemoFilledAuction | DemoNoFillAuction;

export type DemoMinimumTakeHomeRange = Readonly<{
  lowMinor: number;
  highMinor: number;
  sampleSize: number;
}>;

type DemoCampaign = Omit<DemoBidCreative, "matchReason" | "matchedSignals"> & Readonly<{
  keywords: readonly string[];
  baseOfferMinor: number;
  contextualOfferMinor: number;
  contextualReason: string;
  generalReason: string;
  rewardTypes: readonly DemoRewardType[];
  nonCashValueMinor: Partial<Record<Exclude<DemoRewardType, "cash">, number>>;
  actionRewards: readonly DemoActionReward[];
}>;

type DemoActionRewardInput = Omit<DemoActionReward, "operatorFeeMinor" | "receiverTakeHomeMinor">;

function cashSplit(grossAmountMinor: number) {
  const split = calculateRevenueSplit(grossAmountMinor, LAUNCH_REVENUE_SPLIT);
  return Object.freeze({ operatorFeeMinor: split.operatorMinor, receiverTakeHomeMinor: split.receiverMinor });
}

function actionReward(input: DemoActionRewardInput): DemoActionReward {
  return Object.freeze({ ...input, ...cashSplit(input.grossAmountMinor) });
}

const CAMPAIGNS: readonly DemoCampaign[] = [
  {
    advertiserId: "neon", advertiserName: "Neon", accent: "#80d6aa",
    keywords: ["postgres", "database", "sql", "cloudflare", "api"], baseOfferMinor: 42, contextualOfferMinor: 86,
    contextualReason: "Database infrastructure matches your stack", generalReason: "Developer infrastructure campaign",
    rewardTypes: ["cash", "credits"], headline: "Give your API a database that keeps up.",
    nonCashValueMinor: { credits: 1_000 },
    actionRewards: [
      actionReward({ id: "open_brief", label: "Open setup brief", description: "Review the integration inside this session.", verification: "Verified link open", grossAmountMinor: 200 }),
      actionReward({ id: "activate", label: "Activate product", description: "Create your first database branch.", verification: "Verified product activation", grossAmountMinor: 1_500 }),
      actionReward({ id: "paid_conversion", label: "Become a paid customer", description: "Make your first paid Neon purchase.", verification: "Verified first payment", grossAmountMinor: 10_000 }),
    ],
    body: "Branch Postgres in seconds. Your agent gets a clean connection string and you keep shipping.",
    action: "Open the Neon setup brief",
  },
  {
    advertiserId: "resend", advertiserName: "Resend", accent: "#f1eee7",
    keywords: ["email", "receipt", "transactional", "notification", "api"], baseOfferMinor: 40, contextualOfferMinor: 72,
    contextualReason: "Your receipt flow may need transactional email", generalReason: "Developer tools campaign",
    rewardTypes: ["cash", "credits"], headline: "A receipt should arrive before doubt does.",
    nonCashValueMinor: { credits: 1_000 },
    actionRewards: [
      actionReward({ id: "open_brief", label: "Open setup brief", description: "Review the email integration.", verification: "Verified link open", grossAmountMinor: 150 }),
      actionReward({ id: "activate", label: "Activate product", description: "Send your first transactional email.", verification: "Verified product activation", grossAmountMinor: 1_000 }),
      actionReward({ id: "paid_conversion", label: "Become a paid customer", description: "Make your first paid Resend purchase.", verification: "Verified first payment", grossAmountMinor: 7_500 }),
    ],
    body: "Add transactional email with an API your agent can explain in one sitting.", action: "See the email integration",
  },
  {
    advertiserId: "openrouter", advertiserName: "OpenRouter", accent: "#f2a65a",
    keywords: ["model", "ai", "agent", "llm", "typescript", "api"], baseOfferMinor: 39, contextualOfferMinor: 69,
    contextualReason: "Model routing fits your TypeScript API", generalReason: "AI builder campaign",
    rewardTypes: ["cash", "credits"], headline: "One API. The right model for every job.",
    nonCashValueMinor: { credits: 500 },
    actionRewards: [
      actionReward({ id: "open_brief", label: "Open setup brief", description: "Compare routes for your workload.", verification: "Verified link open", grossAmountMinor: 120 }),
      actionReward({ id: "activate", label: "Activate product", description: "Run your first model request.", verification: "Verified product activation", grossAmountMinor: 1_000 }),
      actionReward({ id: "paid_conversion", label: "Become a paid customer", description: "Make your first paid model request.", verification: "Verified first payment", grossAmountMinor: 5_000 }),
    ],
    body: "Compare speed, price, and quality without rewriting your agent stack.", action: "Compare model routes",
  },
  {
    advertiserId: "doordash", advertiserName: "DoorDash", accent: "#ff5a47", keywords: [],
    baseOfferMinor: 52, contextualOfferMinor: 52, contextualReason: "Builders need lunch too", generalReason: "Builders need lunch too",
    rewardTypes: ["cash", "discounts"], headline: "Your deploy can wait twelve minutes.",
    nonCashValueMinor: { discounts: 800 },
    actionRewards: [],
    body: "Take $8 off lunch while your tests finish. McDonald’s is 14 minutes away.", action: "Reveal the lunch offer",
  },
];

export function buildDemoAuction(profile: DemoProfile): DemoAuction {
  const bids: DemoBid[] = [];
  const profileBoostMinor = Math.min(7, Math.max(0, Math.floor(profile.sharedSignalCount))) * 4;
  for (const campaign of CAMPAIGNS) {
    const rewardType = campaign.rewardTypes.find((reward) => profile.acceptedRewards.includes(reward));
    if (!rewardType) continue;
    const matchedSignals = findSignalMatches(profile, campaign.keywords);
    const contextual = matchedSignals.length > 0;
    const baseOfferMinor = contextual ? campaign.contextualOfferMinor : campaign.baseOfferMinor;
    const offerAmountMinor = baseOfferMinor + profileBoostMinor;
    const creative = {
      advertiserId: campaign.advertiserId, advertiserName: campaign.advertiserName,
      matchReason: contextual ? campaign.contextualReason : campaign.generalReason, matchedSignals,
      accent: campaign.accent, headline: campaign.headline, body: campaign.body, action: campaign.action,
    };

    if (rewardType !== "cash") {
      const baseValueMinor = campaign.nonCashValueMinor[rewardType] ?? baseOfferMinor;
      bids.push(Object.freeze({ ...creative, rewardType,
        baseValueMinor,
        valueMinor: baseValueMinor + profileBoostMinor,
        profileBoostValueMinor: profileBoostMinor }));
      continue;
    }
    const offerSplit = cashSplit(offerAmountMinor);
    const baseSplit = cashSplit(baseOfferMinor);
    bids.push(Object.freeze({ ...creative, rewardType, grossAmountMinor: offerAmountMinor,
      ...offerSplit, profileBoostMinor,
      profileBoostTakeHomeMinor: offerSplit.receiverTakeHomeMinor - baseSplit.receiverTakeHomeMinor,
      actionRewards: campaign.actionRewards }));
  }
  bids.sort(compareBids);
  const displayedBids = bids.slice(0, 3);

  const winner = displayedBids.find((bid) => isEligible(bid, profile.minimumTakeHomeMinor));
  const auctionBase = { auctionId: "demo-auction-001", bids: Object.freeze(displayedBids) };
  if (winner) return Object.freeze({ ...auctionBase, status: "filled", winner });
  return Object.freeze({ ...auctionBase, status: "no_fill",
    reason: displayedBids.length === 0 ? "reward_type_unavailable" : "minimum_not_met" });
}

export function suggestDemoMinimumTakeHomeRange(
  context: DemoMarketContext,
  frequency: DemoFrequencyId,
): DemoMinimumTakeHomeRange {
  const cashMarket = buildDemoAuction({ ...context, minimumTakeHomeMinor: 0, acceptedRewards: ["cash"] });
  const comparableTakeHomes = cashMarket.bids.flatMap((bid) =>
    bid.rewardType === "cash" ? [bid.receiverTakeHomeMinor] : []);
  const frequencySlots = DEMO_FREQUENCIES[frequency].slots;
  const frequencyFactor = Math.max(0.6, Math.min(1.1,
    1 - Math.log2(Math.max(1, frequencySlots) / 8) * 0.08));
  const adjusted = comparableTakeHomes.map((amount) => Math.max(1, Math.round(amount * frequencyFactor)));

  return Object.freeze({
    lowMinor: Math.min(...adjusted),
    highMinor: Math.max(...adjusted),
    sampleSize: adjusted.length,
  });
}

export function createSponsoredSession(auction: DemoFilledAuction) {
  const winner = auction.winner;
  return Object.freeze({
    id: `sponsored-${auction.auctionId}`, title: `AD DADDY: ${winner.headline}`,
    disclosure: "Sponsored via Ad Daddy", advertiserName: winner.advertiserName, rewardType: winner.rewardType,
    rewardMinor: winner.rewardType === "cash" ? winner.receiverTakeHomeMinor : winner.valueMinor,
    potentialRewardMinor: winner.rewardType === "cash"
      ? winner.receiverTakeHomeMinor + winner.actionRewards.reduce((sum, reward) => sum + reward.receiverTakeHomeMinor, 0)
      : winner.valueMinor,
    actionRewards: winner.rewardType === "cash" ? winner.actionRewards : [],
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
