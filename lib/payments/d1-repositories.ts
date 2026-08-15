import type { LedgerTransaction } from "../domain/types.ts";
import type { DepositCommitment, DepositRecord } from "./deposits.ts";
import { LedgerInvariantError, type LedgerRepository } from "./ledger.ts";
import type { PayoutDestination, PayoutRecord } from "./payouts.ts";
import type { DurableRefundRecord, PaymentStateRepository } from "./repository.ts";
import type { RefundApprovalRecord, RefundApprovalRepository, VerifiedRefundHumanProof } from "./refunds.ts";

type Row = Record<string, unknown>;
const DEPOSIT_RECORD_COLUMNS = `e.id AS depositId, e.commitment_id AS commitmentId, c.campaign_id AS campaignId,
  c.advertiser_account_id AS advertiserAccountId, e.chain_id AS chainId, e.token_address AS tokenAddress,
  e.transaction_hash AS transactionHash, e.log_index AS logIndex, e.opaque_memo AS memo,
  e.amount_minor AS amountMinor, e.status, e.reason, e.policy_version AS policyVersion`;

export class D1LedgerRepository implements LedgerRepository {
  readonly #db: D1Database;
  constructor(db: D1Database) { this.#db = db; }

  async commit(transaction: LedgerTransaction): Promise<LedgerTransaction> {
    const existing = await this.findByIdempotencyKey(transaction.idempotencyKey);
    if (existing) {
      if (existing.inputFingerprint !== transaction.inputFingerprint) throw new LedgerInvariantError(`Idempotency key collision: ${transaction.idempotencyKey}`);
      return existing;
    }
    if (await this.findByTransactionId(transaction.transactionId)) throw new LedgerInvariantError(`Transaction ID already exists: ${transaction.transactionId}`);

    const statements: D1PreparedStatement[] = [];
    for (const entry of transaction.entries) {
      const owner = ledgerOwner(entry.accountId);
      statements.push(this.#db.prepare("INSERT OR IGNORE INTO ledger_accounts (id, owner_kind, owner_id, currency) VALUES (?, ?, ?, ?)")
        .bind(entry.accountId, owner.kind, owner.id, entry.currency));
    }
    if (transaction.splitVersion) {
      statements.push(this.#db.prepare("INSERT OR IGNORE INTO revenue_split_versions (version, receiver_basis_points, operator_basis_points, effective_at) VALUES (?, 8000, 2000, ?)")
        .bind(transaction.splitVersion, transaction.createdAt));
    }
    statements.push(this.#db.prepare(`INSERT INTO ledger_transactions
      (id, idempotency_key, request_fingerprint, kind, currency, reference_id, revenue_split_version, entry_count, balance_minor, chain_reference, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'posted', ?)`)
      .bind(transaction.transactionId, transaction.idempotencyKey, transaction.inputFingerprint, transaction.kind, transaction.currency,
        transaction.referenceId, transaction.splitVersion ?? null, transaction.entries.length, transaction.chainReference ?? null, transaction.createdAt));
    transaction.entries.forEach((entry, index) => {
      statements.push(this.#db.prepare(`INSERT INTO ledger_entries
        (id, transaction_id, account_id, currency, amount_minor, memo, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(entry.entryId, transaction.transactionId, entry.accountId, entry.currency, entry.amountMinor, entry.memo ?? null, index + 1, transaction.createdAt));
    });
    try {
      await this.#db.batch(statements);
      return structuredClone(transaction);
    } catch (error) {
      const raced = await this.findByIdempotencyKey(transaction.idempotencyKey);
      if (raced?.inputFingerprint === transaction.inputFingerprint) return raced;
      throw error;
    }
  }

  async list(): Promise<readonly LedgerTransaction[]> {
    const result = await this.#db.prepare("SELECT id FROM ledger_transactions WHERE status = 'posted' ORDER BY created_at, id").all<{ id: string }>();
    return Promise.all(result.results.map((row) => this.findByTransactionId(row.id))).then((rows) => rows.filter((row): row is LedgerTransaction => Boolean(row)));
  }

  private async findByIdempotencyKey(key: string) {
    const row = await this.#db.prepare("SELECT id FROM ledger_transactions WHERE idempotency_key = ?").bind(key).first<{ id: string }>();
    return row ? this.findByTransactionId(row.id) : undefined;
  }

  private async findByTransactionId(id: string): Promise<LedgerTransaction | undefined> {
    const row = await this.#db.prepare(`SELECT id, idempotency_key AS idempotencyKey, request_fingerprint AS inputFingerprint,
      kind, currency, reference_id AS referenceId, revenue_split_version AS splitVersion, chain_reference AS chainReference,
      created_at AS createdAt FROM ledger_transactions WHERE id = ? AND status = 'posted'`).bind(id).first<Row>();
    if (!row) return undefined;
    const entries = await this.#db.prepare(`SELECT id AS entryId, account_id AS accountId, amount_minor AS amountMinor,
      currency, memo FROM ledger_entries WHERE transaction_id = ? ORDER BY sequence`).bind(id).all<Row>();
    return structuredClone({
      transactionId: text(row.id), idempotencyKey: text(row.idempotencyKey), inputFingerprint: text(row.inputFingerprint),
      kind: text(row.kind) as LedgerTransaction["kind"], currency: text(row.currency), referenceId: text(row.referenceId),
      entries: entries.results.map((entry) => ({ entryId: text(entry.entryId), accountId: text(entry.accountId), amountMinor: integer(entry.amountMinor), currency: text(entry.currency), ...(entry.memo === null ? {} : { memo: text(entry.memo) }) })),
      ...(row.splitVersion === null ? {} : { splitVersion: text(row.splitVersion) }),
      ...(row.chainReference === null ? {} : { chainReference: text(row.chainReference) }),
      createdAt: text(row.createdAt),
    });
  }
}

export class D1PaymentStateRepository implements PaymentStateRepository {
  readonly #db: D1Database;
  readonly #policyVersion: string;
  constructor(db: D1Database, policyVersion: string) { this.#db = db; this.#policyVersion = policyVersion; }

  async getDepositCommitment(memo: string) {
    const row = await this.#db.prepare(`SELECT id, campaign_id AS campaignId, advertiser_account_id AS advertiserAccountId,
      advertiser_ledger_account_id AS advertiserLedgerAccountId, treasury_ledger_account_id AS treasuryLedgerAccountId,
      amount_minor AS amountMinor, opaque_memo AS memo, expected_sender AS expectedSender
      FROM deposit_commitments WHERE opaque_memo = ?`).bind(memo.toLowerCase()).first<Row>();
    return row ? depositCommitment(row) : undefined;
  }
  async putDepositCommitment(value: DepositCommitment) {
    await this.#db.prepare(`INSERT OR IGNORE INTO deposit_commitments
      (id, campaign_id, advertiser_account_id, advertiser_ledger_account_id, treasury_ledger_account_id, opaque_memo, amount_minor, expected_sender, policy_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(value.commitmentId, value.campaignId, value.advertiserAccountId, value.advertiserLedgerAccountId, value.treasuryLedgerAccountId,
        value.memo.toLowerCase(), value.amountMinor, value.expectedSender ?? null, this.#policyVersion).run();
    const stored = await this.getDepositCommitment(value.memo);
    if (!stored || JSON.stringify(stored) !== JSON.stringify(value)) throw new Error("Deposit memo commitment collision");
    return stored;
  }
  async getDepositRecord(eventKey: string) {
    const [chainId, transactionHash, logIndex] = splitEventKey(eventKey);
    const row = await this.#db.prepare(`SELECT ${DEPOSIT_RECORD_COLUMNS}
      FROM chain_payment_events e LEFT JOIN deposit_commitments c ON c.id = e.commitment_id
      WHERE e.chain_id = ? AND e.transaction_hash = ? AND e.log_index = ?`).bind(chainId, transactionHash, logIndex).first<Row>();
    return row ? depositRecord(row) : undefined;
  }
  async getDepositRecordByMemo(memo: string) {
    const row = await this.#db.prepare(`SELECT ${DEPOSIT_RECORD_COLUMNS}
      FROM chain_payment_events e LEFT JOIN deposit_commitments c ON c.id = e.commitment_id
      WHERE e.opaque_memo = ? AND e.status <> 'quarantined' ORDER BY e.created_at LIMIT 1`).bind(memo.toLowerCase()).first<Row>();
    return row ? depositRecord(row) : undefined;
  }
  async findCreditedCampaignDeposit(input: { campaignId: string; advertiserAccountId: string; amountMinor: number; tokenAddress: string }) {
    const row = await this.#db.prepare(`SELECT ${DEPOSIT_RECORD_COLUMNS}
      FROM chain_payment_events e JOIN deposit_commitments c ON c.id = e.commitment_id
      WHERE c.campaign_id = ? AND c.advertiser_account_id = ? AND e.amount_minor = ?
        AND lower(e.token_address) = lower(?) AND e.status = 'credited' LIMIT 1`)
      .bind(input.campaignId, input.advertiserAccountId, input.amountMinor, input.tokenAddress).first<Row>();
    return row ? depositRecord(row) : undefined;
  }
  async putDepositRecord(record: DepositRecord) {
    const [chainId] = splitEventKey(record.eventKey);
    await this.#db.prepare(`INSERT INTO chain_payment_events
      (id, commitment_id, chain_id, token_address, transaction_hash, log_index, opaque_memo, amount_minor, status, reason, policy_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, transaction_hash, log_index) DO UPDATE SET status = excluded.status, reason = excluded.reason`)
      .bind(record.depositId, record.commitmentId ?? null, chainId, record.tokenAddress.toLowerCase(), record.transactionHash.toLowerCase(), record.logIndex, record.memo.toLowerCase(),
        record.amountMinor, record.status, record.reason ?? null, record.policyVersion).run();
    return (await this.getDepositRecord(record.eventKey))!;
  }
  async listPayoutDestinations(humanId: string) {
    const rows = await this.#db.prepare(`SELECT id, address, approved_at AS approvedAt, activates_at AS activatesAt
      FROM payout_destinations WHERE account_id = ? ORDER BY approved_at, id`).bind(humanId).all<Row>();
    return rows.results.map((row) => ({ destinationId: text(row.id), address: text(row.address), approvedAt: text(row.approvedAt), activatesAt: text(row.activatesAt) }));
  }
  async putPayoutDestination(humanId: string, destination: PayoutDestination) {
    await this.#db.prepare(`INSERT OR IGNORE INTO payout_destinations (id, account_id, address, approved_at, activates_at)
      VALUES (?, ?, ?, ?, ?)`).bind(destination.destinationId, humanId, destination.address, destination.approvedAt, destination.activatesAt).run();
    const values = await this.listPayoutDestinations(humanId);
    const stored = values.find((value) => value.destinationId === destination.destinationId);
    if (!stored) throw new Error("Payout destination was not persisted");
    return stored;
  }
  async getPayout(payoutId: string) {
    const row = await this.#db.prepare(`SELECT id AS payoutId, account_id AS receiverHumanId, receiver_ledger_account_id AS receiverLedgerAccountId,
      treasury_ledger_account_id AS treasuryLedgerAccountId, destination_address AS destination, destination_id AS destinationId,
      amount_minor AS amountMinor, opaque_memo AS memo, status, policy_version AS policyVersion, queued_at AS queuedAt,
      transaction_hash AS transactionHash, failure_reason AS failureReason FROM payout_records WHERE id = ?`).bind(payoutId).first<Row>();
    return row ? payoutRecord(row) : undefined;
  }
  async putPayout(record: PayoutRecord) {
    const statements = [this.#db.prepare(`INSERT INTO payout_records
      (id, account_id, receiver_ledger_account_id, treasury_ledger_account_id, destination_id, destination_address, amount_minor, opaque_memo,
       status, transaction_hash, failure_reason, policy_version, queued_at, paid_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, transaction_hash = excluded.transaction_hash,
        failure_reason = excluded.failure_reason, paid_at = excluded.paid_at`)
      .bind(record.payoutId, record.receiverHumanId, record.receiverLedgerAccountId, record.treasuryLedgerAccountId, record.destinationId,
        record.destination, record.amountMinor, record.memo, record.status, record.transactionHash ?? null, record.failureReason ?? null,
        record.policyVersion, record.queuedAt, record.status === "paid" ? new Date().toISOString() : null)];
    statements.push(outboxStatement(this.#db, "payout", record.payoutId, record.memo, record.status, record));
    await this.#db.batch(statements);
    return (await this.getPayout(record.payoutId))!;
  }
  async payoutTotalForPeriod(period: string) {
    const row = await this.#db.prepare("SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payout_records WHERE queued_at >= ? AND queued_at < ?")
      .bind(`${period}T00:00:00.000Z`, `${period}T23:59:59.999Z`).first<{ total: number }>();
    return row?.total ?? 0;
  }
  async getRefund(refundId: string) {
    const row = await this.#db.prepare(`SELECT id AS refundId, campaign_id AS campaignId, approval_id AS approvalId, account_id AS accountId,
      advertiser_ledger_account_id AS advertiserLedgerAccountId, treasury_ledger_account_id AS treasuryLedgerAccountId,
      amount_minor AS amountMinor, address, opaque_memo AS memo, reserved_minor AS reservedMinor, held_minor AS heldMinor,
      status, policy_version AS policyVersion, transaction_hash AS transactionHash, failure_reason AS failureReason
      FROM refund_records WHERE id = ?`).bind(refundId).first<Row>();
    if (!row) return undefined;
    return {
      record: {
        refundId: text(row.refundId), campaignId: text(row.campaignId), amountMinor: integer(row.amountMinor), address: text(row.address), memo: text(row.memo),
        status: text(row.status) as "pending" | "failed" | "paid", reservedMinor: integer(row.reservedMinor), heldMinor: integer(row.heldMinor),
        policyVersion: text(row.policyVersion), ...(row.transactionHash === null ? {} : { transactionHash: text(row.transactionHash) }),
        ...(row.failureReason === null ? {} : { failureReason: text(row.failureReason) }),
      },
      binding: { approvalId: text(row.approvalId), accountId: text(row.accountId), advertiserLedgerAccountId: text(row.advertiserLedgerAccountId), treasuryLedgerAccountId: text(row.treasuryLedgerAccountId) },
    };
  }
  async getRefundByCampaign(campaignId: string) {
    const row = await this.#db.prepare("SELECT id FROM refund_records WHERE campaign_id = ? ORDER BY created_at LIMIT 1")
      .bind(campaignId).first<{ id: string }>();
    return row ? this.getRefund(row.id) : undefined;
  }
  async putRefund(value: DurableRefundRecord) {
    const { record, binding } = value;
    const statements = [this.#db.prepare(`INSERT INTO refund_records
      (id, campaign_id, approval_id, account_id, advertiser_ledger_account_id, treasury_ledger_account_id, amount_minor, address, opaque_memo,
       reserved_minor, held_minor, status, transaction_hash, failure_reason, policy_version, paid_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, transaction_hash = excluded.transaction_hash,
        failure_reason = excluded.failure_reason, paid_at = excluded.paid_at`)
      .bind(record.refundId, record.campaignId, binding.approvalId, binding.accountId, binding.advertiserLedgerAccountId, binding.treasuryLedgerAccountId,
        record.amountMinor, record.address, record.memo, record.reservedMinor, record.heldMinor, record.status, record.transactionHash ?? null,
        record.failureReason ?? null, record.policyVersion, record.status === "paid" ? new Date().toISOString() : null)];
    statements.push(outboxStatement(this.#db, "refund", record.refundId, record.memo, record.status, record));
    await this.#db.batch(statements);
    return (await this.getRefund(record.refundId))!;
  }
}

export class D1RefundApprovalRepository implements RefundApprovalRepository {
  readonly #db: D1Database;
  constructor(db: D1Database) { this.#db = db; }

  async recordVerifiedProof(proof: VerifiedRefundHumanProof): Promise<VerifiedRefundHumanProof> {
    try {
      await this.#db.prepare(`INSERT INTO refund_human_proofs
        (id, account_id, nonce, method, verified_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(proof.proofId, proof.accountId, proof.nonce, proof.method, proof.verifiedAt, proof.expiresAt).run();
    } catch { throw new Error("Refund human proof replay"); }
    return structuredClone(proof);
  }

  async issueApproval(record: Omit<RefundApprovalRecord, "nonce" | "approvedAt">, now: Date): Promise<RefundApprovalRecord> {
    const proof = await this.#db.prepare(`SELECT id, account_id AS accountId, nonce, verified_at AS verifiedAt,
      expires_at AS expiresAt, consumed_by_approval_id AS consumedByApprovalId FROM refund_human_proofs WHERE id = ?`)
      .bind(record.proofId).first<Row>();
    if (!proof || text(proof.accountId) !== record.accountId || proof.consumedByApprovalId !== null || Date.parse(text(proof.expiresAt)) <= now.getTime()) {
      throw new Error("Fresh verified human proof is required");
    }
    if (Date.parse(record.expiresAt) > Date.parse(text(proof.expiresAt))) throw new Error("Refund approval cannot outlive its human proof");
    const issued: RefundApprovalRecord = Object.freeze({ ...record, nonce: text(proof.nonce), approvedAt: text(proof.verifiedAt) });
    try {
      await this.#db.batch([
        this.#db.prepare(`UPDATE refund_human_proofs SET consumed_by_approval_id = ?, consumed_at = ?
          WHERE id = ? AND consumed_by_approval_id IS NULL`).bind(record.approvalId, now.toISOString(), record.proofId),
        this.#db.prepare(`INSERT INTO refund_approval_records
          (id, account_id, campaign_id, refund_address, amount_minor, proof_id, nonce, approved_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(issued.approvalId, issued.accountId, issued.campaignId, issued.refundAddress, issued.amountMinor,
            issued.proofId, issued.nonce, issued.approvedAt, issued.expiresAt),
      ]);
    } catch { throw new Error("Refund human proof replay"); }
    return issued;
  }

  async consumeApproval(approvalId: string, input: { accountId: string; campaignId: string; refundId: string }, now: Date): Promise<RefundApprovalRecord> {
    const current = await this.getApproval(approvalId);
    if (!current || current.accountId !== input.accountId || current.campaignId !== input.campaignId || Date.parse(current.expiresAt) <= now.getTime()) {
      throw new Error("Fresh server-issued refund approval is required");
    }
    if (current.consumedByRefundId) {
      if (current.consumedByRefundId !== input.refundId) throw new Error("Refund approval replay");
      return current;
    }
    await this.#db.prepare(`UPDATE refund_approval_records SET consumed_by_refund_id = ?, consumed_at = ?
      WHERE id = ? AND consumed_by_refund_id IS NULL`).bind(input.refundId, now.toISOString(), approvalId).run();
    const consumed = await this.getApproval(approvalId);
    if (!consumed || consumed.consumedByRefundId !== input.refundId) throw new Error("Refund approval replay");
    return consumed;
  }

  private async getApproval(approvalId: string): Promise<RefundApprovalRecord | undefined> {
    const row = await this.#db.prepare(`SELECT id AS approvalId, account_id AS accountId, campaign_id AS campaignId,
      refund_address AS refundAddress, amount_minor AS amountMinor, proof_id AS proofId, nonce,
      approved_at AS approvedAt, expires_at AS expiresAt, consumed_by_refund_id AS consumedByRefundId, consumed_at AS consumedAt
      FROM refund_approval_records WHERE id = ?`).bind(approvalId).first<Row>();
    if (!row) return undefined;
    return { approvalId: text(row.approvalId), accountId: text(row.accountId), campaignId: text(row.campaignId),
      refundAddress: text(row.refundAddress), amountMinor: integer(row.amountMinor), proofId: text(row.proofId), nonce: text(row.nonce),
      approvedAt: text(row.approvedAt), expiresAt: text(row.expiresAt),
      ...(row.consumedByRefundId === null ? {} : { consumedByRefundId: text(row.consumedByRefundId) }),
      ...(row.consumedAt === null ? {} : { consumedAt: text(row.consumedAt) }) };
  }
}

function outboxStatement(db: D1Database, kind: "payout" | "refund", id: string, memo: string, status: string, payload: unknown) {
  const delivered = status === "paid";
  return db.prepare(`INSERT INTO outbox_events
    (id, idempotency_key, topic, payload_json, status, attempts, available_at, delivery_receipt_json, delivered_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(idempotency_key) DO UPDATE SET status = excluded.status,
      delivery_receipt_json = excluded.delivery_receipt_json, delivered_at = excluded.delivered_at`)
    .bind(`payment:${kind}:${id}`, `payment:${kind}:${memo}`, `payment.${kind}`, JSON.stringify(payload), delivered ? "delivered" : "pending",
      new Date().toISOString(), delivered ? JSON.stringify(payload) : null, delivered ? new Date().toISOString() : null);
}

function depositCommitment(row: Row): DepositCommitment {
  return { commitmentId: text(row.id), campaignId: text(row.campaignId), advertiserAccountId: text(row.advertiserAccountId),
    advertiserLedgerAccountId: text(row.advertiserLedgerAccountId), treasuryLedgerAccountId: text(row.treasuryLedgerAccountId),
    amountMinor: integer(row.amountMinor), memo: text(row.memo), ...(row.expectedSender === null ? {} : { expectedSender: text(row.expectedSender) }) };
}
function depositRecord(row: Row): DepositRecord {
  const eventKey = `${text(row.chainId)}:${text(row.transactionHash).toLowerCase()}:${integer(row.logIndex)}`;
  return { depositId: text(row.depositId), ...(row.commitmentId === null ? {} : { commitmentId: text(row.commitmentId) }),
    ...(row.campaignId === null ? {} : { campaignId: text(row.campaignId) }),
    ...(row.advertiserAccountId === null ? {} : { advertiserAccountId: text(row.advertiserAccountId) }),
    eventKey, memo: text(row.memo), amountMinor: integer(row.amountMinor), tokenAddress: text(row.tokenAddress),
    status: text(row.status) as DepositRecord["status"], ...(row.reason === null ? {} : { reason: text(row.reason) }),
    transactionHash: text(row.transactionHash), logIndex: integer(row.logIndex), policyVersion: text(row.policyVersion) };
}
function payoutRecord(row: Row): PayoutRecord {
  return { payoutId: text(row.payoutId), receiverHumanId: text(row.receiverHumanId), receiverLedgerAccountId: text(row.receiverLedgerAccountId),
    treasuryLedgerAccountId: text(row.treasuryLedgerAccountId), destination: text(row.destination), destinationId: text(row.destinationId),
    amountMinor: integer(row.amountMinor), memo: text(row.memo), status: text(row.status) as PayoutRecord["status"], policyVersion: text(row.policyVersion),
    queuedAt: text(row.queuedAt), ...(row.transactionHash === null ? {} : { transactionHash: text(row.transactionHash) }),
    ...(row.failureReason === null ? {} : { failureReason: text(row.failureReason) }) };
}
function splitEventKey(eventKey: string): [string, string, number] {
  const last = eventKey.lastIndexOf(":"); const first = eventKey.indexOf(":");
  if (first < 1 || last <= first) throw new Error("Payment event key is malformed");
  return [eventKey.slice(0, first), eventKey.slice(first + 1, last), Number(eventKey.slice(last + 1))];
}
function ledgerOwner(accountId: string): { kind: string; id: string } {
  const [prefix, ...rest] = accountId.split(":");
  if (["advertiser", "receiver", "operator", "treasury", "clearing", "hold"].includes(prefix)) return { kind: prefix, id: rest.join(":") || accountId };
  return { kind: "clearing", id: accountId };
}
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Durable payment row is malformed"); return value; }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Durable payment row is malformed"); return value; }
