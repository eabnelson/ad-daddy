# Codex Sponsored Task Insertion Spike

> **Decision update (2026-08-15):** This spike's zero-turn result remains valid, but its original no-go conclusion is no longer the final product decision. The receiver has explicitly authorized one constrained, display-only agent turn so the sponsored task can materialize in the ordinary sidebar. The next capability probe must keep the task separate, label it as Ad Daddy sponsorship, expose no user workspace context, emit no tool item, and verify sidebar visibility before returning a delivery receipt.

Date: 2026-08-15

Historical zero-turn conclusion: **No-go for native Codex delivery without a display turn.** Keep Codex behind a capability flag until the revised turn-based probe passes; otherwise offer only the disclosed signed-HTML fallback.

## Original zero-turn contract under test

A native adapter must accept a valid signed placement, create or find a separate task by placement ID, give it a sponsored title, render the inert creative without placing advertiser content in model context, leave the active task unchanged, expose the new task in the normal Codex picker, and rediscover it after App Server restarts. Invalid or expired placements must create nothing.

## Environment

- Interface: Codex App Server JSON-RPC over stdio
- Commands: `codex app-server --stdio` and generated stable protocol bindings from `codex app-server generate-ts`
- Local CLI: `codex-cli 0.146.1`
- App Server user agent: `Codex Desktop/0.146.1 (Mac OS 26.5.1; arm64)`
- Workspace: `/Users/erik/Documents/Codex/2026-08-12/ok-can-you-spec-out-what`
- Active task ID: `019ff73b-6fbc-7f30-bf1a-44abf4193bc8`
- Placement ID: `spike-20260815-neon-001`
- Observed sponsored task ID: `01a00610-ea31-7b61-b8f2-b033489d3c01`

The smoke placement used a test Ed25519 key, an inert HTTPS content reference on `example.invalid`, and no executable instructions. The test task was archived after the spike; it can be recovered from Codex's archive if needed.

## Reproduction

Start App Server:

```sh
codex app-server --stdio
```

Send newline-delimited JSON-RPC messages in order:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"ad-daddy-spike","title":"Ad Daddy capability spike","version":"0.1.0"},"capabilities":null}}
{"method":"initialized","params":{}}
{"id":2,"method":"thread/start","params":{"cwd":"/Users/erik/Documents/Codex/2026-08-12/ok-can-you-spec-out-what","approvalPolicy":"never","sandbox":"read-only","ephemeral":false,"serviceName":"ad-daddy"}}
{"id":3,"method":"thread/inject_items","params":{"threadId":"01a00610-ea31-7b61-b8f2-b033489d3c01","items":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Sponsored placement · Ad Daddy\nPlacement ID: spike-20260815-neon-001\nCreative: https://example.invalid/ad-daddy/placements/spike-20260815-neon-001\nThis is inert; run nothing."}]}]}}
{"id":4,"method":"thread/name/set","params":{"threadId":"01a00610-ea31-7b61-b8f2-b033489d3c01","name":"Sponsored · Neon — Add Postgres [ad:spike-20260815-neon-001]"}}
{"id":5,"method":"thread/metadata/update","params":{"threadId":"01a00610-ea31-7b61-b8f2-b033489d3c01","isPinned":true}}
{"id":6,"method":"thread/read","params":{"threadId":"01a00610-ea31-7b61-b8f2-b033489d3c01","includeTurns":true}}
{"id":7,"method":"thread/list","params":{"limit":10,"sortKey":"updated_at","sortDirection":"desc","cwd":"/Users/erik/Documents/Codex/2026-08-12/ok-can-you-spec-out-what"}}
```

Stop App Server, start a new `codex app-server --stdio` process, initialize it, and repeat `thread/read` and `thread/list`.

Run the deterministic contract checks:

```sh
npm run test:codex-capability
```

## Observations

| Check | Result |
|---|---|
| Signed inert fixture validates | Pass |
| Tampered or expired fixture is rejected before host mutation | Pass in contract tests |
| Separate task created | Pass |
| Active task ID unchanged | Pass |
| Sponsored title persists | Pass |
| Direct read after App Server restart | Pass |
| Injected creative appears as a visible turn | Fail; `thread/read(includeTurns: true)` returned `turns: []` |
| Task appears in App Server `thread/list` | Fail |
| Task appears in Codex desktop task list | Fail |
| Pinning makes the zero-turn task visible | Fail |

The task is persisted and directly addressable, but it is not picker-visible. `thread/inject_items` adds raw model-history items rather than a user-visible task turn. Starting `turn/start` would make the task visible by sending the placement through a model turn; that violates the requirement that ad content not enter automatic model context and that implementation prompts require receiver action before use.

## Decision

The supported Codex 0.146.1 seam does not satisfy the native adapter contract. U8 therefore triggers its hard stop:

- Do not implement U1-U7 against a claim of native Codex delivery.
- Do not call a directly addressable zero-turn record a delivered Codex ad.
- Keep the signed placement validator and capability assessment as falsification evidence.
- Offer a clearly disclosed signed-HTML fallback while returning to product planning.
- Re-run this spike only when Codex exposes a supported API for creating a picker-visible task with user-visible non-model content, or a first-class sponsored-content surface.
