import { generateKeyPairSync, randomBytes } from "node:crypto";

const pair = generateKeyPairSync("ed25519");
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim().replaceAll("\n", "\\n");
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString().trim().replaceAll("\n", "\\n");

process.stdout.write([
  `AD_DADDY_TEAM_KEY=${randomBytes(32).toString("base64url")}`,
  "AD_DADDY_TEAM_SIGNING_KEY_ID=team_vercel_v1",
  `AD_DADDY_TEAM_SIGNING_PRIVATE_KEY_PEM="${privateKey}"`,
  `AD_DADDY_TEAM_SIGNING_PUBLIC_KEY_PEM="${publicKey}"`,
  "",
].join("\n"));
