import { join } from "node:path";
import { homedir } from "node:os";

/** Root config/data directory. Override with HELIOS_HOME env var. */
export const HELIOS_DIR = process.env.HELIOS_HOME ?? join(homedir(), ".helios");

/** Get the agent ID from environment. */
export function getAgentId(): string {
  return process.env.AGENTHUB_AGENT ?? "";
}

/** Tool name for the web search marker — providers map this to their native search. */
export const WEB_SEARCH_TOOL = "web_search";
