import { createInterface } from "node:readline";
import type { ApplicationService } from "./application.ts";

const TOOLS = [
  { name: "submit", description: "Create and start a durable initiative", inputSchema: { type: "object", required: ["repo", "prompt"], properties: { repo: { type: "string" }, prompt: { type: "string" } } } },
  { name: "tree", description: "Read an initiative task tree", inputSchema: { type: "object", required: ["initiativeId"], properties: { initiativeId: { type: "string" } } } },
  { name: "status", description: "Read one node or concise initiative progress", inputSchema: { type: "object", required: ["nodeId"], properties: { nodeId: { type: "string" } } } },
  { name: "progress", description: "Read concise SQLite-backed initiative progress without agent calls", inputSchema: { type: "object", required: ["initiativeId"], properties: { initiativeId: { type: "string" } } } },
  { name: "architecture_contract_get", description: "Read the current or selected architecture contract", inputSchema: { type: "object", required: ["initiativeId"], properties: { initiativeId: { type: "string" }, revision: { type: "number" } } } },
  { name: "architecture_contract_list", description: "List architecture contract revisions", inputSchema: { type: "object", required: ["initiativeId"], properties: { initiativeId: { type: "string" } } } },
  { name: "architecture_contract_create", description: "Persist a validated architecture contract revision", inputSchema: { type: "object", required: ["contract"], properties: { contract: { type: "object" }, supersessionReason: { type: "string" } } } },
  { name: "message", description: "Append guidance for the manager", inputSchema: { type: "object", required: ["initiativeId", "body"], properties: { initiativeId: { type: "string" }, body: { type: "string" } } } },
  { name: "plan_edit", description: "Apply a validated plan edit", inputSchema: { type: "object", required: ["initiativeId", "patch"], properties: { initiativeId: { type: "string" }, patch: { type: "object" } } } },
  { name: "pause", description: "Pause an initiative", inputSchema: { type: "object", required: ["initiativeId"], properties: { initiativeId: { type: "string" } } } },
  { name: "resume", description: "Resume one task/branch or an entire initiative", inputSchema: { type: "object", properties: { nodeId: { type: "string" }, initiativeId: { type: "string" } } } },
  { name: "logs", description: "Read durable events", inputSchema: { type: "object", properties: { nodeId: { type: "string" } } } },
  { name: "metrics", description: "Read initiative runtime metrics", inputSchema: { type: "object", required: ["initiativeId"], properties: { initiativeId: { type: "string" }, prometheus: { type: "boolean" } } } },
  { name: "recover", description: "Recover expired leases and stale agent sessions", inputSchema: { type: "object", properties: {} } },
  { name: "supervise_once", description: "Run one non-LLM supervisor recovery cycle", inputSchema: { type: "object", properties: {} } },
  { name: "supervisor_status", description: "Read supervisor and active-session status", inputSchema: { type: "object", properties: {} } },
  { name: "feed", description: "Read bounded privacy-filtered lifecycle events after a cursor", inputSchema: { type: "object", properties: { initiativeId: { type: "string" }, afterId: { type: "number" }, limit: { type: "number" } } } },
  { name: "agents", description: "List persistent agent identities", inputSchema: { type: "object", properties: { initiativeId: { type: "string" } } } },
  { name: "agent_sessions", description: "List persistent agent sessions", inputSchema: { type: "object", properties: { initiativeId: { type: "string" }, state: { type: "string" } } } },
  { name: "profiles_list", description: "List built-in, catalog, and custom agent profiles", inputSchema: { type: "object", properties: {} } },
  { name: "profiles_validate", description: "Validate a profile manifest without persisting it", inputSchema: { type: "object", required: ["profile"], properties: { profile: { type: "object" } } } },
  { name: "profiles_create", description: "Persist a validated custom profile", inputSchema: { type: "object", required: ["profile"], properties: { profile: { type: "object" }, overwrite: { type: "boolean" } } } },
  { name: "profiles_clone", description: "Clone an existing profile with safe overrides", inputSchema: { type: "object", required: ["sourceId", "targetId"], properties: { sourceId: { type: "string" }, targetId: { type: "string" }, overrides: { type: "object" } } } },
  { name: "agent_profile_create", description: "Create and assign a persisted Pi profile for an existing agent identity", inputSchema: { type: "object", required: ["agentId"], properties: { agentId: { type: "string" }, profileId: { type: "string" }, overrides: { type: "object" }, overwrite: { type: "boolean" } } } },
];

function result(value: unknown): any {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function isRequestObject(value: unknown): value is { method?: unknown; id?: unknown; params?: any } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Handle one MCP request object. Returns a JSON-RPC response object, or
 * `undefined` for notifications (JSON-RPC 2.0: notifications never receive
 * a response, not even error responses).
 */
async function handleRequest(service: ApplicationService, request: unknown): Promise<Record<string, unknown> | undefined> {
  if (!isRequestObject(request) || typeof request.method !== "string") {
    const id = isRequestObject(request) ? (request.id ?? null) : null;
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
  }
  const id = request.id ?? null;
  const notify = request.id === undefined;
  try {
    if (request.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "loom-and-order", version: "0.1.0" } } };
    if (request.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (request.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    if (request.method === "tools/call") return { jsonrpc: "2.0", id, result: await callTool(service, request.params?.name, request.params?.arguments ?? {}) };
    if (notify) return undefined;
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${request.method}` } };
  } catch (error) {
    if (notify) return undefined;
    return { jsonrpc: "2.0", id, error: { code: -32000, message: String(error) } };
  }
}

/**
 * Handle one newline-delimited line of MCP traffic. Supports single
 * requests and JSON-RPC batch arrays. Returns the line to write to stdout,
 * or `undefined` when the line produces no response (notifications only).
 */
export async function processMcpLine(service: ApplicationService, line: string): Promise<string | undefined> {
  if (!line.trim()) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch {
    return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error: empty batch" } });
    const responses: Record<string, unknown>[] = [];
    for (const item of parsed) {
      const response = await handleRequest(service, item);
      if (response) responses.push(response);
    }
    return responses.length ? JSON.stringify(responses) : undefined;
  }
  const response = await handleRequest(service, parsed);
  return response ? JSON.stringify(response) : undefined;
}

export async function serveMcp(service: ApplicationService): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    const output = await processMcpLine(service, line);
    if (output) process.stdout.write(`${output}\n`);
  }
}

async function callTool(service: ApplicationService, name: string, args: any): Promise<any> {
  switch (name) {
    case "submit": return result(await service.submit(args.repo, args.prompt));
    case "tree": return result(service.tree(args.initiativeId));
    case "status": return result(service.status(args.nodeId));
    case "progress": return result(service.progress(args.initiativeId));
    case "architecture_contract_get": return result(service.architectureContract(args.initiativeId, args.revision));
    case "architecture_contract_list": return result(service.architectureContracts(args.initiativeId));
    case "architecture_contract_create": return result(service.saveArchitectureContract(args.contract, args.supersessionReason));
    case "message": return result({ messageId: service.message(args.initiativeId, args.body) });
    case "plan_edit": return result(service.planEdit(args.initiativeId, args.patch));
    case "pause": service.pause(args.initiativeId); return result({ ok: true });
    case "resume": {
      const nodeId = args.nodeId ?? args.initiativeId;
      if (typeof nodeId !== "string" || !nodeId) throw new Error("resume requires nodeId or initiativeId");
      service.resume(nodeId);
      return result({ ok: true });
    }
    case "logs": return result(service.logs(args.nodeId));
    case "metrics": return result(args.prometheus ? service.prometheus(args.initiativeId) : service.metrics(args.initiativeId));
    case "recover": return result({ recovered: service.recover() });
    case "supervise_once": return result(service.superviseOnce());
    case "supervisor_status": return result(service.supervisorStatus());
    case "feed": return result(service.feed(args.initiativeId, Number(args.afterId ?? 0), Number(args.limit ?? 100)));
    case "agents": return result(service.agents(args.initiativeId));
    case "agent_sessions": return result(service.agentSessions(args.initiativeId, args.state));
    case "profiles_list": return result(service.listProfiles());
    case "profiles_validate": return result(service.validateProfile(args.profile));
    case "profiles_create": return result(service.saveCustomProfile(args.profile, Boolean(args.overwrite)));
    case "profiles_clone": return result(service.cloneProfile(args.sourceId, args.targetId, args.overrides ?? {}));
    case "agent_profile_create": return result(service.createAgentProfile(args.agentId, args.profileId, args.overrides ?? {}, Boolean(args.overwrite)));
    default: throw new Error(`unknown tool ${name}`);
  }
}
