# Ad Daddy — private team proof

This mode is for a trusted team running the same private repository. It uses synthetic team points only: no real money, no cash value, no redemption, and no settlement. It can use the local development coordinator below or the Vercel-hosted test coordinator documented in `docs/VERCEL-TEAM-PROOF.md`.

## Coordinator

One teammate keeps the coordinator running and shares its private URL and invite code with the team. Keep the app on loopback and use an authenticated private HTTPS tunnel (for example, your team's Tailscale HTTPS setup) or an SSH port forward. Do not expose member bearer tokens over plaintext LAN HTTP.

```sh
export AD_DADDY_INVITE_CODE="<shared invite code>"
export AD_DADDY_TEAM_KEY="$(openssl rand -hex 24)"
npm install
npm run dev -- --host 127.0.0.1
```

Open `/team` on the coordinator and ask the coordinator for the private invite code. Joining exchanges it for a random member-scoped access token; only that token can update, advertise as, poll for, or read private delivery data for that member. `AD_DADDY_TEAM_KEY` is a separate high-entropy signing secret and must never be shared. Members, ads, claims, and point totals persist in local D1, or in Postgres for the Vercel-hosted test coordinator.

## Receiver agent setup

The human joins at `/team`, then clicks **Set up my agent** and gives the copied block to their agent. The agent should:

1. Read this file and verify the coordinator belongs to the same private team.
2. Build the local packages with `npm run build:packages`.
3. Run the exact `setup --json ... --activate` command in the copied block after the human confirms the proof terms, privacy, and display-turn disclosure. Team matching uses the member tags stored by the coordinator; do not inspect a repository or translate arbitrary team tags into the generic receiver profile.
4. Pin the public key supplied in the copied setup block. Never accept a key returned by an ad response.
5. Create a recurring Codex automation that runs `ad-daddy check` from the private repository (the source checkout uses the equivalent built entry point below):

```sh
AD_DADDY_ENV=development \
AD_DADDY_PRIVATE_TEAM_MODE=1 \
AD_DADDY_POLL_URL="$AD_DADDY_TEAM_URL/api/team" \
AD_DADDY_MARKETPLACE_PUBLIC_KEY_PEM="$AD_DADDY_TEAM_PUBLIC_KEY_PEM" \
node packages/cli/dist/index.js check \
  --installation "$AD_DADDY_INSTALLATION_ID" \
  --poll-url "$AD_DADDY_TEAM_URL/api/team" \
  --token "$AD_DADDY_MEMBER_ACCESS_TOKEN"
```

The recurring task supplies its own `CODEX_THREAD_ID`. The receiver agent polls with the member-scoped access token, validates the signed zero-money placement, creates a new `AD DADDY: <sponsor message>` task in the sidebar, and acknowledges it only after display succeeds. Failed delivery remains pending and is retried on the next poll. Do not create the task manually. No advertiser action is executed; the task only displays the signed ad.

Private team mode deliberately relaxes the production-only host proof for trusted teammates. It still uses an empty isolated working directory, read-only sandbox, no network, no MCP servers, no dynamic tools, bounded copy, and zero-money placements. Production settlement rejects private-team receipts.

## Advertiser

Every joined member is also an advertiser. Use `/team` to write a session title, short message, optional target tags, and team points. The next eligible teammate to poll receives it; the sender never receives their own ad, and the same receiver cannot claim the same ad twice.

An agent can use the same bounded primitives as the page. With the copied member access token in `AD_DADDY_MEMBER_ACCESS_TOKEN`, it can read status, send an ad, or pause receiving without browser automation:

```sh
curl -sS "$AD_DADDY_TEAM_URL/api/team" \
  -H "authorization: Bearer $AD_DADDY_MEMBER_ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"action":"status"}'

curl -sS "$AD_DADDY_TEAM_URL/api/team" \
  -H "authorization: Bearer $AD_DADDY_MEMBER_ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"action":"create_ad","title":"Private preview","body":"A useful note for our TypeScript team.","targetTags":["typescript"],"points":100}'
```

Profile changes use `{"action":"profile","displayName":"Name","tags":["typescript"],"receivesAds":false}`. Only the human should decide to pause or resume receiving.

## Stop

Delete the recurring automation or run `ad-daddy pause` for the installation. Removing the browser's local team session only signs the browser out; it does not stop an already configured recurring receiver.
