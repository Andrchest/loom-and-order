import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findLatestSessionLog, followSessionLog, readIncrementalLog, type SignalSeam, type TimerSeam } from "../src/cli-commands/logs.ts";

function fixture(): { directory: string; logs: string } {
  const directory = mkdtempSync(join(tmpdir(), "loom-and-order-cli-logs-"));
  const logs = join(directory, "logs");
  mkdirSync(logs);
  return { directory, logs };
}

test("latest session log selection uses mtime and lexical tie-breaking", () => {
  const { directory, logs } = fixture();
  try {
    const older = join(logs, "older.jsonl");
    const alpha = join(logs, "alpha.jsonl");
    const beta = join(logs, "beta.jsonl");
    writeFileSync(older, "old\n");
    writeFileSync(alpha, "alpha\n");
    writeFileSync(beta, "beta\n");
    const oldTime = new Date(1_000);
    const latest = new Date(2_000);
    utimesSync(older, oldTime, oldTime);
    utimesSync(alpha, latest, latest);
    utimesSync(beta, latest, latest);
    assert.equal(findLatestSessionLog(logs)?.name, "alpha.jsonl");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("incremental reads detect an in-place rewrite even when it grows", () => {
  const { directory, logs } = fixture();
  try {
    const path = join(logs, "session.jsonl");
    writeFileSync(path, "first\nsecond\n");
    const first = readIncrementalLog(path);
    assert.equal(first.content, "first\nsecond\n");
    writeFileSync(path, "replacement\nsecond\nthird\n");
    const replacement = readIncrementalLog(path, first.state);
    assert.equal(replacement.content, "replacement\nsecond\nthird\n");
    appendFileSync(path, "fourth\n");
    assert.equal(readIncrementalLog(path, replacement.state).content, "fourth\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("following uses injected output, timer, and SIGINT seams", async () => {
  const { directory, logs } = fixture();
  try {
    const path = join(logs, "session.jsonl");
    writeFileSync(path, "initial\n");
    const output: string[] = [];
    let poll: (() => void) | undefined;
    let listener: (() => void) | undefined;
    let cleared = false;
    const timers: TimerSeam = {
      setInterval: callback => { poll = callback; return 1; },
      clearInterval: () => { cleared = true; },
    };
    const signals: SignalSeam = {
      on: (_signal, callback) => { listener = callback; },
      removeListener: (_signal, callback) => { assert.equal(callback, listener); listener = undefined; },
    };
    const following = followSessionLog(logs, { output: value => output.push(value), timers, signals });
    await Promise.resolve();
    assert.deepEqual(output, ["initial\n"]);
    appendFileSync(path, "appended\n");
    poll?.();
    assert.deepEqual(output, ["initial\n", "appended\n"]);
    listener?.();
    await following;
    assert.equal(cleared, true);
    assert.equal(listener, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("following reports a missing JSONL session log", async () => {
  const { directory, logs } = fixture();
  try {
    await assert.rejects(followSessionLog(logs), /no regular JSONL session log found/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
