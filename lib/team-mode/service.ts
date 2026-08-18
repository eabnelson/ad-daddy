import { createHash, randomBytes } from "node:crypto";

import { assertSafeAdvertiserDisplayText } from "@ad-daddy/host-adapters/advertiser-content-policy";
import type { SignedPlacement } from "@ad-daddy/host-adapters/contract";

import { signPlacement } from "../marketplace/signing-keys.ts";


export const TEAM_CLAIM_TTL_MS = 24 * 60 * 60_000;
export const TEAM_STARTING_POINTS = 50;
export const TEAM_SEND_COST_PER_PERSON = 1;
export const TEAM_EARN_PER_DISPLAYED_AD = 1;

export interface TeamMember {
  id: string;
  installationId: string;
  displayName: string;
  tags: string[];
  receivesAds: boolean;
  pointsBalance: number;
  capabilityHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamAd {
  id: string;
  advertiserMemberId: string;
  advertiserName: string;
  title: string;
  body: string;
  targetTags: string[];
  points: number;
  rewardKind: "team_points";
  active: boolean;
  createdAt: string;
}

export interface TeamAdSummary {
  adId: string;
  pointsPerRecipient: 1;
  recipientCount: number;
  displayedCount: number;
  rewardKind: "team_points";
  createdAt: string;
}

export interface TeamAdRecipient {
  adId: string;
  receiverMemberId: string;
  queuedAt: string;
}

export interface TeamDelivery {
  id: string;
  adId: string;
  receiverMemberId: string;
  installationId: string;
  points: number;
  matchedTags: string[];
  deliveredAt: string;
  status: "pending" | "displayed";
}

export type PublicTeamMember = Omit<TeamMember, "capabilityHash">;
export type PublicNetworkMember = Omit<TeamMember, "capabilityHash" | "installationId" | "pointsBalance">;

export interface TeamModeStore {
  createMember(member: TeamMember): Promise<void>;
  getMemberByCapabilityHash(capabilityHash: string): Promise<TeamMember | undefined>;
  updateMember(member: TeamMember): Promise<void>;
  listMembers(): Promise<TeamMember[]>;
  createAd(ad: TeamAd, recipients: TeamAdRecipient[]): Promise<void>;
  listAds(): Promise<TeamAd[]>;
  listAdRecipients(): Promise<TeamAdRecipient[]>;
  claimNext(member: TeamMember, now: Date): Promise<{ ad: TeamAd; delivery: TeamDelivery } | undefined>;
  acknowledgeDelivery(member: TeamMember, deliveryId: string, now: Date): Promise<TeamDelivery>;
  listDeliveries(): Promise<TeamDelivery[]>;
}

export class MemoryTeamModeStore implements TeamModeStore {
  readonly #members = new Map<string, TeamMember>();
  readonly #ads = new Map<string, TeamAd>();
  readonly #recipients = new Map<string, TeamAdRecipient>();
  readonly #deliveries = new Map<string, TeamDelivery>();

  async createMember(member: TeamMember) {
    if (this.#members.has(member.id) || [...this.#members.values()].some((candidate) => candidate.installationId === member.installationId)) {
      throw new Error("Team member identity already exists");
    }
    this.#members.set(member.id, clone(member)!);
  }
  async getMemberByCapabilityHash(capabilityHash: string) {
    return clone([...this.#members.values()].find((member) => member.capabilityHash === capabilityHash));
  }
  async updateMember(member: TeamMember) {
    if (!this.#members.has(member.id)) throw new Error("Unknown team member");
    this.#members.set(member.id, clone(member)!);
  }
  async listMembers() { return [...this.#members.values()].map((member) => clone(member)!); }
  async createAd(ad: TeamAd, recipients: TeamAdRecipient[]) {
    if (this.#ads.has(ad.id)) throw new Error("Team ad already exists");
    const advertiser = this.#members.get(ad.advertiserMemberId);
    const balance = advertiser?.pointsBalance ?? 0;
    const cost = teamSendCost(recipients.length);
    if (balance < cost) throw new Error(`This ad costs ${cost} points, but only ${balance} are available`);
    this.#members.set(ad.advertiserMemberId, { ...advertiser!, pointsBalance: balance - cost });
    this.#ads.set(ad.id, clone(ad)!);
    for (const recipient of recipients) this.#recipients.set(recipientKey(recipient.adId, recipient.receiverMemberId), clone(recipient)!);
  }
  async listAds() { return [...this.#ads.values()].map((ad) => clone(ad)!); }
  async listAdRecipients() { return [...this.#recipients.values()].map((recipient) => clone(recipient)!); }
  async listDeliveries() { return [...this.#deliveries.values()].map((delivery) => clone(delivery)!); }
  async claimNext(member: TeamMember, now: Date) {
    if (!member.receivesAds) return undefined;
    const pending = [...this.#deliveries.values()].find(
      (delivery) => delivery.receiverMemberId === member.id && delivery.status === "pending",
    );
    if (pending) {
      if (!claimExpired(pending, now)) {
        const ad = this.#ads.get(pending.adId);
        if (ad?.active) return { ad: clone(ad)!, delivery: clone(pending)! };
      }
      this.#deliveries.delete(pending.id);
    }
    const existingAdIds = new Set([...this.#deliveries.values()]
      .filter((delivery) => delivery.receiverMemberId === member.id)
      .map((delivery) => delivery.adId));
    const queued = [...this.#recipients.values()]
      .filter((recipient) => recipient.receiverMemberId === member.id && !existingAdIds.has(recipient.adId))
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt))[0];
    const queuedAd = queued ? this.#ads.get(queued.adId) : undefined;
    if (!queuedAd?.active) return undefined;
    const delivery: TeamDelivery = {
      id: `team_delivery_${crypto.randomUUID()}`,
      adId: queuedAd.id,
      receiverMemberId: member.id,
      installationId: member.installationId,
      points: TEAM_EARN_PER_DISPLAYED_AD,
      matchedTags: [],
      deliveredAt: now.toISOString(),
      status: "pending",
    };
    this.#deliveries.set(delivery.id, delivery);
    return { ad: clone(queuedAd)!, delivery: clone(delivery)! };
  }
  async acknowledgeDelivery(member: TeamMember, deliveryId: string, now: Date) {
    const delivery = this.#deliveries.get(deliveryId);
    if (!delivery || delivery.receiverMemberId !== member.id) throw new TeamModeNotFoundError("Unknown team delivery");
    if (delivery.status === "displayed") return clone(delivery)!;
    const displayed = { ...delivery, status: "displayed" as const, deliveredAt: now.toISOString() };
    this.#deliveries.set(deliveryId, displayed);
    const receiver = this.#members.get(member.id)!;
    this.#members.set(member.id, { ...receiver, pointsBalance: receiver.pointsBalance + TEAM_EARN_PER_DISPLAYED_AD });
    return clone(displayed)!;
  }
}

interface TeamModeSigning {
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  clock?: () => Date;
}

export class TeamModeService {
  readonly #store: TeamModeStore;
  readonly #signing: TeamModeSigning;
  constructor(store: TeamModeStore, signing: TeamModeSigning) {
    this.#store = store;
    this.#signing = signing;
  }

  publicKey() { return this.#signing.publicKeyPem; }

  async join(input: { displayName: unknown; tags: unknown; receivesAds: unknown }) {
    const now = this.now().toISOString();
    const id = `team_member_${crypto.randomUUID()}`;
    const memberKey = randomBytes(32).toString("base64url");
    const member: TeamMember = {
      id,
      installationId: `team_install_${crypto.randomUUID()}`,
      displayName: boundedText(input.displayName, "displayName", 1, 60),
      tags: input.tags === undefined ? [] : tags(input.tags),
      receivesAds: boolean(input.receivesAds, true),
      pointsBalance: TEAM_STARTING_POINTS,
      capabilityHash: capabilityHash(memberKey),
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.createMember(member);
    return { member: publicMember(member), memberKey };
  }

  async updateProfile(input: { memberKey: unknown; displayName: unknown; tags: unknown; receivesAds: unknown }) {
    const member = await this.requireMemberCapability(input.memberKey);
    const updated: TeamMember = {
      ...member,
      displayName: input.displayName === undefined ? member.displayName : boundedText(input.displayName, "displayName", 1, 60),
      tags: input.tags === undefined ? member.tags : tags(input.tags),
      receivesAds: boolean(input.receivesAds, member.receivesAds),
      updatedAt: this.now().toISOString(),
    };
    await this.#store.updateMember(updated);
    return publicMember(updated);
  }

  async createAd(input: { memberKey: unknown; title: unknown; body: unknown; recipientMemberIds: unknown }) {
    const member = await this.requireMemberCapability(input.memberKey);
    const title = boundedText(input.title, "title", 1, 120);
    const body = boundedText(input.body, "body", 1, 2_000);
    assertSafeAdvertiserDisplayText(title);
    assertSafeAdvertiserDisplayText(body);
    const requestedRecipientIds = recipientIds(input.recipientMemberIds);
    const members = await this.#store.listMembers();
    const membersById = new Map(members.map((candidate) => [candidate.id, candidate]));
    const recipients = requestedRecipientIds.map((id) => {
      const receiver = membersById.get(id);
      if (!receiver || receiver.id === member.id || !receiver.receivesAds) {
        throw new Error(`Recipient ${id} is not currently available to receive ads`);
      }
      return receiver;
    });
    const createdAt = this.now().toISOString();
    const ad: TeamAd = {
      id: `team_ad_${crypto.randomUUID()}`,
      advertiserMemberId: member.id,
      advertiserName: member.displayName,
      title,
      body,
      targetTags: [],
      points: TEAM_EARN_PER_DISPLAYED_AD,
      rewardKind: "team_points",
      active: true,
      createdAt,
    };
    const queued = recipients.map((receiver) => ({ adId: ad.id, receiverMemberId: receiver.id, queuedAt: createdAt }));
    await this.#store.createAd(ad, queued);
    const deliveries = await this.#store.listDeliveries();
    const updatedMember = await this.requireMemberCapability(input.memberKey);
    return {
      ad,
      recipients: recipientViews(queued, members, deliveries),
      queuedCount: queued.length,
      pointsSpent: teamSendCost(queued.length),
      balance: updatedMember.pointsBalance,
    };
  }

  async poll(input: { memberKey: unknown; installationId: unknown }) {
    const installationId = boundedText(input.installationId, "installationId", 1, 128);
    const member = await this.requireMemberCapability(input.memberKey);
    if (member.installationId !== installationId) throw new TeamModeNotFoundError("Unknown team installation");
    const claimed = await this.#store.claimNext(member, this.now());
    if (!claimed) return { status: "no_placement" as const };
    return {
      receiverAccountId: member.id,
      installationId: member.installationId,
      placement: this.placement(claimed.ad, claimed.delivery),
    };
  }

  async acknowledge(input: { memberKey: unknown; deliveryId: unknown }) {
    const member = await this.requireMemberCapability(input.memberKey);
    return this.#store.acknowledgeDelivery(member, boundedText(input.deliveryId, "deliveryId", 1, 128), this.now());
  }

  async status(memberKey: unknown) {
    const selected = await this.requireMemberCapability(memberKey);
    const [members, ads, recipients, deliveries] = await Promise.all([
      this.#store.listMembers(), this.#store.listAds(), this.#store.listAdRecipients(), this.#store.listDeliveries(),
    ]);
    const selectedId = selected.id;
    const displayed = deliveries.filter((delivery) => delivery.status === "displayed");
    const adsById = new Map(ads.map((ad) => [ad.id, ad]));
    return {
      moneyEnabled: false as const,
      rewardKind: "team_points" as const,
      member: publicMember(selected),
      members: members.map(networkMember),
      ads: ads.map((ad) => adSummary(ad, recipients, deliveries)),
      deliveries: deliveries.filter((delivery) => delivery.receiverMemberId === selectedId),
      score: {
        pointsReceived: displayed.filter((delivery) => delivery.receiverMemberId === selectedId).length,
        pointsSent: recipients.filter((recipient) => adsById.get(recipient.adId)?.advertiserMemberId === selectedId).length,
      },
      economy: economy(selected.pointsBalance),
    };
  }

  async profile(memberKey: unknown) {
    return publicMember(await this.requireMemberCapability(memberKey));
  }

  async people(memberKey: unknown) {
    const selected = await this.requireMemberCapability(memberKey);
    return (await this.#store.listMembers())
      .filter((member) => member.id !== selected.id && member.receivesAds)
      .map(networkMember);
  }

  async advertiserProfile(memberKey: unknown) {
    const selected = await this.requireMemberCapability(memberKey);
    const [members, ads, recipients, deliveries] = await Promise.all([
      this.#store.listMembers(), this.#store.listAds(), this.#store.listAdRecipients(), this.#store.listDeliveries(),
    ]);
    return {
      moneyEnabled: false as const,
      rewardKind: "team_points" as const,
      member: publicMember(selected),
      ads: adDetails(ads.filter((ad) => ad.advertiserMemberId === selected.id), members, recipients, deliveries),
      availableReceiverCount: members.filter((member) => member.id !== selected.id && member.receivesAds).length,
      economy: economy(selected.pointsBalance),
    };
  }

  async memberAds(memberKey: unknown) {
    const selected = await this.requireMemberCapability(memberKey);
    const [members, ads, recipients, deliveries] = await Promise.all([
      this.#store.listMembers(), this.#store.listAds(), this.#store.listAdRecipients(), this.#store.listDeliveries(),
    ]);
    return adDetails(ads.filter((ad) => ad.advertiserMemberId === selected.id), members, recipients, deliveries);
  }

  async browseAds(memberKey: unknown) {
    const selected = await this.requireMemberCapability(memberKey);
    const [ads, recipients, deliveries] = await Promise.all([
      this.#store.listAds(), this.#store.listAdRecipients(), this.#store.listDeliveries(),
    ]);
    const adsById = new Map(ads.map((ad) => [ad.id, ad]));
    const displayedAdIds = new Set(deliveries
      .filter((delivery) => delivery.receiverMemberId === selected.id && delivery.status === "displayed")
      .map((delivery) => delivery.adId));
    return recipients
      .filter((recipient) => recipient.receiverMemberId === selected.id && !displayedAdIds.has(recipient.adId))
      .map((recipient) => adsById.get(recipient.adId))
      .filter((ad) => ad?.active)
      .filter((ad): ad is TeamAd => Boolean(ad))
      .map((ad) => ({ ...adSummary(ad, recipients, deliveries), queuedForYou: true as const }));
  }

  private async requireMemberCapability(memberKey: unknown) {
    const key = boundedText(memberKey, "memberKey", 32, 128);
    const member = await this.#store.getMemberByCapabilityHash(capabilityHash(key));
    if (!member) throw new TeamModeNotFoundError("Unknown team capability");
    return member;
  }

  private placement(ad: TeamAd, delivery: TeamDelivery): SignedPlacement {
    // Pending deliveries are replayed byte-for-byte until the receiver
    // acknowledges display, so the local idempotency record never collides.
    const issuedAt = new Date(delivery.deliveredAt);
    return signPlacement({
      protocolVersion: 1,
      placementId: delivery.id,
      advertiser: { id: ad.advertiserMemberId, displayName: ad.advertiserName },
      title: ad.title,
      contentReference: `https://team.ad-daddy.invalid/ads/${encodeURIComponent(ad.id)}`,
      disclosure: "Sponsored",
      payout: { amountMinor: 0, currency: "USD" },
      nonCashReward: { kind: "team_points", amount: TEAM_EARN_PER_DISPLAYED_AD, label: "team points", redeemable: false },
      signalsUsed: delivery.matchedTags,
      creative: {
        body: `${ad.body}\n\nYou earn 1 team point when this ad is displayed. Team points have no cash value and cannot be redeemed.`,
        attachments: [],
      },
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + TEAM_CLAIM_TTL_MS).toISOString(),
    }, { keyId: this.#signing.keyId, privateKeyPem: this.#signing.privateKeyPem });
  }

  private now() { return this.#signing.clock?.() ?? new Date(); }
}

export class TeamModeNotFoundError extends Error {}
export class TeamModeInfrastructureError extends Error {}

function tags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("tags must be an array with at most 20 entries");
  const normalized = value.map((tag) => boundedText(tag, "tag", 1, 32).trim().toLowerCase());
  if (normalized.some((tag) => !/^[a-z0-9][a-z0-9+._-]{0,31}$/.test(tag))) throw new Error("tags contain an unsupported value");
  return [...new Set(normalized)];
}

function recipientIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) {
    throw new Error("recipientMemberIds must contain 1-24 teammates");
  }
  const normalized = value.map((id) => boundedText(id, "recipientMemberId", 1, 128));
  if (new Set(normalized).size !== normalized.length) throw new Error("recipientMemberIds must not contain duplicates");
  return normalized;
}

function boundedText(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.trim().length < minimum || value.length > maximum) throw new Error(`${name} must contain ${minimum}-${maximum} characters`);
  return value.trim();
}

function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error("receivesAds must be boolean");
  return value;
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

export function claimExpired(delivery: TeamDelivery, now: Date): boolean {
  return Date.parse(delivery.deliveredAt) + TEAM_CLAIM_TTL_MS <= now.getTime();
}

function capabilityHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicMember(member: TeamMember): PublicTeamMember {
  return {
    id: member.id, installationId: member.installationId, displayName: member.displayName,
    tags: [...member.tags], receivesAds: member.receivesAds, pointsBalance: member.pointsBalance,
    createdAt: member.createdAt, updatedAt: member.updatedAt,
  };
}

function networkMember(member: TeamMember): PublicNetworkMember {
  return {
    id: member.id, displayName: member.displayName, tags: [...member.tags], receivesAds: member.receivesAds,
    createdAt: member.createdAt, updatedAt: member.updatedAt,
  };
}

function adSummary(ad: TeamAd, recipients: TeamAdRecipient[], deliveries: TeamDelivery[]): TeamAdSummary {
  const queued = recipients.filter((recipient) => recipient.adId === ad.id);
  const displayedReceivers = new Set(deliveries
    .filter((delivery) => delivery.adId === ad.id && delivery.status === "displayed")
    .map((delivery) => delivery.receiverMemberId));
  return {
    adId: ad.id,
    pointsPerRecipient: TEAM_SEND_COST_PER_PERSON,
    recipientCount: queued.length,
    displayedCount: queued.filter((recipient) => displayedReceivers.has(recipient.receiverMemberId)).length,
    rewardKind: ad.rewardKind,
    createdAt: ad.createdAt,
  };
}

export function teamSendCost(recipientCount: number) {
  return recipientCount * TEAM_SEND_COST_PER_PERSON;
}

function recipientKey(adId: string, receiverMemberId: string) {
  return `${adId}:${receiverMemberId}`;
}

function economy(balance: number) {
  return {
    balance,
    startingBalance: TEAM_STARTING_POINTS,
    sendCostPerPerson: TEAM_SEND_COST_PER_PERSON,
    earnPerDisplayedAd: TEAM_EARN_PER_DISPLAYED_AD,
  };
}

function recipientViews(recipients: TeamAdRecipient[], members: TeamMember[], deliveries: TeamDelivery[]) {
  const membersById = new Map(members.map((member) => [member.id, member]));
  return recipients.map((recipient) => {
    const delivery = deliveries.find((candidate) => candidate.adId === recipient.adId && candidate.receiverMemberId === recipient.receiverMemberId);
    return {
      memberId: recipient.receiverMemberId,
      displayName: membersById.get(recipient.receiverMemberId)?.displayName ?? "Unknown teammate",
      status: delivery?.status ?? "queued" as "queued" | "pending" | "displayed",
    };
  });
}

function adDetails(ads: TeamAd[], members: TeamMember[], recipients: TeamAdRecipient[], deliveries: TeamDelivery[]) {
  return ads.map((ad) => ({
    ...ad,
    recipients: recipientViews(recipients.filter((recipient) => recipient.adId === ad.id), members, deliveries),
  }));
}
