import assert from "node:assert/strict";
import { test } from "node:test";
import { applyArchitectureExecutionPlan, parseArchitectureContract, parseManagerDecision, parsePlan, parseReview } from "../src/runtime.ts";

test("parses architecture contracts without accepting hidden reasoning fields", () => {
  const contract = parseArchitectureContract(JSON.stringify({
    summary: "Pure deterministic engine",
    decisions: ["Keep the engine independent from terminal IO"],
    constraints: ["Use the standard library"],
    invariants: ["Identical seeds produce identical states"],
    interfaces: ["GameState and step"],
    taskGuidance: ["Add negative invariant tests"],
    reasoning: "must not become part of the contract",
  }));
  assert.ok(contract);
  assert.equal(contract.version, 1);
  assert.equal(Object.hasOwn(contract, "reasoning"), false);
  assert.equal(parseArchitectureContract(JSON.stringify({ summary: "missing fields" })), null);
});

test("rejects prose or self-produced paths in machine artifact fields", () => {
  const base = { summary: "Runtime-aware feature", decisions: ["Keep checks explicit"], constraints: ["Use the standard library"], invariants: ["No prose paths"], interfaces: ["CLI"], taskGuidance: ["Build the layer"] };
  const plan = (task: any) => JSON.stringify({ ...base, executionPlan: { tasks: [task], integrationOrder: ["task"], preflightChecks: ["paths"], repairPolicy: "manager review" } });
  assert.equal(parseArchitectureContract(plan({ alias: "task", title: "Task", objective: "Run it", produces: ["Immutable model foundation"], deliverables: [], requiredArtifacts: [], prerequisites: [], dependsOn: [], verification: ["test"] })), null);
  assert.equal(parseArchitectureContract(plan({ alias: "task", title: "Task", objective: "Run it", produces: ["src/model.py"], deliverables: ["Model"], requiredArtifacts: ["src/model.py"], prerequisites: [], dependsOn: [], verification: ["test"] })), null);
  assert.equal(parseArchitectureContract(plan({ alias: "task", title: "Task", objective: "Run it", produces: ["src/model.py"], deliverables: ["Model"], requiredArtifacts: ["Python 3.10+"], prerequisites: [], dependsOn: [], verification: ["test"] })), null);
  assert.equal(parseArchitectureContract(JSON.stringify({
    ...base,
    executionPlan: {
      tasks: [
        { alias: "foundation", title: "Foundation", objective: "Create the package", produces: ["src/__init__.py"], deliverables: [], requiredArtifacts: [], prerequisites: [], dependsOn: [], verification: ["test"] },
        { alias: "api", title: "Public API", objective: "Export the package", produces: ["./src/__init__.py"], deliverables: [], requiredArtifacts: [], prerequisites: [], dependsOn: ["foundation"], verification: ["test"] },
      ],
      integrationOrder: ["foundation", "api"],
      preflightChecks: ["paths"],
      repairPolicy: "manager review",
    },
  })), null);
});

test("keeps textual prerequisites separate from artifact preflight", () => {
  const contract = parseArchitectureContract(JSON.stringify({
    summary: "Runtime-aware feature",
    decisions: ["Keep checks explicit"],
    constraints: ["Use the standard library"],
    invariants: ["No textual prerequisite is a path"],
    interfaces: ["CLI"],
    taskGuidance: ["Install the runtime before execution"],
    executionPlan: {
      tasks: [{ alias: "task", title: "Task", objective: "Run it", produces: [], deliverables: [], requires: ["Python 3.10+", "The model contract and invariants in this architecture"], dependsOn: [], verification: ["test"] }],
      integrationOrder: ["task"],
      preflightChecks: ["required artifacts exist"],
      repairPolicy: "manager review",
    },
  }));
  assert.deepEqual(contract?.executionPlan?.tasks[0].requiredArtifacts, []);
  assert.deepEqual(contract?.executionPlan?.tasks[0].prerequisites, ["Python 3.10+", "The model contract and invariants in this architecture"]);
});

test("parses a system-aware architecture execution plan and adds its dependencies", () => {
  const contract = parseArchitectureContract(JSON.stringify({
    summary: "Layered feature",
    decisions: ["Keep interfaces explicit"],
    constraints: ["Use the existing runtime"],
    invariants: ["Consumers follow producers"],
    interfaces: ["Public API"],
    taskGuidance: ["Build before integration"],
    executionPlan: {
      tasks: [
        { alias: "foundation", title: "Foundation", objective: "Create the base", produces: ["src/base.ts"], deliverables: ["Base"], requiredArtifacts: [], prerequisites: [], dependsOn: [], verification: ["unit test"] },
        { alias: "integration", title: "Integration", objective: "Connect the base", produces: ["src/integration.ts"], deliverables: ["Integration"], requiredArtifacts: ["src/base.ts"], prerequisites: [], dependsOn: [], verification: ["integration test"] },
      ],
      integrationOrder: ["foundation", "integration"],
      preflightChecks: ["required artifacts exist"],
      repairPolicy: "one repair then escalation",
    },
  }));
  assert.equal(contract?.version, 2);
  const plan = parsePlan(JSON.stringify({ title: "Feature", epics: [{ title: "Core", tasks: [{ architectureAlias: "foundation", title: "Foundation", acceptanceCriteria: ["works"] }, { architectureAlias: "integration", title: "Integration", acceptanceCriteria: ["works"] }] }] }));
  assert.ok(plan);
  applyArchitectureExecutionPlan(plan, contract?.executionPlan);
  assert.deepEqual(plan.epics[0].tasks[1].dependsOn, ["task-1-1-foundation"]);
});

test("maps architect hardWorker marks to the worker-hard profile and keeps explicit choices", () => {
  const contract = parseArchitectureContract(JSON.stringify({
    summary: "Hard feature",
    decisions: ["Escalate the invariants task"],
    constraints: ["Keep scope tight"],
    invariants: ["Deletion is retention-safe"],
    interfaces: ["Runtime API"],
    taskGuidance: ["Use worker-hard for the GC core"],
    executionPlan: {
      tasks: [
        { alias: "plain", title: "Plain", objective: "Simple work", produces: [], deliverables: ["done"], requiredArtifacts: [], prerequisites: [], dependsOn: [], verification: ["test"] },
        { alias: "hard", title: "Hard", objective: "Invariant-heavy work", produces: [], deliverables: ["done"], requiredArtifacts: [], prerequisites: [], dependsOn: [], verification: ["gc tests"], hardWorker: true },
        { alias: "explicit", title: "Explicit", objective: "Manager chose", produces: [], deliverables: ["done"], requiredArtifacts: [], prerequisites: [], dependsOn: [], verification: ["test"], hardWorker: true },
      ],
      integrationOrder: ["plain", "hard", "explicit"],
      preflightChecks: ["artifacts"],
      repairPolicy: "manager review",
    },
  }));
  assert.ok(contract?.executionPlan);
  const plan = parsePlan(JSON.stringify({ title: "Hard", epics: [{ title: "E", tasks: [{ architectureAlias: "plain", title: "Plain", acceptanceCriteria: ["a"] }, { architectureAlias: "hard", title: "Hard", acceptanceCriteria: ["a"] }, { architectureAlias: "explicit", title: "Explicit", acceptanceCriteria: ["a"], profileId: "researcher" }] }] }));
  assert.ok(plan);
  applyArchitectureExecutionPlan(plan, contract.executionPlan);
  assert.equal(plan.epics[0].tasks[0].profileId, undefined);
  assert.equal(plan.epics[0].tasks[1].profileId, "worker-hard");
  assert.equal(plan.epics[0].tasks[2].profileId, "researcher");
});

test("rejects hardWorker marks that are not true or lack verification checks", () => {
  const base = (hardWorker: unknown, verification: string[]) => parseArchitectureContract(JSON.stringify({
    summary: "Hard feature",
    decisions: ["d"],
    constraints: ["c"],
    invariants: ["i"],
    interfaces: ["f"],
    taskGuidance: ["g"],
    executionPlan: {
      tasks: [{ alias: "t", title: "T", objective: "O", produces: [], deliverables: [], requiredArtifacts: [], prerequisites: [], dependsOn: [], verification, hardWorker }],
      integrationOrder: ["t"],
      preflightChecks: ["x"],
      repairPolicy: "manager review",
    },
  }));
  assert.equal(base("yes", ["test"]), null);
  assert.equal(base(1, ["test"]), null);
  assert.equal(base(true, []), null);
  const valid = base(true, ["gc tests"]);
  assert.equal(valid?.executionPlan?.tasks[0].hardWorker, true);
});

test("parses the bounded manager recovery actions strictly", () => {
  for (const action of ["architect", "retry", "block"] as const) {
    const decision = parseManagerDecision(JSON.stringify({ action, nodeId: "task-1", reason: "recorded", edits: [] }));
    assert.equal(decision?.action, action);
    assert.equal(decision?.nodeId, "task-1");
  }
  assert.equal(parseManagerDecision(JSON.stringify({ action: "retry", edits: [] })), null);
  assert.equal(parseManagerDecision(JSON.stringify({ action: "retry", nodeId: "task-1", edits: [{ nodeId: "task-1", dependsOn: "not-an-array" }] })), null);
  assert.equal(parseManagerDecision(JSON.stringify({ action: "retry", nodeId: "task-1", edits: [{ title: "missing node id" }] })), null);
});

test("rejects malformed plan fields instead of stringifying them", () => {
  assert.equal(parsePlan(JSON.stringify({ title: "Feature", epics: [{ title: "Core", tasks: [{ title: "Task", acceptanceCriteria: [{ bad: true }] }] }] })), null);
  assert.equal(parsePlan(JSON.stringify({ title: "Feature", epics: [{ title: "Core", tasks: [{ title: "Task", subtasks: [{ title: "Nested", subtasks: [{ title: "Too deep" }] }] }] }] })), null);
});

test("requires strict reviewer handoff fields", () => {
  assert.equal(parseReview(JSON.stringify({ verdict: "pass" })), null);
  assert.equal(parseReview(JSON.stringify({ verdict: "pass", findings: [""], evidence: {} })), null);
  assert.equal(parseReview(JSON.stringify({ verdict: "pass", findings: [], evidence: [] })), null);
  assert.deepEqual(parseReview(JSON.stringify({ verdict: "pass", findings: [" good "], evidence: { checks: ["unit"] } }))?.findings, ["good"]);
});

test("canonicalizes plan IDs and resolves title-based dependencies", () => {
  const plan = parsePlan(JSON.stringify({
    title: "Feature",
    epics: [{
      title: "Foundation",
      tasks: [
        { title: "Bootstrap", acceptanceCriteria: ["works"] },
        { title: "Engine", dependsOn: ["Bootstrap"], acceptanceCriteria: ["works"] },
      ],
    }],
  }));
  assert.ok(plan);
  assert.equal(plan.epics[0].id, "epic-1-foundation");
  assert.equal(plan.epics[0].tasks[0].id, "task-1-1-bootstrap");
  assert.equal(plan.epics[0].tasks[1].id, "task-1-2-engine");
  assert.deepEqual(plan.epics[0].tasks[1].dependsOn, ["task-1-1-bootstrap"]);
});

test("preserves explicit dependency aliases while assigning canonical IDs", () => {
  const plan = parsePlan(JSON.stringify({
    title: "Feature",
    epics: [{
      id: "epic-from-model",
      title: "Foundation",
      tasks: [
        { id: "bootstrap-from-model", title: "Bootstrap", acceptanceCriteria: ["works"] },
        { title: "Engine", dependsOn: ["bootstrap-from-model"], acceptanceCriteria: ["works"] },
      ],
    }],
  }));
  assert.ok(plan);
  assert.equal(plan.epics[0].id, "epic-1-foundation");
  assert.deepEqual(plan.epics[0].tasks[1].dependsOn, ["task-1-1-bootstrap"]);
});
