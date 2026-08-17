import type { LocalStore } from "../local-store.js";
import { evaluateCheckPolicy } from "../scheduler.js";

type SkippedCheck = { status: "skipped"; reason: "not_active" | "quiet_hours" | "cadence" | "frequency_cap" };
type CheckedResponse<Response> = { status: "checked"; response: Response };
type CheckInput<Response> = {
  installationId: string;
  store: LocalStore;
  poll: (publishedFields: object, now: Date) => Promise<Response>;
  placementsToday?: number;
  now?: Date;
  deliveryNow?: Date;
};

export function runManualCheck<Response, Delivery>(input: CheckInput<Response> & {
  delivery: { deliver(response: Response, now?: Date): Promise<Delivery> };
}): Promise<SkippedCheck | (CheckedResponse<Response> & { delivery: Delivery })>;
export function runManualCheck<Response>(input: CheckInput<Response> & { delivery?: undefined }): Promise<SkippedCheck | CheckedResponse<Response>>;
export function runManualCheck<Response, Delivery>(input: CheckInput<Response> & {
  delivery?: { deliver(response: Response, now?: Date): Promise<Delivery> };
}): Promise<SkippedCheck | (CheckedResponse<Response> & { delivery?: Delivery })>;
export async function runManualCheck<Response, Delivery>(input: CheckInput<Response> & {
  delivery?: { deliver(response: Response, now?: Date): Promise<Delivery> };
}): Promise<SkippedCheck | (CheckedResponse<Response> & { delivery?: Delivery })> {
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
  if (!decision.allowed) {
    if (!decision.reason) throw new Error("A denied check policy must include a reason");
    return { status: "skipped", reason: decision.reason } as const;
  }
  const response = await input.poll(config.publishedFields, now);
  // A marketplace response is necessarily issued after the pre-request policy
  // clock. Reusing `now` can reject a freshly signed placement as future-dated.
  const deliveryNow = input.deliveryNow ?? (input.now ? input.now : new Date());
  const delivery = input.delivery
    ? await input.delivery.deliver(response, deliveryNow)
    : undefined;
  await input.store.markCheckedIfCurrent(config.installationId, config.consentVersion, now.toISOString());
  return {
    status: "checked",
    response,
    ...(delivery === undefined ? {} : { delivery }),
  } as const;
}
