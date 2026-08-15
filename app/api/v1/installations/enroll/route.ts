import {
  D1DeviceEnrollmentRepository,
  DurableDeviceEnrollmentService,
} from "../../../../../lib/auth/device-enrollment.ts";

type Clock = () => Date;

export function createEnrollmentHandler(service?: DurableDeviceEnrollmentService, clock: Clock = () => new Date()) {
  return async function handle(request: Request): Promise<Response> {
    try {
      const body = await boundedJson(request) as Record<string, unknown>;
      if (
        typeof body.grantToken !== "string" || typeof body.installationId !== "string" ||
        typeof body.hostKind !== "string" || typeof body.algorithm !== "string" ||
        typeof body.keyVersion !== "number" || typeof body.keyThumbprint !== "string" ||
        !body.publicJwk || typeof body.publicJwk !== "object" || Array.isArray(body.publicJwk)
      ) return Response.json({ error: "invalid_enrollment_request" }, { status: 400 });
      const enrolled = await (service ?? await deployedService()).enroll({
        grantToken: body.grantToken,
        installationId: body.installationId,
        hostKind: body.hostKind,
        algorithm: body.algorithm,
        keyVersion: body.keyVersion,
        publicJwk: body.publicJwk as JsonWebKey,
        keyThumbprint: body.keyThumbprint,
        now: clock(),
      });
      return Response.json({
        installationId: enrolled.installationId,
        accountId: enrolled.accountId,
        status: enrolled.status,
        algorithm: enrolled.algorithm,
        keyVersion: enrolled.keyVersion,
        keyThumbprint: enrolled.keyThumbprint,
        enrolledAt: enrolled.enrolledAt,
      }, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
      return Response.json({ error: "device_enrollment_rejected", message: boundedMessage(error) }, { status: 409 });
    }
  };
}

export const POST = createEnrollmentHandler();

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
  return (error instanceof Error ? error.message : "Device enrollment rejected").slice(0, 200);
}
