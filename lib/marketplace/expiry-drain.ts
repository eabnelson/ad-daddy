export const EXPIRY_BATCH_SIZE = 100;
export const EXPIRY_MAX_BATCHES_PER_RUN = 5;

export interface ExpiryService {
  expire(now: Date, input: { batchSize: number }): Promise<{ processed: number; hasMore: boolean }>;
}

/** Drain several ordered pages without allowing one cron invocation to run forever. */
export async function drainExpiryBatches(
  service: ExpiryService,
  now: Date,
  input: { batchSize?: number; maxBatches?: number } = {},
): Promise<{ processed: number; batches: number; hasMore: boolean }> {
  const batchSize = input.batchSize ?? EXPIRY_BATCH_SIZE;
  const maxBatches = input.maxBatches ?? EXPIRY_MAX_BATCHES_PER_RUN;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000 ||
    !Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) {
    throw new Error("Expiry drain bounds are invalid");
  }
  let processed = 0;
  let batches = 0;
  let hasMore = false;
  while (batches < maxBatches) {
    const page = await service.expire(now, { batchSize });
    processed += page.processed;
    batches += 1;
    hasMore = page.hasMore;
    if (!hasMore) break;
    // A repository reporting a backlog without making progress would spin on
    // the same page. Leave it for the next cron and surface the backlog.
    if (page.processed === 0) break;
  }
  return { processed, batches, hasMore };
}
