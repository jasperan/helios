import type { MetricPoint } from "./store.js";

export interface AnalysisResult {
  trend: "decreasing" | "plateau" | "increasing" | "unstable" | "insufficient_data";
  slope: number;
  currentValue: number;
  meanValue: number;
  stdDev: number;
  hasNaN: boolean;
  hasInf: boolean;
}

/**
 * Analyze a metric time series for trends.
 */
export function analyzeMetric(
  points: MetricPoint[],
  windowSize = 20,
): AnalysisResult {
  if (points.length < 3) {
    return {
      trend: "insufficient_data",
      slope: 0,
      currentValue: points.length > 0 ? points[points.length - 1].value : 0,
      meanValue: 0,
      stdDev: 0,
      hasNaN: false,
      hasInf: false,
    };
  }

  const values = points.slice(-windowSize).map((p) => p.value);
  const hasNaN = values.some(isNaN);
  const hasInf = values.some((v) => !isFinite(v));

  const validValues = values.filter((v) => isFinite(v) && !isNaN(v));
  if (validValues.length < 3) {
    return {
      trend: "unstable",
      slope: 0,
      currentValue: values[values.length - 1],
      meanValue: 0,
      stdDev: 0,
      hasNaN,
      hasInf,
    };
  }

  const mean = validValues.reduce((a, b) => a + b, 0) / validValues.length;
  const variance =
    validValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) /
    validValues.length;
  const stdDev = Math.sqrt(variance);
  const slope = linearRegressionSlope(validValues);
  const currentValue = validValues[validValues.length - 1];

  // Determine trend
  const slopeThreshold = stdDev * 0.1 || 1e-6;
  let trend: AnalysisResult["trend"];

  if (Math.abs(slope) < slopeThreshold) {
    trend = "plateau";
  } else if (slope < 0) {
    trend = "decreasing";
  } else {
    trend = "increasing";
  }

  return { trend, slope, currentValue, meanValue: mean, stdDev, hasNaN, hasInf };
}

/**
 * Simple linear regression slope.
 * x = [0, 1, 2, ...], y = values
 */
function linearRegressionSlope(values: number[]): number {
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (values[i] - yMean);
    denominator += (i - xMean) ** 2;
  }

  return denominator === 0 ? 0 : numerator / denominator;
}
