# Codex Sponsored Task Insertion Spike

Date: 2026-08-15

Conclusion: **Go for receiver-pulled native Codex delivery on the exact capability-tested version; fail closed on every other version.** The constrained display turn creates a normal non-pinned Codex UI task, leaves the active task selected, survives App Server restart, and emits no tool item. The receiver's Codex task API directly verified the ordinary UI-list and active-task conditions after the lower-level App Server probe. Runtime delivery may use interactive `thread/list` membership as the calibrated receipt condition only for App Server/Desktop `0.146.1`; other versions retain the explicit signed-HTML fallback until they pass the same probe. This proves explicit local delivery, not unattended `launchd` delivery; the background path remains gated on its own keychain, restart, and sleep/wake probe.

## Host-policy preflight

Integration status: **no special OpenAI approval is an Ad Daddy protocol dependency; production remains gated by receiver consent, the current published host contract and terms, and the exact-version capability probe**.

Official OpenAI documentation describes App Server as the interface used to power rich Codex clients and says to use it for deep integrations inside another product. It documents `thread/start`, `thread/name/set`, `turn/start`, `thread/list`, `thread/read`, `turn/interrupt`, sandbox policy, and streamed item events. See [Codex App Server](https://developers.openai.com/codex/app-server/).

Delivery is modeled as a receiver-authorized pull, not a marketplace push. The user's installed Ad Daddy client fetches a device-bound signed placement using the receiver's own consent and credentials, then the local client asks App Server to create the separate task. The marketplace never receives Codex credentials or calls the host on the receiver's behalf. General compliance with current published terms remains an operator responsibility, but this architecture does not wait for or model a separate sponsored-task approval grant.

## Contract under test

A native adapter receives a placement only from a receiver-initiated fetch. It must validate the short-lived installation-bound grant and freshly device-authorized creative-redemption lease before host mutation, create or find one separate task by placement ID, apply the exact title shape `Sponsored · {advertiser title}`, and run exactly one model turn under the immutable Ad Daddy display instruction. The opaque claim ID is not a bearer credential. Advertiser fields are bounded data. The turn has an empty temporary cwd, approval policy `never`, read-only filesystem policy, no network access, no optional MCP/app/plugin/browser/computer-use/image/multi-agent/workspace-dependency tools, and no user workspace roots.

Delivery fails closed when the turn times out, exceeds its output budget, emits any tool item, loads an unexpected workspace instruction source, changes the active task, disappears after restart, or cannot be directly verified in the ordinary desktop sidebar. A failure yields no receipt. A placement-ID retry must never start a second turn. The fallback remains:

> Native sponsored-task delivery is unavailable. Open the signed HTML creative manually.

## Environment and exact interface

- Installed CLI: `codex-cli 0.146.1`
- Installed desktop bundle: `com.openai.codex`, version `26.810.52044` (bundle build `6662`)
- App Server user agent: `Codex Desktop/0.146.1 (Mac OS 26.5.1; arm64) dumb (ad_daddy; 0.1.0)`
- Interface: `codex app-server --stdio`, newline-delimited JSON-RPC
- Stable methods exercised: `initialize`, `thread/start`, `thread/name/set`, `turn/start`, `turn/interrupt`, `thread/read`, `thread/list`, and `thread/archive`
- Model: `gpt-5.6-luna`
- Placement: `spike-20260815-neon-001`
- Empty turn cwd: `/tmp/ad-daddy-sponsored.u0F6hg` (removed after the run)
- Sponsored task ID: `01a00657-a581-7051-987d-6da50df28f86`
- Display turn ID: `01a00657-abff-7ca2-9011-add0999f3382`
- Expected active task ID supplied to the probe: `019ff73b-6fbc-7f30-bf1a-44abf4193bc8`

The generated 0.146.1 protocol schema was used to set `approvalPolicy: "never"`, thread sandbox `"read-only"`, turn sandbox policy `{ "type": "readOnly", "networkAccess": false }`, empty runtime workspace roots, empty environments and dynamic tools, and disabled web search/MCP/apps/optional feature families. `project_doc_max_bytes: 0` and an empty fallback-filename list prevent cwd instruction discovery. App Server still reports the receiver-global `/Users/erik/.codex/AGENTS.md`; it is recorded as a global client instruction, not a receiver-workspace root. Any other instruction source fails delivery.

## Observations

| Check | Observation |
|---|---|
| Signature/policy validation before host mutation | Pass in deterministic integration tests; invalid, tampered, and expired fixtures open no App Server connection |
| Separate sponsored task | Pass; task `01a00657-a581-7051-987d-6da50df28f86` differs from the expected active task ID |
| Exact title | Pass; `Sponsored · Add Postgres without leaving Codex` |
| Exactly one display turn | Pass; one completed turn before and after placement-ID retry |
| Display disclosure | Pass; final response begins `Sponsored via Ad Daddy` |
| Advertiser data boundary | Pass; user input is delimited by `BEGIN ADVERTISER DATA` / `END ADVERTISER DATA`; prompt-injection fixture remains quoted data in deterministic coverage |
| Tool items | Pass; `0` command, file-change, MCP, dynamic-tool, collaboration-tool, web-search, image-view, or image-generation items |
| Files/network/install/purchase/external action | Pass for the observed turn; no action item was emitted and the host profile was read-only/network-disabled |
| Output budget / timeout | Pass in deterministic coverage; both interrupt and return no receipt |
| App Server restart read | Pass; a newly initialized process returned the same title, one completed turn, and final response |
| App Server ordinary interactive list | Pass after the turn; `thread/list` returns the task under source `vscode`. The pre-turn zero-record behavior remains omitted |
| Placement-ID retry | Pass; turn count remained `1` and the turn ID remained `01a00657-abff-7ca2-9011-add0999f3382` |
| Desktop ordinary task list/sidebar | Pass through the Codex app task API after unarchiving; task `01a00657-a581-7051-987d-6da50df28f86` appeared as a normal non-pinned local task with the exact sponsored title and `notLoaded` status. Computer Use remained blocked, so no screenshot was captured |
| Active desktop task before/after | Pass through direct Codex app state: active task `019ff73b-6fbc-7f30-bf1a-44abf4193bc8` remained selected while the sponsored task stayed `notLoaded` |
| Codex app read | Pass; direct read returned exactly one completed turn, the bounded untrusted-data user item, the Ad Daddy final response, and no tool item |
| Receipt gate | Pass for the exact tested App Server/Desktop `0.146.1` capability profile; the adapter rejects untested versions and retains the signed-HTML fallback |
| Inert item injection without a model turn | No-go; a 2026-08-15 `thread/inject_items` probe produced a persistent zero-turn task with empty preview that `thread/list` omitted, so it cannot satisfy the sidebar requirement. Probe task `01a0072a-8824-7243-8547-9f099f752ae2` was archived immediately |

Observed display output:

```text
Sponsored via Ad Daddy

- Advertiser: Neon (adv_neon_test)
- Offer: “Add Postgres without leaving Codex”
- Reward: 5.00 USD
- Targeting: TypeScript and database integration
- Advertiser-authored text: “Neon provides serverless Postgres with branching for development workflows.”
- Supported attachment reference: Neon product overview (text/html) — https://example.invalid/ad-daddy/attachments/neon-overview.html
```

## Cleanup and decision

The capability-test task was archived through `thread/archive`, temporarily unarchived for direct Codex app list/read verification, and re-archived. Archived-list verification returned the same task ID. Archival is recoverable.

The turn-based approach fixes the historical zero-turn omission and satisfies U8 for the tested version: a completed turn is persisted, directly readable after restart, present in the ordinary task list/sidebar, and does not navigate away from the receiver's active task. The host protocol exposes no supported switch that removes the built-in command/file tool families entirely; Ad Daddy therefore combines empty workspace/environment/dynamic-tool scopes, read-only/no-network sandboxing, creative injection rejection, immutable display instructions, and fail-closed tool-item monitoring for test/staging demonstrations. Production additionally requires the connection itself to attest `builtInToolsDisabled: true` before advertiser content is sent to `turn/start`; the current connector deliberately cannot emit that proof. Keep Codex native delivery behind the exact-version capability gate, preserve the explicit signed-HTML fallback for unknown versions, require a host-supported no-built-in-tools profile or equivalent isolation proof before production, and keep session creation exclusively inside the receiver's local pull client. This gate is technical and independent of any OpenAI approval.
