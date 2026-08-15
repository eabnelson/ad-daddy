export type CampaignBudgetStatus = "active" | "paused" | "closed";

export interface BudgetReservation {
  reservationId: string;
  amountMinor: number;
  day: string;
  status: "reserved" | "released" | "committed";
}

export interface CampaignBudgetSnapshot {
  campaignId: string;
  status: CampaignBudgetStatus;
  fundedMinor: number;
  spentMinor: number;
  reservedMinor: number;
  heldMinor: number;
  withdrawableMinor: number;
  dailyCapMinor: number;
  history: readonly BudgetReservation[];
}

interface BudgetRecord {
  campaignId: string;
  status: CampaignBudgetStatus;
  fundedMinor: number;
  spentMinor: number;
  dailyCapMinor: number;
  reservations: Map<string, BudgetReservation>;
  holds: Map<string, number>;
}

export class CampaignBudgetService {
  readonly #records = new Map<string, BudgetRecord>();
  readonly #tails = new Map<string, Promise<void>>();

  open(input: { campaignId: string; fundedMinor: number; dailyCapMinor: number }): CampaignBudgetSnapshot {
    assertAmount(input.fundedMinor, "fundedMinor", true);
    assertAmount(input.dailyCapMinor, "dailyCapMinor", true);
    if (input.dailyCapMinor > input.fundedMinor) throw new Error("Daily cap cannot exceed funded balance");
    if (this.#records.has(input.campaignId)) throw new Error("Campaign budget already exists");
    this.#records.set(input.campaignId, {
      campaignId: input.campaignId,
      status: "active",
      fundedMinor: input.fundedMinor,
      spentMinor: 0,
      dailyCapMinor: input.dailyCapMinor,
      reservations: new Map(),
      holds: new Map(),
    });
    return this.snapshot(input.campaignId);
  }

  async reserve(campaignId: string, reservationId: string, amountMinor: number, now = new Date()): Promise<BudgetReservation> {
    return this.serialize(campaignId, () => {
      const record = this.require(campaignId);
      const existing = record.reservations.get(reservationId);
      if (existing) {
        if (existing.amountMinor !== amountMinor) throw new Error("Reservation idempotency key collision");
        if (existing.status === "released") throw new Error("Reservation was released");
        return Object.freeze({ ...existing });
      }
      if (record.status !== "active") throw new Error(`Campaign is ${record.status}`);
      assertAmount(amountMinor, "amountMinor");
      const reservedMinor = sumActiveReservations(record);
      const heldMinor = sum(record.holds.values());
      if (record.spentMinor + reservedMinor + heldMinor + amountMinor > record.fundedMinor) throw new Error("Insufficient funded campaign balance");
      const day = now.toISOString().slice(0, 10);
      const dailyUsed = [...record.reservations.values()]
        .filter((item) => item.day === day && item.status !== "released")
        .reduce((total, item) => total + item.amountMinor, 0);
      if (dailyUsed + amountMinor > record.dailyCapMinor) throw new Error("Campaign daily cap exceeded");
      const reservation: BudgetReservation = { reservationId, amountMinor, day, status: "reserved" };
      record.reservations.set(reservationId, reservation);
      return Object.freeze({ ...reservation });
    });
  }

  async release(campaignId: string, reservationId: string): Promise<BudgetReservation> {
    return this.serialize(campaignId, () => {
      const reservation = this.require(campaignId).reservations.get(reservationId);
      if (!reservation) throw new Error("Unknown reservation");
      if (reservation.status === "committed") throw new Error("Committed reservation cannot be released");
      reservation.status = "released";
      return Object.freeze({ ...reservation });
    });
  }

  async commit(campaignId: string, reservationId: string): Promise<BudgetReservation> {
    return this.serialize(campaignId, () => {
      const record = this.require(campaignId);
      const reservation = record.reservations.get(reservationId);
      if (!reservation || reservation.status !== "reserved") throw new Error("Reservation is not active");
      reservation.status = "committed";
      record.spentMinor += reservation.amountMinor;
      return Object.freeze({ ...reservation });
    });
  }

  async hold(campaignId: string, holdId: string, amountMinor: number): Promise<CampaignBudgetSnapshot> {
    return this.serialize(campaignId, () => {
      const record = this.require(campaignId);
      if (record.status === "closed") throw new Error("Campaign is closed");
      assertAmount(amountMinor, "hold amount");
      const existing = record.holds.get(holdId);
      if (existing !== undefined && existing !== amountMinor) throw new Error("Hold idempotency key collision");
      if (existing === undefined && record.spentMinor + sumActiveReservations(record) + sum(record.holds.values()) + amountMinor > record.fundedMinor) {
        throw new Error("Insufficient balance for hold");
      }
      record.holds.set(holdId, amountMinor);
      return this.toSnapshot(record);
    });
  }

  async pause(campaignId: string): Promise<CampaignBudgetSnapshot> {
    return this.serialize(campaignId, () => {
      const record = this.require(campaignId);
      if (record.status === "closed") throw new Error("Campaign is closed");
      record.status = "paused";
      for (const reservation of record.reservations.values()) {
        if (reservation.status === "reserved") reservation.status = "released";
      }
      return this.toSnapshot(record);
    });
  }

  async resume(campaignId: string): Promise<CampaignBudgetSnapshot> {
    return this.serialize(campaignId, () => {
      const record = this.require(campaignId);
      if (record.status === "closed") throw new Error("Campaign is closed permanently");
      record.status = "active";
      return this.toSnapshot(record);
    });
  }

  async close(campaignId: string): Promise<CampaignBudgetSnapshot> {
    return this.serialize(campaignId, () => {
      const record = this.require(campaignId);
      record.status = "closed";
      return this.toSnapshot(record);
    });
  }

  snapshot(campaignId: string): CampaignBudgetSnapshot {
    return this.toSnapshot(this.require(campaignId));
  }

  private async serialize<T>(campaignId: string, operation: () => T): Promise<T> {
    const previous = this.#tails.get(campaignId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.#tails.set(campaignId, tail);
    await previous;
    try { return operation(); }
    finally {
      release();
      if (this.#tails.get(campaignId) === tail) this.#tails.delete(campaignId);
    }
  }

  private require(campaignId: string): BudgetRecord {
    const record = this.#records.get(campaignId);
    if (!record) throw new Error("Unknown campaign budget");
    return record;
  }

  private toSnapshot(record: BudgetRecord): CampaignBudgetSnapshot {
    const reservedMinor = sumActiveReservations(record);
    const heldMinor = sum(record.holds.values());
    return Object.freeze({
      campaignId: record.campaignId,
      status: record.status,
      fundedMinor: record.fundedMinor,
      spentMinor: record.spentMinor,
      reservedMinor,
      heldMinor,
      withdrawableMinor: record.fundedMinor - record.spentMinor - reservedMinor - heldMinor,
      dailyCapMinor: record.dailyCapMinor,
      history: Object.freeze([...record.reservations.values()].map((item) => Object.freeze({ ...item }))),
    });
  }
}

function assertAmount(value: number, name: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
}

function sum(values: Iterable<number>): number { let total = 0; for (const value of values) total += value; return total; }
function sumActiveReservations(record: BudgetRecord): number {
  return [...record.reservations.values()].filter((item) => item.status === "reserved").reduce((total, item) => total + item.amountMinor, 0);
}
