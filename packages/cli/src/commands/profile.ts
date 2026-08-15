export type RewardType = "stablecoin" | "credits" | "discount";

export interface ReceiverFieldValues {
  coarseLocation?: string;
  projectNames?: readonly string[];
  publicRepositoryUrls?: readonly string[];
  privateRepoTechStacks?: readonly (readonly string[])[];
  projectDescriptions?: readonly string[];
  adFrequency?: Readonly<{ maxPerDay: number; quietHours?: Readonly<{ startHourLocal: number; endHourLocal: number }> }>;
  subscriptionTier?: string;
  tokenUsageRange?: string;
  totalSessionRange?: string;
  acceptedRewardTypes?: readonly RewardType[];
  minimumTakeHomeMinor?: number;
}

export type ReceiverFieldKey = keyof ReceiverFieldValues;
export type ReceiverFieldSelection = Partial<Record<ReceiverFieldKey, boolean>>;

const RECEIVER_FIELD_KEYS: readonly ReceiverFieldKey[] = [
  "coarseLocation", "projectNames", "publicRepositoryUrls", "privateRepoTechStacks",
  "projectDescriptions", "adFrequency", "subscriptionTier", "tokenUsageRange",
  "totalSessionRange", "acceptedRewardTypes", "minimumTakeHomeMinor",
];

export function buildPublishedProfile(input: {
  values: ReceiverFieldValues;
  enabled: ReceiverFieldSelection;
}): ReceiverFieldValues {
  assertKnownFields(input.values, "values");
  assertKnownFields(input.enabled, "enabled");
  const published: Partial<Record<ReceiverFieldKey, unknown>> = {};
  for (const key of RECEIVER_FIELD_KEYS) {
    if (input.enabled[key] === true && input.values[key] !== undefined) {
      validateField(key, input.values[key]);
      published[key] = structuredClone(input.values[key]);
    }
  }
  return published as ReceiverFieldValues;
}

const PACKAGE_TECHNOLOGIES: Readonly<Record<string, string>> = Object.freeze({
  react: "React",
  next: "Next.js",
  pg: "Postgres",
  postgres: "Postgres",
  typescript: "TypeScript",
  django: "Django",
  flask: "Flask",
  rails: "Rails",
  redis: "Redis",
  prisma: "Prisma",
  drizzle: "Drizzle",
  convex: "Convex",
});
const ALLOWED_TECHNOLOGIES = new Set(Object.values(PACKAGE_TECHNOLOGIES));

function assertKnownFields(input: object, path: string): void {
  for (const key of Object.keys(input)) {
    if (!(RECEIVER_FIELD_KEYS as readonly string[]).includes(key)) throw new Error(`${path}.${key} is not an allowed receiver field`);
  }
}

function stringValue(input: unknown, path: string, maximum: number): string {
  if (typeof input !== "string" || !input.trim() || input.length > maximum) throw new Error(`${path} must be a non-empty string no longer than ${maximum} characters`);
  return input;
}

function stringList(input: unknown, path: string, maximumLength: number): readonly string[] {
  if (!Array.isArray(input) || input.length > 20) throw new Error(`${path} must contain at most 20 values`);
  return input.map((value, index) => stringValue(value, `${path}[${index}]`, maximumLength));
}

function validateField(key: ReceiverFieldKey, value: unknown): void {
  if (key === "coarseLocation" || key === "subscriptionTier" || key === "tokenUsageRange" || key === "totalSessionRange") {
    stringValue(value, key, 64);
  } else if (key === "projectNames") {
    stringList(value, key, 80);
  } else if (key === "projectDescriptions") {
    stringList(value, key, 280);
  } else if (key === "publicRepositoryUrls") {
    for (const [index, repository] of stringList(value, key, 256).entries()) {
      const url = URL.parse(repository);
      if (!url || url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) throw new Error(`${key}[${index}] must be a public HTTPS github.com URL`);
    }
  } else if (key === "privateRepoTechStacks") {
    if (!Array.isArray(value) || value.length > 20) throw new Error(`${key} must contain at most 20 stacks`);
    for (const [index, stack] of value.entries()) {
      for (const technology of stringList(stack, `${key}[${index}]`, 64)) {
        if (!ALLOWED_TECHNOLOGIES.has(technology)) throw new Error(`${technology} is not an allowlisted local technology label`);
      }
    }
  } else if (key === "adFrequency") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("adFrequency must be an object");
    const frequency = value as { maxPerDay?: unknown; quietHours?: unknown };
    if (!Number.isSafeInteger(frequency.maxPerDay) || (frequency.maxPerDay as number) < 1 || (frequency.maxPerDay as number) > 24) throw new Error("adFrequency.maxPerDay must be 1-24");
    if (frequency.quietHours !== undefined) {
      const quiet = frequency.quietHours as { startHourLocal?: unknown; endHourLocal?: unknown };
      if (!quiet || typeof quiet !== "object" || !Number.isSafeInteger(quiet.startHourLocal) || !Number.isSafeInteger(quiet.endHourLocal) || (quiet.startHourLocal as number) < 0 || (quiet.startHourLocal as number) > 23 || (quiet.endHourLocal as number) < 0 || (quiet.endHourLocal as number) > 23) throw new Error("quiet hours must use local hours 0-23");
    }
  } else if (key === "acceptedRewardTypes") {
    const rewards = stringList(value, key, 32);
    if (new Set(rewards).size !== rewards.length || rewards.some((reward) => !["stablecoin", "credits", "discount"].includes(reward))) throw new Error("acceptedRewardTypes contains an unsupported or duplicate reward");
  } else if (key === "minimumTakeHomeMinor") {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("minimumTakeHomeMinor must be a non-negative safe integer");
  }
}

/** Derives only allowlisted technology labels. Repository metadata is deliberately ignored. */
export function derivePrivateRepositoryStack(input: {
  repositoryPath: string;
  remote?: string;
  manifests: Readonly<Record<string, string>>;
}): string[] {
  const detected = new Set<string>();
  for (const [manifest, contents] of Object.entries(input.manifests)) {
    const base = manifest.split(/[\\/]/).at(-1)?.toLowerCase();
    if (base === "package.json") {
      detected.add("TypeScript");
      try {
        const parsed = JSON.parse(contents) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
        for (const dependency of [...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})]) {
          const technology = PACKAGE_TECHNOLOGIES[dependency.toLowerCase()];
          if (technology) detected.add(technology);
        }
      } catch {
        // An unreadable manifest yields no dependency labels.
      }
    } else if (base === "requirements.txt" || base === "pyproject.toml") {
      for (const [needle, technology] of Object.entries(PACKAGE_TECHNOLOGIES)) {
        if (new RegExp(`(^|[^a-z])${needle}([^a-z]|$)`, "i").test(contents)) detected.add(technology);
      }
    } else if (base === "gemfile" && /\brails\b/i.test(contents)) {
      detected.add("Rails");
    }
  }
  return [...detected].sort();
}

function dollars(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

export function previewReceiverEconomics(input: {
  acceptedRewardTypes: readonly RewardType[];
  minimumTakeHomeMinor?: number;
}) {
  const labels: Record<RewardType, string> = {
    stablecoin: "Stablecoin (cash)",
    credits: "Product credits",
    discount: "Discounts",
  };
  const minimum = input.minimumTakeHomeMinor ?? 0;
  return {
    accepted: input.acceptedRewardTypes.map((type) => labels[type]),
    minimumCashTakeHome: dollars(minimum),
    minimumGrossBidAtLaunchSplit: dollars(Math.ceil(minimum / 0.8)),
    explanation: `Credits and discounts are bonuses and never replace the ${dollars(minimum)} cash minimum.`,
  };
}
