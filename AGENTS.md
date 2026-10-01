# loom-and-order

This is a standalone project. Do not edit `/home/andreipc/auto-work` as part of this project.

## Purpose

Build a durable local multi-agent runtime for Pi. The runtime owns the initiative → epic → task → subtask DAG, launches isolated manager/worker/reviewer Pi profiles, records evidence, integrates only reviewed changes, and exposes one application API to CLI, TUI, and MCP clients.

## Rules

- Never silently run a worker without the configured sandbox backend.
- Never integrate a task without a passing reviewer and repository gate.
- Never change global Pi settings, credentials, or installed packages automatically.
- Tests must use fake Pi processes and temporary Git repositories; no live provider calls.
- Keep durable state outside target repositories by default.
- Do not copy the retired teamwork extension.
