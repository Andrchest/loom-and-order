import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ApplicationService } from "../src/application.ts";
import { handle, type SignalSeam, type TimerSeam } from "../src/cli-commands/progress.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const cli = join(root, "src", "cli.ts");

function invoke(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { encoding: "utf8" });
}

function fixture(status = "draft"): { directory: string; state: string; initiativeId: string } {
  const directory = mkdtempSync(join(tmpdir(), "loom-and-order-cli-progress-"));
  const state = join(directory, "state");
  const service = new ApplicationService({ stateDir: state, autoStart: false });
  const { initiativeId } = service.store.createPlan({
    plan: { title: "Progress fixture", epics: [{ id: "epic", title: "Epic", tasks: [{ id: "task", title: "Task", acceptanceCriteria: ["test"] }] }] },
    repoPath: directory,
    baseCommit: "fixture",
  });
  service.store.db.prepare("UPDATE nodes SET status = ? WHERE id = ?").run(status, initiativeId);
  service.close();
  return { directory, state, initiativeId };
}

test("ordinary progress remains one successful snapshot", () => {
  const { directory, state, initiativeId } = fixture("draft");
  try {
    const result = invoke(["progress", initiativeId, "--state-dir", state, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(result.stdout).initiative.status, "draft");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("watch once renders one block and maps terminal lifecycle states to status", () => {
  for (const [status, expectedExit] of [["completed", 0], ["failed", 0], ["cancelled", 0], ["draft", 1], ["active", 1], ["waiting", 1], ["blocked", 1], ["pending", 1]] as const) {
    const { directory, state, initiativeId } = fixture(status);
    try {
      const result = invoke(["progress", initiativeId, "--watch", "--once", "--state-dir", state, "--json"]);
      assert.equal(result.status, expectedExit, `${status}: ${result.stderr}`);
      assert.equal(result.stdout.trim().split("\n").length, 1, status);
      assert.equal(JSON.parse(result.stdout).initiative.status, status === "pending" ? "ready" : status);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("once requires watch", () => {
  const { directory, state, initiativeId } = fixture();
  try {
    const result = invoke(["progress", initiativeId, "--once", "--state-dir", state, "--json"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires --watch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("continuous watch clears its timer and SIGINT listener through seams", async () => {
  let poll: (() => void) | undefined;
  let signal: (() => void) | undefined;
  let cleared = false;
  let renders = 0;
  const timers: TimerSeam = {
    setInterval: callback => { poll = callback; return "timer"; },
    clearInterval: timer => { assert.equal(timer, "timer"); cleared = true; },
  };
  const signals: SignalSeam = {
    on: (_name, listener) => { signal = listener; },
    removeListener: (_name, listener) => { assert.equal(listener, signal); signal = undefined; },
  };
  const context = {
    command: "progress",
    args: ["initiative"],
    positionals: ["progress", "initiative"],
    values: {},
    booleans: new Set(["watch"]),
    json: true,
    machine: true,
    stateDir: "state",
    service: { progress: () => ({ initiative: { status: "active" } }) },
    render: value => JSON.stringify(value),
    output: () => { renders += 1; },
    writeStdout: () => undefined,
  } as any;
  const watching = handle(context, { timers, signals });
  await Promise.resolve();
  assert.equal(renders, 1);
  poll?.();
  assert.equal(renders, 2);
  signal?.();
  await watching;
  assert.equal(cleared, true);
  assert.equal(signal, undefined);
});
