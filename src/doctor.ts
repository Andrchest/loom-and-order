import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface BlockedTask {
  id: string;
  reason: string | null;
}

export interface StateDiagnosis {
  sqliteIntegrityCheck: string[];
  nodeCountsByStatus: Record<string, number>;
  eventCount: number;
  orphanedWorktrees: string[];
  blockedTasks: BlockedTask[];
  healthy: boolean;
}

interface DatabaseDiagnosis {
  sqliteIntegrityCheck: string[];
  nodeCountsByStatus: Record<string, number>;
  eventCount: number;
  blockedTasks: BlockedTask[];
  diagnosticFailure: boolean;
  worktreePaths: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function diagnosticError(prefix: string, error: unknown): string {
  return `${prefix}: ${errorMessage(error)}`;
}

function relativeStatePath(stateDir: string, path: string): string {
  return relative(stateDir, path).split("\\").join("/");
}

function managedWorktreeDirectories(stateDir: string): { paths: string[]; error: string | null } {
  const root = join(stateDir, "worktrees");
  try {
    const paths: string[] = [];
    for (const initiative of readdirSync(root, { withFileTypes: true })) {
      if (!initiative.isDirectory()) continue;
      const initiativePath = join(root, initiative.name);
      for (const node of readdirSync(initiativePath, { withFileTypes: true })) {
        if (node.isDirectory()) paths.push(join(initiativePath, node.name));
      }
    }
    return { paths: paths.sort((left, right) => left.localeCompare(right)), error: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { paths: [], error: null };
    return { paths: [], error: diagnosticError("worktree discovery failed", error) };
  }
}

interface ReadOnlyDatabaseSnapshot {
  path: string;
  cleanup(): void;
}

function snapshotDatabase(databasePath: string): ReadOnlyDatabaseSnapshot {
  const directory = mkdtempSync(join(tmpdir(), "loom-and-order-doctor-"));
  const snapshotPath = join(directory, "state.sqlite3");
  try {
    copyFileSync(databasePath, snapshotPath);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        copyFileSync(`${databasePath}${suffix}`, `${snapshotPath}${suffix}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return {
      path: snapshotPath,
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function openDatabaseDiagnosis(stateDir: string): DatabaseDiagnosis {
  const databasePath = join(stateDir, "state.sqlite3");
  const empty: DatabaseDiagnosis = {
    sqliteIntegrityCheck: [],
    nodeCountsByStatus: {},
    eventCount: 0,
    blockedTasks: [],
    diagnosticFailure: false,
    worktreePaths: [],
  };

  let database: DatabaseSync | undefined;
  let snapshot: ReadOnlyDatabaseSnapshot | undefined;
  try {
    // Copy the database and any WAL inputs outside stateDir before opening it.
    // A read-only SQLite connection can still create -wal/-shm sidecars, while
    // immutable mode avoids those sidecars by ignoring an uncheckpointed WAL.
    // The private snapshot provides both current WAL visibility and no state
    // directory mutation; the database itself is opened read-only.
    snapshot = snapshotDatabase(databasePath);
    database = new DatabaseSync(snapshot.path, { readOnly: true });
    const integrityRows = database.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    empty.sqliteIntegrityCheck = integrityRows.map((row) => String(row.integrity_check ?? ""));
    if (!empty.sqliteIntegrityCheck.length) {
      empty.sqliteIntegrityCheck = ["integrity check returned no result"];
      empty.diagnosticFailure = true;
    }

    const countRows = database.prepare("SELECT status, COUNT(*) AS count FROM nodes GROUP BY status ORDER BY status").all() as Array<{ status: unknown; count: unknown }>;
    for (const row of countRows) empty.nodeCountsByStatus[String(row.status)] = Number(row.count);

    const eventRow = database.prepare("SELECT COUNT(*) AS count FROM events").get() as { count?: unknown } | undefined;
    empty.eventCount = Number(eventRow?.count ?? 0);

    const blockedRows = database.prepare("SELECT id, failure FROM nodes WHERE level IN ('task', 'subtask') AND status = 'blocked' ORDER BY id").all() as Array<{ id: unknown; failure: unknown }>;
    empty.blockedTasks = blockedRows.map((row) => ({ id: String(row.id), reason: typeof row.failure === "string" ? row.failure : null }));

    const worktreeRows = database.prepare("SELECT worktree_path FROM nodes WHERE worktree_path IS NOT NULL").all() as Array<{ worktree_path: unknown }>;
    empty.worktreePaths = worktreeRows
      .filter((row) => typeof row.worktree_path === "string" && row.worktree_path.length > 0)
      .map((row) => isAbsolute(row.worktree_path as string) ? resolve(row.worktree_path as string) : resolve(stateDir, row.worktree_path as string));
  } catch (error) {
    empty.sqliteIntegrityCheck = [diagnosticError("database diagnosis failed", error)];
    empty.diagnosticFailure = true;
  } finally {
    try { database?.close(); } catch { /* preserve the diagnosis */ }
    try { snapshot?.cleanup(); } catch { /* preserve the diagnosis */ }
  }
  return empty;
}

/**
 * Inspect durable state without opening Store or ApplicationService.
 * Every filesystem and database operation is read-only; failures become an
 * unhealthy report so the CLI can still emit its stable JSON shape.
 */
export function diagnoseState(stateDirectory: string): StateDiagnosis {
  const stateDir = resolve(stateDirectory);
  const database = openDatabaseDiagnosis(stateDir);
  const worktrees = managedWorktreeDirectories(stateDir);
  const referenced = new Set(database.worktreePaths);
  const orphanedWorktrees = worktrees.paths
    .filter((path) => !referenced.has(resolve(path)))
    .map((path) => relativeStatePath(stateDir, path));
  if (worktrees.error) database.sqliteIntegrityCheck.push(worktrees.error);

  const healthy = !database.diagnosticFailure
    && !worktrees.error
    && database.sqliteIntegrityCheck.length > 0
    && database.sqliteIntegrityCheck.every((result) => result === "ok")
    && orphanedWorktrees.length === 0
    && database.blockedTasks.length === 0;
  return {
    sqliteIntegrityCheck: database.sqliteIntegrityCheck,
    nodeCountsByStatus: database.nodeCountsByStatus,
    eventCount: database.eventCount,
    orphanedWorktrees,
    blockedTasks: database.blockedTasks,
    healthy,
  };
}

export const diagnose = diagnoseState;
export const doctor = diagnoseState;
