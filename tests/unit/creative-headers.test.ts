import assert from "node:assert/strict";
import test from "node:test";

import nextConfig from "../../next.config.ts";

test("creative responses deny framing at the HTTP header boundary", async () => {
  const rules = await nextConfig.headers?.();
  const creative = rules?.find((rule) => rule.source === "/creative/:path*");
  assert.ok(creative);
  assert.equal(creative.headers.find((header) => header.key === "X-Frame-Options")?.value, "DENY");
  assert.match(
    creative.headers.find((header) => header.key === "Content-Security-Policy")?.value ?? "",
    /frame-ancestors 'none'/,
  );
});
