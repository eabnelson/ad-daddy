import type { Metadata } from "next";
import { DM_Sans, Space_Mono } from "next/font/google";
import "./globals.css";

const sans = DM_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
});

const mono = Space_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "Ad Daddy",
  description: "Tell your agent to get setup with Ad Daddy and start earning before you build.",
  openGraph: {
    title: "Ad Daddy",
    description: "Earn before you build.",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "Ad Daddy — Earn before you build." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Ad Daddy",
    description: "Earn before you build.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
