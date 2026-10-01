import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CliCommandHandler, CommandContext } from "../cli-commands.ts";

export interface LatestSessionLog {
  path: string;
  name: string;
  mtimeMs: number;
}

/** Return the newest regular JSONL session log, with a stable name tie-breaker. */
export function findLatestSessionLog(logDir: string): LatestSessionLog | undefined {
  let entries;
  try {
    entries = readdirSync(logDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const candidates: LatestSessionLog[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const path = join(logDir, entry.name);
    try {
      const stats = statSync(path);
      if (stats.isFile()) candidates.push({ path, name: entry.name, mtimeMs: stats.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  candidates.sort((left, right) => {
    if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  return candidates[0];
}

// Short aliases keep the file helpers convenient for focused unit tests.
export const selectLatestSessionLog = findLatestSessionLog;
export const findLatestLog = findLatestSessionLog;

export interface IncrementalLogState {
  path?: string;
  offset: number;
  /** The complete bytes observed during the previous poll. */
  snapshot: Buffer;
}

export interface IncrementalLogResult {
  content: string;
  offset: number;
  state: IncrementalLogState;
}

/**
 * Read only bytes not emitted by the previous read.  Comparing the complete
 * previous snapshot, rather than just the length, catches in-place rewrites
 * that have the same (or a larger) size as the old file.
 */
export function readIncrementalLog(path: string, previous?: IncrementalLogState | number): IncrementalLogResult {
  const numericOffset = typeof previous === "number";
  const oldState: IncrementalLogState = numericOffset
    ? { offset: previous, snapshot: Buffer.alloc(0) }
    : previous ?? { offset: 0, snapshot: Buffer.alloc(0) };
  const bytes = readFileSync(path);
  const canAppend = numericOffset
    ? bytes.length >= oldState.offset
    : oldState.path === path && bytes.length >= oldState.offset && bytes.subarray(0, oldState.snapshot.length).equals(oldState.snapshot);
  const offset = canAppend ? oldState.offset : 0;
  const content = bytes.subarray(offset).toString("utf8");
  const state: IncrementalLogState = { path, offset: bytes.length, snapshot: bytes };
  return { content, offset: bytes.length, state };
}

export const readIncremental = readIncrementalLog;

export interface TimerSeam {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(timer: unknown): void;
}

export interface SignalSeam {
  on(signal: "SIGINT", listener: () => void): void;
  removeListener(signal: "SIGINT", listener: () => void): void;
}

export interface FollowSessionLogOptions {
  writeStdout?: (value: string) => void;
  /** `output` is an alias useful to small unit-test fixtures. */
  output?: (value: string) => void;
  timers?: TimerSeam;
  signals?: SignalSeam;
  intervalMs?: number;
}

const systemTimers: TimerSeam = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
};

const processSignals: SignalSeam = {
  on: (signal, listener) => process.on(signal, listener),
  removeListener: (signal, listener) => process.removeListener(signal, listener),
};

/** Follow the newest session log until SIGINT, without terminating the caller. */
export async function followSessionLog(logDir: string, options: FollowSessionLogOptions = {}): Promise<void> {
  const write = options.writeStdout ?? options.output ?? ((value: string): void => process.stdout.write(value));
  const timers = options.timers ?? systemTimers;
  const signals = options.signals ?? processSignals;
  const intervalMs = options.intervalMs ?? 1_000;
  let state: IncrementalLogState | undefined;

  const poll = (): void => {
    const latest = findLatestSessionLog(logDir);
    if (!latest) return;
    try {
      const result = readIncrementalLog(latest.path, state);
      state = result.state;
      if (result.content) write(result.content);
    } catch (error) {
      // A log can disappear between directory scan and read during rotation.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };

  if (!findLatestSessionLog(logDir)) throw new Error(`no regular JSONL session log found in ${logDir}`);
  poll();

  return await new Promise<void>((resolve) => {
    const timer = timers.setInterval(poll, intervalMs);
    const stop = (): void => {
      timers.clearInterval(timer);
      signals.removeListener("SIGINT", stop);
      resolve();
    };
    signals.on("SIGINT", stop);
  });
}

export const followLatestSessionLog = followSessionLog;

function serviceFor(context: CommandContext) {
  if (!context.service) throw new Error("logs requires an application service");
  return context.service;
}

export async function handle(context: CommandContext): Promise<void> {
  const initiativeId = context.args[0];
  if (context.booleans.has("follow")) {
    if (!initiativeId) throw new Error("logs --follow requires an initiative ID");
    await followSessionLog(join(context.stateDir, "logs"), { writeStdout: context.writeStdout });
    return;
  }
  context.output(serviceFor(context).logs(initiativeId));
}

const handler: CliCommandHandler = { command: "logs", handle };
export default handler;
