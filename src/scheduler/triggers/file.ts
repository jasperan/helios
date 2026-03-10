import type { FileCondition } from "./types.js";
import type { ConnectionPool } from "../../remote/connection-pool.js";

// Track file sizes for stability detection
const fileSizeHistory = new Map<string, { size: number; since: number }>();

export async function evaluateFile(
  condition: FileCondition,
  pool: ConnectionPool,
): Promise<boolean> {
  switch (condition.mode) {
    case "exists": {
      const result = await pool.exec(
        condition.machineId,
        `test -e ${condition.path} && echo "exists" || echo "missing"`,
      );
      return result.stdout.trim() === "exists";
    }

    case "modified": {
      const result = await pool.exec(
        condition.machineId,
        `stat -c %Y ${condition.path} 2>/dev/null || stat -f %m ${condition.path} 2>/dev/null`,
      );
      if (result.exitCode !== 0) return false;
      const mtime = parseInt(result.stdout.trim(), 10);
      if (isNaN(mtime)) return false;
      // First evaluation: capture baseline, return false
      if (condition.baselineMtime === undefined) {
        condition.baselineMtime = mtime;
        return false;
      }
      return mtime > condition.baselineMtime;
    }

    case "size_stable": {
      const result = await pool.exec(
        condition.machineId,
        `stat -c %s ${condition.path} 2>/dev/null || stat -f %z ${condition.path} 2>/dev/null`,
      );
      if (result.exitCode !== 0) return false;
      const size = parseInt(result.stdout.trim(), 10);
      const key = `${condition.machineId}:${condition.path}`;
      const prev = fileSizeHistory.get(key);

      if (!prev || prev.size !== size) {
        fileSizeHistory.set(key, { size, since: Date.now() });
        return false;
      }

      const stableFor = (Date.now() - prev.since) / 1000;
      return stableFor >= (condition.stabilityWindowSec ?? 60);
    }
  }
}
