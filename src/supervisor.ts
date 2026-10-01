import type { ProfileManifest } from "./profiles.ts";
import { Store } from "./store.ts";

export interface SupervisorOptions {
  profiles: Record<string, ProfileManifest>;
  intervalMs?: number;
  staleHeartbeatMs?: number;
  /** Called after a complete recovery/rollup cycle, outside all node leases. */
  onCycle?: () => void;
}

export interface SupervisorReport {
  recovered: string[];
  blocked: string[];
  staleSessions: string[];
  refreshedInitiatives: string[];
  cursor: number;
  at: string;
}

export class Supervisor {
  readonly store: Store;
  readonly options: SupervisorOptions;
  private timer: NodeJS.Timeout | null = null;
  private lastReport: SupervisorReport | null = null;

  constructor(store: Store, options: SupervisorOptions) {
    this.store = store;
    this.options = options;
  }

  runOnce(at = new Date()): SupervisorReport {
    const staleBefore = new Date(at.getTime() - (this.options.staleHeartbeatMs ?? 30_000));
    const staleSessions = this.store.recoverStaleAgentSessions(staleBefore);
    const recovered = [...new Set([...staleSessions, ...this.store.recoverExpiredLeases(at), ...this.store.recoverDeadOwnerLeases(at)])];
    const blocked: string[] = [];
    const refreshedInitiatives = new Set<string>();
    for (const nodeId of recovered) {
      const node = this.store.getNode(nodeId);
      if (!node) continue;
      refreshedInitiatives.add(node.initiativeId);
      const profile = this.options.profiles[node.profileId ?? "worker"];
      const maxAttempts = profile?.maxAttempts ?? 3;
      if (node.status === "pending" && node.attempt >= maxAttempts) {
        this.store.transition(node.id, "blocked", { reason: `supervisor exhausted attempts after recovery (${node.attempt}/${maxAttempts})`, recoveryOwner: "supervisor", recoveryScope: "task", requiredAction: "investigate repeated supervisor recovery failures", unblockCondition: "root cause resolved", recoveryEpoch: node.recoveryEpoch + 1 });
        blocked.push(node.id);
      }
    }
    for (const initiative of this.store.listInitiatives()) {
      this.store.unblockWaiting(initiative.id);
      this.store.refreshReady(initiative.id);
      this.store.refreshRollups(initiative.id);
      refreshedInitiatives.add(initiative.id);
    }
    const report: SupervisorReport = {
      recovered,
      blocked,
      staleSessions,
      refreshedInitiatives: [...refreshedInitiatives],
      cursor: this.store.eventCursor(),
      at: at.toISOString(),
    };
    for (const initiativeId of report.refreshedInitiatives) {
      this.store.recordEvent(initiativeId, "supervisor_cycle", { recovered: report.recovered.length, blocked: report.blocked.length, staleSessions: report.staleSessions.length });
    }
    try { this.options.onCycle?.(); } catch { /* automatic GC is a best-effort scheduler side effect */ }
    report.cursor = this.store.eventCursor();
    this.lastReport = report;
    return report;
  }

  start(): void {
    if (this.timer) return;
    this.runOnce();
    this.timer = setInterval(() => this.runOnce(), this.options.intervalMs ?? 10_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  status(): { running: boolean; intervalMs: number; staleHeartbeatMs: number; lastReport: SupervisorReport | null; activeSessions: number } {
    return {
      running: this.timer !== null,
      intervalMs: this.options.intervalMs ?? 10_000,
      staleHeartbeatMs: this.options.staleHeartbeatMs ?? 30_000,
      lastReport: this.lastReport,
      activeSessions: this.store.listAgentSessions(undefined, "running").length,
    };
  }
}
