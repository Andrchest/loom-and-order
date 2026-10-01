import type { CliCommandHandler, CommandContext } from "../cli-commands.ts";
import { diagnoseState } from "../doctor.ts";

export function handle(context: CommandContext): { exitCode: 0 | 1 } {
  const result = diagnoseState(context.stateDir);
  context.output(result);
  return { exitCode: result.healthy ? 0 : 1 };
}

const handler: CliCommandHandler = { command: "doctor", requiresService: false, handle };
export default handler;
