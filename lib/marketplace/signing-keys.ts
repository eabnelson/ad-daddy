import { sign } from "node:crypto";

import {
  canonicalJson,
  validateSignedPlacement,
  type PlacementPayload,
  type SignedPlacement,
} from "@ad-daddy/host-adapters/contract";
import {
  CredentialLifecycleService,
  type ManagedCredential,
} from "../auth/credential-lifecycle.ts";
import type { Environment } from "../domain/types.ts";

export const PLACEMENT_VERIFY_SCOPE = "placement:verify";

export class MarketplaceSigningKeys {
  readonly #credentials: CredentialLifecycleService;
  readonly #environment: Environment;
  constructor(
    credentials: CredentialLifecycleService,
    environment: Environment,
  ) {
    this.#credentials = credentials;
    this.#environment = environment;
  }

  verify(placement: SignedPlacement, now = new Date()): PlacementPayload {
    return this.verifyWithKey(placement, now).payload;
  }

  verifyWithKey(placement: SignedPlacement, now = new Date()): {
    payload: PlacementPayload;
    publicKeyPem: string;
  } {
    const key = this.#credentials.assertUsable(
      placement.keyId,
      this.#environment,
      PLACEMENT_VERIFY_SCOPE,
      now,
    );
    if (key.kind !== "marketplace_signing") {
      throw new Error("Placement key has the wrong credential kind");
    }
    return Object.freeze({
      payload: validateSignedPlacement(placement, key.publicMaterial, now),
      publicKeyPem: key.publicMaterial,
    });
  }
}

export function enrollMarketplacePublicKey(
  credentials: CredentialLifecycleService,
  input: {
    credentialId: string;
    keyId: string;
    publicKeyPem: string;
    environment: Environment;
    now?: Date;
  },
): ManagedCredential {
  return credentials.enroll({
    credentialId: input.credentialId,
    keyId: input.keyId,
    kind: "marketplace_signing",
    environment: input.environment,
    scopes: [PLACEMENT_VERIFY_SCOPE],
    publicMaterial: input.publicKeyPem,
    now: input.now,
  });
}

export function signPlacement(
  payload: PlacementPayload,
  input: { keyId: string; privateKeyPem: string },
): SignedPlacement {
  return Object.freeze({
    algorithm: "Ed25519" as const,
    keyId: input.keyId,
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload)),
      input.privateKeyPem,
    ).toString("base64url"),
  });
}
