/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { deployedSponsorshipRuntime } from "../lib/marketplace/sponsorship-runtime.ts";
import { drainExpiryBatches } from "../lib/marketplace/expiry-drain.ts";
import { dispatchWithVerifiedRequestIdentity } from "../lib/auth/verified-request-identity.ts";
import { createTeamModeHandler } from "../app/api/team/route.ts";
import { D1TeamModeStore } from "../lib/team-mode/d1-store.ts";
import { TeamModeService } from "../lib/team-mode/service.ts";
import { TEAM_MODE_KEY_ID, TEAM_MODE_PRIVATE_KEY_PEM, TEAM_MODE_PUBLIC_KEY_PEM } from "../lib/team-mode/signing-key.ts";

interface Env {
  AUCTION_SERVICE: Fetcher;
  ASSETS: Fetcher;
  DB: D1Database;
  AD_DADDY_ENV: "development" | "test" | "staging" | "production";
  AD_DADDY_MEMO_SALT: string;
  AD_DADDY_PAYMENT_EVENT_SECRET: string;
  AD_DADDY_CAMPAIGN_TOKEN_SECRET: string;
  AD_DADDY_LAUNCH_POLICY_JSON: string;
  AD_DADDY_ACCOUNT_AGENT_TOKEN_SECRET: string;
  AD_DADDY_IDENTITY_ASSERTION_SECRET: string;
  AD_DADDY_OPERATOR_ACCOUNT_IDS: string;
  AD_DADDY_INVITE_CODE?: string;
  AD_DADDY_TEAM_KEY?: string;
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

let teamModeRuntime: {
  db: D1Database;
  inviteCode?: string;
  memberTokenSecret?: string;
  handler: ReturnType<typeof createTeamModeHandler>;
} | undefined;

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return dispatchWithVerifiedRequestIdentity(request, env.AD_DADDY_IDENTITY_ASSERTION_SECRET, async (verifiedRequest) => {
      request = verifiedRequest;
      const url = new URL(request.url);

      if (url.pathname === "/api/team") {
        if (env.AD_DADDY_ENV !== "development") return Response.json({ error: "private_team_mode_is_development_only" }, { status: 404 });
        return privateTeamHandler(env)(request);
      }

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
    });
  },
  async scheduled(_controller: unknown, _env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const runtime = await deployedSponsorshipRuntime();
      await drainExpiryBatches(runtime.service, new Date());
    })());
  },
};

export default worker;

function privateTeamHandler(env: Env) {
  if (
    !teamModeRuntime ||
    teamModeRuntime.db !== env.DB ||
    teamModeRuntime.inviteCode !== env.AD_DADDY_INVITE_CODE ||
    teamModeRuntime.memberTokenSecret !== env.AD_DADDY_TEAM_KEY
  ) {
    const service = new TeamModeService(new D1TeamModeStore(env.DB), {
      keyId: TEAM_MODE_KEY_ID,
      privateKeyPem: TEAM_MODE_PRIVATE_KEY_PEM,
      publicKeyPem: TEAM_MODE_PUBLIC_KEY_PEM,
    });
    teamModeRuntime = {
      db: env.DB,
      inviteCode: env.AD_DADDY_INVITE_CODE,
      memberTokenSecret: env.AD_DADDY_TEAM_KEY,
      handler: createTeamModeHandler({
        service,
        inviteCode: env.AD_DADDY_INVITE_CODE,
        memberTokenSecret: env.AD_DADDY_TEAM_KEY,
        environment: env.AD_DADDY_ENV,
      }),
    };
  }
  return teamModeRuntime.handler;
}
