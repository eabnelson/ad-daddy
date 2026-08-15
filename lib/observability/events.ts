export const LIFECYCLE_EVENT_TYPES = [
  "opportunity_created", "auction_filled", "auction_no_fill", "placement_delivered",
  "receiver_paused", "advertiser_blocked", "placement_reported", "installation_uninstalled",
  "base_settled", "conversion_paid", "payout_paid", "payout_failed",
] as const;
export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

export interface LifecycleEvent {
  eventId: string;
  type: LifecycleEventType;
  occurredAt: string;
  reason?: string;
  receiverAccountId?: string;
  advertiserId?: string;
  placementId?: string;
  campaignId?: string;
}

export class LifecycleEventStore {
  readonly #events = new Map<string, LifecycleEvent>();
  record(input: LifecycleEvent): LifecycleEvent {
    if (!LIFECYCLE_EVENT_TYPES.includes(input.type) || !input.eventId || input.eventId.length > 128 || !Number.isFinite(Date.parse(input.occurredAt))) throw new Error("Lifecycle event is invalid");
    const allowedKeys = new Set(["eventId", "type", "occurredAt", "reason", "receiverAccountId", "advertiserId", "placementId", "campaignId"]);
    if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw new Error("Lifecycle event contains private or unsupported metadata");
    const existing = this.#events.get(input.eventId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(input)) throw new Error("Lifecycle event idempotency collision");
    if (!existing) this.#events.set(input.eventId, Object.freeze(structuredClone(input)));
    return structuredClone(existing ?? input);
  }
  aggregate(): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const event of this.#events.values()) {
      const key = event.reason ? `${event.type}:${event.reason}` : event.type;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.freeze(counts);
  }
}

export const lifecycleEvents = new LifecycleEventStore();
