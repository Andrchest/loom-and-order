# Runtime protocol

## Node states

Initiatives and epics use `draft → running → paused → completed|waiting|blocked|failed`. Tasks and subtasks use:

```text
pending → ready → leased → running → reviewing → integrating → completed
   │        │       │         │          │            │
   └────────┴───────┴─────────┴──────────┴────────────┴→ recovering|waiting_*|needs_*|blocked|failed|paused
```

`waiting_dependency` is recalculated from dependency state, while `waiting_external` may be automatically reopened when its safe repository-relative `artifact:` condition exists. `needs_manager`, `needs_architect`, `waiting_approval`, and `needs_operator` are task-local checkpoints; they carry an owner, scope, required action, unblock condition, and recovery epoch. They do not block independent branches. A completed task is terminal. The first semantic reviewer failure creates a repair attempt and preserves previous evidence; exactly two worker attempts are automatic. After a second failure, Manager chooses Architect escalation, an explicitly authorized extra attempt, or block. A blocked task can be reopened through explicit external guidance or `resume NODE_OR_INITIATIVE_ID` only when its durable reason is explicitly recoverable; semantic reviewer findings remain non-resumable without Manager guidance. Invalid transitions fail atomically. An initiative run lease prevents concurrent schedulers from operating on the same DAG.

## Task packet

Every worker launch receives JSON-equivalent data containing:

- initiative, epic, task, and parent IDs;
- immutable task title/description and acceptance criteria;
- dependency completion summaries;
- source commit, branch, unique worktree, isolated Pi profile ID, and attempt ID;
- repository instructions and required checks;
- explicit non-goals and a requirement to commit the bounded change;
- the current versioned architecture contract;
- structured findings from the previous reviewer attempt when this is a repair.

Every reviewer launch receives the same contract plus the architecture contract, diff, commit metadata, worker output, and captured command evidence. Reviewer output is accepted only if it is parseable and contains `verdict: pass|fail` and an array of findings.

## Agent-specific profiles

An existing persistent agent identity can be assigned its own validated profile with the CLI `agent-profile-create` command or MCP `agent_profile_create` tool. The profile is derived from the identity's role/profile/model/pool, persisted outside the target repository, and linked back to the agent record. This does not create a new session; callers can use the assigned profile for future launches.

## Architecture contracts and recovery

Architecture contracts are stored in SQLite under runner state, not in the target repository. Revisions are append-only and include the Architect profile/model, timestamp, supersession reason, decisions, constraints, invariants, interfaces, task guidance, and (version 2) a system-aware execution plan. The execution plan assigns stable task aliases, path-only `produces` outputs, prose `deliverables`, path-only pre-existing `requiredArtifacts`, textual `prerequisites`, dependency aliases, verification checks, integration order, preflight checks, and repair policy. The runner validates these boundaries before persistence, translates aliases to canonical DAG IDs, and adds dependencies when a required artifact is produced by another task. A task must not require one of its own outputs. Textual prerequisites and deliverables are never treated as filesystem paths; only structured repository-relative `requiredArtifacts` participate in preflight. Missing artifacts enter a task-local recovery checkpoint and may be reopened by the supervisor when the artifact appears. Use `architecture-contract get|list|create` or the corresponding MCP tools to inspect them.

A reviewer finding is preserved as a review record and a repair event. The worker sees only structured findings, not reviewer reasoning or raw hidden output. After the automatic repair bound, Manager receives task status, attempt history, findings, the current contract, and external guidance. Manager cannot edit source files; architectural task-shape changes are Architect-owned.

## Manager messages and plan edits

A message is appended with an ID and delivery state. The manager consumes messages at a scheduling boundary; it never loses or silently rewrites a message. A plan edit is a validated patch to the DAG or criteria. Edits are rejected if they create a cycle, mutate an active task's immutable execution identity, or remove a dependency that is already integrated without a new generation. `resume` accepts either a task/branch node ID for scoped recovery or an initiative ID for an explicit whole-initiative recovery; scoped resume does not reopen unrelated blockers.

## Client contract

The application service exposes submit, tree, status, progress, architecture-contract, logs, message, plan-edit, pause, resume, recover, and dashboard operations. CLI, TUI, and MCP map directly to these methods. `progress` is a compact SQLite-only status read with task/epic counts, blockers, active sessions, and metrics. `submit --no-start` accepts an explicit version-2 architecture draft through `--architecture-file`; `run` fails closed when no persisted execution plan exists. A message sent to a blocked initiative reopens its manager checkpoint through the application API. A client crash does not change runtime state. `progress` and `status` are SQLite-only reads (apart from safe artifact-triggered auto-unblock checks); they never call an agent or provider.

## Completion evidence

A task can be integrated only when:

1. worker process exited successfully and left exactly one clean commit on its task branch;
2. reviewer returned `pass` for the exact task diff and criteria;
3. configured focused checks and the task pre-merge repository gate exited zero;
4. the integration merge succeeded in the epic worktree;
5. the post-merge epic repository gate exited zero;
6. all evidence paths and hashes were persisted.

The initiative is complete only when all epics and their tasks are integrated or explicitly marked blocked by the manager. Human-visible status must distinguish model claims, reviewer findings, command evidence, and integration state.
