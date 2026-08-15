export interface RequestLimits {
  maxBytes: number;
  maxCollectionItems: number;
  maxDepth?: number;
  maxStringLength?: number;
}

export class RequestLimitError extends Error {
  readonly status = 413;
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "RequestLimitError"; this.code = code; }
}

export const CAMPAIGN_REQUEST_LIMITS = Object.freeze({ maxBytes: 32_768, maxCollectionItems: 50, maxDepth: 8, maxStringLength: 8_192 });
export const OPPORTUNITY_REQUEST_LIMITS = Object.freeze({ maxBytes: 8_192, maxCollectionItems: 100, maxDepth: 6, maxStringLength: 1_024 });
export const AUCTION_REQUEST_LIMITS = Object.freeze({ maxBytes: 16_384, maxCollectionItems: 50, maxDepth: 6, maxStringLength: 2_048 });

export async function parseBoundedJson(request: Request, limits: RequestLimits): Promise<unknown> {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) throw new Error("maxBytes must be positive");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limits.maxBytes)) throw new RequestLimitError("BODY_TOO_LARGE", `Request body may not exceed ${limits.maxBytes} bytes`);
  const bytes = await readBoundedBody(request, limits.maxBytes);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new RequestLimitError("INVALID_JSON", "Request body must be valid UTF-8 JSON"); }
  inspect(value, limits, 0);
  return value;
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body exceeds configured limit");
        throw new RequestLimitError("BODY_TOO_LARGE", `Request body may not exceed ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function inspect(value: unknown, limits: RequestLimits, depth: number): void {
  if (depth > (limits.maxDepth ?? 8)) throw new RequestLimitError("BODY_TOO_DEEP", "Request body nesting is too deep");
  if (typeof value === "string" && value.length > (limits.maxStringLength ?? 8_192)) throw new RequestLimitError("STRING_TOO_LONG", "Request string is too long");
  if (Array.isArray(value)) {
    if (value.length > limits.maxCollectionItems) throw new RequestLimitError("COLLECTION_TOO_LARGE", `Request collection may contain at most ${limits.maxCollectionItems} items`);
    for (const item of value) inspect(item, limits, depth + 1);
  } else if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > limits.maxCollectionItems) throw new RequestLimitError("COLLECTION_TOO_LARGE", `Request collection may contain at most ${limits.maxCollectionItems} items`);
    for (const [key, item] of entries) {
      if (key.length > 128) throw new RequestLimitError("KEY_TOO_LONG", "Request key is too long");
      inspect(item, limits, depth + 1);
    }
  }
}
