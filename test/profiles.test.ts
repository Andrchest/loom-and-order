import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateArchitectureContract } from "../src/domain.ts";
import { buildPiInvocation } from "../src/launcher.ts";
import { CustomProfileStore, loadModelCatalog, loadProfile, parseRoleProfileSelection, ProfileResolver } from "../src/profiles.ts";
import { TOOLCHAIN_PI_BIN } from "../src/toolchain.ts";
import { profileDimensions } from "../src/executor.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("model catalog declares the supported pools and safe defaults", () => {
  const catalog = loadModelCatalog(join(ROOT, "profiles", "model-catalog.json"));
  assert.equal(catalog.limits.codexNonManager, 4);
  assert.equal(catalog.limits.local, 1);
  assert.equal(catalog.limits.infrastructureRetries, 2);
  assert.deepEqual(catalog.pools.map((pool) => pool.pool).sort(), ["codex", "local"]);
  assert.equal(catalog.profiles.length, 0);
  assert.equal(Object.keys(catalog.presets).length, 0);
});

test("architecture contracts require durable design fields", () => {
  const contract = {
    version: 1,
    revision: 1,
    initiativeId: "initiative-1",
    author: { role: "architect", profileId: "architect", model: "openai-codex/gpt-5.6-terra" },
    createdAt: new Date().toISOString(),
    summary: "A durable design",
    decisions: ["Use a pure engine"],
    constraints: ["No network"],
    invariants: ["State is deterministic"],
    interfaces: ["Engine API"],
    taskGuidance: ["Add invariant tests"],
  };
  assert.doesNotThrow(() => validateArchitectureContract(contract));
  assert.throws(() => validateArchitectureContract({
    ...contract,
    version: 2,
    executionPlan: {
      tasks: [
        { alias: "foundation", title: "Foundation", objective: "Create the package", produces: ["src/__init__.py"], deliverables: [], requiredArtifacts: [], prerequisites: [], dependsOn: [], verification: ["test"] },
        { alias: "api", title: "Public API", objective: "Export the package", produces: ["./src/__init__.py"], deliverables: [], requiredArtifacts: [], prerequisites: [], dependsOn: ["foundation"], verification: ["test"] },
      ],
      integrationOrder: ["foundation", "api"],
      preflightChecks: ["paths"],
      repairPolicy: "manager review",
    },
  }), /multiple producers/);
  assert.throws(() => validateArchitectureContract({ ...contract, invariants: [""] }), /invariants/);
  assert.throws(() => validateArchitectureContract({ ...contract, author: { ...contract.author, role: "manager" } }), /author/);
});

test("custom profile store persists safe overrides", () => {
  const stateDir = mkdtempSync(join(ROOT, ".tmp-custom-profile-test-"));
  try {
    const base = loadProfile(join(ROOT, "profiles", "example-local.json"));
    const store = new CustomProfileStore(stateDir);
    const saved = store.save({
      ...base,
      id: "custom-research-manager",
      role: "researcher",
      pool: "local",
      model: "local/Example-Model",
      thinkingLevel: "medium",
      rolePrompt: "Research only; do not edit files.",
      skills: ["./profiles/skills/researcher"],
      tools: ["read", "grep", "find", "ls"],
      timeoutMs: 300_000,
      maxAttempts: 3,
      maxConcurrency: 1,
      reviewPolicy: { reviewerRequired: false, gateRequired: false, allowIntegration: false },
    });
    assert.equal(store.get(saved.id)?.rolePrompt, "Research only; do not edit files.");
    assert.equal(store.get(saved.id)?.maxConcurrency, 1);
    assert.equal(store.list().some((profile) => profile.id === saved.id), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("host-auth profiles reference the existing host auth without copying it", () => {
  const stateDir = mkdtempSync(join(ROOT, ".tmp-host-auth-profile-test-"));
  const hostAuth = join(stateDir, "host-auth.json");
  writeFileSync(hostAuth, "{}\n", { mode: 0o600 });
  try {
    const worker = loadProfile(join(ROOT, "profiles", "example-subscription.json"));
    const resolved = new ProfileResolver(stateDir, { LAO_PI_SANDBOX_EXTENSION: "/trusted/pi-sandbox.ts", LAO_HOST_AUTH_FILE: hostAuth }).resolve(worker, "host-auth-test");
    const isolatedAuth = join(resolved.agentDir, "auth.json");
    assert.equal(lstatSync(isolatedAuth).isSymbolicLink(), true);
    assert.equal(readFileSync(isolatedAuth, "utf8"), "{}\n");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("example-local profile resolves its local model from LAO_LOCAL_MODEL", () => {
  const stateDir = mkdtempSync(join(ROOT, ".tmp-local-profile-test-"));
  const hostModels = join(stateDir, "host-models.json");
  writeFileSync(hostModels, '{"providers":{}}\n', { mode: 0o600 });
  try {
    const localProfile = loadProfile(join(ROOT, "profiles", "example-local.json"));
    assert.equal(localProfile.pool, "local");
    assert.equal(localProfile.model, null);
    const resolved = new ProfileResolver(stateDir, { LAO_LOCAL_MODEL: "local/Example-Model", LAO_MODELS_FILE: hostModels }).resolve(localProfile, "local-test");
    assert.equal(resolved.model, "local/Example-Model");
    const settings = JSON.parse(readFileSync(resolved.settingsPath, "utf8"));
    assert.equal(settings.defaultModel, "local/Example-Model");
    const invocation = buildPiInvocation({ profile: resolved, cwd: ROOT, prompt: "work", runId: "local-test" });
    assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--model"), invocation.args.indexOf("--model") + 2), ["--model", "local/Example-Model"]);
    // The host provider catalog must be visible to the isolated agent directory.
    const isolatedModels = join(resolved.agentDir, "models.json");
    assert.equal(lstatSync(isolatedModels).isSymbolicLink(), true);
    assert.equal(readFileSync(isolatedModels, "utf8"), '{"providers":{}}\n');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("local pool profile without LAO_LOCAL_MODEL fails explicitly", () => {
  const stateDir = mkdtempSync(join(ROOT, ".tmp-local-missing-model-test-"));
  try {
    const localProfile = loadProfile(join(ROOT, "profiles", "example-local.json"));
    assert.throws(() => new ProfileResolver(stateDir, {}).resolve(localProfile, "local-missing"), /LAO_LOCAL_MODEL/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("profile model values expand environment placeholders", () => {
  const stateDir = mkdtempSync(join(ROOT, ".tmp-model-env-profile-test-"));
  try {
    const base = loadProfile(join(ROOT, "profiles", "example-local.json"));
    const dynamic = { ...base, id: "worker-dynamic", pool: "local", model: "${LAO_LOCAL_MODEL}" };
    const resolved = new ProfileResolver(stateDir, { LAO_LOCAL_MODEL: "local/Example-Model" }).resolve(dynamic, "dynamic-test");
    assert.equal(resolved.model, "local/Example-Model");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("ships two generic example worker profiles", () => {
  const local = loadProfile(join(ROOT, "profiles", "example-local.json"));
  assert.equal(local.role, "worker");
  assert.equal(local.pool, "local");
  assert.equal(local.model, null);
  const subscription = loadProfile(join(ROOT, "profiles", "example-subscription.json"));
  assert.equal(subscription.role, "worker");
  assert.equal(subscription.pool, "codex");
  assert.equal(subscription.model, "openai-codex/gpt-5.5");
  assert.ok(subscription.sandbox.allowedDomains.length > 0);
});

test("metric dimensions record the resolved local model, not unknown", () => {
  const manifest = loadProfile(join(ROOT, "profiles", "example-local.json"));
  assert.equal(profileDimensions(manifest, { LAO_LOCAL_MODEL: "local/Example-Model" }).model, "local/Example-Model");
  assert.equal(profileDimensions(manifest, {}).model, "unknown");
});

test("external role profile selection: JSON map and per-role env precedence", () => {
  const selection = parseRoleProfileSelection({
    LAO_ROLE_PROFILES: '{"worker":"worker","reviewer":"reviewer-x"}',
    LAO_PROFILE_REVIEWER: "reviewer",
  });
  assert.equal(selection.worker, "worker");
  assert.equal(selection.reviewer, "reviewer");
  assert.equal(selection.architect, undefined);
  assert.equal(selection.manager, undefined);
});

test("external role profile selection: invalid JSON is rejected", () => {
  assert.throws(() => parseRoleProfileSelection({ LAO_ROLE_PROFILES: "not-json" }), /LAO_ROLE_PROFILES/);
  assert.throws(() => parseRoleProfileSelection({ LAO_ROLE_PROFILES: '{"worker":1}' }), /LAO_ROLE_PROFILES\.worker/);
});

test("toolchain-backed profiles resolve to the local Pi runtime and extensions", () => {
  const stateDir = mkdtempSync(join(ROOT, ".tmp-toolchain-profile-test-"));
  try {
    const worker = loadProfile(join(ROOT, "profiles", "example-subscription.json"));
    assert.equal(worker.piBin, TOOLCHAIN_PI_BIN);
    const resolved = new ProfileResolver(stateDir, { LAO_TOOLCHAIN_DIR: "/runner/toolchain" }).resolve(worker, "toolchain-test");
    assert.equal(resolved.piBin, "/runner/toolchain/node_modules/.bin/pi");
    const settings = JSON.parse(readFileSync(resolved.settingsPath, "utf8"));
    assert.equal(settings.extensions[0], "/runner/toolchain/node_modules/pi-quiet-tools/src/index.ts");
    assert.equal(settings.extensions.includes("/runner/toolchain/node_modules/pi-mcp-adapter/index.ts"), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("example profiles pin explicit models instead of ambient Pi model", () => {
  const local = loadProfile(join(ROOT, "profiles", "example-local.json"));
  const subscription = loadProfile(join(ROOT, "profiles", "example-subscription.json"));
  assert.equal(local.pool, "local");
  assert.equal(local.model, null);
  assert.equal(subscription.model, "openai-codex/gpt-5.5");
  assert.equal(subscription.pool, "codex");
  assert.equal(subscription.thinkingLevel, "high");
  assert.equal(local.sandbox.backend, "trusted-local");
  assert.equal(subscription.sandbox.backend, "trusted-local");
  assert.equal(subscription.tools.includes("write"), true);
  assert.equal(subscription.tools.includes("edit"), true);
  assert.equal(JSON.parse(readFileSync(join(ROOT, "profiles", "example-subscription.json"), "utf8")).pool, "codex");
  assert.match(readFileSync(join(ROOT, "profiles", "skills", "researcher", "SKILL.md"), "utf8"), /do not create, edit, delete, commit, merge, or push/i);
  assert.match(readFileSync(join(ROOT, "profiles", "skills", "release", "SKILL.md"), "utf8"), /reviewer.*pass.*gate.*passed/i);
  const stateDir = mkdtempSync(join(ROOT, ".tmp-profile-test-"));
  try {
    const resolved = new ProfileResolver(stateDir, { LAO_PI_SANDBOX_EXTENSION: "/trusted/pi-sandbox.ts" }).resolve(subscription, "catalog-test");
    const invocation = buildPiInvocation({ profile: resolved, cwd: ROOT, prompt: "plan", runId: "catalog-test" });
    assert.equal(invocation.command, "pi");
    assert.equal(invocation.args.includes("--extension"), false);
    assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--model"), invocation.args.indexOf("--model") + 2), ["--model", "openai-codex/gpt-5.5"]);
    assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--thinking"), invocation.args.indexOf("--thinking") + 2), ["--thinking", "high"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
