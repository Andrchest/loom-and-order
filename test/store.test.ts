import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { prometheus } from "../src/metrics.ts";
import { Store } from "../src/store.ts";

function makeStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-store-"));
  return { dir, store: new Store(join(dir, "state.sqlite3")) };
}

test("applies LAO_SQLITE_SYNC=normal pragma when set", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-store-"));
  process.env.LAO_SQLITE_SYNC = "normal";
  try {
    const store = new Store(join(dir, "state.sqlite3"));
    try {
      const row = store.db.prepare("PRAGMA synchronous").get() as { synchronous: number };
      assert.equal(Number(row.synchronous), 1, "NORMAL = 1");
    } finally {
      store.close();
    }
  } finally {
    delete process.env.LAO_SQLITE_SYNC;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaults to synchronous=FULL without LAO_SQLITE_SYNC", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-store-"));
  delete process.env.LAO_SQLITE_SYNC;
  try {
    const store = new Store(join(dir, "state.sqlite3"));
    try {
      const row = store.db.prepare("PRAGMA synchronous").get() as { synchronous: number };
      assert.equal(Number(row.synchronous), 2, "FULL = 2");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects invalid LAO_SQLITE_SYNC values", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-store-"));
  process.env.LAO_SQLITE_SYNC = "bogus";
  try {
    assert.throws(() => new Store(join(dir, "state.sqlite3")), /invalid LAO_SQLITE_SYNC/);
  } finally {
    delete process.env.LAO_SQLITE_SYNC;
    rmSync(dir, { recursive: true, force: true });
  }
});

const basePlan = {
  title: "Example initiative",
  summary: "A durable plan",
  epics: [{
    id: "epic-one",
    title: "Core",
    tasks: [
      { id: "task-one", title: "First", acceptanceCriteria: ["test passes"] },
      { id: "task-two", title: "Second", dependsOn: ["task-one"], acceptanceCriteria: ["review passes"] },
    ],
  }],
};

test("persists versioned architecture contracts and supersession metadata", () => {
  const { store, dir } = makeStore();
  try {
    const { initiativeId } = store.createPlan({ plan: basePlan, repoPath: "/repo", baseCommit: "abc" });
    const first = {
      version: 1,
      revision: 1,
      initiativeId,
      author: { role: "architect" as const, profileId: "architect", model: "openai-codex/gpt-5.6-terra" },
      createdAt: new Date().toISOString(),
      summary: "Initial design",
      decisions: ["Use a durable contract"],
      constraints: ["No target writes"],
      invariants: ["Contract revisions are append-only"],
      interfaces: ["Store API"],
      taskGuidance: ["Test persistence"],
    };
    const saved = store.saveArchitectureContract(first);
    assert.equal(saved.revision, 1);
    assert.equal(saved.supersedesRevision, null);
    const second = store.saveArchitectureContract({ ...first, revision: 2, summary: "Revised design", createdAt: new Date().toISOString() }, "Clarified task boundaries");
    assert.equal(second.supersedesRevision, 1);
    assert.equal(second.supersessionReason, "Clarified task boundaries");
    assert.equal(store.getArchitectureContract(initiativeId)?.revision, 2);
    assert.deepEqual(store.listArchitectureContracts(initiativeId).map((contract) => contract.revision), [1, 2]);
    assert.equal(store.events(initiativeId).filter((event) => event.kind === "architecture_contract_created").length, 2);
    store.close();
    const reopened = new Store(join(dir, "state.sqlite3"));
    assert.equal(reopened.getArchitectureContract(initiativeId)?.summary, "Revised design");
    assert.equal(reopened.listArchitectureContracts(initiativeId)[1].supersessionReason, "Clarified task boundaries");
    reopened.close();
  } finally {
    try { store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects explicit node ID collisions before mutating the state database", () => {
  const { store, dir } = makeStore();
  try {
    store.createPlan({ plan: { title: "First", epics: [{ id: "epic", title: "E", tasks: [{ id: "task", title: "T" }] }] }, repoPath: "/repo", baseCommit: "abc" });
    assert.throws(() => store.createPlan({ plan: { title: "Second", epics: [{ id: "epic", title: "E2", tasks: [{ id: "task-2", title: "T2" }] }] }, repoPath: "/repo", baseCommit: "def" }), /state namespace collision/);
    assert.equal(store.listInitiatives().length, 1);
    assert.equal(store.events().some((event) => event.kind === "plan_created" && event.nodeId === "initiative-"), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prevents concurrent initiative runs and releases the lease", () => {
  const { store, dir } = makeStore();
  try {
    const { initiativeId } = store.createPlan({ plan: basePlan, repoPath: "/repo", baseCommit: "abc" });
    store.acquireInitiativeRun(initiativeId, "owner-1", process.pid);
    assert.throws(() => store.acquireInitiativeRun(initiativeId, "owner-2", process.pid), /active run lease/);
    store.releaseInitiativeRun(initiativeId, "owner-1");
    assert.doesNotThrow(() => store.acquireInitiativeRun(initiativeId, "owner-2", process.pid));
    store.releaseInitiativeRun(initiativeId, "owner-2");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persists hierarchy, criteria, dependencies, events and messages", () => {
  const { store, dir } = makeStore();
  try {
    const created = store.createPlan({ plan: basePlan, repoPath: "/repo", baseCommit: "abc" });
    assert.equal(created.epicIds[0], "epic-one");
    assert.equal(store.getNode("task-one")?.status, "ready");
    assert.equal(store.getNode("task-two")?.status, "pending");
    const messageId = store.addMessage(created.initiativeId, "Prioritize tests");
    assert.equal(store.pendingMessages(created.initiativeId)[0].id, messageId);
    const eventCount = store.events().length;
    store.close();
    const reopened = new Store(join(dir, "state.sqlite3"));
    assert.equal(reopened.getNode("task-one")?.acceptanceCriteria[0], "test passes");
    assert.deepEqual(reopened.getNode("task-two")?.dependsOn, ["task-one"]);
    assert.equal(reopened.pendingMessages(created.initiativeId)[0].body, "Prioritize tests");
    assert.ok(reopened.events().length >= eventCount);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persists recoverable block metadata across store restarts", () => {
  const { store, dir } = makeStore();
  try {
    const { initiativeId } = store.createPlan({ plan: basePlan, repoPath: "/repo", baseCommit: "abc" });
    const blocked = store.transition("task-one", "blocked", {
      reason: "missing external fixture",
      recoveryOwner: "operator",
      recoveryScope: "task",
      requiredAction: "add fixtures/cases.json",
      unblockCondition: "fixture exists and passes validation",
      recoveryEpoch: 2,
      recoveryFingerprint: "fixture-missing-v1",
    });
    assert.equal(blocked.recoveryOwner, "operator");
    assert.equal(blocked.recoveryScope, "task");
    assert.equal(blocked.requiredAction, "add fixtures/cases.json");
    assert.equal(blocked.unblockCondition, "fixture exists and passes validation");
    assert.equal(blocked.recoveryEpoch, 2);
    assert.equal(blocked.recoveryFingerprint, "fixture-missing-v1");
    store.close();
    const reopened = new Store(join(dir, "state.sqlite3"));
    const recovered = reopened.getNode("task-one")!;
    assert.equal(recovered.initiativeId, initiativeId);
    assert.equal(recovered.status, "blocked");
    assert.equal(recovered.recoveryOwner, "operator");
    assert.equal(recovered.recoveryEpoch, 2);
    assert.equal(recovered.recoveryFingerprint, "fixture-missing-v1");
    reopened.close();
  } finally {
    try { store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps independent initiative work runnable when one task is blocked", () => {
  const { store, dir } = makeStore();
  try {
    const plan = { title: "Independent work", epics: [{ id: "epic-independent", title: "Core", tasks: [
      { id: "task-blocked", title: "Blocked branch", acceptanceCriteria: ["external fixture"] },
      { id: "task-runnable", title: "Runnable branch", acceptanceCriteria: ["test passes"] },
    ] }] };
    const { initiativeId } = store.createPlan({ plan, repoPath: "/repo", baseCommit: "abc" });
    store.transition("task-blocked", "blocked", {
      reason: "waiting for external fixture",
      recoveryOwner: "operator",
      recoveryScope: "task",
      requiredAction: "provide fixture",
      unblockCondition: "fixture is present",
    });
    store.refreshRollups(initiativeId);
    assert.equal(store.getNode("task-runnable")?.status, "ready");
    assert.equal(store.getNode("epic-independent")?.status, "waiting");
    assert.equal(store.getNode(initiativeId)?.status, "waiting");

    const runnable = store.claim("task-runnable", "test", 60_000);
    store.transition(runnable.id, "running");
    store.transition(runnable.id, "completed");
    store.refreshRollups(initiativeId);
    assert.equal(store.getNode("epic-independent")?.status, "blocked");
    assert.equal(store.getNode(initiativeId)?.status, "blocked");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waits downstream tasks on blocked dependencies and reopens them after completion", () => {
  const { store, dir } = makeStore();
  try {
    const plan = { title: "Dependency recovery", epics: [{ id: "epic-dependency", title: "Core", tasks: [
      { id: "producer", title: "Producer", acceptanceCriteria: ["artifact"] },
      { id: "consumer", title: "Consumer", dependsOn: ["producer"], acceptanceCriteria: ["uses artifact"] },
    ] }] };
    const { initiativeId } = store.createPlan({ plan, repoPath: "/repo", baseCommit: "abc" });
    store.transition("producer", "blocked", { reason: "waiting for external input", recoveryOwner: "operator", recoveryScope: "task", requiredAction: "provide input", unblockCondition: "input exists" });
    store.refreshReady(initiativeId);
    assert.equal(store.getNode("consumer")?.status, "waiting_dependency");
    store.transition("producer", "pending", { reason: "external input provided" });
    store.refreshReady(initiativeId);
    assert.equal(store.getNode("producer")?.status, "ready");
    assert.equal(store.getNode("consumer")?.status, "waiting_dependency");
    const producer = store.claim("producer", "test", 60_000);
    store.transition(producer.id, "running");
    store.transition(producer.id, "completed");
    store.refreshReady(initiativeId);
    assert.equal(store.getNode("consumer")?.status, "ready");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects dependency cycles atomically", () => {
  const { store, dir } = makeStore();
  try {
    assert.throws(() => store.createPlan({
      plan: { title: "Cycle", epics: [{ title: "E", tasks: [
        { id: "a", title: "A", dependsOn: ["b"] },
        { id: "b", title: "B", dependsOn: ["a"] },
      ] }] },
      repoPath: "/repo",
      baseCommit: "abc",
    }), /cycle/);
    assert.equal(store.listNodes("missing").length, 0);
    assert.equal(store.events().length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persists and aggregates bounded runtime metrics", () => {
  const { store, dir } = makeStore();
  try {
    const { initiativeId } = store.createPlan({ plan: basePlan, repoPath: "/repo", baseCommit: "abc" });
    store.recordMetric({ initiativeId, nodeId: "task-one", runId: "run-1", role: "worker", outcome: "success", durationMs: 10, counters: { input_tokens: 3, tool_calls: 1, ttft_ms: 2, tokens_per_second: 10, cost_usd: 0.5, api_cost_usd: 0.5, codex_credits: 2 }, dimensions: { profile: "worker", model: "openai-codex/gpt-test", backend: "fake" } });
    store.recordMetric({ initiativeId, nodeId: "task-one", runId: "run-2", role: "worker", outcome: "failure", durationMs: 30, counters: { input_tokens: 5, tool_errors: 1 }, dimensions: { profile: "worker", model: "openai-codex/gpt-test", backend: "fake" } });
    assert.throws(() => store.recordMetric({ initiativeId, runId: "bad", role: "worker", outcome: "success", durationMs: 1, dimensions: { arbitrary: "high-cardinality" } }), /dimension is not allowed/);
    const summary = store.metricSummary(initiativeId);
    assert.equal(summary.metricCount, 2);
    assert.equal(summary.byRole.worker.p50DurationMs, 10);
    assert.equal(summary.byRole.worker.p95DurationMs, 30);
    assert.equal(summary.counters.input_tokens, 8);
    assert.equal(summary.overall.p50TtftMs, 2);
    assert.equal(summary.overall.avgTokensPerSecond, 10);
    assert.equal(summary.overall.costUsd, 0.5);
    assert.equal(summary.overall.apiCostUsd, 0.5);
    assert.equal(summary.overall.codexCredits, 2);
    assert.equal(summary.overall.costComplete, false);
    assert.equal(summary.overall.apiCostComplete, false);
    assert.equal(summary.overall.codexCreditsComplete, false);
    assert.equal(summary.byProfile.worker.costUnknownRuns, 1);
    assert.equal(summary.byModel["openai-codex/gpt-test"].runs, 2);
    assert.equal(summary.byProfileModel["worker @ openai-codex/gpt-test"].costKnownRuns, 1);
    const exposition = prometheus(summary);
    assert.match(exposition, /pi_epics_agent_ttft_ms_p50/);
    assert.match(exposition, /pi_epics_overall_api_cost_usd_total/);
    assert.match(exposition, /pi_epics_overall_codex_credits_total/);
    assert.match(exposition, /profile="worker"/);
    assert.match(exposition, /model="openai-codex\/gpt-test"/);
    store.close();
    const reopened = new Store(join(dir, "state.sqlite3"));
    assert.equal(reopened.metrics(initiativeId).length, 2);
    assert.equal(reopened.metricSummary(initiativeId).outcomes.failure, 1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persists agent identities and sessions across store restart", () => {
  const { store, dir } = makeStore();
  const { initiativeId } = store.createPlan({ plan: basePlan, repoPath: "/repo", baseCommit: "abc" });
  try {
    const agent = store.ensureAgent({ id: "worker-task-one", initiativeId, nodeId: "task-one", role: "worker", profileId: "worker", model: "fake/model", pool: "local" });
    assert.equal(agent.status, "idle");
    store.startAgentSession({ id: "session-1", agentId: agent.id, initiativeId, nodeId: "task-one", role: "worker", profileId: "worker", model: "fake/model", attemptNo: 1, pid: 123 });
    store.heartbeatAgent(agent.id, "session-1");
    store.finishAgentSession("session-1", "completed", { exitCode: 0, handoffSummary: "completed" });
    assert.equal(store.getAgent(agent.id)?.runCount, 1);
    assert.equal(store.getAgent(agent.id)?.successCount, 1);
    assert.equal(store.getAgentSession("session-1")?.state, "completed");
    store.close();
    const reopened = new Store(join(dir, "state.sqlite3"));
    assert.equal(reopened.getAgent(agent.id)?.model, "fake/model");
    assert.equal(reopened.listAgentSessions(initiativeId).length, 1);
    assert.equal(reopened.eventsSince(0, initiativeId).some((event) => event.kind === "agent_session_started"), true);
    reopened.close();
  } finally {
    try { store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rolls completed and blocked task states into epic and initiative statuses", () => {
  const { store, dir } = makeStore();
  try {
    const { initiativeId } = store.createPlan({ plan: basePlan, repoPath: "/repo", baseCommit: "abc" });
    store.transition(store.claim("task-one", "test", 60_000).id, "running");
    store.transition("task-one", "completed");
    store.transition(store.claim("task-two", "test", 60_000).id, "running");
    store.transition("task-two", "completed");
    store.refreshRollups(initiativeId);
    assert.equal(store.getNode("epic-one")?.status, "completed");
    assert.equal(store.getNode(initiativeId)?.status, "completed");
    assert.equal(store.events("epic-one").some((event) => event.kind === "status_changed" && event.payload.rollup === true), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforces transitions, leases and recovery", () => {
  const { store, dir } = makeStore();
  try {
    const { initiativeId } = store.createPlan({ plan: basePlan, repoPath: "/repo", baseCommit: "abc" });
    assert.throws(() => store.transition("task-one", "completed"), /invalid transition/);
    const leased = store.claim("task-one", "worker-1", 1);
    assert.equal(leased.status, "leased");
    store.transition("task-one", "running");
    const recovered = store.recoverExpiredLeases(new Date(Date.now() + 1000));
    assert.deepEqual(recovered, ["task-one"]);
    assert.equal(store.getNode("task-one")?.status, "pending");
    store.refreshReady(initiativeId);
    assert.equal(store.getNode("task-one")?.status, "ready");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovers leases whose executor owner process is dead", () => {
  const { store, dir } = makeStore();
  try {
    // A pid that is guaranteed dead: a child process that has already exited.
    const child = spawnSync(process.execPath, ["-e", "0"]);
    assert.ok(child.pid && child.pid > 1);
    const { initiativeId } = store.createPlan({ plan: basePlan, repoPath: "/repo", baseCommit: "abc" });
    store.claim("task-one", `executor-${child.pid}`, 60_000);
    store.transition("task-one", "running");
    assert.deepEqual(store.recoverDeadOwnerLeases(), ["task-one"]);
    assert.equal(store.getNode("task-one")?.status, "pending");
    const event = store.events("task-one").find((e) => e.kind === "lease_recovered");
    assert.equal(event?.payload.reason, "owner_process_dead");
    // A lease owned by a live process (this one) must be left alone.
    store.refreshReady(initiativeId);
    const leased = store.claim("task-one", `executor-${process.pid}`, 60_000);
    assert.deepEqual(store.recoverDeadOwnerLeases(), []);
    assert.equal(leased.status, "leased");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subtasks persist, go ready, unlock by dependency, and are claimed like tasks", () => {
  const { store, dir } = makeStore();
  try {
    const plan = {
      title: "Subtask initiative",
      epics: [{
        id: "epic-sub",
        title: "Core",
        tasks: [{
          id: "task-parent",
          title: "Parent",
          acceptanceCriteria: ["done"],
          subtasks: [
            { id: "sub-a", title: "First sub", acceptanceCriteria: ["a done"] },
            { id: "sub-b", title: "Second sub", dependsOn: ["sub-a"], acceptanceCriteria: ["b done"] },
          ],
        }],
      }],
    };
    const { initiativeId } = store.createPlan({ plan, repoPath: "/repo", baseCommit: "abc" });
    const a = store.getNode("sub-a")!;
    const b = store.getNode("sub-b")!;
    assert.equal(a.level, "subtask");
    assert.equal(a.parentId, "task-parent");
    assert.equal(a.status, "ready");
    assert.equal(b.status, "pending", "dependent subtask stays pending until sub-a completes");
    const claimed = store.claim("sub-a", "worker-1", 60000);
    assert.equal(claimed.status, "leased");
    store.transition("sub-a", "running");
    store.transition("sub-a", "completed");
    store.refreshReady(initiativeId);
    assert.equal(store.getNode("sub-b")!.status, "ready", "sub-b unlocks after sub-a completes");
    assert.ok(store.listReadyTasks(initiativeId).some((node) => node.id === "sub-b"), "subtask appears in listReadyTasks");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stamps fresh databases with the current schema version", () => {
  const { store, dir } = makeStore();
  try {
    assert.equal(store.schemaVersion(), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrates pre-versioning databases (user_version=0) to current, keeping data", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-store-"));
  const dbPath = join(dir, "state.sqlite3");
  const first = new Store(dbPath);
  try {
    first.recordEvent(null, "lifecycle_probe", { marker: "keep-me" });
  } finally {
    first.close();
  }
  // Simulate a database created before versioning existed.
  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA user_version = 0;");
  raw.close();

  const reopened = new Store(dbPath);
  try {
    assert.equal(reopened.schemaVersion(), 1);
    const rows = (reopened.db.prepare("SELECT payload_json FROM events WHERE kind = 'lifecycle_probe'").all()) as Array<{ payload_json: string }>;
    assert.equal(rows.length, 1);
    assert.match(rows[0].payload_json, /keep-me/);
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
