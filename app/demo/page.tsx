import type { Metadata } from "next";

import { DemoExperience } from "./demo-experience";

export const metadata: Metadata = {
  title: "Ad Daddy — Interactive Demo",
  description: "Create a receiver profile, invite automated bidders, and watch a sponsored session appear beside your work.",
};

export default function DemoPage() {
  return <DemoExperience />;
}
