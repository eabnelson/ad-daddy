import { createHmac, timingSafeEqual } from "node:crypto";

import type { TempoTransferEvent } from "../payments/tempo-client.ts";

export interface PaymentEventEnvelope {
  event: TempoTransferEvent;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
}

/**
 * Private capability shared only by the chain indexer and the application.
 * Public HTTP callers never receive this object or its secret.
 */
export class OperatorEventEnvelopeService {
  readonly #secret: string;
  readonly #consumedNonces = new Set<string>();

  constructor(secret: string) {
    if (secret.length < 32) throw new Error("Payment event capability secret must contain at least 32 characters");
    this.#secret = secret;
  }

  sign(event: TempoTransferEvent, input: { nonce: string; issuedAt: string; expiresAt: string }): PaymentEventEnvelope {
    const unsigned = { event: structuredClone(event), ...input };
    return { ...unsigned, signature: this.#signature(unsigned) };
  }

  verify(envelope: PaymentEventEnvelope, now = new Date()): TempoTransferEvent {
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("Payment event capability is required");
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(envelope.nonce)) throw new Error("Payment event capability nonce is invalid");
    const issuedAt = Date.parse(envelope.issuedAt);
    const expiresAt = Date.parse(envelope.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now.getTime() || expiresAt <= now.getTime() || expiresAt - issuedAt > 5 * 60_000) {
      throw new Error("Payment event capability is expired or malformed");
    }
    if (!/^[a-zA-Z0-9_-]{43}$/.test(envelope.signature)) throw new Error("Payment event capability signature is invalid");
    if (this.#consumedNonces.has(envelope.nonce)) throw new Error("Payment event capability has already been consumed");
    const expected = Buffer.from(this.#signature({ event: envelope.event, issuedAt: envelope.issuedAt, expiresAt: envelope.expiresAt, nonce: envelope.nonce }), "base64url");
    const actual = Buffer.from(envelope.signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Payment event capability signature is invalid");
    this.#consumedNonces.add(envelope.nonce);
    return structuredClone(envelope.event);
  }

  #signature(input: Omit<PaymentEventEnvelope, "signature">): string {
    return createHmac("sha256", this.#secret).update(canonicalPayload(input)).digest("base64url");
  }
}

function canonicalPayload(input: Omit<PaymentEventEnvelope, "signature">): string {
  const event = input.event;
  return JSON.stringify({
    event: {
      chainId: event.chainId,
      tokenAddress: event.tokenAddress,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      from: event.from,
      to: event.to,
      amountMinor: event.amountMinor,
      memo: event.memo,
      status: event.status,
    },
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
  });
}
