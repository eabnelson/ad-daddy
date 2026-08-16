/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { deployedSponsorshipRuntime } from "../lib/marketplace/sponsorship-runtime.ts";
import { drainExpiryBatches } from "../lib/marketplace/expiry-drain.ts";

interface Env {
  AUCTION_SERVICE: Fetcher;
  ASSETS: Fetcher;
  DB: D1Database;
  AD_DADDY_ENV: "test" | "staging" | "production";
  AD_DADDY_MEMO_SALT: string;
  AD_DADDY_PAYMENT_EVENT_SECRET: string;
  AD_DADDY_CAMPAIGN_TOKEN_SECRET: string;
  AD_DADDY_LAUNCH_POLICY_JSON: string;
  AD_DADDY_ACCOUNT_AGENT_TOKEN_SECRET: string;
  AD_DADDY_OPERATOR_ACCOUNT_IDS: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/v1/payments/deposits" && request.headers.has("oai-operator-scope")) {
      return Response.json({ error: "private_payment_event_capability_required" }, { status: 403 });
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(_controller: unknown, _env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const runtime = await deployedSponsorshipRuntime();
      await drainExpiryBatches(runtime.service, new Date());
    })());
  },
};

export default worker;
