import type { ToolDefinition } from "../providers/types.js";
import type { RemoteExecutor } from "../remote/executor.js";
import type { MetricCollector } from "../metrics/collector.js";
import { patternsFromNames, patternsFromRegexes } from "../metrics/parser.js";

export function createRemoteExecTool(
  executor: RemoteExecutor,
): ToolDefinition {
  return {
    name: "remote_exec",
    description:
      "Execute a short shell command. Returns stdout, stderr, and exit code. ONLY for quick one-shot commands (ls, cat, pip install, git clone, etc). NEVER use this for training, evaluation, or anything that runs longer than a few seconds — use remote_exec_background instead.",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: "ID of the remote machine to run the command on",
        },
        command: {
          type: "string",
          description: "Shell command to execute",
        },
        timeout_seconds: {
          type: "number",
          description: "Optional timeout in seconds",
        },
      },
      required: ["machine_id", "command"],
    },
    execute: async (args) => {
      const result = await executor.exec(
        args.machine_id as string,
        args.command as string,
        args.timeout_seconds
          ? (args.timeout_seconds as number) * 1000
          : undefined,
      );
      return JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
      });
    },
  };
}

export function createRemoteExecBackgroundTool(
  executor: RemoteExecutor,
  metricCollector?: MetricCollector,
): ToolDefinition {
  return {
    name: "remote_exec_background",
    description:
      "Launch a long-running process in the background. Returns PID and log path. Stdout is captured automatically — DO NOT redirect stdout yourself. To track metrics in the dashboard, provide metric_names (for key=value format) or metric_patterns (custom regexes).",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: "ID of the machine (use \"local\" for this machine)",
        },
        command: {
          type: "string",
          description: "Command to run in the background",
        },
        log_path: {
          type: "string",
          description: "Optional path for stdout/stderr log file",
        },
        metric_names: {
          type: "array",
          items: { type: "string" },
          description:
            "Metric names to parse from stdout in key=value or key: value format. Example: [\"loss\", \"acc\", \"lr\"]",
        },
        metric_patterns: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Map of metric name → regex string with one capture group for the numeric value. Example: {\"loss\": \"Loss:\\\\s*([\\\\d.e+-]+)\"}",
        },
      },
      required: ["machine_id", "command"],
    },
    execute: async (args) => {
      const metricNames = args.metric_names as string[] | undefined;
      const metricPatterns = args.metric_patterns as Record<string, string> | undefined;

      const proc = await executor.execBackground(
        args.machine_id as string,
        args.command as string,
        args.log_path as string | undefined,
        { metricNames, metricPatterns },
      );

      // Register collector source immediately so metrics are tracked from the start
      if (metricCollector && proc.logPath) {
        let patterns;
        if (metricPatterns) {
          patterns = patternsFromRegexes(metricPatterns);
        } else if (metricNames && metricNames.length > 0) {
          patterns = patternsFromNames(metricNames);
        }
        if (patterns) {
          metricCollector.addSource({
            taskId: `${proc.machineId}:${proc.pid}`,
            machineId: proc.machineId,
            logPath: proc.logPath,
            patterns,
          });
        }
      }

      return JSON.stringify({
        pid: proc.pid,
        log_path: proc.logPath,
        machine_id: proc.machineId,
      });
    },
  };
}
