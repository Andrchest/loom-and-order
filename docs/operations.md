# Operations

How the runtime behaves, what lives where, and how to operate it in normal and crash conditions. The code is the source of truth; this document is the operator's mental model. For the agent-facing how-to (commands, playbooks, triage), see [`skills/operating-Loom & Order/SKILL.md`](../skills/operating-Loom & Order/SKILL.md).

## Mental model

One **initiative** is one user request against one source repository. The runtime keeps everything durable *outside* the repository:

```
state-dir/
  state.sqlite3        # nodes, leases, attempts, sessions, events, metrics
  worktrees/<initiative-id>/<node-id>/   # one git worktree per epic and task
  logs/                # per-session stdout (JSONL) and stderr
  toolchain/           # managed Pi bundle + extensions (isolated cache)
  custom-profiles/     # profiles created via `profiles create`
```

Default state dir: `~/.local/state/loom-and-order` (override: `--state-dir` or `LAO_STATE_DIR`). The target repository is only ever read (clean-checkout validation) and written through its worktrees — never in place.

## Lifecycle of a submission

1. **Clean-checkout guard** — the target repo must be clean (only runner-owned `.pi/quiet-tools/` untracked noise is allowed). Operator garbage fails closed here.
2. **Architect** (read-only) — inspects the repo and writes a *versioned architecture contract*: decisions, invariants, interfaces, and a system-aware `executionPlan` (task boundaries, path-only `produces`, prose `deliverables`, pre-existing `requiredArtifacts`, textual `prerequisites`, dependencies, integration order, repair policy). The contract is persisted; every later revision is a new version with a supersession reason.
3. **Manager** — turns the contract into the `initiative → epic → task → subtask` DAG, preserving Architect aliases. The runner adds path-based artifact dependencies and rejects unknown references and cycles atomically.
4. **Preflight** — for every task, declared `requiredArtifacts` must exist at the resolved base; missing artifacts block that task locally (no agent call, no contamination of independent branches). Contradictory plans (multiple producers of one artifact, self-requiring tasks) are rejected here without any worker running.
5. **Dispatch** — all ready tasks are dispatched concurrently (independent tasks run in parallel; dependencies materialize by merging completed producer commits into the dependent epic base before its workers start).
6. **Per-task pipeline** — see below.
7. **Rollup** — epics and the initiative roll up when all children complete; blockers roll down from tasks with owner + required action + unblock condition.

### Per-task pipeline

```
ready → claim (lease) → worker → exactly-one-commit check → reviewer
      → (fail: one automatic conversational worker repair turn, then
         a second review; two semantic failures → Manager decides)
      → pre-merge gate → integration merge (epic branch) → post-merge gate
      → completed
```

- The **worker** implements in its task worktree and leaves changes *uncommitted* (the host owns the commit boundary; workers are forbidden git write commands in trusted-local mode).
- The **commit-shape check** enforces exactly one clean commit since the task base. This is what keeps integration trivially reviewable and merge conflicts rare.
- The **reviewer** sees the diff, acceptance criteria, architecture contract, and command evidence; its output is accepted only if parseable with `verdict: pass|fail` and findings.
- **Gates** are real process runs (auto-detected: `npm test`, Python unittest, …; pinnable via `--gate-json`). A task completes only after pre-merge gate, merge, *and* post-merge epic gate all pass.
- **Integration** merges the task branch into the epic branch under an epic lock.

## Concurrency: leases

The only concurrency control is the **lease**. Claiming a node sets `status = leased`, `lease_owner = executor-<pid>`, `lease_until = now + TTL`, and increments the attempt. The TTL is the profile timeout plus a margin (90 min for the default worker profile), and the owning process refreshes it every 30 s while alive.

A node under a lease is invisible to other schedulers. Three independent triggers release a dead lease:

| Trigger | Latency | Covers |
|---|---|---|
| Stale agent session (heartbeat > 30 s) | ~30 s | worker/review phases (any phase with a live agent session) |
| Dead-owner probe (`kill(pid, 0)` on `executor-<pid>`) | one supervisor cycle (seconds) | all phases, including `integrating` (no session) |
| Lease TTL expiry | up to TTL (90 min) | everything; backstop against PID reuse |

Recovery sets the node back to `pending`, clears the lease, interrupts running sessions (marked `interrupted`), and marks the owning agent `recovering`. All of this is evented (`lease_recovered`, `agent_session_interrupted`) and atomic in SQLite.

## Supervision

The supervisor is a loop of cheap cycles: recover stale sessions → recover expired leases → recover dead-owner leases → refresh readiness → block nodes that exhausted `maxAttempts` → auto-unblock `waiting_external` nodes whose artifact condition appeared.

Two ways to run it:

- **Built-in** — a `run` process starts a supervisor for its lifetime. This covers crashes *while a run is active*.
- **Companion** — `lao supervise --follow` as a standalone process. This is required for unattended work, because between `run` invocations (run exits when no work is ready) nobody recovers anything. `supervise` without `--follow` performs exactly one cycle and exits — that is by design, not a bug.

There is no daemon mode in v1; the companion process is the documented pattern (tmux/nohup).

### Attempt accounting

`maxAttempts` (3 default) bounds *autonomous* recovery: a node recovered by the supervisor that already used N attempts is blocked with "exhausted attempts" once N reaches the bound. An explicit operator `resume` intentionally bypasses the bound — a task can legitimately reach attempt 6 under operator direction. The bound exists to stop autonomous ping-pong, not to cap human-driven recovery.

## Recovery semantics

What a recovery *costs*, by phase of the crash:

| Crash during | What recovery does | Cost |
|---|---|---|
| worker / review | Stale-session detection re-pends the task; the next `run` re-dispatches a fresh attempt from the task base | one fresh attempt (~10 min) |
| integrating (merge not yet done) | Dead-owner probe re-pends in seconds; fresh attempt re-implements from base | one fresh attempt |
| integrating (merge **done**, completion not recorded) | Fresh attempt's base is the epic tip; the runtime detects the prior merge of the task branch and completes idempotently — gate verification only, no worker, no reviewer, no re-merge | ~10 s |

The last row is the idempotent-integration guarantee: a crash can never cause a duplicate merge, a conflicting re-implementation, or a lost merge. The epic branch is the durable record of what was integrated.

### Operator recovery procedure (the only supported one)

```
doctor → progress (find blocker) → events (understand) →
supervise --follow (companion) → resume <node> → run <initiative>
```

Manual repair of worktrees, branches, or the database is not supported and will desynchronize the event log. If a situation appears unrepairable via CLI, stop and escalate — do not improvise against SQLite.

## Blockers

A blocked node is a *decision request*, not an error. It always carries:

- **owner** — who can unblock (supervisor, manager, architect, operator);
- **requiredAction** — what specifically to do;
- **unblockCondition** — the durable condition that must become true.

Owners matter: supervisor-owned blockers clear on the next recovery cycle; manager-owned ones expect a `message` with guidance (the Manager then chooses escalation, extra attempt, or block); operator-owned ones expect `resume`/`plan-edit`. Initiative-level blockers ("all remaining task branches are blocked") are rollups — fix the children and the initiative unrolls.

`waiting_external` is special: it declares a safe repository-relative `artifact:` condition and reopens automatically when the file exists. No human in the loop needed.

## Integration and delivery

Each epic has its own branch and worktree; completed tasks merge into it (post-merge gated). **The runtime never merges into your mainline and never pushes.**

When the initiative is `completed`, `lao deliver <initiative-id>` builds a `loom-and-order/deliver-<initiative-id>` branch in the target repository: every completed epic branch is merged, in dependency order, on top of the target's current HEAD, in a throwaway worktree, and the result must pass the repository gate. Your working tree and its checked-out branch are never touched, and re-running the command rebuilds the branch from scratch. You then review and merge the deliver branch yourself — the final integration policy (rebase? squash? PR?) is yours.

`lao prune <initiative-id> [--all] [--include-epics] [--dry-run]` reclaims disk: worktrees of terminal task/subtask nodes are removed, merged task branches are deleted (unmerged ones are kept for forensics), and completed epic worktrees go only with `--include-epics`. Epic **branches** are always kept because `deliver` needs them.

Consequences to plan for:

- Prune terminal initiatives after delivery; `--dry-run` previews.
- A delivered-and-deleted state dir loses the event history; archive `state.sqlite3` if you want the audit trail.

## Trust model

- **trusted-local** (default): workers run as you, with your file access, in isolated Pi directories. They cannot push and (by prompt contract) do not run git write commands, but *can* read/write anything your user can. Use only for trusted repositories.
- **pi-sandbox**: bubblewrap/seccomp-routed Bash, fail-closed network/credential policy, explicit extension path. For hostile repositories. Linux only.
- The runtime installs its toolchain into its own cache only; it never touches global npm, `~/.pi/agent`, or host credentials. Provider auth is profile-owned.

Nothing here promises LLM correctness or protection from a compromised host/kernel. Review profile, network allowlist, credentials, and gate before unattended work.

## Known operational limits (v1)

| Limit | Impact | Mitigation |
|---|---|---|
| No daemon supervision | Crashes between `run`s stall up to 90 min (TTL) if no companion supervisor | keep `supervise --follow` alive for unattended work |
| No automatic worktree GC | Disk grows with initiatives | `lao prune` after delivery (`--include-epics` for epics) |
| Deliver branch is not merged for you | The host owns the final integration boundary | review and merge `loom-and-order/deliver-<initiative-id>` yourself |
| PID-based leases | One host per state dir; PID reuse risk | TTL backstop; do not share state dirs across hosts |
| Single-commit invariant | Coarse tasks fail shape checks | decompose finely (Architect guidance) |
| `pi-sandbox` backend not dogfooded live | Sandbox path unverified in real runs | v1.1: sandboxed dogfood run |
| Reboot / power-loss path untested live | Expected to work via dead-owner probe + WAL | v1.1: reboot test |
| Multi-hour runs untested live | Lease refresh is heartbeat-based; drift unproven | v1.1: long run |
| Schema migration machinery unexercised | Only v1 exists | test on first real schema bump |
