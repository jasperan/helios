import type { SubagentInfo, SubagentSpawnConfig, SubagentLogEntry } from "./types.js";
import type { ToolDefinition, ModelProvider } from "../providers/types.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { SubagentManager } from "./manager.js";
import { ScopedMemoryStore } from "./scoped-memory.js";
import { createMemoryTools } from "../tools/memory-tools.js";
import { formatError, truncate } from "../ui/format.js";
import { debugLog } from "../paths.js";

const MAX_LOG_ENTRIES = 50;

function appendLog(info: SubagentInfo, type: SubagentLogEntry["type"], summary: string): void {
  info.log.push({ timestamp: Date.now(), type, summary });
  if (info.log.length > MAX_LOG_ENTRIES) {
    info.log = info.log.slice(-MAX_LOG_ENTRIES);
  }
}

/** Tools that subagents should never have access to. */
const ALWAYS_DENY = new Set(["sleep", "start_monitor", "stop_monitor"]);

export interface SubagentExecContext {
  orchestrator: Orchestrator;
  allTools: ToolDefinition[];
  parentMemory: MemoryStore;
  parentSessionId: string;
  depth: number;
  subagentManager: SubagentManager;
}

/** Infer provider from model name. */
export function resolveProviderForModel(
  model: string | undefined,
  provider: string | undefined,
  orchestrator: Orchestrator,
): { provider: "claude" | "openai" | "vllm"; model: string } {
  if (provider === "claude" || provider === "openai" || provider === "vllm") {
    const defaults: Record<string, string> = {
      claude: "claude-sonnet-4-6",
      openai: "gpt-5.4",
      vllm: "qwen3.5:9b",
    };
    return {
      provider,
      model: model ?? defaults[provider],
    };
  }
  if (model) {
    if (model.startsWith("claude")) return { provider: "claude", model };
    if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) {
      return { provider: "openai", model };
    }
    // Models that don't match claude/openai patterns are likely open weights on vLLM
    if (model.startsWith("qwen") || model.startsWith("llama") || model.startsWith("mistral") || model.startsWith("deepseek")) {
      return { provider: "vllm", model };
    }
  }
  // Inherit parent
  return {
    provider: (orchestrator.currentProvider?.name as "claude" | "openai" | "vllm") ?? "claude",
    model: model ?? orchestrator.currentModel ?? "claude-sonnet-4-6",
  };
}

/** Build the filtered tool set for a subagent. */
/** Dynamically add subagent tools if depth allows (avoids circular require). */
export async function addSubagentTools(
  tools: ToolDefinition[],
  depth: number,
  maxDepth: number,
  subagentManager: SubagentManager,
  orchestrator: Orchestrator,
  parentMemory: MemoryStore,
): Promise<void> {
  if (maxDepth === 0 || depth + 1 < maxDepth) {
    const { createSubagentTools } = await import("../tools/subagent.js");
    tools.push(...createSubagentTools(subagentManager, orchestrator, parentMemory));
  }
}

function buildTools(
  allTools: ToolDefinition[],
  config: SubagentSpawnConfig,
  scopedMemory: ScopedMemoryStore,
  depth: number,
  maxDepth: number,
  subagentManager: SubagentManager,
  orchestrator: Orchestrator,
  parentMemory: MemoryStore,
): ToolDefinition[] {
  let tools = allTools.filter((t) => !ALWAYS_DENY.has(t.name));

  // Apply user deny list
  if (config.tools_deny) {
    const denied = new Set(config.tools_deny);
    tools = tools.filter((t) => !denied.has(t.name));
  }

  // Replace memory tools with scoped versions
  tools = tools.filter((t) => !t.name.startsWith("memory_"));
  tools.push(...createMemoryTools(scopedMemory));

  // Replace subagent tools — include if depth allows (added dynamically via addSubagentTools)
  tools = tools.filter((t) => !t.name.startsWith("subagent"));

  return tools;
}

function buildSystemPrompt(info: SubagentInfo, config: SubagentSpawnConfig): string {
  return `You are a Helios subagent (ID: ${info.id}, depth: ${info.depth}).

## Your Task
${config.task}

## Memory
Your memory is scoped — writes go to /subagents/${info.id}/ in the parent's memory tree.
You can read the parent's memory for context (goal, observations, experiments, etc.).
When done, write a clear result summary to memory.

## Completion
When your task is complete, state your conclusion clearly in your final message.
Be thorough but concise — the parent agent will read your result.`;
}

/** Run a subagent in the background. Mutates `info` with status/result/cost. */
export async function runSubagent(
  info: SubagentInfo,
  config: SubagentSpawnConfig,
  ctx: SubagentExecContext,
): Promise<void> {
  const providerInstance = ctx.orchestrator.getProvider(info.provider) as ModelProvider | null;
  if (!providerInstance) throw new Error(`Provider "${info.provider}" not available`);

  // Ensure authenticated
  if (!(await providerInstance.isAuthenticated())) {
    await providerInstance.authenticate();
  }

  // Temporarily set model for session creation
  const originalModel = providerInstance.currentModel;
  providerInstance.currentModel = info.model;

  const session = await providerInstance.createSession({
    systemPrompt: buildSystemPrompt(info, config),
    model: info.model,
    ephemeral: true,
  });

  // Restore model immediately — session already captured it
  providerInstance.currentModel = originalModel;

  const scopedMemory = new ScopedMemoryStore(ctx.parentMemory, info.id);
  const tools = buildTools(
    ctx.allTools,
    config,
    scopedMemory,
    ctx.depth,
    ctx.subagentManager.maxDepth,
    ctx.subagentManager,
    ctx.orchestrator,
    ctx.parentMemory,
  );

  // Dynamically add subagent tools if depth allows (async import avoids circular dep)
  await addSubagentTools(
    tools,
    ctx.depth,
    ctx.subagentManager.maxDepth,
    ctx.subagentManager,
    ctx.orchestrator,
    ctx.parentMemory,
  );

  const maxTurns = config.max_turns ?? 50;
  let lastText = "";

  try {
    // The provider's send() handles the full tool loop internally.
    // We just drain events and track cost.
    for (let turn = 0; turn < maxTurns; turn++) {
      if (info.abortController.signal.aborted) break;
      info.turn = turn;

      let turnText = "";
      let hadToolCalls = false;

      const message = turn === 0 ? config.task : "Continue.";

      for await (const event of providerInstance.send(session, message, tools)) {
        if (info.abortController.signal.aborted) break;

        if (event.type === "text" && event.delta) {
          turnText += event.delta;
        }
        if (event.type === "tool_call") {
          hadToolCalls = true;
          info.lastToolCall = event.name;
          appendLog(info, "tool_call", `${event.name}(${truncate(JSON.stringify(event.args), 80, true)})`);
        }
        if (event.type === "tool_result") {
          const prefix = event.isError ? "ERROR: " : "";
          appendLog(info, "tool_result", `${prefix}${truncate(event.result, 120, true)}`);
        }
        if (event.type === "done" && event.usage) {
          const cost = event.usage.costUsd ?? 0;
          info.costUsd += cost;
          info.inputTokens += event.usage.inputTokens;
          info.outputTokens += event.usage.outputTokens;
          ctx.orchestrator.addCost(cost, event.usage.inputTokens, event.usage.outputTokens);
        }
      }

      if (turnText) {
        lastText = turnText;
        appendLog(info, "text", truncate(turnText, 120, true));
      }

      // If the provider didn't make any tool calls, the agent is done
      if (!hadToolCalls) break;
    }

    const result = lastText || "(subagent produced no text output)";
    info.result = result;
    scopedMemory.write("/result", `Subagent ${info.id} result`, result);
    info.status = "completed";
    info.completedAt = Date.now();
    debugLog("subagent", "completed", { id: info.id, cost: info.costUsd });
  } catch (err) {
    info.error = formatError(err);
    info.status = info.abortController.signal.aborted ? "cancelled" : "failed";
    info.completedAt = Date.now();
    scopedMemory.write("/result", `Subagent ${info.id} failed`, `Error: ${info.error}`);
    debugLog("subagent", "failed", { id: info.id, error: info.error });
  } finally {
    await providerInstance.closeSession(session).catch(() => {});
  }
}
