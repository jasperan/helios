import type { ToolDefinition } from "../providers/types.js";
import type { RemoteExecutor } from "../remote/executor.js";
import type { ConnectionPool } from "../remote/connection-pool.js";

export function createTaskOutputTool(
  executor: RemoteExecutor,
  pool: ConnectionPool,
): ToolDefinition {
  return {
    name: "task_output",
    description:
      "View the recent stdout/stderr output of a running or finished background task. " +
      "Use this instead of running 'tail' or 'cat' manually — it knows the log path automatically.",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: "Machine the task is running on",
        },
        pid: {
          type: "number",
          description: "PID of the background process",
        },
        lines: {
          type: "number",
          description: "Number of recent lines to show (default: 50)",
        },
      },
      required: ["machine_id", "pid"],
    },
    execute: async (args) => {
      const machineId = args.machine_id as string;
      const pid = args.pid as number;
      const lines = (args.lines as number) ?? 50;

      const proc = executor.getBackgroundProcess(machineId, pid);
      if (!proc) {
        return JSON.stringify({
          error: `No tracked background process with pid ${pid} on ${machineId}`,
        });
      }

      if (!proc.logPath) {
        return JSON.stringify({
          error: "No log path recorded for this process",
        });
      }

      const output = await pool.tailFile(machineId, proc.logPath, lines);
      const running = await executor.isRunning(machineId, pid);

      return JSON.stringify({
        pid,
        machine_id: machineId,
        log_path: proc.logPath,
        running,
        output,
      });
    },
  };
}
