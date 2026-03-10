import type { MetricCondition } from "./types.js";
import type { ConnectionPool } from "../../remote/connection-pool.js";

export async function evaluateMetric(
  condition: MetricCondition,
  pool: ConnectionPool,
): Promise<boolean> {
  const value = await fetchMetricValue(condition, pool);
  if (value === null) return false;
  return compareValue(value, condition.comparator, condition.threshold);
}

async function fetchMetricValue(
  condition: MetricCondition,
  pool: ConnectionPool,
): Promise<number | null> {
  const { source, machineId, field } = condition;

  switch (source.type) {
    case "json_file": {
      const result = await pool.exec(
        machineId,
        `cat ${source.path} 2>/dev/null`,
      );
      if (result.exitCode !== 0) return null;
      try {
        const data = JSON.parse(result.stdout);
        return extractField(data, field);
      } catch {
        return null;
      }
    }

    case "csv_file": {
      // Read last line of CSV
      const result = await pool.exec(
        machineId,
        `tail -1 ${source.path} 2>/dev/null`,
      );
      if (result.exitCode !== 0 || !result.stdout.trim()) return null;

      // Read header
      const headerResult = await pool.exec(
        machineId,
        `head -1 ${source.path}`,
      );
      const headers = headerResult.stdout.trim().split(",");
      const values = result.stdout.trim().split(",");
      const idx = headers.indexOf(field);
      if (idx === -1) return null;
      return parseFloat(values[idx]);
    }

    case "command": {
      const result = await pool.exec(machineId, source.command);
      if (result.exitCode !== 0) return null;
      const num = parseFloat(result.stdout.trim());
      return isNaN(num) ? null : num;
    }

    case "tensorboard":
      // TensorBoard metrics are collected via the MetricCollector pipeline, not inline
      return null;
  }
}

function extractField(obj: unknown, path: string): number | null {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "number" ? current : null;
}

function compareValue(
  value: number,
  comparator: MetricCondition["comparator"],
  threshold: number,
): boolean {
  switch (comparator) {
    case "<":
      return value < threshold;
    case ">":
      return value > threshold;
    case "<=":
      return value <= threshold;
    case ">=":
      return value >= threshold;
    case "==":
      return value === threshold;
    case "!=":
      return value !== threshold;
  }
}
