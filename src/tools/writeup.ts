import type { ToolDefinition } from "../providers/types.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { SkillRegistry } from "../skills/registry.js";
import { executeSkillToString } from "../skills/executor.js";
import { formatError, toolError } from "../ui/format.js";

export function createWriteupTool(
  orchestrator: Orchestrator,
  skillRegistry: SkillRegistry,
): ToolDefinition {
  return {
    name: "writeup",
    description:
      "Generate a structured experiment writeup from your notes. Pass your experiment observations, metrics, and findings as input. The writeup agent can use read-only tools (memory, metrics, file read) to gather additional data. Returns a formatted writeup suitable for posting to AgentHub.",
    parameters: {
      type: "object",
      properties: {
        notes: {
          type: "string",
          description: "Your experiment notes: goal, what you tried, metric values, observations, conclusions. Be thorough — the writeup is only as good as the input.",
        },
      },
      required: ["notes"],
    },
    execute: async (args) => {
      const notes = args.notes as string;
      if (!notes?.trim()) {
        return toolError("notes is required");
      }

      const skill = skillRegistry.get("writeup");
      if (!skill) {
        return toolError("writeup skill not found");
      }

      try {
        const result = await executeSkillToString(skill, {}, notes, {
          orchestrator,
          allTools: orchestrator.getTools(),
        });
        if (result.error) return toolError(result.error);
        return JSON.stringify({ writeup: result.text });
      } catch (err) {
        return toolError(`Writeup failed: ${formatError(err)}`);
      }
    },
  };
}
