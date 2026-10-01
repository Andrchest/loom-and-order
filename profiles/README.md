# Profiles

Profiles are the unit of per-role execution: which Pi binary, which model
(thinking level and pool), which skills/extensions/tools, timeouts, retry
budget, sandbox policy, and (optionally) a role prompt.

## What the repository ships

Two **example worker profiles** as templates only — they are not wired to any
real infrastructure and are not used by the runtime for the other roles:

| File | Purpose |
|---|---|
| `profiles/example-local.json` | Worker running on a **local model** (Ollama/vLLM-style). `pool: "local"`, `model: null` — the concrete model comes from `LAO_LOCAL_MODEL` at run time, so the same profile serves any local model you deploy. |
| `profiles/example-subscription.json` | Worker running on a **subscription provider** (Codex-style). `pool: "codex"`, a public example model, and an explicit `allowedDomains` list of the provider's public endpoints. |

Copy an example, change the `id` (unique across all profiles), the `role`,
and the model/domains, and save it with `lao profiles create <file> <id>` —
created profiles persist under `<state-dir>/custom-profiles/`.

## Creating profiles

```bash
# Write a profile file (see the examples for the shape)
lao profiles create ./my-worker.json my-worker
lao profiles list
lao profiles validate ./my-worker.json   # validate a file without saving
```

A profile must have a unique `id` (pattern `a-z0-9-`), one of the six roles,
and a supported `sandbox.backend` (`trusted-local` | `pi-sandbox`).

### Role coverage

The runtime needs a profile for each role it dispatches: `architect` and
`manager` for planning, `worker` for implementation, `reviewer` for review.
`researcher` and `release` are optional roles. If no profile is configured
for a role, the runtime fails closed at submit — configure all four core
roles first.

## Selecting profiles per role

Profiles are resolved per role with this precedence (highest wins):

1. `LAO_ROLE_PROFILES` — a JSON object mapping roles to profile IDs:
   ```bash
   LAO_ROLE_PROFILES='{"worker":"my-worker","reviewer":"my-reviewer"}' lao submit ...
   ```
2. `LAO_PROFILE_<ROLE>` — one variable per role:
   `LAO_PROFILE_WORKER=my-worker lao run <initiative-id>`

Within a single run every task of the same role uses the same profile.
Mixed pools across roles are normal (e.g., a local-model worker with a
subscription-model reviewer).

## Local models

A profile with `pool: "local"` and `model: null` picks up the model from
`LAO_LOCAL_MODEL=provider/model` at run time. If the provider is not visible
to the isolated agent, point `LAO_MODELS_FILE` at a provider catalog JSON
(it is symlinked into each agent directory).

## Subscription models

A profile with `pool: "codex"` uses the host's provider authentication
(`credentialMode: "host-auth"` in the examples) and needs the provider's
public endpoints in `allowedDomains` (the sandbox only enforces domains for
`pi-sandbox`; `trusted-local` does not).

## Sandboxing

`sandbox.backend: "trusted-local"` runs the agent as the host OS user with no
network or filesystem restrictions — use it only for code you trust and on
worktrees you can afford to let write. `pi-sandbox` runs the agent inside
bubblewrap/seccomp with a strict filesystem and `allowedDomains`
whitelist; it requires the `LAO_PI_SANDBOX_EXTENSION` path and fails closed
if it is missing. See `docs/sandbox.md`.

## Model catalog

`profiles/model-catalog.json` declares the model pools (`local`, `codex`)
and pool limits used by accounting and rate limiting. It intentionally
contains no concrete personal models — add yours via profiles.

## Skills

Role skills live in `profiles/skills/` (`architect`, `manager`, `worker`,
`reviewer`). Profiles reference them by name and they are materialized into
each isolated agent directory.
