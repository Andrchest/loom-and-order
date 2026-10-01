# Architecture

## Goal

`Loom & Order` is a local durable orchestrator, not a single long-running Pi prompt. A user submits an initial request and may later send short instructions or plan edits. The runtime keeps the plan, leases, process attempts, evidence, and Git artifacts outside the user's working checkout.

## Components

```text
CLI / TUI / MCP
       │
       ▼
Application service
       │
       ├── SQLite store + event log
       ├── DAG scheduler / lease recovery
       ├── Git worktree manager
       └── Profile-aware agent launcher
                         │
              manager / worker / reviewer Pi
                         │
                 explicit sandbox backend
```

All clients call the same application service. They do not read SQLite directly or implement their own transitions. MCP is an opt-in stdio server and never changes Pi settings on startup.

## Durable hierarchy

- **Initiative**: one user request, source repository, policy, and overall outcome.
- **Epic**: an independently integratable slice with an epic worktree/branch.
- **Task**: one bounded worker assignment with acceptance criteria, profile, dependencies, and task worktree.
- **Subtask**: optional finer-grained work item owned by a task. A subtask may be tracked without its own process; the parent task remains the execution boundary unless a future profile explicitly promotes it.

Dependencies are explicit node IDs. Architect aliases are retained on task nodes, translated to canonical IDs by the runner, and the store rejects unknown references and cycles in one transaction. Only dependency-satisfied tasks become ready. Manager messages and plan edits are append-only external inputs; applying an edit creates an event and a new plan generation.

## Agent roles

The **architect** is a read-only design role. It runs once before initial manager decomposition and may be re-invoked for an architectural escalation. It produces a versioned architecture contract containing decisions, constraints, invariants, interfaces, task-shaping guidance, and a system-aware `executionPlan`. Each execution-plan task has a stable alias, objective, path-only `produces` outputs, prose `deliverables`, repository-relative pre-existing `requiredArtifacts` for preflight, textual/toolchain `prerequisites` for human and Manager context, dependency aliases, verification checks, and the integration/preflight/repair policy. The runner rejects prose in artifact fields, rejects self-produced requirements, and never treats free-text prerequisites or deliverables as paths. The built-in Architect uses the explicit GPT-5.6 Terra `xhigh` profile and never edits target files.

The **manager** is a durable workflow role. It converts the architecture contract and user request into a strict DAG, preserving Architect aliases and dependencies. The runner applies execution-plan dependencies before persisting the DAG; it performs repository-artifact preflight before worker/reviewer launches and fails closed without an agent call when a declared `requiredArtifacts` entry is absent. Missing artifacts are recorded as task-local recovery metadata rather than contaminating independent branches. The manager assigns profiles, launches/reroutes agents, and responds to external messages. It does not implement code or author architecture. Recovery decisions are explicit: escalate to Architect, authorize an extra attempt, or block.

A **worker** receives one task packet, the current architecture contract, relevant repository guidance, acceptance criteria, allowed profile, and its own worktree. It must implement only that task, run focused checks, and create a commit.

A **reviewer** is a separate Pi process/profile. It receives the task contract, architecture contract, diff, commit metadata, and command evidence. It returns a structured pass/fail verdict with findings. A passing reviewer is necessary but not sufficient: the configured repository gate must also pass. The first semantic failure returns to the worker once with findings; a second failure is routed to Manager.

A **researcher** is read-only and returns an evidence report without a worktree, commit, reviewer, or gate. A **release** agent is available for explicit scheduling only; it follows the same isolated worktree, independent reviewer, and repository-gate requirements before integration. Release scheduling is disabled by default and can be enabled only through the explicit service/CLI option.

## Model routing and concurrency

`profiles/model-catalog.json` is an explicit, project-local catalog. The default `codex-balanced` preset is:

- manager: GPT-5.6 Luna, `max`;
- worker: GPT-5.6 Luna, `high` (the `xhigh` worker profile is selectable manually);
- reviewer: GPT-5.6 Luna, `xhigh`;
- researcher: GPT-6 Luna, `xhigh`;
- architect: GPT-5.6 Terra, `xhigh`;
- release: GPT-5.6 Terra, `high`.

Local smoke-test models (llama.cpp/Ollama-style providers) are catalogued as a separate `local` pool. A profile must name its model and pool; an unavailable model fails closed and is never silently replaced by another model. The scheduler allows at most four simultaneous non-manager Codex runs and one local run. The manager does not consume the Codex worker slots. At most two infrastructure/provider/protocol repeats are allowed for launch failures, timeouts, transport failures, and invalid structured output. Worker code/test failures, reviewer findings, and repository-gate failures are result outcomes, not provider retries.

## Git isolation and integration

The user's source checkout must be clean at submission. The runtime creates an initiative base and an epic integration worktree. Each task gets a branch/worktree from the current epic branch; when a dependency was integrated in another epic, its commit is materialized into the dependent epic before the task worktree is created. The user's current branch is never checked out or modified by the orchestrator. Worktrees and branches are retained for inspection. Runner-owned untracked `.pi/quiet-tools` artifacts do not invalidate submission, but tracked changes and other user changes still fail closed.

## Profiles and execution backends

A profile manifest defines role, Pi binary, isolated `PI_CODING_AGENT_DIR`, session directory, skills, extensions, tool policy, model, timeout, and execution backend. Profiles are explicit and resolved without mutating global Pi configuration. Built-in profiles use `trusted-local`: Pi settings and sessions are isolated per run, while trusted workers can use normal coding tools and Git linked worktrees.

The optional `@erichll/pi-sandbox` backend protects Pi's Bash through bubblewrap/seccomp and requires its own trusted configuration. It is selected explicitly for untrusted repositories; the launcher fails closed if that backend is selected without its extension. This backend does not provide Docker Sandboxes' provider credential proxy. A future `sbx` adapter will run the whole Pi process in Docker Sandboxes with the official Pi kit and credential proxy. The runtime must not describe host-auth as brokered isolation.

Pi and selected external extensions run from an atomic toolchain bundle under runner state. The bundle vendors Node 24 LTS, the Pi CLI, and the selected extensions; a daily TTL check resolves npm `latest` versions into a staging generation, smoke-checks the local runtime, and switches the active pointer only after success. The previous generation remains available for rollback. The MCP adapter runs in exclusive mode against a copied project `.mcp.json`, preventing global MCP configuration from entering isolated sessions.

## Reliability

State transitions, leases, attempts, architecture-contract revisions, messages, plan generations, reviewer verdicts, integration recovery, post-merge gates, and command evidence are committed before publication. A crashed supervisor does not erase a task. A semantic reviewer failure is retried once with structured findings in the same worker session when possible; after the second failure Manager chooses Architect escalation, an explicitly authorized extra attempt, or block. Integration conflicts are aborted/reset safely, fingerprinted, and routed through a task-local Manager checkpoint when Manager is configured before a bounded rerun on the current epic base; unresolved conflicts remain blocked with a resumable reason. Recovery expires leases, marks an interrupted attempt, and requeues only according to the bounded retry policy. Initiative run leases prevent concurrent schedulers, and explicit node-ID collision checks reject incompatible state reuse before insertion. Idempotency keys prevent a completed task from being executed again during recovery.

Durability is bounded: SQLite and local files cannot protect against disk loss, a compromised host, a malicious provider, or incorrect model output. Provider/toolchain preflight failures are classified and persisted even when no initiative can be created. MLflow is optional; SQLite remains authoritative when tracing is disabled or unavailable. “Completed” means the configured reviewer, pre-merge gate, integration, and post-merge gate produced evidence, not that the feature is semantically perfect.
