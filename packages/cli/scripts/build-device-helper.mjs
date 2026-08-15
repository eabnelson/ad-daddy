import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const nativeDirectory = resolve(scriptDirectory, "../dist/native");

if (process.platform === "darwin") {
  const packagePath = resolve(scriptDirectory, "../../device-key-helper");
  execFileSync("swift", ["build", "--package-path", packagePath, "-c", "release"], { stdio: "inherit" });
  const source = join(packagePath, ".build", "release", "ad-daddy-device-key-helper");
  const destination = join(nativeDirectory, "ad-daddy-device-key-helper");
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
  chmodSync(destination, 0o755);
} else {
  rmSync(nativeDirectory, { recursive: true, force: true });
}
