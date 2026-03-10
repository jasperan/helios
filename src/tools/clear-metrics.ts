import type { ToolDefinition } from "../providers/types.js";
import type { MetricStore } from "../metrics/store.js";
import type { MetricCollector } from "../metrics/collector.js";

export function createClearMetricsTool(
  store: MetricStore,
  collector: MetricCollector,
): ToolDefinition {
  return {
    name: "clear_metrics",
    description:
      "Clear collected metrics. Use this when discarding a failed experiment run before starting a new one, so the dashboard and metric queries only show data from the new run.",
    parameters: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description:
            "Optional: clear metrics only for a specific task (e.g. \"local:1234\"). If omitted, clears all metrics.",
        },
      },
    },
    execute: async (args) => {
      const taskId = args.task_id as string | undefined;

      if (taskId) {
        const deleted = store.clearTask(taskId);
        collector.removeSource(taskId);
        return JSON.stringify({ cleared: deleted, task_id: taskId });
      }

      const deleted = store.clear();
      collector.reset();
      return JSON.stringify({ cleared: deleted, all: true });
    },
  };
}
