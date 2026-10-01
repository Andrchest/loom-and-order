---
name: loom-and-order
description: Operate the Loom & Order multi-agent runtime. Use when submitting initiatives, watching progress, diagnosing stuck or crashed work, recovering blocked tasks, managing profiles and architecture contracts, or delivering results. Triggers on lao CLI commands, initiative/epic/task state, supervisor, lease recovery, integration conflicts, "resume", "doctor", "progress", "submit".
---

# Operating Loom & Order

`Loom & Order` is a durable local multi-agent runtime. You submit one prompt; an **Architect** writes a versioned architecture contract, a **Manager** turns it into an `initiative → epic → task → subtask` DAG, **workers** execute tasks in isolated Git worktrees, **reviewers** verify them (diff + acceptance + test gate), and passing commits are integrated into an epic branch. State lives in SQLite outside the target repository; every action is an event.

The CLI is the only operator interface. **Never edit `state.sqlite3`, worktrees, or branches by hand** — every recovery has a CLI path, and manual edits corrupt the event log's invariants.

## Setup

```bash
cd Loom & Order && npm install && npm link   # installs the `lao` binary
lao help
```

- Requires Node.js 22.22+ (the CLI is TypeScript run via native type stripping).
- State dir: `~/.local/state/loom-and-order` by default; override with `--state-dir PATH` (every command accepts it) or `LAO_STATE_DIR`.
- Gate: auto-detected by default (`npm test`, Python unittest, …). Pin it per command with `--gate-json '["npm","test"]'` or `LAO_GATE_COMMAND`.
- Profiles: `trusted-local` by default (worker can touch any file your OS user can). Hostile repositories need an explicit `pi-sandbox` profile — see "Trust modes".

## First run: role profiles

The repository ships two **example worker profiles** (`profiles/example-local.json` — local model, `profiles/example-subscription.json` — subscription model) as templates. It ships **no** architect/manager/worker/reviewer profiles: create your own before the first submit, or the runtime fails closed with `profile not configured: <role>`.

```bash
# 1. Clone an example into a real role profile (persisted under the state dir):
lao profiles clone example-subscription --id my-architect --overrides-json '{"role":"architect","thinkingLevel":"high"}'
lao profiles clone example-subscription --id my-manager --overrides-json '{"role":"manager"}'
lao profiles clone example-subscription --id my-worker --overrides-json '{"role":"worker"}'
lao profiles clone example-subscription --id my-reviewer --overrides-json '{"role":"reviewer"}'
lao profiles list
```

For a local-model role, clone `example-local` instead and set `LAO_LOCAL_MODEL=provider/model` (optionally `LAO_MODELS_FILE` for the provider catalog) when running. Per-role selection is `LAO_ROLE_PROFILES='{"worker":"my-worker"}'` or `LAO_PROFILE_WORKER=my-worker`. Full guidance: `profiles/README.md`.

## Core workflow

```bash
# 1. Submit. The Architect + Manager build the DAG, then workers start detached.
lao submit --repo /path/to/target --prompt "Build the thing"

# 2. Watch.
lao progress <initiative-id>              # one-shot snapshot
lao progress <initiative-id> --watch      # live until Ctrl-C
lao progress <initiative-id> --watch --once   # single rendered frame

# 3. Keep a supervisor alive (see "Supervision" below).
lao supervise --follow

# 4. Diagnose when something looks off.
lao doctor
lao events --limit 50
lao logs <initiative-id> --follow
lao feed <initiative-id> --follow

# 5. Recover a stuck task (only documented paths).
lao resume <task-or-initiative-id>
lao run <initiative-id>
```

`submit` prints the initiative ID. `run` re-dispatches ready work for an existing initiative (it requires a persisted version-2 architecture plan; `submit` creates it automatically, so a plain `submit` → `run` round-trip is unnecessary — workers are already detached).

## Command reference

### Lifecycle
| Command | What it does |
|---|---|
| `submit --repo PATH --prompt TEXT [--plan-file P] [--architecture-file A] [--no-start] [--enable-release]` | Create an initiative. Without `--plan-file`, Architect + Manager design the DAG. `--no-start` persists without launching (then you must have supplied `--architecture-file`; start later with `run`). `--enable-release` allows release-profile tasks (off by default). |
| `run <initiative-id>` | Acquire the initiative run lease, start the built-in supervisor, dispatch all ready work, exit when nothing is ready. Safe to re-run after `resume`. |
| `pause <initiative-id>` | Stop dispatching new work (active sessions finish). |
| `resume <node-or-initiative-id>` | Reopen a node and **auto-restart the detached runner** (autoStart). A **task** is resumable from `blocked`, `waiting`, `recovering`, `waiting_*`, `needs_*` — and the bypass of `maxAttempts` is intentional (operator override). An **initiative** resume is allowed only when every blocked/failed task carries a recovery fingerprint or supervisor ownership; domain failures (worker output, reviewer verdicts, gates) throw `non-resumable blockers` — guide those via `message` instead. |
| `recover` | One-shot recovery sweep (stale sessions, expired/dead-owner leases) without a full run. |
| `supervise [--follow]` | One supervisor cycle (default) or resident loop (`--follow`). |
| `supervisor-status` | What the supervisor currently sees. |
| `deliver <initiative-id>` | Non-destructive delivery of a **completed** initiative: builds a `loom-and-order/deliver-<initiative-id>` branch in the target repo with every completed epic merged in dependency order on top of the target's current HEAD, then runs the repo gate. The target working tree is never touched. Re-running rebuilds the branch. |
| `prune [initiative-id] [--all] [--include-epics] [--dry-run]` | Remove worktrees of terminal task/subtask nodes. Merged task branches are deleted, unmerged ones are kept for forensics. `--include-epics` also removes completed epic worktrees (their branches are always kept — `deliver` needs them). |

### Inspection (read-only, safe anytime)
| Command | What it shows |
|---|---|
| `tree <initiative-id>` | The DAG with per-node status. |
| `status <node-or-initiative-id>` | One node: status, lease, attempt, failure, blocker fields. |
| `progress <initiative-id> [--watch [--once]]` | Counts by status, blockers (owner + required action + unblock condition), active sessions, metrics. SQLite-only. |
| `events [--limit N]` | Recent append-only events (all initiatives). |
| `feed [initiative-id] [--after EVENT_ID] [--limit N] [--follow]` | Cursor-based event stream for one initiative. |
| `logs [node-id]` | Events recorded for one node (its history). | 
| `logs <initiative-id> --follow` | Tail the newest agent session JSONL from the state dir incrementally (survives in-place rewrites, follows file rotation by mtime). |
| `agents [initiative-id]` | Agent records (role, model, status, heartbeats). |
| `agent-sessions [initiative-id] [--state running]` | Agent sessions with state and heartbeats. |
| `doctor` | SQLite integrity, state-dir sanity, supervisor health. Run this first after any crash. |
| `metrics <initiative-id> [--prometheus] [--out FILE]` | Counters: attempts, durations, tokens, cost, recoveries. |
| `toolchain status \| update` | Managed Pi bundle state (isolated cache, never global). |

### Control (durable inputs, not chat)
| Command | Effect |
|---|---|
| `message <initiative-id> "text"` | Append a durable instruction; it is injected into the next worker prompt for that initiative. This is how you guide a Manager-blocked task ("semantic reviewer blockers require Manager guidance"). |
| `plan-edit <initiative-id> --file PATCH.json` | Patch an existing node: `{nodeId, title?, description?, acceptanceCriteria?, dependsOn?, profileId?}`. Cannot create nodes. Creates a new plan generation + event. |
| `architecture-contract get|list|create <initiative-id> [--revision N] [--file C.json] [--reason TEXT]` | Inspect or supersede the versioned architecture contract. |

### Profiles
| Command | Effect |
|---|---|
| `profiles list` | Built-in + custom profiles. |
| `profiles validate --file P.json` | Validate a profile manifest without saving. |
| `profiles create --file P.json [--overwrite]` | Save a custom profile (lands in the state dir, never global). |
| `profiles clone SOURCE_ID --id TARGET_ID [--overrides-json JSON]` | Derive a new profile. |
| `agent-profile-create AGENT_ID [--profile-id ID] [--overrides-json JSON] [--overwrite]` | Pin a per-agent profile override. |

### Interfaces
`dashboard <initiative-id>` — terminal TUI. `mcp` — stdio MCP server (opt-in, exposes the same application service; never changes Pi settings on startup).

The MCP server speaks JSON-RPC 2.0 over stdio (protocol 2024-11-05, with `ping`, batch requests, and correct notification semantics) with 24 tools covering the full control plane — read-only (`tree`, `status`, `progress`, `feed`, `logs`, `metrics`, `agents`, `agent_sessions`, `architecture_contract_*`, `profiles_list`, `supervisor_status`) and writing (`submit`, `message`, `plan_edit`, `pause`, `resume`, `recover`, `supervise_once`, `profiles_create`, `profiles_clone`, `agent_profile_create`, `architecture_contract_create`). Writing tools carry the same autoStart semantics as the CLI (`submit`/`resume` start detached runners). To attach it to a Pi session, add to `~/.pi/agent/mcp-adapter.json` under `mcpServers`:

```json
"lao": {
  "command": "node",
  "args": ["/path/to/loom-and-order/src/cli.ts", "mcp", "--state-dir", "/path/to/state-dir"]
}
```

## Node states (what the dashboard/tree shows)

```
pending → ready → leased → running → reviewing → integrating → completed
```
Off-rails states: `paused`, `waiting_dependency` (recalculated), `waiting_external` (auto-reopens when its `artifact:` condition file exists), `waiting_approval`, `needs_manager`, `needs_architect`, `needs_operator`, `recovering`, `blocked`, `failed`. `completed` is terminal. A blocked node always carries: **owner**, **requiredAction**, **unblockCondition** — read them before acting.

## Supervision (critical operational knowledge)

Leases are the only concurrency control. A claimed node carries `lease_owner = executor-<pid>` and a TTL = **profile timeout + 1 minute** (≈91 min for the default worker profile, whose agent timeout is 90 min). The owning process refreshes the lease every 30 s across the task's whole lifecycle (worker + review + repair turns + gate + merge), so a healthy long review is never recovered. Three recovery triggers exist:

1. **Stale agent session** (30 s heartbeat) — covers worker/review phases.
2. **Lease TTL expiry** (≈91 min) — backstop for everything.
3. **Dead-owner probe** — the supervisor checks `kill(pid, 0)` on `executor-<pid>` owners; a dead pid recovers the lease in seconds (this is what saves a crash during `integrating`, which has no agent session).

The built-in supervisor runs **only while a `run` process is alive**. Between runs there is no one recovering. Therefore: **for unattended work, keep `lao supervise --follow` alive as a companion process** (tmux/nohup). `supervise` without `--follow` is one-shot by design.

After any recovery, a node returns to `pending`; if its attempt count reached `maxAttempts` (3 default), the supervisor blocks it with "exhausted attempts" — that is normal and `resume` fixes it (explicit resume bypasses the bound).

## Crash playbook (kill -9 / power loss)

Verified end-to-end; use only these steps, in order:

```bash
lao doctor                          # sqliteIntegrityCheck + sanity
lao progress <initiative-id>        # find the stuck node + blocker
lao events --limit 30               # see the last state changes
lao supervise --follow &            # companion supervisor (new process)
lao resume <stuck-task-id>          # if blocked; auto-restarts the runner
lao progress <initiative-id> --watch # confirm movement
```

`resume` already re-dispatches (autoStart), so an extra `run` is only needed when a blocker cleared by other means (e.g. an external artifact appeared, a `message` was answered) leaves ready work undispatched.

Phase-specific notes:

- **Crash in worker/review** — recovered in ~30 s by the next supervisor cycle (stale session). Nothing to do; the task re-runs from its base commit.
- **Crash in integrating** — recovered in seconds by the dead-owner probe. If the original merge had already landed, the re-attempt detects the prior merge and completes idempotently (gate only, ~10 s) — no re-implementation, no duplicate commit.
- **After host reboot** — all `executor-<pid>` owners are dead; the supervisor recovers everything on the first cycle. Run `doctor` first.

## Blocker triage

| Blocker reason (substring) | Meaning | Action |
|---|---|---|
| `supervisor exhausted attempts after recovery (n/n)` | Autonomous recovery budget spent | `resume <task>` (auto-restarts the runner) |
| `worker did not leave exactly one clean commit` | Single-commit invariant violated (task too big, or nothing left to implement) | `message` with scope guidance, or split via `plan-edit`; then `resume` |
| `integration conflict:` | Merge failed; one bounded retry already used | If crash-induced, the prior-merge detection handles it on re-run. Otherwise `message` the Manager with a resolution direction |
| `repository gate failed:` / `post-merge repository gate failed` | Gate (your test command) red on the integrated branch | Fix the underlying test expectation in the prompt/contract, `message`, `resume` |
| `architecture preflight` / `requiredArtifacts` missing | Plan declares inputs that do not exist | `plan-edit` the dependency or `architecture-contract create` a corrected revision |
| semantic reviewer failure (findings listed) | Reviewer found real quality issues; automatic repair budget spent | `message <initiative-id> "<guidance>"` — the Manager decides escalation/extra attempt/block |
| `waiting_external` | Waiting on a file condition | Auto-reopens when the artifact appears; no action |
| initiative-level `all remaining task branches are blocked` | Rollup of child blockers | Fix the children; the initiative unrolls itself |

## Delivery (bringing results home)

Results live on **epic branches in the state-dir worktrees** — the runtime never touches your target checkout. When the initiative is `completed`, deliver it with one command:

```bash
lao deliver <initiative-id>
# -> loom-and-order/deliver-<initiative-id> in the target repo, gate passed
```

The deliver branch merges every completed epic in dependency order on top of the target's current HEAD in a throwaway worktree; your working tree and its checked-out branch are never touched. You then review and merge the deliver branch yourself — the host owns the final integration boundary. Re-running `deliver` rebuilds the branch from scratch (idempotent). Every integrated commit already passed: exactly-one-task-commit shape, reviewer pass, pre-merge gate, merge, post-merge epic gate.

After delivery, clean up disk:

```bash
lao prune <initiative-id> --include-epics
```

## Trust modes

- **`trusted-local` (default)** — Pi runs directly with an isolated `PI_CODING_AGENT_DIR`; workers have normal tools and your user's file access. For repositories you trust.
- **`pi-sandbox`** — routes Bash through bubblewrap/seccomp, fail-closed; requires `LAO_PI_SANDBOX_EXTENSION` and Linux. For hostile repositories. A Git worktree is NOT a sandbox.
- **`sbx` (Docker microVM)** — planned, not in v1.

The runtime never installs into global npm/`~/.pi`, never copies host credentials, and never pushes.

## Pitfalls (learned the hard way)

1. **No resident supervision = up-to-90-min stalls after a crash** until someone runs `supervise`/`run`. Keep `supervise --follow` alive for unattended work.
2. **`resume` costs one fresh attempt** (worker → reviewer → integration, ~10 min typical) — except when the prior-merge path makes integration a ~10 s no-op.
3. **`maxAttempts` bounds only autonomous recovery.** Explicit `resume` intentionally bypasses it (a task can reach attempt 6 with maxAttempts 3).
4. **One task = exactly one commit.** Decompose finely; a task that "needs" several logical commits will fail the shape check.
5. **Worktrees are not garbage-collected automatically.** Use `lao prune <initiative-id>` (add `--include-epics` for completed epics) once an initiative is terminal; `--dry-run` previews. Manual removal of state-dir worktrees is still possible for anything prune refuses.
6. **Leases are PID-based** (`executor-<pid>`). Fine on a single host; do not run two hosts against one state dir (PID namespaces break the dead-owner probe).
7. **`progress`/`tree`/`status` are read-only** — safe to poll aggressively. `message`/`plan-edit`/`resume`/`pause` are the only state writers besides `run`/`supervise`/`recover`.
8. **The clean-checkout guard is real**: untracked garbage in the target repo (including stray directories) fails `submit` with "source checkout is not clean". Only runner-owned `.pi/quiet-tools/` artifacts are allowed.

## Verification checklist before declaring success

```bash
lao doctor                                  # healthy: true
lao progress <initiative-id>                # byStatus all completed
git -C /path/to/target log --oneline -5 loom-and-order/deliver-<initiative-id>   # epic merges present, no duplicates
git -C /path/to/target status --short                        # working tree untouched
lao events --limit 10                       # last events are rollups / deliver_completed
```
