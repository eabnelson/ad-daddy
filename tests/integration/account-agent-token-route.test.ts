import assert from "node:assert/strict";
import test from "node:test";

import { createAccountAgentTokenHandler } from "../../app/api/v1/account-agent-token/route.ts";
import { VERIFIED_ACCOUNT_ID_HEADER } from "../../lib/auth/verified-request-identity.ts";

test("account agent token issuance consumes only the verified internal account claim", async () => {
  const issuedFor: string[] = [];
  const handler = createAccountAgentTokenHandler(async (accountId) => {
    issuedFor.push(accountId);
    return "issued-token";
  });
  const body = JSON.stringify({ scopes: ["placement:read"], expiresAt: "2026-08-17T16:05:00.000Z" });

  const forged = await handler(new Request("https://ad.daddy/api/v1/account-agent-token", {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-id": "victim" },
    body,
  }));
  assert.equal(forged.status, 401);
  assert.deepEqual(issuedFor, []);

  const verified = await handler(new Request("https://ad.daddy/api/v1/account-agent-token", {
    method: "POST",
    headers: { "content-type": "application/json", [VERIFIED_ACCOUNT_ID_HEADER]: "account_owner" },
    body,
  }));
  assert.equal(verified.status, 201);
  assert.deepEqual(issuedFor, ["account_owner"]);
  assert.deepEqual(await verified.json(), { token: "issued-token", expiresAt: "2026-08-17T16:05:00.000Z" });
});
