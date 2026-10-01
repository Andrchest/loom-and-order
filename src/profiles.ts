import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TOOLCHAIN_PI_BIN } from "./toolchain.ts";

export interface SandboxConfig {
  backend: "trusted-local" | "pi-sandbox" | "sbx";
  extensionPath?: string | null;
  sandboxName?: string | null;
  allowedDomains: string[];
  deniedDomains?: string[];
  credentialMode: "explicit-profile-auth" | "host-auth" | "broker";
}

export type AgentRole = "manager" | "worker" | "reviewer" | "researcher" | "architect" | "release";
export type ModelPool = "local" | "codex";

export interface ModelPricing {
  inputPerMillionUsd?: number;
  outputPerMillionUsd?: number;
  reasoningPerMillionUsd?: number;
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
  codexInputCreditsPerMillion?: number;
  codexOutputCreditsPerMillion?: number;
  codexCacheReadCreditsPerMillion?: number;
  codexCacheWriteCreditsPerMillion?: number;
}

export interface ProfileManifest {
  id: string;
  role: AgentRole;
  pool?: ModelPool;
  piBin: string;
  model?: string | null;
  thinkingLevel?: string;
  skills: string[];
  extensions: string[];
  tools: string[];
  timeoutMs: number;
  maxAttempts: number;
  maxConcurrency?: number;
  rolePrompt?: string;
  pricing?: ModelPricing;
  reviewPolicy?: {
    reviewerRequired?: boolean;
    gateRequired?: boolean;
    allowIntegration?: boolean;
  };
  sandbox: SandboxConfig;
}

export interface ModelPoolSpec {
  id: string;
  pool: ModelPool;
  provider: string;
  model: string;
  name: string;
  contextWindow: number;
  thinkingLevels: string[];
}

export interface CatalogProfileSpec {
  id: string;
  role: AgentRole;
  pool: ModelPool;
  model: string;
  thinkingLevel: string;
  description: string;
}

export interface CatalogModelSpec {
  id: string;
  pool: ModelPool;
  provider: string;
  model: string;
  name: string;
  contextWindow: number;
  thinkingLevels: string[];
  pricing?: ModelPricing;
}

export interface ModelCatalog {
  version: number;
  defaultPreset: string;
  limits: {
    codexNonManager: number;
    local: number;
    infrastructureRetries: number;
  };
  pools: ModelPoolSpec[];
  models?: CatalogModelSpec[];
  profiles: CatalogProfileSpec[];
  presets: Record<string, Record<AgentRole, string>>;
}

export interface ResolvedProfile extends ProfileManifest {
  rootDir: string;
  agentDir: string;
  sessionDir: string;
  settingsPath: string;
  sandboxConfigPath: string;
}

const PROVIDER_DOMAINS = new Set([
  "api.anthropic.com:443",
  "api.openai.com:443",
  "generativelanguage.googleapis.com:443",
]);

function expand(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => env[key] ?? "");
}

const PROFILE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function validDomain(value: string): boolean {
  return /^(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/.test(value) && !value.includes("/") && !value.includes("..");
}

export function validateSandbox(config: SandboxConfig): void {
  if (config.backend === "trusted-local" && (config.extensionPath || config.sandboxName)) throw new Error("trusted-local cannot use sandboxName or extensionPath");
  if (config.backend === "pi-sandbox" && config.sandboxName) throw new Error("pi-sandbox cannot use sandboxName");
  if (config.backend === "sbx" && config.extensionPath) throw new Error("sbx cannot use extensionPath");
  if (config.backend === "pi-sandbox" && !config.extensionPath) throw new Error("pi-sandbox profile requires extensionPath");
  if (config.backend === "trusted-local" && config.credentialMode === "broker") throw new Error("trusted-local cannot use broker credentials");
  if (config.backend === "sbx" && !config.sandboxName) throw new Error("sbx profile requires sandboxName");
  if (config.credentialMode === "broker" && config.backend !== "sbx") {
    throw new Error("broker credentials require the sbx backend; trusted-local and pi-sandbox must use explicit-profile-auth or host-auth");
  }
  for (const domain of [...config.allowedDomains, ...(config.deniedDomains ?? [])]) {
    if (!validDomain(domain)) throw new Error(`invalid network domain: ${domain}`);
  }
}

export function validateProfileManifest(manifest: ProfileManifest): void {
  if (!PROFILE_ID_PATTERN.test(manifest.id)) throw new Error(`invalid profile id: ${manifest.id}`);
  if (!["manager", "worker", "reviewer", "researcher", "architect", "release"].includes(manifest.role)) throw new Error(`invalid profile role: ${manifest.role}`);
  if (!manifest.piBin || !Array.isArray(manifest.skills) || !Array.isArray(manifest.extensions) || !Array.isArray(manifest.tools)) {
    throw new Error("profile must declare piBin, skills, extensions, and tools");
  }
  if (!Number.isInteger(manifest.timeoutMs) || manifest.timeoutMs <= 0) throw new Error("profile timeoutMs must be a positive integer");
  if (!Number.isInteger(manifest.maxAttempts) || manifest.maxAttempts < 1 || manifest.maxAttempts > 3) throw new Error("profile maxAttempts must be an integer from 1 to 3 (at most two repeats)");
  if (manifest.maxConcurrency !== undefined && (!Number.isInteger(manifest.maxConcurrency) || manifest.maxConcurrency <= 0)) throw new Error("profile maxConcurrency must be a positive integer");
  if (manifest.pricing) for (const value of Object.values(manifest.pricing)) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error("profile pricing values must be finite and non-negative");
  if (manifest.pool !== undefined && manifest.pool !== "local" && manifest.pool !== "codex") throw new Error(`invalid profile pool: ${manifest.pool}`);
  validateSandbox(manifest.sandbox);
}

export function loadProfile(path: string): ProfileManifest {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as ProfileManifest;
  try {
    validateProfileManifest(manifest);
  } catch (error) {
    throw new Error(`${String(error)} (${path})`);
  }
  return manifest;
}

export function loadModelCatalog(path: string): ModelCatalog {
  const catalog = JSON.parse(readFileSync(path, "utf8")) as ModelCatalog;
  if (catalog.version !== 1 || !catalog.defaultPreset || !catalog.limits || !Array.isArray(catalog.pools) || !Array.isArray(catalog.profiles) || !catalog.presets) {
    throw new Error(`invalid model catalog ${path}`);
  }
  if (!catalog.limits.codexNonManager || !catalog.limits.local || catalog.limits.infrastructureRetries < 0) {
    throw new Error(`invalid model catalog limits ${path}`);
  }
  const poolIds = new Set<string>();
  for (const pool of catalog.pools) {
    if (!pool.id || poolIds.has(pool.id) || !pool.provider || !pool.model || !pool.name || !pool.contextWindow || !pool.thinkingLevels?.length) {
      throw new Error(`invalid model pool in ${path}`);
    }
    poolIds.add(pool.id);
    if (pool.pool !== "local" && pool.pool !== "codex") throw new Error(`invalid model pool kind: ${pool.id}`);
  }
  const modelIds = new Set<string>();
  for (const model of catalog.models ?? []) {
    if (!model.id || modelIds.has(model.id) || !model.provider || !model.model || !model.name || !model.contextWindow || !model.thinkingLevels?.length) {
      throw new Error(`invalid catalog model in ${path}`);
    }
    modelIds.add(model.id);
    if (model.pool !== "local" && model.pool !== "codex") throw new Error(`invalid catalog model pool: ${model.id}`);
  }
  const profileIds = new Set<string>();
  for (const profile of catalog.profiles) {
    if (!profile.id || profileIds.has(profile.id) || !profile.role || !profile.pool || !profile.model || !profile.thinkingLevel || !profile.description) {
      throw new Error(`invalid catalog profile in ${path}`);
    }
    profileIds.add(profile.id);
    if (!["manager", "worker", "reviewer", "researcher", "architect", "release"].includes(profile.role)) throw new Error(`invalid catalog role: ${profile.role}`);
    if (profile.pool !== "local" && profile.pool !== "codex") throw new Error(`invalid catalog pool: ${profile.pool}`);
  }
  if (Object.keys(catalog.presets).length > 0) {
    if (!catalog.presets[catalog.defaultPreset]) throw new Error(`default preset is missing: ${catalog.defaultPreset}`);
    for (const [presetId, preset] of Object.entries(catalog.presets)) {
      for (const role of ["manager", "worker", "reviewer", "researcher", "architect", "release"] as const) {
        const profileId = preset[role];
        if (!profileId || !profileIds.has(profileId)) throw new Error(`preset ${presetId} references unknown profile: ${String(profileId)}`);
      }
    }
  }
  return catalog;
}

export function materializeCatalogProfiles(catalog: ModelCatalog, baseProfiles: Partial<Record<AgentRole, ProfileManifest>>): ProfileManifest[] {
  return catalog.profiles.map((spec) => {
    const base = baseProfiles[spec.role];
    if (!base) throw new Error(`no base profile for catalog role: ${spec.role}`);
    const profile: ProfileManifest = {
      ...base,
      id: spec.id,
      role: spec.role,
      pool: spec.pool,
      model: spec.model,
      thinkingLevel: spec.thinkingLevel,
      pricing: catalog.models?.find((model) => model.model === spec.model)?.pricing ?? base.pricing,
    };
    validateProfileManifest(profile);
    return profile;
  });
}

export interface RoleProfileSelection {
  architect?: string;
  manager?: string;
  worker?: string;
  reviewer?: string;
  researcher?: string;
  release?: string;
}

const ROLE_SELECTION_ROLES = ["architect", "manager", "worker", "reviewer", "researcher", "release"] as const;

// External (operator) role -> profile selection. Precedence, highest last:
// LAO_ROLE_PROFILES JSON, then LAO_PROFILE_<ROLE>.
export function parseRoleProfileSelection(env: NodeJS.ProcessEnv): RoleProfileSelection {
  const selection: RoleProfileSelection = {};
  if (env.LAO_ROLE_PROFILES) {
    let parsed: unknown;
    try { parsed = JSON.parse(env.LAO_ROLE_PROFILES); }
    catch { throw new Error("LAO_ROLE_PROFILES must be a JSON object mapping roles to profile IDs"); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("LAO_ROLE_PROFILES must be a JSON object mapping roles to profile IDs");
    for (const role of ROLE_SELECTION_ROLES) {
      const value = (parsed as Record<string, unknown>)[role];
      if (value === undefined) continue;
      if (typeof value !== "string" || !value) throw new Error(`LAO_ROLE_PROFILES.${role} must be a non-empty profile ID`);
      selection[role] = value;
    }
  }
  for (const role of ROLE_SELECTION_ROLES) {
    const value = env[`LAO_PROFILE_${role.toUpperCase()}`];
    if (value) selection[role] = value;
  }
  return selection;
}

export function resolveProfileModel(manifest: ProfileManifest, env: NodeJS.ProcessEnv): string | null | undefined {
  if (manifest.model) return expand(manifest.model, env);
  if (manifest.pool === "local") {
    const fromEnv = env.LAO_LOCAL_MODEL;
    if (!fromEnv) throw new Error(`local pool profile ${manifest.id} has no model and LAO_LOCAL_MODEL (provider/model) is not set`);
    return fromEnv;
  }
  return manifest.model;
}

export class ProfileResolver {
  readonly stateDir: string;
  readonly env: NodeJS.ProcessEnv;

  constructor(stateDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.stateDir = resolve(stateDir);
    this.env = env;
  }

  resolve(manifest: ProfileManifest, runId: string): ResolvedProfile {
    validateProfileManifest(manifest);
    const model = resolveProfileModel(manifest, this.env);
    const rootDir = join(this.stateDir, "profiles", manifest.id, runId);
    const agentDir = join(rootDir, "agent");
    const sessionDir = join(rootDir, "sessions");
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    if (manifest.sandbox.backend === "pi-sandbox") mkdirSync(join(agentDir, "extensions", "pi-sandbox"), { recursive: true, mode: 0o700 });
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const extensions = manifest.extensions.map((value) => expand(value, this.env));
    const extensionPath = manifest.sandbox.extensionPath ? expand(manifest.sandbox.extensionPath, this.env) : "";
    const piBin = manifest.piBin === TOOLCHAIN_PI_BIN && !this.env.LAO_TOOLCHAIN_DIR ? "pi" : expand(manifest.piBin, this.env);
    if (manifest.sandbox.backend === "pi-sandbox" && extensionPath) {
      extensions.push(extensionPath);
    }
    if (manifest.sandbox.backend === "pi-sandbox" && !extensionPath) throw new Error("LAO_PI_SANDBOX_EXTENSION is not configured; refusing unsandboxed launch");
    const settings = {
      defaultProjectTrust: "never",
      ...(model ? { defaultModel: model } : {}),
      ...(manifest.thinkingLevel ? { defaultThinkingLevel: manifest.thinkingLevel } : {}),
      defaultTools: manifest.tools,
      skills: manifest.skills.map((value) => expand(value, this.env)),
      extensions,
      enableSkillCommands: false,
      packages: [],
    };
    if (manifest.sandbox.credentialMode === "host-auth") {
      const hostAuth = expand(this.env.LAO_HOST_AUTH_FILE ?? join(this.env.HOME ?? ".", ".pi", "agent", "auth.json"), this.env);
      const isolatedAuth = join(agentDir, "auth.json");
      if (existsSync(hostAuth) && !existsSync(isolatedAuth)) symlinkSync(hostAuth, isolatedAuth);
    }
    // The isolated profile must see the host provider catalog (local servers such as
    // llama.cpp/Ollama backends are only defined in the host models.json, never in pi defaults).
    const hostModels = expand(this.env.LAO_MODELS_FILE ?? join(this.env.HOME ?? ".", ".pi", "agent", "models.json"), this.env);
    const isolatedModels = join(agentDir, "models.json");
    if (existsSync(hostModels) && !existsSync(isolatedModels)) symlinkSync(hostModels, isolatedModels);
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    const sandboxConfigPath = join(agentDir, "extensions", "pi-sandbox", "config.json");
    if (manifest.sandbox.backend === "pi-sandbox") {
      writeFileSync(sandboxConfigPath, `${JSON.stringify({
        subagents: { provider: "builtin" },
        network: {
          allowedDomains: manifest.sandbox.allowedDomains,
          deniedDomains: manifest.sandbox.deniedDomains ?? [],
        },
      }, null, 2)}\n`, { mode: 0o600 });
    }
    return {
      ...manifest,
      model,
      piBin,
      extensions,
      sandbox: {
        ...manifest.sandbox,
        extensionPath: extensionPath || null,
      },
      rootDir,
      agentDir,
      sessionDir,
      settingsPath,
      sandboxConfigPath,
    };
  }
}

export function writeProfile(path: string, manifest: ProfileManifest): void {
  validateProfileManifest(manifest);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

export function profileExists(path: string): boolean {
  return existsSync(path);
}

export class CustomProfileStore {
  readonly directory: string;

  constructor(stateDir: string) {
    this.directory = join(resolve(stateDir), "custom-profiles");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  pathFor(id: string): string {
    if (!PROFILE_ID_PATTERN.test(id)) throw new Error(`invalid profile id: ${id}`);
    return join(this.directory, `${id}.json`);
  }

  list(): ProfileManifest[] {
    return readdirSync(this.directory).filter((name) => name.endsWith(".json")).sort().map((name) => loadProfile(join(this.directory, name)));
  }

  get(id: string): ProfileManifest | null {
    const path = this.pathFor(id);
    return profileExists(path) ? loadProfile(path) : null;
  }

  save(manifest: ProfileManifest, overwrite = false): ProfileManifest {
    const path = this.pathFor(manifest.id);
    if (profileExists(path) && !overwrite) throw new Error(`profile already exists: ${manifest.id}`);
    writeProfile(path, manifest);
    return manifest;
  }

  clone(source: ProfileManifest, id: string, overrides: Partial<ProfileManifest> = {}): ProfileManifest {
    const clone = { ...source, ...overrides, id } as ProfileManifest;
    validateProfileManifest(clone);
    return clone;
  }
}
