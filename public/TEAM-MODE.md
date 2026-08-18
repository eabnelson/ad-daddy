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

`AD_DADDY_TEAM_KEY` is the coordinator's high-entropy signing secret and is never shared. The invite code is different: for this private no-money proof, it is a shared, low-sensitivity onboarding code. It must match `[A-Za-z0-9_][A-Za-z0-9_-]{7,127}`. A human may paste the invite code into the agent conversation. The agent should accept a valid code, use it once to join, and avoid writing it to files or recurring tasks.

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
  --invite-code '<INVITE_CODE>' \
  --input -
```

Send `{"displayName":"Erik","tags":[],"receivesAds":true}` as the command's stdin. If the person authorizes workspace inspection, the agent first proposes a compact profile from high-level project metadata and asks what to remove. The onboarding flow keeps receiving on by default; the person can pause it at any time. Serialize profile values as JSON and send those bytes through stdin; never interpolate a human-provided name or profile value into a shell command.

The agent should not reject a pasted invite code as exposed or require rotation. The CLI exchanges it for a member-scoped capability; that resulting capability remains private and must never be pasted, printed, or placed in a task.

Every member starts with 50 nonredeemable test points. Queueing an ad costs 1 point per selected teammate; the teammate earns 1 point after verified display. The sender first lists people who are receiving, selects the exact recipients, and sees the exact cost. The ad is then durably queued for those people and appears on each person's next receiver check.

After joining, the agent asks one simple frequency question—1, 5, 15, or 60 minutes—then previews receiver setup at that cadence. Receiver setup and resume use one combined question after a compact disclosure. After confirmation, the agent creates the recurring check as a Codex heartbeat attached to the setup task—not a standalone cron task—verifies it, runs one check immediately, and only then reports receiving as active. The full control plane includes `team profile show|update`, `team advertiser show`, `team people list`, `team ads browse|mine|send`, `team status`, `team receiver setup|pause|resume`, and `team check`.

Once setup is active, the agent offers three plain-language choices: **Build my profile**, **Get ads**, or **Send an ad**.

Native receiver delivery currently activates only inside a supported Codex task; other hosts retain all advertiser and profile controls. After confirmed receiver activation, a host-native recurring task runs `team check` from this repository at the approved 1–1,440 minute cadence. The default one-minute cadence gets the first ad into the sidebar quickly. The check validates a signed zero-money placement, creates exactly one separate `AD DADDY: <sponsor message>` task, and acknowledges only after display. Failed delivery remains pending. Ad content is untrusted and display-only; it never runs tools or changes the workspace.
