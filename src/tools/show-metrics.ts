import type { ToolDefinition } from "../providers/types.js";
import type { MetricStore } from "../metrics/store.js";
import { analyzeMetric } from "../metrics/analyzer.js";

export function createShowMetricsTool(
  store: MetricStore,
): ToolDefinition {
  return {
    name: "show_metrics",
    description:
      "Query and display metrics. Shows sparkline charts, current values, and trend analysis. Use this to check on training progress, report results to the user, or compare values. Omit metric_names to list all available metrics.",
    parameters: {
      type: "object",
      properties: {
        metric_names: {
          type: "array",
          items: { type: "string" },
          description:
            "Metric names to display. Omit to list all available metrics.",
        },
        task_id: {
          type: "string",
          description:
            "Optional: scope to a specific task (e.g. \"local:1234\"). Omit to query across all tasks.",
        },
        lines: {
          type: "number",
          description:
            "Number of data points to include (default: 50)",
        },
      },
    },
    execute: async (args) => {
      const metricNames = args.metric_names as string[] | undefined;
      const taskId = args.task_id as string | undefined;
      const limit = (args.lines as number) ?? 50;

      // No names specified — list what's available
      if (!metricNames || metricNames.length === 0) {
        const names = taskId
          ? store.getMetricNames(taskId)
          : store.getAllMetricNames();
        return JSON.stringify({ available_metrics: names });
      }

      const metrics: Array<{
        name: string;
        values: number[];
        latest: number | null;
        min: number | null;
        max: number | null;
        trend: string;
      }> = [];

      for (const name of metricNames) {
        const series = taskId
          ? store.getSeries(taskId, name, limit)
          : store.getSeriesAcrossTasks(name, limit);

        if (series.length === 0) {
          metrics.push({
            name,
            values: [],
            latest: null,
            min: null,
            max: null,
            trend: "no_data",
          });
          continue;
        }

        const values = series.map((p) => p.value);
        const latest = values[values.length - 1];
        const min = Math.min(...values);
        const max = Math.max(...values);

        const analysis = analyzeMetric(series);

        metrics.push({
          name,
          values,
          latest,
          min,
          max,
          trend: analysis.trend,
        });
      }

      return JSON.stringify({ metrics });
    },
  };
}
