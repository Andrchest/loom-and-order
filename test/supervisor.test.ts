import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Supervisor } from "../src/supervisor.ts";
import { Store } from "../src/store.ts";
import type { ProfileManifest } from "../src/profiles.ts";

const profile: ProfileManifest = {
  id: "worker",
  role: "worker",
  pool: "local",
  model: "fake/local",
  piBin: "pi",
  skills: [],
  extensions: [],
  tools: ["read"],
  timeoutMs: 10_000,
  maxAttempts: 2,
  sandbox: { backend: "pi-sandbox", extensionPath: "/trusted/pi-sandbox.ts", allowedDomains: [], credentialMode: "host-auth" },
};

function makeStore(): { store: Store; dir: string; initiativeId: string } {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-supervisor-"));
  const store = new Store(join(dir, "state.sqlite3"));
  const { initiativeId } = store.createPlan({ plan: { title: "supervisor", epics: [{ id: "epic", title: "E", tasks: [{ id: "task", title: "T" }] }] }, repoPath: "/repo", baseCommit: "abc" });
  return { store, dir, initiativeId };
}

test("supervisor recovers stale sessions and survives Store restart", () => {
  const { store, dir, initiativeId } = makeStore();
  try {
    const leased = store.claim("task", "executor", 60_000);
    store.transition(leased.id, "running");
    store.startAgentSession({ id: "session-1", agentId: "worker-task", initiativeId, nodeId: "task", role: "worker", profileId: "worker", model: "fake/local", attemptNo: 1, pid: 99999 });
    const supervisor = new Supervisor(store, { profiles: { worker: profile }, staleHeartbeatMs: 1 });
    const first = supervisor.runOnce(new Date(Date.now() + 1000));
    assert.deepEqual(first.staleSessions, ["task"]);
    assert.deepEqual(first.recovered, ["task"]);
    assert.equal(store.getNode("task")?.status, "ready");
    assert.equal(store.getAgent("worker-task")?.status, "recovering");
    assert.equal(store.getAgentSession("session-1")?.state, "interrupted");
    const eventCount = store.eventsSince(0, initiativeId).length;
    store.close();

    const reopened = new Store(join(dir, "state.sqlite3"));
    const second = new Supervisor(reopened, { profiles: { worker: profile }, staleHeartbeatMs: 1 }).runOnce(new Date());
    assert.deepEqual(second.recovered, []);
    assert.equal(reopened.getAgent("worker-task")?.model, "fake/local");
    assert.equal(reopened.eventsSince(0, initiativeId).length >= eventCount, true);
    reopened.close();
  } finally {
    try { store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supervisor auto-unblocks an external artifact wait", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-supervisor-artifact-"));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  const store = new Store(join(dir, "state.sqlite3"));
  try {
    const { initiativeId } = store.createPlan({ plan: { title: "artifact", epics: [{ id: "epic", title: "E", tasks: [{ id: "task", title: "T" }] }] }, repoPath: repo, baseCommit: "abc" });
    store.transition("task", "waiting_external", { reason: "fixture missing", recoveryOwner: "operator", recoveryScope: "task", requiredAction: "add fixture", unblockCondition: "artifact:fixtures/input.json" });
    writeFileSync(join(repo, "fixtures.tmp"), "not the fixture");
    const supervisor = new Supervisor(store, { profiles: { worker: profile } });
    assert.deepEqual(supervisor.runOnce().recovered, []);
    assert.equal(store.getNode("task")?.status, "waiting_external");
    mkdirSync(join(repo, "fixtures"), { recursive: true });
    writeFileSync(join(repo, "fixtures", "input.json"), "{}");
    const report = supervisor.runOnce();
    assert.equal(report.refreshedInitiatives.includes(initiativeId), true);
    assert.equal(store.getNode("task")?.status, "ready");
    assert.equal(store.events("task").some((event) => event.kind === "auto_unblocked"), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supervisor recovers integrating leases with a dead executor owner (no session)", () => {
  const { store, dir } = makeStore();
  try {
    const child = spawnSync(process.execPath, ["-e", "0"]);
    assert.ok(child.pid && child.pid > 1);
    const leased = store.claim("task", `executor-${child.pid}`, 60_000);
    store.transition(leased.id, "running");
    store.transition(leased.id, "reviewing");
    store.transition(leased.id, "integrating");
    // No agent session exists: heartbeat detection cannot help; only the
    // owner-liveness probe can. The lease is fresh (not expired).
    const report = new Supervisor(store, { profiles: { worker: profile } }).runOnce();
    assert.deepEqual(report.recovered, ["task"]);
    // Recovery flips to pending and the same cycle's refreshReady promotes it.
    assert.equal(store.getNode("task")?.status, "ready");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supervisor blocks a task after the recovery attempt bound", () => {
  const { store, dir } = makeStore();
  try {
    const leased = store.claim("task", "executor", 60_000);
    store.transition(leased.id, "running");
    store.startAgentSession({ id: "session-1", agentId: "worker-task", initiativeId: leased.initiativeId, nodeId: "task", role: "worker", profileId: "worker", model: "fake/local", attemptNo: 1 });
    const bounded = { ...profile, maxAttempts: 1 };
    const report = new Supervisor(store, { profiles: { worker: bounded }, staleHeartbeatMs: 1 }).runOnce(new Date(Date.now() + 1000));
    assert.deepEqual(report.blocked, ["task"]);
    assert.equal(store.getNode("task")?.status, "blocked");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
