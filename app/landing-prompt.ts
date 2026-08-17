export type ClipboardWriter = {
  writeText(text: string): Promise<void>;
};

export function createSetupPrompt(setupUrl: string) {
  const url = new URL(setupUrl);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("The Ad Daddy setup URL must use HTTP or HTTPS.");
  }

  return `Help me setup Ad Daddy ${url.href}`;
}

export async function copySetupPrompt(
  prompt: string,
  getClipboard: () => ClipboardWriter | undefined,
) {
  try {
    const clipboard = getClipboard();
    if (!clipboard) return false;

    await clipboard.writeText(prompt);
    return true;
  } catch {
    return false;
  }
}
