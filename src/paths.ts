import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, appendFileSync } from "node:fs";

/** Root config/data directory. Override with HELIOS_HOME env var. */
export const HELIOS_DIR = process.env.HELIOS_HOME ?? join(homedir(), ".helios");

/** Get the agent ID from environment. */
export function getAgentId(): string {
  return process.env.AGENTHUB_AGENT ?? "";
}

/** Tool name for the web search marker — providers map this to their native search. */
export const WEB_SEARCH_TOOL = "web_search";

/** Check if debug mode is enabled (--debug flag or HELIOS_DEBUG env var). */
export function isDebug(): boolean {
  return process.env.HELIOS_DEBUG === "1";
}

let debugLogPath: string | null = null;

/** Log a debug message to ~/.helios/debug.log (only when debug mode is enabled). */
export function debugLog(label: string, ...args: unknown[]): void {
  if (!isDebug()) return;
  try {
    if (!debugLogPath) {
      mkdirSync(HELIOS_DIR, { recursive: true });
      debugLogPath = join(HELIOS_DIR, "debug.log");
    }
    const timestamp = new Date().toISOString().slice(11, 23);
    const line = `[${timestamp}] [${label}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`;
    appendFileSync(debugLogPath, line);
  } catch {
    // Don't let debug logging crash the app
  }
}
