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
