import { LandingPage } from "../../../app/landing-page";

const setupUrl = "https://ad-daddy-team.vercel.app/ad-daddy.md";

export default function Home() {
  return <LandingPage initialSetupUrl={setupUrl} />;
}
