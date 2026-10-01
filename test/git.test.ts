import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitWorkspace } from "../src/git.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function repo(root: string): string {
  const path = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", path]);
  git(path, ["config", "user.email", "test@example.invalid"]);
  git(path, ["config", "user.name", "Test"]);
  writeFileSync(join(path, "README.md"), "base\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "base"]);
  return path;
}

test("ensureDependencies installs missing node_modules once (F7)", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-deps-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nmkdir -p node_modules\n", { mode: 0o755 });
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${originalPath}`;
    const target = repo(root);
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: "deps-test", version: "0.0.0" }));
    const workspace = new GitWorkspace(join(root, "state"));
    assert.equal(workspace.ensureDependencies(target), true);
    assert.ok(existsSync(join(target, "node_modules")));
    assert.equal(workspace.ensureDependencies(target), false);
  } finally {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureDependencies is a no-op without package.json", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-deps-none-"));
  try {
    const target = repo(root);
    const workspace = new GitWorkspace(join(root, "state"));
    assert.equal(workspace.ensureDependencies(target), false);
    assert.ok(!existsSync(join(target, "node_modules")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic gate runs package tests and diff validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-gate-"));
  try {
    const target = repo(root);
    writeFileSync(join(target, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
    const result = await new GitWorkspace(join(root, "state")).runGate(target, ["__auto__"]);
    assert.equal(result.ok, true);
    assert.match(result.output, /npm test/);
    assert.match(result.output, /git diff --check/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic gate runs Python unittest discovery when package metadata is present", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-python-gate-"));
  try {
    const target = repo(root);
    writeFileSync(join(target, "pyproject.toml"), "[project]\nname='gate-test'\n");
    mkdirSync(join(target, "tests"), { recursive: true });
    writeFileSync(join(target, "tests", "test_gate.py"), "import unittest\nclass GateTest(unittest.TestCase):\n    def test_ok(self): self.assertTrue(True)\n");
    const result = await new GitWorkspace(join(root, "state")).runGate(target, ["__auto__"]);
    assert.equal(result.ok, true);
    assert.match(result.output, /python3 -m unittest discover/);
    assert.match(result.output, /git diff --check/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allows only runner-owned untracked quiet-tool artifacts while rejecting user changes", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-clean-checkout-"));
  try {
    const target = repo(root);
    mkdirSync(join(target, ".pi", "quiet-tools", "outputs"), { recursive: true });
    writeFileSync(join(target, ".pi", "quiet-tools", "outputs", "trace.txt"), "runner artifact\n");
    const workspace = new GitWorkspace(join(root, "state"));
    assert.doesNotThrow(() => workspace.assertClean(target));
    writeFileSync(join(target, "user-change.txt"), "user\n");
    assert.throws(() => workspace.assertClean(target), /source checkout is not clean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit gate command remains authoritative", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-explicit-gate-"));
  try {
    const target = repo(root);
    const result = await new GitWorkspace(join(root, "state")).runGate(target, ["node", "-e", "process.exit(3)"]);
    assert.equal(result.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("escalates to SIGKILL when a gate command ignores SIGTERM", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-gate-sigkill-"));
  try {
    const target = repo(root);
    const stubborn = join(root, "stubborn-gate.mjs");
    writeFileSync(stubborn, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => {}, 60_000);\n");
    const workspace = new GitWorkspace(join(root, "state"), 100);
    const started = Date.now();
    const result = await workspace.runGate(target, ["node", stubborn]);
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 15_000, `expected bounded SIGKILL escalation, took ${Date.now() - started}ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commitChanges refuses credential-like files but allows normal and example files", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-secrets-"));
  try {
    const target = repo(root);
    const workspace = new GitWorkspace(join(root, "state"));
    writeFileSync(join(target, "implementation.txt"), "code\n");
    writeFileSync(join(target, ".env.example"), "TOKEN=example\n");
    const commit = workspace.commitChanges(target, "feat: normal files");
    assert.equal(workspace.currentCommit(target), commit);
    writeFileSync(join(target, ".env"), "TOKEN=secret\n");
    assert.throws(() => workspace.commitChanges(target, "feat: with env"), /credential-like files/);
    assert.equal(workspace.currentCommit(target), commit);
    rmSync(join(target, ".env"), { force: true });
    writeFileSync(join(target, "id_rsa"), "key material\n");
    assert.throws(() => workspace.commitChanges(target, "feat: with key"), /credential-like files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findPriorMerge locates a merged task branch and ignores unrelated history", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-and-order-prior-merge-"));
  const target = repo(root);
  const workspace = new GitWorkspace(join(root, "state"));
  try {
    // Unrelated merge history must not match.
    git(target, ["checkout", "-b", "feature/unrelated"]);
    writeFileSync(join(target, "other.txt"), "other\n");
    git(target, ["add", "."]);
    git(target, ["commit", "-m", "other work"]);
    git(target, ["checkout", "main"]);
    git(target, ["merge", "--no-ff", "--no-edit", "feature/unrelated"]);
    assert.equal(workspace.findPriorMerge(target, "loom-and-order/test/task-demo"), null);
    // A real task-branch merge is found by its branch name.
    git(target, ["checkout", "-b", "loom-and-order/test/task-demo"]);
    writeFileSync(join(target, "feature.txt"), "feature\n");
    git(target, ["add", "."]);
    git(target, ["commit", "-m", "task work"]);
    git(target, ["checkout", "main"]);
    git(target, ["merge", "--no-ff", "--no-edit", "loom-and-order/test/task-demo"]);
    const mergeCommit = workspace.currentCommit(target);
    assert.equal(workspace.findPriorMerge(target, "loom-and-order/test/task-demo"), mergeCommit);
    assert.equal(workspace.findPriorMerge(target, "loom-and-order/test/task-other"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
