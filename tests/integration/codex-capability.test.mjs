import assert from "node:assert/strict";
import test from "node:test";

import {
  PlacementValidationError,
  validateSignedPlacement,
} from "../../packages/host-adapters/dist/contract.js";
import {
  assessCodexCapability,
} from "../../packages/host-adapters/dist/codex-capability.js";
import {
  SIGNED_PLACEMENT_FIXTURE,
  TEST_MARKETPLACE_PUBLIC_KEY_PEM,
} from "../../packages/host-adapters/dist/fixtures/signed-placement.js";

test("accepts the valid signed inert placement fixture", () => {
  const placement = validateSignedPlacement(
    SIGNED_PLACEMENT_FIXTURE,
    TEST_MARKETPLACE_PUBLIC_KEY_PEM,
    new Date("2026-08-15T15:30:00.000Z"),
  );

  assert.equal(placement.placementId, "spike-20260815-neon-001");
  assert.equal(placement.disclosure, "Sponsored");
});

test("rejects a placement whose signed payload was modified", () => {
  const tampered = structuredClone(SIGNED_PLACEMENT_FIXTURE);
  tampered.payload.payout.amountMinor = 50_000;

  assert.throws(
    () =>
      validateSignedPlacement(
        tampered,
        TEST_MARKETPLACE_PUBLIC_KEY_PEM,
        new Date("2026-08-15T15:30:00.000Z"),
      ),
    (error) =>
      error instanceof PlacementValidationError &&
      error.code === "INVALID_SIGNATURE",
  );
});

test("rejects an expired placement", () => {
  assert.throws(
    () =>
      validateSignedPlacement(
        SIGNED_PLACEMENT_FIXTURE,
        TEST_MARKETPLACE_PUBLIC_KEY_PEM,
        new Date("2031-01-01T00:00:00.000Z"),
      ),
    (error) =>
      error instanceof PlacementValidationError && error.code === "EXPIRED",
  );
});

test("returns an explicit fallback when the host interface is unavailable", () => {
  const result = assessCodexCapability({
    interfaceAvailable: false,
    cliVersion: null,
    activeTaskId: "active-task",
    createdTaskId: null,
    pickerTaskIds: [],
    restartReadable: false,
    creativeRenderedOutsideModelContext: false,
  });

  assert.equal(result.nativeDelivery, false);
  assert.equal(result.code, "HOST_INTERFACE_UNAVAILABLE");
  assert.equal(result.fallback.kind, "signed-html");
});

test("fails the native gate when a persisted task is omitted from the picker", () => {
  const result = assessCodexCapability({
    interfaceAvailable: true,
    cliVersion: "0.146.1",
    activeTaskId: "019ff73b-6fbc-7f30-bf1a-44abf4193bc8",
    createdTaskId: "01a00610-ea31-7b61-b8f2-b033489d3c01",
    pickerTaskIds: ["019ff73b-6fbc-7f30-bf1a-44abf4193bc8"],
    restartReadable: true,
    creativeRenderedOutsideModelContext: false,
  });

  assert.equal(result.nativeDelivery, false);
  assert.equal(result.code, "TASK_NOT_PICKER_VISIBLE");
  assert.match(result.reason, /not visible/i);
});

test("recognizes the complete native capability contract", () => {
  const result = assessCodexCapability({
    interfaceAvailable: true,
    cliVersion: "0.146.1",
    activeTaskId: "active-task",
    createdTaskId: "sponsored-task",
    pickerTaskIds: ["active-task", "sponsored-task"],
    restartReadable: true,
    creativeRenderedOutsideModelContext: true,
  });

  assert.equal(result.nativeDelivery, true);
  assert.equal(result.code, "SUPPORTED");
});
