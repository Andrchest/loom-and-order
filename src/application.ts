import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator, profileDimensions, providerFailure, runtimeCounters, type Submission } from "./executor.ts";
import { Supervisor } from "./supervisor.ts";
import { applyArchitectureExecutionPlan, parseArchitectureContract, parsePlan, PiAgentRuntime, defaultPlan, type AgentRuntime, type ArchitectureDraft } from "./runtime.ts";
import { CustomProfileStore, loadModelCatalog, loadProfile, materializeCatalogProfiles, parseRoleProfileSelection, validateProfileManifest, type ProfileManifest, type RoleProfileSelection } from "./profiles.ts";
import { prometheus } from "./metrics.ts";
import { Store } from "./store.ts";
import { GitWorkspace } from "./git.ts";
import { ToolchainManager, type ToolchainStatus } from "./toolchain.ts";
import type { AgentRecord, ArchitectureContract, EventRecord, PlanSpec } from "./domain.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function defaultStateDir(): string {
  return resolve(process.env.LAO_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? ".", ".local", "state"), "loom-and-order"));
}

function gateFromEnvironment(): string[] {
  const value = process.env.LAO_GATE_COMMAND;
  if (!value) return ["__auto__"];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.length || parsed.some((item) => typeof item !== "string")) throw new Error("not a command array");
    return parsed;
  } catch (error) {
    throw new Error(`LAO_GATE_COMMAND must be a JSON string array: ${String(error)}`);
  }
}

function topologicalOrder(nodes: Array<{ id: string; dependsOn: string[] }>): string[] {
  const remaining = new Map(nodes.map((node) => [node.id, new Set(node.dependsOn)]));
  const ordered: string[] = [];
  while (remaining.size) {
    const ready = [...remaining.entries()].filter(([, deps]) => [...deps].every((dependency) => !remaining.has(dependency))).map(([id]) => id);
    if (!ready.length) throw new Error("dependency cycle in epic graph; refusing to deliver");
    for (const id of ready) {
      ordered.push(id);
      remaining.delete(id);
    }
  }
  return ordered;
}

export interface ServiceOptions {
  stateDir?: string;
  projectRoot?: string;
  gateCommand?: string[];
  autoStart?: boolean;
  enableRelease?: boolean;
  runtime?: AgentRuntime;
}

function normalizeProfile(profile: ProfileManifest, projectRoot: string): ProfileManifest {
  const resolveResource = (value: string): string => value.startsWith("./") ? resolve(projectRoot, value) : value;
  return { ...profile, skills: profile.skills.map(resolveResource), extensions: profile.extensions.map(resolveResource) };
}

export function detachedRunInvocation(entry: string, initiativeId: string, stateDir: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    command: process.execPath,
    args: ["--experimental-strip-types", entry, "run", initiativeId, "--state-dir", stateDir],
    env: { ...process.env, LAO_STATE_DIR: stateDir },
  };
}

export class ApplicationService {
  readonly stateDir: string;
  readonly projectRoot: string;
  readonly store: Store;
  readonly runtime: AgentRuntime;
  readonly profiles: Record<string, ProfileManifest>;
  readonly roleSelection: RoleProfileSelection;
  readonly orchestrator: Orchestrator;
  readonly supervisor: Supervisor;
  readonly customProfileStore: CustomProfileStore;
  readonly toolchain: ToolchainManager;
  readonly autoStart: boolean;
  readonly gateCommand: string[];
  private gitWorkspace: GitWorkspace | null = null;

  private git(): GitWorkspace {
    if (!this.gitWorkspace) this.gitWorkspace = new GitWorkspace(this.stateDir);
    return this.gitWorkspace;
  }

  constructor(options: ServiceOptions = {}) {
    this.stateDir = resolve(options.stateDir ?? defaultStateDir());
    this.projectRoot = resolve(options.projectRoot ?? PROJECT_ROOT);
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.store = new Store(join(this.stateDir, "state.sqlite3"));
    this.toolchain = new ToolchainManager(this.stateDir);
    this.runtime = options.runtime ?? new PiAgentRuntime(this.stateDir, join(this.stateDir, "logs"), this.toolchain.env);
    // The repository ships two example worker profiles as templates only. Real
    // role profiles are operator-provided: create them with `profiles create`
    // (persisted under the state directory) or clone an example.
    const baseProfiles: Record<string, ProfileManifest> = {
      "example-local": normalizeProfile(loadProfile(join(this.projectRoot, "profiles", "example-local.json")), this.projectRoot),
      "example-subscription": normalizeProfile(loadProfile(join(this.projectRoot, "profiles", "example-subscription.json")), this.projectRoot),
    };
    const catalog = loadModelCatalog(join(this.projectRoot, "profiles", "model-catalog.json"));
    const catalogProfiles = materializeCatalogProfiles(catalog, baseProfiles);
    this.customProfileStore = new CustomProfileStore(this.stateDir);
    const customProfiles = this.customProfileStore.list().map((profile) => normalizeProfile(profile, this.projectRoot));
    const allProfiles = [...Object.values(baseProfiles), ...catalogProfiles, ...customProfiles];
    const duplicate = allProfiles.find((profile, index) => allProfiles.findIndex((candidate) => candidate.id === profile.id) !== index);
    if (duplicate) throw new Error(`duplicate profile id: ${duplicate.id}`);
    this.profiles = Object.fromEntries(allProfiles.map((profile) => [profile.id, profile]));
    this.roleSelection = parseRoleProfileSelection(process.env);
    for (const [role, profileId] of Object.entries(this.roleSelection)) {
      const profile = this.profiles[profileId];
      if (!profile) throw new Error(`role profile selection ${role} -> ${profileId}: profile not configured`);
      if (profile.role !== role) throw new Error(`role profile selection ${role} -> ${profileId}: profile role is ${profile.role}`);
    }
    this.orchestrator = new Orchestrator(this.store, this.runtime, {
      stateDir: this.stateDir,
      gateCommand: options.gateCommand ?? gateFromEnvironment(),
      profiles: this.profiles,
      enableRelease: options.enableRelease ?? false,
      env: process.env,
      roleSelection: this.roleSelection,
    });
    this.supervisor = new Supervisor(this.store, { profiles: this.profiles });
    this.autoStart = options.autoStart ?? true;
    this.gateCommand = options.gateCommand ?? gateFromEnvironment();
  }

  // External role -> profile selection: the operator's choice wins over the
  // built-in role default and over per-task profileId choices made by the manager.
  roleProfile(role: string): ProfileManifest {
    const selectedId = this.roleSelection[role as keyof RoleProfileSelection];
    // Default resolution: a profile named after the role, otherwise the first
    // profile of that role (profiles are operator-provided, not built-ins).
    const profile =
      (selectedId ? this.profiles[selectedId] : undefined) ??
      this.profiles[role] ??
      Object.values(this.profiles).find((candidate) => candidate.role === role);
    if (!profile) throw new Error(`profile not configured: ${role}`);
    return profile;
  }

  async submit(repoPath: string, prompt: string, plan?: PlanSpec, suppliedArchitecture?: ArchitectureDraft): Promise<Submission> {
    const repo = resolve(repoPath);
    if (this.autoStart) await this.ensureToolchain();
    let effectivePlan = plan;
    let architectureDraft: ArchitectureDraft | null = suppliedArchitecture ?? null;
    let architectureRun: any = null;
    let planningRun: any = null;
    if (this.autoStart) {
      const architectProfile = this.roleProfile("architect");
      const architectPrompt = [
        "You are the architecture agent for loom-and-order.",
        "Inspect the repository without editing it. Define the architecture, interfaces, invariants, constraints, and task boundaries for the requested initiative.",
        "Return only JSON matching {summary:string,decisions:string[],constraints:string[],invariants:string[],interfaces:string[],taskGuidance:string[],executionPlan:{tasks:[{alias,title,objective,produces:string[],deliverables:string[],requiredArtifacts:string[],prerequisites:string[],dependsOn:string[],verification:string[]}],integrationOrder:string[],preflightChecks:string[],repairPolicy:string}}. The executionPlan is for the runner: define task boundaries, repository-relative output paths, human-readable deliverables, pre-existing input artifacts, human/toolchain prerequisites, dependency aliases, integration order, preflight checks, and the repair policy. `produces` and `requiredArtifacts` must contain only repository-relative paths. `produces` lists files/directories created or materially changed by the task; each output path must have exactly one producer across the whole executionPlan. If a later task needs to update an existing file, assign ownership to one task and keep the later change within that task boundary rather than declaring a second producer. `requiredArtifacts` lists inputs that already exist before the task starts. Put prose descriptions in `deliverables` and text such as runtime versions or policies in `prerequisites`. For a first-layer task that creates its own files, requiredArtifacts must be []. Never use a free-text prerequisite or deliverable as a file path. Example: produces:[\"src/model.py\"], deliverables:[\"Immutable model\"], requiredArtifacts:[], prerequisites:[\"Python 3.10+\"]. Do not return markdown, prompts, reasoning, credentials, or raw tool output.",
        architectProfile.rolePrompt ?? "",
        `User request:\n${prompt}`,
      ].join("\n\n");
      let architectSessionId: string | undefined;
      let architectFeedback = "";
      let architectFeedbackTurns = 0;
      for (let attempt = 1; attempt <= architectProfile.maxAttempts; attempt += 1) {
        let terminalFailureRecorded = false;
        const continueSession = Boolean(architectSessionId && architectFeedbackTurns === 0 && attempt > 1);
        try {
          const designed = await this.orchestrator.runAgent({
            role: "architect",
            profile: architectProfile,
            cwd: repo,
            prompt: [architectPrompt, architectFeedback].filter(Boolean).join("\n\n"),
            runId: `architecture-${Date.now()}-${attempt}`,
            ...(continueSession ? { sessionId: architectSessionId, continueSession: true } : {}),
            agentId: `architect-${repo.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-64)}`,
          });
          architectureRun = designed;
          if (designed.ok) architectSessionId = architectSessionId ?? designed.sessionId ?? designed.runId;
          architectureDraft = designed.ok ? parseArchitectureContract(designed.output) : null;
          if (architectureDraft?.version === 2 && architectureDraft.executionPlan) break;
          architectureDraft = null;
          if (designed.ok && attempt < architectProfile.maxAttempts) {
            architectFeedback = "Your previous response did not pass the architecture contract validator. Continue in this same conversation, return only the corrected JSON contract, and ensure every executionPlan task has alias, title, objective, produces, deliverables, requiredArtifacts, prerequisites, dependsOn, and verification arrays; artifact arrays must contain paths only, and a task must not require one of its own produced paths.";
            if (continueSession) architectFeedbackTurns += 1;
          }
          if (attempt === architectProfile.maxAttempts) {
            const kind = providerFailure(designed) ? "provider_transport" : designed.ok ? "invalid_architecture_output" : "architect_failure";
            const reason = kind === "provider_transport" ? "architect provider transport/auth failure" : designed.ok ? "architect returned no valid architecture contract" : `architect failed (exit ${designed.exitCode})`;
            this.store.recordSystemFailure({ role: "architect", kind, attempt, runId: designed.runId, reason });
            terminalFailureRecorded = true;
            throw new Error(`${reason}; no plan was persisted`);
          }
        } catch (error) {
          if (attempt === architectProfile.maxAttempts) {
            if (!terminalFailureRecorded) this.store.recordSystemFailure({ role: "architect", kind: "planning_exception", attempt, reason: "architect planning raised an exception" });
            throw error;
          }
        }
      }
    }
    if (!effectivePlan) {
      const managerPrompt = [
        "You are the planning manager for loom-and-order.",
        "You are responsible only for turning the architecture contract and user request into a strict JSON DAG and launching/routing agents. Do not implement code or author architecture.",
        "Inspect the repository without editing it. Turn the user's request into a strict JSON plan with initiative title, epics, tasks, optional subtasks, explicit dependencies, and testable acceptanceCriteria.",
        "Keep tasks bounded enough for one worker. Every task must include architectureAlias matching an executionPlan task alias. Preserve all Architect dependencies in dependsOn; a task that requires an artifact produced by another task must depend on its producer. Do not include markdown or commentary; return only JSON matching {title,summary?,epics:[{title,description?,tasks:[{architectureAlias,title,description?,dependsOn?,acceptanceCriteria:string[],profileId?:string,subtasks?:[]}]}]}.",
        this.roleProfile("manager").rolePrompt ?? "",
        `Architecture contract draft:\n${JSON.stringify(architectureDraft)}`,
        `User request:\n${prompt}`,
      ].join("\n\n");
      let managerSessionId: string | undefined;
      let managerFeedback = "";
      let managerFeedbackTurns = 0;
      for (let attempt = 1; attempt <= this.roleProfile("manager").maxAttempts; attempt += 1) {
        let terminalFailureRecorded = false;
        const continueSession = Boolean(managerSessionId && managerFeedbackTurns === 0 && attempt > 1);
        try {
          const planned = await this.orchestrator.runAgent({
            role: "manager",
            profile: this.roleProfile("manager"),
            cwd: repo,
            prompt: [managerPrompt, managerFeedback].filter(Boolean).join("\n\n"),
            runId: `planning-${Date.now()}-${attempt}`,
            ...(continueSession ? { sessionId: managerSessionId, continueSession: true } : {}),
            agentId: `manager-planning-${repo.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-64)}`,
          });
          planningRun = planned;
          if (planned.ok) managerSessionId = managerSessionId ?? planned.sessionId ?? planned.runId;
          const candidate = planned.ok ? parsePlan(planned.output) as PlanSpec | null : null;
          try {
            effectivePlan = candidate ? applyArchitectureExecutionPlan(candidate, architectureDraft?.executionPlan) as PlanSpec : null;
          } catch {
            effectivePlan = null;
          }
          if (effectivePlan) break;
          if (planned.ok && attempt < this.roleProfile("manager").maxAttempts) {
            managerFeedback = "Your previous response did not pass the plan/DAG validator. Continue in this same conversation, return only corrected JSON, preserve architectureAlias values, remove unknown dependencies, and eliminate cycles.";
            if (continueSession) managerFeedbackTurns += 1;
          }
          if (attempt === this.roleProfile("manager").maxAttempts) {
            const kind = providerFailure(planned) ? "provider_transport" : planned.ok ? "invalid_manager_output" : "manager_failure";
            const reason = kind === "provider_transport" ? "manager provider transport/auth failure" : planned.ok ? "manager returned no valid JSON plan" : `manager planning failed (exit ${planned.exitCode})`;
            this.store.recordSystemFailure({ role: "manager", kind, attempt, runId: planned.runId, reason });
            terminalFailureRecorded = true;
            throw new Error(`${reason}; no plan was persisted`);
          }
        } catch (error) {
          if (attempt === this.roleProfile("manager").maxAttempts) {
            if (!terminalFailureRecorded) this.store.recordSystemFailure({ role: "manager", kind: "planning_exception", attempt, reason: "manager planning raised an exception" });
            throw error;
          }
        }
      }
    }
    this.validatePlanProfiles(effectivePlan ?? defaultPlan(prompt) as PlanSpec);
    const submission = this.orchestrator.submit(repo, prompt, effectivePlan ?? defaultPlan(prompt) as PlanSpec);
    if (architectureDraft) {
      const architectProfile = this.roleProfile("architect");
      this.store.saveArchitectureContract({
        ...architectureDraft,
        revision: 1,
        initiativeId: submission.initiativeId,
        author: { role: "architect", profileId: architectProfile.id, model: architectProfile.model ?? "unknown" },
        createdAt: new Date().toISOString(),
      });
      if (architectureRun) {
        this.store.recordMetric({
          initiativeId: submission.initiativeId,
          runId: architectureRun.runId,
          role: "architect",
          outcome: architectureRun.ok ? "success" : architectureRun.raw.timedOut ? "timeout" : "failure",
          durationMs: Number(architectureRun.raw.durationMs ?? 0),
          counters: runtimeCounters(architectureRun.raw, architectProfile),
          dimensions: profileDimensions(architectProfile, process.env),
        });
      }
    } else if (!this.autoStart) {
      this.store.recordEvent(submission.initiativeId, "architecture_contract_missing", {
        reason: "plan was submitted without a persisted ArchitectureExecutionPlan; run requires explicit architecture metadata",
      });
    }
    if (planningRun) {
      this.store.recordMetric({
        initiativeId: submission.initiativeId,
        runId: planningRun.runId,
        role: "manager",
        outcome: planningRun.ok ? "success" : planningRun.raw.timedOut ? "timeout" : "failure",
        durationMs: Number(planningRun.raw.durationMs ?? 0),
        counters: runtimeCounters(planningRun.raw, this.roleProfile("manager")),
        dimensions: profileDimensions(this.roleProfile("manager"), process.env),
      });
    }
    if (this.autoStart) await this.startDetached(submission.initiativeId);
    return submission;
  }

  async run(initiativeId: string): Promise<any> {
    await this.ensureToolchain();
    const contract = this.store.getArchitectureContract(initiativeId);
    if (!contract || contract.version !== 2 || !contract.executionPlan) {
      this.store.recordEvent(initiativeId, "architecture_preflight_failed", {
        reason: "version-2 ArchitectureExecutionPlan is required before run",
        hasContract: Boolean(contract),
        contractVersion: contract?.version ?? null,
      });
      throw new Error("cannot run initiative without a persisted version-2 ArchitectureExecutionPlan");
    }
    const owner = `run-${process.pid}-${randomUUID()}`;
    this.store.acquireInitiativeRun(initiativeId, owner);
    try {
      this.supervisor.start();
      return await this.orchestrator.runInitiative(initiativeId);
    } finally {
      this.supervisor.stop();
      this.store.releaseInitiativeRun(initiativeId, owner);
    }
  }

  superviseOnce(): any {
    return this.supervisor.runOnce();
  }

  supervisorStatus(): any {
    return this.supervisor.status();
  }

  toolchainStatus(): ToolchainStatus | null {
    return this.toolchain.status();
  }

  async updateToolchain(): Promise<ToolchainStatus> {
    return this.toolchain.update();
  }

  agents(initiativeId?: string): any[] {
    return this.store.listAgents(initiativeId);
  }

  agentSessions(initiativeId?: string, state?: string): any[] {
    return this.store.listAgentSessions(initiativeId, state);
  }

  feed(initiativeId?: string, afterId = 0, limit = 100): any[] {
    return this.store.eventsSince(afterId, initiativeId, limit);
  }

  listProfiles(): Array<Record<string, unknown>> {
    return Object.values(this.profiles).map((profile) => ({ id: profile.id, role: profile.role, pool: profile.pool ?? null, model: profile.model ?? null, thinkingLevel: profile.thinkingLevel ?? null, custom: profile.id.endsWith("-custom") || this.customProfileStore.get(profile.id) !== null }));
  }

  validateProfile(profile: ProfileManifest): ProfileManifest {
    validateProfileManifest(profile);
    return profile;
  }

  saveCustomProfile(profile: ProfileManifest, overwrite = false): ProfileManifest {
    validateProfileManifest(profile);
    if (this.profiles[profile.id] && this.customProfileStore.get(profile.id) === null) throw new Error(`cannot overwrite built-in profile: ${profile.id}`);
    const saved = this.customProfileStore.save(profile, overwrite);
    const normalized = normalizeProfile(saved, this.projectRoot);
    this.profiles[normalized.id] = normalized;
    return normalized;
  }

  cloneProfile(sourceId: string, targetId: string, overrides: Partial<ProfileManifest> = {}): ProfileManifest {
    const source = this.profiles[sourceId];
    if (!source) throw new Error(`unknown profile: ${sourceId}`);
    if (this.profiles[targetId]) throw new Error(`profile already exists: ${targetId}`);
    const cloned = this.customProfileStore.clone(source, targetId, overrides);
    return this.saveCustomProfile(cloned);
  }

  createAgentProfile(agentId: string, profileId?: string, overrides: Partial<ProfileManifest> = {}, overwrite = false): { agent: AgentRecord; profile: ProfileManifest; path: string; created: boolean } {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    const source = this.profiles[agent.profileId] ?? this.profiles[agent.role];
    if (!source) throw new Error(`unknown source profile for agent ${agentId}: ${agent.profileId}`);
    const derivedId = agentId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56);
    const id = profileId ?? `agent-${derivedId}`;
    if (id === "agent-") throw new Error(`cannot derive profile id from agent: ${agentId}`);
    const existing = this.customProfileStore.get(id);
    if (existing && !overwrite && agent.profileId !== id) throw new Error(`profile already exists: ${id}`);
    const agentPool = agent.pool === "local" || agent.pool === "codex" ? agent.pool : undefined;
    const profile = this.customProfileStore.clone(source, id, {
      ...overrides,
      role: agent.role as ProfileManifest["role"],
      model: overrides.model ?? agent.model ?? source.model,
      pool: overrides.pool ?? agentPool ?? source.pool,
    });
    const saved = existing && !overwrite ? existing : this.saveCustomProfile(profile, overwrite);
    const linkedAgent = this.store.setAgentProfile(agentId, saved.id, saved.model, saved.pool);
    return { agent: linkedAgent, profile: saved, path: this.customProfileStore.pathFor(saved.id), created: !existing };
  }

  tree(initiativeId: string): any[] {
    return this.store.listNodes(initiativeId);
  }

  status(nodeId: string): any {
    const node = this.store.getNode(nodeId);
    if (!node) throw new Error(`unknown node ${nodeId}`);
    return node.level === "initiative" ? this.progress(nodeId) : node;
  }

  progress(initiativeId: string): any {
    const initiative = this.store.getNode(initiativeId);
    if (!initiative || initiative.level !== "initiative") throw new Error(`unknown initiative ${initiativeId}`);
    this.store.unblockWaiting(initiativeId);
    this.store.refreshReady(initiativeId);
    this.store.refreshRollups(initiativeId);
    const currentInitiative = this.store.getNode(initiativeId)!;
    const nodes = this.store.listNodes(initiativeId);
    const tasks = nodes.filter((node) => ["task", "subtask"].includes(node.level));
    const epics = nodes.filter((node) => node.level === "epic");
    const counts = (items: typeof nodes): Record<string, number> => Object.fromEntries(items.reduce((map, item) => map.set(item.status, (map.get(item.status) ?? 0) + 1), new Map<string, number>()));
    return {
      initiative: { id: currentInitiative.id, title: currentInitiative.title, status: currentInitiative.status, createdAt: currentInitiative.createdAt, updatedAt: currentInitiative.updatedAt },
      tasks: { total: tasks.length, byStatus: counts(tasks) },
      epics: { total: epics.length, byStatus: counts(epics) },
      blockers: nodes.filter((node) => ["blocked", "failed", "waiting", "recovering", "waiting_dependency", "waiting_external", "waiting_approval", "needs_manager", "needs_architect", "needs_operator"].includes(node.status)).map((node) => ({ id: node.id, level: node.level, title: node.title, status: node.status, reason: node.failure, owner: node.recoveryOwner, scope: node.recoveryScope, requiredAction: node.requiredAction, unblockCondition: node.unblockCondition, recoveryEpoch: node.recoveryEpoch })),
      activeSessions: this.store.listAgentSessions(initiativeId, "running").length,
      metrics: this.store.metricSummary(initiativeId),
    };
  }

  architectureContract(initiativeId: string, revision?: number): any {
    if (!this.store.getNode(initiativeId)) throw new Error(`unknown initiative ${initiativeId}`);
    return this.store.getArchitectureContract(initiativeId, revision);
  }

  architectureContracts(initiativeId: string): any[] {
    if (!this.store.getNode(initiativeId)) throw new Error(`unknown initiative ${initiativeId}`);
    return this.store.listArchitectureContracts(initiativeId);
  }

  saveArchitectureContract(contract: ArchitectureContract, supersessionReason?: string): any {
    return this.store.saveArchitectureContract(contract, supersessionReason);
  }

  message(initiativeId: string, body: string): number {
    const initiative = this.store.getNode(initiativeId);
    if (!initiative) throw new Error(`unknown initiative ${initiativeId}`);
    const messageId = this.store.addMessage(initiativeId, body);
    if (["blocked", "failed", "waiting"].includes(initiative.status)) {
      this.store.transition(initiativeId, "running", { reason: "external guidance reopened manager checkpoint" });
      void Promise.resolve(this.startDetached(initiativeId)).catch(() => undefined);
    }
    return messageId;
  }

  planEdit(initiativeId: string, patch: { nodeId: string; title?: string; description?: string; acceptanceCriteria?: string[]; dependsOn?: string[]; profileId?: string | null }): any {
    this.validateEditProfile(patch.profileId);
    return this.store.applyPlanEdit(initiativeId, patch);
  }

  private validateEditProfile(profileId: string | null | undefined): void {
    if (!profileId) return;
    const profile = this.profiles[profileId];
    if (!profile) throw new Error(`unknown profile in plan edit: ${profileId}`);
    if (profile.role === "release" && !this.orchestrator.options.enableRelease) throw new Error("release profile is inactive by default; enable explicit release scheduling first");
  }

  pause(initiativeId: string): void {
    this.store.pauseInitiative(initiativeId);
  }

  resume(nodeId: string): void {
    const target = this.store.getNode(nodeId);
    if (!target) throw new Error(`unknown node ${nodeId}`);
    if (target.level !== "initiative") {
      const recoverable = ["blocked", "waiting", "recovering", "waiting_dependency", "waiting_external", "waiting_approval", "needs_manager", "needs_architect", "needs_operator"].includes(target.status);
      if (!recoverable) throw new Error(`node ${nodeId} is not waiting for recovery`);
      this.store.transition(nodeId, "pending", { reason: "explicit task resume requested" });
      this.store.unblockWaiting(target.initiativeId);
      this.store.refreshReady(target.initiativeId);
      this.store.refreshRollups(target.initiativeId);
      if (this.autoStart) void Promise.resolve(this.startDetached(target.initiativeId)).catch(() => undefined);
      return;
    }
    const initiative = target;
    const nodes = this.store.listNodes(initiative.id);
    if (["blocked", "failed"].includes(initiative.status)) {
      const blocked = nodes.filter((node) => ["blocked", "failed"].includes(node.status) && ["task", "subtask"].includes(node.level));
      // Structured classification: auto-resume is safe only for environment/scheduler
      // failures whose state was already reset for a retry (integration recovery sets
      // a recoveryFingerprint; supervisor exhaustion is marked recoveryOwner=supervisor).
      // Domain failures (worker output, reviewer verdicts, gates) carry neither marker
      // and would just repeat.
      const unsafe = blocked.filter((node) => !node.recoveryFingerprint && node.recoveryOwner !== "supervisor");
      if (unsafe.length) throw new Error(`initiative has non-resumable blockers: ${unsafe.map((node) => node.id).join(", ")}`);
      for (const node of blocked) this.store.transition(node.id, "pending", { reason: "explicit resume requested" });
      this.store.transition(initiative.id, "running", { reason: "explicit resume requested" });
      this.store.refreshReady(initiative.id);
    } else if (initiative.status === "waiting") {
      this.store.transition(initiative.id, "running", { reason: "explicit resume requested" });
      this.store.refreshReady(initiative.id);
    } else {
      this.store.resumeInitiative(initiative.id);
    }
    if (this.autoStart) void Promise.resolve(this.startDetached(initiative.id)).catch(() => undefined);
  }

  recover(): string[] {
    const report = this.supervisor.runOnce();
    for (const nodeId of report.recovered) {
      const node = this.store.getNode(nodeId);
      if (node) this.store.recordMetric({ initiativeId: node.initiativeId, nodeId, runId: `recovery-${nodeId}-${Date.now()}`, role: "scheduler", outcome: "recovery", durationMs: 0, dimensions: { status: "supervisor_recovery" } });
    }
    return report.recovered;
  }

  /**
   * Deliver a completed initiative to the target repository without touching
   * the operator's working tree: a throwaway worktree carries a
   * `loom-and-order/deliver-<initiative>` branch that merges every completed
   * epic branch (in dependency order) on top of the target's current HEAD,
   * then passes the repository gate. Re-running rebuilds the branch from
   * scratch (idempotent). The operator reviews and merges the branch
   * themselves.
   */
  async deliver(initiativeId: string): Promise<any> {
    const initiative = this.store.getNode(initiativeId);
    if (!initiative) throw new Error(`unknown initiative: ${initiativeId}`);
    if (initiative.status !== "completed") throw new Error(`initiative is ${initiative.status}; deliver requires a completed initiative`);
    const git = this.git();
    const repoPath = initiative.repoPath!;
    git.assertRepository(repoPath);
    const epics = this.store.listNodes(initiativeId).filter((node) => node.level === "epic");
    const missing = epics.filter((epic) => epic.status !== "completed" || !epic.branch);
    if (missing.length) throw new Error(`cannot deliver: epic(s) without completed branch: ${missing.map((epic) => epic.id).join(", ")}`);
    const ordered = topologicalOrder(epics.map((epic) => ({ id: epic.id, dependsOn: epic.dependsOn })));
    const branch = `loom-and-order/deliver-${initiativeId}`;
    const worktree = join(this.stateDir, "worktrees", initiativeId, "deliver");
    const base = git.head(repoPath);
    // Idempotent rebuild: remove any previous deliver attempt.
    if (git.branchExists(repoPath, branch)) {
      try { git.removeWorktree(repoPath, worktree); } catch { /* already gone */ }
      git.deleteBranch(repoPath, branch);
    }
    git.createWorktree(repoPath, branch, worktree, base);
    git.ensureDependencies(worktree);
    const merges: Array<{ epicId: string; branch: string; mergeCommit: string }> = [];
    try {
      for (const epicId of ordered) {
        const epic = this.store.getNode(epicId)!;
        merges.push({ epicId, branch: epic.branch!, mergeCommit: git.merge(worktree, epic.branch!) });
      }
    } catch (error) {
      git.removeWorktree(repoPath, worktree);
      this.store.recordEvent(initiativeId, "deliver_failed", { branch, reason: String(error) });
      throw new Error(`deliver merge failed: ${String(error)}`);
    }
    const gate = await git.runGate(worktree, this.gateCommand);
    git.removeWorktree(repoPath, worktree);
    if (!gate.ok) {
      this.store.recordEvent(initiativeId, "deliver_failed", { branch, reason: "repository gate failed on the delivered tree" });
      throw new Error(`deliver gate failed on the delivered tree (branch ${branch} kept for inspection): ${gate.output.slice(-2000)}`);
    }
    const deliverHead = git.branchHead(repoPath, branch);
    this.store.recordEvent(initiativeId, "deliver_completed", { branch, commit: deliverHead, base, epics: merges, gate: { ok: true, durationMs: gate.durationMs } });
    return { branch, commit: deliverHead, base, epics: merges, gate: { ok: true, output: gate.output.slice(-4000), durationMs: gate.durationMs }, next: `git merge ${branch}` };
  }

  /**
   * Garbage-collect worktrees of terminal nodes. Task/subtask worktrees are
   * removed when their node is completed or failed; merged task branches are
   * deleted, unmerged ones are kept for forensics. Epic worktrees are only
   * removed with `includeEpics` and only for completed epics (their branches
   * are always kept: `deliver` needs them). Dry-run reports without acting.
   */
  prune(options: { initiativeId?: string; all?: boolean; includeEpics?: boolean; dryRun?: boolean } = {}): any {
    if (!options.initiativeId && !options.all) throw new Error("prune requires an initiative id or --all");
    const git = this.git();
    const initiatives = options.all
      ? this.store.listInitiatives()
      : [this.store.getNode(options.initiativeId!)].filter((node): node is NonNullable<typeof node> => Boolean(node));
    if (!initiatives.length) throw new Error(`unknown initiative: ${options.initiativeId ?? ""}`);
    const report: Array<{ nodeId: string; level: string; status: string; action: string; detail: string }> = [];
    for (const initiative of initiatives) {
      const nodes = this.store.listNodes(initiative.id);
      const work = nodes.filter((node) => ["task", "subtask"].includes(node.level));
      for (const node of work) {
        if (!["completed", "failed"].includes(node.status)) {
          if (node.worktreePath) report.push({ nodeId: node.id, level: node.level, status: node.status, action: "skipped", detail: "node is not terminal" });
          continue;
        }
        if (!node.worktreePath && !node.branch) continue;
        const merged = node.branch ? git.isAncestor(this.store.getNode(node.parentId ?? node.id)!.worktreePath ?? initiative.repoPath!, node.branch) : false;
        const actions: string[] = [];
        if (node.worktreePath) {
          if (!options.dryRun) {
            try { git.removeWorktree(initiative.repoPath!, node.worktreePath); } catch (error) { throw new Error(`worktree removal failed for ${node.id}: ${String(error)}`); }
            this.store.clearWorktree(node.id);
          }
          actions.push("worktree removed");
        }
        if (node.branch) {
          if (merged) {
            if (!options.dryRun) git.deleteBranch(initiative.repoPath!, node.branch);
            actions.push(`branch deleted (merged into parent: ${node.branch})`);
          } else {
            report.push({ nodeId: node.id, level: node.level, status: node.status, action: "branch-kept", detail: `unmerged branch ${node.branch} kept for forensics` });
          }
        }
        if (actions.length) report.push({ nodeId: node.id, level: node.level, status: node.status, action: options.dryRun ? "would-prune" : "pruned", detail: actions.join("; ") });
      }
      if (options.includeEpics) {
        for (const epic of nodes.filter((node) => node.level === "epic")) {
          if (epic.status !== "completed" || !epic.worktreePath) continue;
          if (!options.dryRun) {
            git.removeWorktree(initiative.repoPath!, epic.worktreePath);
            this.store.clearWorktree(epic.id);
          }
          report.push({ nodeId: epic.id, level: epic.level, status: epic.status, action: options.dryRun ? "would-prune" : "pruned", detail: `epic worktree removed; branch ${epic.branch} kept for deliver` });
        }
      }
    }
    return { dryRun: options.dryRun ?? false, actions: report };
  }

  logs(nodeId?: string): any[] {
    return this.store.events(nodeId);
  }

  recentEvents(limit: number): EventRecord[] {
    return this.store.recentEvents(limit);
  }

  metrics(initiativeId: string): any {
    return this.store.metricSummary(initiativeId);
  }

  prometheus(initiativeId: string): string {
    return prometheus(this.store.metricSummary(initiativeId));
  }

  close(): void {
    this.supervisor.stop();
    this.store.close();
  }

  private validatePlanProfiles(plan: PlanSpec): void {
    const check = (node: { profileId?: string; subtasks?: Array<{ profileId?: string; subtasks?: any[] }> }): void => {
      if (node.profileId && !this.profiles[node.profileId]) throw new Error(`unknown profile in plan: ${node.profileId}`);
      if (node.profileId && this.profiles[node.profileId]?.role === "release" && !this.orchestrator.options.enableRelease) throw new Error("release profile is inactive by default; enable explicit release scheduling first");
      for (const child of node.subtasks ?? []) check(child);
    };
    for (const epic of plan.epics) {
      check(epic);
      for (const task of epic.tasks) {
        check(task);
        for (const subtask of task.subtasks ?? []) check(subtask);
      }
    }
  }

  private async ensureToolchain(): Promise<void> {
    try {
      await this.toolchain.ensureFresh();
    } catch (error) {
      this.store.recordSystemFailure({ role: "scheduler", kind: "toolchain_preflight", attempt: 1, reason: "toolchain preflight failed" });
      throw new Error(`toolchain preflight failed: ${String(error)}`);
    }
  }

  private async startDetached(initiativeId: string): Promise<void> {
    const entry = process.argv[1] ? resolve(process.argv[1]) : "";
    if (!entry || !existsSync(entry)) throw new Error("cannot locate CLI entry point for detached runtime");
    await new Promise<void>((resolvePromise, reject) => {
      const invocation = detachedRunInvocation(entry, initiativeId, this.stateDir);
      const child = spawn(invocation.command, invocation.args, {
        cwd: this.projectRoot,
        detached: true,
        stdio: "ignore",
        env: invocation.env,
      });
      child.once("spawn", () => {
        this.store.recordEvent(initiativeId, "runtime_detached_spawned", { pid: child.pid ?? null, entry });
        child.unref();
        resolvePromise();
      });
      child.once("error", (error) => {
        this.store.recordEvent(initiativeId, "runtime_detached_failed", { reason: "detached runtime process failed to start" });
        reject(new Error(`detached runtime failed to start: ${String(error)}`));
      });
    });
  }
}
