# Observability

Metrics are local, durable observations stored in the same SQLite state directory as the initiative. They are derived from Pi JSON events and executor boundaries; they do not replace the append-only lifecycle event log.

## Captured data

Each run observation contains only bounded identifiers (`initiativeId`, `nodeId`, `runId`, role, outcome), duration, counters, and bounded dimensions such as profile, sandbox backend, model, gate basename, and status. Prompts, raw tool arguments, credentials, filesystem paths, and raw model output are not metric labels. Raw stdout/stderr remain separate attempt artifacts for debugging and are not exported as metric labels.

Counters include, when Pi reports them:

- `input_tokens`, `output_tokens`, `reasoning_tokens`;
- `cache_read_tokens`, `cache_write_tokens`, `total_tokens`;
- `runtime_ms` / wall-clock duration;
- `ttft_ms` — time from process start to the first visible assistant output;
- `generation_ms` — time from first output to process end;
- `tokens_per_second` — output tokens divided by generation time;
- `tool_calls` and `tool_errors`;
- stdout/stderr byte counts;
- `cost_usd` / `api_cost_usd`, when known;
- `codex_credits`, when a Codex credit rate is configured;
- gate output bytes.

Each row is tied to `initiativeId`, `nodeId`, `runId`, role, `profile`, backend, and concrete `model`. Summaries are available as `overall`, `byRole`, `byProfile`, `byModel`, and `byProfileModel`. Every group exposes token-category totals, wall-clock totals/p50/p95, TTFT p50/p95, TPS average/p50/p95, and cost totals.

API cost precedence is: provider/Pi-reported USD usage, profile pricing, `LAO_MODEL_PRICING_JSON` model pricing, then unknown. The legacy `costUsd` aggregate is an alias for `apiCostUsd`. Codex subscription usage is reported independently as `codexCredits`; it is an estimate of included/credit usage, not a USD charge. Local-pool runs are recorded as API cost `0` and zero Codex credits. Unknown API or credit pricing is not guessed: the corresponding `*Complete` field is false and `*UnknownRuns` shows the missing observations. Rate configuration uses per-million-token fields, for example:

```bash
export LAO_MODEL_PRICING_JSON='{"openai-codex/gpt-5.6-luna":{"inputPerMillionUsd":0.2,"cacheReadPerMillionUsd":0.02,"outputPerMillionUsd":1.2,"codexInputCreditsPerMillion":5,"codexCacheReadCreditsPerMillion":0.5,"codexOutputCreditsPerMillion":30}}'
```

Outcomes include `success`, `failure`, `timeout`, `blocked`, `recovery`, `pass`, and `fail`. Role summaries preserve run count, success/failure count, total duration, p50 duration, and p95 duration. Percentiles are calculated from the observations retained for the initiative, not from an unbounded process counter.

Recovery is also visible in the durable event stream. Relevant privacy-filtered lifecycle events include same-session feedback/repair, manager and architect recovery decisions, `dependency_preflight_blocked`, `integration_recovery_scheduled`/`integration_recovery_exhausted`, `auto_unblocked`, stale-session recovery, and supervisor circuit-breaker exhaustion. Event payloads contain bounded reasons, owners, scopes, recovery epochs/fingerprints, and counts; they never contain prompts, credentials, paths, or raw provider output. `progress` exposes task-local blocker fields (`owner`, `scope`, `requiredAction`, `unblockCondition`, `recoveryEpoch`) so a blocked branch can be resumed without reopening unrelated work.

## CLI

```bash
node --experimental-strip-types src/cli.ts metrics <initiative-id>
node --experimental-strip-types src/cli.ts metrics <initiative-id> --json
node --experimental-strip-types src/cli.ts metrics <initiative-id> --prometheus
node --experimental-strip-types src/cli.ts feed <initiative-id> --follow
node --experimental-strip-types src/cli.ts agents <initiative-id>
node --experimental-strip-types src/cli.ts agent-sessions <initiative-id>
node --experimental-strip-types src/cli.ts supervise --follow
```

Agent identities are durable logical records, separate from Pi processes and task attempts. Each session has a run ID, profile/model, heartbeat, state, exit code, and bounded handoff status. The supervisor is a non-LLM recovery loop: it detects stale heartbeats and expired leases, interrupts abandoned sessions, requeues within the profile attempt bound, blocks exhausted tasks, and refreshes the DAG. The local pool limit remains enforced because the supervisor itself never consumes an agent slot.

`feed` is cursor-based and privacy-filtered. It omits prompts, raw outputs, stdout/stderr, credentials, and reasoning fields. The TUI dashboard shows active identities, sessions, heartbeat age, supervisor state, recovery ownership, and recent event IDs. `progress` and `status` do not make agent/provider calls; they read SQLite and perform only bounded local artifact checks needed for auto-unblock.

`--prometheus` emits dependency-free OpenMetrics-compatible text with bounded role/profile/model/outcome labels and overall/grouped runtime, TTFT, TPS, token, and API-cost/Codex-credit series. It is intended for a local scrape or a short-lived bridge; there is no built-in HTTP listener.

## TUI and MCP

The dashboard displays the current metric count, recovery count, and outcome totals above the task tree. The custom MCP server exposes a `metrics` tool with `initiativeId` and optional `prometheus: true`; `resume` accepts a task/branch node ID for scoped recovery or an initiative ID for an explicit whole-initiative resume.

## Local MLflow tracing

The runtime also exports bounded traces to a local MLflow Tracking Server through the `mlflow-tracing` TypeScript SDK. The default endpoint is `http://127.0.0.1:5000`; override it with `LAO_MLFLOW_TRACKING_URI` or `MLFLOW_TRACKING_URI`. The experiment ID can be set with `LAO_MLFLOW_EXPERIMENT_ID` or `MLFLOW_EXPERIMENT_ID`. `LAO_MLFLOW_ENABLED=0` disables export without changing task execution.

Start the local server and provision the dedicated experiment with:

```bash
bash scripts/start-local-mlflow.sh
```

The server stores its SQLite backend and proxied artifacts under `~/.local/state/loom-and-order/mlflow` (or the configured `LAO_STATE_DIR`). The exporter is fail-safe: MLflow outages never fail a manager, worker, reviewer, gate, or scheduler operation. `LAO_MLFLOW_DEBUG=1` adds diagnostics; the underlying SDK may still emit a concise exporter error for a failed request.

A trace contains nested spans for the scheduler/initiative, manager planning/checkpoints, worker/reviewer/researcher/release Pi runs, tool calls observed in Pi JSON events, and repository gates. Each Pi role span is tagged with its `profile` and concrete `model` and contains wall-clock runtime, TTFT, generation time, TPS, token-category counters, cost and cost source, exit status, and bounded event summaries. Prompts, raw assistant output, tool arguments/results, credentials, and filesystem paths are redacted or represented by bounded metadata before export. Sanitized `pi-events.json` is uploaded as a trace artifact after the root span completes. Raw stdout/stderr remain local attempt artifacts.

Privacy boundaries are deliberate: prompts are not recorded as span inputs; hidden reasoning fields are redacted; visible message text and tool event content are represented by metadata; credential-like keys and bearer/basic values are redacted; no credentials or raw filesystem paths are metric labels. MLflow trace exports are local by default and never use the previously configured remote server. SQLite lifecycle events and system-failure records remain authoritative when MLflow is disabled or unavailable.

## Real-run verification status

Deterministic fake-provider tests cover process exit failure, timeout, stale heartbeat, lease recovery, Store reopen, duplicate supervisor passes, and bounded blocking. A real GPT-6 Luna low-thinking smoke launch must still have `LAO_PI_SANDBOX_EXTENSION` configured; the launcher intentionally blocks before provider access when the reviewed sandbox extension is absent.

## Deliberate limits

SQLite metrics remain the durable source for initiative state and percentiles. MLflow is an observability projection and may be incomplete during an outage. Token usage is whatever Pi reports in its JSON events and may be absent for providers that do not report it. The system does not claim provider billing accuracy or absolute delivery guarantees.
