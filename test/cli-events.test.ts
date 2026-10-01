import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Store } from "../src/store.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const cli = join(root, "src", "cli.ts");

function invoke(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { encoding: "utf8" });
}

function fixture(): { directory: string; state: string; events: ReturnType<Store["events"]> } {
  const directory = mkdtempSync(join(tmpdir(), "loom-and-order-cli-events-"));
  const state = join(directory, "state");
  const store = new Store(join(state, "state.sqlite3"));
  try {
    for (let sequence = 1; sequence <= 25; sequence += 1) {
      store.recordEvent(sequence % 2 === 0 ? "node-b" : "node-a", `event-${sequence}`, { sequence });
    }
    return { directory, state, events: store.events() };
  } finally {
    store.close();
  }
}

test("events renders recent events newest first with the exact projection", () => {
  const { directory, state, events } = fixture();
  try {
    const result = invoke(["events", "--state-dir", state]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    const expected = events.slice().reverse().map(({ createdAt, nodeId, kind, payload }) => ({ createdAt, nodeId, kind, payload }));
    assert.deepEqual(output, expected.slice(0, 20));
    assert.equal(output.length, 20);
    for (const item of output) assert.deepEqual(Object.keys(item), ["createdAt", "nodeId", "kind", "payload"]);

    const limited = invoke(["events", "--state-dir", state, "--limit", "2"]);
    assert.equal(limited.status, 0, limited.stderr);
    assert.deepEqual(JSON.parse(limited.stdout), expected.slice(0, 2));

    const logs = invoke(["logs", "--state-dir", state, "--json"]);
    assert.equal(logs.status, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), events);

    const feed = invoke(["feed", "node-a", "--state-dir", state, "--json"]);
    assert.equal(feed.status, 0, feed.stderr);
    assert.deepEqual(JSON.parse(feed.stdout), events.filter((event) => event.nodeId === "node-a").map((event) => ({ ...event, payload: event.payload })));

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("events rejects invalid limits", () => {
  const { directory, state } = fixture();
  try {
    for (const limit of ["0", "-1", "nope", "1.5", "9007199254740992"]) {
      const result = invoke(["events", "--state-dir", state, "--limit", limit]);
      assert.notEqual(result.status, 0, `expected rejection for ${limit}`);
      assert.match(result.stderr, /positive safe integer/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
