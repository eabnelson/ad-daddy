import type { PlacementPayload } from "@ad-daddy/host-adapters";
import {
  AdvertiserContentPolicyError,
  assertSafeAdvertiserDisplayText,
  hasForbiddenAdvertiserPromptPattern,
} from "@ad-daddy/host-adapters/advertiser-content-policy";
import {
  buildCreativeContentSecurityPolicy,
  validateCreativeUrl,
  type CreativeUrlPolicy,
} from "./creative-url-policy.ts";

export type CreativePolicyCode =
  | "UNSAFE_IMPLEMENTATION_PROMPT"
  | "UNAPPROVED_PACKAGE"
  | "UNSAFE_CREATIVE"
  | "UNSUPPORTED_ATTACHMENT";

export class CreativePolicyError extends Error {
  readonly code: CreativePolicyCode;
  constructor(code: CreativePolicyCode, message: string) {
    super(message);
    this.code = code;
    this.name = "CreativePolicyError";
  }
}

export interface CreativeValidationPolicy extends CreativeUrlPolicy {
  approvedPackages: readonly string[];
  approvedPackageDomains: readonly string[];
}

export interface ValidatedCreative {
  payload: PlacementPayload;
  destinationUrl?: string;
  contentReference: string;
  attachmentUrls: readonly string[];
  contentSecurityPolicy: string;
}

export function validateCreative(
  payload: PlacementPayload,
  policy: CreativeValidationPolicy,
): ValidatedCreative {
  const contentReference = validateCreativeUrl(payload.contentReference, "creative", policy);
  const destination = payload.destinationUrl
    ? validateCreativeUrl(payload.destinationUrl, "destination", policy)
    : undefined;
  const attachmentUrls = payload.creative.attachments.map((attachment) => {
    validateAdvertiserDisplayText(attachment.title);
    if (!attachment.sizeBytes || !attachment.sha256) {
      throw new CreativePolicyError(
        "UNSUPPORTED_ATTACHMENT",
        "Attachments require a bounded size and SHA-256 integrity digest",
      );
    }
    return validateCreativeUrl(attachment.url, "creative", policy).toString();
  });
  validateAdvertiserDisplayText(payload.title);
  validateAdvertiserDisplayText(payload.creative.body);
  if (payload.creative.implementationPrompt) {
    validateImplementationPrompt(payload.creative.implementationPrompt, policy);
  }
  const destinationOrigins = destination ? [destination.origin] : [];
  return Object.freeze({
    payload,
    destinationUrl: destination?.toString(),
    contentReference: contentReference.toString(),
    attachmentUrls: Object.freeze(attachmentUrls),
    contentSecurityPolicy: buildCreativeContentSecurityPolicy({ destinationOrigins }),
  });
}

function validateAdvertiserDisplayText(value: string): void {
  try {
    assertSafeAdvertiserDisplayText(value);
  } catch (error) {
    if (error instanceof AdvertiserContentPolicyError) {
      throw new CreativePolicyError("UNSAFE_CREATIVE", error.message);
    }
    throw error;
  }
}

export function validateImplementationPrompt(
  prompt: string,
  policy: Pick<CreativeValidationPolicy, "approvedPackages" | "approvedPackageDomains">,
): void {
  if (hasForbiddenAdvertiserPromptPattern(prompt)) {
    throw new CreativePolicyError(
      "UNSAFE_IMPLEMENTATION_PROMPT",
      "Implementation prompt requests privileged or executable behavior",
    );
  }
  const packageMentions = [...prompt.matchAll(/(?:npm (?:install|i)|pnpm add|yarn add)\s+([@\w./-]+)/gi)]
    .map((match) => match[1]);
  for (const packageName of packageMentions) {
    if (!policy.approvedPackages.includes(packageName)) {
      throw new CreativePolicyError("UNAPPROVED_PACKAGE", `Package ${packageName} is not approved for display prompts`);
    }
  }
  const urls = [...prompt.matchAll(/https:\/\/[^\s)\]}>'"]+/gi)].map((match) => match[0]);
  for (const raw of urls) {
    const host = new URL(raw).hostname.toLowerCase();
    if (!policy.approvedPackageDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
      throw new CreativePolicyError("UNSAFE_IMPLEMENTATION_PROMPT", `Prompt URL ${host} is not approved`);
    }
  }
}

export type MeasurementTier = "session_created" | "session_open" | "creative_engagement";

export function measurementAvailability(input: {
  tier: MeasurementTier;
  signedEvidence?: { eventId: string; placementId: string; occurredAt: string };
}): { status: "verified"; evidence: NonNullable<typeof input.signedEvidence> } | { status: "unavailable" } {
  if (input.tier === "session_created" && input.signedEvidence) {
    return { status: "verified", evidence: input.signedEvidence };
  }
  if (input.signedEvidence) return { status: "verified", evidence: input.signedEvidence };
  return { status: "unavailable" };
}
