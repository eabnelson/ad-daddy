import type { ReactNode } from "react";
import { DM_Sans, Space_Mono } from "next/font/google";

import { brandMetadata } from "../../../app/brand";
import "../../../app/globals.css";

const sans = DM_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
});

const mono = Space_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata = brandMetadata(new URL("https://ad-daddy-team.vercel.app"));

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
