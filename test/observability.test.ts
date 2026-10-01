import assert from "node:assert/strict";
import test from "node:test";
import { observabilityStatus, safeValue } from "../src/observability.ts";

test("redacts credentials and hidden reasoning from exported values", () => {
  assert.deepEqual(safeValue({ token: "secret-value", password: "pw", thinking: "private chain of thought", visible: "ok" }), {
    token: "[REDACTED]",
    password: "[REDACTED]",
    thinking: "[REDACTED]",
    visible: "ok",
  });
  assert.equal(safeValue("Authorization: Bearer abc123"), "Authorization: Bearer [REDACTED]");
});

test("redacts prompts, outputs, paths, and raw message text from exported values", () => {
  assert.deepEqual(safeValue({ prompt: "private prompt", assistant_text: "raw answer", stdout_path: "/tmp/private.log", cwd: "/repo", text: "raw text", bytes: 4 }), {
    prompt: "[REDACTED]",
    assistant_text: "[REDACTED]",
    stdout_path: "[REDACTED]",
    cwd: "[REDACTED]",
    text: "[REDACTED]",
    bytes: 4,
  });
});

test("MLflow export can be disabled without changing the runtime", () => {
  const previous = process.env.LAO_MLFLOW_ENABLED;
  process.env.LAO_MLFLOW_ENABLED = "0";
  assert.equal(observabilityStatus().enabled, false);
  if (previous === undefined) delete process.env.LAO_MLFLOW_ENABLED;
  else process.env.LAO_MLFLOW_ENABLED = previous;
});
