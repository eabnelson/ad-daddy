import { ImageResponse } from "next/og";

import { BRAND_RED } from "./brand";
import { AD_DADDY_DISPLAY_FONT } from "./fonts/anton-subset";

const BRAND_IMAGE_FONT = {
  data: AD_DADDY_DISPLAY_FONT,
  name: "AdDaddyDisplay",
  style: "normal" as const,
  weight: 400 as const,
};

export function brandOpenGraphImage() {
  return new ImageResponse(
    <div style={{ alignItems: "center", background: "#000000", display: "flex", fontFamily: "AdDaddyDisplay", fontSize: 144, fontWeight: 400, height: "100%", justifyContent: "center", letterSpacing: "-8px", width: "100%" }}>
      <div style={{ display: "flex" }}>
        <span style={{ color: BRAND_RED }}>AD</span>
        <span style={{ color: "#ffffff", marginLeft: 24 }}>DADDY</span>
      </div>
    </div>,
    { fonts: [BRAND_IMAGE_FONT], width: 1200, height: 630 },
  );
}

export function brandIconImage() {
  return new ImageResponse(
    <div style={{ alignItems: "center", background: "#000000", display: "flex", fontFamily: "AdDaddyDisplay", fontSize: 40, fontWeight: 400, height: "100%", justifyContent: "center", letterSpacing: "-3px", width: "100%" }}>
      <span style={{ color: BRAND_RED }}>A</span>
      <span style={{ color: "#ffffff" }}>D</span>
    </div>,
    { fonts: [BRAND_IMAGE_FONT], width: 64, height: 64 },
  );
}
