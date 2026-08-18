import { createHmac, timingSafeEqual } from "node:crypto";

import { MemoryTeamModeStore, TeamModeInfrastructureError, TeamModeNotFoundError, TeamModeService } from "../../../lib/team-mode/service.ts";
import { TEAM_MODE_KEY_ID, TEAM_MODE_PRIVATE_KEY_PEM, TEAM_MODE_PUBLIC_KEY_PEM } from "../../../lib/team-mode/signing-key.ts";

const MAX_BODY_BYTES = 16_384;

interface TeamModeRuntime {
  service: TeamModeService;
  inviteCode?: string;
  memberTokenSecret?: string;
  environment?: string;
}

export const localTeamModeService = new TeamModeService(new MemoryTeamModeStore(), {
  keyId: TEAM_MODE_KEY_ID,
  privateKeyPem: TEAM_MODE_PRIVATE_KEY_PEM,
  publicKeyPem: TEAM_MODE_PUBLIC_KEY_PEM,
});

export function createTeamModeHandler(runtime: TeamModeRuntime = {
  service: localTeamModeService,
  inviteCode: process.env.AD_DADDY_INVITE_CODE,
  memberTokenSecret: process.env.AD_DADDY_TEAM_KEY,
  environment: process.env.AD_DADDY_ENV,
}) {
  return async function handle(request: Request): Promise<Response> {
    if (runtime.environment !== "development" && runtime.environment !== "hosted_test") {
      return json(404, { error: "private_team_mode_is_test_only" });
    }
    if (!runtime.inviteCode || runtime.inviteCode.length < 8 || !runtime.memberTokenSecret || runtime.memberTokenSecret.length < 16) {
      return json(503, { error: "team_mode_not_configured" });
    }
    let body: Record<string, unknown>;
    try { body = await boundedBody(request); }
    catch (error) { return json(400, { error: "invalid_team_request", message: message(error) }); }
    try {
      if (body.action === "join") {
        if (!authorizeInvite(request, runtime.inviteCode)) return json(401, { error: "invalid_invite_code" });
        const joined = await runtime.service.join({ displayName: body.displayName, tags: body.tags, receivesAds: body.receivesAds });
        return json(201, {
          member: joined.member,
          accessToken: memberAccessToken(runtime.memberTokenSecret, joined.memberKey),
          publicKeyPem: runtime.service.publicKey(),
        });
      }
      const memberKey = authorizeMember(request, runtime.memberTokenSecret);
      if (!memberKey) return json(401, { error: "member_capability_required" });
      if (body.action === "profile") return json(200, { member: await runtime.service.updateProfile({
        memberKey, displayName: body.displayName, tags: body.tags, receivesAds: body.receivesAds,
      }) });
      if (body.action === "profile_status") return json(200, { member: await runtime.service.profile(memberKey) });
      if (body.action === "people") return json(200, { people: await runtime.service.people(memberKey) });
      if (body.action === "advertiser_profile") return json(200, await runtime.service.advertiserProfile(memberKey));
      if (body.action === "my_ads") return json(200, { ads: await runtime.service.memberAds(memberKey) });
      if (body.action === "create_ad") return json(201, { ad: await runtime.service.createAd({
        memberKey, title: body.title, body: body.body, targetTags: body.targetTags, points: body.points,
      }) });
      if (body.action === "poll" || (body.action === undefined && typeof body.installationId === "string")) {
        return json(200, await runtime.service.poll({ memberKey, installationId: body.installationId }));
      }
      if (body.action === "ack") return json(200, { delivery: await runtime.service.acknowledge({ memberKey, deliveryId: body.deliveryId }) });
      if (body.action === "browse_ads") return json(200, { matches: await runtime.service.browseAds(memberKey) });
      if (body.action === "status") return json(200, { ...(await runtime.service.status(memberKey)), publicKeyPem: runtime.service.publicKey() });
      return json(400, { error: "unknown_team_action" });
    } catch (error) {
      if (error instanceof TeamModeNotFoundError) return json(404, { error: "team_resource_not_found", message: message(error) });
      if (error instanceof TeamModeInfrastructureError) return json(503, { error: "team_mode_unavailable" });
      return json(400, { error: "team_request_rejected", message: message(error) });
    }
  };
}

export const POST = createTeamModeHandler();

async function boundedBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method !== "POST" || request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") throw new Error("Expected a JSON POST");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("Team request is too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("Team request is too large");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Team request must be an object");
  return value as Record<string, unknown>;
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

function authorizeInvite(request: Request, inviteCode: string): boolean {
  return safeEqual(bearerToken(request), inviteCode);
}

function authorizeMember(request: Request, memberTokenSecret: string): string | undefined {
  const supplied = bearerToken(request);
  const [prefix, memberKey, signature, ...extra] = supplied.split(".");
  if (prefix !== "member" || !memberKey || !signature || extra.length || !/^[A-Za-z0-9_-]{32,128}$/.test(memberKey)) return undefined;
  const expectedSignature = memberTokenSignature(memberTokenSecret, memberKey);
  return safeEqual(signature, expectedSignature) ? memberKey : undefined;
}

function memberAccessToken(memberTokenSecret: string, memberKey: string): string {
  return `member.${memberKey}.${memberTokenSignature(memberTokenSecret, memberKey)}`;
}

function memberTokenSignature(memberTokenSecret: string, memberKey: string): string {
  return createHmac("sha256", memberTokenSecret).update(memberKey).digest("base64url");
}

function safeEqual(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(status: number, body: unknown) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function message(error: unknown) { return (error instanceof Error ? error.message : "Request rejected").slice(0, 240); }
