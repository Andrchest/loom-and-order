import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { infrastructureFailure, Orchestrator, ProfileLimiter } from "../src/executor.ts";
import { Store } from "../src/store.ts";
import type { AgentRuntime, AgentResult } from "../src/runtime.ts";
import type { AgentRole } from "../src/profiles.ts";
import type { ProfileManifest } from "../src/profiles.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(root: string): string {
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "base"]);
  return repo;
}

const profile: ProfileManifest = {
  id: "worker",
  role: "worker",
  piBin: "pi",
  model: "fake/local-model",
  pool: "local",
  skills: [],
  extensions: [],
  tools: ["read", "bash"],
  timeoutMs: 10_000,
  maxAttempts: 2,
  sandbox: { backend: "pi-sandbox", extensionPath: "/trusted/pi-sandbox.ts", allowedDomains: [], credentialMode: "host-auth" },
};
const reviewer: ProfileManifest = { ...profile, id: "reviewer", role: "reviewer" };
const researcher: ProfileManifest = { ...profile, id: "researcher", role: "researcher", pool: "codex" };
const release: ProfileManifest = { ...profile, id: "release", role: "release", pool: "codex", reviewPolicy: { reviewerRequired: true, gateRequired: true, allowIntegration: true } };

test("submission forwards the durable automatic GC policy", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-submit-policy-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  try {
    const orchestrator = new Orchestrator(store, new FakeRuntime(), {
      stateDir: join(root, "state"),
      gateCommand: ["git", "diff", "--check"],
      profiles: { worker: profile, reviewer },
    });
    const enabled = orchestrator.submit(repo, "Enabled", { title: "Enabled", epics: [{ title: "E", tasks: [{ title: "T" }] }] }, { autoPrune: true });
    const disabled = orchestrator.submit(repo, "Disabled", { title: "Disabled", epics: [{ title: "E", tasks: [{ title: "T" }] }] });
    assert.equal(enabled.autoPrune, true);
    assert.equal(disabled.autoPrune, false);
    assert.equal(store.getAutoPrune(enabled.initiativeId), true);
    assert.equal(store.getAutoPrune(disabled.initiativeId), false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("external role selection wins over requested profile id", () => {
  const altWorker: ProfileManifest = { ...profile, id: "worker-alt" };
  const highWorker: ProfileManifest = { ...profile, id: "worker-high" };
  const store = new Store(join(mkdtempSync(join(tmpdir(), "loom-and-order-selection-test-")), "state.sqlite3"));
  try {
    const orchestrator = new Orchestrator(store, new FakeRuntime(), {
      stateDir: "state",
      gateCommand: ["git", "diff", "--check"],
      profiles: { worker: profile, "worker-alt": altWorker, "worker-high": highWorker, reviewer },
      roleSelection: { worker: "worker-alt" },
    });
    const profileFor = (orchestrator as any).profileFor.bind(orchestrator);
    assert.equal(profileFor("worker").id, "worker-alt");
    assert.equal(profileFor("worker-high").id, "worker-alt");
    assert.equal(profileFor("reviewer").id, "reviewer");
    const plain = new Orchestrator(store, new FakeRuntime(), {
      stateDir: "state",
      gateCommand: ["git", "diff", "--check"],
      profiles: { worker: profile, "worker-alt": altWorker, reviewer },
    });
    assert.equal((plain as any).profileFor("worker").id, "worker");
  } finally {
    store.close();
  }
});

function fakeRaw(runId: string): any {
  return { runId, exitCode: 0, signal: null, timedOut: false, events: [], assistantText: "", agentEnded: true, stdoutPath: "fake.stdout", stderrPath: "fake.stderr", durationMs: 1, eventCounts: {}, toolCalls: 0, toolErrors: 0, usage: {}, telemetry: { inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, wallClockMs: 1, ttftMs: null, generationMs: null, tokensPerSecond: null, costUsd: 0, costSource: "local-zero" }, stdoutBytes: 0, stderrBytes: 0 };
}

class FakeRuntime implements AgentRuntime {
  calls: Array<{ role: string; cwd: string; prompt: string; sessionId?: string; continueSession?: boolean }> = [];
  private readonly extraWorkerCommit: boolean;
  constructor(extraWorkerCommit = false) {
    this.extraWorkerCommit = extraWorkerCommit;
  }
  async run(input: { role: AgentRole; profile: ProfileManifest; cwd: string; prompt: string; runId: string; agentId?: string }): Promise<AgentResult> {
    this.calls.push({ role: input.role, cwd: input.cwd, prompt: input.prompt, sessionId: (input as any).sessionId, continueSession: (input as any).continueSession });
    const raw = fakeRaw(input.runId);
    if (input.role === "worker") {
      writeFileSync(join(input.cwd, "worker-output.txt"), `${Date.now()}\n`);
      git(input.cwd, ["add", "worker-output.txt"]);
      git(input.cwd, ["commit", "-m", "implement task"]);
      if (this.extraWorkerCommit) {
        writeFileSync(join(input.cwd, "second-output.txt"), "extra\n");
        git(input.cwd, ["add", "second-output.txt"]);
        git(input.cwd, ["commit", "-m", "second task commit"]);
      }
      return { ok: true, output: "implemented", exitCode: 0, runId: input.runId, raw };
    }
    return { ok: true, output: JSON.stringify({ verdict: "pass", findings: [], evidence: { checks: ["fake"] } }), exitCode: 0, runId: input.runId, raw };
  }
}

test("classifies infrastructure failures separately from agent results", () => {
  const base = { exitCode: 0, signal: null, timedOut: false, agentEnded: true };
  assert.equal(infrastructureFailure({ raw: { ...base, timedOut: true } }), true);
  assert.equal(infrastructureFailure({ raw: { ...base, exitCode: 1 } }), true);
  assert.equal(infrastructureFailure({ raw: { ...base, agentEnded: false } }), true);
  assert.equal(infrastructureFailure({ raw: base }), false);
  assert.equal(infrastructureFailure(new Error("provider transport")), true);
});

test("enforces four Codex slots and one local slot", async () => {
  const limiter = new ProfileLimiter();
  const codex = { ...profile, id: "codex-worker", pool: "codex" as const };
  let active = 0;
  let maximum = 0;
  await Promise.all(Array.from({ length: 10 }, () => limiter.run(codex, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  })));
  assert.equal(maximum, 4);

  const local = { ...profile, id: "local-worker", pool: "local" as const };
  active = 0;
  maximum = 0;
  await Promise.all(Array.from({ length: 4 }, () => limiter.run(local, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  })));
  assert.equal(maximum, 1);

  const localManager = { ...local, id: "local-manager", role: "manager" as const };
  active = 0;
  maximum = 0;
  await Promise.all(Array.from({ length: 3 }, () => limiter.run(localManager, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  })));
  assert.equal(maximum, 1);
});

test("runs dependency-ordered tasks in isolated worktrees and integrates reviewed commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-executor-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  const runtime = new FakeRuntime();
  try {
    const orchestrator = new Orchestrator(store, runtime, {
      stateDir: join(root, "state"),
      gateCommand: ["git", "diff", "--check"],
      profiles: { worker: profile, reviewer },
    });
    const submitted = orchestrator.submit(repo, "Build the feature", {
      title: "Feature",
      epics: [{ id: "epic", title: "Core", tasks: [
        { id: "first", title: "First", description: "first", acceptanceCriteria: ["first works"] },
        { id: "second", title: "Second", description: "second", dependsOn: ["first"], acceptanceCriteria: ["second works"] },
      ] }],
    });
    store.saveArchitectureContract({
      version: 1,
      revision: 1,
      initiativeId: submitted.initiativeId,
      author: { role: "architect", profileId: "architect", model: "fake/architect" },
      createdAt: new Date().toISOString(),
      summary: "Test architecture",
      decisions: ["Use isolated worktrees"],
      constraints: ["Do not edit main"],
      invariants: ["Reviewed code only"],
      interfaces: ["Worker API"],
      taskGuidance: ["Run focused tests"],
    });
    const result = await orchestrator.runInitiative(submitted.initiativeId);
    assert.equal(result.status, "completed");
    assert.equal(store.getNode("first")?.status, "completed");
    assert.equal(store.getNode("second")?.status, "completed");
    assert.ok(store.getNode("epic")?.integratedCommit);
    const metrics = store.metricSummary(submitted.initiativeId);
    assert.equal(metrics.byRole.worker.runs, 2);
    assert.equal(metrics.byRole.reviewer.runs, 2);
    assert.equal(metrics.byRole.gate.runs, 4);
    assert.equal(metrics.outcomes.pass, 6);
    assert.equal(metrics.byModel["fake/local-model"].runs, 4);
    const workerMetric = store.metrics(submitted.initiativeId).find((metric) => metric.role === "worker");
    assert.equal(workerMetric?.dimensions?.profile, "worker");
    assert.equal(workerMetric?.dimensions?.model, "fake/local-model");
    assert.equal(runtime.calls.filter((call) => call.role === "worker").length, 2);
    assert.equal(runtime.calls.filter((call) => call.role === "reviewer").length, 2);
    assert.match(runtime.calls.find((call) => call.role === "worker")?.prompt ?? "", /Test architecture/);
    assert.match(runtime.calls.find((call) => call.role === "reviewer")?.prompt ?? "", /Reviewed code only/);
    assert.notEqual(store.getNode("first")?.worktreePath, store.getNode("second")?.worktreePath);
    assert.match(readFileSync(join(store.getNode("epic")!.worktreePath!, "worker-output.txt"), "utf8"), /\d/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not preflight a task's own produced artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-own-artifacts-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  try {
    const runtime = new FakeRuntime();
    const orchestrator = new Orchestrator(store, runtime, { stateDir: join(root, "state"), gateCommand: ["git", "diff", "--check"], profiles: { worker: profile, reviewer } });
    const submitted = orchestrator.submit(repo, "Own outputs", { title: "Own outputs", epics: [{ title: "Core", tasks: [{ id: "task", architectureAlias: "domain", title: "Domain", acceptanceCriteria: ["works"] }] }] });
    store.saveArchitectureContract({
      version: 2,
      revision: 1,
      initiativeId: submitted.initiativeId,
      author: { role: "architect", profileId: "architect", model: "fake/architect" },
      createdAt: new Date().toISOString(),
      summary: "Own outputs",
      decisions: ["Task creates its own files"],
      constraints: ["No external inputs"],
      invariants: ["Preflight never waits for own outputs"],
      interfaces: ["domain"],
      taskGuidance: ["Create model"],
      executionPlan: {
        tasks: [{ alias: "domain", title: "Domain", objective: "Create model", produces: ["worker-output.txt"], deliverables: ["Model"], requiredArtifacts: [], prerequisites: [], dependsOn: [], verification: ["gate"] }],
        integrationOrder: ["domain"],
        preflightChecks: ["paths"],
        repairPolicy: "one repair then escalation",
      },
    });
    const result = await orchestrator.runInitiative(submitted.initiativeId);
    assert.equal(result.status, "completed");
    assert.equal(store.getNode("task")?.status, "completed");
    assert.equal(store.events("task").some((event) => event.kind === "dependency_preflight_blocked"), false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("materializes integrated cross-epic dependencies into the dependent task base", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-cross-epic-base-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  try {
    const orchestrator = new Orchestrator(store, new FakeRuntime(), {
      stateDir: join(root, "state"),
      gateCommand: ["git", "diff", "--check"],
      profiles: { worker: profile, reviewer },
    });
    const submitted = orchestrator.submit(repo, "Cross-epic dependency", {
      title: "Cross-epic dependency",
      epics: [
        { id: "producer-epic", title: "Producer", tasks: [{ id: "producer", title: "Produce artifact", acceptanceCriteria: ["artifact exists"] }] },
        { id: "consumer-epic", title: "Consumer", tasks: [{ id: "consumer", title: "Consume artifact", dependsOn: ["producer"], acceptanceCriteria: ["artifact is available"] }] },
      ],
    });
    const result = await orchestrator.runInitiative(submitted.initiativeId);
    assert.equal(result.status, "completed");
    const dependencyEvent = store.events("consumer").find((event) => event.kind === "dependency_base_resolved");
    assert.ok(dependencyEvent);
    assert.equal((dependencyEvent?.payload as any).dependencies[0].nodeId, "producer");
    assert.equal((dependencyEvent?.payload as any).dependencies[0].merged, true);
    assert.ok(store.getNode("consumer")?.baseCommit);
    assert.match(readFileSync(join(store.getNode("consumer")!.worktreePath!, "worker-output.txt"), "utf8"), /\d/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovers a bounded same-epic integration conflict and reruns the task on the merged base", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-integration-recovery-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  const runtime = new FakeRuntime();
  try {
    const orchestrator = new Orchestrator(store, runtime, {
      stateDir: join(root, "state"),
      gateCommand: ["git", "diff", "--check"],
      profiles: { worker: profile, reviewer },
    });
    const submitted = orchestrator.submit(repo, "Parallel integration", {
      title: "Parallel integration",
      epics: [{ id: "epic", title: "Core", tasks: [
        { id: "first", title: "First", acceptanceCriteria: ["first works"] },
        { id: "second", title: "Second", acceptanceCriteria: ["second works"] },
      ] }],
    });
    const result = await orchestrator.runInitiative(submitted.initiativeId);
    assert.equal(result.status, "completed");
    assert.equal(store.getNode("first")?.status, "completed");
    assert.equal(store.getNode("second")?.status, "completed");
    const recovered = ["first", "second"].flatMap((id) => store.events(id)).filter((event) => event.kind === "integration_recovery_scheduled");
    assert.equal(recovered.length, 1);
    assert.equal(runtime.calls.filter((call) => call.role === "worker").length, 3);
    assert.equal(store.metricSummary(submitted.initiativeId).recoveryCount, 1);
    assert.equal(git(store.getNode("epic")!.worktreePath!, ["status", "--porcelain"]), "");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not complete a task when the post-merge epic gate fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-post-merge-gate-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  try {
    const orchestrator = new Orchestrator(store, new FakeRuntime(), {
      stateDir: join(root, "state"),
      gateCommand: ["node", "-e", "const {execFileSync}=require('node:child_process'); process.exit(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).includes('/epic-') ? 1 : 0)"],
      profiles: { worker: profile, reviewer },
    });
    const submitted = orchestrator.submit(repo, "Post-merge gate", {
      title: "Post-merge gate",
      epics: [{ id: "epic", title: "Core", tasks: [{ id: "task", title: "Task", acceptanceCriteria: ["gate the integrated branch"] }] }],
    });
    const result = await orchestrator.runInitiative(submitted.initiativeId);
    assert.equal(result.status, "blocked");
    assert.equal(store.getNode("task")?.status, "blocked");
    assert.equal(store.getNode("task")?.integratedCommit, null);
    assert.equal(store.events("task").filter((event) => event.kind === "post_merge_gate_failed").length, 2);
    assert.equal(git(store.getNode("epic")!.worktreePath!, ["status", "--porcelain"]), "");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocks a worker that leaves more than one commit since its task base", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-commit-policy-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  try {
    const orchestrator = new Orchestrator(store, new FakeRuntime(true), {
      stateDir: join(root, "state"),
      gateCommand: ["git", "diff", "--check"],
      profiles: { worker: profile, reviewer },
    });
    const submitted = orchestrator.submit(repo, "Commit policy", {
      title: "Policy",
      epics: [{ id: "epic", title: "Core", tasks: [{ id: "task", title: "Task", acceptanceCriteria: ["one commit"] }] }],
    });
    const result = await orchestrator.runInitiative(submitted.initiativeId);
    assert.equal(result.status, "blocked");
    assert.match(store.getNode("task")?.failure ?? "", /exactly one clean commit/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocks a task at dependency preflight without launching worker or reviewer", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-preflight-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  const runtime = new FakeRuntime();
  try {
    const orchestrator = new Orchestrator(store, runtime, {
      stateDir: join(root, "state"),
      gateCommand: ["git", "diff", "--check"],
      profiles: { worker: profile, reviewer },
    });
    const submitted = orchestrator.submit(repo, "Build the feature", {
      title: "Feature",
      epics: [{ id: "epic", title: "Core", tasks: [{ id: "task", architectureAlias: "needs-base", title: "Needs base", acceptanceCriteria: ["works"] }] }],
    });
    store.saveArchitectureContract({
      version: 2,
      revision: 1,
      initiativeId: submitted.initiativeId,
      author: { role: "architect", profileId: "architect", model: "fake/architect" },
      createdAt: new Date().toISOString(),
      summary: "System-aware architecture",
      decisions: ["Declare prerequisites"],
      constraints: ["Do not edit main"],
      invariants: ["Workers start only after artifacts exist"],
      interfaces: ["Worker API"],
      taskGuidance: ["Create the base before consuming it"],
      executionPlan: {
        tasks: [{ alias: "needs-base", title: "Needs base", objective: "Consume the base", produces: [], deliverables: [], requiredArtifacts: ["src/base.ts"], prerequisites: [], dependsOn: [], verification: ["test"] }],
        integrationOrder: ["needs-base"],
        preflightChecks: ["required artifacts exist"],
        repairPolicy: "one repair then escalation",
      },
    });
    const result = await orchestrator.runInitiative(submitted.initiativeId);
    assert.equal(result.status, "waiting");
    assert.equal(store.getNode("task")?.status, "waiting_external");
    assert.equal(store.getNode("task")?.recoveryOwner, "operator");
    assert.match(store.getNode("task")?.unblockCondition ?? "", /^artifacts:/);
    assert.equal(runtime.calls.filter((call) => call.role === "worker").length, 0);
    assert.equal(runtime.calls.filter((call) => call.role === "reviewer").length, 0);
    assert.equal(store.events("task").some((event) => event.kind === "dependency_preflight_blocked"), true);
    assert.equal(store.metrics(submitted.initiativeId).some((metric) => metric.counters.dependency_preflight_blocked === 1), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runs researcher tasks read-only without worktree integration", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-researcher-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  const runtime = new FakeRuntime();
  try {
    const orchestrator = new Orchestrator(store, runtime, { stateDir: join(root, "state"), gateCommand: ["git", "diff", "--check"], profiles: { worker: profile, reviewer, researcher } });
    const submitted = orchestrator.submit(repo, "Research", { title: "Research", epics: [{ title: "E", tasks: [{ id: "research", title: "Research", profileId: "researcher", acceptanceCriteria: ["report"] }] }] });
    const result = await orchestrator.runInitiative(submitted.initiativeId);
    assert.equal(result.status, "completed");
    assert.equal(store.getNode("research")?.status, "completed");
    assert.equal(store.getNode("research")?.worktreePath, null);
    assert.equal(store.metricSummary(submitted.initiativeId).byRole.researcher.runs, 1);
    assert.equal(runtime.calls.some((call) => call.role === "researcher"), true);
    assert.match(runtime.calls.find((call) => call.role === "researcher")?.prompt ?? "", /RESEARCH_RESULT: complete/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps release profile inactive unless explicitly scheduled", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-release-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  try {
    const orchestrator = new Orchestrator(store, new FakeRuntime(), { stateDir: join(root, "state"), gateCommand: ["git", "diff", "--check"], profiles: { worker: profile, reviewer, release } });
    const submitted = orchestrator.submit(repo, "Release", { title: "Release", epics: [{ title: "E", tasks: [{ id: "release-task", title: "Release", profileId: "release" }] }] });
    const result = await orchestrator.runInitiative(submitted.initiativeId);
    assert.equal(result.status, "blocked");
    assert.match(store.getNode("release-task")?.failure ?? "", /inactive/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("repairs a reviewer failure once before integration", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-review-repair-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  const runtime = new FakeRuntime();
  let reviews = 0;
  runtime.run = async function (input) {
    this.calls.push({ role: input.role, cwd: input.cwd, prompt: input.prompt, sessionId: input.sessionId, continueSession: input.continueSession });
    const raw = fakeRaw(input.runId);
    if (input.role === "worker") {
      writeFileSync(join(input.cwd, "implementation.txt"), "fixed\n");
      git(input.cwd, ["add", "."]);
      git(input.cwd, ["commit", "-m", "implementation"]);
      return { ok: true, output: "implemented", exitCode: 0, runId: input.runId, raw };
    }
    reviews += 1;
    return { ok: true, output: JSON.stringify(reviews === 1 ? { verdict: "fail", findings: ["add invariant coverage"], evidence: {} } : { verdict: "pass", findings: [], evidence: { checks: ["repair"] } }), exitCode: 0, runId: input.runId, raw };
  };
  try {
    const orchestrator = new Orchestrator(store, runtime, { stateDir: join(root, "state"), gateCommand: ["git", "diff", "--check"], profiles: { worker: profile, reviewer } });
    const submitted = orchestrator.submit(repo, "Repair review", { title: "Repair", epics: [{ title: "E", tasks: [{ id: "task", title: "Task", acceptanceCriteria: ["x"] }] }] });
    const result = await orchestrator.runInitiative(submitted.initiativeId);
    assert.equal(result.status, "completed");
    assert.equal(store.getNode("task")?.status, "completed");
    assert.equal(runtime.calls.filter((call) => call.role === "worker").length, 2);
    assert.match(runtime.calls.filter((call) => call.role === "worker")[1]?.prompt ?? "", /add invariant coverage/);
    assert.equal(runtime.calls.filter((call) => call.role === "worker")[1]?.continueSession, true);
    assert.equal(runtime.calls.filter((call) => call.role === "worker")[1]?.sessionId, "task-worker-1");
    assert.equal(store.metricSummary(submitted.initiativeId).byRole.gate.runs, 2);
    assert.equal(store.events("task").some((event) => event.kind === "conversational_feedback_completed"), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("escalates exhausted repairs to Manager and Architect before a third attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-manager-recovery-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  const runtime = new FakeRuntime();
  let reviews = 0;
  runtime.run = async function (input) {
    this.calls.push({ role: input.role, cwd: input.cwd, prompt: input.prompt });
    const raw = fakeRaw(input.runId);
    if (input.role === "worker") {
      writeFileSync(join(input.cwd, "implementation.txt"), `${this.calls.length}\n`);
      git(input.cwd, ["add", "."]);
      git(input.cwd, ["commit", "-m", "implementation"]);
      return { ok: true, output: "implemented", exitCode: 0, runId: input.runId, raw };
    }
    if (input.role === "reviewer") {
      reviews += 1;
      return { ok: true, output: JSON.stringify(reviews < 3 ? { verdict: "fail", findings: ["architecture needs revision"], evidence: {} } : { verdict: "pass", findings: [], evidence: {} }), exitCode: 0, runId: input.runId, raw };
    }
    if (input.role === "manager") return { ok: true, output: JSON.stringify({ action: "architect", nodeId: "task", reason: "cross-cutting invariant", edits: [], note: "escalate" }), exitCode: 0, runId: input.runId, raw };
    return { ok: true, output: JSON.stringify({ summary: "Revised architecture", decisions: ["Revise invariant"], constraints: ["Keep API stable"], invariants: ["All terminal states are valid"], interfaces: ["GameState"], taskGuidance: ["Add negative tests"], executionPlan: { tasks: [{ alias: "task", title: "Task", objective: "Repair the task", produces: [], deliverables: [], requiredArtifacts: [], prerequisites: [], dependsOn: [], verification: ["review"] }], integrationOrder: ["task"], preflightChecks: ["clean worktree"], repairPolicy: "one repair then escalation" } }), exitCode: 0, runId: input.runId, raw };
  };
  const manager = { ...profile, id: "manager", role: "manager" as const, model: "fake/manager" };
  const architect = { ...profile, id: "architect", role: "architect" as const, model: "fake/architect" };
  try {
    const orchestrator = new Orchestrator(store, runtime, { stateDir: join(root, "state"), gateCommand: ["git", "diff", "--check"], profiles: { worker: profile, reviewer, manager, architect } });
    const submitted = orchestrator.submit(repo, "Recovery", { title: "Recovery", epics: [{ title: "E", tasks: [{ id: "task", title: "Task", acceptanceCriteria: ["x"] }] }] });
    const result = await orchestrator.runInitiative(submitted.initiativeId);
    assert.equal(result.status, "completed");
    assert.equal(runtime.calls.filter((call) => call.role === "worker").length, 3);
    assert.equal(runtime.calls.filter((call) => call.role === "manager").length, 1);
    assert.equal(runtime.calls.filter((call) => call.role === "architect").length, 1);
    assert.equal(store.getArchitectureContract(submitted.initiativeId)?.summary, "Revised architecture");
    assert.equal(store.events("task").some((event) => event.kind === "manager_recovery_decision"), true);
    assert.equal(store.events("task").some((event) => event.kind === "architecture_escalated"), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("routes durable manager recovery checkpoints before retrying a task", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-manager-checkpoint-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  const runtime = new FakeRuntime();
  const manager = { ...profile, id: "manager", role: "manager" as const, model: "fake/manager" };
  runtime.run = async function (input) {
    this.calls.push({ role: input.role, cwd: input.cwd, prompt: input.prompt });
    const raw = fakeRaw(input.runId);
    if (input.role === "manager") return { ok: true, output: JSON.stringify({ action: "retry", nodeId: "task", reason: "retry after worktree repair", edits: [] }), exitCode: 0, runId: input.runId, raw };
    if (input.role === "worker") {
      writeFileSync(join(input.cwd, "implementation.txt"), "recovered\n");
      git(input.cwd, ["add", "."]);
      git(input.cwd, ["commit", "-m", "recovered"]);
      return { ok: true, output: "implemented", exitCode: 0, runId: input.runId, raw };
    }
    return { ok: true, output: JSON.stringify({ verdict: "pass", findings: [], evidence: {} }), exitCode: 0, runId: input.runId, raw };
  };
  try {
    const orchestrator = new Orchestrator(store, runtime, { stateDir: join(root, "state"), gateCommand: ["git", "diff", "--check"], profiles: { worker: profile, reviewer, manager } });
    const submitted = orchestrator.submit(repo, "Manager checkpoint", { title: "Manager checkpoint", epics: [{ title: "E", tasks: [{ id: "task", title: "Task", acceptanceCriteria: ["x"] }] }] });
    store.transition("task", "needs_manager", { reason: "worktree setup failed", recoveryOwner: "manager", recoveryScope: "task", requiredAction: "retry", unblockCondition: "manager recovery decision", recoveryEpoch: 1 });
    store.refreshRollups(submitted.initiativeId);
    const result = await orchestrator.runInitiative(submitted.initiativeId);
    assert.equal(result.status, "completed");
    assert.equal(runtime.calls.filter((call) => call.role === "manager").length, 1);
    assert.equal(store.events("task").some((event) => event.kind === "manager_recovery_decision"), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not integrate a failed reviewer and records a blocked task after retry bound", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-review-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  const runtime = new FakeRuntime();
  runtime.run = async function (input) {
    this.calls.push({ role: input.role, cwd: input.cwd, prompt: input.prompt });
    const raw = fakeRaw(input.runId);
    if (input.role === "worker") {
      writeFileSync(join(input.cwd, `attempt-${this.calls.length}.txt`), "change\n");
      git(input.cwd, ["add", "."]);
      git(input.cwd, ["commit", "-m", "change"]);
      return { ok: true, output: "implemented", exitCode: 0, runId: input.runId, raw };
    }
    return { ok: true, output: JSON.stringify({ verdict: "fail", findings: ["missing evidence"], evidence: {} }), exitCode: 0, runId: input.runId, raw };
  };
  try {
    const orchestrator = new Orchestrator(store, runtime, { stateDir: join(root, "state"), gateCommand: ["git", "diff", "--check"], profiles: { worker: profile, reviewer } });
    const submitted = orchestrator.submit(repo, "Fail review", { title: "Failure", epics: [{ title: "E", tasks: [{ id: "task", title: "Task", acceptanceCriteria: ["x"] }] }] });
    const result = await orchestrator.runInitiative(submitted.initiativeId);
    assert.equal(result.status, "blocked");
    assert.equal(store.getNode("task")?.status, "blocked");
    assert.equal(store.latestReview("task")?.verdict, "fail");
    assert.equal(store.getNode("task")?.integratedCommit, null);
    assert.equal(runtime.calls.filter((call) => call.role === "worker").length, 2);
    assert.match(runtime.calls.filter((call) => call.role === "worker")[1]?.prompt ?? "", /missing evidence/);
    assert.equal(store.events("task").some((event) => event.kind === "conversational_feedback_completed"), true);
    assert.equal(store.events("task").some((event) => event.kind === "repair_escalated"), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("discards manager plan edits that reference unknown profiles", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-mgredit-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  const runtime = new FakeRuntime();
  const manager = { ...profile, id: "manager", role: "manager" as const, model: "fake/manager" };
  runtime.run = async function (input) {
    this.calls.push({ role: input.role, cwd: input.cwd, prompt: input.prompt });
    const raw = fakeRaw(input.runId);
    if (input.role === "manager") {
      return { ok: true, output: JSON.stringify({ action: "block", nodeId: "task", reason: "needs guidance", edits: [{ nodeId: "task", profileId: "ghost-profile" }] }), exitCode: 0, runId: input.runId, raw };
    }
    if (input.role === "worker") {
      writeFileSync(join(input.cwd, "implementation.txt"), "done\n");
      git(input.cwd, ["add", "."]);
      git(input.cwd, ["commit", "-m", "done"]);
      return { ok: true, output: "implemented", exitCode: 0, runId: input.runId, raw };
    }
    return { ok: true, output: JSON.stringify({ verdict: "pass", findings: [], evidence: {} }), exitCode: 0, runId: input.runId, raw };
  };
  try {
    const orchestrator = new Orchestrator(store, runtime, { stateDir: join(root, "state"), gateCommand: ["git", "diff", "--check"], profiles: { worker: profile, reviewer, manager } });
    const submitted = orchestrator.submit(repo, "Manager edit", { title: "Manager edit", epics: [{ title: "E", tasks: [{ id: "task", title: "Task", acceptanceCriteria: ["x"] }] }] });
    store.addMessage(submitted.initiativeId, "please adjust the profile");
    await orchestrator.runInitiative(submitted.initiativeId);
    // The invalid edit must be discarded: the profile stays unset, the manager is
    // not re-run in a crash loop, and the guidance reaches the worker prompt.
    assert.equal(store.getNode("task")?.profileId, null);
    assert.equal(runtime.calls.filter((call) => call.role === "manager").length, 1);
    assert.match(runtime.calls.filter((call) => call.role === "worker")[0]?.prompt ?? "", /please adjust the profile/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocks a task when execution preparation fails inside executeTaskInternal", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-prepfail-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  const runtime = new FakeRuntime();
  try {
    const orchestrator = new Orchestrator(store, runtime, { stateDir: join(root, "state"), gateCommand: ["git", "diff", "--check"], profiles: { worker: profile, reviewer } });
    const submitted = orchestrator.submit(repo, "Prep fail", { title: "Prep fail", epics: [{ title: "E", tasks: [{ id: "task", title: "Task", acceptanceCriteria: ["x"] }] }] });
    // Pause the task so the lease claim inside executeTaskInternal fails; the
    // preparation guard must block the task instead of rejecting the run.
    store.transition("task", "paused");
    await (orchestrator as any).executeTaskInternal(store.getNode("task"));
    assert.equal(store.getNode("task")?.status, "blocked");
    assert.match(store.getNode("task")?.failure ?? "", /task preparation failed/);
    assert.equal(runtime.calls.length, 0);
    assert.equal(store.events("task").some((event) => event.kind === "task_preparation_failed"), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocks a task with an unconfigured profile instead of crashing the run", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-badprofile-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  const runtime = new FakeRuntime();
  try {
    const orchestrator = new Orchestrator(store, runtime, { stateDir: join(root, "state"), gateCommand: ["git", "diff", "--check"], profiles: { worker: profile, reviewer } });
    const submitted = orchestrator.submit(repo, "Bad profile", { title: "Bad profile", epics: [{ title: "E", tasks: [{ id: "task", title: "Task", acceptanceCriteria: ["x"], profileId: "ghost-profile" }] }] });
    const result = await orchestrator.runInitiative(submitted.initiativeId);
    assert.equal(result.status, "blocked");
    assert.equal(store.getNode("task")?.status, "blocked");
    assert.match(store.getNode("task")?.failure ?? "", /profile not configured: ghost-profile/);
    assert.equal(runtime.calls.length, 0);
    assert.equal(store.events("task").some((event) => event.kind === "profile_resolution_failed"), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lease heartbeat refreshes lease_until for owned nodes in active statuses", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-leasehb-store-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  try {
    const orchestrator = new Orchestrator(store, new FakeRuntime(), {
      stateDir: join(root, "state"),
      gateCommand: ["git", "diff", "--check"],
      profiles: { worker: profile, reviewer },
    });
    const submitted = orchestrator.submit(repo, "Lease heartbeat", {
      title: "Lease heartbeat",
      epics: [{ title: "E", tasks: [{ id: "hb", title: "HB", description: "d", acceptanceCriteria: ["x"] }] }],
    });
    store.saveArchitectureContract({
      version: 1,
      revision: 1,
      initiativeId: submitted.initiativeId,
      author: { role: "architect", profileId: "architect", model: "fake/a" },
      createdAt: new Date().toISOString(),
      summary: "s",
      decisions: ["d"],
      constraints: ["c"],
      invariants: ["i"],
      interfaces: ["f"],
      taskGuidance: ["g"],
    });
    store.refreshReady(submitted.initiativeId);
    const owner = "executor-test";
    const task = store.claim("hb", owner, 10_000);
    // Deterministic freshness check: the heartbeat must set lease_until to
    // now+ttl (a strict > comparison flakes when claim and heartbeat land in
    // the same millisecond).
    const assertFreshLease = (status: string) => {
      const at = Date.now();
      const previous = new Date(store.getNode(task.id)!.leaseUntil!).getTime();
      store.heartbeat(task.id, owner, 10_000);
      const lease = new Date(store.getNode(task.id)!.leaseUntil!).getTime();
      // Lower bound proves the lease was recomputed from "now" (fresh refresh);
      // an upper bound would flake because the internal Date.now() can lag the
      // test's under a loaded SQLite (hundreds of ms per op on slow hosts).
      assert.ok(lease >= at + 10_000 - 5, `heartbeat in ${status} must refresh lease_until to now+ttl (got ${lease}, expected >= ${at + 10_000 - 5})`);
      assert.ok(lease >= previous, `heartbeat in ${status} must not shorten the lease`);
    };
    store.transition(task.id, "running");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assertFreshLease("running");
    store.transition(task.id, "reviewing");
    assertFreshLease("reviewing");
    store.transition(task.id, "integrating");
    assertFreshLease("integrating");
    assert.throws(() => store.heartbeat(task.id, "someone-else", 10_000), /lease not owned/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

class SlowWorkerRuntime extends FakeRuntime {
  // The wiring test needs the worker session to outlive at least one lease
  // heartbeat tick (leaseHeartbeatMs: 50); a fast fake finish can skip it.
  override async run(input: { role: AgentRole; profile: ProfileManifest; cwd: string; prompt: string; runId: string; agentId?: string }): Promise<AgentResult> {
    if (input.role === "worker") await new Promise((resolve) => setTimeout(resolve, 120));
    return super.run(input);
  }
}

test("executor refreshes the task lease while executing the task", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-leasehb-wiring-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  try {
    const orchestrator = new Orchestrator(store, new SlowWorkerRuntime(), {
      stateDir: join(root, "state"),
      gateCommand: ["git", "diff", "--check"],
      profiles: { worker: profile, reviewer },
      leaseHeartbeatMs: 50,
    });
    const submitted = orchestrator.submit(repo, "Lease wiring", {
      title: "Lease wiring",
      epics: [{ title: "Core", tasks: [{ id: "beat", title: "Beat", description: "d", acceptanceCriteria: ["x"] }] }],
    });
    store.saveArchitectureContract({
      version: 1,
      revision: 1,
      initiativeId: submitted.initiativeId,
      author: { role: "architect", profileId: "architect", model: "fake/a" },
      createdAt: new Date().toISOString(),
      summary: "s",
      decisions: ["d"],
      constraints: ["c"],
      invariants: ["i"],
      interfaces: ["f"],
      taskGuidance: ["g"],
    });
    let heartbeatCalls = 0;
    const originalHeartbeat = store.heartbeat.bind(store);
    (store as any).heartbeat = (...args: Parameters<typeof store.heartbeat>) => {
      heartbeatCalls += 1;
      return originalHeartbeat(...args);
    };
    const result = await orchestrator.runInitiative(submitted.initiativeId);
    assert.equal(result.status, "completed");
    assert.equal(store.getNode("beat")?.status, "completed");
    assert.ok(heartbeatCalls > 0, "executor must refresh the task lease while executing");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

class SubtaskFakeRuntime extends FakeRuntime {
  // Each node writes a unique file so parallel branches never conflict at merge.
  override async run(input: { role: AgentRole; profile: ProfileManifest; cwd: string; prompt: string; runId: string; agentId?: string }): Promise<AgentResult> {
    if (input.role === "worker") {
      const node = input.cwd.split(/[/\\]/).filter(Boolean).pop() ?? "node";
      writeFileSync(join(input.cwd, `output-${node}.txt`), `${Date.now()}\n`);
      git(input.cwd, ["add", `output-${node}.txt`]);
      git(input.cwd, ["commit", "-m", "implement task"]);
      return { ok: true, output: "implemented", exitCode: 0, runId: input.runId, raw: fakeRaw(input.runId) };
    }
    return super.run(input);
  }
}

test("runs subtask nodes in their own worktrees and integrates each into the epic", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-subtasks-"));
  const repo = makeRepo(root);
  const store = new Store(join(root, "state", "state.sqlite3"));
  const runtime = new SubtaskFakeRuntime();
  try {
    const orchestrator = new Orchestrator(store, runtime, {
      stateDir: join(root, "state"),
      gateCommand: ["git", "diff", "--check"],
      profiles: { worker: profile, reviewer },
    });
    const submitted = orchestrator.submit(repo, "Feature with subtasks", {
      title: "Feature with subtasks",
      epics: [{ id: "epic", title: "Core", tasks: [
        { id: "parent", title: "Parent", description: "umbrella task", acceptanceCriteria: ["parent works"],
          subtasks: [
            { id: "sub-1", title: "Sub 1", description: "first slice", acceptanceCriteria: ["slice 1 works"] },
            { id: "sub-2", title: "Sub 2", description: "second slice", dependsOn: ["sub-1"], acceptanceCriteria: ["slice 2 works"] },
          ] },
      ] }],
    });
    store.saveArchitectureContract({
      version: 1,
      revision: 1,
      initiativeId: submitted.initiativeId,
      author: { role: "architect", profileId: "architect", model: "fake/architect" },
      createdAt: new Date().toISOString(),
      summary: "Test architecture",
      decisions: ["Use isolated worktrees"],
      constraints: ["Do not edit main"],
      invariants: ["Reviewed code only"],
      interfaces: ["Worker API"],
      taskGuidance: ["Run focused tests"],
    });
    const result = await orchestrator.runInitiative(submitted.initiativeId);
    assert.equal(result.status, "completed");
    for (const id of ["parent", "sub-1", "sub-2"]) {
      const node = store.getNode(id)!;
      assert.equal(node.status, "completed", `${id} must complete`);
      assert.ok(node.integratedCommit, `${id} must be integrated into the epic`);
    }
    const sub1 = store.getNode("sub-1")!;
    const sub2 = store.getNode("sub-2")!;
    assert.notEqual(sub1.worktreePath, sub2.worktreePath, "subtasks get isolated worktrees");
    assert.equal(sub1.parentId, "parent");
    const epic = store.getNode("epic")!;
    // All three commits (parent + both subtasks) landed in the epic worktree.
    const log = git(epic.worktreePath!, ["log", "--format=%s"]);
    const merges = log.split("\n").filter((line) => line.startsWith("Merge branch")).length;
    assert.equal(merges, 3, "parent and both subtasks merge into the epic");
    assert.equal(log.split("\n").filter((line) => line === "implement task").length, 3);
    assert.equal(store.metricSummary(submitted.initiativeId).byRole.worker.runs, 3);
    assert.equal(store.metricSummary(submitted.initiativeId).byRole.reviewer.runs, 3);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
