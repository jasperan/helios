import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HELIOS_DIR } from "../paths.js";

const PREFS_FILE = join(HELIOS_DIR, "preferences.json");

export interface Preferences {
  lastProvider?: "claude" | "openai";
  claudeAuthMode?: "cli" | "api";
  model?: string;
  reasoningEffort?: string;
}

export function loadPreferences(): Preferences {
  try {
    return JSON.parse(readFileSync(PREFS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function savePreferences(prefs: Partial<Preferences>): void {
  mkdirSync(HELIOS_DIR, { recursive: true });
  const existing = loadPreferences();
  writeFileSync(
    PREFS_FILE,
    JSON.stringify({ ...existing, ...prefs }, null, 2),
    "utf-8",
  );
}
