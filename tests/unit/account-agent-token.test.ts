import assert from "node:assert/strict";
import test from "node:test";

import { AccountAgentTokenService, authenticateAccountBearer } from "../../lib/auth/account-agent-token.ts";

test("account agent tokens are stable across service reconstruction and scope-bound", async () => {
  const now = new Date("2026-08-15T20:00:00.000Z");
  const secret = "a".repeat(32);
  const token = await new AccountAgentTokenService(secret).issue({
    accountId: "account_1", scopes: ["campaign:manage"], expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  }, now);
  const restarted = new AccountAgentTokenService(secret);
  assert.equal((await restarted.verify(token, "campaign:manage", now)).accountId, "account_1");
  await assert.rejects(restarted.verify(token, "placement:act", now), /scope/i);
  await assert.rejects(new AccountAgentTokenService("b".repeat(32)).verify(token, "campaign:manage", now), /signature/i);
  await assert.rejects(new AccountAgentTokenService(secret).issue({
    accountId: "account_1", scopes: ["campaign:manage"], expiresAt: new Date(now.getTime() + 16 * 60_000).toISOString(),
  }, now), /15 minutes/i);
});

test("invalid, expired, and scope-mismatched bearer tokens authenticate as absent", async () => {
  const now = new Date();
  const service = new AccountAgentTokenService("a".repeat(32));
  const expired = await service.issue({
    accountId: "account_1",
    scopes: ["campaign:manage"],
    expiresAt: new Date(now.getTime() + 1_000).toISOString(),
  }, now);
  assert.equal(await authenticateAccountBearer("not-a-token", "campaign:manage", service), undefined);
  assert.equal(await authenticateAccountBearer(expired, "placement:read", service), undefined);
  assert.equal(await authenticateAccountBearer(expired, "campaign:manage", service), "account_1");
});
