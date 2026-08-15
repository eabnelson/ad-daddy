import type {
  ConsentStatus,
  ConsentVersion,
  Money,
  ReceiverProfileFields,
  ReceiverProfileSnapshot,
  RewardType,
} from "./types.ts";

const PROFILE_FIELD_KEYS = new Set<keyof ReceiverProfileFields>([
  "coarseLocation",
  "projectNames",
  "publicRepositoryUrls",
  "privateRepoTechStacks",
  "projectDescriptions",
  "adFrequency",
  "subscriptionTier",
  "tokenUsageRange",
  "totalSessionRange",
  "acceptedRewardTypes",
  "minimumTakeHomeMinor",
  "directlyIdentifyingPreBidExposure",
]);
const REWARD_TYPES = new Set<RewardType>(["stablecoin", "credits", "discount"]);
const CONSENT_STATUSES = new Set<ConsentStatus>(["active", "paused", "revoked"]);
const SAFE_TECH_NAME = /^[A-Za-z0-9][A-Za-z0-9 .+#_-]{0,63}$/;
const SAFE_BUCKET = /^[A-Za-z0-9][A-Za-z0-9 ._+/-]{0,63}$/;
const SNAPSHOT_KEYS = new Set([
  "profileId",
  "accountId",
  "installationId",
  "consentVersion",
  "publishedAt",
  "expiresAt",
  "fields",
]);

export class DomainValidationError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(
    code: string,
    path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "DomainValidationError";
    this.code = code;
    this.path = path;
  }
}

function record(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DomainValidationError("INVALID_TYPE", path, "must be an object");
  }
  return input as Record<string, unknown>;
}

function string(input: unknown, path: string, maxLength = 256): string {
  if (typeof input !== "string" || input.length === 0 || input.length > maxLength) {
    throw new DomainValidationError("INVALID_STRING", path, `must be 1-${maxLength} characters`);
  }
  return input;
}

function safeInteger(input: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(input) || (input as number) < minimum || (input as number) > maximum) {
    throw new DomainValidationError("INVALID_INTEGER", path, `must be a safe integer between ${minimum} and ${maximum}`);
  }
  return input as number;
}

function isoDate(input: unknown, path: string): string {
  const value = string(input, path, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new DomainValidationError("INVALID_DATE", path, "must be an ISO-8601 UTC timestamp");
  }
  return value;
}

function stringArray(input: unknown, path: string, itemMax = 160, maxItems = 20): string[] {
  if (!Array.isArray(input) || input.length > maxItems) {
    throw new DomainValidationError("INVALID_ARRAY", path, `must contain at most ${maxItems} items`);
  }
  return input.map((item, index) => string(item, `${path}[${index}]`, itemMax));
}

function validateFields(input: unknown): ReceiverProfileFields {
  const source = record(input, "fields");
  for (const key of Object.keys(source)) {
    if (!PROFILE_FIELD_KEYS.has(key as keyof ReceiverProfileFields)) {
      throw new DomainValidationError("FIELD_NOT_ALLOWED", `fields.${key}`, "is not publishable targeting data");
    }
  }

  const fields: ReceiverProfileFields = {};
  if (source.coarseLocation !== undefined) {
    const value = string(source.coarseLocation, "fields.coarseLocation", 64);
    if (!SAFE_BUCKET.test(value)) throw new DomainValidationError("INVALID_BUCKET", "fields.coarseLocation", "must be coarse and bucketed");
    fields.coarseLocation = value;
  }
  if (source.projectNames !== undefined) fields.projectNames = stringArray(source.projectNames, "fields.projectNames", 80, 20);
  if (source.publicRepositoryUrls !== undefined) {
    const urls = stringArray(source.publicRepositoryUrls, "fields.publicRepositoryUrls", 256, 20);
    for (const [index, value] of urls.entries()) {
      const url = URL.parse(value);
      if (!url) throw new DomainValidationError("INVALID_URL", `fields.publicRepositoryUrls[${index}]`, "must be a URL");
      if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) {
        throw new DomainValidationError("INVALID_URL", `fields.publicRepositoryUrls[${index}]`, "must be a public HTTPS github.com URL");
      }
    }
    fields.publicRepositoryUrls = urls;
  }
  if (source.privateRepoTechStacks !== undefined) {
    if (!Array.isArray(source.privateRepoTechStacks) || source.privateRepoTechStacks.length > 20) {
      throw new DomainValidationError("INVALID_ARRAY", "fields.privateRepoTechStacks", "must contain at most 20 stacks");
    }
    fields.privateRepoTechStacks = source.privateRepoTechStacks.map((stack, stackIndex) => {
      const technologies = stringArray(stack, `fields.privateRepoTechStacks[${stackIndex}]`, 64, 20);
      for (const [techIndex, technology] of technologies.entries()) {
        if (!SAFE_TECH_NAME.test(technology) || technology.includes("/") || technology.includes("\\")) {
          throw new DomainValidationError(
            "PRIVATE_PATH_NOT_ALLOWED",
            `fields.privateRepoTechStacks[${stackIndex}][${techIndex}]`,
            "must be a technology name, not a repository name or path",
          );
        }
      }
      return technologies;
    });
  }
  if (source.projectDescriptions !== undefined) fields.projectDescriptions = stringArray(source.projectDescriptions, "fields.projectDescriptions", 280, 20);
  if (source.subscriptionTier !== undefined) fields.subscriptionTier = string(source.subscriptionTier, "fields.subscriptionTier", 64);
  if (source.tokenUsageRange !== undefined) fields.tokenUsageRange = string(source.tokenUsageRange, "fields.tokenUsageRange", 64);
  if (source.totalSessionRange !== undefined) fields.totalSessionRange = string(source.totalSessionRange, "fields.totalSessionRange", 64);
  if (source.minimumTakeHomeMinor !== undefined) fields.minimumTakeHomeMinor = safeInteger(source.minimumTakeHomeMinor, "fields.minimumTakeHomeMinor", 0, 1_000_000_000_000);
  if (source.acceptedRewardTypes !== undefined) {
    const values = stringArray(source.acceptedRewardTypes, "fields.acceptedRewardTypes", 32, 3) as RewardType[];
    if (new Set(values).size !== values.length || values.some((value) => !REWARD_TYPES.has(value))) {
      throw new DomainValidationError("INVALID_REWARD_TYPE", "fields.acceptedRewardTypes", "contains an unsupported or duplicate reward type");
    }
    fields.acceptedRewardTypes = values;
  }
  if (source.adFrequency !== undefined) {
    const frequency = record(source.adFrequency, "fields.adFrequency");
    for (const key of Object.keys(frequency)) {
      if (key !== "maxPerDay" && key !== "quietHours") throw new DomainValidationError("FIELD_NOT_ALLOWED", `fields.adFrequency.${key}`, "is not allowed");
    }
    fields.adFrequency = { maxPerDay: safeInteger(frequency.maxPerDay, "fields.adFrequency.maxPerDay", 1, 24) };
    if (frequency.quietHours !== undefined) {
      const quiet = record(frequency.quietHours, "fields.adFrequency.quietHours");
      for (const key of Object.keys(quiet)) {
        if (key !== "startHourLocal" && key !== "endHourLocal") {
          throw new DomainValidationError("FIELD_NOT_ALLOWED", `fields.adFrequency.quietHours.${key}`, "is not allowed");
        }
      }
      fields.adFrequency.quietHours = {
        startHourLocal: safeInteger(quiet.startHourLocal, "fields.adFrequency.quietHours.startHourLocal", 0, 23),
        endHourLocal: safeInteger(quiet.endHourLocal, "fields.adFrequency.quietHours.endHourLocal", 0, 23),
      };
    }
  }
  if (source.directlyIdentifyingPreBidExposure !== undefined) {
    const exposure = record(source.directlyIdentifyingPreBidExposure, "fields.directlyIdentifyingPreBidExposure");
    for (const key of Object.keys(exposure)) {
      if (key !== "projectNames" && key !== "publicRepositoryUrls") {
        throw new DomainValidationError("FIELD_NOT_ALLOWED", `fields.directlyIdentifyingPreBidExposure.${key}`, "is not allowed");
      }
    }
    if (typeof exposure.projectNames !== "boolean" || typeof exposure.publicRepositoryUrls !== "boolean") {
      throw new DomainValidationError("INVALID_TYPE", "fields.directlyIdentifyingPreBidExposure", "must contain explicit boolean choices");
    }
    fields.directlyIdentifyingPreBidExposure = {
      projectNames: exposure.projectNames,
      publicRepositoryUrls: exposure.publicRepositoryUrls,
    };
  }
  return fields;
}

export function validateReceiverProfileSnapshot(input: unknown, now = new Date()): ReceiverProfileSnapshot {
  const source = record(input, "snapshot");
  for (const key of Object.keys(source)) {
    if (!SNAPSHOT_KEYS.has(key)) throw new DomainValidationError("FIELD_NOT_ALLOWED", key, "is not part of a profile snapshot");
  }
  const publishedAt = isoDate(source.publishedAt, "publishedAt");
  const expiresAt = isoDate(source.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= now.getTime() || Date.parse(expiresAt) <= Date.parse(publishedAt)) {
    throw new DomainValidationError("EXPIRED_SNAPSHOT", "expiresAt", "must be after publication and in the future");
  }
  return Object.freeze({
    profileId: string(source.profileId, "profileId", 128),
    accountId: string(source.accountId, "accountId", 128),
    installationId: string(source.installationId, "installationId", 128),
    consentVersion: safeInteger(source.consentVersion, "consentVersion", 1),
    publishedAt,
    expiresAt,
    fields: Object.freeze(validateFields(source.fields)),
  });
}

export function createConsentVersion(input: {
  receiverId: string;
  previousVersion: number | null;
  acceptedAt: string;
  termsVersion: string;
  privacyVersion: string;
  status: ConsentStatus;
}): ConsentVersion {
  const previousVersion = input.previousVersion === null ? null : safeInteger(input.previousVersion, "previousVersion", 1);
  if (!CONSENT_STATUSES.has(input.status)) throw new DomainValidationError("INVALID_CONSENT_STATUS", "status", "is invalid");
  return Object.freeze({
    receiverId: string(input.receiverId, "receiverId", 128),
    version: previousVersion === null ? 1 : previousVersion + 1,
    previousVersion,
    acceptedAt: isoDate(input.acceptedAt, "acceptedAt"),
    termsVersion: string(input.termsVersion, "termsVersion", 128),
    privacyVersion: string(input.privacyVersion, "privacyVersion", 128),
    status: input.status,
  });
}

export function validateMoney(input: unknown, path = "money"): Money {
  const source = record(input, path);
  const currency = string(source.currency, `${path}.currency`, 12);
  if (!/^[A-Z][A-Z0-9]{2,11}$/.test(currency)) throw new DomainValidationError("INVALID_CURRENCY", `${path}.currency`, "must be an uppercase asset code");
  return { amountMinor: safeInteger(source.amountMinor, `${path}.amountMinor`), currency };
}
