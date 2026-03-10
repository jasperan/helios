import type { ToolDefinition } from "../providers/types.js";
import type { MonitorManager } from "../core/monitor.js";

export function createStartMonitorTool(
  monitor: MonitorManager,
): ToolDefinition {
  return {
    name: "start_monitor",
    description: `Start a monitoring loop that periodically re-invokes you with a status update. Use this after launching a background task so you get called back to check on progress without needing to sleep/wake repeatedly.

When the monitor fires, you receive a message with:
- Elapsed time since monitoring started
- Current task statuses (running/completed/failed)
- Latest metric values
- Your original goal

You can then take actions (check output, adjust params, launch new runs) and your response ends. The monitor will call you again at the next interval.

Calling start_monitor again replaces the current monitor — use this to adjust the interval as conditions change. Match the interval to what you're waiting for: 1-2m for short runs, 5-10m for long ones. If nothing is changing, increase the interval to save context.

Call stop_monitor when the goal is complete or you no longer need periodic checks.

IMPORTANT: After calling start_monitor, you can continue doing other things in the same turn (unlike sleep). The monitor runs in the background.`,
    parameters: {
      type: "object",
      properties: {
        interval_minutes: {
          type: "number",
          description: "How often to check (in minutes). Default: 2",
        },
        goal: {
          type: "string",
          description:
            "What you are monitoring for. This is included in each status update to remind you of the objective.",
        },
      },
      required: ["goal"],
    },
    execute: async (args) => {
      const intervalMin = (args.interval_minutes as number) ?? 2;
      const goal = args.goal as string;
      const intervalMs = intervalMin * 60 * 1000;

      const config = monitor.start(intervalMs, goal);

      return JSON.stringify({
        status: "monitoring",
        interval_minutes: intervalMin,
        goal,
        started_at: new Date(config.startedAt).toISOString(),
      });
    },
  };
}

export function createStopMonitorTool(
  monitor: MonitorManager,
): ToolDefinition {
  return {
    name: "stop_monitor",
    description:
      "Stop the active monitoring loop. Call this when the objective is complete or you no longer need periodic check-ins.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      if (!monitor.isActive) {
        return JSON.stringify({ status: "no_active_monitor" });
      }
      monitor.stop();
      return JSON.stringify({ status: "stopped" });
    },
  };
}
