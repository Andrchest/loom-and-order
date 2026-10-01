import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CliCommandHandler, CommandContext } from "../cli-commands.ts";

function serviceFor(context: CommandContext) {
  if (!context.service) throw new Error("metrics requires an application service");
  return context.service;
}

function writeMetricsFile(path: string, contents: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) throw new Error(`metrics output directory does not exist: ${parent}`);
  if (!statSync(parent).isDirectory()) throw new Error(`metrics output parent is not a directory: ${parent}`);
  writeFileSync(path, contents, "utf8");
}

export async function handle(context: CommandContext): Promise<void> {
  const initiativeId = context.args[0];
  if (!initiativeId) throw new Error("metrics requires an initiative ID");
  const service = serviceFor(context);
  const prometheus = context.booleans.has("prometheus");
  const output = context.values.out;
  if (output) {
    const representation = prometheus
      ? service.prometheus(initiativeId)
      : `${context.render(service.metrics(initiativeId))}\n`;
    writeMetricsFile(output, representation);
    context.writeStdout(`${JSON.stringify({ ok: true, file: output })}\n`);
    return;
  }
  if (prometheus) context.writeStdout(`${service.prometheus(initiativeId)}\n`);
  else context.output(service.metrics(initiativeId));
}

const handler: CliCommandHandler = { command: "metrics", handle };
export default handler;
