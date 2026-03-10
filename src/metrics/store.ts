import { getDb } from "../store/database.js";

export interface MetricPoint {
  metricName: string;
  value: number;
  step?: number;
  timestamp: number;
}

export class MetricStore {
  insert(
    taskId: string,
    machineId: string,
    point: MetricPoint,
  ): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO metrics (task_id, machine_id, metric_name, value, step, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      machineId,
      point.metricName,
      point.value,
      point.step ?? null,
      point.timestamp,
    );
  }

  insertBatch(
    taskId: string,
    machineId: string,
    points: MetricPoint[],
  ): void {
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO metrics (task_id, machine_id, metric_name, value, step, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const insertMany = db.transaction((pts: MetricPoint[]) => {
      for (const p of pts) {
        stmt.run(
          taskId,
          machineId,
          p.metricName,
          p.value,
          p.step ?? null,
          p.timestamp,
        );
      }
    });

    insertMany(points);
  }

  getLatest(
    taskId: string,
    metricName: string,
  ): MetricPoint | null {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT * FROM metrics
         WHERE task_id = ? AND metric_name = ?
         ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(taskId, metricName) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      metricName: row.metric_name as string,
      value: row.value as number,
      step: row.step as number | undefined,
      timestamp: row.timestamp as number,
    };
  }

  getSeries(
    taskId: string,
    metricName: string,
    limit = 200,
  ): MetricPoint[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM metrics
           WHERE task_id = ? AND metric_name = ?
           ORDER BY timestamp DESC
           LIMIT ?
         ) ORDER BY timestamp ASC`,
      )
      .all(taskId, metricName, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      metricName: row.metric_name as string,
      value: row.value as number,
      step: row.step as number | undefined,
      timestamp: row.timestamp as number,
    }));
  }

  getMetricNames(taskId: string): string[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT DISTINCT metric_name FROM metrics WHERE task_id = ?`,
      )
      .all(taskId) as { metric_name: string }[];
    return rows.map((r) => r.metric_name);
  }

  /** Get all distinct task IDs that have metrics */
  getTaskIds(): string[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT DISTINCT task_id FROM metrics")
      .all() as { task_id: string }[];
    return rows.map((r) => r.task_id);
  }

  /** Get all metric names across all tasks */
  getAllMetricNames(): string[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT DISTINCT metric_name FROM metrics")
      .all() as { metric_name: string }[];
    return rows.map((r) => r.metric_name);
  }

  /** Get series for a metric name across all tasks, merged by timestamp */
  getSeriesAcrossTasks(
    metricName: string,
    limit = 200,
  ): MetricPoint[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM metrics
           WHERE metric_name = ?
           ORDER BY timestamp DESC
           LIMIT ?
         ) ORDER BY timestamp ASC`,
      )
      .all(metricName, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      metricName: row.metric_name as string,
      value: row.value as number,
      step: row.step as number | undefined,
      timestamp: row.timestamp as number,
    }));
  }

  /** Get a summary of final metrics for a task (latest value of each metric) */
  getTaskSummary(taskId: string): Record<string, { latest: number; min: number; max: number; count: number }> {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT metric_name,
                (SELECT value FROM metrics m2 WHERE m2.task_id = m1.task_id AND m2.metric_name = m1.metric_name ORDER BY timestamp DESC LIMIT 1) as latest,
                MIN(value) as min_val,
                MAX(value) as max_val,
                COUNT(*) as cnt
         FROM metrics m1
         WHERE task_id = ?
         GROUP BY metric_name`,
      )
      .all(taskId) as Record<string, unknown>[];

    const summary: Record<string, { latest: number; min: number; max: number; count: number }> = {};
    for (const row of rows) {
      summary[row.metric_name as string] = {
        latest: row.latest as number,
        min: row.min_val as number,
        max: row.max_val as number,
        count: row.cnt as number,
      };
    }
    return summary;
  }

  /** Delete all metrics for a specific task */
  clearTask(taskId: string): number {
    const db = getDb();
    const result = db
      .prepare("DELETE FROM metrics WHERE task_id = ?")
      .run(taskId);
    return result.changes;
  }

  /** Delete all metrics */
  clear(): number {
    const db = getDb();
    const result = db.prepare("DELETE FROM metrics").run();
    return result.changes;
  }

  /** Clean up metrics older than retentionDays */
  cleanup(retentionDays: number): number {
    const db = getDb();
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const result = db
      .prepare("DELETE FROM metrics WHERE timestamp < ?")
      .run(cutoff);
    return result.changes;
  }
}
