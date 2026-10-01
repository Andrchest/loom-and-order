import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ApplicationService } from "./application.ts";

export interface ParsedCommand {
  command: string;
  args: string[];
  positionals: string[];
  values: Record<string, string>;
  booleans: Set<string>;
}

export interface CommandContext extends ParsedCommand {
  json: boolean;
  machine: boolean;
  stateDir: string;
  service?: ApplicationService;
  /** Render a value using the CLI's existing human/machine JSON convention. */
  render(value: unknown): string;
  /** Write a rendered value followed by one newline. */
  output(value: unknown): void;
  /** Write raw text without changing it. */
  writeStdout(value: string): void;
  /** A handler may return a non-zero status without terminating the process. */
  exitCode?: number;
}

export interface CommandResult {
  exitCode?: number;
}

export interface CliCommandHandler {
  command: string;
  requiresService?: boolean;
  handle(context: CommandContext): CommandResult | void | Promise<CommandResult | void>;
}

export interface CliCommandModule {
  command: string;
  requiresService?: boolean;
  handle(context: CommandContext): CommandResult | void | Promise<CommandResult | void>;
}

export type CommandHandler = CliCommandHandler;
export type HandlerContext = CommandContext;

function isHandler(value: unknown): value is CliCommandHandler {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CliCommandHandler>;
  return typeof candidate.command === "string" && typeof candidate.handle === "function";
}

/**
 * Discover command extensions from the sibling src/cli-commands directory.
 * Modules may export a CliCommandModule as default, or export command/handle
 * named bindings. The latter keeps feature modules small and easy to test.
 */
export async function loadCommandHandlers(): Promise<Map<string, CliCommandHandler>> {
  const directory = fileURLToPath(new URL("./cli-commands/", import.meta.url));
  const handlers = new Map<string, CliCommandHandler>();
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    const module = await import(pathToFileURL(join(directory, entry.name)).href) as {
      default?: unknown;
      command?: unknown;
      requiresService?: unknown;
      handle?: unknown;
    };
    const candidate = isHandler(module.default)
      ? module.default
      : typeof module.command === "string" && typeof module.handle === "function"
        ? { command: module.command, requiresService: module.requiresService as boolean | undefined, handle: module.handle as CliCommandHandler["handle"] }
        : undefined;
    if (!candidate) throw new Error(`invalid CLI command handler module: ${entry.name}`);
    if (handlers.has(candidate.command)) throw new Error(`duplicate CLI command handler: ${candidate.command}`);
    handlers.set(candidate.command, candidate);
  }
  return handlers;
}

export const discoverCommandHandlers = loadCommandHandlers;

export function createCommandContext(parsed: ParsedCommand, options: {
  stateDir: string;
  service?: ApplicationService;
  machine: boolean;
  writeStdout?: (value: string) => void;
}): CommandContext {
  const render = (value: unknown): string => options.machine ? JSON.stringify(value) : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const writeStdout = options.writeStdout ?? ((value: string): void => process.stdout.write(value));
  return {
    ...parsed,
    json: options.machine,
    machine: options.machine,
    stateDir: options.stateDir,
    service: options.service,
    render,
    output: (value: unknown): void => writeStdout(`${render(value)}\n`),
    writeStdout,
  };
}
