import type { MetricPoint } from "./store.js";

/**
 * Parse metrics from log output using caller-supplied patterns.
 *
 * Two modes:
 * - metric_names: ["loss", "lr"] → auto-generates key=value regexes
 * - metric_patterns: { "loss": "Loss:\\s*([\\d.e+-]+)" } → custom regexes
 *
 * Each pattern must have exactly one capture group for the numeric value.
 */

export interface MetricPatterns {
  /** Map of metric name → regex string with one capture group for the value */
  patterns: Record<string, RegExp>;
}

/** Build MetricPatterns from a list of names (assumes key=value format) */
export function patternsFromNames(names: string[]): MetricPatterns {
  const patterns: Record<string, RegExp> = {};
  for (const name of names) {
    // Match name=value or name: value
    patterns[name] = new RegExp(
      `(?:^|\\s|,)${escapeRegex(name)}\\s*[=:]\\s*([+-]?\\d+\\.?\\d*(?:e[+-]?\\d+)?)`,
      "i",
    );
  }
  return { patterns };
}

/** Build MetricPatterns from a map of name → regex string */
export function patternsFromRegexes(
  regexMap: Record<string, string>,
): MetricPatterns {
  const patterns: Record<string, RegExp> = {};
  for (const [name, re] of Object.entries(regexMap)) {
    patterns[name] = new RegExp(re, "i");
  }
  return { patterns };
}

/** Parse log output using the given patterns */
export function parseWithPatterns(
  output: string,
  mp: MetricPatterns,
): MetricPoint[] {
  const points: MetricPoint[] = [];
  const now = Date.now();
  const lines = output.split("\n");

  for (const line of lines) {
    for (const [name, re] of Object.entries(mp.patterns)) {
      const match = re.exec(line);
      if (match && match[1]) {
        const value = parseFloat(match[1]);
        if (isFinite(value)) {
          points.push({
            metricName: name,
            value,
            timestamp: now,
          });
        }
      }
    }
  }

  return points;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
