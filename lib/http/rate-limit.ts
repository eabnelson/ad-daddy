export interface RateLimitResult { allowed: boolean; retryAfterSeconds: number; }

export class FixedWindowRateLimiter {
  readonly #counts = new Map<string, { windowStart: number; count: number }>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxRetry: number;
  constructor(input: { limit: number; windowMs: number; maxRetryAfterSeconds: number }) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || !Number.isSafeInteger(input.windowMs) || input.windowMs < 1) throw new Error("Rate limit values must be positive integers");
    this.#limit = input.limit; this.#windowMs = input.windowMs; this.#maxRetry = input.maxRetryAfterSeconds;
  }
  check(keys: readonly string[], now = new Date()): RateLimitResult {
    const uniqueKeys = [...new Set(keys)];
    if (uniqueKeys.length === 0 || uniqueKeys.length > 8 || uniqueKeys.some((key) => !key || key.length > 256)) throw new Error("Rate limit keys are invalid");
    let retryAfterSeconds = 0;
    for (const key of uniqueKeys) {
      const bucket = this.#counts.get(key);
      if (bucket && now.getTime() - bucket.windowStart < this.#windowMs && bucket.count >= this.#limit) {
        retryAfterSeconds = Math.max(retryAfterSeconds, Math.ceil((bucket.windowStart + this.#windowMs - now.getTime()) / 1_000));
      }
    }
    if (retryAfterSeconds > 0) return { allowed: false, retryAfterSeconds: Math.min(this.#maxRetry, retryAfterSeconds) };
    for (const key of uniqueKeys) {
      const bucket = this.#counts.get(key);
      if (!bucket || now.getTime() - bucket.windowStart >= this.#windowMs) this.#counts.set(key, { windowStart: now.getTime(), count: 1 });
      else bucket.count += 1;
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
