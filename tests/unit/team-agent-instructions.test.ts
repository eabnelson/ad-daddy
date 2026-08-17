import assert from "node:assert/strict";
import test from "node:test";

import { buildTeamAgentInstructions } from "../../lib/team-mode/agent-instructions.ts";

test("hosted agent instructions are origin-bound and cover both marketplace roles", () => {
  const markdown = buildTeamAgentInstructions("https://ads.example.com");
  assert.match(markdown, /^# Ad Daddy/m);
  assert.match(markdown, /https:\/\/ads\.example\.com\/api\/team/);
  assert.match(markdown, /join/);
  assert.match(markdown, /invite code/i);
  assert.doesNotMatch(markdown, /Team key/i);
  assert.match(markdown, /profile/);
  assert.match(markdown, /browse_ads/);
  assert.match(markdown, /create_ad/);
  assert.match(markdown, /no cash value/i);
  assert.match(markdown, /AD DADDY: <sponsor message>/);
  assert.match(markdown, /Existing member token/);
  assert.match(markdown, /setup --json '<SETUP_JSON>'/);
  assert.match(markdown, /AD_DADDY_PRIVATE_TEAM_MODE=1/);
  assert.doesNotMatch(markdown, /localhost/);
});
