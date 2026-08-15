import {
  D1DeviceEnrollmentRepository,
  DurableDeviceEnrollmentService,
} from "../../../../../lib/auth/device-enrollment.ts";
import type { HumanApproval } from "../../../../../lib/domain/types.ts";

type Clock = () => Date;

export function createEnrollmentGrantHandler(service?: DurableDeviceEnrollmentService, clock: Clock = () => new Date()) {
  return async function handle(request: Request): Promise<Response> {
    const accountId = request.headers.get("oai-authenticated-user-id");
    if (!accountId) return Response.json({ error: "human_authentication_required" }, { status: 401 });
    try {
      const body = await boundedJson(request) as Record<string, unknown>;
      if (typeof body.installationId !== "string" || typeof body.keyThumbprint !== "string" || !isRecord(body.approval)) {
        return Response.json({ error: "invalid_enrollment_grant_request" }, { status: 400 });
      }
      const grant = await (service ?? await deployedService()).issueGrant({
        accountId,
        installationId: body.installationId,
        keyThumbprint: body.keyThumbprint,
        approval: body.approval as unknown as HumanApproval,
        now: clock(),
      });
      return Response.json(grant, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
      return Response.json({ error: "enrollment_grant_rejected", message: boundedMessage(error) }, { status: 409 });
    }
  };
}

export const POST = createEnrollmentGrantHandler();

let cached: DurableDeviceEnrollmentService | undefined;
async function deployedService() {
  if (cached) return cached;
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("D1 enrollment binding is required");
  cached = new DurableDeviceEnrollmentService(new D1DeviceEnrollmentRepository(env.DB));
  return cached;
}

async function boundedJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 16_384) throw new Error("Enrollment request is too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 16_384) throw new Error("Enrollment request is too large");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Enrollment request must be an object");
  return parsed;
}

function boundedMessage(error: unknown) {
  return (error instanceof Error ? error.message : "Enrollment grant rejected").slice(0, 200);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
