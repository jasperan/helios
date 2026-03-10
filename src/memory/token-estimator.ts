/** Rough token estimation: ~4 chars per token (standard heuristic). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Per-model context window sizes. */
const MODEL_LIMITS: Record<string, number> = {
  // Claude (200k)
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  // OpenAI (~400k)
  "gpt-5.4": 400_000,
  "gpt-5.3-codex": 400_000,
  "gpt-5.3-codex-spark": 400_000,
  "gpt-5.2-codex": 400_000,
  "gpt-5.2": 400_000,
  "gpt-5.1-codex-max": 400_000,
  "gpt-5.1-codex": 400_000,
  "gpt-5.1": 400_000,
};

const DEFAULT_LIMIT = 200_000;

/** Get context budget (80% of model limit) in tokens. */
export function getContextBudget(model: string): number {
  const limit = MODEL_LIMITS[model] ?? DEFAULT_LIMIT;
  return Math.floor(limit * 0.8);
}

/** Checkpoint threshold — 85% of budget. */
export function getCheckpointThreshold(model: string): number {
  return Math.floor(getContextBudget(model) * 0.85);
}
