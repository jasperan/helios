import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTestDb } from "../../__tests__/db-helper.js";

// ─── Mocks ───────────────────────────────────────────

const mockDb = { current: createTestDb() };
vi.mock("../../store/database.js", () => {
  const getDb = () => mockDb.current;
  class StmtCache {
    private cache = new Map();
    stmt(sql: string) {
      let s = this.cache.get(sql);
      if (!s) { s = getDb().prepare(sql); this.cache.set(sql, s); }
      return s;
    }
  }
  return { getDb, StmtCache, getHeliosDir: () => "/tmp/helios-test" };
});

vi.mock("../../paths.js", () => ({
  WEB_SEARCH_TOOL: "web_search",
  debugLog: vi.fn(),
}));

// ─── Imports (dynamic because of mocks) ──────────────

const { SessionStore } = await import("../../store/session-store.js");
const { VLLMProvider } = await import("./provider.js");
const { CHECKPOINT_ACK } = await import("../types.js");

// ─── Helpers ─────────────────────────────────────────

/** Build a mock SSE response from an array of chat completion chunk events. */
function mockSSEResponse(events: Record<string, unknown>[], status = 200): Response {
  const encoder = new TextEncoder();
  const parts = events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
  parts.push("data: [DONE]\n\n");
  const body = parts.join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Build a SSE response that produces a text reply via chat completions format. */
function textSSEResponse(
  text: string,
  usage = { prompt_tokens: 10, completion_tokens: 5 },
): Response {
  return mockSSEResponse([
    {
      choices: [{
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      }],
    },
    {
      choices: [{
        index: 0,
        delta: { content: text },
        finish_reason: null,
      }],
    },
    {
      choices: [{
        index: 0,
        delta: {},
        finish_reason: "stop",
      }],
      usage,
    },
  ]);
}

/** Build a SSE response with tool calls in chat completions delta format. */
function toolCallSSEResponse(
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  text = "",
): Response {
  const events: Record<string, unknown>[] = [];

  // Optional text prefix
  if (text) {
    events.push({
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    });
  }

  // Tool call deltas (split name and args across chunks like real SSE)
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    // First chunk: id + name
    events.push({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: i,
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: "" },
          }],
        },
        finish_reason: null,
      }],
    });
    // Second chunk: arguments
    events.push({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: i,
            function: { arguments: JSON.stringify(tc.args) },
          }],
        },
        finish_reason: null,
      }],
    });
  }

  // Final chunk
  events.push({
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  });

  return mockSSEResponse(events);
}

/** Build a models list response. */
function modelsResponse(models: string[]): Response {
  return new Response(JSON.stringify({
    data: models.map(id => ({ id, object: "model", owned_by: "vllm" })),
  }), { status: 200, headers: { "content-type": "application/json" } });
}

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function makeTool(name: string, exec?: (args: any) => Promise<string>): any {
  return {
    name,
    description: `Test tool ${name}`,
    parameters: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
    execute: exec ?? vi.fn().mockResolvedValue("tool-result"),
  };
}

function makeSession(id = "sess-1"): any {
  return {
    id,
    providerId: "vllm",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
}

// ─── Tests ───────────────────────────────────────────

describe("VLLMProvider", () => {
  let store: InstanceType<typeof SessionStore>;
  let provider: InstanceType<typeof VLLMProvider>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDb.current = createTestDb();
    store = new SessionStore();
    provider = new VLLMProvider(store);

    mockFetch = vi.fn().mockResolvedValue(textSSEResponse("Hello"));
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ========== Provider Identity ==========

  describe("Provider Identity", () => {
    it("has correct name and displayName", () => {
      expect(provider.name).toBe("vllm");
      expect(provider.displayName).toBe("vLLM");
    });

    it("defaults to qwen3.5:9b model", () => {
      expect(provider.currentModel).toBe("qwen3.5:9b");
    });

    it("accepts reasoningEffort without error", () => {
      provider.reasoningEffort = "high";
      expect(provider.reasoningEffort).toBe("high");
    });
  });

  // ========== Authentication ==========

  describe("Authentication", () => {
    it("isAuthenticated returns true when server is reachable", async () => {
      mockFetch.mockResolvedValueOnce(modelsResponse(["qwen3.5:9b"]));
      const result = await provider.isAuthenticated();
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/models"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("isAuthenticated returns false when server is down", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const result = await provider.isAuthenticated();
      expect(result).toBe(false);
    });

    it("authenticate throws when server unreachable", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(provider.authenticate()).rejects.toThrow("Cannot reach vLLM");
    });

    it("authenticate auto-detects model when default not available", async () => {
      // isAuthenticated check
      mockFetch.mockResolvedValueOnce(modelsResponse(["llama3:8b"]));
      // fetchModels call
      mockFetch.mockResolvedValueOnce(modelsResponse(["llama3:8b"]));
      await provider.authenticate();
      expect(provider.currentModel).toBe("llama3:8b");
    });

    it("authenticate keeps default model when available", async () => {
      mockFetch.mockResolvedValueOnce(modelsResponse(["qwen3.5:9b", "llama3:8b"]));
      mockFetch.mockResolvedValueOnce(modelsResponse(["qwen3.5:9b", "llama3:8b"]));
      await provider.authenticate();
      expect(provider.currentModel).toBe("qwen3.5:9b");
    });
  });

  // ========== Model Listing ==========

  describe("fetchModels", () => {
    it("returns models from server", async () => {
      mockFetch.mockResolvedValueOnce(modelsResponse(["qwen3.5:9b", "llama3:8b"]));
      const models = await provider.fetchModels();
      expect(models).toHaveLength(2);
      expect(models[0].id).toBe("qwen3.5:9b");
      expect(models[1].id).toBe("llama3:8b");
    });

    it("returns current model as fallback on error", async () => {
      mockFetch.mockResolvedValueOnce(new Response("", { status: 500 }));
      const models = await provider.fetchModels();
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("qwen3.5:9b");
    });
  });

  // ========== Session Management ==========

  describe("Session Management", () => {
    it("createSession initializes empty history", async () => {
      const session = await provider.createSession({});
      expect(session.id).toBeTruthy();
      expect((provider as any).conversationHistory.get(session.id)).toEqual([]);
    });

    it("createSession stores system prompt", async () => {
      const session = await provider.createSession({ systemPrompt: "Be helpful" });
      expect((provider as any).systemPrompts.get(session.id)).toBe("Be helpful");
    });

    it("closeSession cleans up state", async () => {
      const session = await provider.createSession({ systemPrompt: "test" });
      await provider.closeSession(session);
      expect((provider as any).conversationHistory.has(session.id)).toBe(false);
      expect((provider as any).systemPrompts.has(session.id)).toBe(false);
    });
  });

  // ========== Text Streaming ==========

  describe("Text Streaming", () => {
    it("streams text response and emits done with usage", async () => {
      const session = await provider.createSession({});
      mockFetch.mockResolvedValueOnce(textSSEResponse("Hello world"));

      const events = await collect(provider.send(session, "Hi", []));

      const textEvents = events.filter(e => e.type === "text");
      expect(textEvents.length).toBeGreaterThan(0);

      const doneEvent = events.find(e => e.type === "done");
      expect(doneEvent).toBeTruthy();
      expect(doneEvent.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        contextTokens: 10,
      });
    });

    it("appends user message to conversation history", async () => {
      const session = await provider.createSession({});
      mockFetch.mockResolvedValueOnce(textSSEResponse("Reply"));

      await collect(provider.send(session, "Hello", []));

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history[0]).toEqual({ role: "user", content: "Hello" });
      expect(history[1]).toEqual({ role: "assistant", content: "Reply" });
    });

    it("includes system prompt in messages", async () => {
      const session = await provider.createSession({ systemPrompt: "Be concise" });
      mockFetch.mockResolvedValueOnce(textSSEResponse("Ok"));

      await collect(provider.send(session, "Hi", []));

      const reqBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(reqBody.messages[0]).toEqual({ role: "system", content: "Be concise" });
    });

    it("strips <think> blocks from final text", async () => {
      const thinkText = "<think>Let me reason about this...</think>The answer is 42.";
      mockFetch.mockResolvedValueOnce(textSSEResponse(thinkText));
      const session = await provider.createSession({});

      const events = await collect(provider.send(session, "Question", []));

      const history = (provider as any).conversationHistory.get(session.id);
      const assistantMsg = history.find((m: any) => m.role === "assistant");
      expect(assistantMsg.content).toBe("The answer is 42.");
      expect(assistantMsg.content).not.toContain("<think>");
    });
  });

  // ========== Tool Calling ==========

  describe("Tool Calling", () => {
    it("handles tool calls and loops back for final response", async () => {
      const tool = makeTool("get_weather");
      const session = await provider.createSession({});

      // First call: model requests tool
      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ id: "call_1", name: "get_weather", args: { input: "Paris" } }]),
        )
        // Second call: model gives final answer
        .mockResolvedValueOnce(textSSEResponse("The weather in Paris is sunny."));

      const events = await collect(provider.send(session, "Weather in Paris?", [tool]));

      const toolCall = events.find(e => e.type === "tool_call");
      expect(toolCall).toBeTruthy();
      expect(toolCall.name).toBe("get_weather");
      expect(toolCall.args).toEqual({ input: "Paris" });

      const toolResult = events.find(e => e.type === "tool_result");
      expect(toolResult).toBeTruthy();
      expect(toolResult.callId).toBe("call_1");
      expect(toolResult.isError).toBe(false);

      const doneEvent = events.find(e => e.type === "done");
      expect(doneEvent).toBeTruthy();
    });

    it("handles unknown tool gracefully", async () => {
      const session = await provider.createSession({});

      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ id: "call_1", name: "nonexistent", args: {} }]),
        )
        .mockResolvedValueOnce(textSSEResponse("Sorry, I couldn't do that."));

      const events = await collect(provider.send(session, "Do something", []));

      const toolResult = events.find(e => e.type === "tool_result");
      expect(toolResult.isError).toBe(true);
      expect(toolResult.result).toContain("Unknown tool");
    });

    it("handles tool execution error", async () => {
      const failTool = makeTool("fail_tool", async () => { throw new Error("Boom"); });
      const session = await provider.createSession({});

      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ id: "call_1", name: "fail_tool", args: { input: "x" } }]),
        )
        .mockResolvedValueOnce(textSSEResponse("Tool failed."));

      const events = await collect(provider.send(session, "Run it", [failTool]));

      const toolResult = events.find(e => e.type === "tool_result");
      expect(toolResult.isError).toBe(true);
      expect(toolResult.result).toContain("Boom");
    });

    it("filters web_search from tools sent to vLLM", async () => {
      const session = await provider.createSession({});
      const webTool = makeTool("web_search");
      const normalTool = makeTool("read_file");
      mockFetch.mockResolvedValueOnce(textSSEResponse("Done"));

      await collect(provider.send(session, "Hi", [webTool, normalTool]));

      const reqBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const toolNames = reqBody.tools.map((t: any) => t.function.name);
      expect(toolNames).not.toContain("web_search");
      expect(toolNames).toContain("read_file");
    });
  });

  // ========== Qwen Thinking Mode ==========

  describe("Qwen Thinking Mode", () => {
    it("sends chat_template_kwargs for qwen models", async () => {
      const session = await provider.createSession({});
      provider.currentModel = "qwen3.5:9b";
      mockFetch.mockResolvedValueOnce(textSSEResponse("Hi"));

      await collect(provider.send(session, "Hello", []));

      const reqBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(reqBody.chat_template_kwargs).toEqual({ enable_thinking: false });
    });

    it("does not send chat_template_kwargs for non-qwen models", async () => {
      const session = await provider.createSession({});
      provider.currentModel = "llama3:8b";
      mockFetch.mockResolvedValueOnce(textSSEResponse("Hi"));

      await collect(provider.send(session, "Hello", []));

      const reqBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(reqBody.chat_template_kwargs).toBeUndefined();
    });
  });

  // ========== URL Validation ==========

  describe("URL Validation", () => {
    it("rejects non-http protocols", () => {
      process.env.VLLM_BASE_URL = "file:///etc/passwd";
      expect(() => new VLLMProvider(store)).toThrow("Unsupported protocol");
      delete process.env.VLLM_BASE_URL;
    });

    it("rejects malformed URLs", () => {
      process.env.VLLM_BASE_URL = "not a url";
      expect(() => new VLLMProvider(store)).toThrow("Invalid VLLM_BASE_URL");
      delete process.env.VLLM_BASE_URL;
    });

    it("accepts valid http URLs", () => {
      process.env.VLLM_BASE_URL = "http://my-server:9000/v1/";
      const p = new VLLMProvider(store);
      expect((p as any).baseUrl).toBe("http://my-server:9000/v1");
      delete process.env.VLLM_BASE_URL;
    });

    it("accepts valid https URLs", () => {
      process.env.VLLM_BASE_URL = "https://api.example.com";
      const p = new VLLMProvider(store);
      expect((p as any).baseUrl).toBe("https://api.example.com");
      delete process.env.VLLM_BASE_URL;
    });
  });

  // ========== Attachment Warning ==========

  describe("Attachment Warning", () => {
    it("logs warning when attachments are passed", async () => {
      const { debugLog } = await import("../../paths.js");
      const session = await provider.createSession({});
      mockFetch.mockResolvedValueOnce(textSSEResponse("Ok"));

      await collect(provider.send(session, "Hi", [], [{ type: "image", data: "base64" } as any]));

      expect(debugLog).toHaveBeenCalledWith("vllm", "attachments not yet supported — ignoring", { count: 1 });
    });
  });

  // ========== Error Handling ==========

  describe("Error Handling", () => {
    it("throws on non-transient API errors", async () => {
      const session = await provider.createSession({});
      mockFetch.mockResolvedValueOnce(
        new Response("Bad request", { status: 400 }),
      );

      await expect(collect(provider.send(session, "Hi", []))).rejects.toThrow("vLLM API error: 400");
    });

    it("retries on 429 rate limit", async () => {
      const session = await provider.createSession({});
      mockFetch
        .mockResolvedValueOnce(new Response("Rate limited", { status: 429 }))
        .mockResolvedValueOnce(textSSEResponse("Success"));

      const events = await collect(provider.send(session, "Hi", []));
      const textEvents = events.filter(e => e.type === "text");
      expect(textEvents.some(e => e.delta?.includes("retrying"))).toBe(true);
      expect(events.find(e => e.type === "done")).toBeTruthy();
    });

    it("retries on 500 server error", async () => {
      const session = await provider.createSession({});
      mockFetch
        .mockResolvedValueOnce(new Response("Internal error", { status: 500 }))
        .mockResolvedValueOnce(textSSEResponse("Recovered"));

      const events = await collect(provider.send(session, "Hi", []));
      expect(events.find(e => e.type === "done")).toBeTruthy();
    });
  });

  // ========== History Management ==========

  describe("History Management", () => {
    it("resetHistory clears and seeds with briefing", () => {
      const session = makeSession();
      (provider as any).conversationHistory.set(session.id, [
        { role: "user", content: "old" },
      ]);

      provider.resetHistory(session, "New context");

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toEqual([
        { role: "user", content: "New context" },
        { role: "assistant", content: CHECKPOINT_ACK },
      ]);
    });

    it("interrupt aborts the current request", () => {
      const session = makeSession();
      const controller = new AbortController();
      (provider as any).abortController = controller;

      provider.interrupt(session);

      expect(controller.signal.aborted).toBe(true);
      expect((provider as any).abortController).toBeNull();
    });
  });

  // ========== Request Format ==========

  describe("Request Format", () => {
    it("sends correct request structure", async () => {
      const session = await provider.createSession({ systemPrompt: "Be brief" });
      mockFetch.mockResolvedValueOnce(textSSEResponse("Ok"));

      await collect(provider.send(session, "Test", []));

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/chat/completions"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "Content-Type": "application/json" }),
        }),
      );

      const reqBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(reqBody.model).toBe("qwen3.5:9b");
      expect(reqBody.stream).toBe(true);
      expect(reqBody.max_tokens).toBe(16384);
      expect(reqBody.messages[0].role).toBe("system");
      expect(reqBody.messages[1].role).toBe("user");
    });

    it("includes Authorization header when API key is set", async () => {
      // Access private field to set API key
      (provider as any).apiKey = "test-key-123";
      const session = await provider.createSession({});
      mockFetch.mockResolvedValueOnce(textSSEResponse("Ok"));

      await collect(provider.send(session, "Test", []));

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer test-key-123");
    });
  });
});
