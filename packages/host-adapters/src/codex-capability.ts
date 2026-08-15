export type CodexCapabilityCode =
  | "SUPPORTED"
  | "HOST_INTERFACE_UNAVAILABLE"
  | "HOST_VERSION_UNKNOWN"
  | "HOST_VERSION_UNSUPPORTED"
  | "TASK_NOT_CREATED"
  | "ACTIVE_TASK_UNVERIFIABLE"
  | "ACTIVE_TASK_MUTATED"
  | "TASK_NOT_LIST_VISIBLE"
  | "TASK_NOT_SIDEBAR_VERIFIED"
  | "TASK_NOT_RESTART_READABLE"
  | "DISPLAY_TURN_INCOMPLETE"
  | "TOOL_ITEM_EMITTED"
  | "INSTRUCTION_SOURCE_LEAK";

export interface CodexCapabilityObservation {
  interfaceAvailable: boolean;
  cliVersion: string | null;
  activeTaskIdBefore: string | null;
  activeTaskIdAfter: string | null;
  createdTaskId: string | null;
  listedTaskIds: string[];
  sidebarVerified: boolean;
  restartReadable: boolean;
  displayTurnCompleted: boolean;
  toolItemCount: number;
  instructionSources: string[];
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

export const SIGNED_HTML_FALLBACK: CodexCapabilityResult["fallback"] = {
  kind: "signed-html",
  disclosure:
    "Native sponsored-task delivery is unavailable. Open the signed HTML creative manually.",
};

export const CODEX_NATIVE_DELIVERY_VERSIONS: readonly string[] = Object.freeze([
  "0.146.1",
]);

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
  if (!CODEX_NATIVE_DELIVERY_VERSIONS.includes(observation.cliVersion)) {
    return failure(
      "HOST_VERSION_UNSUPPORTED",
      `Codex ${observation.cliVersion} has not passed the sponsored-task capability probe.`,
    );
  }
  if (!observation.createdTaskId) {
    return failure(
      "TASK_NOT_CREATED",
      "The host interface did not create a separate sponsored task.",
    );
  }
  if (!observation.activeTaskIdBefore || !observation.activeTaskIdAfter) {
    return failure(
      "ACTIVE_TASK_UNVERIFIABLE",
      "The integration cannot directly compare the active task before and after insertion.",
    );
  }
  if (
    observation.createdTaskId === observation.activeTaskIdBefore ||
    observation.activeTaskIdBefore !== observation.activeTaskIdAfter
  ) {
    return failure(
      "ACTIVE_TASK_MUTATED",
      "The sponsored placement changed or reused the receiver's active task.",
    );
  }
  if (!observation.displayTurnCompleted) {
    return failure(
      "DISPLAY_TURN_INCOMPLETE",
      "The constrained sponsored display turn did not complete.",
    );
  }
  if (observation.toolItemCount > 0) {
    return failure(
      "TOOL_ITEM_EMITTED",
      "The sponsored display turn emitted a forbidden tool item.",
    );
  }
  if (observation.instructionSources.length > 0) {
    return failure(
      "INSTRUCTION_SOURCE_LEAK",
      "The sponsored task loaded workspace or user instruction sources.",
    );
  }
  if (!observation.restartReadable) {
    return failure(
      "TASK_NOT_RESTART_READABLE",
      "The sponsored task could not be read after restarting App Server.",
    );
  }
  if (!observation.listedTaskIds.includes(observation.createdTaskId)) {
    return failure(
      "TASK_NOT_LIST_VISIBLE",
      "The created sponsored task is addressable but absent from App Server's persisted task list.",
    );
  }
  if (!observation.sidebarVerified) {
    return failure(
      "TASK_NOT_SIDEBAR_VERIFIED",
      "Ordinary Codex sidebar visibility was not directly verified.",
    );
  }
  return {
    nativeDelivery: true,
    code: "SUPPORTED",
    reason: "Codex satisfies the complete native sponsored-task contract.",
    fallback: SIGNED_HTML_FALLBACK,
  };
}

function failure(
  code: Exclude<CodexCapabilityCode, "SUPPORTED">,
  reason: string,
): CodexCapabilityResult {
  return {
    nativeDelivery: false,
    code,
    reason,
    fallback: SIGNED_HTML_FALLBACK,
  };
}
