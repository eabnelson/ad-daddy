export type CodexCapabilityCode =
  | "SUPPORTED"
  | "HOST_INTERFACE_UNAVAILABLE"
  | "HOST_VERSION_UNKNOWN"
  | "TASK_NOT_CREATED"
  | "ACTIVE_TASK_MUTATED"
  | "TASK_NOT_PICKER_VISIBLE"
  | "TASK_NOT_RESTART_READABLE"
  | "CREATIVE_REQUIRES_MODEL_CONTEXT";

export interface CodexCapabilityObservation {
  interfaceAvailable: boolean;
  cliVersion: string | null;
  activeTaskId: string;
  createdTaskId: string | null;
  pickerTaskIds: string[];
  restartReadable: boolean;
  creativeRenderedOutsideModelContext: boolean;
}

export interface CodexCapabilityResult {
  nativeDelivery: boolean;
  code: CodexCapabilityCode;
  reason: string;
  fallback: {
    kind: "signed-html";
    disclosure: string;
  };
}

const FALLBACK: CodexCapabilityResult["fallback"] = {
  kind: "signed-html",
  disclosure:
    "Native sponsored-task delivery is unavailable. Open the signed HTML creative manually.",
};

export function assessCodexCapability(
  observation: CodexCapabilityObservation,
): CodexCapabilityResult {
  if (!observation.interfaceAvailable) {
    return failure(
      "HOST_INTERFACE_UNAVAILABLE",
      "The supported Codex App Server interface is unavailable.",
    );
  }

  if (!observation.cliVersion) {
    return failure(
      "HOST_VERSION_UNKNOWN",
      "The Codex host version could not be verified.",
    );
  }

  if (!observation.createdTaskId) {
    return failure(
      "TASK_NOT_CREATED",
      "The host interface did not create a separate sponsored task.",
    );
  }

  if (observation.createdTaskId === observation.activeTaskId) {
    return failure(
      "ACTIVE_TASK_MUTATED",
      "The placement targeted the active task instead of a separate task.",
    );
  }

  if (!observation.pickerTaskIds.includes(observation.createdTaskId)) {
    return failure(
      "TASK_NOT_PICKER_VISIBLE",
      "The created sponsored task is addressable but not visible in the Codex task picker.",
    );
  }

  if (!observation.restartReadable) {
    return failure(
      "TASK_NOT_RESTART_READABLE",
      "The sponsored task could not be read after restarting App Server.",
    );
  }

  if (!observation.creativeRenderedOutsideModelContext) {
    return failure(
      "CREATIVE_REQUIRES_MODEL_CONTEXT",
      "Codex requires a model turn to surface the creative, which would place ad content in automatic model context.",
    );
  }

  return {
    nativeDelivery: true,
    code: "SUPPORTED",
    reason: "Codex satisfies the complete native sponsored-task contract.",
    fallback: FALLBACK,
  };
}

function failure(
  code: Exclude<CodexCapabilityCode, "SUPPORTED">,
  reason: string,
): CodexCapabilityResult {
  return { nativeDelivery: false, code, reason, fallback: FALLBACK };
}
