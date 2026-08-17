import { LandingPage } from "./landing-page";

const defaultSiteUrl = "http://localhost:3000";

function getSetupUrl() {
  try {
    return new URL("/ad-daddy.md", process.env.NEXT_PUBLIC_AD_DADDY_URL ?? defaultSiteUrl).href;
  } catch {
    return new URL("/ad-daddy.md", defaultSiteUrl).href;
  }
}

export default function Home() {
  return <LandingPage initialSetupUrl={getSetupUrl()} />;
}
