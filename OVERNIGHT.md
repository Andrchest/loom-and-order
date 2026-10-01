# Overnight recovery log

Operational log for the Snake E2E and runner hardening. This records concise observations, decisions, fixes, and verification results—not hidden chain-of-thought.

## 2026-09-25

- Started E2E run11 with the unchanged Snake prompt after commit `d84758c`.
- Target repository: `/tmp/pi-epics-snake-run6`; state: `/tmp/pi-epics-snake-run11`.
- Initial check: Architect submission process is active; no result or progress database summary yet.
- Run11 terminal result: Architect failed before plan persistence. Attempt 1 launched, then attempts 2 and 3 failed with Pi CLI error `--session-id cannot be combined with --continue`.
- Diagnosis: the launcher combined `--session-id` and `--continue`, and continuation attempts also resolved a new profile/session directory from the feedback run ID, so same-session planning retries could not work.
- Fix applied in `src/launcher.ts`: omit `--session-id` on `--continue` (required by Pi 0.87.1) and resolve continuation attempts against the original session ID/directory. Added regression coverage for invocation flags and directory reuse.
- Verification: launcher tests passed; full offline suite passed 75/75; `npm run check` and `git diff --check` passed.
- Fix committed as `ba14313`.
- Started replacement E2E run12 with the same prompt because run11 failed before plan persistence and no provider/worker process was active. State: `/tmp/pi-epics-snake-run12`; log: `/tmp/pi-epics-snake-run12-submit.log`.
- Current policy: do not launch another run while run12 is active.

## Next scheduled cycle

- Run11 remains terminal with the previously recorded Architect CLI failure; no process is active for run11.
- Run12 is active under `node ... src/cli.ts run initiative-dbf3d1f8-0187-44d5-b934-fda2a9f00bad --state-dir /tmp/pi-epics-snake-run12`.
- SQLite progress: initiative `running`; 9 tasks total: 5 completed, 1 running, 1 reviewing, 2 pending; 2 active sessions; no blockers; 25 metrics with 9 successful agent runs, 1 failure, 15 passes, and recovery count 0.
- Decision: no code changes or additional E2E launch while run12 is active.

## Run12 completion

- Run12 is terminal-completed; no run11/run12 submit or runner process remains active.
- Final SQLite progress: initiative `completed`; all 9 tasks and all 5 epics completed; 0 active sessions; 0 blockers; recovery count 0.
- Final metrics: 40 records, outcomes `success=12`, `fail=1`, `pass=27`. The single failure was the expected first reviewer rejection for task 1-1; bounded conversational repair followed and the second review passed. No runner failure or recovery loop was observed.
- Integrated commits were recorded on the run12 initiative branches. The target repository `/tmp/pi-epics-snake-run6` remains on its original `main` commit because release/integration was not enabled; final release workflow remains unverified.
- Decision: do not launch another expensive E2E. Remaining risk is limited to the unexercised release/finalize path and provider quota backoff.

## Subsequent scheduled cycle

- Run11 submit log still reports the known terminal Architect failure with no persisted plan; no run11 state progress identifier is available.
- No pi-epics runner, submit, or agent process is active. The target worktree and runner feature branch are clean.
- Run12 remains completed with no blockers; no new reproducible defect was found and no offline code change was necessary.
- Decision: preserve the successful run12 result and skip another expensive E2E launch.

## Latest scheduled cycle

- Run11 submit log is unchanged: Architect exited 1 and no plan was persisted.
- SQLite-only run12 progress remains terminal-completed: 9/9 tasks, 5/5 epics, 0 blockers, 0 active sessions, recovery count 0.
- No runner or agent process is active; no reproducible defect was found.
- Decision: no code change and no additional expensive E2E launch.

## Current scheduled cycle

- Run11 submit log remains terminal with `architect failed (exit 1); no plan was persisted`.
- SQLite-only run12 progress remains `completed`: 9/9 tasks, 5/5 epics, no blockers, no active sessions, recovery count 0.
- No runner or agent process is active, and the feature branch is clean.
- No new reproducible defect or evidence requiring a code change was found; another expensive E2E was skipped.

## Latest scheduled cycle

- Run11 remains terminal with the unchanged Architect error and no persisted plan.
- SQLite-only run12 status remains completed: all 9 tasks and 5 epics completed, no blockers, no active sessions, recovery count 0.
- No runner or agent process is active; no code fix is warranted and no additional expensive E2E was started.

## Current scheduled cycle

- Run11 submit log remains unchanged with Architect exit 1 and no persisted plan.
- SQLite-only run12 check: `completed`, 9 completed tasks, 5 completed epics, 0 blockers, 0 active sessions, recovery count 0.
- No runner/agent process is active and no new reproducible defect was found.
- Decision: no code change and no additional E2E launch.

## Current scheduled cycle

- Run11 submit log still contains only the known Architect exit-1/no-plan result.
- Run12 SQLite progress is unchanged: completed, 9/9 tasks, 5/5 epics, 0 blockers, 0 active sessions, recovery count 0.
- No runner or agent process is active; no reproducible defect was identified.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 remains terminal with Architect exit 1 and no persisted plan.
- SQLite-only run12 progress remains completed: 9 completed tasks, 5 completed epics, 0 blockers, 0 active sessions, recovery count 0.
- No runner/agent process is active and no new reproducible defect was found.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 submit log remains unchanged: Architect exit 1 with no persisted plan.
- SQLite-only run12 progress remains completed with 9/9 tasks, 5/5 epics, 0 blockers, 0 active sessions, and recovery count 0.
- No runner/agent process is active and no new reproducible defect was found.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 submit log remains terminal with the known Architect exit-1/no-plan result.
- SQLite-only run12 check remains completed: 9/9 tasks, 5/5 epics, no blockers, no active sessions, recovery count 0.
- No runner/agent process is active and no new reproducible defect was found.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 remains terminal with no persisted plan.
- Run12 remains completed in SQLite: 9/9 tasks, 5/5 epics, 0 blockers, 0 active sessions, recovery count 0.
- No runner or agent process is active; no new defect was found.
- No code change or additional E2E launch was performed.

## Current scheduled cycle

- Run11 submit log remains the known Architect exit-1/no-plan result.
- Run12 SQLite progress remains completed: all 9 tasks and 5 epics completed, no blockers, no active sessions, recovery count 0.
- No runner/agent process is active; no reproducible defect was identified.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 remains terminal with no persisted plan.
- Run12 remains completed in SQLite: 9/9 tasks, 5/5 epics, no blockers, no active sessions, recovery count 0.
- No active runner/agent process or new reproducible defect was found.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 submit log remains unchanged with Architect exit 1 and no persisted plan.
- Run12 SQLite progress remains completed: 9/9 tasks, 5/5 epics, 0 blockers, 0 active sessions, recovery count 0.
- No runner or agent process is active and no new defect was found.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 remains terminal with no persisted plan.
- Run12 remains completed in SQLite: 9/9 tasks, 5/5 epics, no blockers, no active sessions, recovery count 0.
- No runner/agent process is active; no reproducible defect was found.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 submit log remains the known Architect exit-1/no-plan result.
- Run12 SQLite progress remains completed: 9/9 tasks, 5/5 epics, 0 blockers, 0 active sessions, recovery count 0.
- No runner or agent process is active; no new reproducible defect was found.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 remains terminal with no persisted plan.
- Run12 remains completed in SQLite: 9/9 tasks, 5/5 epics, no blockers, no active sessions, recovery count 0.
- No active runner/agent process is present and no new defect was found.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 submit log remains the known Architect exit-1/no-plan result.
- Run12 SQLite status remains completed: all tasks and epics completed, 0 blockers, 0 active sessions, recovery count 0.
- No runner or agent process is active; no reproducible defect was identified.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 remains terminal with no persisted plan.
- Run12 remains completed in SQLite: 9/9 tasks and 5/5 epics completed, 0 blockers, 0 active sessions, recovery count 0.
- No runner/agent process is active and no new defect was found.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 submit log remains unchanged with Architect exit 1 and no persisted plan.
- Run12 SQLite status remains completed: 9/9 tasks, 5/5 epics, 0 blockers, 0 active sessions, recovery count 0.
- No runner or agent process is active; no reproducible defect was found.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 remains terminal with the known Architect exit-1/no-plan result.
- Run12 remains completed in SQLite: 9/9 tasks and 5/5 epics completed, 0 blockers, 0 active sessions, recovery count 0.
- No runner/agent process is active and no new defect was found.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 submit log remains terminal with Architect exit 1 and no persisted plan.
- Run12 SQLite progress remains completed: 9/9 tasks, 5/5 epics, 0 blockers, 0 active sessions, recovery count 0.
- No runner or agent process is active; no reproducible defect was found.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 remains terminal with no persisted plan.
- Run12 remains completed in SQLite: 9/9 tasks, 5/5 epics, no blockers, no active sessions, recovery count 0.
- No runner or agent process is active; no reproducible defect was found.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 remains terminal with the known Architect exit-1/no-plan result.
- Run12 remains completed in SQLite: 9/9 tasks and 5/5 epics completed, 0 blockers, 0 active sessions, recovery count 0.
- No runner/agent process is active and no new defect was found.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 submit log remains terminal with Architect exit 1 and no persisted plan.
- Run12 SQLite status remains completed: 9/9 tasks, 5/5 epics, 0 blockers, 0 active sessions, recovery count 0.
- No runner or agent process is active; no reproducible defect was found.
- No code change or additional expensive E2E launch was performed.

## Current scheduled cycle

- Run11 remains terminal with no persisted plan.
- Run12 remains completed in SQLite: 9/9 tasks, 5/5 epics, no blockers, no active sessions, recovery count 0.
- No runner/agent process is active; no reproducible defect was found.
- No code change or additional expensive E2E launch was performed.

## Run13

- User-requested replacement E2E started with the same Snake prompt.
- State: `/tmp/pi-epics-snake-run13`; submit log: `/tmp/pi-epics-snake-run13-submit.log`.
- Run13 is terminal with no persisted initiative or plan. Architecture attempt 1 returned an invalid contract; attempt 2 parsed successfully. Manager attempts 1-3 returned JSON-shaped plans, but architecture reconciliation rejected all of them because `snake_game/__init__.py` had two producers (`domain-model` and `public-api`). The terminal system failure was `invalid_manager_output` during manager planning, not provider transport.
- Diagnosis: duplicate artifact ownership was detected too late in `applyArchitectureExecutionPlan`, causing futile manager retries instead of rejecting the architecture contract at the architecture boundary.
- Fix applied: reject duplicate produced paths during architecture parsing and durable contract validation; tell Architect that every output path must have one producer; added regression tests.
- Verification: targeted runtime/profile tests passed; full offline suite passed 75/75; `npm run check` and `git diff --check` passed.
- Fix committed as `0a73ee8`.
- After offline verification and with no runner process active, started replacement run14 with the same Snake prompt.
- State: `/tmp/pi-epics-snake-run14`; submit log: `/tmp/pi-epics-snake-run14-submit.log`.
- Run14 final SQLite progress: initiative `initiative-13ff8a70-0cb3-4793-a834-455d1b36f293` completed; 8/8 tasks and 4/4 epics completed, 0 blockers, 0 active sessions, recovery count 0. Metrics show 10 successful agent outcomes and 24 passing gate/review outcomes; system failures 0 and every recorded review passed.
- Worker/reviewer telemetry includes recovered tool errors (13 worker, 7 reviewer), but no failed attempt, blocked node, or recovery cycle.
- Integrated commits were recorded on run14 branches. Release was not enabled, so the target repository main branch remains outside the release/finalize verification scope.
- Current policy: do not start another E2E without a new request.

## Current scheduled cycle

- Run11 submit log remains terminal with Architect exit 1 and no persisted plan.
- SQLite-only run14 progress remains completed: 8/8 tasks, 4/4 epics, 0 blockers, 0 active sessions, recovery count 0; outcomes remain 10 success and 24 pass.
- No runner or agent process is active; no new reproducible defect was found.
- No code change or additional E2E launch was performed.
