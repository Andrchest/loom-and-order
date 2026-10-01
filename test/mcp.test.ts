import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApplicationService } from "../src/application.ts";
import { processMcpLine } from "../src/mcp.ts";

function makeRepo(parent: string): string {
  const path = join(parent, "repo");
  execFileSync("git", ["init", "-b", "main", path]);
  execFileSync("git", ["-C", path, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Test"]);
  writeFileSync(join(path, "README.md"), "base\n");
  execFileSync("git", ["-C", path, "add", "."]);
  execFileSync("git", ["-C", path, "commit", "-m", "base"]);
  return path;
}

function makeService(): { service: ApplicationService; dir: string; initiativeId: string } {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-mcp-"));
  const service = new ApplicationService({ stateDir: dir, autoStart: false });
  const { initiativeId } = service.store.createPlan({
    plan: { title: "mcp", epics: [{ id: "epic", title: "E", tasks: [{ id: "task", title: "T" }] }] },
    repoPath: "/repo",
    baseCommit: "abc",
  });
  return { service, dir, initiativeId };
}

async function call(service: ApplicationService, request: unknown): Promise<any> {
  const output = await processMcpLine(service, JSON.stringify(request));
  return output ? JSON.parse(output) : undefined;
}

test("mcp: initialize returns server info and protocol version", async () => {
  const { service, dir } = makeService();
  try {
    const response = await call(service, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(response.result.serverInfo.name, "loom-and-order");
    assert.equal(response.result.protocolVersion, "2024-11-05");
    assert.deepEqual(response.result.capabilities, { tools: {} });
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp: ping responds with an empty result", async () => {
  const { service, dir } = makeService();
  try {
    const response = await call(service, { jsonrpc: "2.0", id: 7, method: "ping" });
    assert.deepEqual(response.result, {});
    assert.equal(response.id, 7);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp: tools/list exposes the full tool catalog with schemas", async () => {
  const { service, dir } = makeService();
  try {
    const response = await call(service, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.ok(response.result.tools.length >= 24);
    for (const tool of response.result.tools) {
      assert.ok(tool.name.length > 0);
      assert.ok(tool.description.length > 0);
      assert.equal(tool.inputSchema.type, "object");
    }
    const names = response.result.tools.map((tool: any) => tool.name);
    for (const expected of ["submit", "progress", "resume", "message", "supervise_once", "profiles_list"]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp: submit forwards optional autoPrune and resolves the default off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-mcp-submit-"));
  const repo = makeRepo(dir);
  const service = new ApplicationService({ stateDir: join(dir, "state"), autoStart: false, env: { ...process.env, LAO_AUTO_PRUNE: "true" } });
  try {
    const listed = await call(service, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const submitTool = listed.result.tools.find((tool: any) => tool.name === "submit");
    assert.equal(submitTool.inputSchema.properties.autoPrune.type, "boolean");

    const enabled = await call(service, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "submit", arguments: { repo, prompt: "enabled", autoPrune: true } } });
    const enabledSubmission = JSON.parse(enabled.result.content[0].text);
    assert.equal(service.store.getAutoPrune(enabledSubmission.initiativeId), true);

    const disabled = await call(service, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "submit", arguments: { repo, prompt: "disabled", autoPrune: false } } });
    const disabledSubmission = JSON.parse(disabled.result.content[0].text);
    assert.equal(service.store.getAutoPrune(disabledSubmission.initiativeId), false);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp: submit uses the documented LAO_AUTO_PRUNE true value when omitted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-mcp-submit-env-"));
  const repo = makeRepo(dir);
  const service = new ApplicationService({ stateDir: join(dir, "state"), autoStart: false, env: { ...process.env, LAO_AUTO_PRUNE: "true" } });
  try {
    const response = await call(service, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit", arguments: { repo, prompt: "from env" } } });
    const submission = JSON.parse(response.result.content[0].text);
    assert.equal(service.store.getAutoPrune(submission.initiativeId), true);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp: tools/call progress reads real initiative state", async () => {
  const { service, dir, initiativeId } = makeService();
  try {
    const response = await call(service, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "progress", arguments: { initiativeId } } });
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.initiative.id, initiativeId);
    assert.equal(payload.tasks.total, 1);
    assert.ok(payload.tasks.byStatus);
    assert.ok(Array.isArray(payload.blockers));
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp: tools/call message persists durable guidance", async () => {
  const { service, dir, initiativeId } = makeService();
  try {
    const response = await call(service, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "message", arguments: { initiativeId, body: "prioritize the API" } } });
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.messageId, 1);
    const events = service.store.events(initiativeId);
    assert.ok(events.some((event: any) => event.kind === "manager_message_added"));
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp: unknown tool returns a -32000 error", async () => {
  const { service, dir } = makeService();
  try {
    const response = await call(service, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope", arguments: {} } });
    assert.equal(response.error.code, -32000);
    assert.match(response.error.message, /unknown tool nope/);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp: unknown method with an id returns -32601", async () => {
  const { service, dir } = makeService();
  try {
    const response = await call(service, { jsonrpc: "2.0", id: 1, method: "resources/list" });
    assert.equal(response.error.code, -32601);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp: notifications produce no response", async () => {
  const { service, dir } = makeService();
  try {
    assert.equal(await call(service, { jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
    assert.equal(await call(service, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } }), undefined);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp: batch requests respond in order, excluding notifications", async () => {
  const { service, dir, initiativeId } = makeService();
  try {
    const batch = [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "progress", arguments: { initiativeId } } },
    ];
    const response = await call(service, batch);
    assert.ok(Array.isArray(response));
    assert.equal(response.length, 3);
    assert.equal(response[0].id, 1);
    assert.deepEqual(response[0].result, {});
    assert.equal(response[1].id, 2);
    assert.ok(response[1].result.tools.length >= 24);
    assert.equal(response[2].id, 3);
    assert.equal(JSON.parse(response[2].result.content[0].text).initiative.id, initiativeId);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp: invalid batch items get -32600 while valid siblings still respond", async () => {
  const { service, dir } = makeService();
  try {
    const batch = [42, { jsonrpc: "2.0", id: 5, method: "ping" }];
    const response = await call(service, batch);
    assert.ok(Array.isArray(response));
    assert.equal(response.length, 2);
    assert.equal(response[0].id, null);
    assert.equal(response[0].error.code, -32600);
    assert.equal(response[1].id, 5);
    assert.deepEqual(response[1].result, {});
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp: empty batch and malformed lines are parse errors", async () => {
  const { service, dir } = makeService();
  try {
    const empty = await call(service, []);
    assert.equal(empty.error.code, -32700);
    const malformed = await processMcpLine(service, "{not json");
    const parsed = JSON.parse(malformed!);
    assert.equal(parsed.error.code, -32700);
    assert.equal(await processMcpLine(service, "   "), undefined);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp: resume without a node id is a tool error, not a crash", async () => {
  const { service, dir } = makeService();
  try {
    const response = await call(service, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "resume", arguments: {} } });
    assert.equal(response.error.code, -32000);
    assert.match(response.error.message, /nodeId/);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
