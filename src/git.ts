import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// A worker may legitimately create many files, but credential-like files must
// never enter a task commit (they would be visible to review and gates).
const SECRET_FILE_NAMES: Array<(name: string) => boolean> = [
  (name) => name === ".env" || (name.startsWith(".env.") && name !== ".env.example"),
  (name) => /\.(pem|key|p12|pfx|keystore)$/.test(name),
  (name) => /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/.test(name),
  (name) => name === "credentials.json" || name === "netrc" || name === ".netrc",
];

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* the process already exited */ }
  }
}

const GATE_TIMEOUT_MS = 30 * 60 * 1000;

export class GitWorkspace {
  readonly stateDir: string;
  private readonly gateTimeoutMs: number;

  constructor(stateDir: string, gateTimeoutMs = GATE_TIMEOUT_MS) {
    this.stateDir = stateDir;
    this.gateTimeoutMs = gateTimeoutMs;
  }

  repositoryRoot(repoPath: string): string {
    return resolve(git(repoPath, ["rev-parse", "--show-toplevel"]));
  }

  assertRepository(repoPath: string): void {
    this.repositoryRoot(repoPath);
  }

  assertClean(repoPath: string, allowedUntrackedPrefixes: string[] = [".pi/quiet-tools/"]): void {
    const status = git(repoPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const unexpected = status.split("\n").filter(Boolean).filter((line) => {
      const indexStatus = line.slice(0, 2);
      const path = line.slice(3).split(" -> ").at(-1) ?? "";
      const untracked = indexStatus === "??";
      return !untracked || !allowedUntrackedPrefixes.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
    });
    if (unexpected.length) throw new Error(`source checkout is not clean: ${unexpected[0]}`);
  }

  head(repoPath: string): string {
    return git(repoPath, ["rev-parse", "HEAD"]);
  }

  branch(repoPath: string): string {
    return git(repoPath, ["branch", "--show-current"]) || "detached";
  }

  branchExists(repoPath: string, branch: string): boolean {
    try {
      git(repoPath, ["rev-parse", "--verify", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  deleteBranch(repoPath: string, branch: string): void {
    if (this.branchExists(repoPath, branch)) git(repoPath, ["branch", "-D", branch]);
  }

  /** Move a branch ref without touching any working tree. */
  resetBranch(repoPath: string, branch: string, commit: string): void {
    git(repoPath, ["update-ref", `refs/heads/${branch}`, commit]);
  }

  branchHead(repoPath: string, branch: string): string {
    return git(repoPath, ["rev-parse", `refs/heads/${branch}`]);
  }

  createWorktree(repoPath: string, branch: string, path: string, baseRef: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    git(repoPath, ["worktree", "add", "-b", branch, path, baseRef]);
  }

  // Fresh worktrees have no node_modules, so gates and worker sessions fail
  // on missing dependencies (F7: the post-merge epic gate died this way).
  // Install once per worktree; idempotent when node_modules already exists.
  ensureDependencies(worktree: string): boolean {
    if (!existsSync(resolve(worktree, "package.json")) || existsSync(resolve(worktree, "node_modules"))) return false;
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: this.gateTimeoutMs,
    });
    return true;
  }

  removeWorktree(repoPath: string, path: string): void {
    git(repoPath, ["worktree", "remove", "--force", path]);
  }

  currentCommit(worktree: string): string {
    return git(worktree, ["rev-parse", "HEAD"]);
  }

  isAncestor(repository: string, ancestor: string, descendant = "HEAD"): boolean {
    try {
      git(repository, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  abortMerge(worktree: string): void {
    try {
      git(worktree, ["merge", "--abort"]);
    } catch {
      // The merge may already have been aborted or may not have started.
    }
  }

  hasConflicts(worktree: string): boolean {
    try {
      return git(worktree, ["diff", "--name-only", "--diff-filter=U"]) !== "";
    } catch {
      return true;
    }
  }

  hasCommitChanged(worktree: string, baseCommit: string): boolean {
    return this.currentCommit(worktree) !== baseCommit;
  }

  commitCountSince(worktree: string, baseCommit: string): number {
    return Number(git(worktree, ["rev-list", "--count", `${baseCommit}..HEAD`])) || 0;
  }

  isClean(worktree: string): boolean {
    return git(worktree, ["status", "--porcelain"]) === "";
  }

  resetWorktree(worktree: string, baseCommit: string): void {
    git(worktree, ["reset", "--hard", baseCommit]);
    git(worktree, ["clean", "-fd"]);
  }

  commitChanges(worktree: string, message: string): string {
    if (this.isClean(worktree)) return this.currentCommit(worktree);
    const status = git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const flagged = status.split("\n").filter(Boolean)
      .map((line) => (line.slice(3).split(" -> ").at(-1) ?? "").trim().replace(/^"(.*)"$/, "$1"))
      .filter((name) => SECRET_FILE_NAMES.some((isSecret) => isSecret(name)));
    if (flagged.length > 0) throw new Error(`refusing to commit credential-like files: ${[...new Set(flagged)].join(", ")}`);
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", message]);
    return this.currentCommit(worktree);
  }

  diff(worktree: string, baseCommit: string): string {
    return git(worktree, ["diff", `${baseCommit}..HEAD`, "--"]);
  }

  diffStat(worktree: string, baseCommit: string): string {
    return git(worktree, ["diff", "--stat", `${baseCommit}..HEAD`, "--"]);
  }

  merge(epicWorktree: string, branchOrCommit: string): string {
    try {
      git(epicWorktree, ["merge", "--no-ff", "--no-edit", branchOrCommit]);
      return this.currentCommit(epicWorktree);
    } catch (error) {
      this.abortMerge(epicWorktree);
      throw error;
    }
  }

  /**
   * Find a prior merge of `branch` in the epic history (first-parent walk).
   * A crash between a successful merge and the completion record leaves the
   * epic with the task's work already integrated; re-running integration on a
   * re-implemented task branch would then conflict. Detecting the prior
   * merge lets integration complete idempotently (verify the gate, record the
   * existing merge commit) instead of re-merging.
   */
  findPriorMerge(epicWorktree: string, branch: string): string | null {
    const log = git(epicWorktree, ["log", "--first-parent", "--format=%H %s", "-n", "200"]);
    const marker = `Merge branch '${branch}'`;
    for (const line of log.split("\n")) {
      const index = line.indexOf(marker);
      if (index !== -1) return line.slice(0, 40);
    }
    return null;
  }

  async runGate(worktree: string, command: string[]): Promise<{ ok: boolean; output: string; durationMs: number }> {
    if (!command.length) throw new Error("gate command is required; refusing unverified integration");
    const commands = command.length === 1 && command[0] === "__auto__" ? this.autoGateCommands(worktree) : [command];
    const startedAt = Date.now();
    const output: string[] = [];
    for (const current of commands) {
      const result = await this.runGateCommand(current, worktree);
      output.push(`$ ${current.join(" ")}\n${result.output}`);
      if (!result.ok) return { ok: false, output: output.join("\n").slice(-20000), durationMs: Date.now() - startedAt };
    }
    return { ok: true, output: output.join("\n").slice(-20000), durationMs: Date.now() - startedAt };
  }

  private runGateCommand(command: string[], worktree: string): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolvePromise) => {
      let output = "";
      const child = spawn(command[0], command.slice(1), { cwd: worktree, stdio: ["ignore", "pipe", "pipe"], detached: true });
      const append = (chunk: Buffer): void => {
        output += chunk.toString();
        if (output.length > 12_000) output = output.slice(-12_000);
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      let settled = false;
      const finish = (ok: boolean, extraOutput = ""): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolvePromise({ ok, output: [extraOutput, output].filter(Boolean).join("\n").trim() });
      };
      const timeout = setTimeout(() => {
        killTree(child, "SIGTERM");
        // Same escalation as the launcher: a stuck gate command must end in bounded time.
        const escalation = setTimeout(() => killTree(child, "SIGKILL"), 5_000);
        escalation.unref?.();
      }, this.gateTimeoutMs);
      child.on("error", (error) => finish(false, `gate command failed to start: ${error.message}`));
      child.on("close", (code) => finish(code === 0));
    });
  }

  private autoGateCommands(worktree: string): string[][] {
    const commands: string[][] = [];
    const packagePath = resolve(worktree, "package.json");
    if (existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
        if (typeof packageJson.scripts?.test === "string") commands.push(["npm", "test"]);
      } catch {
        // The diff gate below still provides a safe baseline for malformed metadata.
      }
    }
    if (!commands.length && (existsSync(resolve(worktree, "pyproject.toml")) || existsSync(resolve(worktree, "setup.cfg"))) && existsSync(resolve(worktree, "tests"))) {
      commands.push(["python3", "-m", "unittest", "discover", "-s", "tests", "-v"]);
    }
    commands.push(["git", "diff", "--check"]);
    return commands;
  }

  worktreePath(initiativeId: string, nodeId: string): string {
    return resolve(this.stateDir, "worktrees", initiativeId, nodeId);
  }

  branchName(initiativeId: string, nodeId: string, level: "epic" | "task"): string {
    return `loom-and-order/${initiativeId.slice(-12)}/${level}-${nodeId.slice(-12)}`;
  }
}
