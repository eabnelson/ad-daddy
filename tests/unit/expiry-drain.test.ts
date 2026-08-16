import assert from "node:assert/strict";
import test from "node:test";

import { drainExpiryBatches } from "../../lib/marketplace/expiry-drain.ts";

const NOW = new Date("2026-08-15T20:00:00.000Z");

test("scheduled expiry follows hasMore across bounded ordered pages", async () => {
  const pages = [
    { processed: 3, hasMore: true },
    { processed: 2, hasMore: true },
    { processed: 1, hasMore: false },
  ];
  const batchSizes: number[] = [];
  const result = await drainExpiryBatches({
    async expire(now, input) {
      assert.equal(now, NOW);
      batchSizes.push(input.batchSize);
      return pages.shift()!;
    },
  }, NOW, { batchSize: 25, maxBatches: 4 });

  assert.deepEqual(result, { processed: 6, batches: 3, hasMore: false });
  assert.deepEqual(batchSizes, [25, 25, 25]);
});

test("scheduled expiry leaves a reported backlog after its per-run bound", async () => {
  let calls = 0;
  const result = await drainExpiryBatches({
    async expire() { calls += 1; return { processed: 100, hasMore: true }; },
  }, NOW, { batchSize: 100, maxBatches: 3 });

  assert.deepEqual(result, { processed: 300, batches: 3, hasMore: true });
  assert.equal(calls, 3);
});

test("scheduled expiry stops a no-progress backlog instead of spinning", async () => {
  let calls = 0;
  const result = await drainExpiryBatches({
    async expire() { calls += 1; return { processed: 0, hasMore: true }; },
  }, NOW, { maxBatches: 5 });

  assert.deepEqual(result, { processed: 0, batches: 1, hasMore: true });
  assert.equal(calls, 1);
});
