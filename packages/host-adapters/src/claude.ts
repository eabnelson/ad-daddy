import type { SignedPlacement } from "./contract.js";
import { deliverGenericPlacement, type GenericPlacementResult } from "./generic.js";

export const CLAUDE_NATIVE_SESSION_DELIVERY = Object.freeze({
  supported: false,
  reason: "No tested Claude host interface can create and verify a separate sidebar-visible session.",
});

export function deliverClaudePlacement(input: {
  placement: SignedPlacement;
  publicKeyPem: string;
  creativeUrl: string;
  now?: Date;
}): GenericPlacementResult {
  return deliverGenericPlacement(input);
}
