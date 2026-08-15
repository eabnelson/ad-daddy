export interface LaunchdHost {
  write(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
  bootstrap(label: string, path: string): Promise<void>;
  bootout(label: string): Promise<void>;
}

interface JobInput { installationId: string; cadenceMinutes: number }

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export class LaunchdScheduler {
  readonly #host: LaunchdHost;
  readonly #options: { homeDirectory: string; executablePath: string };
  constructor(host: LaunchdHost, options: { homeDirectory: string; executablePath: string }) {
    this.#host = host;
    this.#options = options;
  }

  preview(input: JobInput) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.installationId)) throw new Error("Invalid installation id");
    if (!Number.isSafeInteger(input.cadenceMinutes) || input.cadenceMinutes < 5) throw new Error("Invalid scheduler cadence");
    const label = `com.addaddy.receiver.${input.installationId}`;
    const path = `${this.#options.homeDirectory}/Library/LaunchAgents/${label}.plist`;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(this.#options.executablePath)}</string><string>check</string><string>--installation</string><string>${xml(input.installationId)}</string></array><key>StartInterval</key><integer>${input.cadenceMinutes * 60}</integer></dict></plist>\n`;
    return { label, path, plist };
  }

  async install(input: JobInput) {
    const job = this.preview(input);
    await this.#host.bootout(job.label).catch(() => undefined);
    await this.#host.write(job.path, job.plist);
    await this.#host.bootstrap(job.label, job.path);
    return job;
  }
  restart(input: JobInput) { return this.install(input); }
  async pause(installationId: string) { await this.#host.bootout(this.preview({ installationId, cadenceMinutes: 5 }).label).catch(() => undefined); }
  async uninstall(installationId: string) {
    const job = this.preview({ installationId, cadenceMinutes: 5 });
    await this.#host.bootout(job.label).catch(() => undefined);
    await this.#host.remove(job.path).catch(() => undefined);
  }
}
