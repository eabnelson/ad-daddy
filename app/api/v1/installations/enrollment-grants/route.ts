import {
  D1DeviceEnrollmentRepository,
  DurableDeviceEnrollmentService,
} from "../../../../../lib/auth/device-enrollment.ts";
import {
  approvalResourceFingerprint,
  D1ApprovalCapabilityRepository,
  type ApprovalCapabilityRepository,
} from "../../../../../lib/auth/approval-capability.ts";
import { verifiedAccountId } from "../../../../../lib/auth/verified-request-identity.ts";

type Clock = () => Date;

export function createEnrollmentGrantHandler(service?: DurableDeviceEnrollmentService, clock: Clock = () => new Date(), approvals?: ApprovalCapabilityRepository) {
  return async function handle(request: Request): Promise<Response> {
    const accountId = verifiedAccountId(request);
    if (!accountId) return Response.json({ error: "human_authentication_required" }, { status: 401 });
    try {
      const body = await boundedJson(request) as Record<string, unknown>;
      if (typeof body.installationId !== "string" || typeof body.keyThumbprint !== "string" || typeof body.approvalId !== "string") {
        return Response.json({ error: "invalid_enrollment_grant_request" }, { status: 400 });
      }
      const now = clock();
      const deployed = service && approvals ? undefined : await deployedServices();
      const approval = await (approvals ?? deployed!.approvals).consume({
        approvalId: body.approvalId,
        accountId,
        purpose: "device_enroll",
        resourceFingerprint: approvalResourceFingerprint({ installationId: body.installationId, keyThumbprint: body.keyThumbprint }),
        useId: `device-enroll:${body.installationId}:${body.keyThumbprint}`,
        now,
      });
      const grant = await (service ?? deployed!.enrollment).issueGrant({
        accountId,
        installationId: body.installationId,
        keyThumbprint: body.keyThumbprint,
        approval: { accountId, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt, purposes: ["device_enroll"] },
        now,
      });
      return Response.json(grant, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
      return Response.json({ error: "enrollment_grant_rejected", message: boundedMessage(error) }, { status: 409 });
    }
  };
}

export const POST = createEnrollmentGrantHandler();

let cached: { enrollment: DurableDeviceEnrollmentService; approvals: ApprovalCapabilityRepository } | undefined;
async function deployedServices() {
  if (cached) return cached;
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("D1 enrollment binding is required");
  cached = {
    enrollment: new DurableDeviceEnrollmentService(new D1DeviceEnrollmentRepository(env.DB)),
    approvals: new D1ApprovalCapabilityRepository(env.DB),
  };
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
