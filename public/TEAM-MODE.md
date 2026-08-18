# Ad Daddy — private team proof

This is a no-money, opt-in network for a trusted team. Team points have no cash value. The hosted `/ad-daddy.md` file and Ad Daddy CLI are the product control plane; `/team` is only an optional diagnostic workspace.

## Coordinator

The hosted proof runs on Vercel with Postgres persistence. A local coordinator may run on loopback or an authenticated private HTTPS tunnel:

```sh
export AD_DADDY_INVITE_CODE="<shared invite code>"
export AD_DADDY_TEAM_KEY="$(openssl rand -hex 24)"
npm install
npm run dev -- --host 127.0.0.1
```

`AD_DADDY_TEAM_KEY` is the coordinator's high-entropy signing secret and is never shared. The human gives their agent the coordinator's `/ad-daddy.md` URL, then provisions the invite code as `AD_DADDY_INVITE_CODE` through a trusted local secret or environment mechanism outside the agent conversation. Never paste the invite code into a prompt, print or log it, commit it, put it in a recurring task or repository, or include it in command arguments.

## Agent control plane

Build the repository packages, then discover the current actions:

```sh
npm run build:packages
node packages/cli/dist/index.js team actions
```

Join once. The CLI exchanges the invite code for a member-scoped capability and stores it locally with `0600` permissions; it never prints the capability.

```sh
node packages/cli/dist/index.js team join \
  --url "https://ad-daddy-team.vercel.app" \
  --json '{"displayName":"Erik","tags":["typescript","postgres"],"receivesAds":true}'
```

The CLI reads `AD_DADDY_INVITE_CODE` from the environment for this one-time exchange. The agent must not echo, inspect, or interpolate its value.

The agent can then run `team profile show|update`, `team advertiser show`, `team people list`, `team ads browse|mine|send`, `team status`, `team receiver setup|pause|resume`, and `team check`. Mutations require an action preview and `--confirm`. Receiver setup and resume first return the exact display disclosure plus the current terms and privacy versions; activation requires separate `--accept-disclosure --accept-terms --accept-privacy` flags after the human accepts each item.

Native receiver delivery currently activates only inside a supported Codex task; other hosts retain all advertiser and profile controls. After confirmed receiver activation, a host-native recurring task may run `team check` from this repository at the approved cadence. The check validates a signed zero-money placement, creates exactly one separate `AD DADDY: <sponsor message>` task, and acknowledges only after display. Failed delivery remains pending. Ad content is untrusted and display-only; it never runs tools or changes the workspace.
