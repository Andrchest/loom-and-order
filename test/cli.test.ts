import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ApplicationService, detachedRunInvocation } from "../src/application.ts";
import { GitWorkspace } from "../src/git.ts";
import { seedTestProfiles } from "./profile-fixtures.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const cli = join(root, "src", "cli.ts");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function repo(parent: string): string {
  const path = join(parent, "repo");
  execFileSync("git", ["init", "-b", "main", path]);
  git(path, ["config", "user.email", "test@example.invalid"]);
  git(path, ["config", "user.name", "Test"]);
  writeFileSync(join(path, "README.md"), "base\n");
  git(path, ["add", "."]); git(path, ["commit", "-m", "base"]);
  return path;
}

function runCli(args: string[]): any {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("builds an absolute detached runtime invocation with the state directory", () => {
  const invocation = detachedRunInvocation("/absolute/src/cli.ts", "initiative-test", "/tmp/loom-and-order-state");
  assert.equal(invocation.args[1], "/absolute/src/cli.ts");
  assert.deepEqual(invocation.args.slice(2), ["run", "initiative-test", "--state-dir", "/tmp/loom-and-order-state"]);
  assert.equal(invocation.env.LAO_STATE_DIR, "/tmp/loom-and-order-state");
});

test("runs Architect before Manager and persists the contract before detached execution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-architect-order-"));
  const target = repo(dir);
  const calls: string[] = [];
  const runtime = {
    async run(input: any): Promise<any> {
      calls.push(input.role);
      const output = input.role === "architect"
        ? JSON.stringify({ summary: "Pure design", decisions: ["Keep boundaries explicit"], constraints: ["No target writes"], invariants: ["DAG IDs are runner-owned"], interfaces: ["Architecture contract"], taskGuidance: ["Add invariant tests"], executionPlan: { tasks: [{ alias: "implement", title: "Implement", objective: "Implement the feature", produces: ["README.md"], requires: [], dependsOn: [], verification: ["works"] }], integrationOrder: ["implement"], preflightChecks: ["clean worktree"], repairPolicy: "one repair then escalation" } })
        : JSON.stringify({ title: "Feature", epics: [{ title: "Core", tasks: [{ architectureAlias: "implement", title: "Implement", acceptanceCriteria: ["works"] }] }] });
      return {
        ok: true,
        output,
        exitCode: 0,
        runId: input.runId,
        raw: { runId: input.runId, exitCode: 0, timedOut: false, agentEnded: true, durationMs: 1, toolCalls: 0, toolErrors: 0, stdoutBytes: 0, stderrBytes: 0, telemetry: {}, usage: {} },
      };
    },
  };
  const state = join(dir, "state");
  seedTestProfiles(state);
  const service = new ApplicationService({ stateDir: state, autoStart: true, runtime: runtime as any });
  try {
    (service as any).ensureToolchain = async () => undefined;
    (service as any).startDetached = () => undefined;
    const submitted = await service.submit(target, "Build it");
    assert.deepEqual(calls, ["architect", "manager"]);
    assert.equal(service.architectureContract(submitted.initiativeId)?.author.model, "openai-codex/gpt-5.5");
    assert.equal(service.architectureContract(submitted.initiativeId)?.summary, "Pure design");
    assert.equal(service.store.getNode(submitted.initiativeId)?.status, "draft");
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("feeds planning schema errors back through the same Architect and Manager sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-planning-feedback-"));
  const target = repo(dir);
  seedTestProfiles(join(dir, "state"));
  const calls: any[] = [];
  let architectCalls = 0;
  let managerCalls = 0;
  const architecture = JSON.stringify({ summary: "Pure design", decisions: ["Keep boundaries explicit"], constraints: ["No target writes"], invariants: ["DAG IDs are runner-owned"], interfaces: ["Architecture contract"], taskGuidance: ["Add invariant tests"], executionPlan: { tasks: [{ alias: "implement", title: "Implement", objective: "Implement the feature", produces: ["README.md"], requires: [], dependsOn: [], verification: ["works"] }], integrationOrder: ["implement"], preflightChecks: ["clean worktree"], repairPolicy: "one repair then escalation" } });
  const plan = JSON.stringify({ title: "Feature", epics: [{ title: "Core", tasks: [{ architectureAlias: "implement", title: "Implement", acceptanceCriteria: ["works"] }] }] });
  const runtime = {
    async run(input: any): Promise<any> {
      calls.push(input);
      const output = input.role === "architect"
        ? (++architectCalls === 1 ? "not valid architecture JSON" : architecture)
        : (++managerCalls === 1 ? "not valid manager JSON" : plan);
      return { ok: true, output, exitCode: 0, runId: input.runId, raw: { runId: input.runId, exitCode: 0, timedOut: false, agentEnded: true, durationMs: 1, toolCalls: 0, toolErrors: 0, stdoutBytes: 0, stderrBytes: 0, telemetry: {}, usage: {} } };
    },
  };
  const service = new ApplicationService({ stateDir: join(dir, "state"), autoStart: true, runtime: runtime as any });
  try {
    (service as any).ensureToolchain = async () => undefined;
    (service as any).startDetached = () => undefined;
    await service.submit(target, "Build it");
    const architectTurns = calls.filter((call) => call.role === "architect");
    const managerTurns = calls.filter((call) => call.role === "manager");
    assert.equal(architectTurns.length, 2);
    assert.equal(managerTurns.length, 2);
    assert.equal(architectTurns[1].continueSession, true);
    assert.equal(architectTurns[1].sessionId, architectTurns[0].runId);
    assert.equal(managerTurns[1].continueSession, true);
    assert.equal(managerTurns[1].sessionId, managerTurns[0].runId);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifies provider planning failures durably instead of reporting only invalid JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-provider-failure-"));
  const target = repo(dir);
  seedTestProfiles(join(dir, "state"));
  const stderrPath = join(dir, "provider.stderr");
  writeFileSync(stderrPath, "fetch failed: temporary upstream transport error\\n");
  const runtime = {
    async run(input: any): Promise<any> {
      return {
        ok: true,
        output: "not json",
        exitCode: 0,
        runId: input.runId,
        raw: { runId: input.runId, exitCode: 0, timedOut: false, agentEnded: true, stderrPath, durationMs: 1, toolCalls: 0, toolErrors: 0, telemetry: {}, usage: {} },
      };
    },
  };
  const service = new ApplicationService({ stateDir: join(dir, "state"), autoStart: true, runtime: runtime as any });
  try {
    (service as any).ensureToolchain = async () => undefined;
    (service as any).startDetached = async () => undefined;
    await assert.rejects(() => service.submit(target, "Provider failure"), /provider transport/);
    assert.equal(service.store.systemFailures().some((failure) => failure.kind === "provider_transport" && failure.role === "architect"), true);
    assert.equal(service.store.listInitiatives().length, 0);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("external guidance reopens a blocked initiative through the application API", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-external-guidance-"));
  const target = repo(dir);
  const state = join(dir, "state");
  const service = new ApplicationService({ stateDir: state, autoStart: false });
  try {
    const submitted = service.orchestrator.submit(target, "Guidance", { title: "Guidance", epics: [{ title: "E", tasks: [{ id: "task", title: "Task" }] }] });
    service.store.transition(submitted.initiativeId, "running");
    service.store.transition(submitted.initiativeId, "blocked", { reason: "test block" });
    let started = false;
    (service as any).startDetached = () => { started = true; };
    service.message(submitted.initiativeId, "add an invariant test");
    assert.equal(service.store.getNode(submitted.initiativeId)?.status, "running");
    assert.equal(service.store.pendingMessages(submitted.initiativeId)[0].body, "add an invariant test");
    assert.equal(started, true);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("external role profile selection is validated and applied at service start", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-role-selection-"));
  const state = join(dir, "state");
  seedTestProfiles(state);
  process.env.LAO_ROLE_PROFILES = JSON.stringify({
    worker: "test-worker",
    architect: "test-architect",
    manager: "test-manager",
    reviewer: "test-reviewer",
  });
  try {
    const service = new ApplicationService({ stateDir: state, autoStart: false });
    try {
      assert.equal(service.roleProfile("worker").id, "test-worker");
      assert.equal(service.roleProfile("architect").id, "test-architect");
      assert.equal(service.roleProfile("manager").id, "test-manager");
      assert.equal(service.roleProfile("reviewer").id, "test-reviewer");
      assert.equal(service.roleProfile("researcher").id, "test-researcher");
    } finally {
      service.close();
    }
  } finally {
    delete process.env.LAO_ROLE_PROFILES;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("external role profile selection rejects unknown profiles and role mismatches", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-role-selection-bad-"));
  const state = join(dir, "state");
  seedTestProfiles(state);
  try {
    process.env.LAO_PROFILE_WORKER = "no-such-profile";
    assert.throws(() => new ApplicationService({ stateDir: join(dir, "state"), autoStart: false }), /role profile selection worker -> no-such-profile/);
    process.env.LAO_PROFILE_WORKER = "architect";
    process.env.LAO_PROFILE_WORKER = "test-architect";
    assert.throws(() => new ApplicationService({ stateDir: state, autoStart: false }), /profile role is architect/);
  } finally {
    delete process.env.LAO_PROFILE_WORKER;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume reopens recoverable blockers and refuses semantic blockers", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-resume-"));
  const target = repo(dir);
  const service = new ApplicationService({ stateDir: join(dir, "state"), autoStart: false });
  try {
    const submitted = service.orchestrator.submit(target, "Resume", { title: "Resume", epics: [{ id: "epic", title: "E", tasks: [{ id: "task", title: "T" }] }] });
    service.store.transition(submitted.initiativeId, "running");
    // Integration-recovery blocks carry a recoveryFingerprint (set by recoverIntegrationFailure);
    // that marker — not the reason text — makes the block auto-resumable.
    service.store.transition("task", "blocked", { reason: "integration conflict: retryable", recoveryFingerprint: "abc123" });
    service.store.transition(submitted.initiativeId, "blocked", { reason: "child blocked" });
    service.resume(submitted.initiativeId);
    assert.equal(service.store.getNode(submitted.initiativeId)?.status, "running");
    assert.equal(service.store.getNode("task")?.status, "ready");

    service.store.transition("task", "blocked", { reason: "review failed: semantic issue" });
    service.store.transition(submitted.initiativeId, "blocked", { reason: "child blocked" });
    assert.throws(() => service.resume(submitted.initiativeId), /non-resumable blockers/);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resumes one blocked task and exposes actionable scoped progress", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-scoped-resume-"));
  const target = repo(dir);
  const service = new ApplicationService({ stateDir: join(dir, "state"), autoStart: false });
  try {
    const submitted = service.orchestrator.submit(target, "Scoped recovery", { title: "Scoped", epics: [{ id: "epic", title: "E", tasks: [
      { id: "blocked-task", title: "Blocked", acceptanceCriteria: ["external"] },
      { id: "independent-task", title: "Independent", acceptanceCriteria: ["works"] },
    ] }] });
    service.store.transition("blocked-task", "blocked", { reason: "missing fixture", recoveryOwner: "operator", recoveryScope: "task", requiredAction: "add fixture", unblockCondition: "artifact:fixtures/input.json", recoveryEpoch: 1 });
    const progressBefore = service.progress(submitted.initiativeId);
    const blocker = progressBefore.blockers.find((item: any) => item.id === "blocked-task");
    assert.equal(progressBefore.initiative.status, "waiting");
    assert.equal(blocker.owner, "operator");
    assert.equal(blocker.requiredAction, "add fixture");
    service.resume("blocked-task");
    assert.equal(service.store.getNode("blocked-task")?.status, "ready");
    assert.equal(service.store.getNode("independent-task")?.status, "ready");
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applies a corrected architecture revision and resumes only the affected task", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-contract-revision-"));
  const target = repo(dir);
  const service = new ApplicationService({ stateDir: join(dir, "state"), autoStart: false });
  try {
    const submitted = service.orchestrator.submit(target, "Correct the contract", { title: "Correct the contract", epics: [{ title: "Core", tasks: [{ id: "task", architectureAlias: "task", title: "Task", acceptanceCriteria: ["works"] }] }] });
    const contract = {
      version: 2 as const,
      revision: 1,
      initiativeId: submitted.initiativeId,
      author: { role: "architect" as const, profileId: "architect", model: "fake/architect" },
      createdAt: new Date().toISOString(),
      summary: "Initial contract",
      decisions: ["Separate outputs from inputs"],
      constraints: ["No dependencies"],
      invariants: ["Artifacts are path-only"],
      interfaces: ["Task"],
      taskGuidance: ["Create the output"],
      executionPlan: { tasks: [{ alias: "task", title: "Task", objective: "Create output", produces: ["output.txt"], deliverables: ["Output"], requiredArtifacts: [], prerequisites: [], dependsOn: [], verification: ["test"] }], integrationOrder: ["task"], preflightChecks: ["paths"], repairPolicy: "one repair then escalation" },
    };
    service.saveArchitectureContract(contract);
    service.store.transition("task", "waiting_external", { reason: "legacy bad contract", recoveryOwner: "operator", recoveryScope: "task", requiredAction: "correct contract", unblockCondition: "architecture revision", recoveryEpoch: 1 });
    service.saveArchitectureContract({ ...contract, revision: 2, summary: "Corrected contract", executionPlan: { ...contract.executionPlan, tasks: [{ ...contract.executionPlan.tasks[0], produces: ["output.txt"], deliverables: ["Correct output"], requiredArtifacts: [], prerequisites: ["standard library"] }] } }, "separate outputs from prerequisites");
    service.resume("task");
    assert.equal(service.architectureContract(submitted.initiativeId)?.revision, 2);
    assert.equal(service.store.getNode("task")?.status, "ready");
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI persists a plan and exposes status, messages, edits and logs", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-cli-"));
  try {
    const target = repo(dir);
    const state = join(dir, "state");
    const plan = join(dir, "plan.json");
    const patch = join(dir, "patch.json");
    writeFileSync(plan, JSON.stringify({ title: "CLI feature", epics: [{ id: "epic", title: "E", tasks: [{ id: "task", title: "T", acceptanceCriteria: ["works"] }] }] }));
    const submitted = runCli(["submit", "--repo", target, "--prompt", "Do it", "--plan-file", plan, "--no-start", "--state-dir", state, "--json"]);
    assert.match(submitted.initiativeId, /^initiative-/);
    const tree = runCli(["tree", submitted.initiativeId, "--state-dir", state, "--json"]);
    assert.equal(tree.some((node: any) => node.id === "task"), true);
    const progress = runCli(["progress", submitted.initiativeId, "--state-dir", state, "--json"]);
    assert.equal(progress.tasks.total, 1);
    assert.equal(progress.initiative.status, "draft");
    const contract = join(dir, "architecture.json");
    writeFileSync(contract, JSON.stringify({
      version: 1,
      revision: 1,
      initiativeId: submitted.initiativeId,
      author: { role: "architect", profileId: "architect", model: "openai-codex/gpt-5.6-terra" },
      createdAt: new Date().toISOString(),
      summary: "CLI architecture",
      decisions: ["Use durable state"],
      constraints: ["No target writes"],
      invariants: ["Only valid contracts are stored"],
      interfaces: ["CLI"],
      taskGuidance: ["Test the contract"],
    }));
    const savedContract = runCli(["architecture-contract", "create", submitted.initiativeId, "--file", contract, "--state-dir", state, "--json"]);
    assert.equal(savedContract.revision, 1);
    assert.equal(runCli(["architecture-contract", "get", submitted.initiativeId, "--state-dir", state, "--json"]).summary, "CLI architecture");
    assert.equal(runCli(["architecture-contract", "list", submitted.initiativeId, "--state-dir", state, "--json"]).length, 1);
    const message = runCli(["message", submitted.initiativeId, "prioritize tests", "--state-dir", state, "--json"]);
    assert.equal(typeof message.messageId, "number");
    writeFileSync(patch, JSON.stringify({ nodeId: "task", description: "updated" }));
    const edited = runCli(["plan-edit", submitted.initiativeId, "--file", patch, "--state-dir", state, "--json"]);
    assert.equal(edited.description, "updated");
    const logs = runCli(["logs", submitted.initiativeId, "--state-dir", state, "--json"]);
    assert.ok(logs.some((event: any) => event.kind === "plan_edit_applied"));
    const feed = runCli(["feed", submitted.initiativeId, "--state-dir", state, "--json"]);
    assert.ok(feed.some((event: any) => event.kind === "plan_edit_applied"));
    assert.equal(Object.hasOwn(feed[0]?.payload ?? {}, "prompt"), false);
    assert.deepEqual(runCli(["agents", submitted.initiativeId, "--state-dir", state, "--json"]), []);
    assert.equal(runCli(["supervisor-status", "--state-dir", state, "--json"]).activeSessions, 0);
    assert.deepEqual(runCli(["supervise", "--state-dir", state, "--json"]).recovered, []);
    const metrics = runCli(["metrics", submitted.initiativeId, "--state-dir", state, "--json"]);
    assert.equal(metrics.metricCount, 0);
    const prometheus = spawnSync(process.execPath, ["--experimental-strip-types", cli, "metrics", submitted.initiativeId, "--prometheus", "--state-dir", state], { encoding: "utf8" });
    assert.equal(prometheus.status, 0, prometheus.stderr);
    assert.match(prometheus.stdout, /pi_epics_metrics_total 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plan edit validates profile assignments before persisting", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-planedit-profile-"));
  try {
    const target = repo(dir);
    seedTestProfiles(join(dir, "state"));
    const service = new ApplicationService({ stateDir: join(dir, "state"), autoStart: false, runtime: {} as any });
    try {
      const submission = service.orchestrator.submit(target, "Do it", { title: "Profiled", epics: [{ id: "epic", title: "E", tasks: [{ id: "task", title: "T", acceptanceCriteria: ["ok"] }] }] } as any);
      assert.throws(() => service.planEdit(submission.initiativeId, { nodeId: "task", profileId: "no-such-profile" }), /unknown profile in plan edit/);
      assert.throws(() => service.planEdit(submission.initiativeId, { nodeId: "task", profileId: "test-release" }), /release profile is inactive/);
      const edited = service.planEdit(submission.initiativeId, { nodeId: "task", profileId: "test-worker" });
      assert.equal(edited.profileId, "test-worker");
    } finally {
      service.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("initiative resume uses structured recovery markers, not failure text", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-resume-structured-"));
  try {
    const target = repo(dir);
    const service = new ApplicationService({ stateDir: join(dir, "state"), autoStart: false, runtime: {} as any });
    try {
      const plan = (taskId: string) => ({ title: "Resume", epics: [{ id: `epic-${taskId}`, title: "E", tasks: [{ id: taskId, title: "T", acceptanceCriteria: ["ok"] }] }] } as any);
      const block = (taskId: string, fields: Record<string, unknown>, nextFields: Record<string, unknown>): void => {
        service.store.transition(taskId, "needs_manager", fields);
        service.store.transition(taskId, "blocked", nextFields);
      };

      // Integration-recovery class: recoveryFingerprint set -> safe to auto-resume.
      const integration = service.orchestrator.submit(target, "p1", plan("task-int"));
      block("task-int", { reason: "integration conflict: conflict", recoveryFingerprint: "abc123", recoveryOwner: "manager", recoveryScope: "task", requiredAction: "retry", unblockCondition: "manager recovery decision", recoveryEpoch: 1 }, { reason: "integration conflict: conflict", recoveryFingerprint: "abc123", recoveryOwner: "manager", recoveryScope: "task", requiredAction: "retry", unblockCondition: "manager recovery decision", recoveryEpoch: 2 });
      service.store.refreshRollups(integration.initiativeId);
      assert.doesNotThrow(() => service.resume(integration.initiativeId));
      // resume() moves the task to pending and refreshReady() promotes it to ready.
      assert.equal(service.store.getNode("task-int")?.status, "ready");

      // Domain failure: manager-owned block without fingerprint -> not resumable,
      // even if the free-text reason mentions a recoverable-sounding word.
      const domain = service.orchestrator.submit(target, "p2", plan("task-dom"));
      block("task-dom", { reason: "worker failed: integration style wording", recoveryOwner: "manager", recoveryScope: "task", requiredAction: "provide guidance", unblockCondition: "explicit recovery action", recoveryEpoch: 1 }, { reason: "worker failed: integration style wording", recoveryOwner: "manager", recoveryScope: "task", requiredAction: "provide guidance", unblockCondition: "explicit recovery action", recoveryEpoch: 2 });
      service.store.refreshRollups(domain.initiativeId);
      assert.throws(() => service.resume(domain.initiativeId), /non-resumable blockers/);

      // Supervisor exhaustion: recoveryOwner=supervisor -> resumable.
      const supervisor = service.orchestrator.submit(target, "p3", plan("task-sup"));
      block("task-sup", { reason: "supervisor exhausted attempts after recovery (3/3)", recoveryOwner: "supervisor", recoveryScope: "task", requiredAction: "investigate", unblockCondition: "root cause resolved", recoveryEpoch: 1 }, { reason: "supervisor exhausted attempts after recovery (3/3)", recoveryOwner: "supervisor", recoveryScope: "task", requiredAction: "investigate", unblockCondition: "root cause resolved", recoveryEpoch: 2 });
      service.store.refreshRollups(supervisor.initiativeId);
      assert.doesNotThrow(() => service.resume(supervisor.initiativeId));
    } finally {
      service.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no-start submission persists architecture metadata and refuses an uncontracted run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-architecture-preflight-"));
  const target = repo(dir);
  const plan = join(dir, "plan.json");
  const architecture = join(dir, "architecture.json");
  writeFileSync(plan, JSON.stringify({ title: "Contracted feature", epics: [{ id: "epic", title: "Core", tasks: [{ id: "task", architectureAlias: "implement", title: "Implement", acceptanceCriteria: ["works"] }] }] }));
  writeFileSync(architecture, JSON.stringify({
    version: 2,
    summary: "Contracted architecture",
    decisions: ["Use isolated worktrees"],
    constraints: ["No target writes"],
    invariants: ["Only reviewed code integrates"],
    interfaces: ["CLI"],
    taskGuidance: ["Run focused checks"],
    executionPlan: {
      tasks: [{ alias: "implement", title: "Implement", objective: "Implement the feature", produces: ["feature.txt"], requires: [], dependsOn: [], verification: ["gate"] }],
      integrationOrder: ["implement"],
      preflightChecks: ["clean worktree"],
      repairPolicy: "one repair then escalate",
    },
  }));
  seedTestProfiles(join(dir, "state"));
  const submitted = runCli(["submit", "--repo", target, "--prompt", "Build it", "--plan-file", plan, "--architecture-file", architecture, "--no-start", "--state-dir", join(dir, "state"), "--json"]);
  const contract = runCli(["architecture-contract", "get", submitted.initiativeId, "--state-dir", join(dir, "state"), "--json"]);
  assert.equal(contract.version, 2);
  assert.equal(contract.executionPlan.tasks[0].produces[0], "feature.txt");
  const service = new ApplicationService({ stateDir: join(dir, "missing-contract-state"), autoStart: false });
  try {
    (service as any).ensureToolchain = async () => undefined;
    const legacy = service.orchestrator.submit(target, "Legacy");
    service.store.recordEvent(legacy.initiativeId, "architecture_contract_missing", { reason: "test" });
    await assert.rejects(() => service.run(legacy.initiativeId), /version-2 ArchitectureExecutionPlan/);
    assert.equal(service.store.events(legacy.initiativeId).some((event) => event.kind === "architecture_preflight_failed"), true);
  } finally {
    service.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

test("CLI manages custom profiles and rejects unknown plan profiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-profiles-"));
  try {
    const state = join(dir, "state");
    const source = JSON.parse(readFileSync(join(root, "profiles", "example-subscription.json"), "utf8"));
    source.id = "custom-manager";
    source.role = "manager";
    const profileFile = join(dir, "custom-manager.json");
    writeFileSync(profileFile, JSON.stringify(source));
    const created = runCli(["profiles", "create", "--file", profileFile, "--state-dir", state, "--json"]);
    assert.equal(created.id, "custom-manager");
    const listed = runCli(["profiles", "list", "--state-dir", state, "--json"]);
    assert.equal(listed.some((profile: any) => profile.id === "custom-manager" && profile.custom === true), true);
    const cloned = runCli(["profiles", "clone", "example-subscription", "--id", "custom-clone", "--overrides-json", '{"thinkingLevel":"high"}', "--state-dir", state, "--json"]);
    assert.equal(cloned.id, "custom-clone");
    assert.equal(cloned.thinkingLevel, "high");

    const target = repo(dir);
    const plan = join(dir, "invalid-plan.json");
    writeFileSync(plan, JSON.stringify({ title: "Invalid profile", epics: [{ id: "epic", title: "E", tasks: [{ id: "task", title: "T", profileId: "does-not-exist" }] }] }));
    const rejected = spawnSync(process.execPath, ["--experimental-strip-types", cli, "submit", "--repo", target, "--prompt", "Do it", "--plan-file", plan, "--no-start", "--state-dir", state, "--json"], { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /unknown profile in plan/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("creates and assigns a role-specific profile for an agent identity", () => {
  const state = mkdtempSync(join(tmpdir(), "loom-and-order-profile-"));
  const service = new ApplicationService({ stateDir: state, autoStart: false });
  try {
    const agent = service.store.ensureAgent({ id: "worker/demo", role: "worker", profileId: "example-subscription", model: "openai-codex/gpt-test", pool: "codex" });
    const created = service.createAgentProfile(agent.id, undefined, { thinkingLevel: "max" });
    assert.equal(created.profile.id, "agent-worker-demo");
    assert.equal(created.profile.role, "worker");
    assert.equal(created.profile.model, "openai-codex/gpt-test");
    assert.equal(created.profile.thinkingLevel, "max");
    assert.equal(created.agent.profileId, created.profile.id);
    assert.equal(readFileSync(created.path, "utf8").includes('"id": "agent-worker-demo"'), true);
    assert.equal(service.listProfiles().some((profile) => profile.id === created.profile.id && profile.custom === true), true);
  } finally {
    service.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test("MCP exposes the same durable application operations", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-mcp-"));
  try {
    const state = join(dir, "state");
    const target = repo(dir);
    const plan = join(dir, "plan.json");
    writeFileSync(plan, JSON.stringify({ title: "MCP feature", epics: [{ id: "epic", title: "E", tasks: [{ id: "task", title: "T" }] }] }));
    seedTestProfiles(state);
    const submitted = runCli(["submit", "--repo", target, "--prompt", "Do it", "--plan-file", plan, "--no-start", "--state-dir", state, "--json"]);
    const managerProfile = JSON.parse(readFileSync(join(root, "profiles", "example-subscription.json"), "utf8"));
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tree", arguments: { initiativeId: submitted.initiativeId } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "message", arguments: { initiativeId: "missing", body: "must not mutate" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "logs", arguments: {} } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "metrics", arguments: { initiativeId: submitted.initiativeId } } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "profiles_validate", arguments: { profile: managerProfile } } },
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "profiles_list", arguments: {} } },
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "feed", arguments: { initiativeId: submitted.initiativeId, afterId: 0, limit: 10 } } },
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "agents", arguments: { initiativeId: submitted.initiativeId } } },
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "supervisor_status", arguments: {} } },
      { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "architecture_contract_get", arguments: { initiativeId: submitted.initiativeId } } },
      { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "architecture_contract_list", arguments: { initiativeId: submitted.initiativeId } } },
      { jsonrpc: "2.0", id: 13, method: "tools/list", params: {} },
    ].map((item) => JSON.stringify(item)).join("\n") + "\n";
    const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, "mcp", "--state-dir", state], { input, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(responses[0].result.serverInfo.name, "loom-and-order");
    assert.equal(JSON.parse(responses[1].result.content[0].text).some((node: any) => node.id === "task"), true);
    assert.match(responses[2].error.message, /unknown initiative/);
    const events = JSON.parse(responses[3].result.content[0].text);
    assert.equal(events.some((event: any) => event.kind === "manager_message_added"), false);
    assert.equal(JSON.parse(responses[4].result.content[0].text).metricCount, 0);
    assert.equal(JSON.parse(responses[5].result.content[0].text).id, "example-subscription");
    assert.equal(JSON.parse(responses[6].result.content[0].text).some((profile: any) => profile.id === "example-subscription"), true);
    assert.equal(JSON.parse(responses[7].result.content[0].text).some((event: any) => event.kind === "plan_created"), true);
    assert.deepEqual(JSON.parse(responses[8].result.content[0].text), []);
    assert.equal(JSON.parse(responses[9].result.content[0].text).activeSessions, 0);
    assert.equal(JSON.parse(responses[10].result.content[0].text), null);
    assert.deepEqual(JSON.parse(responses[11].result.content[0].text), []);
    assert.equal(responses[12].result.tools.some((tool: any) => tool.name === "architecture_contract_get"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function completeNode(store: any, id: string): void {
  store.transition(id, "leased");
  store.transition(id, "running");
  store.transition(id, "completed");
}

test("deliver merges completed epics into a deliver branch and prune cleans terminal worktrees", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-deliver-"));
  const target = repo(dir);
  const state = join(dir, "state");
  seedTestProfiles(state);
  const service = new ApplicationService({ stateDir: state, autoStart: false, gateCommand: ["node", "-e", "process.exit(0)"] });
  try {
    const plan = { title: "Deliverable", epics: [
      { id: "epic-a", title: "A", tasks: [{ id: "task-a", title: "T", acceptanceCriteria: ["ok"] }] },
      { id: "epic-b", title: "B", dependsOn: ["epic-a"], tasks: [{ id: "task-b", title: "T2", acceptanceCriteria: ["ok"] }] },
    ] } as any;
    const submitted = service.orchestrator.submit(target, "Deliver", plan);
    const git = new GitWorkspace(state);
    const branch = (id: string) => `loom-and-order/${submitted.initiativeId}/${id}`;
    // Simulate the executor's integration work for both epics.
    const epicA = service.store.getNode("epic-a")!;
    git.createWorktree(target, branch("epic-epic-a"), git.worktreePath(submitted.initiativeId, "epic-a"), epicA.baseCommit!);
    writeFileSync(join(git.worktreePath(submitted.initiativeId, "epic-a"), "a.txt"), "a\n");
    git.commitChanges(git.worktreePath(submitted.initiativeId, "epic-a"), "epic-a base work");
    service.store.setWorktree("epic-a", branch("epic-epic-a"), git.worktreePath(submitted.initiativeId, "epic-a"));
    const taskA = service.store.getNode("task-a")!;
    git.createWorktree(target, branch("task-task-a"), git.worktreePath(submitted.initiativeId, "task-a"), git.currentCommit(git.worktreePath(submitted.initiativeId, "epic-a")));
    writeFileSync(join(git.worktreePath(submitted.initiativeId, "task-a"), "task-a.txt"), "task a\n");
    const taskACheck = git.commitChanges(git.worktreePath(submitted.initiativeId, "task-a"), "task-a: add work");
    service.store.setWorktree("task-a", branch("task-task-a"), git.worktreePath(submitted.initiativeId, "task-a"));
    const mergeA = git.merge(git.worktreePath(submitted.initiativeId, "epic-a"), branch("task-task-a"));
    service.store.setIntegratedCommit("task-a", mergeA);
    completeNode(service.store, "task-a");
    const epicB = service.store.getNode("epic-b")!;
    git.createWorktree(target, branch("epic-epic-b"), git.worktreePath(submitted.initiativeId, "epic-b"), epicB.baseCommit!);
    git.merge(git.worktreePath(submitted.initiativeId, "epic-b"), branch("epic-epic-a"));
    writeFileSync(join(git.worktreePath(submitted.initiativeId, "epic-b"), "b.txt"), "b\n");
    git.commitChanges(git.worktreePath(submitted.initiativeId, "epic-b"), "epic-b base work");
    service.store.setWorktree("epic-b", branch("epic-epic-b"), git.worktreePath(submitted.initiativeId, "epic-b"));
    git.createWorktree(target, branch("task-task-b"), git.worktreePath(submitted.initiativeId, "task-b"), git.currentCommit(git.worktreePath(submitted.initiativeId, "epic-b")));
    writeFileSync(join(git.worktreePath(submitted.initiativeId, "task-b"), "task-b.txt"), "task b\n");
    git.commitChanges(git.worktreePath(submitted.initiativeId, "task-b"), "task-b: add work");
    service.store.setWorktree("task-b", branch("task-task-b"), git.worktreePath(submitted.initiativeId, "task-b"));
    const mergeB = git.merge(git.worktreePath(submitted.initiativeId, "epic-b"), branch("task-task-b"));
    service.store.setIntegratedCommit("task-b", mergeB);
    completeNode(service.store, "task-b");
    service.store.refreshRollups(submitted.initiativeId);
    assert.equal(service.store.getNode(submitted.initiativeId)!.status, "completed");

    // Dry-run prune reports without acting.
    const dry = service.prune({ initiativeId: submitted.initiativeId, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.actions.some((action: any) => action.action === "would-prune"), true);
    assert.ok(existsSync(git.worktreePath(submitted.initiativeId, "task-a")));

    // Deliver: branch built from target HEAD, both epics merged, gate passed.
    const base = git.head(target);
    const delivered = await service.deliver(submitted.initiativeId);
    assert.equal(delivered.branch, `loom-and-order/deliver-${submitted.initiativeId}`);
    assert.equal(delivered.base, base);
    assert.equal(delivered.epics.length, 2);
    assert.equal(delivered.epics[0].epicId, "epic-a");
    assert.equal(delivered.epics[1].epicId, "epic-b");
    assert.equal(git.isAncestor(target, taskACheck, `refs/heads/${delivered.branch}`), true);
    assert.equal(git.isAncestor(target, mergeB, `refs/heads/${delivered.branch}`), true);
    assert.equal(existsSync(join(state, "worktrees", submitted.initiativeId, "deliver")), false);
    // Target working tree untouched: no deliver files, no deliver branch checkout.
    assert.equal(execFileSync("git", ["-C", target, "branch", "--show-current"], { encoding: "utf8" }).trim(), "main");
    assert.equal(existsSync(join(target, "task-a.txt")), false);

    // Idempotent rebuild: a new target commit, re-deliver, branch follows it.
    writeFileSync(join(target, "new.txt"), "new\n");
    execFileSync("git", ["-C", target, "add", "."]);
    execFileSync("git", ["-C", target, "commit", "-m", "new base work"]);
    const redelivered = await service.deliver(submitted.initiativeId);
    assert.equal(redelivered.base, git.head(target));
    assert.equal(git.isAncestor(target, redelivered.base, `refs/heads/${redelivered.branch}`), true);

    // Real prune removes terminal task worktrees and merged branches, keeps epics.
    const pruned = service.prune({ initiativeId: submitted.initiativeId });
    assert.equal(pruned.actions.filter((action: any) => action.action === "pruned" && action.level === "task").length, 2);
    assert.equal(existsSync(git.worktreePath(submitted.initiativeId, "task-a")), false);
    assert.equal(git.branchExists(target, branch("task-task-a")), false);
    assert.equal(git.branchExists(target, branch("task-task-b")), false);
    assert.ok(existsSync(git.worktreePath(submitted.initiativeId, "epic-a")));
    assert.ok(git.branchExists(target, branch("epic-epic-a")));
    assert.equal(service.store.getNode("task-a")!.worktreePath, null);

    // --include-epics removes completed epic worktrees but keeps their branches.
    const epicPruned = service.prune({ initiativeId: submitted.initiativeId, includeEpics: true });
    assert.equal(epicPruned.actions.some((action: any) => action.nodeId === "epic-a" && action.action === "pruned"), true);
    assert.equal(existsSync(git.worktreePath(submitted.initiativeId, "epic-a")), false);
    assert.ok(git.branchExists(target, branch("epic-epic-a")));

    // Deliver on a non-completed initiative fails closed.
    const pending = service.orchestrator.submit(target, "Pending", { title: "P", epics: [{ id: "epic-p", title: "P", tasks: [{ id: "task-p", title: "T", acceptanceCriteria: ["ok"] }] }] } as any);
    await assert.rejects(() => service.deliver(pending.initiativeId), /requires a completed initiative/);

    // Prune without a scope fails.
    assert.throws(() => service.prune({}), /initiative id or --all/);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
