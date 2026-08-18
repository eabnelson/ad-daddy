import assert from "node:assert/strict";
import test from "node:test";

import { buildTeamAgentInstructions } from "../../lib/team-mode/agent-instructions.ts";

test("hosted agent instructions are origin-bound and cover both marketplace roles", () => {
  const markdown = buildTeamAgentInstructions("https://ads.example.com");
  assert.match(markdown, /^# Ad Daddy/m);
  assert.match(markdown, /https:\/\/ads\.example\.com\/api\/team/);
  assert.match(markdown, /join/);
  assert.match(markdown, /invite code/i);
  assert.match(markdown, /AD_DADDY_INVITE_CODE/);
  assert.match(markdown, /outside the agent conversation/i);
  assert.doesNotMatch(markdown, /--invite-code/);
  assert.doesNotMatch(markdown, /Team key/i);
  assert.match(markdown, /profile/);
  assert.match(markdown, /team ads browse/);
  assert.match(markdown, /team ads send/);
  assert.match(markdown, /no cash value/i);
  assert.match(markdown, /AD DADDY: <sponsor message>/);
  assert.match(markdown, /ad-daddy team join/);
  assert.match(markdown, /ad-daddy team actions/);
  assert.match(markdown, /packages\/ad-daddy-skill/);
  assert.match(markdown, /team profile show/);
  assert.match(markdown, /team advertiser show/);
  assert.match(markdown, /team people list/);
  assert.match(markdown, /team ads send/);
  assert.match(markdown, /team receiver setup/);
  assert.match(markdown, /team receiver setup --confirm --accept-disclosure --accept-terms --accept-privacy/);
  assert.match(markdown, /Receiver delivery is currently supported only inside Codex/);
  assert.match(markdown, /Never infer or pre-fill those acceptances/);
  assert.match(markdown, /team check/);
  assert.match(markdown, /browser is optional/i);
  assert.doesNotMatch(markdown, /Existing member token/);
  assert.doesNotMatch(markdown, /paste.*token/i);
  assert.doesNotMatch(markdown, /localhost/);
});
