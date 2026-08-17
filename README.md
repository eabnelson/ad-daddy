# Ad Daddy

Earn while you build. Ad Daddy is an opt-in marketplace for sponsored agent
tasks. This repository currently includes a no-money private team proof, a
receiver-owned polling CLI, and the broader marketplace prototype.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

## Private team proof

### Vercel-hosted coordinator

The fastest shared-team path is the Vercel app in `apps/vercel`. It hosts the
onboarding page, origin-bound `/ad-daddy.md` agent instructions, profiles, ad
inventory, and the API. A Vercel Marketplace Postgres integration persists the
network; each teammate's local agent still polls and creates the sponsored task
in their own supported host.

```bash
npm install
npm run team:secrets
npm run build:vercel
```

Set the Vercel project's Root Directory to `apps/vercel`, add `DATABASE_URL`
plus the generated secrets, and deploy. Exact setup and verification:
[`docs/VERCEL-TEAM-PROOF.md`](docs/VERCEL-TEAM-PROOF.md).

### Local-only coordinator

Run a zero-money Ad Daddy network for trusted teammates:

```bash
export AD_DADDY_INVITE_CODE="<shared invite code>"
export AD_DADDY_TEAM_KEY="$(openssl rand -hex 24)"
npm run dev -- --host 127.0.0.1
```

Share a private HTTPS or SSH-forwarded-localhost `/team` URL and invite code. Keep `AD_DADDY_TEAM_KEY` private because it signs member tokens. Anyone who joins can
send and receive ads; rewards are non-redeemable team points. The local D1
database preserves the network across restarts. Give your agent the block from
**Set up my agent** so it configures recurring polling and creates matching ads
as separate sponsored Codex tasks. Full instructions: [`public/TEAM-MODE.md`](public/TEAM-MODE.md).

The private team proof never enables cash, settlement, deposits, or redemption.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Verified request identity

The public Worker never trusts caller-supplied identity headers. A trusted
authentication gateway must create a short-lived, method-and-path-bound HMAC
assertion in `ad-daddy-identity-assertion` using the Wrangler secret
`AD_DADDY_IDENTITY_ASSERTION_SECRET`. The Worker verifies that assertion,
removes every public or internal identity header supplied by the caller, and
then injects the internal account claims consumed by application routes.

Until that gateway and secret are configured, account-scoped routes fail
closed. Anonymous landing and demo routes continue to work. Never expose the
assertion secret to a browser or configure it as a plaintext Wrangler variable.

## Optional gateway-owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

The trusted authentication gateway owns `/signin-with-chatgpt`,
`/signout-with-chatgpt`, `/callback`, the OAuth cookies, and signed request
identity assertion. Do not implement app routes for those reserved paths.
Routes that do not import and call the helper remain anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Enforce
explicit server-side membership or allowlist checks where those are required.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
