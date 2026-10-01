import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Generic role profiles for tests. The repository ships two example worker
// profiles only; tests seed the full role set as custom profiles under
// <stateDir>/custom-profiles — the same mechanism `profiles create` uses.
// No personal infrastructure: provider/model values are public examples.

function manifest(id: string, role: string, pool: string, model: string | null, thinkingLevel: string) {
  return {
    id,
    role,
    pool,
    piBin: "pi",
    model,
    thinkingLevel,
    skills: [],
    extensions: [],
    tools: ["read", "bash"],
    timeoutMs: 60000,
    maxAttempts: 3,
    sandbox: {
      backend: "trusted-local",
      sandboxName: null,
      allowedDomains: [],
      deniedDomains: [],
      credentialMode: "host-auth",
    },
  };
}

export const TEST_ROLE_PROFILES: Record<string, unknown> = {
  "test-architect": manifest("test-architect", "architect", "codex", "openai-codex/gpt-5.5", "high"),
  "test-manager": manifest("test-manager", "manager", "codex", "openai-codex/gpt-5.5", "high"),
  "test-worker": manifest("test-worker", "worker", "codex", "openai-codex/gpt-5.5", "high"),
  "test-worker-local": manifest("test-worker-local", "worker", "local", null, "high"),
  "test-reviewer": manifest("test-reviewer", "reviewer", "codex", "openai-codex/gpt-5.5", "high"),
  "test-researcher": manifest("test-researcher", "researcher", "codex", "openai-codex/gpt-5.5", "high"),
  "test-release": manifest("test-release", "release", "codex", "openai-codex/gpt-5.5", "high"),
};

export function seedTestProfiles(stateDir: string): void {
  const directory = join(stateDir, "custom-profiles");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const profile of Object.values(TEST_ROLE_PROFILES)) {
    const id = (profile as { id: string }).id;
    writeFileSync(join(directory, `${id}.json`), `${JSON.stringify(profile, null, 2)}\n`);
  }
}
