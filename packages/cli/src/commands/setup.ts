import type { LocalInstallationConfig, LocalStore, SetupRole } from "../local-store.js";
import { buildPublishedProfile, type ReceiverFieldSelection, type ReceiverFieldValues } from "./profile.js";

interface Approval {
  accountId: string;
  approvedAt: string;
  expiresAt: string;
  purposes: readonly string[];
  approvedPayoutAddress: string;
}

export interface SetupInput {
  installationId: string;
  accountId: string;
  role: SetupRole;
  profile: { values: ReceiverFieldValues; enabled: ReceiverFieldSelection };
  cadenceMinutes: number;
  termsVersion: string;
  privacyVersion: string;
  verifiedPayout?: { address: string; approval: Approval };
  hostDisclosure: { host: string; displayModel?: string; consumesTurn: true };
}

interface SetupDependencies {
  stopScheduler?: (installationId: string) => Promise<void>;
  revokeConsent?: (installationId: string, consentVersion: number) => Promise<void>;
}

export class ReceiverSetupService {
  readonly #store: LocalStore;
  readonly #dependencies: SetupDependencies;
  constructor(store: LocalStore, dependencies: SetupDependencies = {}) {
    this.#store = store;
    this.#dependencies = dependencies;
  }

  async prepare(input: SetupInput) {
    selectSetupRole(input.role);
    if (input.role === "advertiser") throw new Error("Receiver profile setup requires receiver or both role");
    if (!Number.isSafeInteger(input.cadenceMinutes) || input.cadenceMinutes < 5) throw new Error("Cadence must be at least five minutes");
    const existing = await this.#store.get(input.installationId);
    if (existing && existing.accountId !== input.accountId) throw new Error("Installation belongs to another account");
    const publishedFields = buildPublishedProfile(input.profile);
    const consentVersion = (existing?.consentVersion ?? 0) + 1;
    let payoutAddress = existing?.payoutAddress;
    if (input.verifiedPayout) {
      assertPayoutApproval(input.verifiedPayout.approval, input.accountId, input.verifiedPayout.address, new Date());
      if (!input.verifiedPayout.address.trim()) throw new Error("Payout address is required");
      payoutAddress = input.verifiedPayout.address;
    }
    const config: LocalInstallationConfig = {
      installationId: input.installationId,
      accountId: input.accountId,
      role: input.role,
      profile: structuredClone(input.profile),
      publishedFields,
      cadenceMinutes: input.cadenceMinutes,
      termsVersion: input.termsVersion,
      privacyVersion: input.privacyVersion,
      consentVersion,
      status: "draft",
      payoutAddress,
      pendingPayoutAddress: existing?.pendingPayoutAddress,
      hostDisclosure: structuredClone(input.hostDisclosure),
    };
    await this.#store.put(config);
    const model = input.hostDisclosure.displayModel ? ` using ${input.hostDisclosure.displayModel}` : " using the host-selected model";
    return { ...structuredClone(config), activationDisclosure: `Each native placement consumes one ${input.hostDisclosure.host} display turn${model}. It creates a separate sponsored session and never runs advertiser actions.` };
  }

  async activate(input: { installationId: string; disclosureAccepted: boolean; termsAccepted: boolean; privacyAccepted: boolean }) {
    const config = await this.require(input.installationId);
    if (!input.disclosureAccepted) throw new Error("Accept the display-turn and model disclosure before activation");
    if (!input.termsAccepted || !input.privacyAccepted) throw new Error("Accept the current terms and privacy contract before activation");
    const rewards = config.publishedFields.acceptedRewardTypes ?? [];
    if (rewards.includes("stablecoin") && !config.payoutAddress) throw new Error("A human-approved payout address is required for cash activation");
    config.status = "active";
    await this.#store.put(config);
    return config;
  }

  async pause(installationId: string) {
    const config = await this.require(installationId);
    const revokedVersion = config.consentVersion;
    config.status = "paused";
    config.consentVersion += 1;
    await this.#store.put(config);
    await this.#dependencies.stopScheduler?.(installationId);
    await this.#dependencies.revokeConsent?.(installationId, revokedVersion);
    return config;
  }

  async revoke(installationId: string) {
    const paused = await this.pause(installationId);
    paused.status = "revoked";
    await this.#store.put(paused);
    return paused;
  }

  async requestPayoutAddressChange(installationId: string, address: string) {
    const config = await this.require(installationId);
    if (!address.trim()) throw new Error("Payout address is required");
    config.pendingPayoutAddress = address;
    await this.#store.put(config);
    return config;
  }

  async approvePayoutAddressChange(installationId: string, approval: Approval, now = new Date()) {
    const config = await this.require(installationId);
    if (!config.pendingPayoutAddress) throw new Error("No payout address change is pending");
    assertPayoutApproval(approval, config.accountId, config.pendingPayoutAddress, now);
    config.payoutAddress = config.pendingPayoutAddress;
    delete config.pendingPayoutAddress;
    await this.#store.put(config);
    return config;
  }

  private async require(installationId: string) {
    const config = await this.#store.get(installationId);
    if (!config) throw new Error("Unknown installation");
    return config;
  }
}

export function selectSetupRole(role: SetupRole) {
  if (!(["receiver", "advertiser", "both"] as const).includes(role)) throw new Error("Choose receiver, advertiser, or both before setup");
  return {
    role,
    configureReceiver: role === "receiver" || role === "both",
    configureAdvertiser: role === "advertiser" || role === "both",
  };
}

function assertPayoutApproval(approval: Approval, accountId: string, address: string, now: Date): void {
  const approvedAt = Date.parse(approval.approvedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  if (approval.accountId !== accountId || approval.approvedPayoutAddress !== address || !approval.purposes.includes("payout_address_change") || !Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || expiresAt <= now.getTime() || approvedAt > now.getTime() || approvedAt >= expiresAt || now.getTime() - approvedAt > 10 * 60_000) {
    throw new Error("A recent human or wallet approval for the payout address is required");
  }
}
