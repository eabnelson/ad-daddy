"use client";

import { useRef, useState, useSyncExternalStore } from "react";

import { BrandWordmark } from "./brand";
import { copySetupPrompt, createSetupPrompt } from "./landing-prompt";

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
  const promptRef = useRef<HTMLParagraphElement>(null);
  const prompt = createSetupPrompt(instructionsUrl);

  async function copyPrompt() {
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
    idle: "COPY PROMPT",
    copying: "COPYING",
    copied: "COPIED",
    failed: "COPY MANUALLY",
  }[copyState];

  return (
    <main className="launch-page">
      <header className="launch-brand">
        <h1 aria-label="Ad Daddy">
          <BrandWordmark />
        </h1>
        <p>Earn while you build</p>
      </header>

      <section className="launch-handoff" aria-labelledby="agent-title">
        <h2 id="agent-title">
          <span>TELL</span>{" "}YOUR AGENT
        </h2>
        <div className="launch-prompt">
          <p ref={promptRef}>{prompt}</p>
          <button
            type="button"
            onClick={copyPrompt}
            disabled={copyState === "copying"}
            aria-live="polite"
          >
            {copyLabel}
          </button>
        </div>
      </section>
    </main>
  );
}
