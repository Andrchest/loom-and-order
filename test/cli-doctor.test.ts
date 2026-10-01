import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Store } from "../src/store.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const cli = join(root, "src", "cli.ts");

function invoke(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { encoding: "utf8" });
}

function snapshot(directory: string): string {
  const entries: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(path, entry.name);
      const relative = child.slice(directory.length + 1);
      if (entry.isDirectory()) visit(child);
      else entries.push(`${relative}:${readFileSync(child).toString("base64")}`);
    }
  };
  visit(directory);
  return entries.join("\n");
}

function healthyFixture(): { directory: string; state: string; initiativeId: string } {
  const directory = mkdtempSync(join(tmpdir(), "loom-and-order-cli-doctor-"));
  const state = join(directory, "state");
  const store = new Store(join(state, "state.sqlite3"));
  try {
    const { initiativeId } = store.createPlan({
      plan: { title: "Doctor fixture", epics: [{ id: "epic-1", title: "Epic", tasks: [{ id: "task-1", title: "Task" }] }] },
      repoPath: directory,
      baseCommit: "base",
    });
    const worktree = join(state, "worktrees", initiativeId, "task-1");
    mkdirSync(worktree, { recursive: true });
    store.setWorktree("task-1", "branch", worktree);
    return { directory, state, initiativeId };
  } finally {
    store.close();
  }
}

test("doctor reports a healthy read-only state with accurate diagnostics", () => {
  const fixture = healthyFixture();
  try {
    const before = snapshot(fixture.directory);
    const result = invoke(["doctor", "--state-dir", fixture.state, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      sqliteIntegrityCheck: ["ok"],
      nodeCountsByStatus: { draft: 1, ready: 2 },
      eventCount: 7,
      orphanedWorktrees: [],
      blockedTasks: [],
      healthy: true,
    });
    assert.equal(snapshot(fixture.directory), before);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("doctor reads current WAL-backed state while Store remains open", () => {
  const directory = mkdtempSync(join(tmpdir(), "loom-and-order-cli-doctor-wal-"));
  const state = join(directory, "state");
  const store = new Store(join(state, "state.sqlite3"));
  try {
    store.createPlan({
      plan: { title: "Open store fixture", epics: [{ id: "epic-1", title: "Epic", tasks: [{ id: "task-1", title: "Task" }] }] },
      repoPath: directory,
      baseCommit: "base",
    });
    const result = invoke(["doctor", "--state-dir", state, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.nodeCountsByStatus, { draft: 1, ready: 2 });
    assert.equal(report.eventCount, 6);
    assert.equal(report.healthy, true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor reports blocked reasons and only bounded managed worktree orphans", () => {
  const fixture = healthyFixture();
  try {
    const store = new Store(join(fixture.state, "state.sqlite3"));
    try {
      store.transition("task-1", "blocked", { reason: "reviewer rejected the change" });
    } finally {
      store.close();
    }
    const orphan = join(fixture.state, "worktrees", fixture.initiativeId, "orphan");
    mkdirSync(join(orphan, "nested"), { recursive: true });
    writeFileSync(join(fixture.state, "worktrees", "unrelated-file"), "ignored");
    mkdirSync(join(fixture.directory, "outside", "initiative", "node"), { recursive: true });

    const result = invoke(["doctor", "--state-dir", fixture.state, "--json"]);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.blockedTasks, [{ id: "task-1", reason: "reviewer rejected the change" }]);
    assert.deepEqual(report.orphanedWorktrees, [`worktrees/${fixture.initiativeId}/orphan`]);
    assert.equal(report.healthy, false);
    assert.equal(report.orphanedWorktrees.some((path: string) => path.includes("nested")), false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("doctor reports missing and unreadable databases without creating state", () => {
  const directory = mkdtempSync(join(tmpdir(), "loom-and-order-cli-doctor-missing-"));
  const state = join(directory, "state");
  mkdirSync(state, { recursive: true });
  try {
    const before = snapshot(directory);
    const missing = invoke(["doctor", "--state-dir", state, "--json"]);
    assert.equal(missing.status, 1);
    assert.equal(JSON.parse(missing.stdout).healthy, false);
    assert.equal(existsSync(join(state, "state.sqlite3")), false);
    assert.equal(snapshot(directory), before);

    writeFileSync(join(state, "state.sqlite3"), "not a sqlite database");
    const unreadable = invoke(["doctor", "--state-dir", state, "--json"]);
    assert.equal(unreadable.status, 1);
    assert.equal(JSON.parse(unreadable.stdout).healthy, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
