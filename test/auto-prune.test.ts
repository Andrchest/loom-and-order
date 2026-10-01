import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApplicationService } from "../src/application.ts";
import { GitWorkspace } from "../src/git.ts";
import { Store } from "../src/store.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function repository(parent: string): string {
  const repo = join(parent, "repo");
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Automatic GC Test"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  return repo;
}

function terminalize(store: Store, initiativeId: string, status: "completed" | "blocked" | "failed"): void {
  store.db.prepare("UPDATE nodes SET status = ?, lease_owner = NULL, lease_until = NULL WHERE initiative_id = ?").run(status, initiativeId);
}

function fixture(): { dir: string; repo: string; service: ApplicationService; submission: any; epicPath: string; taskPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-auto-gc-"));
  const repo = repository(dir);
  const service = new ApplicationService({ stateDir: join(dir, "state"), autoStart: false, runtime: {} as any });
  const submission = service.orchestrator.submit(repo, "gc", {
    title: "GC",
    epics: [{ id: "epic", title: "Epic", tasks: [{ id: "task", title: "Task" }] }],
  }, { autoPrune: true });
  const workspace = new GitWorkspace(service.stateDir);
  const epicPath = join(service.stateDir, "worktrees", submission.initiativeId, "epic");
  const taskPath = join(service.stateDir, "worktrees", submission.initiativeId, "task");
  const epicBranch = `loom-and-order/epic-${submission.initiativeId}`;
  const taskBranch = `loom-and-order/task-${submission.initiativeId}`;
  workspace.createWorktree(repo, epicBranch, epicPath, "main");
  workspace.createWorktree(repo, taskBranch, taskPath, epicBranch);
  writeFileSync(join(taskPath, "task.txt"), "task\n");
  workspace.commitChanges(taskPath, "task");
  service.store.setWorktree("epic", epicBranch, epicPath);
  service.store.setWorktree("task", taskBranch, taskPath);
  return { dir, repo, service, submission, epicPath, taskPath };
}

function close(fixtureValue: ReturnType<typeof fixture>): void {
  fixtureValue.service.close();
  rmSync(fixtureValue.dir, { recursive: true, force: true });
}

test("completed GC removes terminal task worktrees and merged branches but retains epic and deliver refs", () => {
  const f = fixture();
  try {
    const epicBranch = f.service.store.getNode("epic")!.branch!;
    git(f.epicPath, ["merge", "--no-edit", f.service.store.getNode("task")!.branch!]);
    git(f.repo, ["branch", `loom-and-order/deliver-${f.submission.initiativeId}`]);
    terminalize(f.service.store, f.submission.initiativeId, "completed");
    const first = f.service.runAutomaticGc(f.submission.initiativeId).sweeps[0];
    assert.equal(first.removed_worktrees, 1);
    assert.equal(first.deleted_branches, 1);
    assert.equal(f.service.store.getNode("task")?.worktreePath, null);
    assert.equal(f.service.store.getNode("epic")?.worktreePath, f.epicPath);
    assert.equal(git(f.repo, ["show-ref", "--verify", `refs/heads/${epicBranch}`]).length > 0, true);
    assert.equal(git(f.repo, ["show-ref", "--verify", `refs/heads/loom-and-order/deliver-${f.submission.initiativeId}`]).length > 0, true);
    assert.ok(f.service.logs().some((event) => event.kind === "auto_prune_action"));
  } finally { close(f); }
});

test("blocked GC reclaims terminal worktrees but retains unmerged forensic branches and is idempotent", () => {
  const f = fixture();
  try {
    terminalize(f.service.store, f.submission.initiativeId, "blocked");
    const branch = f.service.store.getNode("task")!.branch!;
    const first = f.service.runAutomaticGc(f.submission.initiativeId).sweeps[0];
    assert.equal(first.removed_worktrees, 1);
    assert.equal(first.deleted_branches, 0);
    assert.equal(first.retained_branches, 1);
    assert.equal(git(f.repo, ["show-ref", "--verify", `refs/heads/${branch}`]).length > 0, true);
    const second = f.service.runAutomaticGc(f.submission.initiativeId).sweeps[0];
    assert.deepEqual({ removed: second.removed_worktrees, deleted: second.deleted_branches }, { removed: 0, deleted: 0 });
    assert.equal(second.retained_branches, 1);
  } finally { close(f); }
});

test("automatic safety gates skip disabled, nonterminal, leased, session, and active-run snapshots", () => {
  const f = fixture();
  try {
    const store = f.service.store;
    store.setAutoPrune(f.submission.initiativeId, false);
    terminalize(store, f.submission.initiativeId, "completed");
    assert.equal(f.service.runAutomaticGc(f.submission.initiativeId).sweeps[0].skips, 1);
    store.setAutoPrune(f.submission.initiativeId, true);
    store.db.prepare("UPDATE nodes SET status = 'pending' WHERE id = 'task'").run();
    assert.equal(f.service.runAutomaticGc(f.submission.initiativeId).sweeps[0].skips, 1);
    store.db.prepare("UPDATE nodes SET status = 'completed', lease_owner = 'test', lease_until = ? WHERE id = 'task'").run(new Date(Date.now() + 60_000).toISOString());
    assert.equal(f.service.runAutomaticGc(f.submission.initiativeId).sweeps[0].skips, 1);
    store.db.prepare("UPDATE nodes SET lease_owner = NULL, lease_until = NULL WHERE initiative_id = ?").run(f.submission.initiativeId);
    store.startAgentSession({ id: "gc-session", agentId: "gc-agent", initiativeId: f.submission.initiativeId, nodeId: "task", role: "worker", profileId: "worker", runId: "gc-run" });
    assert.equal(f.service.runAutomaticGc(f.submission.initiativeId).sweeps[0].skips, 1);
    store.finishAgentSession("gc-session", "completed");
    store.acquireInitiativeRun(f.submission.initiativeId, "gc-run-owner", process.pid);
    assert.equal(f.service.runAutomaticGc(f.submission.initiativeId).sweeps[0].skips, 1);
    store.releaseInitiativeRun(f.submission.initiativeId, "gc-run-owner");
    assert.equal(store.acquireGcLock(f.submission.initiativeId, "other-gc-owner", process.pid), true);
    assert.equal(f.service.runAutomaticGc(f.submission.initiativeId).sweeps[0].skips, 1);
    store.releaseGcLock(f.submission.initiativeId, "other-gc-owner");
    const events = store.events(f.submission.initiativeId).filter((event) => event.kind === "auto_prune_skipped");
    assert.ok(events.length >= 3);
  } finally { close(f); }
});

test("worktree and branch failures are contained and manual prune remains recoverable", () => {
  const f = fixture();
  try {
    terminalize(f.service.store, f.submission.initiativeId, "completed");
    const workspace = (f.service as any).git() as GitWorkspace;
    const remove = workspace.removeWorktree;
    workspace.removeWorktree = () => { throw new Error("injected"); };
    const failedWorktree = f.service.runAutomaticGc(f.submission.initiativeId).sweeps[0];
    assert.equal(failedWorktree.failures, 1);
    assert.equal(f.service.store.getNode("task")?.worktreePath, f.taskPath);
    workspace.removeWorktree = remove;
    f.service.prune({ initiativeId: f.submission.initiativeId });
    assert.equal(f.service.store.getNode("task")?.worktreePath, null);

    const metricsAfterWorktree = f.service.metrics(f.submission.initiativeId);
    assert.ok(metricsAfterWorktree.counters.failures >= 1);
  } finally { close(f); }

  const branchFixture = fixture();
  try {
    terminalize(branchFixture.service.store, branchFixture.submission.initiativeId, "completed");
    const branch = branchFixture.service.store.getNode("task")!.branch!;
    git(branchFixture.epicPath, ["merge", "--no-edit", branch]);
    const workspace = (branchFixture.service as any).git() as GitWorkspace;
    const deleteBranch = workspace.deleteBranch;
    workspace.deleteBranch = () => { throw new Error("injected"); };
    const failedBranch = branchFixture.service.runAutomaticGc(branchFixture.submission.initiativeId).sweeps[0];
    assert.equal(failedBranch.failures, 1);
    assert.equal(git(branchFixture.repo, ["show-ref", "--verify", `refs/heads/${branch}`]).length > 0, true);
    workspace.deleteBranch = deleteBranch;
    branchFixture.service.prune({ initiativeId: branchFixture.submission.initiativeId });
    assert.equal(new GitWorkspace(branchFixture.service.stateDir).branchExists(branchFixture.repo, branch), false);
    const metrics = branchFixture.service.metrics(branchFixture.submission.initiativeId);
    assert.ok(metrics.counters.failures >= 1);
    assert.ok(branchFixture.service.logs().some((event) => event.kind === "auto_prune_failure"));
  } finally { close(branchFixture); }
});
