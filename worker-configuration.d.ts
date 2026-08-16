declare namespace Cloudflare {
  interface Env {
    AUCTION_SERVICE: Fetcher;
    DB: D1Database;
    AD_DADDY_ENV: "test" | "staging" | "production";
    /** Wrangler secret. Never configure this value under `vars`. */
    AD_DADDY_MEMO_SALT: string;
    /** Private indexer HMAC secret. Never configure this value under `vars`. */
    AD_DADDY_PAYMENT_EVENT_SECRET: string;
    /** Stable HMAC secret for short-lived advertiser agent tokens. Wrangler secret only. */
    AD_DADDY_CAMPAIGN_TOKEN_SECRET: string;
    /** Complete versioned launch policy JSON. */
    AD_DADDY_LAUNCH_POLICY_JSON: string;
    /** Stable HMAC secret for human-issued account agent sessions. Wrangler secret only. */
    AD_DADDY_ACCOUNT_AGENT_TOKEN_SECRET: string;
    AD_DADDY_OPERATOR_ACCOUNT_IDS: string;
    /** Ed25519 PKCS#8 PEM used for device-bound grants and inert placements. Wrangler secret only. */
    AD_DADDY_SPONSORSHIP_SIGNING_PRIVATE_KEY: string;
    /** Identifier for the corresponding published sponsorship verification key. */
    AD_DADDY_SPONSORSHIP_SIGNING_KEY_ID: string;
  }
}
