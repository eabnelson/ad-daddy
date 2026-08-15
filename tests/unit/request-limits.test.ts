import assert from "node:assert/strict";
import test from "node:test";

import { parseBoundedForm, parseBoundedJson, RequestLimitError } from "../../lib/http/request-limits.ts";
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

test("chunked bodies stop at the byte limit and expired rate buckets are evicted", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(60)));
      controller.enqueue(new TextEncoder().encode("x".repeat(60)));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(parseBoundedJson(new Request("https://example.test", { method: "POST", body, duplex: "half" } as RequestInit), { maxBytes: 100, maxCollectionItems: 2 }), RequestLimitError);
  assert.equal(cancelled, true);

  const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1, maxRetryAfterSeconds: 1 });
  for (let index = 0; index < 255; index += 1) limiter.check([`expired:${index}`], new Date(0));
  assert.equal(limiter.trackedBucketCount, 255);
  limiter.check(["current"], new Date(2));
  assert.equal(limiter.trackedBucketCount, 1);
});

test("bounded forms accept one small action and reject duplicate or oversized fields", async () => {
  const parsed = await parseBoundedForm(new Request("https://example.test", {
    method: "POST", body: "action=report", headers: { "content-type": "application/x-www-form-urlencoded" },
  }), { maxBytes: 32, maxCollectionItems: 2, maxStringLength: 16 });
  assert.deepEqual(parsed, { action: "report" });
  await assert.rejects(parseBoundedForm(new Request("https://example.test", {
    method: "POST", body: "action=hide&action=report",
  }), { maxBytes: 64, maxCollectionItems: 2, maxStringLength: 16 }), /unique/);
});
