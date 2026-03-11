import type { ToolDefinition } from "../providers/types.js";
import type { MetricStore } from "../metrics/store.js";
import { toolError } from "../ui/format.js";

export function createCompareRunsTool(
  metricStore: MetricStore,
): ToolDefinition {
  return {
    name: "compare_runs",
    description:
      "Compare metrics between two experiment runs side-by-side. " +
      "Shows the final value, min, max, and delta for each metric. " +
      "Use this to decide whether to keep or discard an experiment.",
    parameters: {
      type: "object",
      properties: {
        task_a: {
          type: "string",
          description:
            'Task ID of the baseline run (format: "machine_id:pid")',
        },
        task_b: {
          type: "string",
          description:
            'Task ID of the new run to compare (format: "machine_id:pid")',
        },
        metric_names: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of metric names to compare. If omitted, compares all shared metrics.",
        },
      },
      required: ["task_a", "task_b"],
    },
    execute: async (args) => {
      const taskA = args.task_a as string;
      const taskB = args.task_b as string;
      const filterNames = args.metric_names as string[] | undefined;

      const summaryA = metricStore.getTaskSummary(taskA);
      const summaryB = metricStore.getTaskSummary(taskB);

      if (Object.keys(summaryA).length === 0) {
        return toolError(`No metrics found for task ${taskA}`);
      }
      if (Object.keys(summaryB).length === 0) {
        return toolError(`No metrics found for task ${taskB}`);
      }

      // Get union of metric names, optionally filtered
      const allNames = new Set([
        ...Object.keys(summaryA),
        ...Object.keys(summaryB),
      ]);
      const names = filterNames
        ? filterNames.filter((n) => allNames.has(n))
        : Array.from(allNames);

      const comparisons = names.map((name) => {
        const a = summaryA[name];
        const b = summaryB[name];
        const delta =
          a && b ? b.latest - a.latest : null;
        const direction =
          delta === null
            ? "n/a"
            : delta < -0.0001
              ? "decreased"
              : delta > 0.0001
                ? "increased"
                : "unchanged";

        return {
          metric: name,
          baseline: a
            ? { latest: a.latest, min: a.min, max: a.max, samples: a.count }
            : null,
          experiment: b
            ? { latest: b.latest, min: b.min, max: b.max, samples: b.count }
            : null,
          delta,
          direction,
        };
      });

      return JSON.stringify({
        task_a: taskA,
        task_b: taskB,
        comparisons,
      });
    },
  };
}
