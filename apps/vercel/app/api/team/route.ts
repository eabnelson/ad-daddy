import { neon } from "@neondatabase/serverless";

import { createTeamModeHandler } from "../../../../../app/api/team/route.ts";
import { PostgresTeamModeStore, type TeamPostgresQuery } from "../../../../../lib/team-mode/postgres-store.ts";
import { TeamModeService } from "../../../../../lib/team-mode/service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let handler: ReturnType<typeof createTeamModeHandler> | undefined;

export async function POST(request: Request) {
  try {
    handler ??= createHostedHandler();
    return handler(request);
  } catch {
    return Response.json({ error: "hosted_team_mode_not_configured" }, { status: 503 });
  }
}

function createHostedHandler() {
  const databaseUrl = required("DATABASE_URL");
  const sql = neon(databaseUrl);
  const query: TeamPostgresQuery = async <T extends Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) => {
    return await sql.query(text, [...parameters]) as T[];
  };
  const service = new TeamModeService(new PostgresTeamModeStore(query), {
    keyId: process.env.AD_DADDY_TEAM_SIGNING_KEY_ID || "team_vercel_v1",
    privateKeyPem: pem("AD_DADDY_TEAM_SIGNING_PRIVATE_KEY_PEM"),
    publicKeyPem: pem("AD_DADDY_TEAM_SIGNING_PUBLIC_KEY_PEM"),
  });
  return createTeamModeHandler({
    service,
    inviteCode: required("AD_DADDY_INVITE_CODE"),
    memberTokenSecret: required("AD_DADDY_TEAM_KEY"),
    environment: "hosted_test",
  });
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function pem(name: string) {
  const value = required(name).replaceAll("\\n", "\n");
  if (!value.includes("-----BEGIN")) throw new Error(`${name} must be a PEM key`);
  return value;
}
