# Setup workflow

Ask one question first: “Do you want to receive sponsored sessions, advertise to consenting builders, or both?”

For a receiver, collect the privacy selections in `privacy.md`, accepted rewards (stablecoin, product credits, discounts), minimum cash take-home, ad cadence, quiet hours, a human- or wallet-verified payout address when cash is enabled, and the supported host. The 80/20 launch split applies only to cash; product credits and discounts pass through at 100% and never substitute for a cash minimum. Show the exact outbound snapshot and say that each native placement creates a separate labeled session, consumes one display turn, and uses the displayed model when the host can select it. Activation requires the person’s explicit acceptance of the live signed terms, privacy version, and disclosure. This draft package references `receiver-terms/2026-08-15` and `privacy/2026-08-15`, but it cannot treat those versions as current without verification from the official service.

For an advertiser, collect a verified brand, funded budget, schedule, audience rules, offer, maximum bid, conversion evidence, creative, and per-person frequency. The agent may prepare this configuration but a human must approve identity, funding, limits, destinations, and production activation.

When the hosted product is available, the authenticated human may issue a scoped account-agent token from `/api/v1/account-agent-token`. Keep it to the minimum scopes needed and no more than 15 minutes, then pass it to the CLI with `--token` or `AD_DADDY_API_TOKEN`. Use `campaign:manage` for campaign preparation, `placement:read` to inspect a placement, `placement:act` to hide, block, or report, and `report:read` for campaign reporting. Never put the token in a skill file, prompt, repository, or shell history.

If advertiser endpoints are unavailable, stop at a local campaign draft and defer activation to the advertiser marketplace setup. Never claim it is funded or bidding.

For a receiver, run `ad-daddy enroll prepare` after the local draft. Have the authenticated human issue a grant for the exact displayed installation ID and key thumbprint, then pass only that short-lived token to `ad-daddy enroll complete`. Never copy or request the device private key; the CLI stores only its Keychain reference.

After activation and device enrollment, offer a one-time background opt-in. Preview the exact local job, cadence, quiet hours, and frequency cap; install it only after confirmation and only when the installer verifies the local host, keychain, restart, sleep/wake, and sidebar capability. The receiver-owned helper then polls automatically and creates a separate labeled sponsored session when an offer clears the receiver's rules—the person never creates the ad session. Explain background status, `profile`, diagnostic `check`, `pause`, and `uninstall`; stopping or removing the runner comes before pausing or revoking consent.
