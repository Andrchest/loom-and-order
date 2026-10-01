# Execution backends

## Default: `trusted-local`

The default backend launches the Pi process directly, but does not use the global Pi profile. Every run gets a distinct `PI_CODING_AGENT_DIR` and session directory under the runner state directory. This gives workers normal coding tools and lets Git linked worktrees operate without sandbox path problems.

This is a trust mode, not an OS security boundary. Worker code can access files and commands available to the operating-system user. Use it only for trusted repositories and workers.

## Optional: `@erichll/pi-sandbox`

The first runtime adapter loads the reviewed Pi extension `@erichll/pi-sandbox`. On Linux it uses bubblewrap mount/network namespaces and seccomp, and can maintain separate policies for process-backed subagents. Install its native prerequisites separately (`bubblewrap`, `socat`, `ripgrep`) and configure its trusted global policy according to the package documentation.

A profile using this backend must name the extension through `LAO_PI_SANDBOX_EXTENSION`. If it is absent, that profile refuses to run. The trusted-local backend is not a fallback: it is a separate explicit backend selected by the profile. Network domains are written into the profile-owned sandbox config and are fail-closed at the sandbox runtime boundary.

Important limitation: this backend protects Pi tools, not the host Pi process's provider authentication. The initial profiles use `host-auth`; this is a local trusted-development mode, not a complete secrets boundary. Do not use it for hostile repositories with broad credentials.

## Planned: Docker Sandboxes (`sbx`)

Pi's current containerization documentation and the Docker kit describe:

```bash
sbx secret set anthropic
sbx run --kit "docker.io/sbx/pi-kit:latest" pi
sbx exec <sandbox-name> -- pi -p "..."
```

The official kit pre-bakes Pi, runs the whole Pi process in a Docker Sandboxes microVM, and routes provider credentials through a host-side proxy. Bindings are wired when the sandbox is created and a sandbox must be recreated after changing them. The kit's `latest` tag also tracks rolling Pi releases, so production use should record and pin a known kit/image policy.

The future adapter will create or select named sandboxes, mount only the task worktree, pass profile skills/extensions, and use `credentialMode: broker`. Until that adapter exists, selecting `sbx` is intentionally rejected by the CLI rather than emulated by plain Docker.

## Git and worktree policy

The host runner creates one worktree and branch per task. Workers are expected to modify only that directory and create exactly one clean commit. Workers never push or merge. The host validates source cleanliness, branch/worktree identity, commit count, reviewer verdict, and repository gate before integrating into an epic or release branch.

## General limits

- A writable worktree remains writable to the agent by design; sandboxing does not make the result correct.
- Network allowlists are not a complete data-loss prevention boundary if an allowed multi-tenant host can receive arbitrary uploads.
- Host kernel, Docker/bwrap/QEMU, Pi binary, extensions, skills, and provider remain part of the trusted computing base for their backend.
