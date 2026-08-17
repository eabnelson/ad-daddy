import { buildTeamAgentInstructions } from "../../lib/team-mode/agent-instructions.ts";

export async function GET(request: Request) {
  return new Response(buildTeamAgentInstructions(new URL(request.url).origin), {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "text/markdown; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
