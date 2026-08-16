import type {
  LedgerEntry,
  LedgerTransaction,
  LedgerTransactionInput,
  RevenueSplitVersion,
} from "../domain/types.ts";

export class LedgerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerInvariantError";
  }
}

export interface LedgerRepository {
  commit(transaction: LedgerTransaction): Promise<LedgerTransaction>;
  list(): Promise<readonly LedgerTransaction[]>;
  listForAccounts?(accountIds: readonly string[], input: { limit: number; cursor?: string }): Promise<{ transactions: readonly LedgerTransaction[]; nextCursor: string | null }>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(input: LedgerTransactionInput): string {
  return canonicalJson({
    transactionId: input.transactionId,
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    currency: input.currency,
    referenceId: input.referenceId,
    entries: input.entries,
    splitVersion: input.splitVersion,
    chainReference: input.chainReference,
  });
}

function assertText(value: string, name: string, maxLength = 256): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new LedgerInvariantError(`${name} must be 1-${maxLength} characters`);
  }
}

function buildTransaction(input: LedgerTransactionInput): LedgerTransaction {
  assertText(input.transactionId, "transactionId", 128);
  assertText(input.idempotencyKey, "idempotencyKey", 256);
  assertText(input.referenceId, "referenceId", 128);
  if (!/^[A-Z][A-Z0-9]{2,11}$/.test(input.currency)) throw new LedgerInvariantError("currency must be an uppercase asset code");
  if (input.entries.length < 2 || input.entries.length > 32) throw new LedgerInvariantError("ledger transactions require 2-32 entries");

  let balance = 0;
  const entries: LedgerEntry[] = input.entries.map((entry, index) => {
    assertText(entry.accountId, `entries[${index}].accountId`, 128);
    if (!Number.isSafeInteger(entry.amountMinor) || entry.amountMinor === 0) {
      throw new LedgerInvariantError(`entries[${index}].amountMinor must be a non-zero safe integer`);
    }
    const entryCurrency = entry.currency ?? input.currency;
    if (entryCurrency !== input.currency) throw new LedgerInvariantError("mixed-currency transactions are not allowed");
    balance += entry.amountMinor;
    if (!Number.isSafeInteger(balance)) throw new LedgerInvariantError("ledger transaction total exceeds safe integer range");
    return Object.freeze({
      entryId: `${input.transactionId}:${index + 1}`,
      accountId: entry.accountId,
      amountMinor: entry.amountMinor,
      currency: entryCurrency,
      ...(entry.memo === undefined ? {} : { memo: entry.memo }),
    });
  });
  if (balance !== 0) throw new LedgerInvariantError(`ledger transaction is unbalanced by ${balance} minor units`);

  return Object.freeze({
    transactionId: input.transactionId,
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    currency: input.currency,
    referenceId: input.referenceId,
    entries: Object.freeze(entries),
    ...(input.splitVersion === undefined ? {} : { splitVersion: input.splitVersion }),
    ...(input.chainReference === undefined ? {} : { chainReference: input.chainReference }),
    createdAt: input.createdAt ?? new Date().toISOString(),
    inputFingerprint: fingerprint(input),
  });
}

export class InMemoryLedgerRepository implements LedgerRepository {
  readonly transactions: LedgerTransaction[] = [];
  readonly #byIdempotencyKey = new Map<string, LedgerTransaction>();
  readonly #byTransactionId = new Map<string, LedgerTransaction>();

  async commit(transaction: LedgerTransaction): Promise<LedgerTransaction> {
    const existing = this.#byIdempotencyKey.get(transaction.idempotencyKey);
    if (existing) {
      if (existing.inputFingerprint !== transaction.inputFingerprint) {
        throw new LedgerInvariantError(`Idempotency key collision: ${transaction.idempotencyKey}`);
      }
      return existing;
    }
    if (this.#byTransactionId.has(transaction.transactionId)) {
      throw new LedgerInvariantError(`Transaction ID already exists: ${transaction.transactionId}`);
    }
    this.#byIdempotencyKey.set(transaction.idempotencyKey, transaction);
    this.#byTransactionId.set(transaction.transactionId, transaction);
    this.transactions.push(transaction);
    return transaction;
  }

  async list(): Promise<readonly LedgerTransaction[]> {
    return structuredClone(this.transactions);
  }

  async listForAccounts(accountIds: readonly string[], input: { limit: number; cursor?: string }) {
    const owned = new Set(accountIds);
    const ordered = this.transactions.filter((transaction) => transaction.entries.some((entry) => owned.has(entry.accountId)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.transactionId.localeCompare(left.transactionId));
    const start = input.cursor ? ordered.findIndex((item) => ledgerCursor(item) === input.cursor) + 1 : 0;
    const page = ordered.slice(Math.max(start, 0), Math.max(start, 0) + input.limit);
    return { transactions: structuredClone(page), nextCursor: page.length === input.limit ? ledgerCursor(page.at(-1)!) : null };
  }
}

function ledgerCursor(transaction: LedgerTransaction): string {
  return Buffer.from(`${transaction.createdAt}\0${transaction.transactionId}`).toString("base64url");
}

export class LedgerService {
  readonly #repository: LedgerRepository;

  constructor(repository: LedgerRepository) {
    this.#repository = repository;
  }

  async post(input: LedgerTransactionInput): Promise<LedgerTransaction> {
    return this.#repository.commit(buildTransaction(input));
  }
}

export function calculateRevenueSplit(
  grossMinor: number,
  split: RevenueSplitVersion,
): { receiverMinor: number; operatorMinor: number } {
  if (!Number.isSafeInteger(grossMinor) || grossMinor < 0) throw new LedgerInvariantError("grossMinor must be a non-negative safe integer");
  if (
    !Number.isInteger(split.receiverBasisPoints) ||
    !Number.isInteger(split.operatorBasisPoints) ||
    split.receiverBasisPoints < 0 ||
    split.operatorBasisPoints < 0 ||
    split.receiverBasisPoints + split.operatorBasisPoints !== 10_000
  ) {
    throw new LedgerInvariantError("revenue split basis points must be non-negative integers totaling 10,000");
  }
  assertText(split.version, "split.version", 128);
  // Round the operator fee down so integer conversion never reduces the
  // receiver below the advertised share. The receiver receives the remainder.
  const operatorMinor = Number((BigInt(grossMinor) * BigInt(split.operatorBasisPoints)) / BigInt(10_000));
  if (!Number.isSafeInteger(operatorMinor)) throw new LedgerInvariantError("revenue split exceeds safe integer range");
  return Object.freeze({ receiverMinor: grossMinor - operatorMinor, operatorMinor });
}

export const LAUNCH_REVENUE_SPLIT: RevenueSplitVersion = Object.freeze({
  version: "launch-80-20/v1",
  receiverBasisPoints: 8_000,
  operatorBasisPoints: 2_000,
});
