import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProfileResolver, type ModelPricing, type ResolvedProfile } from "./profiles.ts";
export type { ModelPricing } from "./profiles.ts";
import { flushObservedTraces, registerObservedArtifactContent, safeValue, startObservedSpan } from "./observability.ts";
import { SpanType, SpanStatusCode } from "mlflow-tracing";

export interface LaunchSpec {
  profile: ResolvedProfile;
  cwd: string;
  prompt: string;
  runId?: string;
  sessionId?: string;
  continueSession?: boolean;
  agentId?: string;
  timeoutMs?: number;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface TokenCounts {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
}

export interface RuntimeTelemetry extends TokenCounts {
  wallClockMs: number;
  ttftMs: number | null;
  generationMs: number | null;
  tokensPerSecond: number | null;
  /** Backward-compatible alias for apiCostUsd. */
  costUsd: number | null;
  apiCostUsd: number | null;
  costSource: "provider" | "profile-rate" | "model-rate" | "local-zero" | "unknown";
  codexCredits: number | null;
  codexCreditsSource: "profile-rate" | "model-rate" | "local-zero" | "unknown" | "not-applicable";
}

export interface PiRunResult {
  runId: string;
  sessionId?: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  events: any[];
  assistantText: string;
  agentEnded: boolean;
  stdoutPath: string;
  stderrPath: string;
  durationMs: number;
  eventCounts: Record<string, number>;
  toolCalls: number;
  toolErrors: number;
  usage: Record<string, number>;
  telemetry: RuntimeTelemetry;
  stdoutBytes: number;
  stderrBytes: number;
}

function numericValue(values: Record<string, number>, keys: string[]): number | null {
  for (const key of keys) if (typeof values[key] === "number" && Number.isFinite(values[key])) return values[key];
  return null;
}

function flattenedNumericValues(value: unknown, prefix = "", output: Record<string, number> = {}): Record<string, number> {
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "number" && Number.isFinite(child)) output[name] = child;
    else if (child && typeof child === "object") flattenedNumericValues(child, name, output);
  }
  return output;
}

function normalizedTokenCounts(usage: Record<string, number>): TokenCounts {
  const values: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) values[key.replace(/[.-]/g, "_").toLowerCase()] = value;
  return {
    inputTokens: numericValue(values, ["input_tokens", "input", "prompt_tokens"]),
    outputTokens: numericValue(values, ["output_tokens", "output", "completion_tokens"]),
    reasoningTokens: numericValue(values, ["reasoning_tokens", "reasoning", "completion_tokens_details_reasoning_tokens"]),
    cacheReadTokens: numericValue(values, ["cache_read_tokens", "cache_read", "cached_tokens", "prompt_tokens_details_cached_tokens"]),
    cacheWriteTokens: numericValue(values, ["cache_write_tokens", "cache_write"]),
    totalTokens: numericValue(values, ["total_tokens", "total"]),
  };
}

function providerCostUsd(usage: Record<string, number>): number | null {
  const values: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) values[key.replace(/[.-]/g, "_").toLowerCase()] = value;
  return numericValue(values, ["cost_usd", "costusd", "total_cost_usd", "totalcostusd", "cost"]);
}

function configuredPricing(profileId: string, model: string | null | undefined, profilePricing?: ModelPricing): { rate: ModelPricing | null; source: "profile-rate" | "model-rate" | "unknown" } {
  if (profilePricing) return { rate: profilePricing, source: "profile-rate" };
  const raw = process.env.LAO_MODEL_PRICING_JSON;
  if (!raw) return { rate: null, source: "unknown" };
  try {
    const table = JSON.parse(raw) as Record<string, ModelPricing>;
    const selected = table[model ?? ""] ?? table[profileId];
    return selected ? { rate: selected, source: "model-rate" } : { rate: null, source: "unknown" };
  } catch {
    return { rate: null, source: "unknown" };
  }
}

function rateCostUsd(tokens: TokenCounts, rate: ModelPricing): number | null {
  const values: Array<[number | null, number | undefined]> = [
    [tokens.inputTokens, rate.inputPerMillionUsd],
    [tokens.outputTokens, rate.outputPerMillionUsd],
    [tokens.reasoningTokens, rate.reasoningPerMillionUsd],
    [tokens.cacheReadTokens, rate.cacheReadPerMillionUsd],
    [tokens.cacheWriteTokens, rate.cacheWritePerMillionUsd],
  ];
  if (values.some(([count, price]) => count !== null && price !== undefined && (!Number.isFinite(price) || price < 0))) return null;
  const priced = values.filter(([count, price]) => count !== null && price !== undefined) as Array<[number, number]>;
  return priced.length ? priced.reduce((sum, [count, price]) => sum + count * price / 1_000_000, 0) : null;
}

function rateCostCredits(tokens: TokenCounts, rate: ModelPricing): number | null {
  const values: Array<[number | null, number | undefined]> = [
    [tokens.inputTokens, rate.codexInputCreditsPerMillion],
    [tokens.outputTokens, rate.codexOutputCreditsPerMillion],
    [tokens.cacheReadTokens, rate.codexCacheReadCreditsPerMillion],
    [tokens.cacheWriteTokens, rate.codexCacheWriteCreditsPerMillion],
  ];
  if (values.some(([count, price]) => count !== null && price !== undefined && (!Number.isFinite(price) || price < 0))) return null;
  const priced = values.filter(([count, price]) => count !== null && price !== undefined) as Array<[number, number]>;
  return priced.length ? priced.reduce((sum, [count, price]) => sum + count * price / 1_000_000, 0) : null;
}

export function deriveTelemetry(profile: { id: string; model?: string | null; pool?: "local" | "codex"; pricing?: ModelPricing }, usage: Record<string, number>, startedAt: number, endedAt: number, firstOutputAt: number | null): RuntimeTelemetry {
  const tokens = normalizedTokenCounts(usage);
  const wallClockMs = Math.max(0, endedAt - startedAt);
  const ttftMs = firstOutputAt === null ? null : Math.max(0, firstOutputAt - startedAt);
  const generationMs = ttftMs === null ? null : Math.max(0, wallClockMs - ttftMs);
  const tokensPerSecond = tokens.outputTokens !== null && generationMs !== null && generationMs > 0 ? tokens.outputTokens / (generationMs / 1000) : null;
  let costUsd = providerCostUsd(usage);
  let costSource: RuntimeTelemetry["costSource"] = costUsd !== null ? "provider" : "unknown";
  const pool = profile.pool ?? (profile.model?.startsWith("openai-codex/") ? "codex" : "local");
  const configured = configuredPricing(profile.id, profile.model, profile.pricing);
  if (pool === "local") {
    costUsd = 0;
    costSource = "local-zero";
  } else if (costUsd === null) {
    costUsd = configured.rate ? rateCostUsd(tokens, configured.rate) : null;
    costSource = costUsd === null ? "unknown" : configured.source;
  }
  const codexCredits = pool === "local" ? 0 : configured.rate ? rateCostCredits(tokens, configured.rate) : null;
  const codexCreditsSource: RuntimeTelemetry["codexCreditsSource"] = pool === "local" ? "local-zero" : codexCredits === null ? "unknown" : configured.source;
  return {
    ...tokens,
    wallClockMs,
    ttftMs,
    generationMs,
    tokensPerSecond,
    costUsd,
    apiCostUsd: costUsd,
    costSource,
    codexCredits,
    codexCreditsSource,
  };
}

function assistantOutputText(event: any): string {
  // Pi repeats the completed assistant message in turn_end. It is metadata,
  // not a second assistant response; counting it would corrupt JSON handoffs.
  if (event?.type === "turn_end") return "";
  const direct = [event?.delta, event?.text, event?.assistantMessageEvent?.delta, event?.assistantMessageEvent?.text].find((value) => typeof value === "string" && value.length > 0);
  if (direct) return direct;
  return textFromMessage(event?.message);
}

function textFromMessage(message: any): string {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("");
}

function mergeNumericUsage(target: Record<string, number>, source: unknown): Record<string, number> {
  return Object.assign(target, flattenedNumericValues(source));
}

function traceEvent(event: any): Record<string, unknown> {
  const type = typeof event?.type === "string" ? event.type : "unknown";
  const result: Record<string, unknown> = { type };
  if (type === "message_end") result.text_bytes = Buffer.byteLength(textFromMessage(event.message), "utf8");
  if (type === "tool_execution_start" || type === "tool_execution_end") {
    result.tool = event.toolName ?? event.tool_name ?? event.name ?? "tool";
    result.call_id = event.toolCallId ?? event.tool_call_id ?? event.callId ?? event.call_id;
    result.arguments = safeValue(event.args ?? event.arguments ?? event.input ?? event.parameters);
    result.result = safeValue(event.result ?? event.output ?? event.content);
    result.is_error = Boolean(event.isError ?? event.is_error);
  }
  if (event?.usage && typeof event.usage === "object") result.usage = safeValue(event.usage);
  return result;
}

export function buildPiInvocation(spec: LaunchSpec): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const sessionId = spec.sessionId ?? spec.runId ?? randomUUID();
  const args = [
    "--mode", "json",
    "--print",
    "--no-approve",
    "--session-dir", spec.profile.sessionDir,
    ...(spec.continueSession ? [] : ["--session-id", sessionId]),
    "--name", `${spec.profile.role}-${sessionId}`,
    "--tools", spec.profile.tools.join(","),
  ];
  if (spec.continueSession) args.push("--continue");
  if (spec.profile.model) args.push("--model", spec.profile.model);
  if (spec.profile.thinkingLevel) args.push("--thinking", spec.profile.thinkingLevel);
  if (spec.profile.sandbox.backend === "sbx") {
    if (!spec.profile.sandbox.sandboxName) throw new Error("sbx profile has no sandboxName");
    return {
      command: "sbx",
      args: ["exec", spec.profile.sandbox.sandboxName, "--", spec.profile.piBin, ...args, spec.prompt],
      env: buildEnvironment(spec.profile, spec.baseEnv),
    };
  }
  if (spec.profile.sandbox.backend === "trusted-local") {
    return { command: spec.profile.piBin, args: [...args, spec.prompt], env: buildEnvironment(spec.profile, spec.baseEnv) };
  }
  if (spec.profile.sandbox.backend !== "pi-sandbox") throw new Error("unknown sandbox backend");
  if (!spec.profile.sandbox.extensionPath) throw new Error("pi-sandbox extension is not configured");
  return { command: spec.profile.piBin, args: [...args, spec.prompt], env: buildEnvironment(spec.profile, spec.baseEnv) };
}

const SIGKILL_GRACE_MS = 5_000;

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* the process already exited */ }
  }
}

function buildEnvironment(profile: ResolvedProfile, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  env.PI_MCP_CONFIG_MODE = "exclusive";
  env.PI_CODING_AGENT_DIR = profile.agentDir;
  env.PI_CODING_AGENT_SESSION_DIR = profile.sessionDir;
  env.PI_SKIP_VERSION_CHECK = "1";
  env.PI_TELEMETRY = "0";
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  if (profile.sandbox.credentialMode === "explicit-profile-auth") {
    for (const key of Object.keys(env)) {
      if (key.endsWith("_API_KEY") || key.endsWith("_OAUTH_TOKEN") || key === "AWS_ACCESS_KEY_ID" || key === "AWS_SECRET_ACCESS_KEY") delete env[key];
    }
  }
  return env;
}

export class PiLauncher {
  readonly resolver: ProfileResolver;
  readonly logDir: string;
  readonly env: NodeJS.ProcessEnv;

  constructor(stateDir: string, logDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    this.resolver = new ProfileResolver(stateDir, env);
    this.logDir = logDir;
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
  }

  private prepareProjectMcp(agentDir: string, cwd: string): void {
    const projectConfig = join(cwd, ".mcp.json");
    const isolatedConfig = join(agentDir, "mcp.json");
    if (existsSync(projectConfig)) copyFileSync(projectConfig, isolatedConfig);
    else writeFileSync(isolatedConfig, '{"mcpServers":{}}\n', { mode: 0o600 });
  }

  async run(input: { profile: import("./profiles.ts").ProfileManifest; cwd: string; prompt: string; runId?: string; sessionId?: string; continueSession?: boolean; agentId?: string; timeoutMs?: number }): Promise<PiRunResult> {
    const runId = input.runId ?? randomUUID();
    const sessionId = input.sessionId ?? runId;
    // Pi rejects --session-id together with --continue. Reuse the original
    // run's profile/session directory so --continue resumes that exact session.
    const profile = this.resolver.resolve(input.profile, input.continueSession ? sessionId : runId);
    this.prepareProjectMcp(profile.agentDir, input.cwd);
    const invocation = buildPiInvocation({ profile, cwd: input.cwd, prompt: input.prompt, runId, sessionId, continueSession: input.continueSession, timeoutMs: input.timeoutMs, baseEnv: this.env });
    const stdoutPath = join(this.logDir, `${runId}.stdout.jsonl`);
    const stderrPath = join(this.logDir, `${runId}.stderr.log`);
    writeFileSync(stdoutPath, "", { mode: 0o600 });
    writeFileSync(stderrPath, "", { mode: 0o600 });
    const startedAt = Date.now();
    const roleTrace = startObservedSpan({
      name: `pi:${profile.role}`,
      spanType: SpanType.AGENT,
      inputs: { role: profile.role, run_id: runId, agent_id: input.agentId, profile: profile.id, model: profile.model, sandbox: profile.sandbox.backend },
      attributes: { "pi.role": profile.role, "pi.run_id": runId, "pi.agent_id": input.agentId ?? "unknown", "pi.profile": profile.id, "pi.sandbox": profile.sandbox.backend },
    });
    const eventCounts: Record<string, number> = {};
    let toolCalls = 0;
    let toolErrors = 0;
    let usage: Record<string, number> = {};
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const child = spawn(invocation.command, invocation.args, {
      cwd: input.cwd,
      env: invocation.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    const events: any[] = [];
    const traceEvents: Record<string, unknown>[] = [];
    let assistantText = "";
    let agentEnded = false;
    let firstOutputAt: number | null = null;
    const consumeEvent = (event: any): void => {
      const observedAt = Date.now();
      events.push(event);
      traceEvents.push(traceEvent(event));
      roleTrace.observePiEvent(event);
      eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
      const outputText = assistantOutputText(event);
      if (outputText) {
        if (firstOutputAt === null) firstOutputAt = observedAt;
        if (event.type === "message_end") {
          assistantText = outputText;
        } else {
          assistantText += outputText;
        }
      }
      if (event.type === "tool_execution_end") {
        toolCalls += 1;
        if (event.isError) toolErrors += 1;
      }
      const eventUsage = event.usage ?? event.assistantMessageEvent?.usage ?? event.message?.usage;
      if (eventUsage && typeof eventUsage === "object") mergeNumericUsage(usage, eventUsage);
      if (event.type === "agent_end") agentEnded = true;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      appendFileSync(stdoutPath, chunk);
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          try { consumeEvent(JSON.parse(line)); }
          catch { /* raw output is retained; malformed lines remain evidence */ }
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      appendFileSync(stderrPath, chunk);
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      // Escalate to SIGKILL if the process tree ignores SIGTERM; without this a
      // stuck Pi child would hold the initiative run loop indefinitely.
      const escalation = setTimeout(() => killTree(child, "SIGKILL"), SIGKILL_GRACE_MS);
      escalation.unref?.();
    }, input.timeoutMs ?? input.profile.timeoutMs);
    let result: { code: number | null; signal: NodeJS.Signals | null };
    try {
      result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
    } catch (error) {
      clearTimeout(timeout);
      roleTrace.finishOpenTools();
      roleTrace.fail(error, { run_id: runId, error: String(error) });
      await flushObservedTraces();
      throw error;
    }
    clearTimeout(timeout);
    if (buffer.trim()) {
      appendFileSync(stdoutPath, buffer);
      try { consumeEvent(JSON.parse(buffer)); }
      catch { /* malformed tail remains evidence */ }
    }
    const endedAt = Date.now();
    const telemetry = deriveTelemetry(profile, usage, startedAt, endedAt, firstOutputAt);
    roleTrace.setAttributes({
      "pi.model": profile.model ?? "unknown",
      "pi.wall_clock_ms": telemetry.wallClockMs,
      "pi.ttft_ms": telemetry.ttftMs ?? -1,
      "pi.generation_ms": telemetry.generationMs ?? -1,
      "pi.tokens_per_second": telemetry.tokensPerSecond ?? -1,
      "pi.cost_usd": telemetry.costUsd ?? -1,
      "pi.api_cost_usd": telemetry.apiCostUsd ?? -1,
      "pi.codex_credits": telemetry.codexCredits ?? -1,
      "pi.cost_source": telemetry.costSource,
      "pi.codex_credits_source": telemetry.codexCreditsSource,
    });
    registerObservedArtifactContent(roleTrace, "pi-events.json", JSON.stringify(traceEvents));
    roleTrace.finishOpenTools();
    roleTrace.finish({
      run_id: runId,
      profile: profile.id,
      model: profile.model,
      exit_code: result.code,
      signal: result.signal,
      timed_out: timedOut,
      agent_ended: agentEnded,
      assistant_text: assistantText,
      event_counts: eventCounts,
      tool_calls: toolCalls,
      tool_errors: toolErrors,
      usage,
      telemetry,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
    }, result.code === 0 && !timedOut && agentEnded ? SpanStatusCode.OK : SpanStatusCode.ERROR);
    await flushObservedTraces();
    return {
      runId,
      sessionId,
      exitCode: result.code,
      signal: result.signal,
      timedOut,
      events,
      assistantText,
      agentEnded,
      stdoutPath,
      stderrPath,
      durationMs: telemetry.wallClockMs,
      eventCounts,
      toolCalls,
      toolErrors,
      usage,
      telemetry,
      stdoutBytes,
      stderrBytes,
    };
  }
}
