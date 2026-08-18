"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { BrandWordmark } from "./brand";
import { CopyPromptIcon, type CopyPromptIconState } from "./copy-prompt-icon";
import { copySetupPrompt, createSetupPrompt, scheduleCopyReset } from "./landing-prompt";

const subscribeToOrigin = () => () => {};
const browserInstructionsUrl = () => `${window.location.origin}/ad-daddy.md`;
type CopyState = "idle" | "copying" | "copied" | "failed";

export function LandingPage({ initialSetupUrl }: { initialSetupUrl: string }) {
  const instructionsUrl = useSyncExternalStore(
    subscribeToOrigin,
    browserInstructionsUrl,
    () => initialSetupUrl,
  );
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const promptRef = useRef<HTMLSpanElement>(null);
  const prompt = createSetupPrompt(instructionsUrl);

  useEffect(() => {
    if (copyState !== "copied") return;
    return scheduleCopyReset(() => setCopyState("idle"));
  }, [copyState]);

  async function copyPrompt() {
    if (copyState === "copying") return;
    setCopyState("copying");
    const copied = await copySetupPrompt(prompt, () => navigator.clipboard);
    setCopyState(copied ? "copied" : "failed");

    if (!copied && promptRef.current) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(promptRef.current);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }

  const copyLabel = {
    idle: "Copy setup prompt",
    copying: "Copying setup prompt",
    copied: "Copied to clipboard",
    failed: "Copy failed. Prompt selected for manual copy",
  }[copyState];
  const copyStatus = copyState === "idle" ? "" : copyLabel;
  const copyIconState: CopyPromptIconState = copyState === "copied"
    ? "copied"
    : copyState === "failed"
      ? "failed"
      : "copy";

  return (
    <main className="launch-page">
      <header className="launch-brand">
        <h1 aria-label="Ad Daddy">
          <BrandWordmark />
        </h1>
        <p>EARN WHILE YOU BUILD</p>
      </header>

      <section className="launch-handoff" aria-label="Tell your agent">
        <div className="launch-quote">
          <p>
            <span ref={promptRef}>{prompt}</span>
          </p>
          <button
            className="launch-copy-button"
            type="button"
            onClick={copyPrompt}
            aria-disabled={copyState === "copying"}
            aria-label={copyLabel}
          >
            <CopyPromptIcon state={copyIconState} />
          </button>
          <span
            className={copyState === "failed" ? "launch-copy-hint" : "sr-only"}
            role="status"
            aria-live="polite"
          >
            {copyStatus}
          </span>
        </div>
      </section>
    </main>
  );
}
