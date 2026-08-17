import type { Metadata } from "next";
import type { ReactNode } from "react";

import "../../../app/globals.css";

export const metadata: Metadata = {
  title: "Ad Daddy — Earn while you build",
  description: "A private, no-money team network for sponsored agent tasks.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
