export interface OutboxEventInput {
  eventId: string;
  idempotencyKey: string;
  topic: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface OutboxEvent extends OutboxEventInput {
  status: "pending" | "delivered";
  attempts: number;
  createdAt: string;
  deliveredAt?: string;
  deliveryReceipt?: Readonly<Record<string, unknown>>;
}

export interface OutboxStore {
  enqueue(event: OutboxEventInput): OutboxEvent;
  get(eventId: string): OutboxEvent | undefined;
  recordAttempt(eventId: string): OutboxEvent;
  markDelivered(eventId: string, receipt: Readonly<Record<string, unknown>>): OutboxEvent;
}

export class InMemoryOutbox implements OutboxStore {
  readonly #events = new Map<string, OutboxEvent>();
  readonly #idempotencyKeys = new Map<string, string>();

  enqueue(input: OutboxEventInput): OutboxEvent {
    if (!input.eventId || input.eventId.length > 128 || !input.idempotencyKey || input.idempotencyKey.length > 256 || !input.topic || input.topic.length > 128) {
      throw new Error("Outbox event identifiers and topic must be bounded non-empty strings");
    }
    const payloadJson = canonicalJson(input.payload);
    if (payloadJson.length > 65_536) throw new Error("Outbox payload exceeds 65,536 characters");
    const existingId = this.#idempotencyKeys.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.#events.get(existingId)!;
      if (
        existing.eventId !== input.eventId ||
        existing.topic !== input.topic ||
        canonicalJson(existing.payload) !== payloadJson
      ) {
        throw new Error(`Idempotency key collision: ${input.idempotencyKey}`);
      }
      return Object.freeze({ ...existing });
    }
    if (this.#events.has(input.eventId)) throw new Error(`Outbox event already exists: ${input.eventId}`);
    const event: OutboxEvent = {
      ...input,
      payload: Object.freeze(structuredClone(input.payload)),
      status: "pending",
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    this.#events.set(input.eventId, event);
    this.#idempotencyKeys.set(input.idempotencyKey, input.eventId);
    return Object.freeze({ ...event });
  }

  get(eventId: string): OutboxEvent | undefined {
    const event = this.#events.get(eventId);
    return event ? Object.freeze({ ...event }) : undefined;
  }

  recordAttempt(eventId: string): OutboxEvent {
    const event = this.require(eventId);
    if (event.status === "delivered") return Object.freeze({ ...event });
    event.attempts += 1;
    return Object.freeze({ ...event });
  }

  markDelivered(eventId: string, receipt: Readonly<Record<string, unknown>>): OutboxEvent {
    const event = this.require(eventId);
    if (event.status === "delivered") return Object.freeze({ ...event });
    event.status = "delivered";
    event.deliveredAt = new Date().toISOString();
    event.deliveryReceipt = Object.freeze(structuredClone(receipt));
    return Object.freeze({ ...event });
  }

  private require(eventId: string): OutboxEvent {
    const event = this.#events.get(eventId);
    if (!event) throw new Error(`Unknown outbox event: ${eventId}`);
    return event;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export type OutboxHandler = (event: OutboxEvent) => Promise<Readonly<Record<string, unknown>>>;

export class OutboxDispatcher {
  readonly #inFlight = new Map<string, Promise<OutboxEvent>>();
  readonly #store: OutboxStore;
  readonly #handler: OutboxHandler;

  constructor(
    store: OutboxStore,
    handler: OutboxHandler,
  ) {
    this.#store = store;
    this.#handler = handler;
  }

  deliver(eventId: string): Promise<OutboxEvent> {
    const existing = this.#store.get(eventId);
    if (!existing) return Promise.reject(new Error(`Unknown outbox event: ${eventId}`));
    if (existing.status === "delivered") return Promise.resolve(existing);
    const inFlight = this.#inFlight.get(eventId);
    if (inFlight) return inFlight;

    const delivery = this.attempt(eventId).finally(() => this.#inFlight.delete(eventId));
    this.#inFlight.set(eventId, delivery);
    return delivery;
  }

  private async attempt(eventId: string): Promise<OutboxEvent> {
    const event = this.#store.recordAttempt(eventId);
    const receipt = await this.#handler(event);
    return this.#store.markDelivered(eventId, receipt);
  }
}
