import assert from "node:assert/strict";
import test from "node:test";

import { parseBoundedJson, RequestLimitError } from "../../lib/http/request-limits.ts";
import { FixedWindowRateLimiter } from "../../lib/http/rate-limit.ts";

test("bounded JSON rejects declared and actual oversized bodies and collections", async () => {
  const oversized = new Request("https://example.test", { method: "POST", body: "x".repeat(101), headers: { "content-length": "101" } });
  await assert.rejects(parseBoundedJson(oversized, { maxBytes: 100, maxCollectionItems: 2 }), RequestLimitError);
  const collection = new Request("https://example.test", { method: "POST", body: JSON.stringify({ targets: [1, 2, 3] }) });
  await assert.rejects(parseBoundedJson(collection, { maxBytes: 100, maxCollectionItems: 2 }), /collection/i);
});

test("actor, campaign, and IP throttles return bounded retry guidance", () => {
  const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 60_000, maxRetryAfterSeconds: 60 });
  const first = limiter.check(["actor:1", "campaign:1", "ip:1"], new Date("2026-08-15T16:00:00.000Z"));
  const second = limiter.check(["actor:1", "campaign:1", "ip:1"], new Date("2026-08-15T16:00:01.000Z"));
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.retryAfterSeconds, 59);
});
