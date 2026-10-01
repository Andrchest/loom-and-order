import { readFileSync } from "node:fs";
import {
  flushTraces,
  getCurrentActiveSpan,
  init,
  startSpan,
  withSpan,
  SpanStatusCode,
  SpanType,
  type LiveSpan,
} from "mlflow-tracing";

const DEFAULT_TRACKING_URI = "http://127.0.0.1:5000";
const DEFAULT_EXPERIMENT_ID = "1";
const MAX_STRING_LENGTH = 12_000;
const MAX_COLLECTION_ITEMS = 50;
const SECRET_KEY = /(api[-_ ]?key|authorization|credential|password|secret|token|private[-_ ]?key|cookie|thinking|reasoning|chain[-_ ]?of[-_ ]?thought|prompt|output|stdout|stderr|path|file|cwd|directory|assistant|message|text|argument|result)/i;
const SECRET_VALUE = /((?:bearer|basic)\s+)[^\s]+/gi;

let initializationAttempted = false;
let initialized = false;
let toolSequence = 0;
const completedRootTraceIds = new Set<string>();
const pendingArtifacts = new Map<string, Array<{ name: string; content: string | Uint8Array }>>();
const warnings: string[] = [];

function noteWarning(kind: string, error?: unknown): void {
  const suffix = error === undefined ? "" : `: ${redactText(errorText(error))}`;
  warnings.push(`${kind}${suffix}`.slice(0, 500));
  if (warnings.length > 50) warnings.shift();
}

function isDisabled(): boolean {
  const value = process.env.LAO_MLFLOW_ENABLED?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off";
}

function trackingUri(): string {
  return process.env.LAO_MLFLOW_TRACKING_URI ?? process.env.MLFLOW_TRACKING_URI ?? DEFAULT_TRACKING_URI;
}

function experimentId(): string {
  const configured = process.env.LAO_MLFLOW_EXPERIMENT_ID ?? process.env.MLFLOW_EXPERIMENT_ID;
  if (configured) return configured;
  const stateHome = process.env.XDG_STATE_HOME ?? `${process.env.HOME ?? "."}/.local/state`;
  try {
    const persisted = readFileSync(`${stateHome}/loom-and-order/mlflow/experiment-id`, "utf8").trim();
    if (persisted) return persisted;
  } catch {
    // The local setup script creates this file; the fixed default keeps first-run
    // configuration deterministic when the file is not present yet.
  }
  return DEFAULT_EXPERIMENT_ID;
}

function redactText(value: string): string {
  return value
    .replace(SECRET_VALUE, "$1[REDACTED]")
    .replace(/(api[-_ ]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, MAX_STRING_LENGTH);
}

export function safeValue(value: unknown, key = "", depth = 0): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactText(value);
  if (depth >= 4) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, MAX_COLLECTION_ITEMS).map((item) => safeValue(item, key, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, MAX_COLLECTION_ITEMS)) {
      result[childKey] = safeValue(childValue, childKey, depth + 1);
    }
    return result;
  }
  return String(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initialize(): boolean {
  if (initializationAttempted) return initialized;
  initializationAttempted = true;
  if (isDisabled()) return false;
  try {
    init({ trackingUri: trackingUri(), experimentId: experimentId() });
    initialized = true;
  } catch (error) {
    // Observability must never stop an agent. The error is intentionally short and
    // does not contain prompts, tool output, credentials, or filesystem contents.
    noteWarning("mlflow_initialization_failed", error);
    if (process.env.LAO_MLFLOW_DEBUG === "1") {
      console.warn(`MLflow tracing disabled after initialization failure: ${redactText(errorText(error))}`);
    }
  }
  return initialized;
}

export interface ObservedSpanOptions {
  name: string;
  spanType?: SpanType;
  inputs?: unknown;
  attributes?: Record<string, unknown>;
  parent?: TraceHandle;
}

export class TraceHandle {
  readonly span: LiveSpan | null;
  readonly manual: boolean;
  private finished = false;
  private readonly tools = new Map<string, TraceHandle>();

  constructor(span: LiveSpan | null, manual: boolean) {
    this.span = span;
    this.manual = manual;
  }

  get isActive(): boolean {
    return this.span !== null;
  }

  setOutputs(outputs: unknown): void {
    this.span?.setOutputs(safeValue(outputs));
  }

  setAttributes(attributes: Record<string, unknown>): void {
    this.span?.setAttributes(safeValue(attributes) as Record<string, unknown>);
  }

  finish(outputs?: unknown, status: SpanStatusCode = SpanStatusCode.OK): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.span) return;
    if (outputs !== undefined) this.span.setOutputs(safeValue(outputs));
    this.span.setStatus(status);
    if (this.manual) this.span.end();
    if (this.span.parentId === null) completedRootTraceIds.add(this.span.traceId);
  }

  fail(error: unknown, outputs?: unknown): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.span) return;
    if (outputs !== undefined) this.span.setOutputs(safeValue(outputs));
    this.span.recordException(error instanceof Error ? error : new Error(errorText(error)));
    this.span.setStatus(SpanStatusCode.ERROR, redactText(errorText(error)));
    if (this.manual) this.span.end();
    if (this.span.parentId === null) completedRootTraceIds.add(this.span.traceId);
  }

  child(options: Omit<ObservedSpanOptions, "parent">): TraceHandle {
    return startObservedSpan({ ...options, parent: this });
  }

  observePiEvent(event: any): void {
    const eventType = typeof event?.type === "string" ? event.type : "";
    if (eventType === "tool_execution_start") {
      const name = String(event.toolName ?? event.tool_name ?? event.name ?? "tool");
      const id = String(event.toolCallId ?? event.tool_call_id ?? event.callId ?? event.call_id ?? `${name}-${toolSequence++}`);
      const child = this.child({
        name: `tool:${name}`,
        spanType: SpanType.TOOL,
        inputs: {
          tool: name,
          call_id: id,
          arguments: event.args ?? event.arguments ?? event.input ?? event.parameters,
        },
        attributes: { "pi.tool": name, "pi.tool_call_id": id },
      });
      this.tools.set(id, child);
      return;
    }
    if (eventType !== "tool_execution_end") return;
    const id = String(event.toolCallId ?? event.tool_call_id ?? event.callId ?? event.call_id ?? "");
    const child = this.tools.get(id);
    if (!child) return;
    child.finish({
      call_id: id,
      result: event.result ?? event.output ?? event.content,
      is_error: Boolean(event.isError ?? event.is_error),
    }, (event.isError ?? event.is_error) ? SpanStatusCode.ERROR : SpanStatusCode.OK);
    this.tools.delete(id);
  }

  finishOpenTools(): void {
    for (const [id, tool] of this.tools) {
      tool.finish({ call_id: id, result: "tool event stream ended before completion" }, SpanStatusCode.ERROR);
    }
    this.tools.clear();
  }
}

export function startObservedSpan(options: ObservedSpanOptions): TraceHandle {
  if (!initialize()) return new TraceHandle(null, true);
  try {
    const parent = options.parent?.span ?? getCurrentActiveSpan() ?? undefined;
    const span = startSpan({
      name: options.name,
      spanType: options.spanType ?? SpanType.CHAIN,
      inputs: safeValue(options.inputs),
      attributes: safeValue(options.attributes ?? {}) as Record<string, unknown>,
      parent,
    });
    return new TraceHandle(span, true);
  } catch (error) {
    noteWarning("mlflow_span_failed", error);
    if (process.env.LAO_MLFLOW_DEBUG === "1") {
      console.warn(`MLflow tracing span disabled: ${redactText(errorText(error))}`);
    }
    return new TraceHandle(null, true);
  }
}

function queueArtifact(handle: TraceHandle, name: string, content: string | Uint8Array): void {
  const traceId = handle.span?.traceId;
  if (!traceId || !name) return;
  const artifacts = pendingArtifacts.get(traceId) ?? [];
  artifacts.push({ name, content });
  pendingArtifacts.set(traceId, artifacts);
}

export function registerObservedArtifact(handle: TraceHandle, name: string, filePath: string): void {
  if (!filePath) return;
  try {
    queueArtifact(handle, name, readFileSync(filePath));
  } catch (error) {
    noteWarning("mlflow_artifact_read_failed", error);
    if (process.env.LAO_MLFLOW_DEBUG === "1") {
      console.warn(`MLflow artifact read failed: ${redactText(errorText(error))}`);
    }
  }
}

export function registerObservedArtifactContent(handle: TraceHandle, name: string, content: string): void {
  queueArtifact(handle, name, content.slice(0, 2_000_000));
}

async function uploadPendingArtifacts(): Promise<void> {
  const username = process.env.MLFLOW_TRACKING_USERNAME;
  const password = process.env.MLFLOW_TRACKING_PASSWORD;
  const token = process.env.MLFLOW_TRACKING_TOKEN;
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  else if (username && password) headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  for (const traceId of [...completedRootTraceIds]) {
    const artifacts = pendingArtifacts.get(traceId);
    if (!artifacts) continue;
    let uploaded = true;
    for (const artifact of artifacts) {
      const url = `${trackingUri().replace(/\/$/, "")}/api/2.0/mlflow-artifacts/artifacts/${encodeURIComponent(experimentId())}/traces/${encodeURIComponent(traceId)}/artifacts/${encodeURIComponent(artifact.name)}`;
      try {
        const response = await fetch(url, { method: "PUT", headers: { ...headers, "content-type": "application/octet-stream" }, body: artifact.content });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        uploaded = false;
        noteWarning("mlflow_artifact_upload_failed", error);
        if (process.env.LAO_MLFLOW_DEBUG === "1") {
          console.warn(`MLflow artifact upload failed: ${redactText(errorText(error))}`);
        }
      }
    }
    if (uploaded) {
      pendingArtifacts.delete(traceId);
      completedRootTraceIds.delete(traceId);
    }
  }
}

export async function withObservedSpan<T>(
  options: Omit<ObservedSpanOptions, "parent">,
  callback: (span: TraceHandle) => T | Promise<T>,
): Promise<T> {
  if (!initialize()) return callback(new TraceHandle(null, false));
  let callbackEntered = false;
  let result: T;
  try {
    result = await withSpan(async (liveSpan) => {
      callbackEntered = true;
      const span = new TraceHandle(liveSpan, false);
      try {
        const result = await callback(span);
        span.finish();
        return result;
      } catch (error) {
        span.fail(error);
        throw error;
      }
    }, {
      name: options.name,
      spanType: options.spanType ?? SpanType.CHAIN,
      inputs: safeValue(options.inputs),
      attributes: safeValue(options.attributes ?? {}) as Record<string, unknown>,
    });
  } catch (error) {
    // withSpan can fail before invoking the callback (for example, an invalid
    // exporter configuration). The application must remain usable in that case.
    noteWarning("mlflow_callback_failed", error);
    if (process.env.LAO_MLFLOW_DEBUG === "1") {
      console.warn(`MLflow tracing callback disabled: ${redactText(errorText(error))}`);
    }
    if (callbackEntered) throw error;
    return callback(new TraceHandle(null, false));
  }
  await flushObservedTraces();
  return result;
}

export async function flushObservedTraces(): Promise<void> {
  if (!initialized) return;
  try {
    await flushTraces();
    await uploadPendingArtifacts();
  } catch (error) {
    noteWarning("mlflow_flush_failed", error);
    if (process.env.LAO_MLFLOW_DEBUG === "1") {
      console.warn(`MLflow trace flush failed: ${redactText(errorText(error))}`);
    }
  }
}

export function observabilityStatus(): { enabled: boolean; trackingUri: string; experimentId: string; warnings: string[] } {
  return { enabled: !isDisabled(), trackingUri: trackingUri(), experimentId: experimentId(), warnings: [...warnings] };
}

export function observabilityWarnings(): string[] {
  return [...warnings];
}
