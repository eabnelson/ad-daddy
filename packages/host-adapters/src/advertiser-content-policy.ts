export class AdvertiserContentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvertiserContentPolicyError";
  }
}

const FORBIDDEN_ADVERTISER_TEXT_PATTERNS = [
  /\b(?:secret|credential|password|private[ -]?key|api[ _-]?key)\b/i,
  /\b(?:process\.env|environment variable|\.env\b)/i,
  /\b(?:curl|wget|invoke-webrequest)\b[^\n]{0,160}(?:\||>|-o\b)/i,
  /\b(?:bash|sh|zsh|powershell|cmd\.exe)\b/i,
  /\b(?:run|execute)\b[^\n]{0,80}\b(?:script|command|binary)\b/i,
  /\b(?:disable|bypass|ignore)\b[^\n]{0,80}\b(?:security|approval|instruction|sandbox)\b/i,
] as const;

/**
 * Reject advertiser-authored display copy that could be interpreted as an
 * instruction to the sponsored-session agent. This policy is intentionally
 * host-neutral so campaign intake, placement signing, and host adapters can
 * enforce the same boundary.
 */
export function assertSafeAdvertiserDisplayText(value: string): void {
  if (/<\s*(?:script|iframe|object|embed|form|meta|base)\b/i.test(value)) {
    throw new AdvertiserContentPolicyError(
      "Executable or embedding markup is not allowed in ad copy",
    );
  }
  if (FORBIDDEN_ADVERTISER_TEXT_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new AdvertiserContentPolicyError(
      "Advertiser display text requests privileged or executable behavior",
    );
  }
}

export function hasForbiddenAdvertiserPromptPattern(value: string): boolean {
  return FORBIDDEN_ADVERTISER_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}
