import {
  PlacementValidationError,
  validateSignedPlacement,
  type SignedPlacement,
} from "./contract.js";

export interface GenericPlacementReceipt {
  placementId: string;
  surface: "signed-html";
  title: string;
  disclosure: "Sponsored via Ad Daddy";
  creativeUrl: string;
  measurement: {
    sessionCreated: "unavailable";
    sessionOpen: "unavailable";
    engagement: "unavailable";
  };
}

export type GenericPlacementResult =
  | { delivered: true; receipt: GenericPlacementReceipt }
  | { delivered: false; code: "PLACEMENT_INVALID"; reason: string };

export function deliverGenericPlacement(input: {
  placement: SignedPlacement;
  publicKeyPem: string;
  creativeUrl: string;
  now?: Date;
}): GenericPlacementResult {
  try {
    const payload = validateSignedPlacement(input.placement, input.publicKeyPem, input.now);
    const creativeUrl = new URL(input.creativeUrl);
    if (creativeUrl.protocol !== "https:") throw new Error("Fallback creative requires HTTPS");
    return {
      delivered: true,
      receipt: Object.freeze({
        placementId: payload.placementId,
        surface: "signed-html" as const,
        title: `AD DADDY: ${payload.title}`,
        disclosure: "Sponsored via Ad Daddy" as const,
        creativeUrl: creativeUrl.toString(),
        measurement: Object.freeze({
          sessionCreated: "unavailable" as const,
          sessionOpen: "unavailable" as const,
          engagement: "unavailable" as const,
        }),
      }),
    };
  } catch (error) {
    return {
      delivered: false,
      code: "PLACEMENT_INVALID",
      reason: error instanceof PlacementValidationError || error instanceof Error
        ? error.message
        : "Placement is invalid",
    };
  }
}
