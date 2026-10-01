import { randomUUID } from "node:crypto";

export type MetricRole = "manager" | "worker" | "reviewer" | "researcher" | "release" | "gate" | "scheduler";
export type MetricOutcome = "success" | "failure" | "timeout" | "blocked" | "recovery" | "pass" | "fail";

export interface RunMetric {
  id?: string;
  initiativeId: string;
  nodeId?: string | null;
  runId: string;
  role: MetricRole;
  outcome: MetricOutcome;
  durationMs: number;
  counters?: Record<string, number>;
  dimensions?: Record<string, string>;
}

export interface MetricRow extends RunMetric {
  id: string;
  createdAt: string;
}

export interface MetricAggregate {
  profile?: string;
  model?: string;
  runs: number;
  success: number;
  failure: number;
  totalDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p50TtftMs: number | null;
  p95TtftMs: number | null;
  avgTokensPerSecond: number | null;
  p50TokensPerSecond: number | null;
  p95TokensPerSecond: number | null;
  /** Backward-compatible alias for apiCostUsd. */
  costUsd: number;
  costComplete: boolean;
  costKnownRuns: number;
  costUnknownRuns: number;
  apiCostUsd: number;
  apiCostComplete: boolean;
  apiCostKnownRuns: number;
  apiCostUnknownRuns: number;
  codexCredits: number;
  codexCreditsComplete: boolean;
  codexCreditsKnownRuns: number;
  codexCreditsUnknownRuns: number;
  counters: Record<string, number>;
}

export interface MetricSummary {
  initiativeId: string;
  metricCount: number;
  nodesByStatus: Record<string, number>;
  outcomes: Record<string, number>;
  overall: MetricAggregate;
  byRole: Record<string, MetricAggregate>;
  byProfile: Record<string, MetricAggregate>;
  byModel: Record<string, MetricAggregate>;
  byProfileModel: Record<string, MetricAggregate>;
  counters: Record<string, number>;
  recoveryCount: number;
}

const SAFE_DIMENSIONS = new Set(["profile", "backend", "model", "outcome", "gate", "status"]);
const FORBIDDEN_DIMENSION_WORDS = ["prompt", "secret", "password", "credential", "path", "token"];

export function validateMetric(metric: RunMetric): void {
  if (!metric.initiativeId || !metric.runId) throw new Error("metric needs initiativeId and runId");
  if (!Number.isFinite(metric.durationMs) || metric.durationMs < 0) throw new Error("metric duration must be finite and non-negative");
  if (!metric.role || !metric.outcome) throw new Error("metric needs role and outcome");
  const dimensions = metric.dimensions ?? {};
  if (Object.keys(dimensions).length > 8) throw new Error("metric dimensions are limited to 8 keys");
  for (const [key, value] of Object.entries(dimensions)) {
    if (!SAFE_DIMENSIONS.has(key)) throw new Error(`metric dimension is not allowed: ${key}`);
    if (FORBIDDEN_DIMENSION_WORDS.some((word) => key.toLowerCase().includes(word))) throw new Error(`metric dimension may contain sensitive data: ${key}`);
    if (value.length > 64 || /[\r\n]/.test(value)) throw new Error(`metric dimension value is invalid: ${key}`);
  }
  for (const [key, value] of Object.entries(metric.counters ?? {})) {
    if (!/^[a-z][a-z0-9_]{0,48}$/.test(key)) throw new Error(`metric counter name is invalid: ${key}`);
    if (!Number.isFinite(value)) throw new Error(`metric counter is not finite: ${key}`);
  }
}

export function metricId(): string {
  return `metric-${randomUUID()}`;
}

export function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1));
  return ordered[index];
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function aggregateMetrics(name: string, aggregate: MetricAggregate, labels = ""): string[] {
  const lines: string[] = [];
  const metric = (metricName: string, value: number, metricLabels = labels): void => lines.push(`pi_epics_${metricName}${metricLabels} ${Number.isFinite(value) ? value : 0}`);
  metric(`${name}_runs_total`, aggregate.runs);
  metric(`${name}_success_total`, aggregate.success);
  metric(`${name}_failure_total`, aggregate.failure);
  metric(`${name}_wall_clock_ms_total`, aggregate.totalDurationMs);
  metric(`${name}_wall_clock_ms_p50`, aggregate.p50DurationMs);
  metric(`${name}_wall_clock_ms_p95`, aggregate.p95DurationMs);
  metric(`${name}_ttft_ms_p50`, aggregate.p50TtftMs ?? 0);
  metric(`${name}_ttft_ms_p95`, aggregate.p95TtftMs ?? 0);
  metric(`${name}_tokens_per_second_avg`, aggregate.avgTokensPerSecond ?? 0);
  metric(`${name}_tokens_per_second_p50`, aggregate.p50TokensPerSecond ?? 0);
  metric(`${name}_tokens_per_second_p95`, aggregate.p95TokensPerSecond ?? 0);
  metric(`${name}_cost_usd_total`, aggregate.costUsd);
  metric(`${name}_cost_unknown_runs`, aggregate.costUnknownRuns);
  metric(`${name}_api_cost_usd_total`, aggregate.apiCostUsd);
  metric(`${name}_api_cost_unknown_runs`, aggregate.apiCostUnknownRuns);
  metric(`${name}_codex_credits_total`, aggregate.codexCredits);
  metric(`${name}_codex_credits_unknown_runs`, aggregate.codexCreditsUnknownRuns);
  return lines;
}

export function prometheus(summary: MetricSummary): string {
  const lines: string[] = [];
  const metric = (name: string, value: number, labels = ""): void => lines.push(`pi_epics_${name}${labels} ${Number.isFinite(value) ? value : 0}`);
  metric("metrics_total", summary.metricCount);
  metric("recoveries_total", summary.recoveryCount);
  for (const [outcome, count] of Object.entries(summary.outcomes)) metric("outcomes_total", count, `{outcome="${escapeLabel(outcome)}"}`);
  lines.push(...aggregateMetrics("overall", summary.overall));
  for (const [role, data] of Object.entries(summary.byRole)) {
    const label = `{role="${escapeLabel(role)}"}`;
    metric("runs_total", data.runs, label);
    metric("success_total", data.success, label);
    metric("failure_total", data.failure, label);
    metric("duration_ms_p50", data.p50DurationMs, label);
    metric("duration_ms_p95", data.p95DurationMs, label);
    metric("ttft_ms_p50", data.p50TtftMs ?? 0, label);
    metric("tokens_per_second_avg", data.avgTokensPerSecond ?? 0, label);
    metric("cost_usd_total", data.costUsd, label);
    metric("api_cost_usd_total", data.apiCostUsd, label);
    metric("codex_credits_total", data.codexCredits, label);
  }
  for (const data of Object.values(summary.byProfileModel)) {
    const label = `{profile="${escapeLabel(data.profile ?? "unknown")}",model="${escapeLabel(data.model ?? "unknown")}"}`;
    lines.push(...aggregateMetrics("agent", data, label));
  }
  for (const [name, value] of Object.entries(summary.counters)) metric(`counter_${name}`, value);
  return `${lines.join("\n")}\n`;
}
