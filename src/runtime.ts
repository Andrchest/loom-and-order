import { join } from "node:path";
import { PiLauncher, type PiRunResult } from "./launcher.ts";
import { isRepositoryRelativePath, type ArchitectureContract, type ArchitectureExecutionPlan, type ArchitectureTaskPlan } from "./domain.ts";
import type { AgentRole, ProfileManifest } from "./profiles.ts";

export interface AgentResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
  runId: string;
  sessionId?: string;
  raw: PiRunResult;
}

export interface AgentRuntime {
  run(input: { role: AgentRole; profile: ProfileManifest; cwd: string; prompt: string; runId: string; sessionId?: string; continueSession?: boolean; agentId?: string }): Promise<AgentResult>;
}

export type ArchitectureDraft = Omit<ArchitectureContract, "initiativeId" | "revision" | "author" | "createdAt">;

export class PiAgentRuntime implements AgentRuntime {
  readonly launcher: PiLauncher;

  constructor(stateDir: string, logDir = join(stateDir, "logs"), env: NodeJS.ProcessEnv = process.env) {
    this.launcher = new PiLauncher(stateDir, logDir, env);
  }

  async run(input: { role: AgentRole; profile: ProfileManifest; cwd: string; prompt: string; runId: string; sessionId?: string; continueSession?: boolean; agentId?: string }): Promise<AgentResult> {
    const raw = await this.launcher.run(input);
    return {
      ok: raw.exitCode === 0 && !raw.timedOut && raw.agentEnded,
      output: raw.assistantText,
      exitCode: raw.exitCode,
      runId: raw.runId,
      sessionId: raw.sessionId,
      raw,
    };
  }
}

export function parseJsonObject(text: string): Record<string, any> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(fenced.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function dependencyKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function idSlug(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "item";
}

function canonicalizePlanIds(plan: any): any {
  const aliases = new Map<string, Set<string>>();
  const register = (alias: unknown, id: string): void => {
    if (typeof alias !== "string" || !alias.trim()) return;
    for (const key of [alias.trim(), dependencyKey(alias)]) {
      if (!key) continue;
      const ids = aliases.get(key) ?? new Set<string>();
      ids.add(id);
      aliases.set(key, ids);
    }
  };
  const nodes: any[] = [];
  plan.epics.forEach((epic: any, epicIndex: number) => {
    const epicId = `epic-${epicIndex + 1}-${idSlug(epic.title)}`;
    register(epic.id, epicId); register(epic.title, epicId);
    epic.id = epicId; nodes.push(epic);
    epic.tasks.forEach((task: any, taskIndex: number) => {
      const taskId = `task-${epicIndex + 1}-${taskIndex + 1}-${idSlug(task.title)}`;
      register(task.id, taskId); register(task.title, taskId); register(task.architectureAlias, taskId);
      task.id = taskId; nodes.push(task);
      task.subtasks.forEach((subtask: any, subtaskIndex: number) => {
        const subtaskId = `subtask-${epicIndex + 1}-${taskIndex + 1}-${subtaskIndex + 1}-${idSlug(subtask.title)}`;
        register(subtask.id, subtaskId); register(subtask.title, subtaskId);
        subtask.id = subtaskId; nodes.push(subtask);
      });
    });
  });
  const resolveDependency = (reference: string): string => {
    const ids = aliases.get(reference.trim()) ?? aliases.get(dependencyKey(reference));
    if (!ids?.size) throw new Error(`unknown dependency reference ${reference}`);
    if (ids.size > 1) throw new Error(`ambiguous dependency reference ${reference}`);
    return [...ids][0];
  };
  for (const node of nodes) node.dependsOn = node.dependsOn.map(resolveDependency);
  return plan;
}

export function parseArchitectureContract(text: string): ArchitectureDraft | null {
  const value = parseJsonObject(text);
  const fields = ["decisions", "constraints", "invariants", "interfaces", "taskGuidance"] as const;
  if (!value || typeof value.summary !== "string" || !value.summary.trim() || fields.some((field) => !Array.isArray(value[field]) || value[field].some((item: unknown) => typeof item !== "string" || !item.trim()))) return null;
  const rawPlan = value.executionPlan;
  let executionPlan: ArchitectureExecutionPlan | undefined;
  if (rawPlan !== undefined) {
    if (!rawPlan || !Array.isArray(rawPlan.tasks) || !Array.isArray(rawPlan.integrationOrder) || !Array.isArray(rawPlan.preflightChecks) || typeof rawPlan.repairPolicy !== "string" || !rawPlan.repairPolicy.trim()) return null;
    if (rawPlan.tasks.length === 0 || rawPlan.integrationOrder.some((item: unknown) => typeof item !== "string" || !item.trim()) || rawPlan.preflightChecks.some((item: unknown) => typeof item !== "string" || !item.trim())) return null;
    const tasks: ArchitectureTaskPlan[] = rawPlan.tasks.map((task: any) => ({
      alias: String(task?.alias ?? "").trim(),
      title: String(task?.title ?? "").trim(),
      objective: String(task?.objective ?? "").trim(),
      produces: Array.isArray(task?.produces) ? task.produces.map(String).filter((item: string) => item.trim()) : [],
      deliverables: Array.isArray(task?.deliverables) ? task.deliverables.map(String).filter((item: string) => item.trim()) : [],
      requiredArtifacts: (Array.isArray(task?.requiredArtifacts) ? task.requiredArtifacts : []).map(String).filter((item: string) => item.trim()).concat(
        (Array.isArray(task?.requires) ? task.requires : []).map(String).filter((item: string) => item.trim() && isRepositoryRelativePath(item)),
      ).filter((item: string, index: number, values: string[]) => values.indexOf(item) === index),
      prerequisites: (Array.isArray(task?.prerequisites) ? task.prerequisites : []).map(String).filter((item: string) => item.trim()).concat(
        (Array.isArray(task?.requires) ? task.requires : []).map(String).filter((item: string) => item.trim() && !isRepositoryRelativePath(item)),
      ).filter((item: string, index: number, values: string[]) => values.indexOf(item) === index),
      dependsOn: Array.isArray(task?.dependsOn) ? task.dependsOn.map(String).filter((item: string) => item.trim()) : [],
      verification: Array.isArray(task?.verification) ? task.verification.map(String).filter((item: string) => item.trim()) : [],
    }));
    if (tasks.some((task, index) => {
      const rawTask = rawPlan.tasks[index];
      const legacyRequires = rawTask?.requires;
      const hasStringArray = (field: string): boolean => Array.isArray(rawTask?.[field]) && rawTask[field].every((item: unknown) => typeof item === "string" && item.trim());
      return !task.alias || !task.title || !task.objective || !hasStringArray("produces") || !task.produces.every(isRepositoryRelativePath) ||
        (rawTask?.deliverables !== undefined && !hasStringArray("deliverables")) ||
        !task.requiredArtifacts.every(isRepositoryRelativePath) || !hasStringArray("dependsOn") || !hasStringArray("verification") ||
        (rawTask?.requiredArtifacts !== undefined && !hasStringArray("requiredArtifacts")) ||
        (rawTask?.prerequisites !== undefined && !hasStringArray("prerequisites")) ||
        (legacyRequires !== undefined && !hasStringArray("requires")) ||
        task.requiredArtifacts.some((artifact) => task.produces.includes(artifact));
    })) return null;
    const producedArtifacts = new Set<string>();
    if (tasks.some((task) => task.produces.some((artifact) => {
      const key = artifactPathKey(artifact);
      if (producedArtifacts.has(key)) return true;
      producedArtifacts.add(key);
      return false;
    }))) return null;
    executionPlan = {
      tasks,
      integrationOrder: rawPlan.integrationOrder.map(String),
      preflightChecks: rawPlan.preflightChecks.map(String),
      repairPolicy: rawPlan.repairPolicy.trim(),
    };
  }
  return {
    version: executionPlan ? 2 : 1,
    summary: value.summary.trim(),
    decisions: value.decisions.map(String),
    constraints: value.constraints.map(String),
    invariants: value.invariants.map(String),
    interfaces: value.interfaces.map(String),
    taskGuidance: value.taskGuidance.map(String),
    ...(executionPlan ? { executionPlan } : {}),
  };
}

function validPlanNode(value: any, allowSubtasks = true): boolean {
  if (!value || typeof value !== "object" || typeof value.title !== "string" || !value.title.trim()) return false;
  for (const field of ["id", "architectureAlias", "description", "profileId"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || !value[field].trim())) return false;
  }
  for (const field of ["dependsOn", "acceptanceCriteria"] as const) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].some((item: unknown) => typeof item !== "string" || !item.trim()))) return false;
  }
  if (value.subtasks !== undefined && (!allowSubtasks || !Array.isArray(value.subtasks) || value.subtasks.some((subtask: any) => !validPlanNode(subtask, false)))) return false;
  return true;
}

export function parsePlan(text: string): { title: string; summary?: string; epics: Array<{ id?: string; title: string; description?: string; dependsOn?: string[]; acceptanceCriteria?: string[]; tasks: Array<{ id?: string; architectureAlias?: string; title: string; description?: string; dependsOn?: string[]; acceptanceCriteria?: string[]; profileId?: string; subtasks?: Array<{ id?: string; title: string; description?: string; dependsOn?: string[]; acceptanceCriteria?: string[]; profileId?: string }> }> }> } | null {
  const value = parseJsonObject(text);
  if (!value || typeof value.title !== "string" || !value.title.trim() || !Array.isArray(value.epics) || !value.epics.length) return null;
  if (value.summary !== undefined && typeof value.summary !== "string") return null;
  if (value.epics.some((epic: any) => !validPlanNode(epic) || !Array.isArray(epic.tasks) || !epic.tasks.length || epic.tasks.some((task: any) => !validPlanNode(task)))) return null;
  const epics = value.epics.map((epic: any) => ({
    id: typeof epic.id === "string" ? epic.id : undefined,
    title: String(epic.title ?? ""),
    description: String(epic.description ?? ""),
    dependsOn: Array.isArray(epic.dependsOn) ? epic.dependsOn.map(String) : [],
    acceptanceCriteria: Array.isArray(epic.acceptanceCriteria) ? epic.acceptanceCriteria.map(String) : [],
    tasks: Array.isArray(epic.tasks) ? epic.tasks.map((task: any) => ({
      id: typeof task.id === "string" ? task.id : undefined,
      architectureAlias: typeof task.architectureAlias === "string" ? task.architectureAlias : undefined,
      title: String(task.title ?? ""),
      description: String(task.description ?? ""),
      dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : [],
      acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria.map(String) : [],
      profileId: typeof task.profileId === "string" ? task.profileId : undefined,
      subtasks: Array.isArray(task.subtasks) ? task.subtasks.map((subtask: any) => ({
        id: typeof subtask.id === "string" ? subtask.id : undefined,
        title: String(subtask.title ?? ""),
        description: String(subtask.description ?? ""),
        dependsOn: Array.isArray(subtask.dependsOn) ? subtask.dependsOn.map(String) : [],
        acceptanceCriteria: Array.isArray(subtask.acceptanceCriteria) ? subtask.acceptanceCriteria.map(String) : [],
        profileId: typeof subtask.profileId === "string" ? subtask.profileId : undefined,
      })) : [],
    })) : [],
  }));
  if (epics.some((epic: any) => !epic.title || !epic.tasks.length || epic.tasks.some((task: any) => !task.title))) return null;
  return canonicalizePlanIds({ title: value.title, summary: typeof value.summary === "string" ? value.summary : undefined, epics });
}

function architectureKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function artifactPathKey(value: string): string {
  return value.trim().replace(/^\.\//, "");
}

export function applyArchitectureExecutionPlan(plan: any, executionPlan?: ArchitectureExecutionPlan): any {
  if (!executionPlan) return plan;
  const taskNodes: any[] = plan.epics.flatMap((epic: any) => epic.tasks);
  const aliases = new Map<string, any>();
  const register = (value: unknown, node: any): void => {
    if (typeof value !== "string" || !value.trim()) return;
    aliases.set(value.trim(), node);
    aliases.set(architectureKey(value), node);
  };
  for (const node of taskNodes) {
    register(node.id, node);
    register(node.title, node);
    register(node.architectureAlias, node);
  }
  const resolve = (reference: string): any => aliases.get(reference.trim()) ?? aliases.get(architectureKey(reference));
  const nodesByArchitectureAlias = new Map<string, any>();
  for (const task of executionPlan.tasks) {
    const node = resolve(task.alias) ?? resolve(task.title);
    if (!node) throw new Error(`architecture task is missing from manager plan: ${task.alias}`);
    nodesByArchitectureAlias.set(task.alias, node);
    for (const dependency of task.dependsOn) {
      const dependencyNode = resolve(dependency);
      if (!dependencyNode) throw new Error(`architecture dependency is missing from manager plan: ${dependency}`);
      if (dependencyNode.id === node.id) throw new Error(`architecture task cannot depend on itself: ${task.alias}`);
      node.dependsOn = Array.from(new Set([...(node.dependsOn ?? []), dependencyNode.id]));
    }
  }
  if (nodesByArchitectureAlias.size !== executionPlan.tasks.length) throw new Error("architecture tasks resolve to duplicate manager tasks");
  for (const task of executionPlan.tasks) {
    const node = nodesByArchitectureAlias.get(task.alias);
    for (const requirement of task.requiredArtifacts) {
      const producers = executionPlan.tasks.filter((candidate) => candidate.alias !== task.alias && candidate.produces.some((artifact) => artifactPathKey(artifact) === artifactPathKey(requirement)));
      if (producers.length > 1) throw new Error(`architecture artifact has multiple producers: ${requirement}`);
      if (producers.length === 1) {
        const producerNode = nodesByArchitectureAlias.get(producers[0].alias)!;
        node.dependsOn = Array.from(new Set([...(node.dependsOn ?? []), producerNode.id]));
      }
    }
  }
  for (const reference of executionPlan.integrationOrder) {
    if (!resolve(reference)) throw new Error(`architecture integration task is missing from manager plan: ${reference}`);
  }
  const plannedNodes = new Set(nodesByArchitectureAlias.values());
  for (const node of taskNodes) {
    if (!plannedNodes.has(node)) throw new Error(`manager task is not present in architecture plan: ${node.architectureAlias ?? node.title}`);
  }
  return plan;
}

export type ManagerRecoveryAction = "architect" | "retry" | "block";

export interface ManagerDecision {
  action?: ManagerRecoveryAction;
  nodeId?: string;
  reason?: string;
  edits: Array<{ nodeId: string; title?: string; description?: string; acceptanceCriteria?: string[]; dependsOn?: string[]; profileId?: string | null }>;
  note?: string;
}

export function parseManagerDecision(text: string): ManagerDecision | null {
  const value = parseJsonObject(text);
  if (!value || !Array.isArray(value.edits)) return null;
  const action = value.action === "architect" || value.action === "retry" || value.action === "block" ? value.action : undefined;
  const nodeId = typeof value.nodeId === "string" && value.nodeId.trim() ? value.nodeId.trim() : undefined;
  if (action && !nodeId) return null;
  if (value.edits.some((edit: any) => {
    if (!edit || typeof edit.nodeId !== "string" || !edit.nodeId.trim()) return true;
    if (edit.title !== undefined && typeof edit.title !== "string") return true;
    if (edit.description !== undefined && typeof edit.description !== "string") return true;
    if (edit.profileId !== undefined && edit.profileId !== null && typeof edit.profileId !== "string") return true;
    for (const field of ["acceptanceCriteria", "dependsOn"] as const) {
      if (edit[field] !== undefined && (!Array.isArray(edit[field]) || edit[field].some((item: unknown) => typeof item !== "string" || !item.trim()))) return true;
    }
    return false;
  })) return null;
  const edits = value.edits.map((edit: any) => ({
    nodeId: edit.nodeId,
    ...(edit.title !== undefined ? { title: String(edit.title) } : {}),
    ...(edit.description !== undefined ? { description: String(edit.description) } : {}),
    ...(edit.acceptanceCriteria !== undefined ? { acceptanceCriteria: Array.isArray(edit.acceptanceCriteria) ? edit.acceptanceCriteria.map(String) : [] } : {}),
    ...(edit.dependsOn !== undefined ? { dependsOn: Array.isArray(edit.dependsOn) ? edit.dependsOn.map(String) : [] } : {}),
    ...(edit.profileId !== undefined ? { profileId: edit.profileId === null ? null : String(edit.profileId) } : {}),
  }));
  return {
    ...(action ? { action } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    edits,
    note: typeof value.note === "string" ? value.note : undefined,
  };
}

export function parseReview(text: string): { verdict: "pass" | "fail"; findings: string[]; evidence: Record<string, unknown> } | null {
  const value = parseJsonObject(text);
  if (!value || (value.verdict !== "pass" && value.verdict !== "fail") || !Array.isArray(value.findings) || value.findings.some((item: unknown) => typeof item !== "string" || !item.trim()) || !value.evidence || typeof value.evidence !== "object" || Array.isArray(value.evidence)) return null;
  return { verdict: value.verdict, findings: value.findings.map((item: string) => item.trim()), evidence: value.evidence };
}

export function defaultPlan(prompt: string): { title: string; summary: string; epics: Array<{ title: string; description: string; tasks: Array<{ title: string; description: string; acceptanceCriteria: string[] }> }> } {
  const title = prompt.trim().split(/\s+/).slice(0, 8).join(" ") || "Pi initiative";
  return {
    title,
    summary: prompt.trim(),
    epics: [{
      title: "Implementation",
      description: "Manager-generated initial epic; refine with a plan edit or manager message.",
      tasks: [{
        title: "Implement the requested change",
        description: prompt.trim(),
        acceptanceCriteria: ["Implement the request in the target repository", "Run the repository gate and report exact evidence"],
      }],
    }],
  };
}
