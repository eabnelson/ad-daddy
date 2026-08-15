declare namespace Cloudflare {
  interface Env {
    AUCTION_SERVICE: Fetcher;
    DB: D1Database;
    AD_DADDY_ENV: "test" | "staging" | "production";
    /** Wrangler secret. Never configure this value under `vars`. */
    AD_DADDY_MEMO_SALT: string;
    /** Private indexer HMAC secret. Never configure this value under `vars`. */
    AD_DADDY_PAYMENT_EVENT_SECRET: string;
  }
}
