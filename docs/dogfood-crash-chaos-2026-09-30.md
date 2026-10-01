# Loom & Order — pre-v1 dogfood findings (run 4 crash + run 5/6 chaos)

Date: 2026-09-30. State dirs: /tmp/lao-run-4, /tmp/lao-run-5, /tmp/lao-run-6.
All operator actions used documented CLI commands only; no manual state/worktree surgery.

## Crash resilience (run 4, initiative-573c945d)

Three `kill -9` of the executor process, one per phase: worker, review, integration.

| Kill | Phase | Recovery | Time to recovery |
|------|-------|----------|------------------|
| 1 | worker session | `supervise --follow` stale-session detect (30s heartbeat) → task ready → `run` re-dispatch | ~2 min (operator started supervisor) |
| 2 | review session | same path | ~2 min (supervisor already resident) |
| 3 | integration (gate, before merge) | lease TTL expiry (90 min) only | ~90 min (passive) |

Worktree integrity after every kill: clean, no half-merge (MERGE_HEAD), no duplicate
commits, worker re-attempts started from the recorded base. No data loss in any phase.

### F1 — supervision is not resident (medium)
When the executor process dies, nothing recovers state until an operator starts
`supervise` again. Worker/review sessions are detected within 30s by a resident
supervisor (`recoverStaleAgentSessions`); without one, tasks sit stuck.
Fix options: (a) document `supervise --follow` as a required companion process
(systemd unit in Quickstart); (b) have `run` start embedded supervision for the
lifetime of the process (it already does — `this.supervisor.start()` — so the gap
is only for the detached-then-restarted case).

### F2 — `supervise` is one-shot by default (low, documentation)
`node src/cli.ts supervise` runs exactly one cycle and exits silently. A resident
supervisor requires `--follow`. Operators will assume residency. Consider default
follow or a loud warning.

### F3 — integration-phase crash recovers only via lease TTL (medium) — FIXED
A task killed while `integrating` has no agent session (heartbeat detection
applies to worker/review only). Its lease (90 min TTL) is the only recovery
trigger. After expiry the task returns to `pending`; if `attempt >= maxAttempts`
the supervisor blocks it with "exhausted attempts", requiring an explicit
`resume`. Worst-case stall: ~90 min + manual resume.

**Fixed (commit 155a4e4):** the supervisor now probes lease owners of the form
`executor-<pid>`; a dead pid triggers immediate lease recovery
(`recoverDeadOwnerLeases`), TTL stays as the pid-reuse backstop. Live
verification on run-4's real state: the stuck `integrating` task (owner pid
dead) was recovered within one supervisor cycle (seconds), blocked at the
3/3 attempt bound, and `resume` re-dispatched it (fresh attempt by design:
worker → reviewer → integration). Residual: recovery costs one full fresh
attempt (~10 min on this host); the idempotent integration re-run that would
make the re-attempt cheap is implemented in F4 below.

### F4 — crash after a successful merge causes a re-attempt conflict (medium) — FIXED
Run-4's third kill landed **after** the integration merge had succeeded (the
epic branch already contained the task's commit, `4f0b5cc`) but **before** the
completion record. The re-attempt (after `resume`) re-implemented the task and
produced a genuine merge conflict against the already-merged implementation:
`integrating` → `needs_manager` → manager decision `block`. The initiative sat
blocked with no CLI path to complete.

**Fixed (commits 5ef3691 + 164c7da):** the epic's first-parent history is
walked for a prior merge of the task branch (`GitWorkspace.findPriorMerge`).
Detection happens right after the worktree reset (164c7da), before the worker
dispatch: with the task base updated to the epic tip on recovery, the
re-attempt's worker would have nothing to implement (zero commits →
single-commit shape failure), so the pipeline completes idempotently on the
existing merge commit — gate verification only, no worker, no reviewer, no
re-merge. A fallback check remains in the integration block (5ef3691) for the
edge case where a commit does exist.

**Live verification on run-4's real state: PASS.** Attempt 6 detected the
prior merge (`integration_prior_merge_detected`, mergeCommit `4f0b5cc`),
verified the epic gate, and completed the task on the original merge commit
in ~10 seconds (`integration_already_merged`). The initiative reached
`completed` (4/4 tasks, 2/2 epics) with a clean epic worktree at the original
merge commit — no duplicate commits, no re-implementation cost.

Total crash-recovery time for the killed task with both fixes: supervisor
detection (seconds) + operator `resume` + idempotent completion (~10 s) —
versus the ~90-minute lease TTL stall without them.

**Bonus from the same re-attempt:** two paths previously "unreachable by
design" were exercised for real:
- **Conversational worker repair** — the reviewer failed the first pass
  (legitimate `limit === 0` finding), the worker repaired in the same
  conversation, the reviewer passed on the second pass (146 tests).
- **Integration conflict → manager recovery** — the (then-expected) conflict
  went through `integration_recovery_scheduled` → `needs_manager` → manager
decision `block` with a clear reason and `requiredAction`.

## Architecture preflight (run 5, initiative-e34e04c6 — rejected)

The chaos prompt deliberately contained two contradictions (shared output paths;
a change breaking an existing test). The architect rejected the plan at
preflight with an accurate diagnosis of BOTH issues and created a single
"Reject contradictory chaos execution plan" task. No workers were dispatched.

Finding: preflight rejection works end-to-end and is accurate. Consequence:
**engineered integration conflicts and gate-failure scenarios are largely
unreachable through normal submit** (see below).

## Integration conflict path (run 6, initiative-93249ec9)

Chaos v2 prompt: two parallel tasks, both wiring subcommands into `src/cli.ts`
(task 2 phrased as "read src/cli.ts first" to evade static analysis).
Result: the architect restructured the plan into 3 tasks — two module tasks
plus one dedicated "wire CLI subcommands" task, consolidating `cli.ts`
ownership into a single producer. No conflict occurred; run proceeded normally.

Layered defense confirmed:
1. `validateArchitectureContract` enforces exactly-one-producer in code (also
   for operator-created contracts).
2. The architect LLM detects shared material modification and either rejects
   the plan (run 5) or consolidates ownership into one task (run 6).

Conclusion: the integration-conflict recovery path (abort merge, reset, bounded
retry, explicit block) is a safety net for corrupt/adversarial plans and
crash-during-merge, not for normal operation. It remains unexercised in a real
run by design. Same classification for the conversational gate-failure repair
loop: the preflight's integrability check plus competent workers make
gate-failure-after-focused-pass a last-resort path. Both paths are covered by
unit tests (executor.test.ts) but not by a live dogfood run.

**v1 verdict on chaos paths:** not a gap to fix before v1 — the layered
defense (code validator + architect normalization) makes these paths
unreachable in normal operation, which is the intended safety property.

## Operational notes

- `progress --watch --once`, `doctor`, `events`, `logs`, `metrics` all worked
  against live state dirs during these runs (cherry-picked home for v1).
- Detached runtime restart after kill works: new `run` process acquires the
  initiative run, finds no ready work, exits cleanly.
- `resume` on a non-waiting node fails with a clear error ("not waiting for
  recovery") — safe failure mode.
- An operator debug-script bug created a stray `undefined/` directory in the
  target repo (my phase detector ran `new Store(undefined + ...)` with cwd=repo);
  it made the next submit fail with "source checkout is not clean" — the clean
  checkout guard caught operator garbage correctly. Removed the directory.

## Verdict

Crash resilience: PASS. No data loss, no corrupt worktrees, no duplicate
commits across 3 kills. F3 (dead-owner lease recovery) and F4 (idempotent
integration) are implemented, unit-tested, and live-verified on run-4's real
crashed state — the initiative reached `completed` through the documented
CLI-only recovery path (supervisor detection → `resume` → idempotent
completion). Remaining caveats: supervision must run as a companion
`supervise --follow` process (F1/F2). Recovery of a mid-integration crash now
costs seconds-to-a-minute, not ~90 minutes.
