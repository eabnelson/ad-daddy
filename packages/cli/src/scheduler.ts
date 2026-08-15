export interface SchedulerPolicy {
  cadenceMinutes: number;
  maxPerDay?: number;
  quietHours?: { startHourLocal: number; endHourLocal: number };
}

export function evaluateCheckPolicy(policy: SchedulerPolicy, state: { now: Date; lastCheckedAt?: string; placementsToday?: number }): { allowed: boolean; reason?: "quiet_hours" | "cadence" | "frequency_cap" } {
  const hour = state.now.getHours();
  const quiet = policy.quietHours;
  if (quiet) {
    const within = quiet.startHourLocal < quiet.endHourLocal
      ? hour >= quiet.startHourLocal && hour < quiet.endHourLocal
      : hour >= quiet.startHourLocal || hour < quiet.endHourLocal;
    if (within) return { allowed: false, reason: "quiet_hours" };
  }
  if (state.lastCheckedAt && state.now.getTime() - Date.parse(state.lastCheckedAt) < policy.cadenceMinutes * 60_000) {
    return { allowed: false, reason: "cadence" };
  }
  if (policy.maxPerDay !== undefined && (state.placementsToday ?? 0) >= policy.maxPerDay) return { allowed: false, reason: "frequency_cap" };
  return { allowed: true };
}

export function schedulerSupport(platform: NodeJS.Platform | string) {
  if (platform === "darwin") return { automaticDelivery: true, manualCommand: "ad-daddy check", message: "Automatic delivery is available through an approved macOS launchd job." };
  return { automaticDelivery: false, manualCommand: "ad-daddy check", message: `Automatic delivery is unavailable on ${platform}; run ad-daddy check manually.` };
}

export class CheckCoordinator<T> {
  #inFlight?: Promise<T>;
  readonly #poll: () => Promise<T>;
  constructor(poll: () => Promise<T>) { this.#poll = poll; }
  check(): Promise<T> {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#poll().finally(() => { this.#inFlight = undefined; });
    return this.#inFlight;
  }
}
