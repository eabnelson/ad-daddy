import type { Metadata } from "next";

export const BRAND_NAME = "AD DADDY";
export const BRAND_TAGLINE = "Earn while you build.";
export const BRAND_RED = "#d71920";

export function BrandWordmark() {
  return <><span className="brand-ad">AD</span>{" "}<span className="brand-daddy">DADDY</span></>;
}

export function brandMetadata(metadataBase?: URL): Metadata {
  return {
    ...(metadataBase ? { metadataBase } : {}),
    title: BRAND_NAME,
    description: BRAND_TAGLINE,
    openGraph: {
      title: BRAND_NAME,
      description: BRAND_TAGLINE,
      images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: BRAND_NAME }],
    },
    twitter: {
      card: "summary_large_image",
      title: BRAND_NAME,
      description: BRAND_TAGLINE,
      images: ["/opengraph-image"],
    },
  };
}
