import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { GitWorkspace } from "./git.ts";
import { Store } from "./store.ts";
import { parseArchitectureContract, parseManagerDecision, parseReview, type AgentRuntime, defaultPlan } from "./runtime.ts";
import type { ArchitectureContract, NodeRecord, PlanSpec } from "./domain.ts";
import { resolveProfileModel, type ProfileManifest, type RoleProfileSelection } from "./profiles.ts";
import { withObservedSpan } from "./observability.ts";
import { SpanType } from "mlflow-tracing";

export interface ExecutorOptions {
  stateDir: string;
  gateCommand: string[];
  profiles: Record<string, ProfileManifest>;
  maxCycles?: number;
  enableRelease?: boolean;
  env?: NodeJS.ProcessEnv;
  roleSelection?: RoleProfileSelection;
  /** Refresh interval for the node lease while a task is being executed. Default 30s. */
  leaseHeartbeatMs?: number;
  /** Extra lease TTL beyond the profile timeout. Default 60s. */
  leaseMarginMs?: number;
}

export interface Submission {
  initiativeId: string;
  epicIds: string[];
  autoPrune: boolean;
}

export interface SubmissionOptions {
  autoPrune?: boolean;
}

const MAX_CONVERSATIONAL_FEEDBACK_TURNS = 1;
const MAX_INTEGRATION_RECOVERY_ATTEMPTS = 1;

function branchSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-40);
}

function profilePool(profile: ProfileManifest): "local" | "codex" {
  if (profile.pool) return profile.pool;
  return profile.model?.startsWith("openai-codex/") ? "codex" : "local";
}

function runtimeErrorEvidence(result: any): string {
  const raw = result?.raw ?? {};
  const parts = [raw.error, raw.stderr, raw.message, raw.stderrPath].filter(Boolean).map(String);
  if (raw.stderrPath && existsSync(String(raw.stderrPath))) {
    try { parts.push(readFileSync(String(raw.stderrPath), "utf8").slice(-8000)); } catch { /* best-effort classification */ }
  }
  return parts.join(" ").toLowerCase();
}

export function providerFailure(result: any): boolean {
  const evidence = runtimeErrorEvidence(result);
  return /fetch failed|no api key|unauthorized|authentication|rate limit|429|502|503|504|econn|etimedout|temporar(?:y|ily) unavailable/.test(evidence);
}

export function infrastructureFailure(result: any): boolean {
  const raw = result?.raw;
  if (!raw) return true;
  if (raw.timedOut || raw.exitCode === null || raw.exitCode !== 0 || !raw.agentEnded) return true;
  return providerFailure(result) || /timeout|temporar/.test(runtimeErrorEvidence(result));
}

export class ProfileLimiter {
  private readonly active = { local: 0, codex: 0 };
  private readonly waiters: Array<() => void> = [];

  async run<T>(profile: ProfileManifest, callback: () => Promise<T>): Promise<T> {
    const pool = profilePool(profile);
    if (profile.role === "manager" && pool === "codex") return callback();
    const configured = profile.maxConcurrency ?? (pool === "local" ? 1 : 4);
    const limit = Math.min(pool === "local" ? 1 : 4, Math.max(1, configured));
    while (this.active[pool] >= limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active[pool] += 1;
    try {
      return await callback();
    } finally {
      this.active[pool] -= 1;
      this.waiters.shift()?.();
    }
  }
}

export function runtimeCounters(raw: any, profile?: ProfileManifest): Record<string, number> {
  raw = raw ?? {};
  const counters: Record<string, number> = {
    tool_calls: Number(raw.toolCalls ?? 0),
    tool_errors: Number(raw.toolErrors ?? 0),
    stdout_bytes: Number(raw.stdoutBytes ?? 0),
    stderr_bytes: Number(raw.stderrBytes ?? 0),
    runtime_ms: Number(raw.durationMs ?? raw.telemetry?.wallClockMs ?? 0),
  };
  const telemetry = raw.telemetry ?? {};
  const aliases: Record<string, string> = {
    inputTokens: "input_tokens",
    outputTokens: "output_tokens",
    reasoningTokens: "reasoning_tokens",
    cacheReadTokens: "cache_read_tokens",
    cacheWriteTokens: "cache_write_tokens",
    totalTokens: "total_tokens",
  };
  for (const [key, counter] of Object.entries(aliases)) if (typeof telemetry[key] === "number") counters[counter] = Number(telemetry[key]);
  for (const [key, counter] of Object.entries({ ttftMs: "ttft_ms", generationMs: "generation_ms", tokensPerSecond: "tokens_per_second", costUsd: "cost_usd", apiCostUsd: "api_cost_usd", codexCredits: "codex_credits" })) {
    if (typeof telemetry[key] === "number" && Number.isFinite(telemetry[key])) counters[counter] = Number(telemetry[key]);
  }
  const usage = raw.usage ?? {};
  const legacyAliases: Record<string, string> = {
    input: "input_tokens",
    inputTokens: "input_tokens",
    output: "output_tokens",
    outputTokens: "output_tokens",
    total: "total_tokens",
    totalTokens: "total_tokens",
    cacheRead: "cache_read_tokens",
    cacheWrite: "cache_write_tokens",
  };
  for (const [key, counter] of Object.entries(legacyAliases)) if (counters[counter] === undefined && typeof usage[key] === "number") counters[counter] = Number(usage[key]);
  if (profile && profilePool(profile) === "local" && counters.cost_usd === undefined) counters.cost_usd = 0;
  return counters;
}

export function profileDimensions(profile: ProfileManifest, env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  // Dynamic local models must be visible in metric labels; resolution can only
  // fail when the env variable is missing, which is a launch-time failure anyway.
  let model: string | null | undefined;
  try { model = resolveProfileModel(profile, env); } catch { model = undefined; }
  return { profile: profile.id, backend: profile.sandbox.backend, model: model ?? "unknown", ...extra };
}

export class Orchestrator {
  readonly git: GitWorkspace;
  readonly maxCycles: number;
  readonly store: Store;
  readonly runtime: AgentRuntime;
  readonly options: ExecutorOptions;
  readonly limiter = new ProfileLimiter();
  private readonly epicLocks = new Map<string, Promise<void>>();
  private readonly managerCheckpointRetries = new Map<string, number>();

  constructor(store: Store, runtime: AgentRuntime, options: ExecutorOptions) {
    this.store = store;
    this.runtime = runtime;
    this.options = options;
    this.git = new GitWorkspace(options.stateDir);
    this.maxCycles = options.maxCycles ?? 100;
  }

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  submit(repoPath: string, prompt: string, plan?: PlanSpec, options: SubmissionOptions | boolean = {}): Submission {
    this.git.assertRepository(repoPath);
    this.git.assertClean(repoPath);
    const baseCommit = this.git.head(repoPath);
    const effectivePlan = plan ?? defaultPlan(prompt) as PlanSpec;
    const autoPrune = typeof options === "boolean" ? options : options.autoPrune === true;
    return this.store.createPlan({ plan: effectivePlan, repoPath, baseCommit, autoPrune });
  }

  gcEligibility(initiativeId: string): ReturnType<Store["checkGcEligibility"]> {
    return this.store.checkGcEligibility(initiativeId);
  }

  acquireGcLock(initiativeId: string, owner = `gc-${process.pid}-${randomUUID()}`): boolean {
    return this.store.acquireGcLock(initiativeId, owner);
  }

  releaseGcLock(initiativeId: string, owner: string): boolean {
    return this.store.releaseGcLock(initiativeId, owner);
  }

  async runInitiative(initiativeId: string): Promise<NodeRecord> {
    return withObservedSpan({ name: "scheduler:initiative", spanType: SpanType.CHAIN, inputs: { initiative_id: initiativeId }, attributes: { "pi.initiative_id": initiativeId } }, async (trace) => {
      const result = await this.runInitiativeInternal(initiativeId);
      trace.setOutputs({ initiative_id: initiativeId, status: result.status });
      return result;
    });
  }

  private async runInitiativeInternal(initiativeId: string): Promise<NodeRecord> {
    const initiative = this.store.getNode(initiativeId);
    if (!initiative) throw new Error(`unknown initiative ${initiativeId}`);
    if (initiative.level !== "initiative") throw new Error(`${initiativeId} is not an initiative`);
    if (!initiative.repoPath) throw new Error(`initiative ${initiativeId} has no source repository`);
    const storedRepository = resolve(initiative.repoPath);
    if (this.git.repositoryRoot(storedRepository) !== storedRepository) throw new Error(`initiative repository identity mismatch: ${storedRepository}`);
    this.store.refreshRollups(initiativeId);
    this.store.refreshReady(initiativeId);
    const refreshed = this.store.getNode(initiativeId)!;
    if (refreshed.status === "failed") return refreshed;
    if (refreshed.status === "blocked" && !this.store.listReadyTasks(initiativeId).length) return refreshed;
    if (initiative.status === "paused") return initiative;
    if (["draft", "waiting", "blocked"].includes(refreshed.status) && this.store.listReadyTasks(initiativeId).length) this.store.transition(initiativeId, "running", { reason: "runnable independent work remains" });
    this.store.recoverExpiredLeases();
    this.store.refreshReady(initiativeId);
    for (let cycle = 0; cycle < this.maxCycles; cycle += 1) {
      await this.managerCheckpoint(initiativeId);
      this.store.refreshReady(initiativeId);
      const ready = this.store.listReadyTasks(initiativeId);
      if (!ready.length) break;
      const runnable: NodeRecord[] = [];
      for (const task of ready) {
        const current = this.store.getNode(task.id);
        if (!current || current.status !== "ready") continue;
        let profile: ProfileManifest;
        try {
          profile = this.profileFor(current.profileId ?? "worker");
        } catch (error) {
          this.store.recordEvent(current.id, "profile_resolution_failed", { profileId: current.profileId ?? null, reason: String(error).slice(0, 2000) });
          this.store.transition(current.id, "blocked", {
            reason: `profile not configured: ${current.profileId}`,
            recoveryOwner: "operator",
            recoveryScope: "task",
            requiredAction: "assign a configured profile to this task",
            unblockCondition: "valid profile assignment",
            recoveryEpoch: current.recoveryEpoch + 1,
          });
          continue;
        }
        if (profile.role === "worker" || profile.role === "reviewer" || (profile.role === "release" && this.options.enableRelease)) {
          try {
            const worktrees = this.ensureWorktrees(current, this.findEpic(current));
            if (this.dependencyPreflight(current, worktrees.epic)) runnable.push(current);
          } catch (error) {
            const reason = `worktree dependency preparation failed: ${String(error)}`;
            this.store.recordEvent(current.id, "worktree_preflight_failed", { reason: reason.slice(0, 2000) });
            this.store.recordMetric({ initiativeId: current.initiativeId, nodeId: current.id, runId: `${current.id}-worktree-preflight-${current.generation}`, role: "scheduler", outcome: "recovery", durationMs: 0, counters: {}, dimensions: { status: "worktree_preflight" } });
            this.store.transition(current.id, "needs_manager", {
              reason,
              recoveryOwner: "manager",
              recoveryScope: "task",
              requiredAction: "review the worktree/preflight failure and authorize a retry or task replan",
              unblockCondition: "manager recovery decision",
              recoveryEpoch: current.recoveryEpoch + 1,
            });
          }
        } else {
          runnable.push(current);
        }
      }
      await Promise.all(runnable.map(async (task) => {
        const current = this.store.getNode(task.id);
        if (current?.status === "ready") await this.executeTask(current);
      }));
      this.store.refreshReady(initiativeId);
      const remaining = this.store.listNodes(initiativeId).filter((node) => ["task", "subtask"].includes(node.level) && !["completed", "blocked", "failed"].includes(node.status));
      if (!remaining.length) break;
    }
    this.store.refreshRollups(initiativeId);
    const finalNodes = this.store.listNodes(initiativeId);
    const unfinished = finalNodes.filter((node) => ["task", "subtask"].includes(node.level) && !["completed", "blocked", "failed"].includes(node.status));
    const bad = finalNodes.some((node) => ["blocked", "failed"].includes(node.status));
    if (unfinished.length === 0 && !bad && this.store.getNode(initiativeId)?.status !== "completed") this.store.transition(initiativeId, "completed");
    this.store.refreshRollups(initiativeId);
    return this.store.getNode(initiativeId)!;
  }

  private profileFor(id: string): ProfileManifest {
    let requested = this.options.profiles[id];
    // A role-name fallback (e.g. "worker") resolves to the first profile of
    // that role; explicit unknown profile IDs still fail.
    if (!requested && ["architect", "manager", "worker", "reviewer", "researcher", "release"].includes(id)) {
      requested = Object.values(this.options.profiles).find((profile) => profile.role === id);
    }
    if (!requested) throw new Error(`profile not configured: ${id}`);
    // External (operator) role selection wins over per-task profileId choices.
    const selectedId = this.options.roleSelection?.[requested.role];
    if (selectedId) {
      const selected = this.options.profiles[selectedId];
      if (!selected) throw new Error(`role profile selection not configured: ${selectedId}`);
      return selected;
    }
    return requested;
  }

  // Manager recovery is optional: orchestrators configured without a manager
  // profile skip manager-driven recovery instead of failing.
  private managerProfile(): ProfileManifest | undefined {
    const selectedId = this.options.roleSelection?.manager;
    if (selectedId) {
      const selected = this.options.profiles[selectedId];
      if (!selected) throw new Error(`role profile selection not configured: ${selectedId}`);
      return selected;
    }
    return this.options.profiles.manager;
  }

  private assertValidEditProfile(profileId: string | null | undefined): void {
    if (!profileId) return;
    const profile = this.options.profiles[profileId];
    if (!profile) throw new Error(`unknown profile in manager plan edit: ${profileId}`);
    if (profile.role === "release" && !this.options.enableRelease) throw new Error("release profile is inactive by default; enable explicit release scheduling first");
  }

  private markPreparationFailed(node: NodeRecord, error: unknown): void {
    const reason = `task preparation failed: ${String(error)}`;
    this.store.recordEvent(node.id, "task_preparation_failed", { reason: reason.slice(0, 2000) });
    this.store.recordMetric({ initiativeId: node.initiativeId, nodeId: node.id, runId: `${node.id}-preparation-${node.generation}`, role: "scheduler", outcome: "failure", durationMs: 0, counters: { preparation_failed: 1 }, dimensions: { status: "blocked" } });
    const current = this.store.getNode(node.id);
    if (current && current.status === "ready") {
      this.store.transition(node.id, "blocked", {
        reason,
        recoveryOwner: "operator",
        recoveryScope: "task",
        requiredAction: "investigate worktree/lease preparation failure",
        unblockCondition: "preparation succeeds",
        recoveryEpoch: current.recoveryEpoch + 1,
      });
    } else {
      this.failOrBlock(node.id, reason);
    }
  }

  private dependencyPreflight(task: NodeRecord, epic: NodeRecord): boolean {
    const executionPlan = this.store.getArchitectureContract(task.initiativeId)?.executionPlan;
    if (!executionPlan) return true;
    const guidance = executionPlan.tasks.find((candidate) => candidate.alias === task.architectureAlias || candidate.title.trim().toLocaleLowerCase() === task.title.trim().toLocaleLowerCase());
    if (!guidance || guidance.requiredArtifacts.length === 0) return true;
    const artifactKey = (artifact: string): string => artifact.trim().replace(/^\.\//, "");
    const producers = new Map<string, string>();
    for (const candidate of executionPlan.tasks) {
      for (const produced of candidate.produces) {
        const key = artifactKey(produced);
        const previous = producers.get(key);
        if (previous && previous !== candidate.alias) {
          this.store.transition(task.id, "needs_manager", {
            reason: `architecture artifact has multiple producers: ${produced}`,
            recoveryOwner: "manager",
            recoveryScope: "task",
            requiredAction: "resolve the duplicate artifact producer in the architecture plan",
            unblockCondition: "manager recovery decision",
            recoveryEpoch: task.recoveryEpoch + 1,
          });
          return false;
        }
        producers.set(key, candidate.alias);
      }
    }
    const missing = guidance.requiredArtifacts.filter((artifact) => {
      const relative = artifact.trim();
      return !relative || relative.startsWith("/") || relative.split(/[\\/]+/).includes("..") || !existsSync(resolve(epic.worktreePath!, relative));
    });
    if (!missing.length) return true;
    const producerBacked = missing.filter((artifact) => producers.has(artifactKey(artifact)) && producers.get(artifactKey(artifact)) !== guidance.alias);
    const reason = `dependency preflight missing required artifacts: ${missing.join(", ")}`;
    this.store.recordEvent(task.id, "dependency_preflight_blocked", { missing, producerBacked, requiredArtifacts: guidance.requiredArtifacts, prerequisites: guidance.prerequisites, architectureAlias: guidance.alias });
    this.store.recordMetric({ initiativeId: task.initiativeId, nodeId: task.id, runId: `${task.id}-dependency-preflight-${task.generation}`, role: "scheduler", outcome: "recovery", durationMs: 0, counters: { dependency_preflight_blocked: 1 }, dimensions: { status: producerBacked.length ? "dependency_preflight_producer" : "dependency_preflight_external" } });
    if (producerBacked.length) {
      const producerAliases = new Set(producerBacked.map((artifact) => producers.get(artifactKey(artifact))));
      const producerNodes = this.store.listNodes(task.initiativeId).filter((node) => producerAliases.has(node.architectureAlias ?? ""));
      const unresolved = producerNodes.filter((node) => node.status !== "completed");
      if (unresolved.length) {
        this.store.transition(task.id, "waiting_dependency", {
          reason: `waiting for producer tasks before checking artifacts: ${unresolved.map((node) => node.id).join(", ")}`,
          recoveryOwner: "scheduler",
          recoveryScope: "task",
          requiredAction: "wait for producer task integration",
          unblockCondition: `dependencies:${unresolved.map((node) => node.id).join(",")}`,
          recoveryEpoch: task.recoveryEpoch + 1,
        });
      } else {
        this.store.transition(task.id, "needs_manager", {
          reason: `${reason}; producer completed but artifact is absent from the integrated base`,
          recoveryOwner: "manager",
          recoveryScope: "task",
          requiredAction: "review the producer output and integration base",
          unblockCondition: "manager recovery decision",
          recoveryEpoch: task.recoveryEpoch + 1,
        });
      }
      return false;
    }
    this.store.transition(task.id, "waiting_external", {
      reason,
      recoveryOwner: "operator",
      recoveryScope: "task",
      requiredAction: `Create required artifacts: ${missing.join(", ")}`,
      unblockCondition: `artifacts:${missing.join(",")}`,
      recoveryEpoch: task.recoveryEpoch + 1,
    });
    return false;
  }

  async runAgent(input: { role: ProfileManifest["role"]; profile: ProfileManifest; initiativeId?: string | null; nodeId?: string | null; attemptNo?: number; cwd: string; prompt: string; runId: string; sessionId?: string; continueSession?: boolean; agentId: string }): Promise<Awaited<ReturnType<AgentRuntime["run"]>>> {
    const agentId = input.agentId.slice(0, 128);
    this.store.startAgentSession({
      id: input.runId,
      agentId,
      initiativeId: input.initiativeId,
      nodeId: input.nodeId,
      role: input.role,
      profileId: input.profile.id,
      model: input.profile.model,
      attemptNo: input.attemptNo,
      pid: process.pid,
    });
    const heartbeat = setInterval(() => this.store.heartbeatAgent(agentId, input.runId), 5_000);
    try {
      const result = await this.limiter.run(input.profile, () => this.runtime.run({ ...input, agentId }));
      this.store.finishAgentSession(input.runId, result.ok ? "completed" : "failed", { exitCode: result.exitCode });
      return result;
    } catch (error) {
      this.store.finishAgentSession(input.runId, "failed", { error: String(error) });
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private findEpic(node: NodeRecord): NodeRecord {
    let current: NodeRecord | null = node;
    while (current && current.level !== "epic") current = current.parentId ? this.store.getNode(current.parentId) : null;
    if (!current) throw new Error(`task ${node.id} has no epic parent`);
    return current;
  }

  private ensureWorktrees(node: NodeRecord, epic: NodeRecord): { epic: NodeRecord; task: NodeRecord } {
    let currentEpic = epic;
    if (!currentEpic.worktreePath || !currentEpic.branch) {
      const branch = `loom-and-order/${branchSafe(node.initiativeId)}/epic-${branchSafe(epic.id)}`;
      const path = this.git.worktreePath(node.initiativeId, epic.id);
      this.git.createWorktree(epic.repoPath!, branch, path, epic.baseCommit!);
      this.git.ensureDependencies(path);
      this.store.setWorktree(epic.id, branch, path);
      currentEpic = this.store.getNode(epic.id)!;
    }
    this.materializeDependencyCommits(node, currentEpic);
    let currentTask = this.store.getNode(node.id)!;
    if (!currentTask.worktreePath || !currentTask.branch) {
      const branch = `loom-and-order/${branchSafe(node.initiativeId)}/task-${branchSafe(node.id)}`;
      const path = this.git.worktreePath(node.initiativeId, node.id);
      const taskBase = this.git.currentCommit(currentEpic.worktreePath!);
      this.git.createWorktree(currentEpic.repoPath!, branch, path, taskBase);
      this.git.ensureDependencies(path);
      this.store.setWorktree(node.id, branch, path, taskBase);
      currentTask = this.store.getNode(node.id)!;
    }
    return { epic: currentEpic, task: currentTask };
  }

  private materializeDependencyCommits(task: NodeRecord, epic: NodeRecord): void {
    if (!epic.worktreePath || !task.dependsOn.length) return;
    const dependencies = task.dependsOn
      .map((dependencyId) => this.store.getNode(dependencyId))
      .filter((dependency): dependency is NodeRecord => Boolean(dependency?.integratedCommit));
    const resolved: Array<{ nodeId: string; commit: string; merged: boolean }> = [];
    for (const dependency of dependencies) {
      const commit = dependency.integratedCommit!;
      if (this.git.isAncestor(epic.worktreePath, commit)) {
        resolved.push({ nodeId: dependency.id, commit, merged: false });
        continue;
      }
      const before = this.git.currentCommit(epic.worktreePath);
      try {
        this.git.merge(epic.worktreePath, commit);
      } catch (error) {
        this.git.abortMerge(epic.worktreePath);
        this.git.resetWorktree(epic.worktreePath, before);
        throw new Error(`dependency base integration conflict for ${dependency.id}: ${String(error)}`);
      }
      resolved.push({ nodeId: dependency.id, commit, merged: true });
    }
    if (resolved.length) {
      this.store.recordEvent(task.id, "dependency_base_resolved", {
        epicId: epic.id,
        baseCommit: this.git.currentCommit(epic.worktreePath),
        dependencies: resolved,
      });
    }
  }

  private async managerCheckpoint(initiativeId: string): Promise<void> {
    const hasMessages = this.store.pendingMessages(initiativeId).length > 0;
    const hasRecovery = this.store.listNodes(initiativeId).some((node) => ["task", "subtask"].includes(node.level) && node.status === "needs_manager" && node.recoveryOwner === "manager");
    if (!hasMessages && !hasRecovery) return;
    await withObservedSpan({ name: "manager:checkpoint", spanType: SpanType.AGENT, inputs: { initiative_id: initiativeId }, attributes: { "pi.role": "manager", "pi.initiative_id": initiativeId } }, async (trace) => {
      await this.managerCheckpointInternal(initiativeId);
      trace.setOutputs({ initiative_id: initiativeId, completed: true });
    });
  }

  private async managerCheckpointInternal(initiativeId: string): Promise<void> {
    const messages = this.store.pendingMessages(initiativeId);
    const recoveryNodes = this.store.listNodes(initiativeId).filter((node) => ["task", "subtask"].includes(node.level) && node.status === "needs_manager" && node.recoveryOwner === "manager");
    if (!messages.length && !recoveryNodes.length) return;
    const initiative = this.store.getNode(initiativeId)!;
    const managerProfile = this.managerProfile();
    if (!managerProfile) return;
    if ((this.managerCheckpointRetries.get(initiativeId) ?? 0) >= managerProfile.maxAttempts) return;
    const tree = this.store.listNodes(initiativeId).map((node) => ({ id: node.id, level: node.level, status: node.status, title: node.title, dependencies: node.dependsOn }));
    const architecture = this.store.getArchitectureContract(initiativeId);
    const checkpointRunId = `${initiativeId}-manager-${Date.now()}`;
    let result: Awaited<ReturnType<AgentRuntime["run"]>>;
    try {
      result = await this.runAgent({
        role: "manager",
        profile: managerProfile,
        initiativeId,
        cwd: initiative.repoPath!,
        prompt: [
          "You are the durable manager checkpoint for loom-and-order.",
          "Do not edit files. Review the current task tree and the new user guidance. Return only JSON: {\"action\"?:\"retry\"|\"architect\"|\"block\",\"nodeId\"?:string,\"reason\"?:string,\"edits\":[{\"nodeId\":string,\"title\"?:string,\"description\"?:string,\"acceptanceCriteria\"?:string[],\"dependsOn\"?:string[],\"profileId\"?:string|null}],\"note\"?:string}.",
          managerProfile.rolePrompt ?? "",
          `Architecture contract:\n${JSON.stringify(architecture)}`,
          `Task tree:\n${JSON.stringify(tree)}`,
          messages.length ? `New guidance:\n${messages.map((message) => `- ${message.body}`).join("\n")}` : "No new user guidance; review the durable recovery checkpoints below.",
          recoveryNodes.length ? `Recovery checkpoints:\n${JSON.stringify(recoveryNodes.map((node) => ({ id: node.id, title: node.title, status: node.status, reason: node.failure, requiredAction: node.requiredAction, unblockCondition: node.unblockCondition, recoveryEpoch: node.recoveryEpoch })))} ` : "",
        ].join("\n\n"),
        runId: checkpointRunId,
        agentId: `manager-${initiativeId}`,
      });
    } catch {
      this.store.recordMetric({ initiativeId, runId: checkpointRunId, role: "manager", outcome: "failure", durationMs: 0, counters: {}, dimensions: profileDimensions(managerProfile, this.env) });
      const retries = (this.managerCheckpointRetries.get(initiativeId) ?? 0) + 1;
      this.managerCheckpointRetries.set(initiativeId, retries);
      return;
    }
    const decision = result.ok ? parseManagerDecision(result.output) : null;
    this.store.recordMetric({ initiativeId, runId: result.runId, role: "manager", outcome: decision ? "success" : result.raw.timedOut ? "timeout" : "failure", durationMs: Number(result.raw.durationMs ?? 0), counters: runtimeCounters(result.raw, managerProfile), dimensions: profileDimensions(managerProfile, this.env) });
    if (!decision) {
      this.managerCheckpointRetries.set(initiativeId, (this.managerCheckpointRetries.get(initiativeId) ?? 0) + 1);
      return;
    }
    this.managerCheckpointRetries.delete(initiativeId);
    try {
      for (const edit of decision.edits) this.assertValidEditProfile(edit.profileId);
      for (const edit of decision.edits) this.store.applyPlanEdit(initiativeId, edit);
      if (decision.action && decision.nodeId) {
        const target = this.store.getNode(decision.nodeId);
        if (!target || target.initiativeId !== initiativeId) throw new Error(`unknown recovery node ${decision.nodeId}`);
        if (decision.action === "retry" && target.status !== "pending") {
          this.store.transition(target.id, "pending", { reason: decision.reason || "manager authorized recovery retry" });
        } else if (decision.action === "architect" && target.status !== "needs_architect") {
          this.store.transition(target.id, "needs_architect", { reason: decision.reason || "manager requested architecture review", recoveryOwner: "architect", recoveryScope: "task", requiredAction: "revise the architecture contract or task boundary", unblockCondition: "architect recovery decision", recoveryEpoch: target.recoveryEpoch + 1 });
        } else if (decision.action === "block" && target.status !== "blocked") {
          this.store.transition(target.id, "blocked", { reason: decision.reason || "manager blocked recovery checkpoint", recoveryOwner: "manager", recoveryScope: "task", requiredAction: "provide explicit recovery guidance", unblockCondition: "explicit manager/operator resume", recoveryEpoch: target.recoveryEpoch });
        }
        this.store.recordEvent(target.id, "manager_recovery_decision", { action: decision.action, reason: decision.reason ?? "", nodeId: target.id, actor: "manager", profileId: managerProfile.id, model: managerProfile.model ?? "unknown" });
      } else if (decision.action) {
        this.store.recordEvent(initiativeId, "manager_recovery_decision", { action: decision.action, nodeId: decision.nodeId ?? null, reason: decision.reason ?? "", actor: "manager", profileId: managerProfile.id, model: managerProfile.model ?? "unknown" });
      }
      if (messages.length) this.store.markMessagesDelivered(messages.map((message) => message.id));
    } catch {
      // Keep messages pending when the manager proposes an invalid or unsafe edit.
    }
  }

  private async executeTask(input: NodeRecord): Promise<void> {
    await withObservedSpan({ name: "scheduler:task", spanType: SpanType.CHAIN, inputs: { initiative_id: input.initiativeId, node_id: input.id, title: input.title }, attributes: { "pi.initiative_id": input.initiativeId, "pi.node_id": input.id } }, async (trace) => {
      await this.executeTaskInternal(input);
      trace.setOutputs({ node_id: input.id, completed: true });
    });
  }

  private async executeTaskInternal(input: NodeRecord): Promise<void> {
    const selectedProfile = this.profileFor(input.profileId ?? "worker");
    if (selectedProfile.role === "researcher") {
      await this.executeResearchTask(input, selectedProfile);
      return;
    }
    if (selectedProfile.role === "release" && !this.options.enableRelease) {
      this.store.transition(input.id, "blocked", { reason: "release profile is inactive until explicit release scheduling is enabled" });
      return;
    }
    let epic: NodeRecord;
    let worktrees: { epic: NodeRecord; task: NodeRecord };
    let task: NodeRecord;
    try {
      epic = this.findEpic(input);
      worktrees = this.ensureWorktrees(input, epic);
      task = this.store.claim(input.id, `executor-${process.pid}`, selectedProfile.timeoutMs + (this.options.leaseMarginMs ?? 60_000));
      this.store.transition(task.id, "running");
    } catch (error) {
      this.markPreparationFailed(input, error);
      return;
    }
    const profile = selectedProfile;
    // The claim TTL covers one phase, but a task's full lifecycle (worker +
    // review + feedback turns + gate + merge) can outlive it. Refresh the
    // lease while we own the node so the supervisor only recovers genuinely
    // stalled work, never a healthy long review.
    const leaseOwner = `executor-${process.pid}`;
    const leaseMs = selectedProfile.timeoutMs + (this.options.leaseMarginMs ?? 60_000);
    const leaseHeartbeat = setInterval(() => {
      try {
        this.store.heartbeat(task.id, leaseOwner, leaseMs);
      } catch {
        // Lease no longer owned (completed, recovered, or re-claimed).
      }
    }, this.options.leaseHeartbeatMs ?? 30_000);
    try {
    // A fresh worker attempt always starts from the task base. Resume paths
    // (policy blocks, exhausted repair budgets, commit-shape failures) can
    // leave prior host/worker commits in the worktree; stacking a new attempt
    // on top breaks the single-commit invariant the commit-shape check enforces.
    this.git.resetWorktree(task.worktreePath!, task.baseCommit!);
    const priorMerge = this.git.findPriorMerge(worktrees.epic.worktreePath!, task.branch!);
    if (priorMerge) {
      // A previous attempt already merged this task's branch into the epic
      // (typically a crash between the merge and the completion record). The
      // epic tip is now the task base, so re-implementing would leave no
      // commit (single-commit shape failure) or conflict with the merged
      // work. Complete idempotently on the existing merge commit.
      this.store.recordEvent(task.id, "integration_prior_merge_detected", { mergeCommit: priorMerge, attemptNo: task.attempt });
      await this.completeOnPriorMerge(task, worktrees, priorMerge);
      return;
    }
    const workerAttempt = this.store.recordAttempt({ nodeId: task.id, attemptNo: task.attempt, role: "worker", state: "running", outputPath: undefined });
    const messages = this.store.pendingMessages(task.initiativeId);
    const workerPrompt = this.workerPrompt(task, worktrees.epic, worktrees.task, messages.map((message) => message.body), profile);
    this.store.markMessagesDelivered(messages.map((message) => message.id));
    let worker;
    try {
      worker = await this.runAgent({ role: profile.role, profile, initiativeId: task.initiativeId, nodeId: task.id, attemptNo: task.attempt, cwd: task.worktreePath!, prompt: workerPrompt, runId: `${task.id}-${profile.role}-${task.attempt}`, agentId: `${profile.role}-${task.id}` });
    } catch (error) {
      this.store.finishAttempt(workerAttempt, "failed", { output: String(error) });
      this.store.recordMetric({ initiativeId: task.initiativeId, nodeId: task.id, runId: `${task.id}-${profile.role}-${task.attempt}`, role: profile.role === "release" ? "release" : "worker", outcome: "failure", durationMs: 0, counters: runtimeCounters(undefined, profile), dimensions: profileDimensions(profile, this.env) });
      this.failOrRetry(task.id, profile.maxAttempts, `infrastructure launch failure: ${String(error)}`);
      return;
    }
    this.store.finishAttempt(workerAttempt, worker.ok ? "completed" : "failed", { exitCode: worker.exitCode, output: worker.output.slice(-10000), stdoutPath: worker.raw.stdoutPath, stderrPath: worker.raw.stderrPath });
    this.store.recordMetric({
      initiativeId: task.initiativeId,
      nodeId: task.id,
      runId: worker.runId,
      role: profile.role === "release" ? "release" : "worker",
      outcome: worker.ok ? "success" : worker.raw.timedOut ? "timeout" : "failure",
      durationMs: Number(worker.raw.durationMs ?? 0),
      counters: runtimeCounters(worker.raw, profile),
      dimensions: profileDimensions(profile, this.env),
    });
    if (!worker.ok) {
      if (infrastructureFailure(worker)) this.failOrRetry(task.id, profile.maxAttempts, "worker infrastructure failure");
      else this.failOrBlock(task.id, "worker returned a failed result");
      return;
    }
    try {
      // A sandboxed Git worktree may not expose the parent repository's linked
      // .git metadata. The host-side orchestrator owns the commit boundary so
      // workers can still implement and test safely inside the sandbox.
      this.git.commitChanges(task.worktreePath!, `feat: implement ${task.title}`);
    } catch (error) {
      this.failOrBlock(task.id, `worker commit failed: ${String(error)}`);
      return;
    }
    if (this.git.commitCountSince(task.worktreePath!, task.baseCommit!) !== 1 || !this.git.isClean(task.worktreePath!)) {
      this.failOrBlock(task.id, "worker did not leave exactly one clean commit");
      return;
    }

    const reviewerProfile = this.profileFor("reviewer");
    let feedbackTurns = 0;
    while (true) {
      if (this.store.getNode(task.id)?.status !== "reviewing") this.store.transition(task.id, "reviewing");
      const reviewAttempt = this.store.recordAttempt({ nodeId: task.id, attemptNo: task.attempt, role: "reviewer", state: "running" });
      const diff = this.git.diff(task.worktreePath!, task.baseCommit!).slice(-100000);
      let reviewer;
      try {
        reviewer = await this.runAgent({
          role: "reviewer",
          profile: reviewerProfile,
          initiativeId: task.initiativeId,
          nodeId: task.id,
          attemptNo: task.attempt,
          cwd: task.worktreePath!,
          prompt: this.reviewerPrompt(task, diff, worker.output, reviewerProfile),
          runId: `${task.id}-reviewer-${task.attempt}-${feedbackTurns}`,
          agentId: `reviewer-${task.id}`,
        });
      } catch (error) {
        this.store.finishAttempt(reviewAttempt, "failed", { output: String(error) });
        this.store.recordMetric({ initiativeId: task.initiativeId, nodeId: task.id, runId: `${task.id}-reviewer-${task.attempt}-${feedbackTurns}`, role: "reviewer", outcome: "failure", durationMs: 0, counters: runtimeCounters(undefined, reviewerProfile), dimensions: profileDimensions(reviewerProfile, this.env) });
        this.failOrRetry(task.id, reviewerProfile.maxAttempts, `reviewer infrastructure failure: ${String(error)}`);
        return;
      }
      const verdict = reviewer.ok ? parseReview(reviewer.output) : null;
      this.store.finishAttempt(reviewAttempt, verdict?.verdict === "pass" ? "completed" : "failed", { exitCode: reviewer.exitCode, output: reviewer.output.slice(-10000), stdoutPath: reviewer.raw.stdoutPath, stderrPath: reviewer.raw.stderrPath });
      this.store.recordMetric({
        initiativeId: task.initiativeId,
        nodeId: task.id,
        runId: reviewer.runId,
        role: "reviewer",
        outcome: verdict?.verdict ?? (reviewer.raw.timedOut ? "timeout" : "failure"),
        durationMs: Number(reviewer.raw.durationMs ?? 0),
        counters: runtimeCounters(reviewer.raw, reviewerProfile),
        dimensions: profileDimensions(reviewerProfile, this.env),
      });
      if (!verdict) {
        this.failOrRetry(task.id, reviewerProfile.maxAttempts, "reviewer produced no valid verdict");
        return;
      }
      this.store.addReview({ taskId: task.id, verdict: verdict.verdict, findings: verdict.findings, evidence: verdict.evidence, createdAt: new Date().toISOString() });
      if (verdict.verdict !== "pass") {
        const findings = verdict.findings.length ? verdict.findings : ["reviewer rejected the implementation without findings"];
        if (feedbackTurns < MAX_CONVERSATIONAL_FEEDBACK_TURNS) {
          try {
            this.git.resetWorktree(worktrees.task.worktreePath!, task.baseCommit!);
            const repaired = await this.conversationalWorkerRepair(task, worktrees, profile, worker, `The reviewer rejected your implementation. Continue in this same conversation and repair the current task. Findings:\n${findings.map((finding) => `- ${finding}`).join("\\n")}\nReturn a corrected implementation and run the focused checks.`, feedbackTurns + 1);
            if (repaired) {
              worker = repaired;
              feedbackTurns += 1;
              continue;
            }
          } catch (error) {
            this.store.recordEvent(task.id, "conversational_feedback_failed", { reason: String(error), feedbackTurn: feedbackTurns + 1 });
          }
        }
        const current = this.store.getNode(task.id)!;
        this.store.recordEvent(task.id, "repair_escalated", { attempts: current.attempt, findings, feedbackTurns });
        await this.managerRecoveryDecision(current, findings, worktrees);
        return;
      }

      const gate = await withObservedSpan({ name: "repository:gate", spanType: SpanType.TOOL, inputs: { node_id: task.id, command: basename(this.options.gateCommand[0]) }, attributes: { "pi.role": "gate", "pi.node_id": task.id } }, async (trace) => {
        const result = await this.git.runGate(task.worktreePath!, this.options.gateCommand);
        trace.setOutputs({ ok: result.ok, duration_ms: result.durationMs, output_bytes: result.output.length });
        return result;
      });
      this.store.recordMetric({
        initiativeId: task.initiativeId,
        nodeId: task.id,
        runId: `${task.id}-gate-${task.attempt}-${feedbackTurns}`,
        role: "gate",
        outcome: gate.ok ? "pass" : "fail",
        durationMs: gate.durationMs,
        counters: { output_bytes: gate.output.length },
        dimensions: { gate: basename(this.options.gateCommand[0]) },
      });
      if (!gate.ok) {
        const reason = `repository gate failed: ${gate.output.slice(-2000)}`;
        if (feedbackTurns < MAX_CONVERSATIONAL_FEEDBACK_TURNS) {
          try {
            this.git.resetWorktree(worktrees.task.worktreePath!, task.baseCommit!);
            const repaired = await this.conversationalWorkerRepair(task, worktrees, profile, worker, `The repository gate failed. Continue in this same conversation and repair the current task. Gate output:\n${gate.output.slice(-4000)}\nRun the gate-relevant checks and return the corrected implementation.`, feedbackTurns + 1);
            if (repaired) {
              worker = repaired;
              feedbackTurns += 1;
              continue;
            }
          } catch (error) {
            this.store.recordEvent(task.id, "conversational_feedback_failed", { reason: String(error), feedbackTurn: feedbackTurns + 1 });
          }
        }
        const current = this.store.getNode(task.id)!;
        await this.managerRecoveryDecision(current, [reason], worktrees);
        return;
      }
      this.store.transition(task.id, "integrating", { gateOutput: gate.output.slice(-10000) });
      break;
    }
    await this.withEpicLock(worktrees.epic.id, async () => {
      const epicBeforeMerge = this.git.currentCommit(worktrees.epic.worktreePath!);
      const priorMerge = this.git.findPriorMerge(worktrees.epic.worktreePath!, task.branch!);
      if (priorMerge) {
        await this.completeOnPriorMerge(task, worktrees, priorMerge);
        return;
      }
      try {
        const integrated = this.git.merge(worktrees.epic.worktreePath!, task.branch!);
        const postMergeGate = await this.git.runGate(worktrees.epic.worktreePath!, this.options.gateCommand);
        this.store.recordMetric({
          initiativeId: task.initiativeId,
          nodeId: task.id,
          runId: `${task.id}-post-merge-gate-${task.attempt}`,
          role: "gate",
          outcome: postMergeGate.ok ? "pass" : "fail",
          durationMs: postMergeGate.durationMs,
          counters: { output_bytes: postMergeGate.output.length },
          dimensions: { gate: basename(this.options.gateCommand[0]), status: "post_merge" },
        });
        if (!postMergeGate.ok) {
          this.git.resetWorktree(worktrees.epic.worktreePath!, epicBeforeMerge);
          this.store.recordEvent(task.id, "post_merge_gate_failed", { output: postMergeGate.output.slice(-10000), epicBeforeMerge });
          await this.recoverIntegrationFailure(task, worktrees, `post-merge repository gate failed: ${postMergeGate.output.slice(-2000)}`);
          return;
        }
        this.store.setIntegratedCommit(task.id, integrated);
        this.store.setIntegratedCommit(worktrees.epic.id, integrated);
        this.store.transition(task.id, "completed", { integratedCommit: integrated, gateOutput: postMergeGate.output.slice(-10000) });
      } catch (error) {
        this.git.abortMerge(worktrees.epic.worktreePath!);
        this.git.resetWorktree(worktrees.epic.worktreePath!, epicBeforeMerge);
        await this.recoverIntegrationFailure(task, worktrees, `integration conflict: ${String(error)}`);
      }
    });
    } finally {
      clearInterval(leaseHeartbeat);
    }
  }

  private async completeOnPriorMerge(task: NodeRecord, worktrees: { epic: NodeRecord; task: NodeRecord }, priorMerge: string): Promise<void> {
    await this.withEpicLock(worktrees.epic.id, async () => {
      const epicBeforeMerge = this.git.currentCommit(worktrees.epic.worktreePath!);
      const gate = await this.git.runGate(worktrees.epic.worktreePath!, this.options.gateCommand);
      if (gate.ok) {
        this.store.setIntegratedCommit(task.id, priorMerge);
        this.store.setIntegratedCommit(worktrees.epic.id, priorMerge);
        this.store.transition(task.id, "completed", { integratedCommit: priorMerge, gateOutput: gate.output.slice(-10000) });
        this.store.recordEvent(task.id, "integration_already_merged", { mergeCommit: priorMerge, baseCommit: epicBeforeMerge });
      } else {
        await this.recoverIntegrationFailure(task, worktrees, `prior integration merge ${priorMerge} exists but epic gate failed: ${gate.output.slice(-2000)}`);
      }
    });
  }

  private async conversationalWorkerRepair(
    task: NodeRecord,
    worktrees: { epic: NodeRecord; task: NodeRecord },
    profile: ProfileManifest,
    previous: Awaited<ReturnType<AgentRuntime["run"]>>,
    prompt: string,
    feedbackTurn: number,
  ): Promise<Awaited<ReturnType<AgentRuntime["run"]>> | null> {
    const sessionId = previous.sessionId ?? previous.runId;
    const runId = `${task.id}-worker-feedback-${task.attempt}-${feedbackTurn}`;
    const attempt = this.store.recordAttempt({ nodeId: task.id, attemptNo: task.attempt, role: "worker", state: "running" });
    let result: Awaited<ReturnType<AgentRuntime["run"]>>;
    try {
      result = await this.runAgent({
        role: profile.role,
        profile,
        initiativeId: task.initiativeId,
        nodeId: task.id,
        attemptNo: task.attempt,
        cwd: worktrees.task.worktreePath!,
        prompt,
        runId,
        sessionId,
        continueSession: true,
        agentId: `${profile.role}-${task.id}`,
      });
    } catch (error) {
      this.store.finishAttempt(attempt, "failed", { output: String(error) });
      this.store.recordEvent(task.id, "conversational_feedback_failed", { feedbackTurn, reason: String(error) });
      this.store.recordMetric({ initiativeId: task.initiativeId, nodeId: task.id, runId, role: profile.role === "release" ? "release" : "worker", outcome: "failure", durationMs: 0, counters: {}, dimensions: profileDimensions(profile, this.env, { status: "same_session_feedback" }) });
      return null;
    }
    this.store.finishAttempt(attempt, result.ok ? "completed" : "failed", { exitCode: result.exitCode, output: result.output.slice(-10000), stdoutPath: result.raw.stdoutPath, stderrPath: result.raw.stderrPath });
    this.store.recordMetric({ initiativeId: task.initiativeId, nodeId: task.id, runId, role: profile.role === "release" ? "release" : "worker", outcome: result.ok ? "success" : result.raw.timedOut ? "timeout" : "failure", durationMs: Number(result.raw.durationMs ?? 0), counters: runtimeCounters(result.raw, profile), dimensions: profileDimensions(profile, this.env, { status: "same_session_feedback" }) });
    if (!result.ok) return null;
    try {
      this.git.commitChanges(worktrees.task.worktreePath!, `fix: repair ${task.title}`);
      if (this.git.commitCountSince(worktrees.task.worktreePath!, task.baseCommit!) !== 1 || !this.git.isClean(worktrees.task.worktreePath!)) throw new Error("worker feedback did not leave exactly one clean commit");
    } catch (error) {
      this.store.recordEvent(task.id, "conversational_feedback_failed", { feedbackTurn, reason: String(error) });
      return null;
    }
    this.store.recordEvent(task.id, "conversational_feedback_completed", { feedbackTurn, sessionId });
    return result;
  }

  private async recoverIntegrationFailure(task: NodeRecord, worktrees: { epic: NodeRecord; task: NodeRecord }, reason: string): Promise<void> {
    const fingerprint = reason.toLocaleLowerCase().replace(/[0-9a-f]{7,}/g, "<sha>").replace(/\s+/g, " ").trim().slice(0, 240);
    const priorRecoveries = this.store.events(task.id).filter((event) => event.kind === "integration_recovery_scheduled" && event.payload.fingerprint === fingerprint).length;
    this.store.recordMetric({
      initiativeId: task.initiativeId,
      nodeId: task.id,
      runId: `${task.id}-integration-recovery-${priorRecoveries + 1}`,
      role: "scheduler",
      outcome: priorRecoveries < MAX_INTEGRATION_RECOVERY_ATTEMPTS ? "recovery" : "blocked",
      durationMs: 0,
      counters: { integration_recovery: 1 },
      dimensions: { status: priorRecoveries < MAX_INTEGRATION_RECOVERY_ATTEMPTS ? "retry" : "exhausted" },
    });
    if (priorRecoveries >= MAX_INTEGRATION_RECOVERY_ATTEMPTS) {
      this.store.recordEvent(task.id, "integration_recovery_exhausted", { reason, attempts: priorRecoveries, fingerprint });
      this.failOrBlock(task.id, reason);
      return;
    }
    const epicBase = this.git.currentCommit(worktrees.epic.worktreePath!);
    this.git.resetWorktree(worktrees.task.worktreePath!, epicBase);
    this.store.setWorktree(task.id, task.branch!, worktrees.task.worktreePath!, epicBase);
    this.store.recordEvent(task.id, "integration_recovery_scheduled", { reason, fingerprint, attemptNo: priorRecoveries + 1, retryBaseCommit: epicBase });
    const managerProfile = this.managerProfile();
    if (managerProfile) {
      this.store.transition(task.id, "needs_manager", {
        reason,
        recoveryOwner: "manager",
        recoveryScope: "task",
        requiredAction: "review the integration failure and authorize a retry, split, or architecture escalation",
        unblockCondition: "manager recovery decision",
        recoveryEpoch: priorRecoveries + 1,
        recoveryFingerprint: fingerprint,
        integrationRecoveryAttempt: priorRecoveries + 1,
      });
      await this.managerRecoveryDecision(this.store.getNode(task.id)!, [reason], worktrees);
    } else {
      this.store.transition(task.id, "pending", { reason, integrationRecoveryAttempt: priorRecoveries + 1, recoveryFingerprint: fingerprint });
    }
  }

  private async executeResearchTask(input: NodeRecord, profile: ProfileManifest): Promise<void> {
    let task: NodeRecord;
    try {
      task = this.store.claim(input.id, `researcher-${process.pid}`, profile.timeoutMs + 60_000);
      this.store.transition(task.id, "running");
    } catch (error) {
      this.markPreparationFailed(input, error);
      return;
    }
    const attempt = this.store.recordAttempt({ nodeId: task.id, attemptNo: task.attempt, role: "researcher", state: "running" });
    const prompt = [
      "You are a read-only researcher in loom-and-order.",
      "Investigate the task and repository, use the configured tools for research, and do not write, delete, commit, or integrate files.",
      `Task: ${task.title}`,
      task.description,
      `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      profile.rolePrompt ?? "",
      "Return a concise evidence-based report for the manager. End with exactly RESEARCH_RESULT: complete or RESEARCH_RESULT: blocked.",
    ].join("\n\n");
    let result;
    try {
      result = await this.runAgent({ role: "researcher", profile, initiativeId: task.initiativeId, nodeId: task.id, attemptNo: task.attempt, cwd: task.repoPath!, prompt, runId: `${task.id}-researcher-${task.attempt}`, agentId: `researcher-${task.id}` });
    } catch (error) {
      this.store.finishAttempt(attempt, "failed", { output: String(error) });
      this.store.recordMetric({ initiativeId: task.initiativeId, nodeId: task.id, runId: `${task.id}-researcher-${task.attempt}`, role: "researcher", outcome: "failure", durationMs: 0, counters: runtimeCounters(undefined, profile), dimensions: profileDimensions(profile, this.env) });
      this.failOrRetry(task.id, profile.maxAttempts, `research infrastructure failure: ${String(error)}`);
      return;
    }
    this.store.finishAttempt(attempt, result.ok ? "completed" : "failed", { exitCode: result.exitCode, output: result.output.slice(-10000), stdoutPath: result.raw.stdoutPath, stderrPath: result.raw.stderrPath });
    this.store.recordMetric({ initiativeId: task.initiativeId, nodeId: task.id, runId: result.runId, role: "researcher", outcome: result.ok ? "success" : result.raw.timedOut ? "timeout" : "failure", durationMs: Number(result.raw.durationMs ?? 0), counters: runtimeCounters(result.raw, profile), dimensions: profileDimensions(profile, this.env) });
    if (!result.ok) {
      if (infrastructureFailure(result)) this.failOrRetry(task.id, profile.maxAttempts, "research infrastructure failure");
      else this.failOrBlock(task.id, "researcher returned a failed result");
      return;
    }
    this.store.transition(task.id, "completed", { researchOutput: result.output.slice(-10000) });
  }

  private async withEpicLock<T>(epicId: string, callback: () => T | Promise<T>): Promise<T> {
    const previous = this.epicLocks.get(epicId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.epicLocks.set(epicId, current);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (this.epicLocks.get(epicId) === current) this.epicLocks.delete(epicId);
    }
  }

  private async managerRecoveryDecision(task: NodeRecord, findings: string[], worktrees: { epic: NodeRecord; task: NodeRecord }): Promise<void> {
    const managerProfile = this.managerProfile();
    if (!managerProfile) {
      this.failOrBlock(task.id, "repair attempts exhausted and manager profile is unavailable");
      return;
    }
    const architecture = this.store.getArchitectureContract(task.initiativeId);
    const attemptHistory = this.store.listAttempts(task.id).map((attempt) => ({ attemptNo: attempt.attemptNo, role: attempt.role, state: attempt.state, startedAt: attempt.startedAt, endedAt: attempt.endedAt }));
    const externalMessages = this.store.pendingMessages(task.initiativeId).map((message) => message.body);
    const managerPrompt = [
      "You are the recovery manager for loom-and-order.",
      "The worker implementation failed reviewer twice. Choose exactly one recovery action and return only JSON: {\"action\":\"architect\"|\"retry\"|\"block\",\"nodeId\":string,\"reason\":string,\"edits\":[],\"note\":string}.",
      "Do not edit files or author architecture. Choose architect when the contract or task shape must change; choose retry only when an explicit extra attempt is justified; otherwise choose block.",
      managerProfile.rolePrompt ?? "",
      `Task:\n${JSON.stringify({ id: task.id, title: task.title, description: task.description, attempt: task.attempt })}`,
      `Attempt history:\n${JSON.stringify(attemptHistory)}`,
      `Architecture contract:\n${JSON.stringify(architecture)}`,
      `Reviewer findings:\n${findings.map((finding) => `- ${finding}`).join("\n")}`,
      `External guidance:\n${externalMessages.map((message) => `- ${message}`).join("\n") || "none"}`,
    ].join("\n\n");
    let managerResult: Awaited<ReturnType<AgentRuntime["run"]>>;
    try {
      managerResult = await this.runAgent({
        role: "manager",
        profile: managerProfile,
        initiativeId: task.initiativeId,
        nodeId: task.id,
        attemptNo: task.attempt,
        cwd: task.repoPath!,
        prompt: managerPrompt,
        runId: `${task.id}-manager-recovery-${task.attempt}`,
        agentId: `manager-${task.initiativeId}`,
      });
    } catch (error) {
      this.failOrBlock(task.id, `manager recovery failed: ${String(error)}`);
      return;
    }
    const decision = managerResult.ok ? parseManagerDecision(managerResult.output) : null;
    this.store.recordMetric({
      initiativeId: task.initiativeId,
      nodeId: task.id,
      runId: managerResult.runId,
      role: "manager",
      outcome: decision?.action ? "success" : managerResult.raw.timedOut ? "timeout" : "failure",
      durationMs: Number(managerResult.raw.durationMs ?? 0),
      counters: runtimeCounters(managerResult.raw, managerProfile),
      dimensions: profileDimensions(managerProfile, this.env),
    });
    if (!decision?.action) {
      this.failOrBlock(task.id, "manager returned no valid recovery action");
      return;
    }
    this.store.recordEvent(task.id, "manager_recovery_decision", { action: decision.action, reason: decision.reason ?? "", nodeId: task.id, actor: "manager", profileId: managerProfile.id, model: managerProfile.model ?? "unknown", attempt: task.attempt });
    if (decision.action === "block") {
      this.failOrBlock(task.id, decision.reason || "manager blocked after exhausted repair attempts");
      return;
    }
    if (decision.action === "retry") {
      try {
        this.git.resetWorktree(worktrees.task.worktreePath!, task.baseCommit!);
        this.store.transition(task.id, "pending", { reason: decision.reason || "manager authorized an extra repair attempt" });
      } catch (error) {
        this.failOrBlock(task.id, `manager retry preparation failed: ${String(error)}`);
      }
      return;
    }
    const architectProfile = this.options.profiles.architect;
    if (!architectProfile) {
      this.failOrBlock(task.id, "manager requested architecture escalation but architect profile is unavailable");
      return;
    }
    const architectPrompt = [
      "You are the architecture escalation agent for loom-and-order.",
      "Review the current architecture contract and reviewer findings. Return only JSON matching {summary:string,decisions:string[],constraints:string[],invariants:string[],interfaces:string[],taskGuidance:string[],executionPlan:{tasks:[{alias,title,objective,produces:string[],deliverables:string[],requiredArtifacts:string[],prerequisites:string[],dependsOn:string[],verification:string[]}],integrationOrder:string[],preflightChecks:string[],repairPolicy:string}}. Update task boundaries and dependencies for the runner; do not edit target files. `produces` and `requiredArtifacts` must be repository-relative paths only; `produces` means outputs created/changed by this task, while `requiredArtifacts` means inputs that already exist before it starts. Put prose in `deliverables` and runtime versions/policies in `prerequisites`. A task must not require one of its own produced paths. Example: produces:[\"src/model.py\"], deliverables:[\"Immutable model\"], requiredArtifacts:[], prerequisites:[\"Python 3.10+\"].",
      architectProfile.rolePrompt ?? "",
      `Current contract:\n${JSON.stringify(architecture)}`,
      `Task:\n${JSON.stringify({ id: task.id, title: task.title, description: task.description })}`,
      `Reviewer findings:\n${findings.map((finding) => `- ${finding}`).join("\n")}`,
    ].join("\n\n");
    let architectResult: Awaited<ReturnType<AgentRuntime["run"]>>;
    try {
      architectResult = await this.runAgent({
        role: "architect",
        profile: architectProfile,
        initiativeId: task.initiativeId,
        nodeId: task.id,
        attemptNo: task.attempt,
        cwd: task.repoPath!,
        prompt: architectPrompt,
        runId: `${task.id}-architect-recovery-${task.attempt}`,
        agentId: `architect-${task.initiativeId}`,
      });
    } catch (error) {
      this.failOrBlock(task.id, `architect escalation failed: ${String(error)}`);
      return;
    }
    const draft = architectResult.ok ? parseArchitectureContract(architectResult.output) : null;
    this.store.recordMetric({
      initiativeId: task.initiativeId,
      nodeId: task.id,
      runId: architectResult.runId,
      role: "architect",
      outcome: draft ? "success" : architectResult.raw.timedOut ? "timeout" : "failure",
      durationMs: Number(architectResult.raw.durationMs ?? 0),
      counters: runtimeCounters(architectResult.raw, architectProfile),
      dimensions: profileDimensions(architectProfile, this.env),
    });
    if (!draft || draft.version !== 2 || !draft.executionPlan) {
      this.failOrBlock(task.id, "architect returned no valid revised system-aware contract");
      return;
    }
    const revision = (architecture?.revision ?? 0) + 1;
    const revised: ArchitectureContract = {
      ...draft,
      revision,
      initiativeId: task.initiativeId,
      author: { role: "architect", profileId: architectProfile.id, model: architectProfile.model ?? "unknown" },
      createdAt: new Date().toISOString(),
    };
    try {
      this.store.saveArchitectureContract(revised, decision.reason || "manager escalated reviewer failure to Architect");
      this.git.resetWorktree(worktrees.task.worktreePath!, task.baseCommit!);
      this.store.recordEvent(task.id, "architecture_escalated", { revision, reason: decision.reason ?? "", actor: "architect", profileId: architectProfile.id, model: architectProfile.model ?? "unknown" });
      this.store.transition(task.id, "pending", { reason: "architecture contract revised; repair requested" });
    } catch (error) {
      this.failOrBlock(task.id, `architecture revision persistence failed: ${String(error)}`);
    }
  }

  private failOrRetry(id: string, maxAttempts: number, reason: string): void {
    const node = this.store.getNode(id)!;
    if (node.attempt < maxAttempts) this.store.transition(id, "pending", { reason });
    else this.failOrBlock(id, reason);
  }

  private failOrBlock(id: string, reason: string): void {
    const node = this.store.getNode(id)!;
    const from = node.status;
    if (["running", "reviewing", "integrating", "waiting", "recovering", "waiting_dependency", "waiting_external", "waiting_approval", "needs_manager", "needs_architect", "needs_operator"].includes(from)) this.store.transition(id, "blocked", { reason, recoveryOwner: "manager", recoveryScope: "task", requiredAction: "provide guidance or repair the task", unblockCondition: "explicit recovery action", recoveryEpoch: node.recoveryEpoch, recoveryFingerprint: node.recoveryFingerprint });
    else if (["pending", "paused"].includes(from)) this.store.transition(id, "blocked", { reason });
  }

  private workerPrompt(task: NodeRecord, epic: NodeRecord, worktree: NodeRecord, managerMessages: string[] = [], profile?: ProfileManifest): string {
    const architecture = this.store.getArchitectureContract(task.initiativeId);
    const latestReview = this.store.latestReview(task.id);
    const repairFindings = latestReview?.verdict === "fail" ? latestReview.findings : [];
    return [
      "You are a bounded worker in loom-and-order.",
      `Task: ${task.title}`,
      task.description,
      `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      `Epic: ${epic.title}. Worktree: ${worktree.worktreePath}`,
      `Architecture contract:\n${JSON.stringify(architecture)}`,
      repairFindings.length ? `Prior reviewer findings to repair:\n${repairFindings.map((finding) => `- ${finding}`).join("\n")}` : "",
      managerMessages.length ? `Additional manager guidance:\n${managerMessages.map((message) => `- ${message}`).join("\n")}` : "",
      profile?.rolePrompt ?? "",
      profile?.sandbox.backend === "trusted-local"
        ? "Read repository instructions first. Change only this task and run focused checks. Do not run git add, git commit, git push, or any git write command; leave your changes uncommitted in the working tree. The host orchestrator creates the single task commit after your session ends. Do not push or merge."
        : "Read repository instructions first. Change only this task and run focused checks. Do not create commits; the host orchestrator creates the final commit after your sandboxed run, so do not depend on git status or git commit working inside the sandbox. Do not push or merge.",
      "End the visible report with exactly WORK_RESULT: complete or WORK_RESULT: blocked.",
    ].join("\n\n");
  }

  private reviewerPrompt(task: NodeRecord, diff: string, workerOutput: string, profile?: ProfileManifest): string {
    const architecture = this.store.getArchitectureContract(task.initiativeId);
    return [
      "You are an independent reviewer in loom-and-order.",
      `Task: ${task.title}`,
      task.description,
      `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      `Architecture contract:\n${JSON.stringify(architecture)}`,
      `Worker report:\n${workerOutput.slice(-10000)}`,
      `Diff:\n${diff}`,
      profile?.rolePrompt ?? "",
      profile?.sandbox.backend === "trusted-local"
        ? "The host orchestrator has verified the worker worktree and supplies the complete diff above. Inspect the implementation, run focused checks, and do not modify files or commits."
        : "The host orchestrator has already verified the worker commit and supplies the complete diff above. Git worktree metadata is intentionally outside this sandbox; do not run git status, git log, or git diff, and do not fail the review because those commands are unavailable. Run focused checks with PYTHONDONTWRITEBYTECODE=1 when applicable so the worktree stays clean.",
      "Run or inspect the repository checks when possible. Return only JSON with this shape: {\"verdict\":\"pass\"|\"fail\",\"findings\":[string],\"evidence\":object}.",
    ].join("\n\n");
  }
}
