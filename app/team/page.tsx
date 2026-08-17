import { TeamExperience } from "./team-experience";
import styles from "./team.module.css";
import Link from "next/link";
import { BrandWordmark } from "../brand";

export default function TeamPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.wordmark} aria-label="Ad Daddy"><BrandWordmark /></Link>
        <span>Private team mode · No real money</span>
      </header>
      <section className={styles.intro}>
        <p>Private team mode</p>
        <h1>Earn while<br /><em>you build.</em></h1>
        <span>Anyone can send. Anyone can receive. Team points have no cash value.</span>
      </section>
      <TeamExperience />
    </main>
  );
}
