/**
 * vLLM provider — talks to any vLLM-served model via the OpenAI-compatible
 * /v1/chat/completions endpoint. Supports tool calling and SSE streaming.
 *
 * Config:
 *   VLLM_BASE_URL  — API base (default: http://localhost:8000)
 *   VLLM_API_KEY   — optional bearer token
 */

import {
  CHECKPOINT_ACK,
  type ModelProvider,
  type ModelInfo,
  type ToolDefinition,
  type Session,
  type SessionConfig,
  type AgentEvent,
  type ReasoningEffort,
  type Attachment,
} from "../types.js";
import { TransientError, isTransient, sleep } from "../retry.js";
import { formatError, withTimeout } from "../../ui/format.js";
import { debugLog } from "../../paths.js";
import { parseSSELines } from "../sse.js";
import { SessionStore, createEphemeralSession, parseToolCalls, parseToolResultMeta } from "../../store/session-store.js";

const DEFAULT_BASE_URL = "http://localhost:8000";
const DEFAULT_MODEL = "qwen3.5:9b";

function sanitizeBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`Unsupported protocol: ${u.protocol}`);
    }
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "");
  } catch (err) {
    throw new Error(`Invalid VLLM_BASE_URL "${raw}": ${err instanceof Error ? err.message : err}`);
  }
}

// ─── OpenAI chat completions types ──────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// Internal streaming event
type StreamResult =
  | { kind: "delta"; text: string }
  | {
      kind: "complete";
      text: string;
      toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
      usage?: { input: number; output: number };
    };

// ─── Provider ───────────────────────────────────────

export class VLLMProvider implements ModelProvider {
  readonly name = "vllm" as const;
  readonly displayName = "vLLM";
  currentModel: string = DEFAULT_MODEL;
  reasoningEffort: ReasoningEffort = "medium"; // accepted but not used

  private baseUrl: string;
  private apiKey: string | undefined;
  private sessionStore: SessionStore;
  private abortController: AbortController | null = null;
  private systemPrompts = new Map<string, string>();
  private conversationHistory = new Map<string, ChatMessage[]>();

  constructor(sessionStore?: SessionStore) {
    this.baseUrl = sanitizeBaseUrl(process.env.VLLM_BASE_URL ?? DEFAULT_BASE_URL);
    this.apiKey = process.env.VLLM_API_KEY;
    this.sessionStore = sessionStore ?? new SessionStore();
  }

  async isAuthenticated(): Promise<boolean> {
    // vLLM doesn't require auth — just check connectivity
    try {
      const resp = await fetch(`${this.baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(5000),
        ...(this.apiKey ? { headers: { Authorization: `Bearer ${this.apiKey}` } } : {}),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async authenticate(): Promise<void> {
    // Re-read env in case it changed
    this.baseUrl = sanitizeBaseUrl(process.env.VLLM_BASE_URL ?? DEFAULT_BASE_URL);
    this.apiKey = process.env.VLLM_API_KEY;

    const ok = await this.isAuthenticated();
    if (!ok) {
      throw new Error(
        `Cannot reach vLLM at ${this.baseUrl}/v1/models.\n` +
        "Make sure vLLM is running (e.g. `vllm serve <model>`).\n" +
        "Set VLLM_BASE_URL if it's not on localhost:8000.\n" +
        "Set VLLM_API_KEY if the server requires authentication.",
      );
    }

    // Auto-detect model if current default isn't available
    try {
      const models = await this.fetchModels();
      if (models.length > 0 && !models.some(m => m.id === this.currentModel)) {
        this.currentModel = models[0].id;
        debugLog("vllm", "auto-selected model", this.currentModel);
      }
    } catch {
      // Model list failed — keep the configured model and let send() fail with a clear error
    }
  }

  async fetchModels(): Promise<ModelInfo[]> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const resp = await fetch(`${this.baseUrl}/v1/models`, { headers });
    if (!resp.ok) {
      return [{ id: this.currentModel, name: this.currentModel }];
    }

    const data = (await resp.json()) as { data?: Array<{ id: string; owned_by?: string }> };
    if (data.data && data.data.length > 0) {
      return data.data.map(m => ({
        id: m.id,
        name: m.id,
        description: m.owned_by ? `Served by ${m.owned_by}` : undefined,
      }));
    }

    return [{ id: this.currentModel, name: this.currentModel }];
  }

  async createSession(config: SessionConfig): Promise<Session> {
    const session = config.ephemeral
      ? createEphemeralSession("vllm")
      : this.sessionStore.createSession("vllm", config.model ?? this.currentModel);

    if (config.systemPrompt) {
      this.systemPrompts.set(session.id, config.systemPrompt);
    }
    this.conversationHistory.set(session.id, []);
    return session;
  }

  async resumeSession(id: string, systemPrompt?: string): Promise<Session> {
    const session = this.sessionStore.getSession(id);
    if (!session) throw new Error(`Session ${id} not found`);

    if (systemPrompt) {
      this.systemPrompts.set(id, systemPrompt);
    }

    if (!this.conversationHistory.has(id)) {
      const stored = this.sessionStore.getMessages(id, 500);
      const history: ChatMessage[] = [];
      const pendingToolCallIds = new Set<string>();
      const emittedToolCallIds = new Set<string>();

      for (const m of stored) {
        if (m.role === "user") {
          history.push({ role: "user", content: m.content });
        } else if (m.role === "assistant") {
          const tcs = parseToolCalls(m);
          if (tcs.length > 0) {
            const toolCalls: ChatToolCall[] = tcs.map(tc => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            }));
            for (const tc of tcs) {
              pendingToolCallIds.add(tc.id);
              emittedToolCallIds.add(tc.id);
            }
            history.push({
              role: "assistant",
              content: m.content || null,
              tool_calls: toolCalls,
            });
          } else {
            history.push({ role: "assistant", content: m.content });
          }
        } else if (m.role === "tool") {
          const meta = parseToolResultMeta(m);
          if (!emittedToolCallIds.has(meta.callId)) continue;
          pendingToolCallIds.delete(meta.callId);
          history.push({
            role: "tool",
            content: m.content,
            tool_call_id: meta.callId,
          });
        }
      }

      // Synthetic error results for tool calls that never completed
      for (const toolCallId of pendingToolCallIds) {
        history.push({
          role: "tool",
          content: "(session interrupted before tool completed)",
          tool_call_id: toolCallId,
        });
      }

      this.conversationHistory.set(id, history);
    }
    return session;
  }

  async *send(
    session: Session,
    message: string,
    tools: ToolDefinition[],
    attachments?: Attachment[],
  ): AsyncGenerator<AgentEvent> {
    if (attachments && attachments.length > 0) {
      debugLog("vllm", "attachments not yet supported — ignoring", { count: attachments.length });
    }
    const history = this.conversationHistory.get(session.id) ?? [];

    history.push({ role: "user", content: message });

    const MAX_RETRIES = 3;
    let continueLoop = true;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let lastRoundInputTokens = 0;

    while (continueLoop) {
      continueLoop = false;

      let streamResult: (StreamResult & { kind: "complete" }) | undefined;
      let lastError: unknown;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const delayMs = Math.min(1000 * 2 ** (attempt - 1), 15000);
          yield {
            type: "text",
            text: `\n*[retrying in ${Math.round(delayMs / 1000)}s — attempt ${attempt + 1}/${MAX_RETRIES + 1}]*\n`,
            delta: `\n*[retrying in ${Math.round(delayMs / 1000)}s — attempt ${attempt + 1}/${MAX_RETRIES + 1}]*\n`,
          };
          await sleep(delayMs);
        }

        try {
          streamResult = undefined;
          for await (const event of this.streamChatCompletion(session, history, tools)) {
            if (event.kind === "delta") {
              yield { type: "text", text: event.text, delta: event.text };
            } else {
              streamResult = event;
            }
          }
          break; // success
        } catch (err) {
          lastError = err;
          if (!isTransient(err) || attempt === MAX_RETRIES) throw err;
        }
      }

      if (!streamResult) throw lastError ?? new Error("No response from vLLM");

      const { text, toolCalls, usage } = streamResult;

      if (toolCalls.length > 0) {
        // Build assistant message with tool calls
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: text || null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        };
        history.push(assistantMsg);

        for (const tc of toolCalls) {
          yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };

          const tool = tools.find(t => t.name === tc.name);
          let result: string;
          let isError = false;

          if (!tool) {
            result = `Unknown tool: ${tc.name}`;
            isError = true;
          } else {
            try {
              result = await withTimeout(tool.execute(tc.args), 300_000, tc.name);
            } catch (err) {
              result = `Error: ${formatError(err)}`;
              isError = true;
            }
          }

          yield { type: "tool_result", callId: tc.id, result, isError };
          history.push({ role: "tool", content: result, tool_call_id: tc.id });
        }

        if (usage) {
          totalInputTokens += usage.input;
          totalOutputTokens += usage.output;
          lastRoundInputTokens = usage.input;
        }
        continueLoop = true;
      } else {
        if (text) {
          history.push({ role: "assistant", content: text });
        }
        if (usage) {
          totalInputTokens += usage.input;
          totalOutputTokens += usage.output;
          lastRoundInputTokens = usage.input;
        }
        yield {
          type: "done",
          usage: totalInputTokens > 0 || totalOutputTokens > 0
            ? {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                contextTokens: lastRoundInputTokens,
              }
            : undefined,
        };
      }
    }

    this.conversationHistory.set(session.id, history);
  }

  interrupt(_session: Session): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  resetHistory(session: Session, briefingMessage: string): void {
    this.conversationHistory.set(session.id, [
      { role: "user", content: briefingMessage },
      { role: "assistant", content: CHECKPOINT_ACK },
    ]);
  }

  async closeSession(session: Session): Promise<void> {
    this.conversationHistory.delete(session.id);
    this.systemPrompts.delete(session.id);
  }

  // ─── SSE Streaming via /v1/chat/completions ───────

  private async *streamChatCompletion(
    session: Session,
    history: ChatMessage[],
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamResult> {
    this.abortController = new AbortController();

    const messages: ChatMessage[] = [];

    // System prompt
    const systemPrompt = this.systemPrompts.get(session.id);
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    // Conversation history
    messages.push(...history);

    // Build request body
    const body: Record<string, unknown> = {
      model: this.currentModel,
      messages,
      stream: true,
      max_tokens: 16384,
    };

    // Disable thinking mode for Qwen models (vLLM-specific parameter).
    // Without this, Qwen3.5 burns tokens on internal CoT and may return empty content.
    if (this.currentModel.toLowerCase().includes("qwen")) {
      body.chat_template_kwargs = { enable_thinking: false };
    }

    // Add tools if any (filter out web_search — vLLM doesn't support it natively)
    const functionTools = tools
      .filter(t => t.name !== "web_search")
      .map(t => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: {
            type: "object" as const,
            properties: t.parameters.properties,
            required: t.parameters.required,
          },
        },
      }));

    if (functionTools.length > 0) {
      body.tools = functionTools;
      body.tool_choice = "auto";
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    debugLog("vllm", "request", {
      model: body.model,
      messages: messages.length,
      tools: functionTools.length,
      baseUrl: this.baseUrl,
    });

    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: this.abortController.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const status = resp.status;
      debugLog("vllm", "error response", { status, body: errText });
      if (status === 429 || status >= 500) {
        throw new TransientError(`vLLM API error: ${status} ${errText}`);
      }
      throw new Error(`vLLM API error: ${status} ${errText}`);
    }

    // Parse SSE stream (OpenAI chat completions format)
    const textParts: string[] = [];
    const toolCallAccum = new Map<number, { id: string; name: string; argParts: string[] }>();
    let usage: { input: number; output: number } | undefined;

    for await (const evt of parseSSELines(resp) as AsyncGenerator<Record<string, unknown>>) {
      const choices = evt.choices as Array<Record<string, unknown>> | undefined;
      if (!choices || choices.length === 0) {
        // Check for usage in the final message
        const u = evt.usage as Record<string, number> | undefined;
        if (u) {
          usage = {
            input: u.prompt_tokens ?? 0,
            output: u.completion_tokens ?? 0,
          };
        }
        continue;
      }

      const choice = choices[0];
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      // Text content
      if (delta.content) {
        const text = delta.content as string;
        textParts.push(text);
        yield { kind: "delta", text };
      }

      // Tool calls (accumulated across deltas)
      const deltaToolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (deltaToolCalls) {
        for (const dtc of deltaToolCalls) {
          const idx = (dtc.index as number) ?? 0;
          const fn = dtc.function as Record<string, unknown> | undefined;

          if (!toolCallAccum.has(idx)) {
            toolCallAccum.set(idx, {
              id: (dtc.id as string) ?? `call_${idx}`,
              name: (fn?.name as string) ?? "",
              argParts: [],
            });
          }

          const accum = toolCallAccum.get(idx)!;
          if (fn?.name) accum.name = fn.name as string;
          if (dtc.id) accum.id = dtc.id as string;
          if (fn?.arguments) accum.argParts.push(fn.arguments as string);
        }
      }

      // Usage in streaming response (some vLLM versions include it per-chunk)
      const u = evt.usage as Record<string, number> | undefined;
      if (u) {
        usage = {
          input: u.prompt_tokens ?? 0,
          output: u.completion_tokens ?? 0,
        };
      }
    }

    // Assemble final tool calls
    const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    for (const [, accum] of [...toolCallAccum.entries()].sort(([a], [b]) => a - b)) {
      const jsonStr = accum.argParts.join("");
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(jsonStr || "{}");
      } catch (err) {
        debugLog("vllm", "malformed tool call JSON", { name: accum.name, json: jsonStr, error: String(err) });
      }
      toolCalls.push({ id: accum.id, name: accum.name, args });
    }

    // Strip residual <think>...</think> blocks (Qwen-family safety net)
    let finalText = textParts.join("");
    finalText = finalText.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    yield {
      kind: "complete",
      text: finalText,
      toolCalls,
      usage,
    };
  }
}
