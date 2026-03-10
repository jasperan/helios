export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
}

export const COMMANDS: SlashCommand[] = [
  { name: "help", description: "Show available commands and keybindings" },
  { name: "switch", args: "<claude|openai>", description: "Switch model provider" },
  { name: "model", args: "<model-id>", description: "Set model (e.g. gpt-5.4, claude-opus-4-6)" },
  { name: "models", description: "List available models for current provider" },
  { name: "reasoning", args: "<low|medium|high>", description: "Set reasoning effort level" },
  { name: "claude-mode", args: "<cli|api>", description: "Switch Claude auth mode (cli = Agent SDK, api = API key)" },
  { name: "resume", args: "[number]", description: "List or resume a past session" },
  { name: "metric", args: "[name1 name2 ...]", description: "Show sparklines for named metrics" },
  { name: "metrics", args: "clear", description: "Clear all collected metrics" },
  { name: "writeup", description: "Generate an experiment writeup from the session" },
  { name: "machine", args: "<add|rm|list>", description: "Manage remote machines" },
  { name: "machines", description: "List configured remote machines" },
  { name: "sticky", args: "<text>", description: "Pin a sticky note (always visible to the model)" },
  { name: "stickies", args: "[rm <num>]", description: "List sticky notes, or remove one by number" },
  { name: "memory", args: "[path]", description: "Show the memory tree (virtual filesystem)" },
  { name: "status", description: "Show provider, model, state, and cost" },
  { name: "clear", description: "Clear conversation history" },
  { name: "quit", description: "Exit Helios" },
];
