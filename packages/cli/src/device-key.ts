import { execFile as execFileCallback } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const REFERENCE_PATTERN = /^[A-Za-z0-9_:-]{1,512}$/;

export interface DeviceCredential {
  credentialReference: string;
  publicJwk: JsonWebKey;
  keyThumbprint: string;
  algorithm: "ES256";
  keyVersion: 1;
  provider: "macos-keychain" | "memory-test";
  productionCapable: boolean;
}

export interface DeviceKeyProvider {
  createOrLoad(installationId: string): Promise<DeviceCredential>;
  sign(credentialReference: string, payload: Uint8Array): Promise<Uint8Array>;
  assertProductionEnrollment(): void;
}

export class InMemoryDeviceKeyProvider implements DeviceKeyProvider {
  readonly #keys = new Map<string, CryptoKeyPair>();

  async createOrLoad(installationId: string): Promise<DeviceCredential> {
    assertInstallationId(installationId);
    const credentialReference = `memory:${installationId}`;
    let pair = this.#keys.get(credentialReference);
    if (!pair) {
      pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      this.#keys.set(credentialReference, pair);
    }
    const publicJwk = publicOnly(await crypto.subtle.exportKey("jwk", pair.publicKey));
    return Object.freeze({
      credentialReference,
      publicJwk,
      keyThumbprint: await jwkThumbprint(publicJwk),
      algorithm: "ES256",
      keyVersion: 1,
      provider: "memory-test",
      productionCapable: false,
    });
  }

  async sign(credentialReference: string, payload: Uint8Array): Promise<Uint8Array> {
    const pair = this.#keys.get(credentialReference);
    if (!pair) throw new Error("Unknown in-memory device credential reference");
    return new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      toArrayBuffer(payload),
    ));
  }

  assertProductionEnrollment(): void {
    throw new Error("The in-memory device key provider is test-only and cannot enroll a production installation");
  }
}

export type DeviceKeyHelperRunner = (arguments_: readonly string[]) => Promise<string>;

export class MacOSDeviceKeyProvider implements DeviceKeyProvider {
  readonly #platform: NodeJS.Platform;
  readonly #runHelper: DeviceKeyHelperRunner;

  constructor(input: {
    platform?: NodeJS.Platform;
    helperPath?: string;
    runHelper?: DeviceKeyHelperRunner;
  } = {}) {
    this.#platform = input.platform ?? process.platform;
    const helperPath = input.helperPath ?? defaultHelperPath();
    this.#runHelper = input.runHelper ?? (async (arguments_) => {
      const { stdout } = await execFile(helperPath, [...arguments_], { timeout: 30_000, maxBuffer: 64 * 1024 });
      return stdout;
    });
  }

  async createOrLoad(installationId: string): Promise<DeviceCredential> {
    this.assertMacOS();
    assertInstallationId(installationId);
    const label = `com.addaddy.device.${installationId}`;
    const output = parseHelperOutput(await this.#runHelper(["create-or-load", "--label", label]));
    const publicJwk = publicOnly(output.publicJwk);
    const keyThumbprint = await jwkThumbprint(publicJwk);
    return Object.freeze({
      credentialReference: output.credentialReference,
      publicJwk,
      keyThumbprint,
      algorithm: "ES256",
      keyVersion: 1,
      provider: "macos-keychain",
      productionCapable: true,
    });
  }

  async sign(credentialReference: string, payload: Uint8Array): Promise<Uint8Array> {
    this.assertMacOS();
    if (!REFERENCE_PATTERN.test(credentialReference)) throw new Error("Device credential reference is invalid");
    const output = parseSignatureOutput(await this.#runHelper([
      "sign-message",
      "--credential-reference", credentialReference,
      "--message", encodeBase64Url(payload),
    ]));
    return derEcdsaSignatureToRaw(decodeBase64Url(output.signatureDer));
  }

  assertProductionEnrollment(): void {
    this.assertMacOS();
  }

  private assertMacOS(): void {
    if (this.#platform !== "darwin") throw new Error("Production device enrollment requires the bundled macOS Keychain helper");
  }
}

/** Converts Security.framework's X9.62/DER signature into the 64-byte JOSE/WebCrypto ES256 wire form. */
export function derEcdsaSignatureToRaw(der: Uint8Array): Uint8Array {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error("Malformed X9.62 DER signature sequence");
  const sequence = readDerLength(der, offset);
  offset = sequence.next;
  if (sequence.length !== der.length - offset) throw new Error("Malformed X9.62 DER signature length");
  const r = readDerInteger(der, offset);
  const s = readDerInteger(der, r.next);
  if (s.next !== der.length) throw new Error("Malformed X9.62 DER signature trailing bytes");
  const raw = new Uint8Array(64);
  raw.set(normalizeScalar(r.bytes), 0);
  raw.set(normalizeScalar(s.bytes), 32);
  return raw;
}

function readDerInteger(input: Uint8Array, offset: number): { bytes: Uint8Array; next: number } {
  if (input[offset++] !== 0x02) throw new Error("Malformed X9.62 DER signature integer");
  const size = readDerLength(input, offset);
  offset = size.next;
  if (size.length < 1 || offset + size.length > input.length) throw new Error("Malformed X9.62 DER signature integer length");
  const bytes = input.slice(offset, offset + size.length);
  if ((bytes[0] & 0x80) !== 0 || (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0)) {
    throw new Error("Malformed X9.62 DER signature integer encoding");
  }
  return { bytes, next: offset + size.length };
}

function readDerLength(input: Uint8Array, offset: number): { length: number; next: number } {
  const first = input[offset++];
  if (first === undefined) throw new Error("Malformed X9.62 DER signature length");
  if ((first & 0x80) === 0) return { length: first, next: offset };
  const count = first & 0x7f;
  if (count < 1 || count > 2 || offset + count > input.length) throw new Error("Malformed X9.62 DER signature length");
  let length = 0;
  for (let index = 0; index < count; index += 1) length = (length << 8) | input[offset + index];
  if (length < 128) throw new Error("Malformed X9.62 DER signature non-minimal length");
  return { length, next: offset + count };
}

function normalizeScalar(input: Uint8Array): Uint8Array {
  const scalar = input.length === 33 && input[0] === 0 ? input.slice(1) : input;
  if (scalar.length > 32) throw new Error("Malformed X9.62 DER signature scalar size");
  const output = new Uint8Array(32);
  output.set(scalar, 32 - scalar.length);
  return output;
}

function parseHelperOutput(value: string): { credentialReference: string; publicJwk: JsonWebKey } {
  const parsed = parseJsonRecord(value);
  if (typeof parsed.credentialReference !== "string" || !REFERENCE_PATTERN.test(parsed.credentialReference)) {
    throw new Error("Device key helper returned an invalid credential reference");
  }
  if (!parsed.publicJwk || typeof parsed.publicJwk !== "object" || Array.isArray(parsed.publicJwk)) {
    throw new Error("Device key helper returned an invalid public key");
  }
  return { credentialReference: parsed.credentialReference, publicJwk: parsed.publicJwk as JsonWebKey };
}

function parseSignatureOutput(value: string): { signatureDer: string } {
  const parsed = parseJsonRecord(value);
  if (typeof parsed.signatureDer !== "string" || !/^[A-Za-z0-9_-]{8,256}$/.test(parsed.signatureDer)) {
    throw new Error("Device key helper returned an invalid signature");
  }
  return { signatureDer: parsed.signatureDer };
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* fail below */ }
  throw new Error("Device key helper returned malformed JSON");
}

function publicOnly(jwk: JsonWebKey): JsonWebKey {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string" || jwk.d !== undefined) {
    throw new Error("Device key must expose only an EC P-256 public JWK");
  }
  return Object.freeze({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y });
}

async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y });
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))));
}

function defaultHelperPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "native", "ad-daddy-device-key-helper");
}

function assertInstallationId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error("Installation ID is invalid");
}

function encodeBase64Url(input: Uint8Array): string {
  return Buffer.from(input).toString("base64url");
}

function decodeBase64Url(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64url"));
}

function toArrayBuffer(input: Uint8Array): ArrayBuffer {
  return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
}
