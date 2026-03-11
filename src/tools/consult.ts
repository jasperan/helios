import type { ToolDefinition } from "../providers/types.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { SkillRegistry } from "../skills/registry.js";
import { executeSkillToString } from "../skills/executor.js";
import { formatError, toolError } from "../ui/format.js";

export function createConsultTool(
  orchestrator: Orchestrator,
  skillRegistry: SkillRegistry,
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
        return toolError("question is required");
      }

      const skill = skillRegistry.get("consult");
      if (!skill) {
        return toolError("consult skill not found");
      }

      try {
        const result = await executeSkillToString(skill, {}, question, {
          orchestrator,
          allTools: orchestrator.getTools(),
        });
        if (result.error) return toolError(result.error);
        const providerName = skill.config.provider === "other"
          ? (orchestrator.currentProvider?.name === "claude" ? "openai" : "claude")
          : (skill.config.provider ?? orchestrator.currentProvider?.name ?? "unknown");
        return JSON.stringify({ provider: providerName, response: result.text });
      } catch (err) {
        return toolError(`Consult failed: ${formatError(err)}`);
      }
    },
  };
}
