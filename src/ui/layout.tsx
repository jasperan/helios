import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { EventEmitter } from "node:events";
import { useScreenSize } from "fullscreen-ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { ConversationPanel } from "./panels/conversation.js";
import { TaskListPanel } from "./panels/task-list.js";
import { MetricsDashboard, sparkline } from "./panels/metrics-dashboard.js";
import { StatusBar } from "./components/status-bar.js";
import { InputBar } from "./components/input-bar.js";
import { C, G, HRule } from "./theme.js";
import { KeyHintRule } from "./components/key-hint-rule.js";
import { TaskOverlay } from "./overlays/task-overlay.js";
import { MetricsOverlay } from "./overlays/metrics-overlay.js";
import { formatMetricValue, formatError } from "./format.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { SleepManager } from "../scheduler/sleep-manager.js";
import type { ConnectionPool } from "../remote/connection-pool.js";
import type { RemoteExecutor } from "../remote/executor.js";
import type { MetricStore } from "../metrics/store.js";
import type { MetricCollector } from "../metrics/collector.js";
import type { MonitorManager, MonitorConfig } from "../core/monitor.js";
import type { ReasoningEffort } from "../providers/types.js";
import type { MouseEvent } from "./mouse-filter.js";
import {
  loadMachines,
  addMachine as addMachineConfig,
  removeMachine as removeMachineConfig,
  parseMachineSpec,
} from "../remote/config.js";
import type { SessionSummary } from "../store/session-store.js";
import type { ExperimentTracker } from "../memory/experiment-tracker.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { StickyManager, StickyNote } from "../core/stickies.js";
import { StickyNotesPanel } from "./panels/sticky-notes.js";
import { ClaudeProvider } from "../providers/claude/provider.js";
import { savePreferences } from "../store/preferences.js";
import { VERSION, checkForUpdate } from "../version.js";

export interface ToolData {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface Message {
  id: number;
  role: "user" | "assistant" | "tool" | "error" | "system";
  content: string;
  tool?: ToolData;
}

export interface TaskInfo {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  machineId: string;
  pid?: number;
  startedAt: number;
}

interface LayoutProps {
  orchestrator: Orchestrator;
  sleepManager: SleepManager;
  connectionPool?: ConnectionPool;
  executor?: RemoteExecutor;
  metricStore?: MetricStore;
  metricCollector?: MetricCollector;
  monitorManager?: MonitorManager;
  experimentTracker?: ExperimentTracker;
  memoryStore?: MemoryStore;
  stickyManager?: StickyManager;
  mouseEmitter?: EventEmitter;
}

let messageIdCounter = 0;

export function Layout({ orchestrator, sleepManager, connectionPool, executor, metricStore, metricCollector, monitorManager, experimentTracker, memoryStore, stickyManager, mouseEmitter }: LayoutProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<ScrollViewRef>(null);

  const [userScrolled, setUserScrolled] = useState(false);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [metricData, setMetricData] = useState<Map<string, number[]>>(new Map());
  const [stickyNotes, setStickyNotes] = useState<StickyNote[]>([]);
  const [activeOverlay, setActiveOverlay] = useState<"none" | "tasks" | "metrics">("none");
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);

  // Check for updates on mount (non-blocking)
  useEffect(() => {
    checkForUpdate().then((v) => { if (v) setUpdateAvailable(v); }).catch(() => {});
  }, []);

  // Poll tasks and metrics every 5 seconds
  useEffect(() => {
    const poll = async () => {
      let didCollect = false;
      // Update task list from executor's background processes
      if (executor && connectionPool) {
        const procs = executor.getBackgroundProcesses();
        // Check all processes in parallel rather than sequentially
        const statuses = await Promise.all(
          procs.map(async (proc) => {
            try {
              const running = await executor.isRunning(proc.machineId, proc.pid);
              return { proc, running };
            } catch {
              return { proc, running: true }; // Transient error — assume still running
            }
          }),
        );

        const finished: string[] = [];
        const updated: TaskInfo[] = [];
        for (const { proc, running } of statuses) {
          const key = `${proc.machineId}:${proc.pid}`;
          const status: TaskInfo["status"] = running ? "running" : "completed";
          if (!running) finished.push(key);
          const shortCmd = proc.command.length > 40
            ? proc.command.slice(0, 40) + "..."
            : proc.command;
          updated.push({
            id: key,
            name: shortCmd,
            status,
            machineId: proc.machineId,
            pid: proc.pid,
            startedAt: proc.startedAt,
          });
        }
        // Collect metrics before removing finished processes (so final data is captured)
        if (finished.length > 0 && metricCollector) {
          await metricCollector.collectAll().catch(() => {});
          didCollect = true;
        }
        for (const key of finished) {
          const [machineId, pidStr] = key.split(":");
          const pid = parseInt(pidStr, 10);

          // Fetch actual exit code before cleanup
          let exitCode = 0;
          try {
            const result = await connectionPool.exec(machineId, `wait ${pid} 2>/dev/null; echo $?`);
            const parsed = parseInt(result.stdout.trim(), 10);
            if (!isNaN(parsed)) exitCode = parsed;
          } catch {
            // Can't determine exit code — default to 0
          }

          // Update experiment tracker with final metrics
          if (experimentTracker && metricStore) {
            const names = metricStore.getMetricNames(key);
            const metrics: Record<string, number> = {};
            for (const name of names) {
              const latest = metricStore.getLatest(key, name);
              if (latest) metrics[name] = latest.value;
            }
            experimentTracker.updateExperiment(machineId, pid, exitCode, Object.keys(metrics).length > 0 ? metrics : undefined);
          }

          // Clean up collector source so it stops tailing the dead process log
          metricCollector?.removeSource(key);
          executor.removeBackgroundProcess(key);
        }
        setTasks(updated);
      }

      // Collect metrics from all sources (skip if we already collected for finished tasks above)
      if (metricCollector && metricStore) {
        if (!didCollect) {
          await metricCollector.collectAll().catch(() => {});
        }
        // Build sparkline data from ALL known metrics (not just live processes)
        const newMetricData = new Map<string, number[]>();
        const allNames = metricStore.getAllMetricNames();
        for (const name of allNames) {
          const series = metricStore.getSeriesAcrossTasks(name, 50);
          if (series.length > 0) {
            newMetricData.set(name, series.map((p) => p.value));
          }
        }
        setMetricData(newMetricData);
      }
    };

    poll();
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  }, [executor, connectionPool, metricCollector, metricStore]);

  // Auto-scroll to bottom when messages change, overlay closes, or user hasn't scrolled up
  useEffect(() => {
    if (!userScrolled) {
      scrollRef.current?.scrollToBottom();
    }
  }, [messages, userScrolled, activeOverlay]);

  // Re-snap to bottom when streaming starts, and keep scrolling during streaming
  useEffect(() => {
    if (isStreaming) {
      setUserScrolled(false);
      // During streaming, content changes faster than React state updates trigger effects.
      // Poll scrollToBottom on a short interval to keep up.
      const timer = setInterval(() => {
        scrollRef.current?.scrollToBottom();
      }, 100);
      return () => clearInterval(timer);
    }
  }, [isStreaming]);

  // Clamped scroll helper — ink-scroll-view's scrollBy has a bug where
  // it clamps to contentHeight instead of contentHeight - viewportHeight,
  // allowing you to scroll past the bottom into empty space.
  const clampedScrollBy = useCallback((delta: number) => {
    const sv = scrollRef.current;
    if (!sv) return;
    const target = Math.max(0, Math.min(sv.getScrollOffset() + delta, sv.getBottomOffset()));
    sv.scrollTo(target);
    return target >= sv.getBottomOffset();
  }, []);

  // Enable SGR mouse reporting and handle scroll via mouseEmitter
  useEffect(() => {
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
    return () => { process.stdout.write("\x1b[?1006l\x1b[?1000l"); };
  }, []);

  useEffect(() => {
    if (!mouseEmitter) return;
    const handler = (evt: MouseEvent) => {
      if (evt.type === "scroll_up") {
        clampedScrollBy(-3);
        setUserScrolled(true);
      } else if (evt.type === "scroll_down") {
        const atBottom = clampedScrollBy(3);
        if (atBottom) setUserScrolled(false);
      }
    };
    mouseEmitter.on("mouse", handler);
    return () => { mouseEmitter.removeListener("mouse", handler); };
  }, [mouseEmitter, clampedScrollBy]);

  useInput((input, key) => {
    // Toggle overlays — always available
    if (key.ctrl && input === "t") {
      setActiveOverlay((prev) => prev === "tasks" ? "none" : "tasks");
      return;
    }
    if (key.ctrl && input === "g") {
      setActiveOverlay((prev) => prev === "metrics" ? "none" : "metrics");
      return;
    }

    // Esc: close overlay first, then interrupt stream
    if (key.escape) {
      if (activeOverlay !== "none") {
        setActiveOverlay("none");
        return;
      }
      if (isStreaming) {
        orchestrator.interrupt();
        setIsStreaming(false);
        return;
      }
    }

    if (key.ctrl && input === "c") {
      if (activeOverlay !== "none") {
        setActiveOverlay("none");
        return;
      }
      if (isStreaming) {
        orchestrator.interrupt();
        setIsStreaming(false);
      } else {
        exit();
      }
      return;
    }

    // Don't process scroll keys when overlay is active
    if (activeOverlay !== "none") return;

    if (key.pageUp) {
      clampedScrollBy(-10);
      setUserScrolled(true);
    }
    if (key.pageDown) {
      const atBottom = clampedScrollBy(10);
      if (atBottom) setUserScrolled(false);
    }
  });

  const addMessage = useCallback(
    (role: Message["role"], content: string, tool?: ToolData): number => {
      const id = ++messageIdCounter;
      setMessages((prev) => [...prev, { id, role, content, tool }]);
      return id;
    },
    [],
  );

  const updateMessage = useCallback((id: number, updates: Partial<Message>) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    );
  }, []);

  const handleSubmit = useCallback(
    async (input: string) => {
      if (!input.trim()) return;

      if (input.startsWith("/")) {
        if (input.startsWith("/writeup")) {
          await handleWriteup(orchestrator, messages, addMessage, updateMessage, setIsStreaming);
          return;
        }
        handleSlashCommand(input, {
          orchestrator, addMessage, setMessages, connectionPool,
          metricStore, metricCollector, memoryStore, stickyManager, setStickyNotes,
        });
        return;
      }

      if (sleepManager.isSleeping) {
        addMessage("user", input);
        addMessage("system", "Waking agent...");
        sleepManager.manualWake(input);
        return;
      }

      addMessage("user", input);
      setIsStreaming(true);

      try {
        let assistantText = "";
        let assistantMsgId: number | null = null;
        // Map tool callId -> message id for attaching results
        const toolMsgIds = new Map<string, number>();

        for await (const event of orchestrator.send(input)) {
          // Feed events to experiment tracker for auto-populating /experiments/
          experimentTracker?.onEvent(event);

          if (event.type === "text" && event.delta) {
            assistantText += event.delta;
            if (assistantMsgId === null) {
              assistantMsgId = addMessage("assistant", assistantText);
            } else {
              updateMessage(assistantMsgId, { content: assistantText });
            }
          }

          if (event.type === "tool_call") {
            const toolData: ToolData = {
              callId: event.id,
              name: event.name,
              args: event.args,
            };
            const msgId = addMessage("tool", "", toolData);
            toolMsgIds.set(event.id, msgId);
            assistantText = "";
            assistantMsgId = null;
          }

          if (event.type === "tool_result") {
            const msgId = toolMsgIds.get(event.callId);
            if (msgId !== undefined) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === msgId && m.tool
                    ? { ...m, tool: { ...m.tool, result: event.result, isError: event.isError } }
                    : m,
                ),
              );
            }
            if (event.isError) {
              addMessage("error", event.result);
            }
          }

          if (event.type === "error") {
            addMessage("error", event.error.message);
          }
        }
      } catch (err) {
        addMessage(
          "error",
          err instanceof Error ? err.message : "Unknown error",
        );
      } finally {
        setIsStreaming(false);
      }
    },
    [orchestrator, sleepManager, addMessage, updateMessage, setMessages, connectionPool, metricStore],
  );

  // Monitor: auto-invoke model on tick
  const isStreamingRef = useRef(false);
  isStreamingRef.current = isStreaming;

  // Use refs for tasks/metricData so the monitor effect doesn't re-subscribe every poll
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const metricDataRef = useRef(metricData);
  metricDataRef.current = metricData;
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  useEffect(() => {
    if (!monitorManager) return;

    const onTick = (config: MonitorConfig) => {
      if (isStreamingRef.current) return;

      const elapsed = Date.now() - config.startedAt;
      const elapsedMin = Math.round(elapsed / 60_000);

      const intervalMin = Math.round(config.intervalMs / 60_000);
      const parts: string[] = [
        `[Monitor check — ${elapsedMin}m elapsed, interval ${intervalMin}m]`,
        `Goal: ${config.goal}`,
      ];

      const currentTasks = tasksRef.current;
      if (currentTasks.length > 0) {
        parts.push("Tasks:");
        for (const t of currentTasks) {
          parts.push(`  ${t.status === "running" ? "◆" : "◇"} ${t.machineId}:${t.pid ?? "?"} ${t.status} — ${t.name}`);
        }
      }

      const currentMetrics = metricDataRef.current;
      if (currentMetrics.size > 0) {
        parts.push("Metrics:");
        for (const [name, values] of currentMetrics.entries()) {
          const latest = values[values.length - 1];
          parts.push(`  ${name}: ${latest}`);
        }
      }

      handleSubmitRef.current(parts.join("\n"));
    };

    monitorManager.on("tick", onTick);
    return () => {
      monitorManager.removeListener("tick", onTick);
    };
  }, [monitorManager]);

  // Sleep/wake: auto-resume model when a trigger fires
  const addMessageRef = useRef(addMessage);
  addMessageRef.current = addMessage;

  useEffect(() => {
    const onWake = (_session: unknown, _reason: string, wakeMessage: string) => {
      if (isStreamingRef.current) return;
      addMessageRef.current("system", "Agent waking up — trigger fired");
      handleSubmitRef.current(wakeMessage);
    };

    sleepManager.on("wake", onWake);
    return () => {
      sleepManager.removeListener("wake", onWake);
    };
  }, [sleepManager]);

  const isSleeping = sleepManager.isSleeping;

  const metricsRows = metricData.size > 0 ? metricData.size : 1;
  const tasksRows = tasks.length > 0 ? Math.min(tasks.length, 5) : 1;
  const panelHeight = Math.max(metricsRows, tasksRows);

  const { height, width } = useScreenSize();

  // ── Fullscreen overlays ───────────────────────────────────────
  if (activeOverlay === "tasks") {
    return (
      <Box flexDirection="column" height={height} width={width}>
        <TaskOverlay
          tasks={tasks}
          executor={executor}
          width={width}
          height={height}
          onClose={() => setActiveOverlay("none")}
        />
      </Box>
    );
  }

  if (activeOverlay === "metrics") {
    return (
      <Box flexDirection="column" height={height} width={width}>
        <MetricsOverlay
          metricData={metricData}
          metricStore={metricStore}
          width={width}
          height={height}
          onClose={() => setActiveOverlay("none")}
        />
      </Box>
    );
  }

  // ── Normal layout ─────────────────────────────────────────────
  return (
    <Box flexDirection="column" height={height} width={width}>
        <Box flexShrink={0}>
          <HeaderWithPanels width={width} />
        </Box>

        <Box flexShrink={0} flexDirection="row">
          <Box flexGrow={1} flexBasis={0} flexDirection="column" paddingX={1}>
            <MetricsDashboard metricData={metricData} width={Math.floor((width - 1) / 2) - 2} />
          </Box>
          <Box width={1} flexDirection="column" alignItems="center">
            <Text color={C.primary} wrap="truncate">
              {Array.from({ length: panelHeight }, () => "│").join("\n")}
            </Text>
          </Box>
          <Box flexGrow={1} flexBasis={0} flexDirection="column" paddingX={1}>
            <TaskListPanel tasks={tasks} width={Math.floor((width - 1) / 2) - 2} />
          </Box>
        </Box>

        <Box flexShrink={0}><HRule /></Box>

        {/* Chat area — ScrollView handles clipping and scrolling */}
        <Box flexGrow={1} flexShrink={1} flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>
            {messages.length === 0 ? (
              <Box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
                <Text color={C.primary} bold>{G.brand}</Text>
                <Text color={C.primary} bold>H E L I O S</Text>
                <Text color={C.dim}>autonomous ml research</Text>
                <Text color={C.dim} dimColor>v{VERSION}</Text>
                <Text color={C.dim} dimColor>{""}</Text>
                <Text color={C.dim} dimColor>/help for commands</Text>
                {updateAvailable && (
                  <Box marginTop={1}>
                    <Text color={C.bright}>update available: v{updateAvailable} — npm i -g helios</Text>
                  </Box>
                )}
              </Box>
            ) : (
              <ScrollView ref={scrollRef}>
                <ConversationPanel
                  messages={messages}
                  isStreaming={isStreaming}
                />
              </ScrollView>
            )}
          </Box>
          {stickyNotes.length > 0 && (
            <Box flexShrink={0}>
              <StickyNotesPanel notes={stickyNotes} width={Math.min(30, Math.floor(width * 0.25))} />
            </Box>
          )}
        </Box>

        <Box flexShrink={0}><KeyHintRule /></Box>
        <Box flexShrink={0}><StatusBar orchestrator={orchestrator} sleepManager={sleepManager} monitorManager={monitorManager} /></Box>
        <Box flexShrink={0}>
          <InputBar
            onSubmit={handleSubmit}
            disabled={isStreaming}
            placeholder={
              isSleeping
                ? "type to wake agent..."
                : "send a message... (/help for commands)"
            }
          />
        </Box>
    </Box>
  );
}

interface SlashCommandContext {
  orchestrator: Orchestrator;
  addMessage: (role: Message["role"], content: string) => number;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  connectionPool?: ConnectionPool;
  metricStore?: MetricStore;
  metricCollector?: MetricCollector;
  memoryStore?: MemoryStore;
  stickyManager?: StickyManager;
  setStickyNotes?: React.Dispatch<React.SetStateAction<StickyNote[]>>;
}

function handleSlashCommand(
  input: string,
  ctx: SlashCommandContext,
): void {
  const { orchestrator, addMessage, setMessages, connectionPool, metricStore, metricCollector, memoryStore, stickyManager, setStickyNotes } = ctx;
  const parts = input.slice(1).split(" ");
  const cmd = parts[0];
  const args = parts.slice(1);

  switch (cmd) {
    case "switch": {
      const provider = args[0] as "claude" | "openai" | undefined;
      if (provider !== "claude" && provider !== "openai") {
        addMessage("system", "Usage: /switch <claude|openai>");
        return;
      }
      addMessage("system", `Switching to ${provider}...`);
      orchestrator.switchProvider(provider).then(
        () => addMessage("system", `Switched to ${provider}`),
        (err) =>
          addMessage(
            "error",
            `Failed to switch: ${formatError(err)}`,
          ),
      );
      break;
    }

    case "model": {
      const modelId = args[0];
      if (!modelId) {
        addMessage("system", `Current model: ${orchestrator.currentModel ?? "default"}\nUsage: /model <model-id>`);
        return;
      }
      addMessage("system", `Setting model to ${modelId}...`);
      orchestrator.setModel(modelId).then(
        () => addMessage("system", `Model set to ${modelId}`),
        (err) =>
          addMessage(
            "error",
            `Failed to set model: ${formatError(err)}`,
          ),
      );
      break;
    }

    case "reasoning": {
      const level = args[0];
      const validLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
      if (!level || !validLevels.includes(level)) {
        const provider = orchestrator.currentProvider?.name;
        const hint = provider === "claude"
          ? "Claude: medium, high, max"
          : "OpenAI: none, minimal, low, medium, high, xhigh";
        addMessage("system", `Current reasoning effort: ${orchestrator.reasoningEffort ?? "medium"}\n${hint}\nUsage: /reasoning <level>`);
        return;
      }
      orchestrator.setReasoningEffort(level as ReasoningEffort).then(
        () => addMessage("system", `Reasoning effort set to ${level}`),
        (err) =>
          addMessage(
            "error",
            `Failed: ${formatError(err)}`,
          ),
      );
      break;
    }

    case "models": {
      addMessage("system", "Fetching available models...");
      orchestrator.fetchModels().then(
        (models) => {
          const current = orchestrator.currentModel;
          const lines = models.map((m) => {
            const marker = m.id === current ? " ◆" : "";
            const desc = m.description ? ` — ${m.description}` : "";
            return `  ${m.id}${marker}${desc}`;
          });
          addMessage("system", `Available models:\n${lines.join("\n")}`);
        },
        (err) =>
          addMessage(
            "error",
            `Failed to fetch models: ${formatError(err)}`,
          ),
      );
      break;
    }

    case "claude-mode": {
      const mode = args[0];
      if (mode !== "cli" && mode !== "api") {
        const current = (orchestrator.getProvider("claude") as ClaudeProvider | null)?.currentAuthMode;
        addMessage("system", `Current Claude mode: ${current === "cli" ? "cli (Agent SDK)" : "api (API key)"}\nUsage: /claude-mode <cli|api>`);
        break;
      }
      const claude = orchestrator.getProvider("claude") as ClaudeProvider | null;
      if (!claude) {
        addMessage("error", "Claude provider not registered");
        break;
      }
      claude.setPreferredAuthMode(mode);
      savePreferences({ claudeAuthMode: mode });
      // Re-authenticate to apply the new mode
      claude.authenticate().then(
        () => addMessage("system", `Claude mode set to ${mode === "cli" ? "cli (Agent SDK)" : "api (API key)"}`),
        (err) => addMessage("error", `Failed to switch Claude mode: ${formatError(err)}`),
      );
      break;
    }

    case "machine":
    case "machines": {
      handleMachineCommand(args, addMessage, connectionPool);
      break;
    }

    case "resume": {
      handleResumeCommand(args, orchestrator, addMessage, setMessages);
      break;
    }

    case "metric":
    case "metrics": {
      if (!metricStore) {
        addMessage("error", "Metric store not available");
        break;
      }

      if (args[0] === "clear") {
        const deleted = metricStore.clear();
        metricCollector?.reset();
        addMessage("system", `Cleared ${deleted} metric points.`);
      } else if (args.length === 0) {
        // /metric with no args — list all known metric names
        const allNames = metricStore.getAllMetricNames();
        if (allNames.length === 0) {
          addMessage("system", "No metrics recorded yet.");
        } else {
          addMessage("system", `Known metrics:\n  ${allNames.join("  ")}\n\nUsage: /metric <name1> [name2] ... | /metrics clear`);
        }
      } else {
        // /metric loss acc lr — show sparklines for named metrics
        const lines: string[] = [];
        for (const name of args) {
          const series = metricStore.getSeriesAcrossTasks(name, 50);
          if (series.length === 0) {
            lines.push(`  ${name}  (no data)`);
            continue;
          }
          const values = series.map((p) => p.value);
          const latest = values[values.length - 1];
          const min = Math.min(...values);
          const max = Math.max(...values);
          const spark = sparkline(values, 30);

          lines.push(`  ${name}  ${spark}  ${formatMetricValue(latest)}  (min ${formatMetricValue(min)} max ${formatMetricValue(max)})`);
        }
        addMessage("system", lines.join("\n"));
      }
      break;
    }

    case "help":
      addMessage(
        "system",
        [
          "Commands:",
          "  /switch <claude|openai>         Switch model provider",
          "  /claude-mode <cli|api>          Switch Claude auth (cli=Agent SDK, api=API key)",
          "  /model <model-id>               Set model",
          "  /models                          List available models",
          "  /reasoning <level>                Set reasoning effort",
          "  /resume                          List recent sessions",
          "  /resume <number>                 Resume a past session",
          "  /metric [name1 name2 ...]        Show metric sparklines",
          "  /metrics clear                   Clear all metrics",
          "  /writeup                         Generate experiment writeup",
          "  /machine add <id> <user@host>    Add remote machine",
          "  /machine rm <id>                 Remove machine",
          "  /machines                        List machines",
          "  /status                          Show current state",
          "  /clear                           Clear conversation",
          "  /quit                            Exit Helios",
          "",
          "Keys:",
          "  Tab        Autocomplete command",
          "  ↑↓         Navigate menu / history",
          "  ←→         Move cursor",
          "  Ctrl+T     Task output overlay",
          "  Ctrl+G     Metrics overlay",
          "  Escape     Interrupt / close overlay",
          "  Ctrl+A/E   Start / end of line",
          "  Ctrl+W     Delete word backward",
          "  Ctrl+U     Clear line",
          "  Ctrl+C     Interrupt / Exit",
        ].join("\n"),
      );
      break;

    case "status":
      addMessage(
        "system",
        [
          `Provider: ${orchestrator.currentProvider?.displayName ?? "None"}`,
          `Model: ${orchestrator.currentModel ?? "default"}`,
          `Reasoning: ${orchestrator.reasoningEffort ?? "medium"}`,
          `State: ${orchestrator.currentState}`,
          `Cost: $${orchestrator.totalCostUsd.toFixed(4)}`,
        ].join("\n"),
      );
      break;

    case "sticky": {
      if (!stickyManager || !setStickyNotes) {
        addMessage("system", "Sticky notes not available.");
        break;
      }
      const stickyText = args.join(" ").trim();
      if (!stickyText) {
        addMessage("system", "Usage: /sticky <text to pin>");
        break;
      }
      const note = stickyManager.add(stickyText);
      setStickyNotes(stickyManager.list());
      addMessage("system", `Pinned sticky #${note.num}: ${stickyText}`);
      break;
    }

    case "stickies": {
      if (!stickyManager || !setStickyNotes) {
        addMessage("system", "Sticky notes not available.");
        break;
      }
      if (args[0] === "rm" && args[1]) {
        const num = parseInt(args[1], 10);
        if (isNaN(num)) {
          addMessage("system", "Usage: /stickies rm <number>");
          break;
        }
        const removed = stickyManager.remove(num);
        setStickyNotes(stickyManager.list());
        addMessage("system", removed ? `Removed sticky #${num}` : `Sticky #${num} not found`);
      } else {
        const notes = stickyManager.list();
        if (notes.length === 0) {
          addMessage("system", "No sticky notes. Use /sticky <text> to add one.");
        } else {
          const listing = notes.map((n) => `  [${n.num}] ${n.text}`).join("\n");
          addMessage("system", `Sticky notes:\n${listing}`);
        }
      }
      break;
    }

    case "memory": {
      if (!memoryStore) {
        addMessage("system", "Memory system not initialized.");
        break;
      }
      const memPath = args[0] ?? "/";
      const tree = memoryStore.formatTree(memPath);
      addMessage("system", `Memory tree (${memPath}):\n${tree}`);
      break;
    }

    case "clear":
      setMessages([]);
      break;

    case "quit":
    case "exit":
      process.exit(0);

    default:
      addMessage("system", `Unknown command: /${cmd}. Try /help`);
  }
}

function handleMachineCommand(
  args: string[],
  addMessage: (role: Message["role"], content: string) => number,
  connectionPool?: ConnectionPool,
): void {
  const subCmd = args[0];

  if (!subCmd || subCmd === "list") {
    const machines = loadMachines();
    if (machines.length === 0) {
      addMessage("system", "No machines configured.\nUsage: /machine add <id> <user@host[:port]> [--key <path>]");
      return;
    }
    const lines = machines.map((m) => {
      const status = connectionPool?.getStatus(m.id);
      let statusText = status?.connected ? "◆ connected" : "◇ disconnected";
      if (!status?.connected && status?.error) {
        statusText += ` — ${status.error}`;
      }
      return `  ${m.id}  ${m.username}@${m.host}:${m.port}  [${m.authMethod}]  ${statusText}`;
    });
    addMessage("system", `Machines:\n${lines.join("\n")}`);
    return;
  }

  if (subCmd === "add") {
    const id = args[1];
    const spec = args[2];
    if (!id || !spec) {
      addMessage("system", "Usage: /machine add <id> <user@host[:port]> [--key <path>]");
      return;
    }

    const options: { key?: string; auth?: string } = {};
    for (let i = 3; i < args.length; i++) {
      if (args[i] === "--key" && args[i + 1]) {
        options.key = args[++i];
      } else if (args[i] === "--auth" && args[i + 1]) {
        options.auth = args[++i];
      }
    }

    try {
      const machine = parseMachineSpec(id, spec, options);
      addMachineConfig(machine);
      connectionPool?.addMachine(machine);
      addMessage("system", `Added machine "${id}" (${machine.username}@${machine.host}:${machine.port}). Connecting...`);
      connectionPool?.connect(id).then(
        () => addMessage("system", `Machine "${id}" connected ◆`),
        (err) => addMessage("error", `Machine "${id}" added but connection failed: ${formatError(err)}\nThe agent can still try to connect later.`),
      );
    } catch (err) {
      addMessage("error", `Failed to add machine: ${formatError(err)}`);
    }
    return;
  }

  if (subCmd === "rm" || subCmd === "remove") {
    const id = args[1];
    if (!id) {
      addMessage("system", "Usage: /machine rm <id>");
      return;
    }
    if (removeMachineConfig(id)) {
      connectionPool?.removeMachine(id);
      addMessage("system", `Removed machine "${id}"`);
    } else {
      addMessage("error", `Machine "${id}" not found`);
    }
    return;
  }

  addMessage("system", "Usage: /machine <add|rm|list>");
}

// Stash the last session listing so /resume <n> can look up by index
let lastSessionListing: SessionSummary[] = [];

function handleResumeCommand(
  args: string[],
  orchestrator: Orchestrator,
  addMessage: (role: Message["role"], content: string) => number,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): void {
  const index = args[0] ? Number.parseInt(args[0], 10) : NaN;

  // --- /resume  (no args) — list recent sessions ---
  if (Number.isNaN(index)) {
    const sessions = orchestrator.sessionStore.listSessionSummaries(20);
    if (sessions.length === 0) {
      addMessage("system", "No past sessions found.");
      return;
    }
    lastSessionListing = sessions;

    const lines = sessions.map((s, i) => {
      const date = new Date(s.lastActiveAt).toLocaleString();
      const provider = s.provider;
      const preview = s.firstUserMessage ?? "(no messages)";
      const msgs = `${s.messageCount} msg${s.messageCount !== 1 ? "s" : ""}`;
      return `  ${i + 1}. [${date}] ${provider} (${msgs})\n     ${preview}`;
    });

    addMessage(
      "system",
      `Recent sessions:\n${lines.join("\n")}\n\nUse /resume <number> to resume a session.`,
    );
    return;
  }

  // --- /resume <number> — resume by index ---
  if (index < 1 || index > lastSessionListing.length) {
    addMessage(
      "system",
      lastSessionListing.length === 0
        ? "Run /resume first to list sessions."
        : `Invalid index. Choose 1-${lastSessionListing.length}.`,
    );
    return;
  }

  const target = lastSessionListing[index - 1]!;
  addMessage("system", `Resuming session from ${new Date(target.lastActiveAt).toLocaleString()}...`);

  // Load stored messages and restore them into the UI
  const storedMessages = orchestrator.sessionStore.getMessages(target.id, 500);

  // Build Message[] from stored messages, resetting the id counter
  const restored: Message[] = storedMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      id: ++messageIdCounter,
      role: m.role as Message["role"],
      content: m.content,
    }));

  setMessages(restored);

  // Tell the orchestrator / provider to resume the session
  orchestrator.resumeSession(target.id).then(
    () => addMessage("system", `Session resumed (${target.provider}, ${storedMessages.length} messages loaded)`),
    (err) =>
      addMessage(
        "error",
        `Failed to resume session: ${formatError(err)}`,
      ),
  );
}

const WRITEUP_SYSTEM_PROMPT = `You are a scientific writing assistant. You will receive the full transcript of an ML experiment session — including the researcher's goals, the agent's actions, tool calls, metric results, and conclusions.

Your task: produce a clean, structured experiment writeup. Write it as a practitioner's report, not an academic paper. Be concise but thorough.

## Format

# [Title — infer from the goal]

## Objective
What was the researcher trying to achieve?

## Setup
- Model architecture, dataset, hardware
- Key hyperparameters and configuration

## Experiments
For each distinct experiment/run:
- What was tried and why
- Key metrics (include actual numbers)
- Whether it improved over the previous best

## Results
- Best configuration found
- Final metric values
- Comparison to baseline / starting point

## Observations
- What worked, what didn't
- Surprising findings
- Hypotheses about why certain changes helped/hurt

## Next Steps (if applicable)
- Promising directions not yet explored
- Known limitations

Keep the writing direct and data-driven. Use actual metric values from the transcript. Do not invent data.`;

async function handleWriteup(
  orchestrator: Orchestrator,
  messages: Message[],
  addMessage: (role: Message["role"], content: string) => number,
  updateMessage: (id: number, updates: Partial<Message>) => void,
  setIsStreaming: (v: boolean) => void,
): Promise<void> {
  if (messages.length === 0) {
    addMessage("system", "No conversation to write up.");
    return;
  }

  // Build a transcript from the conversation
  const transcript = messages
    .map((m) => {
      if (m.role === "user") return `[USER] ${m.content}`;
      if (m.role === "assistant") return `[ASSISTANT] ${m.content}`;
      if (m.role === "tool" && m.tool) {
        const result = m.tool.result ? `\nResult: ${m.tool.result}` : "";
        return `[TOOL: ${m.tool.name}] ${JSON.stringify(m.tool.args)}${result}`;
      }
      if (m.role === "system") return `[SYSTEM] ${m.content}`;
      if (m.role === "error") return `[ERROR] ${m.content}`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  addMessage("system", "Generating writeup...");
  setIsStreaming(true);

  try {
    // Get the active provider and create a one-shot session for the writeup
    const provider = orchestrator.currentProvider;
    if (!provider) {
      addMessage("error", "No active provider");
      return;
    }

    const writeupSession = await provider.createSession({
      systemPrompt: WRITEUP_SYSTEM_PROMPT,
    });

    try {
      let writeupText = "";
      let writeupMsgId: number | null = null;

      for await (const event of provider.send(
        writeupSession,
        `Here is the full experiment session transcript:\n\n${transcript}`,
        [], // no tools for writeup
      )) {
        if (event.type === "text" && event.delta) {
          writeupText += event.delta;
          if (writeupMsgId === null) {
            writeupMsgId = addMessage("assistant", writeupText);
          } else {
            updateMessage(writeupMsgId, { content: writeupText });
          }
        }
      }
    } finally {
      await provider.closeSession(writeupSession).catch(() => {});
    }
  } catch (err) {
    addMessage("error", `Writeup failed: ${formatError(err)}`);
  } finally {
    setIsStreaming(false);
  }
}

/** Single header line: logo on the left, panel labels right-aligned in each half. */
function HeaderWithPanels({ width }: { width: number }) {
  const logo = ` ▓▒░ ${G.brand} HELIOS ░▒▓ `;
  const ver = `${VERSION} `;
  const metricsLabel = ` ⣤⣸⣿ METRICS `;
  const tasksLabel = ` ⊳ TASKS `;

  const half = Math.floor(width / 2);
  const leftFill = Math.max(0, half - logo.length - ver.length - metricsLabel.length - 1);
  const rightFill = Math.max(0, width - half - tasksLabel.length - 1);

  return (
    <Box>
      <ShimmerLogo text={logo} />
      <Text color={C.dim}>{ver}</Text>
      <Text color={C.primary}>{G.rule.repeat(leftFill)}</Text>
      <Text color={C.primary}>{metricsLabel}</Text>
      <Text color={C.primary}>{G.rule}</Text>
      <Text color={C.primary}>{G.rule.repeat(rightFill)}</Text>
      <Text color={C.primary}>{tasksLabel}</Text>
      <Text color={C.primary}>{G.rule}</Text>
    </Box>
  );
}

const SHIMMER_INTERVAL = 80;
const SHIMMER_PAUSE = 20; // extra frames of pause after sweep

function ShimmerLogo({ text }: { text: string }) {
  const [frame, setFrame] = useState(0);
  const len = text.length;
  const cycleLen = len + 6 + SHIMMER_PAUSE; // 6 = shimmer tail width

  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % cycleLen), SHIMMER_INTERVAL);
    return () => clearInterval(timer);
  }, [cycleLen]);

  const shimmerPos = frame - 3; // center of the bright spot

  // Group consecutive chars by color into segments for fewer <Text> nodes
  const segments: Array<{ color: string; chars: string }> = [];
  for (let i = 0; i < len; i++) {
    const dist = Math.abs(i - shimmerPos);
    const color = dist <= 1 ? C.bright : C.primary;

    const prev = segments[segments.length - 1];
    if (prev && prev.color === color) {
      prev.chars += text[i];
    } else {
      segments.push({ color, chars: text[i] });
    }
  }

  return (
    <Text>
      {segments.map((seg, i) => (
        <Text key={i} color={seg.color} bold>{seg.chars}</Text>
      ))}
    </Text>
  );
}
