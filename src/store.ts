import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertAcyclic,
  assertTransition,
  idFor,
  now,
  validateArchitectureContract,
  readyForDependencies,
} from "./domain.ts";
import type {
  AgentRecord,
  AgentSessionRecord,
  ArchitectureContract,
  ArchitectureContractRecord,
  EventRecord,
  Level,
  NodeRecord,
  NodeStatus,
  PlanNodeSpec,
  PlanSpec,
  ReviewVerdict,
} from "./domain.ts";
import { metricId, percentile, validateMetric, type MetricAggregate, type MetricRow, type MetricSummary, type RunMetric } from "./metrics.ts";

function json<T>(value: T): string {
  return JSON.stringify(value ?? null);
}

const FEED_REDACT_KEY = /(prompt|output|stdout|stderr|credential|secret|password|reasoning|chain[-_ ]?of[-_ ]?thought|token)/i;

function publicFeedValue(value: unknown, key = "", depth = 0): unknown {
  if (FEED_REDACT_KEY.test(key)) return "[REDACTED]";
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 500);
  if (depth >= 3) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => publicFeedValue(item, key, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([childKey, childValue]) => [childKey, publicFeedValue(childValue, childKey, depth + 1)]));
  }
  return String(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

type AggregateState = MetricAggregate & { durations: number[]; ttfts: number[]; tps: number[] };

function newAggregate(profile?: string, model?: string): AggregateState {
  return {
    ...(profile ? { profile } : {}),
    ...(model ? { model } : {}),
    runs: 0,
    success: 0,
    failure: 0,
    totalDurationMs: 0,
    p50DurationMs: 0,
    p95DurationMs: 0,
    p50TtftMs: null,
    p95TtftMs: null,
    avgTokensPerSecond: null,
    p50TokensPerSecond: null,
    p95TokensPerSecond: null,
    costUsd: 0,
    costComplete: true,
    costKnownRuns: 0,
    costUnknownRuns: 0,
    apiCostUsd: 0,
    apiCostComplete: true,
    apiCostKnownRuns: 0,
    apiCostUnknownRuns: 0,
    codexCredits: 0,
    codexCreditsComplete: true,
    codexCreditsKnownRuns: 0,
    codexCreditsUnknownRuns: 0,
    counters: {},
    durations: [],
    ttfts: [],
    tps: [],
  };
}

function addMetricToAggregate(state: AggregateState, row: MetricRow): void {
  state.runs += 1;
  state.success += ["success", "pass"].includes(row.outcome) ? 1 : 0;
  state.failure += ["failure", "timeout", "blocked", "fail"].includes(row.outcome) ? 1 : 0;
  state.totalDurationMs += row.durationMs;
  state.durations.push(row.durationMs);
  for (const [name, value] of Object.entries(row.counters ?? {})) state.counters[name] = (state.counters[name] ?? 0) + Number(value);
  const ttft = row.counters?.ttft_ms;
  if (typeof ttft === "number" && ttft >= 0) state.ttfts.push(ttft);
  const tps = row.counters?.tokens_per_second;
  if (typeof tps === "number" && tps >= 0) state.tps.push(tps);
  const apiCost = row.counters?.api_cost_usd ?? row.counters?.cost_usd;
  if (typeof apiCost === "number" && apiCost >= 0) {
    state.costUsd += apiCost;
    state.costKnownRuns += 1;
    state.apiCostUsd += apiCost;
    state.apiCostKnownRuns += 1;
  } else {
    state.costUnknownRuns += 1;
    state.costComplete = false;
    state.apiCostUnknownRuns += 1;
    state.apiCostComplete = false;
  }
  const credits = row.counters?.codex_credits;
  if (typeof credits === "number" && credits >= 0) {
    state.codexCredits += credits;
    state.codexCreditsKnownRuns += 1;
  } else if (["manager", "worker", "reviewer", "researcher", "architect", "release"].includes(row.role)) {
    state.codexCreditsUnknownRuns += 1;
    state.codexCreditsComplete = false;
  }
}

function finalizeAggregate(state: AggregateState): MetricAggregate {
  state.p50DurationMs = percentile(state.durations, 0.5);
  state.p95DurationMs = percentile(state.durations, 0.95);
  state.p50TtftMs = state.ttfts.length ? percentile(state.ttfts, 0.5) : null;
  state.p95TtftMs = state.ttfts.length ? percentile(state.ttfts, 0.95) : null;
  state.avgTokensPerSecond = state.tps.length ? state.tps.reduce((sum, value) => sum + value, 0) / state.tps.length : null;
  state.p50TokensPerSecond = state.tps.length ? percentile(state.tps, 0.5) : null;
  state.p95TokensPerSecond = state.tps.length ? percentile(state.tps, 0.95) : null;
  const { durations: _durations, ttfts: _ttfts, tps: _tps, ...result } = state;
  return result;
}

function rowToAgent(row: any): AgentRecord {
  return {
    id: row.id,
    initiativeId: row.initiative_id,
    nodeId: row.node_id,
    role: row.role,
    profileId: row.profile_id,
    model: row.model,
    pool: row.pool,
    status: row.status,
    currentSessionId: row.current_session_id,
    currentNodeId: row.current_node_id,
    lastHeartbeat: row.last_heartbeat,
    runCount: row.run_count,
    successCount: row.success_count,
    failureCount: row.failure_count,
    handoffSummary: row.handoff_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAgentSession(row: any): AgentSessionRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    initiativeId: row.initiative_id,
    nodeId: row.node_id,
    role: row.role,
    profileId: row.profile_id,
    model: row.model,
    runId: row.run_id,
    attemptNo: row.attempt_no,
    pid: row.pid,
    state: row.state,
    startedAt: row.started_at,
    lastHeartbeat: row.last_heartbeat,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    error: row.error,
    handoffSummary: row.handoff_summary,
  };
}

function rowToArchitectureContract(row: any): ArchitectureContractRecord {
  const contract = parseJson<ArchitectureContract>(row.contract_json, {} as ArchitectureContract);
  validateArchitectureContract(contract);
  return {
    ...contract,
    id: row.id,
    supersedesRevision: row.supersedes_revision,
    supersessionReason: row.supersession_reason,
  };
}

function rowToNode(row: any): NodeRecord {
  return {
    id: row.id,
    initiativeId: row.initiative_id,
    parentId: row.parent_id,
    level: row.level,
    title: row.title,
    architectureAlias: row.architecture_alias ?? null,
    description: row.description,
    acceptanceCriteria: parseJson(row.acceptance_json, []),
    dependsOn: parseJson(row.dependencies_json, []),
    profileId: row.profile_id,
    status: row.status,
    repoPath: row.repo_path,
    baseCommit: row.base_commit,
    branch: row.branch,
    worktreePath: row.worktree_path,
    integratedCommit: row.integrated_commit,
    generation: row.generation,
    attempt: row.attempt,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    failure: row.failure,
    recoveryOwner: row.recovery_owner ?? null,
    recoveryScope: row.recovery_scope ?? null,
    requiredAction: row.required_action ?? null,
    unblockCondition: row.unblock_condition ?? null,
    recoveryEpoch: Number(row.recovery_epoch ?? 0),
    recoveryFingerprint: row.recovery_fingerprint ?? null,
    autoPrune: Boolean(row.auto_prune),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const SCHEMA_VERSION = 2;

export interface GcEligibility {
  eligible: boolean;
  reason: string | null;
}

export interface GcLock {
  initiativeId: string;
  owner: string;
  pid: number;
  acquiredAt: string;
}

type SchemaMigration = { version: number; up: (db: any) => void };

// Ordered migrations. The inline CREATE/ALTER block establishes the v1 shape
// for fresh and pre-versioning databases. v2 adds durable automatic-GC policy
// and the recovery-safe exclusive lock table.
const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  { version: 1, up: () => {} },
  {
    version: 2,
    up: (db) => {
      try { db.exec("ALTER TABLE nodes ADD COLUMN auto_prune INTEGER NOT NULL DEFAULT 0"); } catch { /* v2-shaped fresh databases already have it */ }
      db.exec(`
        CREATE TABLE IF NOT EXISTS gc_locks (
          initiative_id TEXT PRIMARY KEY REFERENCES nodes(id),
          owner TEXT NOT NULL,
          pid INTEGER NOT NULL,
          acquired_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS gc_locks_owner_idx ON gc_locks(owner);
      `);
    },
  },
];

export class Store {
  readonly db: any;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    const syncMode = (process.env.LAO_SQLITE_SYNC ?? "full").toLowerCase();
    if (syncMode !== "full") {
      if (syncMode !== "normal" && syncMode !== "off") {
        throw new Error(`invalid LAO_SQLITE_SYNC: ${process.env.LAO_SQLITE_SYNC} (expected full, normal, or off)`);
      }
      this.db.exec(`PRAGMA synchronous = ${syncMode.toUpperCase()};`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        initiative_id TEXT NOT NULL,
        parent_id TEXT REFERENCES nodes(id),
        level TEXT NOT NULL CHECK(level IN ('initiative','epic','task','subtask')),
        title TEXT NOT NULL,
        architecture_alias TEXT,
        description TEXT NOT NULL DEFAULT '',
        acceptance_json TEXT NOT NULL DEFAULT '[]',
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        profile_id TEXT,
        status TEXT NOT NULL,
        repo_path TEXT,
        base_commit TEXT,
        branch TEXT,
        worktree_path TEXT,
        integrated_commit TEXT,
        generation INTEGER NOT NULL DEFAULT 1,
        attempt INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_until TEXT,
        failure TEXT,
        recovery_owner TEXT,
        recovery_scope TEXT,
        required_action TEXT,
        unblock_condition TEXT,
        recovery_epoch INTEGER NOT NULL DEFAULT 0,
        recovery_fingerprint TEXT,
        auto_prune INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS nodes_initiative_idx ON nodes(initiative_id);
      CREATE INDEX IF NOT EXISTS nodes_status_idx ON nodes(status);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_node_idx ON events(node_id, id);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        initiative_id TEXT NOT NULL,
        body TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS plan_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        initiative_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        patch_json TEXT NOT NULL,
        state TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS architecture_contracts (
        id TEXT PRIMARY KEY,
        initiative_id TEXT NOT NULL REFERENCES nodes(id),
        revision INTEGER NOT NULL,
        contract_json TEXT NOT NULL,
        supersedes_revision INTEGER,
        supersession_reason TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(initiative_id, revision)
      );
      CREATE INDEX IF NOT EXISTS architecture_contracts_initiative_idx ON architecture_contracts(initiative_id, revision);
      CREATE TABLE IF NOT EXISTS system_failures (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        run_id TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS system_failures_created_idx ON system_failures(created_at);
      CREATE TABLE IF NOT EXISTS initiative_runs (
        initiative_id TEXT PRIMARY KEY REFERENCES nodes(id),
        owner TEXT NOT NULL,
        pid INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        role TEXT NOT NULL,
        state TEXT NOT NULL,
        output_path TEXT,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        verdict TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metrics (
        id TEXT PRIMARY KEY,
        initiative_id TEXT NOT NULL,
        node_id TEXT,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL,
        outcome TEXT NOT NULL,
        duration_ms REAL NOT NULL,
        counters_json TEXT NOT NULL DEFAULT '{}',
        dimensions_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS metrics_initiative_idx ON metrics(initiative_id, created_at);
      CREATE INDEX IF NOT EXISTS metrics_role_idx ON metrics(initiative_id, role, created_at);
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        initiative_id TEXT REFERENCES nodes(id),
        node_id TEXT REFERENCES nodes(id),
        role TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        model TEXT,
        pool TEXT,
        status TEXT NOT NULL,
        current_session_id TEXT,
        current_node_id TEXT,
        last_heartbeat TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        handoff_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agents_initiative_idx ON agents(initiative_id, updated_at);
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        initiative_id TEXT REFERENCES nodes(id),
        node_id TEXT REFERENCES nodes(id),
        role TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        model TEXT,
        run_id TEXT NOT NULL UNIQUE,
        attempt_no INTEGER NOT NULL DEFAULT 0,
        pid INTEGER,
        state TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_heartbeat TEXT NOT NULL,
        ended_at TEXT,
        exit_code INTEGER,
        error TEXT,
        handoff_summary TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_sessions_agent_idx ON agent_sessions(agent_id, started_at);
      CREATE INDEX IF NOT EXISTS agent_sessions_node_idx ON agent_sessions(node_id, state);
      CREATE TABLE IF NOT EXISTS gc_locks (
        initiative_id TEXT PRIMARY KEY REFERENCES nodes(id),
        owner TEXT NOT NULL,
        pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gc_locks_owner_idx ON gc_locks(owner);
    `);
    for (const column of [
      "architecture_alias TEXT",
      "recovery_owner TEXT",
      "recovery_scope TEXT",
      "required_action TEXT",
      "unblock_condition TEXT",
      "recovery_epoch INTEGER NOT NULL DEFAULT 0",
      "recovery_fingerprint TEXT",
      "auto_prune INTEGER NOT NULL DEFAULT 0",
    ]) {
      try { this.db.exec(`ALTER TABLE nodes ADD COLUMN ${column}`); } catch { /* existing databases already have the column */ }
    }
    this.migrateToCurrent();
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
  }

  private migrateToCurrent(): void {
    const current = this.schemaVersion();
    for (const migration of SCHEMA_MIGRATIONS) {
      if (migration.version <= current) continue;
      migration.up(this.db);
      this.db.exec(`PRAGMA user_version = ${migration.version};`);
    }
  }

  ensureAgent(input: { id: string; initiativeId?: string | null; nodeId?: string | null; role: string; profileId: string; model?: string | null; pool?: string | null }): AgentRecord {
    const timestamp = now();
    this.db.prepare(`INSERT OR IGNORE INTO agents (id, initiative_id, node_id, role, profile_id, model, pool, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`).run(input.id, input.initiativeId ?? null, input.nodeId ?? null, input.role, input.profileId, input.model ?? null, input.pool ?? null, timestamp, timestamp);
    this.db.prepare(`UPDATE agents SET initiative_id = COALESCE(?, initiative_id), node_id = COALESCE(?, node_id), role = ?, profile_id = ?, model = ?, pool = ?, updated_at = ? WHERE id = ?`).run(
      input.initiativeId ?? null, input.nodeId ?? null, input.role, input.profileId, input.model ?? null, input.pool ?? null, timestamp, input.id,
    );
    return this.getAgent(input.id)!;
  }

  getAgent(id: string): AgentRecord | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    return row ? rowToAgent(row) : null;
  }

  listAgents(initiativeId?: string): AgentRecord[] {
    const rows = initiativeId
      ? this.db.prepare("SELECT * FROM agents WHERE initiative_id = ? ORDER BY created_at, id").all(initiativeId)
      : this.db.prepare("SELECT * FROM agents ORDER BY created_at, id").all();
    return rows.map(rowToAgent);
  }

  setAgentProfile(agentId: string, profileId: string, model?: string | null, pool?: string | null): AgentRecord {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    const timestamp = now();
    this.db.prepare("UPDATE agents SET profile_id = ?, model = ?, pool = ?, updated_at = ? WHERE id = ?").run(profileId, model ?? null, pool ?? null, timestamp, agentId);
    this.recordEvent(agent.nodeId ?? agent.initiativeId, "agent_profile_assigned", { agentId, profileId, model: model ?? null, pool: pool ?? null });
    return this.getAgent(agentId)!;
  }

  startAgentSession(input: { id: string; agentId: string; initiativeId?: string | null; nodeId?: string | null; role: string; profileId: string; model?: string | null; attemptNo?: number; pid?: number | null }): AgentSessionRecord {
    return this.tx(() => {
      this.ensureAgent({ ...input, id: input.agentId });
      const existing = this.db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(input.id) as any;
      if (existing) return rowToAgentSession(existing);
      const timestamp = now();
      this.db.prepare(`INSERT INTO agent_sessions (id, agent_id, initiative_id, node_id, role, profile_id, model, run_id, attempt_no, pid, state, started_at, last_heartbeat)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`).run(
        input.id, input.agentId, input.initiativeId ?? null, input.nodeId ?? null, input.role, input.profileId, input.model ?? null, input.id, input.attemptNo ?? 0, input.pid ?? null, timestamp, timestamp,
      );
      this.db.prepare("UPDATE agents SET status = 'running', current_session_id = ?, current_node_id = ?, last_heartbeat = ?, run_count = run_count + 1, updated_at = ? WHERE id = ?").run(input.id, input.nodeId ?? null, timestamp, timestamp, input.agentId);
      if (input.nodeId) this.event(input.nodeId, "agent_session_started", { agentId: input.agentId, sessionId: input.id, role: input.role, profileId: input.profileId, model: input.model ?? null });
      return this.getAgentSession(input.id)!;
    });
  }

  getAgentSession(id: string): AgentSessionRecord | null {
    const row = this.db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id) as any;
    return row ? rowToAgentSession(row) : null;
  }

  listAgentSessions(initiativeId?: string, state?: string): AgentSessionRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (initiativeId) { clauses.push("initiative_id = ?"); values.push(initiativeId); }
    if (state) { clauses.push("state = ?"); values.push(state); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM agent_sessions${where} ORDER BY started_at, id`).all(...values) as any[]).map(rowToAgentSession);
  }

  heartbeatAgent(agentId: string, sessionId: string, at = now()): void {
    this.db.prepare("UPDATE agent_sessions SET last_heartbeat = ? WHERE id = ? AND agent_id = ? AND state = 'running'").run(at, sessionId, agentId);
    this.db.prepare("UPDATE agents SET last_heartbeat = ?, updated_at = ? WHERE id = ? AND current_session_id = ?").run(at, at, agentId, sessionId);
  }

  finishAgentSession(id: string, state: "completed" | "failed" | "interrupted", input: { exitCode?: number | null; error?: string; handoffSummary?: string } = {}): void {
    this.tx(() => {
      const session = this.getAgentSession(id);
      if (!session || session.state !== "running") return;
      const timestamp = now();
      const summary = input.handoffSummary?.slice(0, 2000) ?? null;
      this.db.prepare("UPDATE agent_sessions SET state = ?, ended_at = ?, last_heartbeat = ?, exit_code = ?, error = ?, handoff_summary = ? WHERE id = ?").run(state, timestamp, timestamp, input.exitCode ?? null, input.error?.slice(0, 2000) ?? null, summary, id);
      const agentStatus = state === "interrupted" ? "recovering" : "idle";
      this.db.prepare(`UPDATE agents SET status = ?, current_session_id = NULL, last_heartbeat = ?, handoff_summary = ?, success_count = success_count + ?, failure_count = failure_count + ?, updated_at = ? WHERE id = ? AND current_session_id = ?`).run(
        agentStatus, timestamp, summary, state === "completed" ? 1 : 0, state === "completed" ? 0 : 1, timestamp, session.agentId, id,
      );
      if (session.nodeId) this.event(session.nodeId, "agent_session_finished", { agentId: session.agentId, sessionId: id, state, exitCode: input.exitCode ?? null });
    });
  }

  private tx<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  private insertNode(
    id: string,
    initiativeId: string,
    parentId: string | null,
    level: Level,
    spec: PlanNodeSpec,
    context: { repoPath?: string; baseCommit?: string },
    status: NodeStatus,
  ): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO nodes (
        id, initiative_id, parent_id, level, title, architecture_alias, description, acceptance_json,
        dependencies_json, profile_id, status, repo_path, base_commit, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      initiativeId,
      parentId,
      level,
      spec.title,
      spec.architectureAlias ?? null,
      spec.description ?? "",
      json(spec.acceptanceCriteria ?? []),
      json(spec.dependsOn ?? []),
      spec.profileId ?? null,
      status,
      context.repoPath ?? null,
      context.baseCommit ?? null,
      timestamp,
      timestamp,
    );
    this.event(id, "node_created", { level, title: spec.title });
  }

  private event(nodeId: string | null, kind: string, payload: Record<string, unknown>): void {
    this.db.prepare(
      "INSERT INTO events (node_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(nodeId, kind, json(payload), now());
  }

  recordEvent(nodeId: string | null, kind: string, payload: Record<string, unknown> = {}): number {
    this.event(nodeId, kind, payload);
    return this.eventCursor();
  }

  createPlan(input: {
    plan: PlanSpec;
    repoPath: string;
    baseCommit: string;
    autoPrune?: boolean;
  }): { initiativeId: string; epicIds: string[]; autoPrune: boolean } {
    const { plan, repoPath, baseCommit, autoPrune = false } = input;
    if (!plan.title.trim() || !plan.epics.length) throw new Error("plan needs a title and at least one epic");
    const explicitIds: string[] = [];
    for (const epic of plan.epics) {
      if (epic.id) explicitIds.push(epic.id);
      for (const task of epic.tasks) {
        if (task.id) explicitIds.push(task.id);
        for (const subtask of task.subtasks ?? []) if (subtask.id) explicitIds.push(subtask.id);
      }
    }
    const duplicates = explicitIds.filter((id, index) => explicitIds.indexOf(id) !== index);
    if (duplicates.length) throw new Error(`plan contains duplicate node ID before persistence: ${duplicates[0]}`);
    if (explicitIds.length) {
      const placeholders = explicitIds.map(() => "?").join(",");
      const existing = this.db.prepare(`SELECT id FROM nodes WHERE id IN (${placeholders}) LIMIT 1`).get(...explicitIds) as any;
      if (existing) throw new Error(`state namespace collision before persistence: node ID ${existing.id} already exists; use a fresh state directory or unique plan IDs`);
    }
    return this.tx(() => {
      const initiativeId = idFor("initiative");
      this.insertNode(
        initiativeId,
        initiativeId,
        null,
        "initiative",
        { title: plan.title, description: plan.summary ?? "" },
        { repoPath, baseCommit },
        "draft",
      );
      // Keep policy persistence in the same transaction as the plan DAG. A
      // detached/resumed run therefore cannot lose the operator's choice.
      this.db.prepare("UPDATE nodes SET auto_prune = ? WHERE id = ? AND level = 'initiative'").run(autoPrune ? 1 : 0, initiativeId);
      const epicIds: string[] = [];
      const allSpecs: Array<{ id: string; dependsOn: string[] }> = [{ id: initiativeId, dependsOn: [] }];
      for (const epic of plan.epics) {
        const epicId = epic.id ?? idFor("epic");
        epicIds.push(epicId);
        this.insertNode(epicId, initiativeId, initiativeId, "epic", epic, { repoPath, baseCommit }, "pending");
        allSpecs.push({ id: epicId, dependsOn: epic.dependsOn ?? [] });
        for (const task of epic.tasks) {
          const taskId = task.id ?? idFor("task");
          this.insertNode(taskId, initiativeId, epicId, "task", task, { repoPath, baseCommit }, "pending");
          allSpecs.push({ id: taskId, dependsOn: task.dependsOn ?? [] });
          for (const subtask of task.subtasks ?? []) {
            const subtaskId = subtask.id ?? idFor("subtask");
            this.insertNode(subtaskId, initiativeId, taskId, "subtask", subtask, { repoPath, baseCommit }, "pending");
            allSpecs.push({ id: subtaskId, dependsOn: subtask.dependsOn ?? [] });
          }
        }
      }
      assertAcyclic(allSpecs);
      this.refreshReadyInternal(initiativeId);
      this.event(initiativeId, "plan_created", { title: plan.title, epicIds, autoPrune: Boolean(autoPrune) });
      return { initiativeId, epicIds, autoPrune: Boolean(autoPrune) };
    });
  }

  private refreshReadyInternal(initiativeId: string): void {
    const nodes = this.listNodes(initiativeId);
    for (const node of nodes) {
      if (!["pending", "waiting_dependency"].includes(node.status)) continue;
      const dependencies = node.dependsOn.map((dependencyId) => nodes.find((candidate) => candidate.id === dependencyId)).filter(Boolean) as NodeRecord[];
      const hasBlockedDependency = dependencies.some((dependency) => ["blocked", "failed", "waiting_dependency", "waiting_external", "waiting_approval", "needs_manager", "needs_architect", "needs_operator"].includes(dependency.status));
      const hasIncompleteDependency = dependencies.some((dependency) => dependency.status !== "completed");
      if (hasBlockedDependency || (node.status === "waiting_dependency" && hasIncompleteDependency)) {
        if (node.status !== "waiting_dependency") {
          this.db.prepare("UPDATE nodes SET status = 'waiting_dependency', failure = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run("waiting for a dependency to become available", now(), node.id);
          this.event(node.id, "dependency_waiting", { dependencies: node.dependsOn });
        }
        continue;
      }
      if (node.status === "waiting_dependency") {
        this.db.prepare("UPDATE nodes SET status = 'pending', failure = NULL, updated_at = ? WHERE id = ? AND status = 'waiting_dependency'").run(now(), node.id);
        this.event(node.id, "dependency_unblocked", { dependencies: node.dependsOn });
      }
      const current = this.getNode(node.id)!;
      if (current.status === "pending" && (node.level === "initiative" || readyForDependencies(current, nodes))) {
        this.db.prepare("UPDATE nodes SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'pending'").run(now(), node.id);
        this.event(node.id, "node_ready", {});
      }
    }
  }

  refreshReady(initiativeId: string): void {
    this.tx(() => this.refreshReadyInternal(initiativeId));
  }

  unblockWaiting(initiativeId?: string): string[] {
    return this.tx(() => {
      const nodes = initiativeId ? this.listNodes(initiativeId) : this.db.prepare("SELECT * FROM nodes WHERE status = 'waiting_external'").all().map(rowToNode);
      const unblocked: string[] = [];
      for (const node of nodes) {
        if (node.status !== "waiting_external" || !node.repoPath || !(node.unblockCondition?.startsWith("artifact:") || node.unblockCondition?.startsWith("artifacts:"))) continue;
        const prefix = node.unblockCondition.startsWith("artifacts:") ? "artifacts:" : "artifact:";
        const artifacts = node.unblockCondition.slice(prefix.length).split(",").map((item) => item.trim()).filter(Boolean);
        if (!artifacts.length || artifacts.some((artifact) => artifact.startsWith("/") || artifact.split(/[\\/]+/).includes("..") || !existsSync(resolve(node.repoPath!, artifact)))) continue;
        this.db.prepare("UPDATE nodes SET status = 'pending', failure = NULL, recovery_owner = NULL, recovery_scope = NULL, required_action = NULL, unblock_condition = NULL, recovery_epoch = 0, recovery_fingerprint = NULL, updated_at = ? WHERE id = ? AND status = 'waiting_external'").run(now(), node.id);
        this.event(node.id, "auto_unblocked", { trigger: "artifact" });
        unblocked.push(node.id);
      }
      if (unblocked.length) this.refreshReadyInternal(initiativeId ?? nodes[0]?.initiativeId ?? "");
      return unblocked;
    });
  }

  refreshRollups(initiativeId: string): void {
    this.tx(() => {
      const nodes = this.listNodes(initiativeId);
      const update = (node: NodeRecord, target: NodeStatus, reason: string): void => {
        if (node.status === target) return;
        if (!["completed", "waiting", "blocked"].includes(target)) return;
        this.db.prepare("UPDATE nodes SET status = ?, failure = ?, updated_at = ? WHERE id = ?").run(target, target === "completed" ? node.failure : reason, now(), node.id);
        this.event(node.id, "status_changed", { from: node.status, to: target, reason, rollup: true });
      };
      const isUnresolved = (node: NodeRecord): boolean => !["completed", "blocked", "failed"].includes(node.status);
      const isBlocked = (node: NodeRecord): boolean => ["blocked", "failed"].includes(node.status);
      const isWaiting = (node: NodeRecord): boolean => ["waiting", "recovering", "waiting_dependency", "waiting_external", "waiting_approval", "needs_manager", "needs_architect", "needs_operator"].includes(node.status);
      for (const epic of nodes.filter((node) => node.level === "epic")) {
        const children = nodes.filter((node) => node.parentId === epic.id && ["task", "subtask"].includes(node.level));
        if (!children.length) continue;
        if (children.every((child) => child.status === "completed")) update(epic, "completed", "all child tasks completed");
        else if (children.some(isBlocked)) update(epic, children.some(isUnresolved) ? "waiting" : "blocked", children.some(isUnresolved) ? "one or more child tasks are waiting while other work remains" : "all child tasks are blocked or failed");
        else if (children.some(isWaiting)) update(epic, "waiting", "one or more child tasks is waiting for recovery");
      }
      const work = nodes.filter((node) => ["task", "subtask"].includes(node.level));
      const initiative = nodes.find((node) => node.id === initiativeId);
      if (initiative && work.length && work.every((node) => node.status === "completed")) update(initiative, "completed", "all tasks completed");
      else if (initiative && work.some(isBlocked)) update(initiative, work.some(isUnresolved) ? "waiting" : "blocked", work.some(isUnresolved) ? "some task branches are blocked while independent work remains" : "all remaining task branches are blocked or failed");
      else if (initiative && work.some(isWaiting)) update(initiative, "waiting", "one or more task branches is waiting for recovery");
    });
  }

  getNode(id: string): NodeRecord | null {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
    return row ? rowToNode(row) : null;
  }

  listNodes(initiativeId: string): NodeRecord[] {
    return this.db.prepare("SELECT * FROM nodes WHERE initiative_id = ? ORDER BY created_at, id").all(initiativeId).map(rowToNode);
  }

  listInitiatives(): NodeRecord[] {
    return this.db.prepare("SELECT * FROM nodes WHERE level = 'initiative' ORDER BY created_at").all().map(rowToNode);
  }

  getAutoPrune(initiativeId: string): boolean {
    const row = this.db.prepare("SELECT auto_prune FROM nodes WHERE id = ? AND level = 'initiative'").get(initiativeId) as any;
    if (!row) throw new Error(`unknown initiative ${initiativeId}`);
    return Boolean(row.auto_prune);
  }

  setAutoPrune(initiativeId: string, enabled: boolean): void {
    this.tx(() => {
      const result = this.db.prepare("UPDATE nodes SET auto_prune = ?, updated_at = ? WHERE id = ? AND level = 'initiative'").run(enabled ? 1 : 0, now(), initiativeId);
      if (!result.changes) throw new Error(`unknown initiative ${initiativeId}`);
      this.event(initiativeId, "auto_prune_policy_changed", { enabled: Boolean(enabled) });
    });
  }

  private processAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private gcEligibilityInternal(initiativeId: string, at: Date, lockOwner?: string): GcEligibility {
    const initiative = this.getNode(initiativeId);
    if (!initiative || initiative.level !== "initiative") return { eligible: false, reason: "unknown_initiative" };
    if (!initiative.autoPrune) return { eligible: false, reason: "auto_prune_disabled" };
    if (!(initiative.status === "completed" || initiative.status === "blocked")) return { eligible: false, reason: "initiative_not_terminal" };
    const nodes = this.listNodes(initiativeId);
    const nonTerminal = nodes.find((node) => !["completed", "blocked", "failed"].includes(node.status));
    if (nonTerminal) return { eligible: false, reason: `non_terminal_node:${nonTerminal.id}` };
    const cutoff = at.toISOString();
    const lease = nodes.find((node) => (node.leaseOwner || node.leaseUntil) && (!node.leaseUntil || node.leaseUntil > cutoff));
    if (lease) return { eligible: false, reason: `active_node_lease:${lease.id}` };
    const session = this.db.prepare("SELECT id FROM agent_sessions WHERE state = 'running' AND (initiative_id = ? OR node_id IN (SELECT id FROM nodes WHERE initiative_id = ?)) LIMIT 1").get(initiativeId, initiativeId) as any;
    if (session) return { eligible: false, reason: `running_agent_session:${session.id}` };
    const run = this.db.prepare("SELECT owner, pid FROM initiative_runs WHERE initiative_id = ? LIMIT 1").get(initiativeId) as any;
    if (run && this.processAlive(Number(run.pid))) return { eligible: false, reason: "active_initiative_run" };
    const lock = this.db.prepare("SELECT owner, pid FROM gc_locks WHERE initiative_id = ? LIMIT 1").get(initiativeId) as any;
    if (lock && this.processAlive(Number(lock.pid)) && lock.owner !== lockOwner) return { eligible: false, reason: "gc_lock_conflict" };
    return { eligible: true, reason: null };
  }

  checkGcEligibility(initiativeId: string, at = new Date(), lockOwner?: string): GcEligibility {
    return this.gcEligibilityInternal(initiativeId, at, lockOwner);
  }

  isGcEligible(initiativeId: string, at = new Date()): boolean {
    return this.checkGcEligibility(initiativeId, at).eligible;
  }

  /**
   * Atomically checks the terminal snapshot and claims the exclusive GC lock.
   * Dead owners are reclaimable, which makes an interrupted sweep safe to
   * resume without requiring a separate cleanup transaction.
   */
  acquireGcLock(initiativeId: string, owner: string, pid = process.pid): boolean {
    return this.tx(() => {
      const eligibility = this.gcEligibilityInternal(initiativeId, new Date(), owner);
      if (!eligibility.eligible) return false;
      const existing = this.db.prepare("SELECT owner, pid FROM gc_locks WHERE initiative_id = ?").get(initiativeId) as any;
      if (existing) {
        if (existing.owner === owner && Number(existing.pid) === pid) return true;
        if (this.processAlive(Number(existing.pid))) return false;
        this.db.prepare("DELETE FROM gc_locks WHERE initiative_id = ?").run(initiativeId);
      }
      const acquiredAt = now();
      this.db.prepare("INSERT INTO gc_locks (initiative_id, owner, pid, acquired_at) VALUES (?, ?, ?, ?)").run(initiativeId, owner, pid, acquiredAt);
      this.event(initiativeId, "gc_lock_acquired", { owner, pid });
      return true;
    });
  }

  tryAcquireGcLock(initiativeId: string, owner: string, pid = process.pid): boolean {
    return this.acquireGcLock(initiativeId, owner, pid);
  }

  releaseGcLock(initiativeId: string, owner: string): boolean {
    return this.tx(() => {
      const result = this.db.prepare("DELETE FROM gc_locks WHERE initiative_id = ? AND owner = ?").run(initiativeId, owner);
      if (!result.changes) return false;
      this.event(initiativeId, "gc_lock_released", { owner });
      return true;
    });
  }

  getGcLock(initiativeId: string): GcLock | null {
    const row = this.db.prepare("SELECT * FROM gc_locks WHERE initiative_id = ?").get(initiativeId) as any;
    return row ? { initiativeId, owner: row.owner, pid: Number(row.pid), acquiredAt: row.acquired_at } : null;
  }

  saveArchitectureContract(contract: ArchitectureContract, supersessionReason?: string): ArchitectureContractRecord {
    validateArchitectureContract(contract);
    const initiative = this.getNode(contract.initiativeId);
    if (!initiative || initiative.level !== "initiative") throw new Error(`unknown initiative ${contract.initiativeId}`);
    return this.tx(() => {
      const previous = this.getArchitectureContract(contract.initiativeId);
      const expectedRevision = (previous?.revision ?? 0) + 1;
      if (contract.revision !== expectedRevision) throw new Error(`architecture revision must be ${expectedRevision}`);
      const id = `architecture-${randomUUID()}`;
      const reason = previous ? (supersessionReason?.trim() || null) : null;
      this.db.prepare(`INSERT INTO architecture_contracts (id, initiative_id, revision, contract_json, supersedes_revision, supersession_reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, contract.initiativeId, contract.revision, json(contract), previous?.revision ?? null, reason, contract.createdAt);
      this.event(contract.initiativeId, "architecture_contract_created", {
        contractId: id,
        revision: contract.revision,
        supersedesRevision: previous?.revision ?? null,
        authorRole: contract.author.role,
        profileId: contract.author.profileId,
        model: contract.author.model,
      });
      return this.getArchitectureContract(contract.initiativeId, contract.revision)!;
    });
  }

  getArchitectureContract(initiativeId: string, revision?: number): ArchitectureContractRecord | null {
    const row = revision === undefined
      ? this.db.prepare("SELECT * FROM architecture_contracts WHERE initiative_id = ? ORDER BY revision DESC LIMIT 1").get(initiativeId)
      : this.db.prepare("SELECT * FROM architecture_contracts WHERE initiative_id = ? AND revision = ?").get(initiativeId, revision);
    return row ? rowToArchitectureContract(row) : null;
  }

  listArchitectureContracts(initiativeId: string): ArchitectureContractRecord[] {
    return this.db.prepare("SELECT * FROM architecture_contracts WHERE initiative_id = ? ORDER BY revision").all(initiativeId).map(rowToArchitectureContract);
  }

  acquireInitiativeRun(initiativeId: string, owner: string, pid = process.pid): void {
    this.tx(() => {
      const gcLock = this.db.prepare("SELECT owner, pid FROM gc_locks WHERE initiative_id = ?").get(initiativeId) as any;
      if (gcLock && this.processAlive(Number(gcLock.pid)) && gcLock.owner !== owner) throw new Error(`initiative has an active GC lock: ${initiativeId}`);
      const existing = this.db.prepare("SELECT owner, pid FROM initiative_runs WHERE initiative_id = ?").get(initiativeId) as any;
      if (existing) {
        let active = false;
        try { process.kill(Number(existing.pid), 0); active = true; } catch { active = false; }
        if (active && existing.owner !== owner) throw new Error(`initiative already has an active run lease: ${initiativeId}`);
        this.db.prepare("DELETE FROM initiative_runs WHERE initiative_id = ?").run(initiativeId);
      }
      const timestamp = now();
      this.db.prepare("INSERT INTO initiative_runs (initiative_id, owner, pid, started_at, heartbeat_at) VALUES (?, ?, ?, ?, ?)").run(initiativeId, owner, pid, timestamp, timestamp);
      this.event(initiativeId, "initiative_run_acquired", { owner, pid });
    });
  }

  releaseInitiativeRun(initiativeId: string, owner: string): void {
    this.tx(() => {
      const result = this.db.prepare("DELETE FROM initiative_runs WHERE initiative_id = ? AND owner = ?").run(initiativeId, owner);
      if (result.changes) this.event(initiativeId, "initiative_run_released", { owner });
    });
  }

  recordSystemFailure(input: { role: string; kind: string; attempt: number; runId?: string; reason: string }): string {
    const id = `system-failure-${randomUUID()}`;
    const reason = input.reason.replace(/[\r\n]+/g, " ").slice(0, 1000);
    this.db.prepare("INSERT INTO system_failures (id, role, kind, attempt, run_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      id, input.role, input.kind, input.attempt, input.runId ?? null, reason, now(),
    );
    return id;
  }

  systemFailures(): Array<{ id: string; role: string; kind: string; attempt: number; runId: string | null; reason: string; createdAt: string }> {
    return (this.db.prepare("SELECT * FROM system_failures ORDER BY created_at, id").all() as any[]).map((row) => ({
      id: row.id, role: row.role, kind: row.kind, attempt: row.attempt, runId: row.run_id, reason: row.reason, createdAt: row.created_at,
    }));
  }

  applyPlanEdit(initiativeId: string, patch: { nodeId: string; title?: string; description?: string; acceptanceCriteria?: string[]; dependsOn?: string[]; profileId?: string | null }): NodeRecord {
    return this.tx(() => {
      const node = this.getNode(patch.nodeId);
      if (!node || node.initiativeId !== initiativeId) throw new Error(`unknown node in initiative: ${patch.nodeId}`);
      if (["running", "reviewing", "integrating", "completed"].includes(node.status)) throw new Error(`cannot edit active node ${node.id}`);
      const nodes = this.listNodes(initiativeId);
      const proposed = nodes.map((candidate) => candidate.id === node.id ? {
        id: candidate.id,
        dependsOn: patch.dependsOn ?? candidate.dependsOn,
      } : { id: candidate.id, dependsOn: candidate.dependsOn });
      assertAcyclic(proposed);
      const fields: string[] = [];
      const values: unknown[] = [];
      if (patch.title !== undefined) { fields.push("title = ?"); values.push(patch.title); }
      if (patch.description !== undefined) { fields.push("description = ?"); values.push(patch.description); }
      if (patch.acceptanceCriteria !== undefined) { fields.push("acceptance_json = ?"); values.push(json(patch.acceptanceCriteria)); }
      if (patch.dependsOn !== undefined) { fields.push("dependencies_json = ?"); values.push(json(patch.dependsOn)); }
      if (patch.profileId !== undefined) { fields.push("profile_id = ?"); values.push(patch.profileId); }
      if (!fields.length) throw new Error("plan edit has no changes");
      fields.push("generation = generation + 1", "updated_at = ?");
      values.push(now(), node.id);
      this.db.prepare(`UPDATE nodes SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      this.db.prepare("INSERT INTO plan_edits (initiative_id, generation, patch_json, state, created_at) VALUES (?, ?, ?, 'applied', ?)").run(initiativeId, node.generation + 1, json(patch), now());
      this.event(initiativeId, "plan_edit_applied", patch);
      this.refreshReadyInternal(initiativeId);
      return this.getNode(node.id)!;
    });
  }

  pauseInitiative(initiativeId: string): void {
    const initiative = this.getNode(initiativeId);
    if (!initiative) throw new Error(`unknown initiative ${initiativeId}`);
    if (initiative.status === "running") this.transition(initiativeId, "paused");
    for (const node of this.listNodes(initiativeId)) {
      if (["pending", "ready"].includes(node.status)) this.transition(node.id, "paused");
    }
  }

  resumeInitiative(initiativeId: string): void {
    const initiative = this.getNode(initiativeId);
    if (!initiative) throw new Error(`unknown initiative ${initiativeId}`);
    if (initiative.status === "paused") this.transition(initiativeId, "running");
    for (const node of this.listNodes(initiativeId)) {
      if (node.status === "paused") this.transition(node.id, "pending");
    }
    this.refreshReady(initiativeId);
  }

  listReadyTasks(initiativeId?: string): NodeRecord[] {
    const sql = initiativeId
      ? "SELECT * FROM nodes WHERE initiative_id = ? AND level IN ('task','subtask') AND status = 'ready' ORDER BY created_at, id"
      : "SELECT * FROM nodes WHERE level IN ('task','subtask') AND status = 'ready' ORDER BY created_at, id";
    return (initiativeId ? this.db.prepare(sql).all(initiativeId) : this.db.prepare(sql).all()).map(rowToNode);
  }

  transition(id: string, to: NodeStatus, details: Record<string, unknown> = {}): NodeRecord {
    return this.tx(() => {
      const current = this.getNode(id);
      if (!current) throw new Error(`unknown node ${id}`);
      assertTransition(current.status, to);
      const timestamp = now();
      const clearLease = ["pending", "paused", "waiting", "recovering", "completed", "blocked", "failed"].includes(to);
      const hasRecoveryDetails = ["recoveryOwner", "recoveryScope", "requiredAction", "unblockCondition", "recoveryEpoch", "recoveryFingerprint"].some((key) => key in details);
      const preservesRecovery = ["waiting", "recovering", "blocked"].includes(to) || hasRecoveryDetails;
      const clearRecovery = ["pending", "ready", "running", "completed", "failed"].includes(to) && !hasRecoveryDetails;
      const value = (key: string, fallback: unknown): unknown => details[key] ?? fallback;
      this.db.prepare(`UPDATE nodes SET status = ?, updated_at = ?, failure = ?, lease_owner = ${clearLease ? "NULL" : "lease_owner"}, lease_until = ${clearLease ? "NULL" : "lease_until"}, recovery_owner = ?, recovery_scope = ?, required_action = ?, unblock_condition = ?, recovery_epoch = ?, recovery_fingerprint = ? WHERE id = ?`).run(
        to,
        timestamp,
        to === "failed" || to === "blocked" || preservesRecovery ? String(details.reason ?? current.failure ?? "") : current.failure,
        clearRecovery ? null : value("recoveryOwner", current.recoveryOwner),
        clearRecovery ? null : value("recoveryScope", current.recoveryScope),
        clearRecovery ? null : value("requiredAction", current.requiredAction),
        clearRecovery ? null : value("unblockCondition", current.unblockCondition),
        clearRecovery ? 0 : Number(value("recoveryEpoch", current.recoveryEpoch)),
        clearRecovery ? null : value("recoveryFingerprint", current.recoveryFingerprint),
        id,
      );
      this.event(id, "status_changed", { from: current.status, to, ...details });
      if (to === "completed") this.refreshReadyInternal(current.initiativeId);
      return this.getNode(id)!;
    });
  }

  claim(id: string, owner: string, leaseMs: number): NodeRecord {
    return this.tx(() => {
      const node = this.getNode(id);
      if (!node) throw new Error(`unknown node ${id}`);
      if (node.status !== "ready") throw new Error(`node ${id} is not ready`);
      const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
      this.db.prepare("UPDATE nodes SET status = 'leased', lease_owner = ?, lease_until = ?, attempt = attempt + 1, updated_at = ? WHERE id = ? AND status = 'ready'").run(owner, leaseUntil, now(), id);
      this.event(id, "lease_acquired", { owner, leaseUntil });
      return this.getNode(id)!;
    });
  }

  heartbeat(id: string, owner: string, leaseMs: number): void {
    const result = this.db.prepare("UPDATE nodes SET lease_until = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status IN ('leased','running','reviewing','integrating')").run(
      new Date(Date.now() + leaseMs).toISOString(), now(), id, owner,
    );
    if (!result.changes) throw new Error(`lease not owned for ${id}`);
  }

  recoverStaleAgentSessions(staleBefore = new Date()): string[] {
    return this.tx(() => {
      const cutoff = staleBefore.toISOString();
      const rows = this.db.prepare("SELECT id, agent_id, node_id FROM agent_sessions WHERE state = 'running' AND last_heartbeat < ?").all(cutoff) as any[];
      const nodeIds: string[] = [];
      for (const row of rows) {
        const timestamp = now();
        this.db.prepare("UPDATE agent_sessions SET state = 'interrupted', ended_at = ?, last_heartbeat = ?, error = ? WHERE id = ? AND state = 'running'").run(timestamp, timestamp, "agent heartbeat stale; supervisor recovered", row.id);
        this.db.prepare("UPDATE agents SET status = 'recovering', current_session_id = NULL, last_heartbeat = ?, failure_count = failure_count + 1, updated_at = ? WHERE id = ? AND current_session_id = ?").run(timestamp, timestamp, row.agent_id, row.id);
        if (row.node_id) {
          const node = this.getNode(row.node_id);
          if (node && ["leased", "running", "reviewing", "integrating"].includes(node.status)) {
            this.db.prepare("UPDATE nodes SET status = 'pending', lease_owner = NULL, lease_until = NULL, failure = ?, updated_at = ? WHERE id = ?").run("agent heartbeat stale; supervisor recovered", timestamp, row.node_id);
            nodeIds.push(row.node_id);
            this.event(row.node_id, "agent_session_interrupted", { agentId: row.agent_id, sessionId: row.id, reason: "heartbeat_stale" });
          }
        }
      }
      return nodeIds;
    });
  }

  recoverExpiredLeases(at = new Date()): string[] {
    return this.tx(() => {
      const cutoff = at.toISOString();
      const rows = this.db.prepare("SELECT id FROM nodes WHERE lease_until IS NOT NULL AND lease_until < ? AND status IN ('leased','running','reviewing','integrating')").all(cutoff) as any[];
      for (const row of rows) {
        const timestamp = now();
        this.db.prepare("UPDATE nodes SET status = 'pending', lease_owner = NULL, lease_until = NULL, failure = ?, updated_at = ? WHERE id = ?").run("lease expired; recovered", timestamp, row.id);
        const sessions = this.db.prepare("SELECT id, agent_id FROM agent_sessions WHERE node_id = ? AND state = 'running'").all(row.id) as any[];
        for (const session of sessions) {
          this.db.prepare("UPDATE agent_sessions SET state = 'interrupted', ended_at = ?, last_heartbeat = ?, error = ? WHERE id = ?").run(timestamp, timestamp, "lease expired; session abandoned", session.id);
          this.db.prepare("UPDATE agents SET status = 'recovering', current_session_id = NULL, last_heartbeat = ?, failure_count = failure_count + 1, updated_at = ? WHERE id = ? AND current_session_id = ?").run(timestamp, timestamp, session.agent_id, session.id);
          this.event(row.id, "agent_session_interrupted", { agentId: session.agent_id, sessionId: session.id, reason: "lease_expired" });
        }
        this.event(row.id, "lease_recovered", { cutoff });
      }
      return rows.map((row) => row.id);
    });
  }

  /**
   * Recover leases whose owner executor process is dead. Lease owners are
   * recorded as `executor-<pid>`; when that pid no longer exists (kill -9,
   * host reboot), the lease is dead weight: the session heartbeat detector
   * only covers worker/review sessions, so an `integrating` node would
   * otherwise wait for the full lease TTL. The TTL remains the backstop
   * against pid reuse.
   */
  recoverDeadOwnerLeases(at = new Date()): string[] {
    return this.tx(() => {
      const rows = this.db.prepare("SELECT id, lease_owner FROM nodes WHERE lease_owner IS NOT NULL AND status IN ('leased','running','reviewing','integrating')").all() as any[];
      const recovered: string[] = [];
      for (const row of rows) {
        const match = /^executor-(\d+)$/.exec(String(row.lease_owner));
        if (!match) continue;
        const pid = Number(match[1]);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code === "EPERM";
        }
        if (alive) continue;
        const timestamp = now();
        this.db.prepare("UPDATE nodes SET status = 'pending', lease_owner = NULL, lease_until = NULL, failure = ?, updated_at = ? WHERE id = ? AND lease_owner = ?").run("lease owner process dead; recovered", timestamp, row.id, row.lease_owner);
        const sessions = this.db.prepare("SELECT id, agent_id FROM agent_sessions WHERE node_id = ? AND state = 'running'").all(row.id) as any[];
        for (const session of sessions) {
          this.db.prepare("UPDATE agent_sessions SET state = 'interrupted', ended_at = ?, last_heartbeat = ?, error = ? WHERE id = ?").run(timestamp, timestamp, "lease owner process dead; session abandoned", session.id);
          this.db.prepare("UPDATE agents SET status = 'recovering', current_session_id = NULL, last_heartbeat = ?, failure_count = failure_count + 1, updated_at = ? WHERE id = ? AND current_session_id = ?").run(timestamp, timestamp, session.agent_id, session.id);
          this.event(row.id, "agent_session_interrupted", { agentId: session.agent_id, sessionId: session.id, reason: "lease_owner_dead" });
        }
        this.event(row.id, "lease_recovered", { owner: row.lease_owner, pid, reason: "owner_process_dead", at: at.toISOString() });
        recovered.push(row.id);
      }
      return recovered;
    });
  }

  /** Forget a node's worktree (used by `prune` after the directory is removed). */
  clearWorktree(id: string): void {
    this.db.prepare("UPDATE nodes SET worktree_path = NULL, updated_at = ? WHERE id = ?").run(now(), id);
    this.event(id, "worktree_pruned", {});
  }

  setWorktree(id: string, branch: string, worktreePath: string, baseCommit?: string): void {
    if (baseCommit) {
      this.db.prepare("UPDATE nodes SET branch = ?, worktree_path = ?, base_commit = ?, updated_at = ? WHERE id = ?").run(branch, worktreePath, baseCommit, now(), id);
    } else {
      this.db.prepare("UPDATE nodes SET branch = ?, worktree_path = ?, updated_at = ? WHERE id = ?").run(branch, worktreePath, now(), id);
    }
    this.event(id, "worktree_assigned", { branch, worktreePath, baseCommit: baseCommit ?? null });
  }

  setIntegratedCommit(id: string, commit: string): void {
    this.db.prepare("UPDATE nodes SET integrated_commit = ?, updated_at = ? WHERE id = ?").run(commit, now(), id);
    this.event(id, "integrated", { commit });
  }

  recordAttempt(input: { nodeId: string; attemptNo: number; role: string; state: string; outputPath?: string; evidence?: Record<string, unknown> }): string {
    const id = idFor("attempt");
    this.db.prepare("INSERT INTO attempts (id, node_id, attempt_no, role, state, output_path, evidence_json, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      id, input.nodeId, input.attemptNo, input.role, input.state, input.outputPath ?? null, json(input.evidence ?? {}), now(),
    );
    this.event(input.nodeId, "attempt_started", { attemptId: id, role: input.role, attemptNo: input.attemptNo });
    return id;
  }

  finishAttempt(id: string, state: string, evidence: Record<string, unknown> = {}): void {
    this.db.prepare("UPDATE attempts SET state = ?, evidence_json = ?, ended_at = ? WHERE id = ?").run(state, json(evidence), now(), id);
  }

  listAttempts(nodeId: string): Array<{ id: string; attemptNo: number; role: string; state: string; startedAt: string; endedAt: string | null }> {
    return (this.db.prepare("SELECT id, attempt_no, role, state, started_at, ended_at FROM attempts WHERE node_id = ? ORDER BY started_at, id").all(nodeId) as any[]).map((row) => ({
      id: row.id,
      attemptNo: row.attempt_no,
      role: row.role,
      state: row.state,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    }));
  }

  addReview(verdict: ReviewVerdict): void {
    this.db.prepare("INSERT INTO reviews (task_id, verdict, findings_json, evidence_json, created_at) VALUES (?, ?, ?, ?, ?)").run(
      verdict.taskId, verdict.verdict, json(verdict.findings), json(verdict.evidence), verdict.createdAt,
    );
    this.event(verdict.taskId, "review_recorded", verdict);
  }

  latestReview(taskId: string): ReviewVerdict | null {
    const row = this.db.prepare("SELECT * FROM reviews WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(taskId) as any;
    if (!row) return null;
    return { taskId, verdict: row.verdict, findings: parseJson(row.findings_json, []), evidence: parseJson(row.evidence_json, {}), createdAt: row.created_at };
  }

  addMessage(initiativeId: string, body: string): number {
    const result = this.db.prepare("INSERT INTO messages (initiative_id, body, state, created_at) VALUES (?, ?, 'pending', ?)").run(initiativeId, body, now());
    this.event(initiativeId, "manager_message_added", { messageId: Number(result.lastInsertRowid) });
    return Number(result.lastInsertRowid);
  }

  pendingMessages(initiativeId: string): Array<{ id: number; body: string; createdAt: string }> {
    return this.db.prepare("SELECT id, body, created_at FROM messages WHERE initiative_id = ? AND state = 'pending' ORDER BY id").all(initiativeId).map((row: any) => ({ id: row.id, body: row.body, createdAt: row.created_at }));
  }

  markMessagesDelivered(ids: number[]): void {
    if (!ids.length) return;
    this.tx(() => {
      for (const id of ids) this.db.prepare("UPDATE messages SET state = 'delivered', delivered_at = ? WHERE id = ? AND state = 'pending'").run(now(), id);
    });
  }

  addPlanEdit(initiativeId: string, generation: number, patch: Record<string, unknown>): number {
    const result = this.db.prepare("INSERT INTO plan_edits (initiative_id, generation, patch_json, state, created_at) VALUES (?, ?, ?, 'pending', ?)").run(initiativeId, generation, json(patch), now());
    this.event(initiativeId, "plan_edit_added", { editId: Number(result.lastInsertRowid), generation });
    return Number(result.lastInsertRowid);
  }

  recordMetric(metric: RunMetric): string {
    validateMetric(metric);
    if (!this.getNode(metric.initiativeId)) throw new Error(`unknown initiative for metric: ${metric.initiativeId}`);
    const id = metric.id ?? metricId();
    this.db.prepare("INSERT INTO metrics (id, initiative_id, node_id, run_id, role, outcome, duration_ms, counters_json, dimensions_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      metric.initiativeId,
      metric.nodeId ?? null,
      metric.runId,
      metric.role,
      metric.outcome,
      metric.durationMs,
      json(metric.counters ?? {}),
      json(metric.dimensions ?? {}),
      now(),
    );
    return id;
  }

  metrics(initiativeId: string): MetricRow[] {
    return this.db.prepare("SELECT * FROM metrics WHERE initiative_id = ? ORDER BY created_at, id").all(initiativeId).map((row: any) => ({
      id: row.id,
      initiativeId: row.initiative_id,
      nodeId: row.node_id,
      runId: row.run_id,
      role: row.role,
      outcome: row.outcome,
      durationMs: row.duration_ms,
      counters: parseJson(row.counters_json, {}),
      dimensions: parseJson(row.dimensions_json, {}),
      createdAt: row.created_at,
    }));
  }

  metricSummary(initiativeId: string): MetricSummary {
    const rows = this.metrics(initiativeId);
    const nodesByStatus: Record<string, number> = {};
    for (const node of this.listNodes(initiativeId)) nodesByStatus[node.status] = (nodesByStatus[node.status] ?? 0) + 1;
    const outcomes: Record<string, number> = {};
    const counters: Record<string, number> = {};
    const overall = newAggregate();
    const byRole: Record<string, AggregateState> = {};
    const byProfile: Record<string, AggregateState> = {};
    const byModel: Record<string, AggregateState> = {};
    const byProfileModel: Record<string, AggregateState> = {};
    for (const row of rows) {
      outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
      for (const [name, value] of Object.entries(row.counters ?? {})) counters[name] = (counters[name] ?? 0) + Number(value);
      const profile = row.dimensions?.profile ?? "unknown";
      const model = row.dimensions?.model ?? "unknown";
      addMetricToAggregate(overall, row);
      addMetricToAggregate(byRole[row.role] ?? (byRole[row.role] = newAggregate()), row);
      addMetricToAggregate(byProfile[profile] ?? (byProfile[profile] = newAggregate(profile)), row);
      addMetricToAggregate(byModel[model] ?? (byModel[model] = newAggregate(undefined, model)), row);
      const profileModel = `${profile} @ ${model}`;
      addMetricToAggregate(byProfileModel[profileModel] ?? (byProfileModel[profileModel] = newAggregate(profile, model)), row);
    }
    const finalize = (groups: Record<string, AggregateState>): Record<string, MetricAggregate> => Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, finalizeAggregate(value)]));
    return {
      initiativeId,
      metricCount: rows.length,
      nodesByStatus,
      outcomes,
      overall: finalizeAggregate(overall),
      byRole: finalize(byRole),
      byProfile: finalize(byProfile),
      byModel: finalize(byModel),
      byProfileModel: finalize(byProfileModel),
      counters,
      recoveryCount: outcomes.recovery ?? 0,
    };
  }

  events(nodeId?: string): EventRecord[] {
    const rows = nodeId ? this.db.prepare("SELECT * FROM events WHERE node_id = ? ORDER BY id").all(nodeId) : this.db.prepare("SELECT * FROM events ORDER BY id").all();
    return rows.map((row: any) => ({ id: row.id, nodeId: row.node_id, kind: row.kind, payload: parseJson(row.payload_json, {}), createdAt: row.created_at }));
  }

  recentEvents(limit: number): EventRecord[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("event limit must be a positive safe integer");
    const rows = this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as any[];
    return rows.map((row) => ({ id: row.id, nodeId: row.node_id, kind: row.kind, payload: parseJson(row.payload_json, {}), createdAt: row.created_at }));
  }

  eventsSince(afterId = 0, initiativeId?: string, limit = 100): EventRecord[] {
    const boundedLimit = Math.min(500, Math.max(1, limit));
    let rows: any[];
    if (initiativeId) {
      rows = this.db.prepare(`SELECT e.* FROM events e WHERE e.id > ? AND (e.node_id = ? OR e.node_id IN (SELECT id FROM nodes WHERE initiative_id = ?)) ORDER BY e.id LIMIT ?`).all(afterId, initiativeId, initiativeId, boundedLimit) as any[];
    } else {
      rows = this.db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?").all(afterId, boundedLimit) as any[];
    }
    return rows.map((row) => ({ id: row.id, nodeId: row.node_id, kind: row.kind, payload: publicFeedValue(parseJson(row.payload_json, {})) as Record<string, unknown>, createdAt: row.created_at }));
  }

  eventCursor(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS cursor FROM events").get() as any;
    return Number(row?.cursor ?? 0);
  }
}
