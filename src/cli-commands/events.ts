import type { CliCommandHandler, CommandContext } from "../cli-commands.ts";

function serviceFor(context: CommandContext) {
  if (!context.service) throw new Error("events requires an application service");
  return context.service;
}

const DEFAULT_LIMIT = 20;

function parseLimit(value: string | undefined): number {
  const limit = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("events --limit must be a positive safe integer");
  return limit;
}

export async function handle(context: CommandContext): Promise<void> {
  const records = serviceFor(context).recentEvents(parseLimit(context.values.limit));
  context.output(records.map(({ createdAt, nodeId, kind, payload }) => ({ createdAt, nodeId, kind, payload })));
}

const handler: CliCommandHandler = { command: "events", handle };
export default handler;
