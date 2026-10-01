import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TOOLCHAIN_EXTENSIONS, TOOLCHAIN_PACKAGES, ToolchainManager } from "../src/toolchain.ts";

test("defines the isolated latest toolchain bundle without global package paths", () => {
  assert.equal(TOOLCHAIN_PACKAGES["@earendil-works/pi-coding-agent"], "latest");
  assert.equal(TOOLCHAIN_PACKAGES["pi-smart-fetch"], "latest");
  assert.equal(TOOLCHAIN_PACKAGES["pi-mcp-adapter"], "latest");
  assert.equal(TOOLCHAIN_EXTENSIONS.tmux, "@romansix/pi-tmux/extensions");
});

test("does not download a missing toolchain when automatic updates are disabled", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "loom-and-order-toolchain-"));
  try {
    const manager = new ToolchainManager(stateDir, { ...process.env, LAO_TOOLCHAIN_AUTO_UPDATE: "0" });
    assert.equal(manager.status(), null);
    await assert.rejects(manager.ensureFresh(), /toolchain cache is empty/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
