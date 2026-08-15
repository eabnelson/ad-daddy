import type { LocalStore } from "../local-store.js";
import { evaluateCheckPolicy } from "../scheduler.js";

export async function runManualCheck(input: {
  installationId: string;
  store: LocalStore;
  poll: (publishedFields: object) => Promise<unknown>;
  placementsToday?: number;
  now?: Date;
}) {
  const config = await input.store.get(input.installationId);
  if (!config) throw new Error("Unknown installation");
  if (config.status !== "active") return { status: "skipped", reason: "not_active" } as const;
  const now = input.now ?? new Date();
  const decision = evaluateCheckPolicy(
    {
      cadenceMinutes: config.cadenceMinutes,
      maxPerDay: config.publishedFields.adFrequency?.maxPerDay,
      quietHours: config.publishedFields.adFrequency?.quietHours,
    },
    {
      now,
      lastCheckedAt: config.lastCheckedAt,
      placementsToday: input.placementsToday,
    },
  );
  if (!decision.allowed) return { status: "skipped", reason: decision.reason } as const;
  const response = await input.poll(config.publishedFields);
  config.lastCheckedAt = now.toISOString();
  await input.store.put(config);
  return { status: "checked", response } as const;
}
