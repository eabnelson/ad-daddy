import { KeyedSerialExecutor } from "../runtime/keyed-serial.ts";

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
  reservedMinor: number;
  heldMinor: number;
  dailyCapMinor: number;
  reservations: Map<string, BudgetReservation>;
  holds: Map<string, number>;
}

export class CampaignBudgetService {
  readonly #records = new Map<string, BudgetRecord>();
  readonly #serial = new KeyedSerialExecutor();

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
      reservedMinor: 0,
      heldMinor: 0,
      dailyCapMinor: input.dailyCapMinor,
      reservations: new Map(),
      holds: new Map(),
    });
    return this.snapshot(input.campaignId);
  }

  async reserve(campaignId: string, reservationId: string, amountMinor: number, now = new Date()): Promise<BudgetReservation> {
    return this.#serial.run(campaignId, () => {
      const record = this.require(campaignId);
      const existing = record.reservations.get(reservationId);
      if (existing) {
        if (existing.amountMinor !== amountMinor) throw new Error("Reservation idempotency key collision");
        if (existing.status === "released") throw new Error("Reservation was released");
        return Object.freeze({ ...existing });
      }
      if (record.status !== "active") throw new Error(`Campaign is ${record.status}`);
      assertAmount(amountMinor, "amountMinor");
      if (record.spentMinor + record.reservedMinor + record.heldMinor + amountMinor > record.fundedMinor) throw new Error("Insufficient funded campaign balance");
      const day = now.toISOString().slice(0, 10);
      const dailyUsed = [...record.reservations.values()]
        .filter((item) => item.day === day && item.status !== "released")
        .reduce((total, item) => total + item.amountMinor, 0);
      if (dailyUsed + amountMinor > record.dailyCapMinor) throw new Error("Campaign daily cap exceeded");
      const reservation: BudgetReservation = { reservationId, amountMinor, day, status: "reserved" };
      record.reservations.set(reservationId, reservation);
      record.reservedMinor += amountMinor;
      return Object.freeze({ ...reservation });
    });
  }

  async release(campaignId: string, reservationId: string): Promise<BudgetReservation> {
    return this.#serial.run(campaignId, () => {
      const reservation = this.require(campaignId).reservations.get(reservationId);
      if (!reservation) throw new Error("Unknown reservation");
      if (reservation.status === "committed") throw new Error("Committed reservation cannot be released");
      if (reservation.status === "reserved") this.require(campaignId).reservedMinor -= reservation.amountMinor;
      reservation.status = "released";
      return Object.freeze({ ...reservation });
    });
  }

  async commit(campaignId: string, reservationId: string): Promise<BudgetReservation> {
    return this.#serial.run(campaignId, () => {
      const record = this.require(campaignId);
      const reservation = record.reservations.get(reservationId);
      if (!reservation || reservation.status !== "reserved") throw new Error("Reservation is not active");
      reservation.status = "committed";
      record.reservedMinor -= reservation.amountMinor;
      record.spentMinor += reservation.amountMinor;
      return Object.freeze({ ...reservation });
    });
  }

  async hold(campaignId: string, holdId: string, amountMinor: number): Promise<CampaignBudgetSnapshot> {
    return this.#serial.run(campaignId, () => {
      const record = this.require(campaignId);
      if (record.status === "closed") throw new Error("Campaign is closed");
      assertAmount(amountMinor, "hold amount");
      const existing = record.holds.get(holdId);
      if (existing !== undefined && existing !== amountMinor) throw new Error("Hold idempotency key collision");
      if (existing === undefined && record.spentMinor + record.reservedMinor + record.heldMinor + amountMinor > record.fundedMinor) {
        throw new Error("Insufficient balance for hold");
      }
      if (existing === undefined) {
        record.holds.set(holdId, amountMinor);
        record.heldMinor += amountMinor;
      }
      return this.toSnapshot(record);
    });
  }

  async pause(campaignId: string): Promise<CampaignBudgetSnapshot> {
    return this.#serial.run(campaignId, () => {
      const record = this.require(campaignId);
      if (record.status === "closed") throw new Error("Campaign is closed");
      record.status = "paused";
      for (const reservation of record.reservations.values()) {
        if (reservation.status === "reserved") reservation.status = "released";
      }
      record.reservedMinor = 0;
      return this.toSnapshot(record);
    });
  }

  async resume(campaignId: string): Promise<CampaignBudgetSnapshot> {
    return this.#serial.run(campaignId, () => {
      const record = this.require(campaignId);
      if (record.status === "closed") throw new Error("Campaign is closed permanently");
      record.status = "active";
      return this.toSnapshot(record);
    });
  }

  async close(campaignId: string): Promise<CampaignBudgetSnapshot> {
    return this.#serial.run(campaignId, () => {
      const record = this.require(campaignId);
      record.status = "closed";
      return this.toSnapshot(record);
    });
  }

  snapshot(campaignId: string): CampaignBudgetSnapshot {
    return this.toSnapshot(this.require(campaignId));
  }

  balance(campaignId: string): Readonly<{ withdrawableMinor: number }> {
    const record = this.require(campaignId);
    return Object.freeze({ withdrawableMinor: record.fundedMinor - record.spentMinor - record.reservedMinor - record.heldMinor });
  }

  private require(campaignId: string): BudgetRecord {
    const record = this.#records.get(campaignId);
    if (!record) throw new Error("Unknown campaign budget");
    return record;
  }

  private toSnapshot(record: BudgetRecord): CampaignBudgetSnapshot {
    return Object.freeze({
      campaignId: record.campaignId,
      status: record.status,
      fundedMinor: record.fundedMinor,
      spentMinor: record.spentMinor,
      reservedMinor: record.reservedMinor,
      heldMinor: record.heldMinor,
      withdrawableMinor: record.fundedMinor - record.spentMinor - record.reservedMinor - record.heldMinor,
      dailyCapMinor: record.dailyCapMinor,
      history: Object.freeze([...record.reservations.values()].map((item) => Object.freeze({ ...item }))),
    });
  }
}

function assertAmount(value: number, name: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
}
