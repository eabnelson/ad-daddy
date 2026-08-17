import { createHash, randomBytes } from "node:crypto";

import { assertSafeAdvertiserDisplayText } from "@ad-daddy/host-adapters/advertiser-content-policy";
import type { SignedPlacement } from "@ad-daddy/host-adapters/contract";

import { signPlacement } from "../marketplace/signing-keys.ts";


export const TEAM_CLAIM_TTL_MS = 24 * 60 * 60_000;

export interface TeamMember {
  id: string;
  installationId: string;
  displayName: string;
  tags: string[];
  receivesAds: boolean;
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
export type PublicNetworkMember = Omit<TeamMember, "capabilityHash" | "installationId">;

export interface TeamModeStore {
  createMember(member: TeamMember): Promise<void>;
  getMemberByCapabilityHash(capabilityHash: string): Promise<TeamMember | undefined>;
  updateMember(member: TeamMember): Promise<void>;
  listMembers(): Promise<TeamMember[]>;
  createAd(ad: TeamAd): Promise<void>;
  listAds(): Promise<TeamAd[]>;
  claimNext(member: TeamMember, now: Date): Promise<{ ad: TeamAd; delivery: TeamDelivery } | undefined>;
  acknowledgeDelivery(member: TeamMember, deliveryId: string, now: Date): Promise<TeamDelivery>;
  listDeliveries(): Promise<TeamDelivery[]>;
}

export class MemoryTeamModeStore implements TeamModeStore {
  readonly #members = new Map<string, TeamMember>();
  readonly #ads = new Map<string, TeamAd>();
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
  async createAd(ad: TeamAd) {
    if (this.#ads.has(ad.id)) throw new Error("Team ad already exists");
    this.#ads.set(ad.id, clone(ad)!);
  }
  async listAds() { return [...this.#ads.values()].map((ad) => clone(ad)!); }
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
    const deliveredAdIds = new Set([...this.#deliveries.values()]
      .filter((delivery) => delivery.receiverMemberId === member.id)
      .map((delivery) => delivery.adId));
    const eligible = rankEligibleAds([...this.#ads.values()], member, deliveredAdIds)[0];
    if (!eligible) return undefined;
    const delivery: TeamDelivery = {
      id: `team_delivery_${crypto.randomUUID()}`,
      adId: eligible.ad.id,
      receiverMemberId: member.id,
      installationId: member.installationId,
      points: eligible.ad.points,
      matchedTags: eligible.matchedTags,
      deliveredAt: now.toISOString(),
      status: "pending",
    };
    this.#deliveries.set(delivery.id, delivery);
    return { ad: clone(eligible.ad)!, delivery: clone(delivery)! };
  }
  async acknowledgeDelivery(member: TeamMember, deliveryId: string, now: Date) {
    const delivery = this.#deliveries.get(deliveryId);
    if (!delivery || delivery.receiverMemberId !== member.id) throw new TeamModeNotFoundError("Unknown team delivery");
    const displayed = { ...delivery, status: "displayed" as const, deliveredAt: now.toISOString() };
    this.#deliveries.set(deliveryId, displayed);
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
      tags: tags(input.tags),
      receivesAds: boolean(input.receivesAds, true),
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
      displayName: boundedText(input.displayName, "displayName", 1, 60),
      tags: tags(input.tags),
      receivesAds: boolean(input.receivesAds, member.receivesAds),
      updatedAt: this.now().toISOString(),
    };
    await this.#store.updateMember(updated);
    return publicMember(updated);
  }

  async createAd(input: { memberKey: unknown; title: unknown; body: unknown; targetTags: unknown; points: unknown }) {
    const member = await this.requireMemberCapability(input.memberKey);
    const title = boundedText(input.title, "title", 1, 120);
    const body = boundedText(input.body, "body", 1, 2_000);
    assertSafeAdvertiserDisplayText(title);
    assertSafeAdvertiserDisplayText(body);
    const points = integer(input.points, "points", 0, 10_000);
    const ad: TeamAd = {
      id: `team_ad_${crypto.randomUUID()}`,
      advertiserMemberId: member.id,
      advertiserName: member.displayName,
      title,
      body,
      targetTags: tags(input.targetTags),
      points,
      rewardKind: "team_points",
      active: true,
      createdAt: this.now().toISOString(),
    };
    await this.#store.createAd(ad);
    return ad;
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
    const [members, ads, deliveries] = await Promise.all([
      this.#store.listMembers(), this.#store.listAds(), this.#store.listDeliveries(),
    ]);
    const selectedId = selected.id;
    const displayed = deliveries.filter((delivery) => delivery.status === "displayed");
    const adsById = new Map(ads.map((ad) => [ad.id, ad]));
    return {
      moneyEnabled: false as const,
      rewardKind: "team_points" as const,
      member: publicMember(selected),
      members: members.map(networkMember),
      ads,
      deliveries: deliveries.filter((delivery) => delivery.receiverMemberId === selectedId),
      score: {
        pointsReceived: displayed.filter((delivery) => delivery.receiverMemberId === selectedId).reduce((sum, delivery) => sum + delivery.points, 0),
        pointsSent: displayed.filter((delivery) => adsById.get(delivery.adId)?.advertiserMemberId === selectedId).reduce((sum, delivery) => sum + delivery.points, 0),
      },
    };
  }

  async browseAds(memberKey: unknown) {
    const selected = await this.requireMemberCapability(memberKey);
    const [ads, deliveries] = await Promise.all([this.#store.listAds(), this.#store.listDeliveries()]);
    const seen = new Set(deliveries
      .filter((delivery) => delivery.receiverMemberId === selected.id)
      .map((delivery) => delivery.adId));
    return rankEligibleAds(ads, selected, seen);
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
      nonCashReward: { kind: "team_points", amount: ad.points, label: "team points", redeemable: false },
      signalsUsed: delivery.matchedTags,
      creative: {
        body: `${ad.body}\n\nPlay-money reward: ${ad.points} team points. Team points have no cash value and cannot be redeemed.`,
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

function matchingTags(targetTags: string[], memberTags: string[]) {
  const member = new Set(memberTags);
  return targetTags.filter((tag) => member.has(tag));
}

export function rankEligibleAds(ads: TeamAd[], member: TeamMember, excludedAdIds: ReadonlySet<string>) {
  return ads
    .filter((ad) => ad.active && ad.advertiserMemberId !== member.id && !excludedAdIds.has(ad.id))
    .map((ad) => ({ ad, matchedTags: matchingTags(ad.targetTags, member.tags) }))
    .filter(({ ad, matchedTags }) => ad.targetTags.length === 0 || matchedTags.length > 0)
    .sort((left, right) => right.matchedTags.length - left.matchedTags.length || left.ad.createdAt.localeCompare(right.ad.createdAt));
}

function tags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("tags must be an array with at most 20 entries");
  const normalized = value.map((tag) => boundedText(tag, "tag", 1, 32).trim().toLowerCase());
  if (normalized.some((tag) => !/^[a-z0-9][a-z0-9+._-]{0,31}$/.test(tag))) throw new Error("tags contain an unsupported value");
  return [...new Set(normalized)];
}

function boundedText(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.trim().length < minimum || value.length > maximum) throw new Error(`${name} must contain ${minimum}-${maximum} characters`);
  return value.trim();
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value as number;
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
    tags: [...member.tags], receivesAds: member.receivesAds,
    createdAt: member.createdAt, updatedAt: member.updatedAt,
  };
}

function networkMember(member: TeamMember): PublicNetworkMember {
  return {
    id: member.id, displayName: member.displayName, tags: [...member.tags], receivesAds: member.receivesAds,
    createdAt: member.createdAt, updatedAt: member.updatedAt,
  };
}
