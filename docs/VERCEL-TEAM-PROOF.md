# Vercel team proof

This deployment is a private test network with no real money. Vercel hosts one shared page and API. Postgres stores member profiles, ads, claims, receipts, and play-money point totals. Each receiver's local agent owns polling and creates sponsored tasks locally; Vercel never reaches into Codex, Claude, or a developer machine.

## Deploy

1. Import this repository into Vercel and leave the project's **Root Directory** at the repository root. The checked-in `vercel.json` builds the `apps/vercel` workspace and its local packages.
2. Keep the detected framework set to Next.js. In **Project Settings → General → Vercel Toolbar**, set both Preview and Production to **Off**. The comments injector is not used by this proof and can make deployment fail with `Cannot patch preview comments when immutable static file upload is enabled`.
3. In the Vercel Marketplace, add a Postgres provider such as Neon to the project. Use a distinct Neon branch (or a completely separate database) for Preview and Production, then confirm each environment received its own `DATABASE_URL`. Never point both environments at the same `team_mode_v2_*` tables.
4. Generate the private network invitation and Ed25519 placement-signing keys locally. Run this once for Preview and again for Production; label the outputs so they cannot be mixed:

   ```sh
   npm install
   npm run team:secrets
   ```

5. Set `AD_DADDY_INVITE_CODE` to the private code shared by the coordinator for Preview and Production. It must match `[A-Za-z0-9_][A-Za-z0-9_-]{7,127}`; rotate an older incompatible value before deploying, while existing members continue to work during rotation. Generate **different high-entropy `AD_DADDY_TEAM_KEY` values** for Preview and Production; this secret signs member tokens and is never shared. Never publish either value or expose the Production token or placement signing keys to Preview deployments.
6. Deploy. The first API request creates only the `team_mode_v2_*` proof tables in the connected database.
7. Verify:

   ```sh
   curl -i https://YOUR_DOMAIN/ad-daddy.md
   curl -i https://YOUR_DOMAIN/api/team \
     -H 'content-type: application/json' \
     -H 'authorization: Bearer WRONG' \
     --data '{"action":"status"}'
   ```

   The Markdown request should return `200` with `content-type: text/markdown`. The bad key should return `401` without network data.

## Use it with the team

Open the deployed root page and give its one-line prompt to a trusted local agent:

> Fetch https://YOUR_DOMAIN/ad-daddy.md and help me join this private Ad Daddy test network. Ask me for the private invite code when needed. I want to receive sponsored tasks and create ads. No real money should be enabled.

The agent fetches the hosted Markdown, builds the repository CLI, and uses the self-describing `ad-daddy team` control plane. It can:

- join once with the invite code without printing the returned member capability;
- review or update the member's public matching profile;
- show the advertiser profile, willing recipients, matching inventory, ads, and point totals;
- create and preview a display-only team ad;
- set up, pause, or resume the receiver and run its recurring local poll.

The CLI stores the member capability in an owner-only local file. Never paste it into a browser, prompt, recurring task, command argument, or repository. The `/team` page remains an optional diagnostic workspace and is not part of agent setup.

Every joined member may advertise and receive. Ads match explicit public tags only. The sender cannot receive their own ad, browsing does not consume an ad, and the trusted local receiver acknowledges after display. In this no-money proof, that acknowledgment and the resulting point totals are member-attested—not a cryptographic measurement claim. Team points have no cash value and cannot be redeemed.

## Local verification

Copy `apps/vercel/.env.example` to `apps/vercel/.env.local`, add a development Postgres URL and the generated values, then run:

```sh
npm run dev:vercel
```

Give the agent `http://localhost:3000/ad-daddy.md`. The separate Cloudflare/Vinext application remains available through `npm run dev`; both use the same team service contract but different durable stores.

## Operational boundary

- If Vercel Deployment Protection is enabled, configure an automation bypass credential for every local receiver; otherwise the agent cannot fetch the Markdown or poll the API. The invite code admits new members; member tokens protect member data and mutations.
- Rotating `AD_DADDY_INVITE_CODE` stops use of the old invitation without invalidating existing member tokens. Rotating `AD_DADDY_TEAM_KEY` invalidates every existing member token and requires every browser and receiver to rejoin.
- Rotate both signing keys only after outstanding 24-hour claims have expired or been acknowledged, then re-run receiver setup so agents pin the new public key.
- Back up or delete only the `team_mode_v2_*` tables when resetting this proof.
- Do not add cash, stablecoins, payment credentials, or conversion payouts to this hosted-test route. The full marketplace has separate production gates.

## Deployment scope

The Vercel project deploys only `apps/vercel`: the landing page, agent-readable instructions, and the no-money `/api/team` coordinator backed by Neon. Pushes to the Git-connected `main` branch are the production deployment path.

The Cloudflare/D1/Tempo marketplace is a separate lane and is not part of this proof deployment. Keep it disabled until its payout verification, D1 migration, campaign approval, authenticated conversion, durable rate-limit, scheduler, and rendered-browser test gates are resolved. None of those routes are exposed by `apps/vercel`.
