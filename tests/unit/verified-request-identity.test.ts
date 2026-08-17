import assert from "node:assert/strict";
import test from "node:test";

import {
  RequestIdentityAssertionService,
  REQUEST_IDENTITY_ASSERTION_HEADER,
  VERIFIED_ACCOUNT_EMAIL_HEADER,
  VERIFIED_ACCOUNT_ID_HEADER,
  dispatchWithVerifiedRequestIdentity,
} from "../../lib/auth/verified-request-identity.ts";

const NOW = new Date("2026-08-17T16:00:00.000Z");
const SECRET = "identity-boundary-secret-value-1234567890";

test("forged public identity headers are rejected before application dispatch", async () => {
  let dispatched = false;
  const response = await dispatchWithVerifiedRequestIdentity(
    new Request("https://ad.daddy/api/v1/account-agent-token", {
      method: "POST",
      headers: { "oai-authenticated-user-id": "victim_account" },
    }),
    SECRET,
    async () => {
      dispatched = true;
      return new Response("should not dispatch");
    },
    NOW,
  );

  assert.equal(response.status, 401);
  assert.equal(dispatched, false);
  assert.deepEqual(await response.json(), { error: "verified_identity_required" });
});

test("a valid gateway assertion becomes the sole internal account claim", async () => {
  const url = "https://ad.daddy/api/v1/account-agent-token";
  const assertion = await new RequestIdentityAssertionService(SECRET).issue({
    accountId: "account_owner",
    email: "owner@example.com",
    method: "POST",
    pathname: "/api/v1/account-agent-token",
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  }, NOW);
  let dispatched = false;
  const response = await dispatchWithVerifiedRequestIdentity(
    new Request(url, { method: "POST", headers: { [REQUEST_IDENTITY_ASSERTION_HEADER]: assertion } }),
    SECRET,
    async (request) => {
      dispatched = true;
      assert.equal(request.headers.get(VERIFIED_ACCOUNT_ID_HEADER), "account_owner");
      assert.equal(request.headers.get(VERIFIED_ACCOUNT_EMAIL_HEADER), "owner@example.com");
      assert.equal(request.headers.has(REQUEST_IDENTITY_ASSERTION_HEADER), false);
      assert.equal(request.headers.has("oai-authenticated-user-id"), false);
      return new Response("verified");
    },
    NOW,
  );

  assert.equal(response.status, 200);
  assert.equal(dispatched, true);
});

test("an assertion cannot be replayed against another route or method", async () => {
  const assertion = await new RequestIdentityAssertionService(SECRET).issue({
    accountId: "account_owner",
    method: "POST",
    pathname: "/api/v1/account-agent-token",
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  }, NOW);
  let dispatchCount = 0;
  const dispatch = async () => {
    dispatchCount += 1;
    return new Response("unexpected");
  };

  const wrongMethod = await dispatchWithVerifiedRequestIdentity(
    new Request("https://ad.daddy/api/v1/account-agent-token", { headers: { [REQUEST_IDENTITY_ASSERTION_HEADER]: assertion } }),
    SECRET,
    dispatch,
    NOW,
  );
  const wrongPath = await dispatchWithVerifiedRequestIdentity(
    new Request("https://ad.daddy/api/v1/ledger", { method: "POST", headers: { [REQUEST_IDENTITY_ASSERTION_HEADER]: assertion } }),
    SECRET,
    dispatch,
    NOW,
  );

  assert.equal(wrongMethod.status, 401);
  assert.equal(wrongPath.status, 401);
  assert.equal(dispatchCount, 0);
});
