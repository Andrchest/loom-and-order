# Loom & Order

A durable local multi-agent runtime for Pi. Submit one prompt; an Architect defines the design contract, a Manager creates/routes the initiative DAG, workers execute isolated tasks, reviewers verify them, and passing commits are integrated into an epic branch.

## Status

This repository is the new implementation, separate from `/home/andreipc/auto-work`. The first slice is a local Linux MVP with:

- durable SQLite state and append-only events;
- `initiative → epic → task → subtask` hierarchy and dependency validation;
- declarative architect/manager/worker/reviewer/researcher/release Pi profiles with explicit model selection (the repo ships two example worker profiles; role profiles are operator-created);
- task-specific Git worktrees;
- mandatory diff/acceptance and test/gate review;
- automatic integration into an isolated epic branch after review;
- CLI, terminal dashboard, and opt-in stdio MCP control;
- trusted-local Pi profiles by default, with per-run isolated Pi directories and task-specific Git worktrees;
- optional sandbox adapter contracts, with `@erichll/pi-sandbox` available for explicit untrusted-repository runs and Docker Sandboxes (`sbx`) planned as a later backend.

## Features

What v1 gives you, beyond the basic loop:

- **Real parallelism** — all ready tasks dispatch concurrently (`Promise.all`); independent tasks in one epic run side by side, cross-epic dependencies materialize by merging completed producer commits into the dependent base.
- **Versioned architecture contracts** — the Architect's plan is a persisted, revisable artifact (`architecture-contract get|list|create`); preflight enforces exactly-one-producer per artifact and rejects self-requiring tasks before any worker runs.
- **Durable operator inputs** — `message` (guidance injected into the next worker prompt) and `plan-edit` (patch an existing node) are append-only, evented, and safe while work is in flight.
- **Crash resilience** — leases with three independent recovery triggers (30 s stale-session heartbeat, dead-owner PID probe, 90-min TTL backstop) and idempotent integration: a crash between merge and completion re-completes on the existing merge commit in ~10 s, never duplicating work. Verified with `kill -9` in worker, review, and integration phases ([docs/dogfood-crash-chaos-2026-09-30.md](docs/dogfood-crash-chaos-2026-09-30.md)).
- **Observability** — append-only event log (`events`, `feed --follow`), per-session logs (`logs --follow`), `progress --watch`, terminal `dashboard`, `metrics` (JSON / Prometheus / `--out`), `agents`, `agent-sessions`, `doctor`, `supervisor-status`.
- **Profiles** — declarative role profiles (model, tools, skills, sandbox, timeout, attempts); `profiles list|validate|create|clone`, per-agent overrides, isolated toolchain cache (`toolchain status|update`).
- **Interfaces** — CLI, TUI dashboard, and opt-in stdio MCP server over one application service.
- **Trust modes** — `trusted-local` by default; explicit `pi-sandbox` (bubblewrap) for hostile repositories; `sbx` planned.

## Design

Read [docs/architecture.md](docs/architecture.md), [docs/protocol.md](docs/protocol.md), and [docs/operations.md](docs/operations.md) before changing the runtime. Operators and agents: the [operating skill](skills/loom-and-order/SKILL.md) is the how-to reference (commands, crash playbooks, blocker triage, delivery).

## Requirements

- Node.js 22.22+ for the runner bootstrap (the managed agent bundle uses Node 24 LTS);
- Git and `tar`;
- network access to npm and nodejs.org for the managed toolchain bundle;
- Linux only for the optional bubblewrap sandbox backend;
- `@erichll/pi-sandbox` plus `bubblewrap`, `socat`, and `ripgrep` only when using an explicit sandbox profile.

The project installs Pi and selected extensions only into its own toolchain cache, never into global npm or `~/.pi/agent`; it does not change global settings or copy host credentials. Every run gets a separate `PI_CODING_AGENT_DIR` and session directory under the configured state directory. A profile explicitly names its Pi binary, backend, skills, extensions, tools, network policy, and provider policy.

## Quickstart

```bash
git clone <repo> && cd Loom & Order
npm install

# 1. Submit a prompt (Architect + Manager build the DAG, then workers start)
node --experimental-strip-types src/cli.ts submit --repo /path/to/target --prompt "Build ..."

# 2. Watch it
node --experimental-strip-types src/cli.ts progress <initiative-id> --watch --once

# 3. If something looks off, diagnose
node --experimental-strip-types src/cli.ts doctor
node --experimental-strip-types src/cli.ts events --limit 50
node --experimental-strip-types src/cli.ts logs <initiative-id> --follow

# 4. Recover a stuck task
node --experimental-strip-types src/cli.ts resume <task-or-initiative-id>
```

Install globally for the `lao` binary (same entry point): `npm link` or `npm install -g .`

### Role profiles

The repository ships two **example worker profiles** as templates — `profiles/example-local.json` (local model via `LAO_LOCAL_MODEL`) and `profiles/example-subscription.json` (subscription model, e.g. Codex). It ships no other role profiles: clone an example into each role you use, or submit fails closed with `profile not configured: <role>`:

```bash
lao profiles clone example-subscription --id my-worker --overrides-json '{"role":"worker"}'
lao profiles clone example-subscription --id my-architect --overrides-json '{"role":"architect"}'
lao profiles clone example-subscription --id my-manager --overrides-json '{"role":"manager"}'
lao profiles clone example-subscription --id my-reviewer --overrides-json '{"role":"reviewer"}'
```

Created profiles persist under the state directory (`<state-dir>/custom-profiles/`), never in the repository. See [profiles/README.md](profiles/README.md) for the full profile model, local/subscription pools, and per-role selection (`LAO_ROLE_PROFILES`, `LAO_PROFILE_<ROLE>`).

## Commands

For the default trusted-local profiles, no sandbox environment variable is needed:

```bash
export LAO_GATE_COMMAND='["npm","test"]'
```

For an explicitly sandboxed custom profile, set the reviewed extension path:

```bash
export LAO_PI_SANDBOX_EXTENSION=/path/to/pi-sandbox/extension
```

Submit a prompt. Without `--plan-file`, the Architect Pi first creates a durable, system-aware architecture contract (task boundaries, artifacts, prerequisites, dependencies, integration order, and repair policy), then the Manager Pi creates and validates the DAG; the runner adds declared artifact dependencies and performs preflight before starting workers. After that the runtime starts detached workers:

```bash
node --experimental-strip-types src/cli.ts submit --repo /path/to/repo --prompt "Build ..."
node --experimental-strip-types src/cli.ts tree <initiative-id>
node --experimental-strip-types src/cli.ts status <node-or-initiative-id>
node --experimental-strip-types src/cli.ts progress <initiative-id>
node --experimental-strip-types src/cli.ts progress <initiative-id> --watch --once
node --experimental-strip-types src/cli.ts events --limit 20
node --experimental-strip-types src/cli.ts doctor
node --experimental-strip-types src/cli.ts logs <initiative-id> --follow
node --experimental-strip-types src/cli.ts resume <task-or-initiative-id>
node --experimental-strip-types src/cli.ts architecture-contract get <initiative-id>
node --experimental-strip-types src/cli.ts architecture-contract list <initiative-id>
node --experimental-strip-types src/cli.ts message <initiative-id> "Prioritize the API work"
node --experimental-strip-types src/cli.ts plan-edit <initiative-id> --file change.json
node --experimental-strip-types src/cli.ts dashboard <initiative-id>
node --experimental-strip-types src/cli.ts metrics <initiative-id>
node --experimental-strip-types src/cli.ts metrics <initiative-id> --prometheus
node --experimental-strip-types src/cli.ts metrics <initiative-id> --out metrics.json
node --experimental-strip-types src/cli.ts metrics <initiative-id> --prometheus --out metrics.prom
node --experimental-strip-types src/cli.ts feed <initiative-id> --follow
node --experimental-strip-types src/cli.ts agents <initiative-id>
node --experimental-strip-types src/cli.ts supervise --follow
node --experimental-strip-types src/cli.ts deliver <initiative-id>
node --experimental-strip-types src/cli.ts prune <initiative-id> --dry-run
node --experimental-strip-types src/cli.ts profiles list
node --experimental-strip-types src/cli.ts toolchain status
node --experimental-strip-types src/cli.ts recover
node --experimental-strip-types src/cli.ts mcp
```

Release scheduling is disabled by default. To explicitly allow a plan containing the release profile, add `--enable-release`; release still requires an independent passing reviewer and repository gate:

```bash
node --experimental-strip-types src/cli.ts submit --repo /path/to/repo --prompt "Prepare release" --plan-file release-plan.json --enable-release
```

For deterministic/local tests, provide a plan and avoid spawning workers. A no-start submission that will later be run must also provide the version-2 architecture draft:

```bash
node --experimental-strip-types src/cli.ts submit --repo /path/to/repo \
  --prompt "Build ..." --plan-file plan.json --architecture-file architecture.json --no-start --json
node --experimental-strip-types src/cli.ts run <initiative-id> --json
```

`progress` reads SQLite only (plus bounded local artifact checks for automatic unblock) and reports task/epic counts, blockers, active sessions, and metrics. Blockers are task-scoped and include an owner, required action, and unblock condition. Resume a task/branch ID to reopen only that recovery scope; resume an initiative ID only for explicitly recoverable scheduler/integration blockers. Semantic reviewer blockers require Manager guidance.

Runtime state defaults to `~/.local/state/loom-and-order` and can be overridden with `LAO_STATE_DIR` or `--state-dir`. Results remain on task and epic branches until the host/release step merges them. Each task gets its own worktree and branch; cross-epic dependencies are materialized into the dependent epic base before the worker starts. The host validates a clean source checkout, exactly one task commit, reviewer pass, pre-merge gate, integration merge, and post-merge epic gate before completion. Runner-owned `.pi/quiet-tools` artifacts are allowed as untracked checkout noise; other user changes still fail closed. Architecture contracts distinguish path-only task outputs (`produces`) from prose outcomes (`deliverables`), pre-existing path inputs (`requiredArtifacts`), and textual/toolchain requirements (`prerequisites`); a task cannot require its own output. A semantic reviewer failure gets one automatic worker repair; after the second failure Manager decides whether to escalate to Architect, authorize an extra attempt, or block. Integration conflicts receive one bounded reset/retry and then remain explicitly blocked.

See [profiles/README.md](profiles/README.md) for the example profiles, the model catalog, local/subscription pool selection, concurrency limits, bounded infrastructure retries, and the custom-profile workflow.

See [docs/observability.md](docs/observability.md) for runtime metrics, wall-clock time, TTFT, generation time, TPS, per-type token counters, cost calculation, profile/model grouping, local MLflow traces/artifacts, TUI/MCP access, privacy boundaries, and the optional Prometheus text export.

## Execution trust modes

The default `trusted-local` backend launches Pi directly with an isolated `PI_CODING_AGENT_DIR` and session directory. It intentionally gives trusted workers normal coding tools, including `write` and `edit`, and can access any files allowed to the operating-system user. It is for repositories and workers you trust, not hostile code.

A Git worktree is not a security sandbox. For hostile repositories, use an explicit profile with the `pi-sandbox` backend. That adapter routes Pi's Bash through bubblewrap/seccomp and a fail-closed policy; it requires `LAO_PI_SANDBOX_EXTENSION`. In both modes, the provider authentication path is profile-owned/explicit rather than a credential broker. Do not put broad host secrets in a trusted-local profile used for untrusted repositories.

Docker Sandboxes (`sbx`) and the official `docker.io/sbx/pi-kit` are the planned second backend. They provide a microVM boundary and credential proxy, but require the separately installed `sbx` CLI and explicit host-side secret binding. The runtime will never install or configure either backend automatically.

This is not a promise that an LLM is correct or that a compromised host/kernel is safe. Review the profile, network allowlist, credentials, and gate before enabling unattended work.

## v1: known limitations and unverified areas

Honest status after the crash/chaos dogfood. Verified live: full lifecycle, parallel dispatch, cross-epic dependencies, `kill -9` in worker/review/integration phases, lease recovery, idempotent integration, preflight rejection, conversational repair, Manager recovery, and the operational CLI. **Not** verified live:

| Area | State |
|---|---|
| `pi-sandbox` backend | Unit-covered only; every dogfood run used `trusted-local`. Do not rely on it for hostile repos until a sandboxed dogfood passes. |
| Host reboot / power loss | Expected to work (dead-owner probe + SQLite WAL); only process-level `kill -9` was tested. |
| Gate-failure repair loop | Unit-tested; effectively unreachable in practice (preflight integrability + competent workers). |
| True 3-way file conflicts between parallel tasks | Unit-tested; preflight's exactly-one-producer rule makes them rare by design. |
| Multi-hour runs | Longest dogfood run ~55 min; lease-refresh drift over hours unproven. |
| Subtasks, `release` profile, `waiting_external`, `paused`, `needs_architect` | Store/unit coverage only; no live initiative exercised them. |
| Concurrent operator writes | The initiative run lease is tested; simultaneous CLI writers (e.g. `resume` + `run`) are not. |

Architectural debts to know before depending on v1:

1. **Supervision is not a daemon.** The built-in supervisor lives only inside a `run` process; keep `lao supervise --follow` alive as a companion for unattended work, or crashes between runs stall up to the 90-min lease TTL.
2. **No automatic worktree GC.** `lao prune` reclaims terminal worktrees and merged task branches after delivery; epic worktrees need `--include-epics`.
3. **The host owns final integration.** `lao deliver` builds a gated `loom-and-order/deliver-<initiative-id>` branch in the target repo (working tree untouched); merging it into your mainline is a deliberate host step (see [docs/operations.md](docs/operations.md#integration-and-delivery)).
4. **PID-based leases.** One host per state dir; PID namespaces (containers) break the dead-owner probe. The TTL is the backstop.
5. **LLMs in the control plane.** Manager/Architect make recovery decisions (block/retry/escalate); bounded by attempt caps, but a bad decision ends in a manual intervention.
6. **One task = exactly one commit.** Coarse task decomposition fails the commit-shape check; decompose finely.
7. **`maxAttempts` bounds autonomous recovery only.** Explicit `resume` intentionally bypasses it.
8. **CLI ships as TypeScript** (`bin` → `src/cli.ts`); requires Node 22.22+ with native type stripping.
9. **SQLite single-writer.** Fine at dogfood load; `SQLITE_BUSY` may surface under much higher parallelism.
10. **Schema migrations exist but were never exercised** by a real upgrade (v1 only).

Deferred to v1.1: daemon supervision mode / `run --until-terminal`, automatic worktree GC, sandboxed dogfood, reboot test, long-run test, release live coverage, TUI/MCP polish, cross-repo initiatives.
