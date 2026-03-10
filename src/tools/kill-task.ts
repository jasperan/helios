import type { ToolDefinition } from "../providers/types.js";
import type { RemoteExecutor } from "../remote/executor.js";
import type { ConnectionPool } from "../remote/connection-pool.js";
import type { MetricCollector } from "../metrics/collector.js";

export function createKillTaskTool(
  executor: RemoteExecutor,
  pool: ConnectionPool,
  metricCollector?: MetricCollector,
): ToolDefinition {
  return {
    name: "kill_task",
    description:
      "Kill a running background process. Use this to abort diverging training, stuck processes, or experiments you want to discard.",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: 'Machine the process is running on (e.g. "local")',
        },
        pid: {
          type: "number",
          description: "PID of the process to kill",
        },
        signal: {
          type: "string",
          description: "Signal to send (default: TERM). Use KILL for unresponsive processes.",
        },
      },
      required: ["machine_id", "pid"],
    },
    execute: async (args) => {
      const machineId = args.machine_id as string;
      const pid = args.pid as number;
      const signal = (args.signal as string) ?? "TERM";

      const taskKey = `${machineId}:${pid}`;

      const running = await executor.isRunning(machineId, pid);
      if (!running) {
        // Final metric collection before cleanup
        if (metricCollector) {
          await metricCollector.collectAll().catch(() => {});
          metricCollector.removeSource(taskKey);
        }
        executor.removeBackgroundProcess(taskKey);
        return JSON.stringify({ status: "already_exited", pid });
      }

      const result = await pool.exec(machineId, `kill -${signal} ${pid}`);

      if (result.exitCode !== 0) {
        return JSON.stringify({
          error: result.stderr.trim() || `kill failed with exit code ${result.exitCode}`,
        });
      }

      // Brief wait for the process to flush output, then final collection
      await new Promise((r) => setTimeout(r, 500));
      if (metricCollector) {
        await metricCollector.collectAll().catch(() => {});
        metricCollector.removeSource(taskKey);
      }

      executor.removeBackgroundProcess(taskKey);
      return JSON.stringify({ status: "killed", pid, signal });
    },
  };
}
