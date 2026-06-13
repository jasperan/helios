/**
 * Shared runtime initialization for both TUI and ACP modes.
 * Extracted from app.tsx to avoid duplication.
 */

import { AuthManager } from "./providers/auth/auth-manager.js";
import { OpenAIOAuth } from "./providers/openai/oauth.js";
import { ClaudeProvider } from "./providers/claude/provider.js";
import { OpenAIProvider } from "./providers/openai/provider.js";
import { VLLMProvider } from "./providers/vllm/provider.js";
import { ConnectionPool } from "./remote/connection-pool.js";
import { RemoteExecutor } from "./remote/executor.js";
import { FileSync } from "./remote/file-sync.js";
import { MetricStore } from "./metrics/store.js";
import { MetricCollector } from "./metrics/collector.js";
import type { MemoryStore } from "./memory/memory-store.js";
import { GlobalMemoryRouter } from "./memory/global-memory.js";
import { ContextGate } from "./memory/context-gate.js";
import { ExperimentTracker } from "./memory/experiment-tracker.js";
import { StickyManager } from "./core/stickies.js";
import { Orchestrator } from "./core/orchestrator.js";
import { TriggerScheduler } from "./scheduler/trigger-scheduler.js";
import { SleepManager } from "./scheduler/sleep-manager.js";
import { MonitorManager } from "./core/monitor.js";
import { loadHubConfig } from "./hub/config.js";
import { HubClient } from "./hub/client.js";
import { formatError, toolError } from "./ui/format.js";
import { getAgentId, WEB_SEARCH_TOOL, debugLog, isDebug } from "./paths.js";
import { loadMachines } from "./remote/config.js";
import { loadPreferences, savePreferences } from "./store/preferences.js";
import { SessionStore } from "./store/session-store.js";
import {
  createRemoteExecTool,
  createRemoteExecBackgroundTool,
} from "./tools/remote-exec.js";
import {
  createUploadTool,
  createDownloadTool,
} from "./tools/remote-sync.js";
import { createSleepTool } from "./tools/sleep.js";
import { createListMachinesTool } from "./tools/list-machines.js";
import { createTaskOutputTool } from "./tools/task-output.js";
import { createCompareRunsTool } from "./tools/compare-runs.js";
import { createShowMetricsTool } from "./tools/show-metrics.js";
import { createClearMetricsTool } from "./tools/clear-metrics.js";
import { createKillTaskTool } from "./tools/kill-task.js";
import { createReadFileTool, createWriteFileTool, createPatchFileTool } from "./tools/file-ops.js";
import { createWebFetchTool } from "./tools/web-fetch.js";
import { createStartMonitorTool, createStopMonitorTool } from "./tools/monitor.js";
import { createConsultTool } from "./tools/consult.js";
import { createWriteupTool } from "./tools/writeup.js";
import { createHubTools } from "./tools/hub.js";
import { createMemoryTools } from "./tools/memory-tools.js";
import { SkillRegistry } from "./skills/registry.js";
import { seedBundledSkills } from "./skills/loader.js";
import { createExperimentBranchTools } from "./tools/experiment-branch.js";
import { createEnvSnapshotTool } from "./tools/env-snapshot.js";
import { createSweepTool } from "./tools/sweep.js";
import { SubagentManager } from "./subagent/manager.js";
import { createSubagentTools } from "./tools/subagent.js";
import { findProjectConfig } from "./config/project.js";
import { ResourceCollector } from "./metrics/resources.js";
import { Notifier, type NotificationEvent } from "./notifications/index.js";
import { ExperimentBrancher } from "./experiments/branching.js";
import { SYSTEM_PROMPT, HUB_PROMPT_ADDENDUM } from "./prompts.js";
import { isReasoningEffort, type ProviderName } from "./providers/types.js";

export interface HeliosRuntime {
  orchestrator: Orchestrator;
  sleepManager: SleepManager;
  connectionPool: ConnectionPool;
  executor: RemoteExecutor;
  metricStore: MetricStore;
  metricCollector: MetricCollector;
  monitorManager: MonitorManager;
  experimentTracker: ExperimentTracker;
  memoryStore: MemoryStore;
  stickyManager: StickyManager;
  resourceCollector: ResourceCollector;
  notifier: Notifier | null;
  experimentBrancher: ExperimentBrancher;
  subagentManager: SubagentManager;
  skillRegistry: SkillRegistry;
  openaiOAuth: OpenAIOAuth;
  projectConfig: ReturnType<typeof findProjectConfig>;
  agentName?: string;
  cleanup: () => void;
}

export interface RuntimeOptions {
  provider?: ProviderName;
  claudeMode?: "cli" | "api";
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<HeliosRuntime> {
  // Project config (helios.json in cwd or parent dirs)
  const projectConfig = findProjectConfig();

  const prefs = loadPreferences();

  // Migrate legacy global model/reasoning to per-provider prefs
  if ((prefs.model || prefs.reasoningEffort) && !prefs.claude?.model && !prefs.openai?.model) {
    const target = prefs.lastProvider ?? "claude";
    const migrated = { model: prefs.model, reasoningEffort: prefs.reasoningEffort };
    prefs[target] = { ...prefs[target], ...migrated };
    delete prefs.model;
    delete prefs.reasoningEffort;
    savePreferences(prefs);
  }

  const initialProvider = options.provider ?? projectConfig?.provider ?? prefs.lastProvider ?? "claude";
  const initialClaudeMode = options.claudeMode ?? prefs.claudeAuthMode;
  const agentId = getAgentId();

  if (isDebug()) {
    debugLog("init", "starting runtime", { provider: initialProvider, claudeMode: initialClaudeMode, agentId: agentId || undefined, projectConfig: projectConfig ? "found" : "none" });
  }

  // Auth
  const authManager = new AuthManager();
  const openaiOAuth = new OpenAIOAuth(authManager);
  authManager.registerRefreshHandler("openai", (rt) => openaiOAuth.refresh(rt));

  // Shared session store (single instance for orchestrator + both providers)
  const sessionStore = new SessionStore(agentId);

  // Providers
  const claudeProvider = new ClaudeProvider(authManager, initialClaudeMode, sessionStore);
  const openaiProvider = new OpenAIProvider(authManager, sessionStore);
  const vllmProvider = new VLLMProvider(sessionStore);

  // Remote
  const connPool = new ConnectionPool();
  const machines = loadMachines();
  for (const machine of machines) {
    connPool.addMachine(machine);
    connPool.connect(machine.id).catch((err) => {
      process.stderr.write(`[helios] Failed to connect to ${machine.id}: ${formatError(err)}\n`);
    });
  }

  const exec = new RemoteExecutor(connPool);
  const fileSync = new FileSync();
  for (const machine of machines) {
    fileSync.addMachine(machine);
  }

  // Metrics
  const metricStore = new MetricStore(agentId);
  const metricCollector = new MetricCollector(connPool, metricStore);

  // Memory (GlobalMemoryRouter routes /global/ paths to a shared store)
  const memoryStore = new GlobalMemoryRouter("pending");
  const contextGate = new ContextGate(memoryStore);
  contextGate.setExecutor(exec);
  contextGate.setMetricStore(metricStore);
  const expTracker = new ExperimentTracker(memoryStore);

  // Resources, notifications, experiment branching
  const resourceCollector = new ResourceCollector(connPool);
  const notifier = projectConfig?.notifications
    ? new Notifier({
        channels: projectConfig.notifications.channels,
        events: projectConfig.notifications.events as NotificationEvent[] | undefined,
      })
    : null;
  const experimentBrancher = new ExperimentBrancher(exec);

  // Stickies
  const stickies = new StickyManager();

  // Hub config
  const hubConfig = loadHubConfig();

  // System prompt
  let systemPrompt = SYSTEM_PROMPT;
  if (hubConfig?.agentName) {
    systemPrompt = systemPrompt.replace(
      "You are Helios, an autonomous ML research agent.",
      `You are Helios agent "${hubConfig.agentName}". This is your unique identity — your agent ID is "${hubConfig.agentName}". When creating directories, naming files, identifying yourself in posts, or any time you need "your name" or "your agent ID", use "${hubConfig.agentName}". You are an autonomous ML research agent.`,
    );
  }
  if (hubConfig) {
    systemPrompt += HUB_PROMPT_ADDENDUM;
  }
  if (projectConfig?.instructions) {
    systemPrompt += `\n\n## Project Instructions\n${projectConfig.instructions}`;
  }

  // Orchestrator
  const orch = new Orchestrator({
    defaultProvider: initialProvider,
    systemPrompt,
    agentId,
    sessionStore,
  });
  orch.setContextGate(contextGate);
  orch.setStickyManager(stickies);
  orch.registerProvider(claudeProvider);
  orch.registerProvider(openaiProvider);
  orch.registerProvider(vllmProvider);

  // Skills — seed bundled skills to ~/.helios/skills/ on first launch (or upgrade)
  seedBundledSkills();
  const projectRoot = projectConfig ? process.cwd() : undefined;
  const skillRegistry = new SkillRegistry(projectRoot);
  skillRegistry.load();

  // Tools
  orch.registerTools([
    createRemoteExecTool(exec),
    createRemoteExecBackgroundTool(exec, metricCollector),
    createUploadTool(fileSync),
    createDownloadTool(fileSync),
    createListMachinesTool(connPool),
    createTaskOutputTool(exec, connPool),
    createShowMetricsTool(metricStore),
    createCompareRunsTool(metricStore),
    createClearMetricsTool(metricStore, metricCollector),
    createKillTaskTool(exec, connPool, metricCollector),
    createReadFileTool(connPool),
    createWriteFileTool(connPool),
    createPatchFileTool(connPool),
    createWebFetchTool(),
    // web_search marker — actual search is handled by each provider's native tool.
    // Registered here so skills can reference it in their tools: allow list.
    {
      name: WEB_SEARCH_TOOL,
      description: "Search the web using the provider's built-in search. The provider handles this natively — Claude uses web_search_20250305, OpenAI uses its built-in web search.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"] },
      execute: async () => toolError("web_search is handled natively by the provider"),
    },
    ...createMemoryTools(memoryStore),
    createConsultTool(orch, skillRegistry),
    createWriteupTool(orch, skillRegistry),
    ...createExperimentBranchTools(experimentBrancher),
    createEnvSnapshotTool(exec, memoryStore),
    createSweepTool(exec, connPool, metricCollector),
  ]);

  // Subagents
  const subagentMgr = new SubagentManager();
  orch.registerTools(createSubagentTools(subagentMgr, orch, memoryStore));

  if (hubConfig) {
    const hubClient = new HubClient(hubConfig);
    orch.registerTools(createHubTools(hubClient, exec));
  }

  // Scheduler
  const triggerScheduler = new TriggerScheduler(connPool);
  const sleepMgr = new SleepManager(triggerScheduler, orch);
  sleepMgr.setExecutor(exec);
  sleepMgr.setConnectionPool(connPool);
  sleepMgr.setMetricStore(metricStore);
  orch.registerTool(createSleepTool(sleepMgr));

  // Monitor
  const monitorMgr = new MonitorManager();
  orch.registerTools([
    createStartMonitorTool(monitorMgr),
    createStopMonitorTool(monitorMgr),
  ]);

  // Activate provider — await so it's ready before callers use the runtime
  try {
    await orch.switchProvider(initialProvider);
    // Apply per-provider preferences (legacy global prefs migrated above)
    const providerPrefs = prefs[initialProvider];
    const model = projectConfig?.model ?? providerPrefs?.model;
    if (model) await orch.setModel(model);
    const reasoning = providerPrefs?.reasoningEffort;
    if (isReasoningEffort(reasoning)) await orch.setReasoningEffort(reasoning);
  } catch (err) {
    process.stderr.write(`[helios] Failed to authenticate ${initialProvider} provider: ${formatError(err)}\n`);
  }

  return {
    orchestrator: orch,
    sleepManager: sleepMgr,
    connectionPool: connPool,
    executor: exec,
    metricStore,
    metricCollector,
    monitorManager: monitorMgr,
    experimentTracker: expTracker,
    memoryStore,
    stickyManager: stickies,
    resourceCollector,
    notifier,
    experimentBrancher,
    subagentManager: subagentMgr,
    skillRegistry,
    openaiOAuth,
    projectConfig,
    agentName: agentId || hubConfig?.agentName,
    cleanup: () => {
      monitorMgr.stop();
      triggerScheduler.stopAll();
      connPool.disconnectAll();
    },
  };
}
