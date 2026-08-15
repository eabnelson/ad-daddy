import { createHash } from "node:crypto";

export const TEMPO_MODERATO_CHAIN_ID = 42_431;
export const TEMPO_MODERATO_RPC_URL = "https://rpc.moderato.tempo.xyz";
export const TEMPO_MODERATO_ALPHA_USD = "0x20c0000000000000000000000000000000000001";

export type TempoTransferStatus = "finalized" | "reorged";

export interface TempoTransferEvent {
  chainId: number;
  tokenAddress: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  from: string;
  to: string;
  amountMinor: number;
  memo: string;
  status: TempoTransferStatus;
}

export interface TempoTransferRequest {
  tokenAddress: string;
  to: string;
  amountMinor: number;
  memo: string;
  feeSponsored: boolean;
}

export interface TempoTransferReceipt extends TempoTransferRequest {
  chainId: number;
  transactionHash: string;
  status: "confirmed" | "failed";
  failureReason?: string;
}

export interface TempoClient {
  readonly chainId: number;
  sendTransfer(request: TempoTransferRequest): Promise<TempoTransferReceipt>;
}

export class SyntheticTempoClient implements TempoClient {
  readonly chainId: number;
  readonly #receipts = new Map<string, TempoTransferReceipt>();
  readonly #failures = new Set<string>();
  constructor(chainId = TEMPO_MODERATO_CHAIN_ID) { this.chainId = chainId; }
  failNextMemo(memo: string) { this.#failures.add(memo); }
  async sendTransfer(request: TempoTransferRequest): Promise<TempoTransferReceipt> {
    validateTransferRequest(request);
    const existing = this.#receipts.get(request.memo);
    if (existing) {
      if (fingerprintTransfer(existing) !== fingerprintTransfer(request)) throw new Error("Tempo memo idempotency collision");
      return existing;
    }
    if (this.#failures.delete(request.memo)) throw new Error("Synthetic Tempo transport failure");
    const receipt: TempoTransferReceipt = Object.freeze({
      ...request,
      chainId: this.chainId,
      transactionHash: `0x${createHash("sha256").update(`${this.chainId}:${request.memo}`).digest("hex")}`,
      status: "confirmed" as const,
    });
    this.#receipts.set(request.memo, receipt);
    return receipt;
  }
}

export function opaqueTempoMemo(namespace: string, recordId: string, salt: string): string {
  if (!namespace || !recordId || !salt) throw new Error("Opaque memo inputs are required");
  return `0x${createHash("sha256").update(`${namespace}\0${recordId}\0${salt}`).digest("hex")}`;
}

export function validateTempoMemo(memo: string): void {
  if (!/^0x[a-f0-9]{64}$/i.test(memo)) throw new Error("Tempo memo must be exactly 32 bytes");
}

export function validateTempoAddress(address: string): void {
  if (!/^0x[a-f0-9]{40}$/i.test(address)) throw new Error("Tempo address is invalid");
}

function validateTransferRequest(request: TempoTransferRequest): void {
  validateTempoAddress(request.tokenAddress);
  validateTempoAddress(request.to);
  validateTempoMemo(request.memo);
  if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor < 1) throw new Error("Tempo transfer amount must be positive");
}

function fingerprintTransfer(request: TempoTransferRequest): string {
  return JSON.stringify([request.tokenAddress.toLowerCase(), request.to.toLowerCase(), request.amountMinor, request.memo.toLowerCase(), request.feeSponsored]);
}
