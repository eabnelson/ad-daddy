export const CLI_VERSION = "0.1.0";

export * from "./commands/check.js";
export * from "./commands/profile.js";
export * from "./commands/setup.js";
export * from "./install-integrity.js";
export * from "./local-store.js";
export * from "./scheduler.js";
export * from "./schedulers/launchd.js";

export function usage(): string {
  return [
    `Ad Daddy CLI ${CLI_VERSION}`,
    "setup      choose receiver, advertiser, or both and preview configuration",
    "profile    show the exact outbound receiver snapshot",
    "check      run one policy-gated manual ad check",
    "pause      stop checking before consent revocation",
    "uninstall  remove the scheduler before revoking the installation",
  ].join("\n");
}
