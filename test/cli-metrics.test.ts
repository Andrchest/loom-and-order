import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const cli = join(root, "src", "cli.ts");

function invoke(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { encoding: "utf8" });
}

test("metrics --out writes JSON and emits only a compact acknowledgement", () => {
  const directory = mkdtempSync(join(tmpdir(), "loom-and-order-cli-metrics-json-"));
  try {
    const state = join(directory, "state");
    const baseline = invoke(["metrics", "initiative", "--state-dir", state]);
    assert.equal(baseline.status, 0, baseline.stderr);
    const output = join(directory, "metrics.json");
    const result = invoke(["metrics", "initiative", "--state-dir", state, "--out", output]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${JSON.stringify({ ok: true, file: output })}\n`);
    assert.equal(readFileSync(output, "utf8"), baseline.stdout);

    const machine = invoke(["metrics", "initiative", "--state-dir", state, "--json"]);
    assert.equal(machine.status, 0, machine.stderr);
    const machineOutput = join(directory, "metrics-machine.json");
    const machineResult = invoke(["metrics", "initiative", "--state-dir", state, "--json", "--out", machineOutput]);
    assert.equal(machineResult.status, 0, machineResult.stderr);
    assert.equal(readFileSync(machineOutput, "utf8"), machine.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("metrics --prometheus --out writes the existing Prometheus representation", () => {
  const directory = mkdtempSync(join(tmpdir(), "loom-and-order-cli-metrics-prom-"));
  try {
    const state = join(directory, "state");
    const baseline = invoke(["metrics", "initiative", "--state-dir", state, "--prometheus"]);
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout, /\n\n$/);
    const output = join(directory, "metrics.prom");
    const result = invoke(["metrics", "initiative", "--state-dir", state, "--prometheus", "--out", output]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${JSON.stringify({ ok: true, file: output })}\n`);
    assert.equal(readFileSync(output, "utf8"), baseline.stdout.slice(0, -1));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("metrics --out reports missing parents without creating them and help covers extensions", () => {
  const directory = mkdtempSync(join(tmpdir(), "loom-and-order-cli-metrics-errors-"));
  try {
    const state = join(directory, "state");
    const missing = join(directory, "missing", "metrics.json");
    const result = invoke(["metrics", "initiative", "--state-dir", state, "--out", missing]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /metrics output directory does not exist/);
    assert.equal(existsSync(join(directory, "missing")), false);

    const help = invoke(["--help"]);
    assert.equal(help.status, 0, help.stderr);
    for (const syntax of ["metrics INITIATIVE_ID [--prometheus] [--out FILE]", "events [--limit N]", "doctor", "logs INITIATIVE_ID --follow", "progress INITIATIVE_ID [--watch [--once]]"]) {
      assert.match(help.stdout, new RegExp(syntax.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
