/** Canonical comparator type used by metric and resource conditions. */
export type Comparator = "<" | ">" | "<=" | ">=" | "==" | "!=";

// --- Trigger Conditions ---

export interface TimerCondition {
  kind: "timer";
  wakeAt: number; // Unix timestamp ms
}

export interface ProcessExitCondition {
  kind: "process_exit";
  machineId: string;
  pid?: number;
  processPattern?: string;
  expectedExitCode?: number;
}

export interface FileCondition {
  kind: "file";
  machineId: string;
  path: string;
  mode: "exists" | "modified" | "size_stable";
  baselineMtime?: number;
  stabilityWindowSec?: number;
}

export interface MetricCondition {
  kind: "metric";
  machineId: string;
  source: MetricSource;
  field: string;
  comparator: Comparator;
  threshold: number;
  /** Require condition to hold for N consecutive checks */
  sustainedChecks?: number;
}

export type MetricSource =
  | { type: "json_file"; path: string }
  | { type: "csv_file"; path: string }
  | { type: "command"; command: string }
  | { type: "tensorboard"; logdir: string };

export interface ResourceCondition {
  kind: "resource";
  machineId: string;
  resource: "gpu_util" | "gpu_memory" | "cpu" | "memory" | "disk";
  gpuIndex?: number;
  comparator: Extract<Comparator, "<" | ">" | "<=" | ">=">;

  threshold: number;
  sustainedChecks?: number;
}

export interface UserMessageCondition {
  kind: "user_message";
}

export type TriggerCondition =
  | TimerCondition
  | ProcessExitCondition
  | FileCondition
  | MetricCondition
  | ResourceCondition
  | UserMessageCondition;

// --- Composite Logic ---

export interface CompositeTrigger {
  op: "and" | "or";
  children: TriggerExpression[];
}

export type TriggerExpression = TriggerCondition | CompositeTrigger;

// --- Trigger Lifecycle ---

export type TriggerStatus =
  | "pending"
  | "active"
  | "satisfied"
  | "expired"
  | "cancelled"
  | "error";

export interface Trigger {
  id: string;
  status: TriggerStatus;
  expression: TriggerExpression;
  createdAt: number;
  /** Hard deadline — expire if not satisfied by this time */
  deadline?: number;
  /** Override default poll interval */
  pollIntervalMs?: number;
  sleepReason: string;
  /** ID linking to the serialized agent context */
  contextSnapshotId: string;
  lastEvaluatedAt?: number;
  lastError?: string;
  satisfiedAt?: number;
  /** Paths of satisfied leaf conditions (for partial AND tracking) */
  satisfiedLeaves: Set<string>;
}

// --- Sleep Session ---

export interface SleepSession {
  id: string;
  trigger: Trigger;
  agentState: {
    sessionId: string;
    providerName: "claude" | "openai" | "vllm";
    providerSessionId?: string;
    pendingGoal: string;
    activeMachines: string[];
  };
  createdAt: number;
  wokeAt?: number;
  wakeReason?:
    | "trigger_satisfied"
    | "user_interrupt"
    | "deadline"
    | "error";
}

// --- Default Polling Intervals ---

export const DEFAULT_POLL_INTERVALS: Record<TriggerCondition["kind"], number> =
  {
    timer: 1000,
    process_exit: 15_000,
    file: 10_000,
    metric: 30_000,
    resource: 10_000,
    user_message: 0, // event-driven
  };
