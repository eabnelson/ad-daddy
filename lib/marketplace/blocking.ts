export class PlacementBlocklist {
  readonly #advertisers = new Map<string, Set<string>>();
  block(receiverAccountId: string, advertiserId: string): void {
    if (!receiverAccountId || !advertiserId) throw new Error("Receiver and advertiser are required");
    const blocked = this.#advertisers.get(receiverAccountId) ?? new Set<string>();
    blocked.add(advertiserId);
    this.#advertisers.set(receiverAccountId, blocked);
  }
  isBlocked(receiverAccountId: string, advertiserId: string): boolean {
    return this.#advertisers.get(receiverAccountId)?.has(advertiserId) ?? false;
  }
  assertAllowed(receiverAccountId: string, advertiserId: string): void {
    if (this.isBlocked(receiverAccountId, advertiserId)) throw new Error("Advertiser is blocked by the receiver");
  }
}

export const placementBlocklist = new PlacementBlocklist();

export interface ReceiverAdvertiserBlockRepository {
  block(receiverAccountId: string, advertiserId: string, sourcePlacementId?: string): void | Promise<void>;
  isBlocked(receiverAccountId: string, advertiserId: string): boolean | Promise<boolean>;
}

export class D1ReceiverAdvertiserBlockRepository implements ReceiverAdvertiserBlockRepository {
  readonly #db: D1Database;
  constructor(db: D1Database) { this.#db = db; }
  async block(receiverAccountId: string, advertiserId: string, sourcePlacementId?: string): Promise<void> {
    if (!receiverAccountId || !advertiserId) throw new Error("Receiver and advertiser are required");
    await this.#db.prepare(`INSERT INTO receiver_advertiser_blocks
      (receiver_account_id, advertiser_id, source_placement_id, blocked_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(receiver_account_id, advertiser_id) DO UPDATE SET
        source_placement_id = COALESCE(receiver_advertiser_blocks.source_placement_id, excluded.source_placement_id)`)
      .bind(receiverAccountId, advertiserId, sourcePlacementId ?? null, new Date().toISOString()).run();
  }
  async isBlocked(receiverAccountId: string, advertiserId: string): Promise<boolean> {
    const row = await this.#db.prepare(`SELECT 1 AS blocked FROM receiver_advertiser_blocks
      WHERE receiver_account_id = ? AND advertiser_id = ?`).bind(receiverAccountId, advertiserId).first<{ blocked: number }>();
    return row?.blocked === 1;
  }
}

let deployed: D1ReceiverAdvertiserBlockRepository | undefined;
export async function getReceiverAdvertiserBlockRepository(): Promise<D1ReceiverAdvertiserBlockRepository> {
  if (deployed) return deployed;
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("D1 receiver block binding is required");
  deployed = new D1ReceiverAdvertiserBlockRepository(env.DB);
  return deployed;
}
