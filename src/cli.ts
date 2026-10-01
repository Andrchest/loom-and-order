#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ApplicationService } from "./application.ts";
import { createCommandContext, loadCommandHandlers, type ParsedCommand } from "./cli-commands.ts";
import { parseArchitectureContract } from "./runtime.ts";
import { serveMcp } from "./mcp.ts";
import { runDashboard } from "./tui.ts";
import type { PlanSpec } from "./domain.ts";

function help(): void {
  console.log(`loom-and-order - durable manager/worker/reviewer/researcher/release runtime

Commands:
  submit --repo PATH --prompt TEXT [--plan-file PATH] [--architecture-file PATH] [--auto-prune] [--no-start] [--enable-release]
  run INITIATIVE_ID
  tree INITIATIVE_ID
  status NODE_OR_INITIATIVE_ID
  progress INITIATIVE_ID [--watch [--once]]
  events [--limit N]
  doctor
  architecture-contract get|list|create INITIATIVE_ID [--revision N] [--file CONTRACT.json] [--reason TEXT]
  message INITIATIVE_ID TEXT
  plan-edit INITIATIVE_ID --file PATCH.json
  pause INITIATIVE_ID
  resume NODE_OR_INITIATIVE_ID
  dashboard INITIATIVE_ID
  logs [NODE_ID] | logs INITIATIVE_ID --follow
  metrics INITIATIVE_ID [--prometheus] [--out FILE]
  deliver INITIATIVE_ID
  prune [INITIATIVE_ID] [--all] [--include-epics] [--dry-run]
  recover
  supervise [--follow]
  supervisor-status
  toolchain status|update
  feed [INITIATIVE_ID] [--after EVENT_ID] [--limit N] [--follow]
  agents [INITIATIVE_ID]
  agent-sessions [INITIATIVE_ID] [--state STATE]
  profiles list
  profiles validate --file PROFILE.json
  profiles create --file PROFILE.json [--overwrite]
  profiles clone SOURCE_ID --id TARGET_ID [--overrides-json JSON]
  agent-profile-create AGENT_ID [--profile-id ID] [--overrides-json JSON] [--overwrite]
  mcp

Options:
  --state-dir PATH   durable state directory
  --gate-json JSON   gate command, e.g. '["npm","test"]'
  --json             machine-readable output
  --enable-release   explicitly enable release/integration profile scheduling
  --auto-prune       opt in to automatic task/subtask cleanup; LAO_AUTO_PRUNE accepts true, 1, yes, or on (default off)
  --follow           keep polling a live supervisor/feed or session log
  --after ID         feed cursor (exclusive)
  --limit N          maximum feed/events records
  --out FILE         write metrics to FILE instead of stdout
  --watch            watch progress until interrupted
  --once             render one watched progress snapshot and exit`);
}

function parseArgs(argv: string[]): { positionals: string[]; values: Record<string, string>; booleans: Set<string> } {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const key = arg.slice(2);
    if (key === "no-start" || key === "json" || key === "help" || key === "prometheus" || key === "overwrite" || key === "enable-release" || key === "auto-prune" || key === "follow" || key === "watch" || key === "once" || key === "all" || key === "include-epics" || key === "dry-run") { booleans.add(key); values[key] = "true"; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`missing value for --${key}`);
    values[key] = value;
  }
  return { positionals, values, booleans };
}

function output(value: unknown, machine: boolean): void {
  console.log(machine ? JSON.stringify(value) : typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function defaultStateDir(): string {
  return resolve(process.env.LAO_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? ".", ".local", "state"), "loom-and-order"));
}

function makeService(values: Record<string, string>, autoStart: boolean): ApplicationService {
  let gateCommand: string[] | undefined;
  if (values["gate-json"]) {
    gateCommand = JSON.parse(values["gate-json"]);
    if (!Array.isArray(gateCommand) || !gateCommand.length) throw new Error("--gate-json must be a non-empty JSON array");
  }
  return new ApplicationService({ stateDir: values["state-dir"], gateCommand, autoStart, enableRelease: values["enable-release"] === "true" });
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.positionals[0];
  const args = parsed.positionals.slice(1);
  const machine = parsed.booleans.has("json");
  if (!command || command === "help" || parsed.booleans.has("help")) { help(); return; }
  const handlers = await loadCommandHandlers();
  const handler = handlers.get(command);
  if (handler) {
    const service = handler.requiresService === false ? undefined : makeService(parsed.values, false);
    try {
      const commandContext = createCommandContext({
        command,
        args,
        positionals: parsed.positionals,
        values: parsed.values,
        booleans: parsed.booleans,
      } satisfies ParsedCommand, {
        stateDir: service?.stateDir ?? resolve(parsed.values["state-dir"] ?? defaultStateDir()),
        service,
        machine,
      });
      const result = await handler.handle(commandContext);
      if (result?.exitCode !== undefined) process.exitCode = result.exitCode;
      if (commandContext.exitCode !== undefined) process.exitCode = commandContext.exitCode;
    } finally {
      service?.close();
    }
    return;
  }
  if (command === "mcp") {
    const service = makeService(parsed.values, false);
    await serveMcp(service);
    service.close();
    return;
  }
  if (command === "run") {
    if (!args[0]) throw new Error("run requires an initiative ID");
    const service = makeService(parsed.values, false);
    try { output(await service.run(args[0]), machine); } finally { service.close(); }
    return;
  }
  const service = makeService(parsed.values, command === "submit" && !parsed.booleans.has("no-start"));
  try {
    switch (command) {
      case "submit": {
        const repo = parsed.values.repo;
        const prompt = parsed.values.prompt;
        if (!repo || !prompt) throw new Error("submit requires --repo and --prompt");
        const plan = parsed.values["plan-file"] ? JSON.parse(readFileSync(parsed.values["plan-file"], "utf8")) as PlanSpec : undefined;
        let architecture;
        if (parsed.values["architecture-file"]) {
          architecture = parseArchitectureContract(readFileSync(parsed.values["architecture-file"], "utf8"));
          if (!architecture) throw new Error("--architecture-file must contain a valid architecture contract draft");
        }
        const submissionOptions = parsed.booleans.has("auto-prune") ? { autoPrune: true } : undefined;
        output(await service.submit(repo, prompt, plan, architecture, submissionOptions), machine);
        break;
      }
      case "tree": output(service.tree(args[0]), machine); break;
      case "status": output(service.status(args[0]), machine); break;
      case "progress": output(service.progress(args[0]), machine); break;
      case "architecture-contract": {
        const action = args[0] ?? "get";
        const initiativeId = args[1];
        if (!initiativeId) throw new Error("architecture-contract requires an initiative ID");
        if (action === "get") output(service.architectureContract(initiativeId, parsed.values.revision ? Number(parsed.values.revision) : undefined), machine);
        else if (action === "list") output(service.architectureContracts(initiativeId), machine);
        else if (action === "create") {
          const file = parsed.values.file;
          if (!file) throw new Error("architecture-contract create requires --file CONTRACT.json");
          output(service.saveArchitectureContract(JSON.parse(readFileSync(file, "utf8")), parsed.values.reason), machine);
        } else throw new Error(`unknown architecture-contract action ${action}`);
        break;
      }
      case "message": output({ messageId: service.message(args[0], args.slice(1).join(" ")) }, machine); break;
      case "plan-edit": {
        const file = parsed.values.file;
        if (!file) throw new Error("plan-edit requires --file PATCH.json");
        output(service.planEdit(args[0], JSON.parse(readFileSync(file, "utf8"))), machine);
        break;
      }
      case "pause": service.pause(args[0]); output({ ok: true }, machine); break;
      case "resume": service.resume(args[0]); output({ ok: true }, machine); break;
      case "dashboard": await runDashboard(service, args[0]); break;
      case "logs": output(service.logs(args[0]), machine); break;
      case "deliver": {
        if (!args[0]) throw new Error("deliver requires an initiative ID");
        output(await service.deliver(args[0]), machine);
        break;
      }
      case "prune": {
        output(service.prune({ initiativeId: args[0], all: parsed.booleans.has("all"), includeEpics: parsed.booleans.has("include-epics"), dryRun: parsed.booleans.has("dry-run") }), machine);
        break;
      }
      case "recover": output({ recovered: service.recover() }, machine); break;
      case "supervisor-status": output(service.supervisorStatus(), machine); break;
      case "toolchain": {
        const action = args[0] ?? "status";
        if (action === "status") output(service.toolchainStatus(), machine);
        else if (action === "update") output(await service.updateToolchain(), machine);
        else throw new Error(`unknown toolchain action ${action}`);
        break;
      }
      case "supervise": {
        if (!parsed.booleans.has("follow")) {
          output(service.superviseOnce(), machine);
          break;
        }
        const render = (): void => output(service.superviseOnce(), machine);
        render();
        await new Promise<void>((resolve) => {
          let timer: NodeJS.Timeout;
          const stop = (): void => { clearInterval(timer); process.removeListener("SIGINT", stop); resolve(); };
          process.on("SIGINT", stop);
          timer = setInterval(render, Number(parsed.values["interval-ms"] ?? 10_000));
        });
        break;
      }
      case "feed": {
        const initiativeId = args[0];
        let cursor = Number(parsed.values.after ?? 0);
        const limit = Number(parsed.values.limit ?? 100);
        const render = (): void => {
          const events = service.feed(initiativeId, cursor, limit);
          if (events.length) {
            output(events, machine);
            cursor = events[events.length - 1].id;
          }
        };
        render();
        if (parsed.booleans.has("follow")) {
          await new Promise<void>((resolve) => {
            let timer: NodeJS.Timeout;
            const stop = (): void => { clearInterval(timer); process.removeListener("SIGINT", stop); resolve(); };
            process.on("SIGINT", stop);
            timer = setInterval(render, 500);
          });
        }
        break;
      }
      case "agents": output(service.agents(args[0]), machine); break;
      case "agent-sessions": output(service.agentSessions(args[0], parsed.values.state), machine); break;
      case "agent-profile-create": {
        if (!args[0]) throw new Error("agent-profile-create requires AGENT_ID");
        const overrides = parsed.values["overrides-json"] ? JSON.parse(parsed.values["overrides-json"]) : {};
        output(service.createAgentProfile(args[0], parsed.values["profile-id"], overrides, parsed.booleans.has("overwrite")), machine);
        break;
      }
      case "profiles": {
        const subcommand = args[0] ?? "list";
        if (subcommand === "list") output(service.listProfiles(), machine);
        else if (subcommand === "validate") {
          const file = parsed.values.file;
          if (!file) throw new Error("profiles validate requires --file PROFILE.json");
          output(service.validateProfile(JSON.parse(readFileSync(file, "utf8"))), machine);
        } else if (subcommand === "create") {
          const file = parsed.values.file;
          if (!file) throw new Error("profiles create requires --file PROFILE.json");
          output(service.saveCustomProfile(JSON.parse(readFileSync(file, "utf8")), parsed.booleans.has("overwrite")), machine);
        } else if (subcommand === "clone") {
          const source = args[1];
          const id = parsed.values.id;
          if (!source || !id) throw new Error("profiles clone requires SOURCE_ID and --id TARGET_ID");
          const overrides = parsed.values["overrides-json"] ? JSON.parse(parsed.values["overrides-json"]) : {};
          output(service.cloneProfile(source, id, overrides), machine);
        } else throw new Error(`unknown profiles subcommand ${subcommand}`);
        break;
      }
      default: help(); throw new Error(`unknown command ${command}`);
    }
  } finally {
    service.close();
  }
}

main().catch((error) => { console.error(`error: ${String(error)}`); process.exitCode = 1; });
