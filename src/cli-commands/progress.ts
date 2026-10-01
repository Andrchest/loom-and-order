import type { CliCommandHandler, CommandContext } from "../cli-commands.ts";

export interface TimerSeam {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(timer: unknown): void;
}

export interface SignalSeam {
  on(signal: "SIGINT", listener: () => void): void;
  removeListener(signal: "SIGINT", listener: () => void): void;
}

export interface WatchProgressOptions {
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

/** Only these initiative states make a one-shot watched progress check pass. */
export function progressExitCode(snapshot: unknown): 0 | 1 {
  const status = typeof snapshot === "string"
    ? snapshot
    : (snapshot as { initiative?: { status?: unknown } } | null)?.initiative?.status;
  return status === "completed" || status === "failed" || status === "cancelled" ? 0 : 1;
}

export const isTerminalProgress = (snapshot: unknown): boolean => progressExitCode(snapshot) === 0;

/**
 * Render progress immediately and continue rendering until SIGINT.  Timer and
 * signal implementations are injectable so this lifecycle can be tested
 * without waiting or installing process listeners.
 */
export async function watchProgress(
  render: () => void,
  options: WatchProgressOptions = {},
): Promise<void> {
  const timers = options.timers ?? systemTimers;
  const signals = options.signals ?? processSignals;
  const intervalMs = options.intervalMs ?? 1_000;

  render();
  return await new Promise<void>((resolve) => {
    let timer: unknown;
    let timerScheduled = false;
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (timerScheduled) timers.clearInterval(timer);
      signals.removeListener("SIGINT", stop);
      resolve();
    };
    timer = timers.setInterval(render, intervalMs);
    timerScheduled = true;
    signals.on("SIGINT", stop);
  });
}

// Explicit alias for callers/tests that want to emphasize the long-running mode.
export const followProgress = watchProgress;

function serviceFor(context: CommandContext) {
  if (!context.service) throw new Error("progress requires an application service");
  return context.service;
}

export async function handle(context: CommandContext, options: WatchProgressOptions = {}): Promise<{ exitCode?: 0 | 1 }> {
  const initiativeId = context.args[0];
  if (!initiativeId) throw new Error("progress requires an initiative ID");
  const watching = context.booleans.has("watch");
  const once = context.booleans.has("once");
  if (once && !watching) throw new Error("progress --once requires --watch");

  const service = serviceFor(context);
  const render = (): unknown => {
    const snapshot = service.progress(initiativeId);
    context.output(snapshot);
    return snapshot;
  };

  if (!watching) {
    render();
    return {};
  }

  if (once) {
    return { exitCode: progressExitCode(render()) };
  }

  await watchProgress(() => { render(); }, {
    ...options,
    intervalMs: options.intervalMs ?? (context.values["interval-ms"] === undefined ? undefined : Number(context.values["interval-ms"])),
  });
  return {};
}

const handler: CliCommandHandler = { command: "progress", handle };
export default handler;
