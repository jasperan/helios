export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

export interface SubagentLogEntry {
  timestamp: number;
  type: "tool_call" | "tool_result" | "text";
  summary: string;
}

export interface SubagentInfo {
  id: string;
  parentSessionId: string;
  depth: number;
  task: string;
  model: string;
  provider: "claude" | "openai" | "vllm";
  status: SubagentStatus;
  createdAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  memoryPrefix: string;
  abortController: AbortController;
  /** Current turn number (0-indexed). */
  turn: number;
  /** Last tool call name (sign of life). */
  lastToolCall?: string;
  /** Rolling log of recent activity (capped). */
  log: SubagentLogEntry[];
}

export interface SubagentSpawnConfig {
  task: string;
  model?: string;
  provider?: "claude" | "openai" | "vllm";
  tools_deny?: string[];
  max_turns?: number;
}
