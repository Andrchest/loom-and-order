import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

export const TOOLCHAIN_PI_BIN = "${LAO_TOOLCHAIN_DIR}/node_modules/.bin/pi";
export const TOOLCHAIN_EXTENSION_ROOT = "${LAO_TOOLCHAIN_DIR}/node_modules";

export const TOOLCHAIN_PACKAGES = {
  "@earendil-works/pi-coding-agent": "latest",
  "pi-quiet-tools": "latest",
  "@pedro_klein/pi-auto-retry": "latest",
  "pi-smart-fetch": "latest",
  "pi-mcp-adapter": "latest",
  "@romansix/pi-tmux": "latest",
} as const;

export const TOOLCHAIN_EXTENSIONS = {
  quietTools: "pi-quiet-tools/src/index.ts",
  autoRetry: "@pedro_klein/pi-auto-retry/src/index.ts",
  smartFetch: "pi-smart-fetch/dist/index.js",
  mcpAdapter: "pi-mcp-adapter/index.ts",
  tmux: "@romansix/pi-tmux/extensions",
} as const;

const NODE_MAJOR = 24;
const NODE_MIN_MINOR = 18;
const UPDATE_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

export interface ToolchainStatus {
  generation: string;
  directory: string;
  nodeVersion: string;
  piVersion: string;
  packages: Record<string, string>;
  installedAt: string;
  checkedAt: string;
  lastError?: string;
}

interface StoredToolchainStatus extends ToolchainStatus {
  generationPath: string;
}

interface NodeRelease {
  version: string;
  lts: string | false;
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code ?? signal}: ${stderr.slice(-4000)}`));
    });
  });
}

function writeJsonAtomically(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function nodePlatform(): { platform: string; arch: string } {
  const platform = process.platform === "linux" || process.platform === "darwin" ? process.platform : null;
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : null;
  if (!platform || !arch) throw new Error(`unsupported Node toolchain platform: ${process.platform}/${process.arch}`);
  return { platform, arch };
}

function parseVersion(version: string): [number, number, number] {
  const match = version.match(/^v(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`invalid Node release version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isSupportedNodeRelease(release: NodeRelease): boolean {
  const [major, minor] = parseVersion(release.version);
  return major === NODE_MAJOR && minor >= NODE_MIN_MINOR && Boolean(release.lts);
}

function loadJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { return null; }
}

export class ToolchainManager {
  readonly root: string;
  readonly generationsDir: string;
  readonly activePath: string;
  readonly lockPath: string;
  readonly env: NodeJS.ProcessEnv;
  private active: StoredToolchainStatus | null;
  private readonly hostPath: string;

  constructor(stateDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.root = join(resolve(stateDir), "toolchain");
    this.generationsDir = join(this.root, "generations");
    this.activePath = join(this.root, "active.json");
    this.lockPath = join(this.root, ".update.lock");
    this.env = { ...env };
    this.hostPath = this.env.PATH ?? "";
    mkdirSync(this.generationsDir, { recursive: true, mode: 0o700 });
    this.active = this.readActive();
    this.activateEnvironment();
  }

  status(): ToolchainStatus | null {
    const current = this.readActive();
    if (!current) return null;
    this.active = current;
    this.activateEnvironment();
    return this.publicStatus(current);
  }

  async ensureFresh(): Promise<ToolchainStatus> {
    const current = this.status();
    if (this.env.LAO_TOOLCHAIN_AUTO_UPDATE === "0") {
      if (!current) throw new Error("toolchain cache is empty and automatic updates are disabled");
      return current;
    }
    if (current && Date.now() - Date.parse(current.checkedAt) < UPDATE_TTL_MS) return current;
    return this.update();
  }

  async update(): Promise<ToolchainStatus> {
    const existing = this.status();
    const lock = this.acquireLock();
    if (!lock) {
      if (existing) return existing;
      throw new Error("toolchain update is already in progress and no active bundle exists");
    }
    const staging = join(this.root, `.staging-${randomUUID()}`);
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      const bundle = await this.installBundle(staging);
      const generation = `bundle-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const finalDirectory = join(this.generationsDir, generation);
      renameSync(staging, finalDirectory);
      const now = new Date().toISOString();
      const stored: StoredToolchainStatus = {
        generation,
        generationPath: relative(this.root, finalDirectory),
        directory: finalDirectory,
        nodeVersion: bundle.nodeVersion,
        piVersion: bundle.piVersion,
        packages: bundle.packages,
        installedAt: now,
        checkedAt: now,
      };
      writeJsonAtomically(this.activePath, stored);
      this.active = stored;
      this.activateEnvironment();
      this.pruneGenerations(generation);
      return this.publicStatus(stored);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (existing) {
        const fallback = { ...existing, lastError: String(error) };
        this.active = fallback;
        this.activateEnvironment();
        return this.publicStatus(fallback);
      }
      throw error;
    } finally {
      this.releaseLock(lock);
    }
  }

  extensionPath(name: keyof typeof TOOLCHAIN_EXTENSIONS): string {
    const current = this.status();
    if (!current) throw new Error("toolchain cache is empty");
    const path = join(current.directory, "node_modules", TOOLCHAIN_EXTENSIONS[name]);
    if (!existsSync(path)) throw new Error(`toolchain extension is missing: ${path}`);
    return path;
  }

  private async installBundle(staging: string): Promise<{ nodeVersion: string; piVersion: string; packages: Record<string, string> }> {
    const { platform, arch } = nodePlatform();
    const releasesResponse = await fetch("https://nodejs.org/dist/index.json");
    if (!releasesResponse.ok) throw new Error(`Node release lookup failed: HTTP ${releasesResponse.status}`);
    const releases = await releasesResponse.json() as NodeRelease[];
    const release = releases.find(isSupportedNodeRelease);
    if (!release) throw new Error(`no Node ${NODE_MAJOR} LTS release >= ${NODE_MAJOR}.${NODE_MIN_MINOR} is available`);

    const archiveExtension = platform === "linux" ? "tar.xz" : "tar.gz";
    const archivePath = join(staging, `${release.version}-${platform}-${arch}.${archiveExtension}`);
    const archiveName = `node-${release.version}-${platform}-${arch}.${archiveExtension}`;
    const archiveResponse = await fetch(`https://nodejs.org/dist/${release.version}/${archiveName}`);
    if (!archiveResponse.ok) throw new Error(`Node download failed: HTTP ${archiveResponse.status}`);
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    const checksumResponse = await fetch(`https://nodejs.org/dist/${release.version}/SHASUMS256.txt`);
    if (!checksumResponse.ok) throw new Error(`Node checksum lookup failed: HTTP ${checksumResponse.status}`);
    const expectedChecksum = (await checksumResponse.text()).split("\n").map((line) => line.trim().split(/\s+/)).find(([checksum, name]) => name === archiveName)?.[0];
    if (!expectedChecksum) throw new Error(`Node checksum is missing for ${archiveName}`);
    const actualChecksum = createHash("sha256").update(archive).digest("hex");
    if (actualChecksum !== expectedChecksum) throw new Error(`Node checksum mismatch for ${archiveName}`);
    writeFileSync(archivePath, archive, { mode: 0o600 });
    const extractedRoot = join(staging, "node-extracted");
    mkdirSync(extractedRoot, { recursive: true, mode: 0o700 });
    await runCommand("tar", [platform === "linux" ? "-xJf" : "-xzf", archivePath, "-C", extractedRoot], this.env, staging);
    renameSync(join(extractedRoot, `node-${release.version}-${platform}-${arch}`), join(staging, "node"));
    rmSync(archivePath, { force: true });
    rmSync(extractedRoot, { recursive: true, force: true });

    const packageJson = {
      name: "loom-and-order-toolchain",
      private: true,
      dependencies: TOOLCHAIN_PACKAGES,
    };
    writeJsonAtomically(join(staging, "package.json"), packageJson);
    const nodeBin = join(staging, "node", "bin");
    const installEnv = { ...this.env, PATH: `${nodeBin}:${this.env.PATH ?? ""}`, npm_config_update_notifier: "false" };
    const npm = join(nodeBin, "npm");
    await runCommand(npm, ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], installEnv, staging);
    const nodeVersion = (await runCommand(join(nodeBin, "node"), ["--version"], installEnv, staging)).stdout.trim();
    const piPath = join(staging, "node_modules", ".bin", "pi");
    const piVersion = (await runCommand(piPath, ["--version"], installEnv, staging)).stdout.trim();
    for (const extension of Object.values(TOOLCHAIN_EXTENSIONS)) {
      const path = join(staging, "node_modules", extension);
      if (!existsSync(path)) throw new Error(`installed toolchain is missing extension entry: ${path}`);
    }
    return { nodeVersion, piVersion, packages: { ...TOOLCHAIN_PACKAGES } };
  }

  private readActive(): StoredToolchainStatus | null {
    const stored = loadJson<StoredToolchainStatus>(this.activePath);
    if (!stored || !stored.generationPath) return null;
    const directory = resolve(this.root, stored.generationPath);
    if (directory !== this.root && !directory.startsWith(`${this.root}/`)) return null;
    if (!existsSync(join(directory, "node_modules", ".bin", "pi"))) return null;
    return { ...stored, directory };
  }

  private activateEnvironment(): void {
    if (this.active) {
      this.env.LAO_TOOLCHAIN_DIR = this.active.directory;
      this.env.PATH = `${join(this.active.directory, "node", "bin")}:${this.hostPath}`;
    } else {
      delete this.env.LAO_TOOLCHAIN_DIR;
      this.env.PATH = this.hostPath;
    }
  }

  private publicStatus(status: StoredToolchainStatus): ToolchainStatus {
    const { generationPath: _generationPath, ...publicStatus } = status;
    return publicStatus;
  }

  private acquireLock(): number | null {
    try {
      const descriptor = openSync(this.lockPath, "wx", 0o600);
      writeFileSync(descriptor, `${process.pid}\n`, { mode: 0o600 });
      return descriptor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(this.lockPath, { force: true });
          return this.acquireLock();
        }
      } catch { /* another updater may have completed */ }
      return null;
    }
  }

  private releaseLock(descriptor: number | null): void {
    if (descriptor === null) return;
    closeSync(descriptor);
    rmSync(this.lockPath, { force: true });
  }

  private pruneGenerations(activeGeneration: string): void {
    const generations = readdirSync(this.generationsDir).filter((name) => name.startsWith("bundle-")).sort().reverse();
    for (const generation of generations.slice(2)) {
      if (generation !== activeGeneration) rmSync(join(this.generationsDir, generation), { recursive: true, force: true });
    }
  }
}
