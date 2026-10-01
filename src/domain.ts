import { randomUUID } from "node:crypto";

export type Level = "initiative" | "epic" | "task" | "subtask";
export type NodeStatus =
  | "draft"
  | "pending"
  | "ready"
  | "leased"
  | "running"
  | "reviewing"
  | "integrating"
  | "paused"
  | "waiting"
  | "recovering"
  | "waiting_dependency"
  | "waiting_external"
  | "waiting_approval"
  | "needs_manager"
  | "needs_architect"
  | "needs_operator"
  | "completed"
  | "blocked"
  | "failed";

export type Role = "manager" | "worker" | "reviewer" | "researcher" | "architect" | "release";
export type AgentStatus = "idle" | "running" | "recovering" | "blocked" | "retired";
export type AgentSessionState = "running" | "completed" | "failed" | "interrupted";
export type RecoveryOwner = "worker" | "manager" | "architect" | "reviewer" | "researcher" | "scheduler" | "operator" | "user";
export type RecoveryScope = "task" | "subtask" | "epic" | "initiative";

export interface RecoveryMetadata {
  owner: RecoveryOwner | string | null;
  scope: RecoveryScope | null;
  requiredAction: string | null;
  unblockCondition: string | null;
  epoch: number;
  fingerprint: string | null;
}

export interface AgentRecord {
  id: string;
  initiativeId: string | null;
  nodeId: string | null;
  role: Role | string;
  profileId: string;
  model: string | null;
  pool: string | null;
  status: AgentStatus;
  currentSessionId: string | null;
  currentNodeId: string | null;
  lastHeartbeat: string | null;
  runCount: number;
  successCount: number;
  failureCount: number;
  handoffSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSessionRecord {
  id: string;
  agentId: string;
  initiativeId: string | null;
  nodeId: string | null;
  role: Role | string;
  profileId: string;
  model: string | null;
  runId: string;
  attemptNo: number;
  pid: number | null;
  state: AgentSessionState;
  startedAt: string;
  lastHeartbeat: string;
  endedAt: string | null;
  exitCode: number | null;
  error: string | null;
  handoffSummary: string | null;
}

export interface PlanNodeSpec {
  id?: string;
  architectureAlias?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  profileId?: string;
  subtasks?: PlanNodeSpec[];
}

export interface EpicSpec extends PlanNodeSpec {
  tasks: PlanNodeSpec[];
}

export interface PlanSpec {
  title: string;
  summary?: string;
  epics: EpicSpec[];
}

export interface ArchitectureTaskPlan {
  alias: string;
  title: string;
  objective: string;
  /** Repository-relative files/directories created or materially changed by this task. */
  produces: string[];
  /** Human-readable outcomes; never used for dependency inference or preflight. */
  deliverables: string[];
  /** Repository-relative files/directories that must already exist before this task starts. */
  requiredArtifacts: string[];
  /** Human/toolchain prerequisites; never interpreted as filesystem paths. */
  prerequisites: string[];
  dependsOn: string[];
  verification: string[];
}

export function isRepositoryRelativePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim().replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split(/[\\/]+/).some((part) => !part || part === "." || part === "..")) return false;
  return normalized.split(/[\\/]+/).every((part) => /^[a-zA-Z0-9._-]+$/.test(part));
}

export interface ArchitectureExecutionPlan {
  tasks: ArchitectureTaskPlan[];
  integrationOrder: string[];
  preflightChecks: string[];
  repairPolicy: string;
}

export interface ArchitectureContract {
  version: number;
  revision: number;
  initiativeId: string;
  author: {
    role: "architect";
    profileId: string;
    model: string;
  };
  createdAt: string;
  summary: string;
  decisions: string[];
  constraints: string[];
  invariants: string[];
  interfaces: string[];
  taskGuidance: string[];
  executionPlan?: ArchitectureExecutionPlan;
}

export interface ArchitectureContractRecord extends ArchitectureContract {
  id: string;
  supersedesRevision: number | null;
  supersessionReason: string | null;
}

export function validateArchitectureContract(value: unknown): asserts value is ArchitectureContract {
  if (!value || typeof value !== "object") throw new Error("architecture contract must be an object");
  const contract = value as Partial<ArchitectureContract>;
  if (![1, 2].includes(contract.version ?? 0) || !Number.isInteger(contract.revision) || contract.revision < 1) throw new Error("architecture contract version or revision is invalid");
  if (typeof contract.initiativeId !== "string" || !contract.initiativeId) throw new Error("architecture contract initiativeId is required");
  if (typeof contract.createdAt !== "string" || !contract.createdAt) throw new Error("architecture contract createdAt is required");
  if (typeof contract.summary !== "string" || !contract.summary) throw new Error("architecture contract summary is required");
  if (!contract.author || contract.author.role !== "architect" || typeof contract.author.profileId !== "string" || typeof contract.author.model !== "string") {
    throw new Error("architecture contract author is invalid");
  }
  for (const field of ["decisions", "constraints", "invariants", "interfaces", "taskGuidance"] as const) {
    if (!Array.isArray(contract[field]) || contract[field].some((item) => typeof item !== "string" || !item.trim())) throw new Error(`architecture contract ${field} must contain non-empty strings`);
  }
  if (contract.version === 2) {
    const plan = contract.executionPlan;
    if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0 || !Array.isArray(plan.integrationOrder) || !Array.isArray(plan.preflightChecks) || plan.integrationOrder.some((item) => typeof item !== "string" || !item.trim()) || plan.preflightChecks.some((item) => typeof item !== "string" || !item.trim()) || typeof plan.repairPolicy !== "string" || !plan.repairPolicy.trim()) {
      throw new Error("architecture contract executionPlan is required for version 2");
    }
    const aliases = new Set<string>();
    const producedArtifacts = new Set<string>();
    for (const task of plan.tasks) {
      if (!task || typeof task.alias !== "string" || !task.alias.trim() || aliases.has(task.alias.trim()) || typeof task.title !== "string" || !task.title.trim() || typeof task.objective !== "string" || !task.objective.trim()) throw new Error("architecture task plan identity is invalid");
      aliases.add(task.alias.trim());
      for (const field of ["produces", "deliverables", "requiredArtifacts", "prerequisites", "dependsOn", "verification"] as const) {
        if (!Array.isArray(task[field]) || task[field].some((item) => typeof item !== "string" || !item.trim())) throw new Error(`architecture task plan ${field} is invalid`);
      }
      for (const field of ["produces", "requiredArtifacts"] as const) {
        if (task[field].some((item) => !isRepositoryRelativePath(item))) throw new Error(`architecture task plan ${field} must contain repository-relative paths only`);
      }
      for (const artifact of task.produces) {
        const key = artifact.trim().replace(/^\.\//, "");
        if (producedArtifacts.has(key)) throw new Error(`architecture task plan has multiple producers for ${artifact}`);
        producedArtifacts.add(key);
      }
      if (task.requiredArtifacts.some((artifact) => task.produces.includes(artifact))) throw new Error(`architecture task plan ${task.alias} cannot require an artifact it produces`);
    }
    if (plan.integrationOrder.length !== aliases.size || new Set(plan.integrationOrder).size !== aliases.size || plan.integrationOrder.some((alias) => !aliases.has(alias))) throw new Error("architecture integrationOrder must contain every task alias exactly once");
    for (const task of plan.tasks) if (task.dependsOn.some((alias) => !aliases.has(alias))) throw new Error("architecture task dependency alias is unknown");
  }
}

export interface NodeRecord {
  id: string;
  initiativeId: string;
  parentId: string | null;
  level: Level;
  title: string;
  architectureAlias?: string | null;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  profileId: string | null;
  status: NodeStatus;
  repoPath: string | null;
  baseCommit: string | null;
  branch: string | null;
  worktreePath: string | null;
  integratedCommit: string | null;
  generation: number;
  attempt: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  failure: string | null;
  recoveryOwner: RecoveryOwner | string | null;
  recoveryScope: RecoveryScope | null;
  requiredAction: string | null;
  unblockCondition: string | null;
  recoveryEpoch: number;
  recoveryFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventRecord {
  id: number;
  nodeId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ReviewVerdict {
  taskId: string;
  verdict: "pass" | "fail";
  findings: string[];
  evidence: Record<string, unknown>;
  createdAt: string;
}

export const TERMINAL_STATUSES = new Set<NodeStatus>(["completed", "blocked", "failed"]);
export const RECOVERY_STATUSES = new Set<NodeStatus>(["waiting", "recovering", "waiting_dependency", "waiting_external", "waiting_approval", "needs_manager", "needs_architect", "needs_operator", "blocked"]);
const RECOVERY_TARGETS: NodeStatus[] = ["waiting", "recovering", "waiting_dependency", "waiting_external", "waiting_approval", "needs_manager", "needs_architect", "needs_operator", "blocked"];

const TRANSITIONS: Record<NodeStatus, Set<NodeStatus>> = {
  draft: new Set<NodeStatus>(["pending", "running", "paused", ...RECOVERY_TARGETS]),
  pending: new Set<NodeStatus>(["ready", "paused", ...RECOVERY_TARGETS]),
  ready: new Set<NodeStatus>(["leased", "paused", ...RECOVERY_TARGETS]),
  leased: new Set<NodeStatus>(["running", "ready", "paused", ...RECOVERY_TARGETS]),
  running: new Set<NodeStatus>(["reviewing", "pending", "paused", "failed", "completed", ...RECOVERY_TARGETS]),
  reviewing: new Set<NodeStatus>(["integrating", "running", "pending", "paused", "failed", ...RECOVERY_TARGETS]),
  integrating: new Set<NodeStatus>(["completed", "pending", "paused", "failed", ...RECOVERY_TARGETS]),
  paused: new Set<NodeStatus>(["pending", "ready", ...RECOVERY_TARGETS]),
  waiting: new Set<NodeStatus>(["pending", "ready", "running", ...RECOVERY_TARGETS]),
  recovering: new Set<NodeStatus>(["pending", "ready", "running", ...RECOVERY_TARGETS, "failed"]),
  waiting_dependency: new Set<NodeStatus>(["pending", "ready", "running", ...RECOVERY_TARGETS]),
  waiting_external: new Set<NodeStatus>(["pending", "ready", "running", ...RECOVERY_TARGETS]),
  waiting_approval: new Set<NodeStatus>(["pending", "ready", "running", ...RECOVERY_TARGETS]),
  needs_manager: new Set<NodeStatus>(["pending", "ready", "running", ...RECOVERY_TARGETS]),
  needs_architect: new Set<NodeStatus>(["pending", "ready", "running", ...RECOVERY_TARGETS]),
  needs_operator: new Set<NodeStatus>(["pending", "ready", "running", ...RECOVERY_TARGETS]),
  completed: new Set(),
  blocked: new Set<NodeStatus>(["pending", "paused", "waiting", "running", ...RECOVERY_TARGETS]),
  failed: new Set<NodeStatus>(["pending", "paused", "waiting", "running", ...RECOVERY_TARGETS]),
};

export function idFor(level: Level): string {
  return `${level}-${randomUUID()}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function assertTransition(from: NodeStatus, to: NodeStatus): void {
  if (!TRANSITIONS[from]?.has(to)) {
    throw new Error(`invalid transition ${from} -> ${to}`);
  }
}

export function assertAcyclic(nodes: Array<{ id: string; dependsOn: string[] }>): void {
  const graph = new Map(nodes.map((node) => [node.id, node.dependsOn]));
  for (const node of nodes) {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`dependency cycle includes ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of graph.get(id) ?? []) {
        if (!graph.has(dependency)) throw new Error(`unknown dependency ${dependency}`);
        visit(dependency);
      }
      visiting.delete(id);
      visited.add(id);
    };
    visit(node.id);
  }
}

export function readyForDependencies(node: NodeRecord, all: NodeRecord[]): boolean {
  return node.dependsOn.every((dependency) => {
    const found = all.find((candidate) => candidate.id === dependency);
    return found?.status === "completed";
  });
}
