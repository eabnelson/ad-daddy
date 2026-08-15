import { verify } from "node:crypto";

export type PlacementValidationCode =
  | "INVALID_PAYLOAD"
  | "INVALID_SIGNATURE"
  | "NOT_YET_VALID"
  | "EXPIRED";

export const PLACEMENT_ATTACHMENT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "text/html",
  "application/pdf",
] as const;

export type PlacementAttachmentMediaType =
  (typeof PLACEMENT_ATTACHMENT_MEDIA_TYPES)[number];

const PLACEMENT_ATTACHMENT_MEDIA_TYPE_SET = new Set<string>(
  PLACEMENT_ATTACHMENT_MEDIA_TYPES,
);

export interface PlacementPayload {
  protocolVersion: 1;
  placementId: string;
  advertiser: {
    id: string;
    displayName: string;
  };
  title: string;
  contentReference: string;
  disclosure: "Sponsored";
  payout: {
    amountMinor: number;
    currency: "USD";
  };
  signalsUsed: string[];
  creative: {
    body: string;
    attachments: Array<{
      title: string;
      url: string;
      mediaType: PlacementAttachmentMediaType;
    }>;
  };
  issuedAt: string;
  expiresAt: string;
}

export interface SignedPlacement {
  algorithm: "Ed25519";
  keyId: string;
  payload: PlacementPayload;
  signature: string;
}

export class PlacementValidationError extends Error {
  constructor(
    readonly code: PlacementValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "PlacementValidationError";
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new PlacementValidationError(
        "INVALID_PAYLOAD",
        "Placement contains a value that cannot be signed.",
      );
    }
    return encoded;
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function validateSignedPlacement(
  placement: SignedPlacement,
  publicKeyPem: string,
  now = new Date(),
): PlacementPayload {
  validatePayloadShape(placement);

  const isAuthentic = verify(
    null,
    Buffer.from(canonicalJson(placement.payload)),
    publicKeyPem,
    Buffer.from(placement.signature, "base64url"),
  );

  if (!isAuthentic) {
    throw new PlacementValidationError(
      "INVALID_SIGNATURE",
      "Placement signature is invalid.",
    );
  }

  const issuedAt = Date.parse(placement.payload.issuedAt);
  const expiresAt = Date.parse(placement.payload.expiresAt);

  if (issuedAt > now.getTime()) {
    throw new PlacementValidationError(
      "NOT_YET_VALID",
      "Placement was issued in the future.",
    );
  }

  if (expiresAt <= now.getTime()) {
    throw new PlacementValidationError("EXPIRED", "Placement has expired.");
  }

  return placement.payload;
}

function validatePayloadShape(placement: SignedPlacement): void {
  const payload = placement?.payload;
  const contentReference = safeUrl(payload?.contentReference);
  const attachments = payload?.creative?.attachments;
  const issuedAt = Date.parse(payload?.issuedAt);
  const expiresAt = Date.parse(payload?.expiresAt);

  const valid =
    placement?.algorithm === "Ed25519" &&
    bounded(placement.keyId, 1, 128) &&
    bounded(placement.signature, 32, 256) &&
    payload?.protocolVersion === 1 &&
    bounded(payload.placementId, 1, 128) &&
    bounded(payload.advertiser?.id, 1, 128) &&
    bounded(payload.advertiser?.displayName, 1, 80) &&
    bounded(payload.title, 1, 120) &&
    contentReference?.protocol === "https:" &&
    payload.disclosure === "Sponsored" &&
    Number.isSafeInteger(payload.payout?.amountMinor) &&
    payload.payout.amountMinor >= 0 &&
    payload.payout.currency === "USD" &&
    Array.isArray(payload.signalsUsed) &&
    payload.signalsUsed.length <= 20 &&
    payload.signalsUsed.every((signal) => bounded(signal, 1, 80)) &&
    bounded(payload.creative?.body, 1, 4_000) &&
    Array.isArray(attachments) &&
    attachments.length <= 5 &&
    attachments.every((attachment) => {
      const url = safeUrl(attachment?.url);
      return (
        bounded(attachment?.title, 1, 120) &&
        url?.protocol === "https:" &&
        PLACEMENT_ATTACHMENT_MEDIA_TYPE_SET.has(attachment?.mediaType)
      );
    }) &&
    Number.isFinite(issuedAt) &&
    Number.isFinite(expiresAt) &&
    issuedAt < expiresAt;

  if (!valid) {
    throw new PlacementValidationError(
      "INVALID_PAYLOAD",
      "Placement payload does not match the bounded v1 contract.",
    );
  }
}

function bounded(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimumLength &&
    value.length <= maximumLength
  );
}

function safeUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2_048) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}
