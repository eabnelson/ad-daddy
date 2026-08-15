import { PAYMENT_REQUEST_LIMITS, parseBoundedJson, RequestLimitError } from "../../../../../../lib/http/request-limits.ts";
import type { SignedConversionEvidence } from "../../../../../../lib/marketplace/attribution.ts";
import { getPaymentRuntime, type PaymentRuntime } from "../../../../../../lib/payments/runtime.ts";

export function createConversionHandler(injectedRuntime?: PaymentRuntime) {
  return async function handle(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const runtime = injectedRuntime ?? await getPaymentRuntime();
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const limit = runtime.rateLimit.check([`conversion-ip:${ip}`]);
    if (!limit.allowed) return rateLimited(limit.retryAfterSeconds);
    const { id } = await context.params;
    let body: { action: "submit" | "settle"; evidence?: SignedConversionEvidence };
    try { body = await parseBoundedJson(request, PAYMENT_REQUEST_LIMITS) as typeof body; }
    catch (error) { return limitError(error); }
    try {
      if (body.action === "submit" && body.evidence) {
        if (body.evidence.placementId !== id) return json(400, { error: "placement_mismatch" });
        const resourceLimit = runtime.rateLimit.check([`conversion-placement:${id}`, `conversion-provider:${body.evidence.provider}:${body.evidence.keyId}`]);
        if (!resourceLimit.allowed) return rateLimited(resourceLimit.retryAfterSeconds);
        return json(202, { conversion: runtime.attribution.submit(body.evidence) });
      }
      if (body.action === "settle") {
        if (request.headers.get("oai-operator-scope") !== "payment-events") return json(403, { error: "payment_operator_required" });
        return json(200, { conversion: await runtime.attribution.settle(id) });
      }
      return json(400, { error: "invalid_conversion_action" });
    } catch (error) { return json(409, { error: "conversion_rejected", message: boundedError(error) }); }
  };
}
export const POST = createConversionHandler();
function json(status: number, body: unknown) { return Response.json(body, { status }); }
function rateLimited(seconds: number) { return Response.json({ error: "rate_limited", retryAfterSeconds: seconds }, { status: 429, headers: { "retry-after": String(seconds) } }); }
function limitError(error: unknown) { return error instanceof RequestLimitError ? json(error.status, { error: error.code }) : json(400, { error: "invalid_request" }); }
function boundedError(error: unknown) { return (error instanceof Error ? error.message : "Conversion rejected").slice(0, 240); }
