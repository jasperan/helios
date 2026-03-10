import type { ToolDefinition, ModelProvider } from "../providers/types.js";
import { formatError } from "../ui/format.js";

const CONSULT_SYSTEM_PROMPT = `You are a senior ML research consultant. Another AI research agent is asking for your help. Give a direct, actionable response. Be concise — focus on what they should try next.`;

export function createConsultTool(
  getActiveProviderName: () => string | null,
  getProvider: (name: string) => ModelProvider | null,
): ToolDefinition {
  return {
    name: "consult",
    description:
      "Ask the other AI provider for a second opinion. Sends your question to Claude (if you're using OpenAI) or OpenAI (if you're using Claude). Use this if you're stuck and want a fresh perspective.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "What you want to ask the other provider.",
        },
      },
      required: ["question"],
    },
    execute: async (args) => {
      const question = args.question as string;
      if (!question?.trim()) {
        return JSON.stringify({ error: "question is required" });
      }

      const activeName = getActiveProviderName();
      if (!activeName) {
        return JSON.stringify({ error: "No active provider" });
      }

      const otherName = activeName === "claude" ? "openai" : "claude";
      const otherProvider = getProvider(otherName);
      if (!otherProvider) {
        return JSON.stringify({ error: `Provider "${otherName}" not available` });
      }

      if (!(await otherProvider.isAuthenticated())) {
        return JSON.stringify({
          error: `Provider "${otherName}" is not authenticated. Ask the user to run /switch ${otherName} first.`,
        });
      }

      const session = await otherProvider.createSession({
        systemPrompt: CONSULT_SYSTEM_PROMPT,
      });

      try {
        let response = "";
        for await (const event of otherProvider.send(session, question, [])) {
          if (event.type === "text" && event.delta) {
            response += event.delta;
          }
        }

        return JSON.stringify({
          provider: otherName,
          response: response || "(empty response)",
        });
      } catch (err) {
        return JSON.stringify({
          error: `Consult failed: ${formatError(err)}`,
        });
      } finally {
        await otherProvider.closeSession(session).catch(() => {});
      }
    },
  };
}
