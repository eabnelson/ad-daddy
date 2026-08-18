import { createElement, Fragment } from "react";

export type CopyPromptIconState = "copy" | "copied" | "failed";

export function CopyPromptIcon({ state }: { state: CopyPromptIconState }) {
  const glyph = state === "copied"
    ? createElement("path", { d: "m5 12 4 4L19 6" })
    : state === "failed"
      ? createElement(Fragment, null,
        createElement("circle", { cx: 12, cy: 12, r: 8 }),
        createElement("path", { d: "m9 9 6 6m0-6-6 6" }),
      )
      : createElement(Fragment, null,
        createElement("rect", { x: 9, y: 9, width: 11, height: 11, rx: 2 }),
        createElement("path", { d: "M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" }),
      );

  return createElement("svg", { "aria-hidden": true, viewBox: "0 0 24 24" }, glyph);
}
