import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deriveTelemetry, PiLauncher, buildPiInvocation } from "../src/launcher.ts";
import { ProfileResolver, validateSandbox, type ProfileManifest } from "../src/profiles.ts";

function profile(extensionPath = "/trusted/pi-sandbox.ts"): ProfileManifest {
  return {
    id: "worker",
    role: "worker",
    piBin: "pi",
    skills: [],
    extensions: [],
    tools: ["read", "bash"],
    timeoutMs: 10_000,
    maxAttempts: 2,
    sandbox: { backend: "pi-sandbox", extensionPath, allowedDomains: ["api.anthropic.com:443"], credentialMode: "host-auth" },
  };
}

test("resolves isolated profile settings and refuses unsafe sandbox configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-profile-"));
  try {
    const resolved = new ProfileResolver(dir, { LAO_PI_SANDBOX_EXTENSION: "/trusted/pi-sandbox.ts" }).resolve({
      ...profile("${LAO_PI_SANDBOX_EXTENSION}"),
      skills: ["/trusted/skills/worker"],
    }, "run-1");
    assert.equal(resolved.agentDir.startsWith(dir), true);
    const settings = JSON.parse(readFileSync(resolved.settingsPath, "utf8"));
    assert.equal(settings.defaultProjectTrust, "never");
    assert.deepEqual(settings.defaultTools, ["read", "bash"]);
    assert.match(readFileSync(resolved.sandboxConfigPath, "utf8"), /api\.anthropic\.com:443/);
    assert.throws(() => validateSandbox({ backend: "pi-sandbox", extensionPath: null, allowedDomains: [], credentialMode: "host-auth" }), /extensionPath/);
    assert.throws(() => validateSandbox({ backend: "pi-sandbox", extensionPath: "/x", allowedDomains: [], credentialMode: "broker" }), /broker credentials/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("builds a fail-closed Pi invocation without changing host settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-invocation-"));
  try {
    const resolved = new ProfileResolver(dir).resolve(profile(), "run-2");
    const invocation = buildPiInvocation({ profile: resolved, cwd: "/worktree", prompt: "do task", runId: "run-2" });
    assert.equal(invocation.command, "pi");
    assert.ok(invocation.args.includes("--mode"));
    assert.ok(invocation.args.includes("--no-approve"));
    assert.equal(invocation.args[invocation.args.indexOf("--tools") + 1], "read,bash");
    assert.equal(invocation.env.PI_CODING_AGENT_DIR, resolved.agentDir);
    assert.equal(invocation.env.PI_CODING_AGENT_SESSION_DIR, resolved.sessionDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preserves a session for bounded conversational feedback retries", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-session-feedback-"));
  try {
    const resolved = new ProfileResolver(dir).resolve(profile(), "first-turn");
    const first = buildPiInvocation({ profile: resolved, cwd: "/worktree", prompt: "implement the task", runId: "first-turn" });
    const followUp = buildPiInvocation({ profile: resolved, cwd: "/worktree", prompt: "The gate failed: add the missing assertion. Return the corrected result.", runId: "feedback-turn", sessionId: "first-turn", continueSession: true });
    const firstSessionArg = first.args.indexOf("--session-id");
    const followUpSessionArg = followUp.args.indexOf("--session-id");
    assert.equal(first.args[firstSessionArg + 1], "first-turn");
    assert.equal(followUpSessionArg, -1);
    assert.equal(followUp.args.includes("--continue"), true);
    assert.equal(followUp.args.at(-1), "The gate failed: add the missing assertion. Return the corrected result.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reuses the original profile/session directory for --continue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-session-directory-"));
  try {
    const capture = join(dir, "session-dirs.txt");
    const fake = join(dir, "fake-session-pi.mjs");
    writeFileSync(fake, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.PI_SESSION_CAPTURE, process.env.PI_CODING_AGENT_SESSION_DIR + '\\n');\nconsole.log(JSON.stringify({type:'agent_end', messages:[]}));\n`);
    chmodSync(fake, 0o700);
    const launcher = new PiLauncher(join(dir, "state"), join(dir, "logs"), { ...process.env, PI_SESSION_CAPTURE: capture });
    const manifest = { ...profile(), piBin: fake };
    await launcher.run({ profile: manifest, cwd: dir, prompt: "first", runId: "first-turn" });
    await launcher.run({ profile: manifest, cwd: dir, prompt: "follow-up", runId: "feedback-turn", sessionId: "first-turn", continueSession: true });
    const dirs = readFileSync(capture, "utf8").trim().split("\n");
    assert.equal(dirs.length, 2);
    assert.equal(dirs[0], dirs[1]);
    assert.match(dirs[0], /profiles[\\/]worker[\\/]first-turn[\\/]sessions$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restricts MCP configuration to the current project file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-mcp-scope-"));
  try {
    const project = join(dir, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { projectOnly: { command: "project-command" } } }));
    const fake = join(dir, "fake-mcp-pi.mjs");
    writeFileSync(fake, `#!/usr/bin/env node\nimport { readFileSync } from 'node:fs';\nconst config = JSON.parse(readFileSync(process.env.PI_CODING_AGENT_DIR + '/mcp.json', 'utf8'));\nif (process.env.PI_MCP_CONFIG_MODE !== 'exclusive' || !config.mcpServers.projectOnly || Object.keys(config.mcpServers).length !== 1) process.exit(9);\nconsole.log(JSON.stringify({type:'agent_end', messages:[]}));\n`);
    chmodSync(fake, 0o700);
    const launcher = new PiLauncher(join(dir, "state"), join(dir, "logs"));
    const result = await launcher.run({ profile: { ...profile(), piBin: fake }, cwd: project, prompt: "scope", runId: "mcp-scope" });
    assert.equal(result.exitCode, 0);
    assert.equal(result.agentEnded, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("derives API cost, Codex credits, local zero cost, and unknown cost", () => {
  const local = deriveTelemetry({ id: "local", model: "local/Example-Model", pool: "local" }, { input: 10, output: 5 }, 1000, 3000, 1500);
  assert.equal(local.costUsd, 0);
  assert.equal(local.apiCostUsd, 0);
  assert.equal(local.codexCredits, 0);
  assert.equal(local.costSource, "local-zero");

  const provider = deriveTelemetry({ id: "codex", model: "openai-codex/gpt-test", pool: "codex" }, { input: 10, output: 5, costUsd: 0.42 }, 1000, 3000, 1500);
  assert.equal(provider.costUsd, 0.42);
  assert.equal(provider.apiCostUsd, 0.42);
  assert.equal(provider.codexCredits, null);
  assert.equal(provider.costSource, "provider");

  const pricedProfile = {
    id: "codex",
    model: "openai-codex/gpt-5.6-luna",
    pool: "codex" as const,
    pricing: {
      inputPerMillionUsd: 0.2,
      outputPerMillionUsd: 1.2,
      cacheReadPerMillionUsd: 0.02,
      codexInputCreditsPerMillion: 5,
      codexOutputCreditsPerMillion: 30,
      codexCacheReadCreditsPerMillion: 0.5,
    },
  };
  const priced = deriveTelemetry(pricedProfile, { input: 1_000_000, output: 500_000, "prompt_tokens_details.cached_tokens": 250_000 }, 1000, 3000, 1500);
  assert.equal(priced.apiCostUsd, 0.805);
  assert.equal(priced.costUsd, 0.805);
  assert.equal(priced.codexCredits, 20.125);
  assert.equal(priced.costSource, "profile-rate");
  assert.equal(priced.codexCreditsSource, "profile-rate");

  const configured = deriveTelemetry({ id: "codex", model: "openai-codex/gpt-test", pool: "codex" }, { input: 1_000_000, output: 500_000 }, 1000, 3000, 1500);
  assert.equal(configured.costUsd, null);
  process.env.LAO_MODEL_PRICING_JSON = JSON.stringify({ "openai-codex/gpt-test": { inputPerMillionUsd: 1, outputPerMillionUsd: 2 } });
  try {
    const priced = deriveTelemetry({ id: "codex", model: "openai-codex/gpt-test", pool: "codex" }, { input: 1_000_000, output: 500_000 }, 1000, 3000, 1500);
    assert.equal(priced.costUsd, 2);
    assert.equal(priced.costSource, "model-rate");
  } finally {
    delete process.env.LAO_MODEL_PRICING_JSON;
  }

  const unknown = deriveTelemetry({ id: "codex", model: "openai-codex/gpt-test", pool: "codex" }, { input: 10, output: 5 }, 1000, 3000, null);
  assert.equal(unknown.ttftMs, null);
  assert.equal(unknown.costUsd, null);
});

test("classifies fake process failure and timeout without hanging", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-failure-pi-"));
  try {
    const failed = join(dir, "failed-pi.mjs");
    writeFileSync(failed, "#!/usr/bin/env node\nprocess.exit(23);\n");
    chmodSync(failed, 0o700);
    const launcher = new PiLauncher(join(dir, "state-failure"), join(dir, "logs-failure"));
    const failure = await launcher.run({ profile: { ...profile(), piBin: failed }, cwd: dir, prompt: "fail", runId: "failed-run" });
    assert.equal(failure.exitCode, 23);
    assert.equal(failure.agentEnded, false);

    const hanging = join(dir, "hanging-pi.mjs");
    writeFileSync(hanging, "#!/usr/bin/env node\nsetTimeout(() => {}, 10_000);\n");
    chmodSync(hanging, 0o700);
    const timeout = await launcher.run({ profile: { ...profile(), piBin: hanging, timeoutMs: 50 }, cwd: dir, prompt: "hang", runId: "timeout-run", timeoutMs: 50 });
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.agentEnded, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("escalates to SIGKILL when a timed-out process ignores SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-sigkill-"));
  try {
    const stubborn = join(dir, "stubborn-pi.mjs");
    writeFileSync(stubborn, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => {}, 60_000);\n");
    chmodSync(stubborn, 0o700);
    const launcher = new PiLauncher(join(dir, "state"), join(dir, "logs"));
    const started = Date.now();
    const result = await launcher.run({ profile: { ...profile(), piBin: stubborn }, cwd: dir, prompt: "hang", runId: "stubborn-run", timeoutMs: 100 });
    assert.equal(result.timedOut, true);
    assert.equal(result.agentEnded, false);
    assert.ok(Date.now() - started < 10_000, `expected bounded SIGKILL escalation, took ${Date.now() - started}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs a fake Pi process and retains structured output and raw logs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-and-order-fake-pi-"));
  try {
    const fake = join(dir, "fake-pi.mjs");
    writeFileSync(fake, `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'session', id:'fake'}));\nconsole.log(JSON.stringify({type:'tool_execution_end', toolName:'bash', isError:false}));\nconsole.log(JSON.stringify({type:'message_update', assistantMessageEvent:{delta:'partial'}, usage:{input:12, output:7, reasoning:2, prompt_tokens_details:{cached_tokens:3}}}));\nconsole.log(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'done'}]}}));\nconsole.log(JSON.stringify({type:'turn_end', message:{role:'assistant', content:[{type:'text', text:'done'}]}}));\nconsole.log(JSON.stringify({type:'agent_end', messages:[]}));\n`);
    chmodSync(fake, 0o700);
    const launcher = new PiLauncher(join(dir, "state"), join(dir, "logs"));
    const result = await launcher.run({ profile: { ...profile(), piBin: fake }, cwd: dir, prompt: "hello", runId: "fake-run" });
    assert.equal(result.exitCode, 0);
    assert.equal(result.agentEnded, true);
    assert.equal(result.assistantText, "done");
    assert.equal(result.toolCalls, 1);
    assert.equal(result.toolErrors, 0);
    assert.equal(result.usage.input, 12);
    assert.equal(result.usage.output, 7);
    assert.equal(result.telemetry.inputTokens, 12);
    assert.equal(result.telemetry.outputTokens, 7);
    assert.equal(result.telemetry.reasoningTokens, 2);
    assert.equal(result.telemetry.cacheReadTokens, 3);
    assert.equal(result.telemetry.costUsd, 0);
    assert.equal(result.telemetry.costSource, "local-zero");
    assert.notEqual(result.telemetry.ttftMs, null);
    assert.equal(result.telemetry.tokensPerSecond === null || typeof result.telemetry.tokensPerSecond === "number", true);
    assert.ok(result.durationMs >= 0);
    assert.match(readFileSync(result.stdoutPath, "utf8"), /agent_end/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
