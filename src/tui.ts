import { ApplicationService } from "./application.ts";

export function formatDashboard(service: ApplicationService, initiativeId: string): string {
  const initiative = service.status(initiativeId);
  const metrics = service.metrics(initiativeId);
  const agents = service.agents(initiativeId);
  const sessions = service.agentSessions(initiativeId, "running");
  const events = service.feed(initiativeId, Math.max(0, service.store.eventCursor() - 8), 8);
  const lines = [
    `Loom & Order  ${initiative.title}  [${initiative.status}]`,
    `runs=${metrics.metricCount} recoveries=${metrics.recoveryCount} outcomes=${JSON.stringify(metrics.outcomes)}`,
    `agents=${agents.length} active_sessions=${sessions.length} supervisor=${service.supervisorStatus().running ? "running" : "idle"}`,
    "Active agents:",
    ...(agents.length ? agents.map((agent) => `  ${agent.id}  ${agent.role}  ${agent.model ?? "unknown"}  ${agent.status}  heartbeat=${agent.lastHeartbeat ?? "never"}`) : ["  none"]),
    "Recent events:",
    ...(events.length ? events.map((event) => `  #${event.id} ${event.kind} ${event.nodeId ?? ""}`) : ["  none"]),
    "Press Ctrl-C to exit. Messages and plan edits are made through CLI/MCP.",
    "",
  ];
  for (const node of service.tree(initiativeId)) {
    const indent = { initiative: "", epic: "  ", task: "    ", subtask: "      " }[node.level];
    lines.push(`${indent}${node.level.padEnd(10)} ${node.status.padEnd(12)} ${node.id}  ${node.title}`);
    if (node.failure) lines.push(`${indent}  ! ${node.failure.slice(0, 160)}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runDashboard(service: ApplicationService, initiativeId: string): Promise<void> {
  const render = (): void => {
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(formatDashboard(service, initiativeId));
  };
  render();
  await new Promise<void>((resolve) => {
    const timer = setInterval(render, 1000);
    const stop = (): void => { clearInterval(timer); process.removeListener("SIGINT", stop); resolve(); };
    process.on("SIGINT", stop);
  });
}
