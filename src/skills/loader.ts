import { readdirSync, readFileSync, mkdirSync, copyFileSync, constants as fsConstants } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HELIOS_DIR } from "../paths.js";
import type { Skill, SkillConfig, SkillToolAccess } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Directory for bundled skills (lives next to compiled JS). */
const BUNDLED_DIR = join(__dirname, "bundled");
/** User-global skills — bundled skills are seeded here on first launch. */
const USER_DIR = join(HELIOS_DIR, "skills");

// ─── Frontmatter parser (no yaml dependency needed) ──

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const meta: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentValue: string = "";
  let inBlock = false;
  let blockIndent = 0;

  for (const line of match[1].split("\n")) {
    // Continuation of a block (indented sub-keys or list items)
    if (inBlock && currentKey) {
      const indent = line.search(/\S/);
      if (indent > blockIndent || line.trim() === "") {
        currentValue += "\n" + line;
        continue;
      }
      // Block ended — flush
      meta[currentKey] = parseYamlValue(currentValue.trim(), true);
      inBlock = false;
      currentKey = null;
      currentValue = "";
    }

    const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    const [, key, rest] = kvMatch;
    const trimmed = rest.trim();

    if (trimmed === "" || trimmed.startsWith("\n")) {
      // Block value starts on next line
      currentKey = key;
      currentValue = "";
      inBlock = true;
      blockIndent = key.length + 1;
    } else {
      meta[key] = parseYamlValue(trimmed, false);
    }
  }

  // Flush trailing block
  if (inBlock && currentKey) {
    meta[currentKey] = parseYamlValue(currentValue.trim(), true);
  }

  return { meta, body: match[2].trim() };
}

function parseYamlValue(raw: string, isBlock: boolean): unknown {
  // Inline list: [a, b, c]
  const listMatch = raw.match(/^\[([^\]]*)\]$/);
  if (listMatch) {
    return listMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
  }

  // Block list (each line starts with "- ")
  if (isBlock && raw.includes("\n")) {
    const lines = raw.split("\n");
    // Check if it's a list
    if (lines.every((l) => l.trim().startsWith("- ") || l.trim() === "")) {
      return lines
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- "))
        .map((l) => l.slice(2).trim());
    }
    // Check if it's a nested object
    const obj: Record<string, unknown> = {};
    for (const l of lines) {
      const m = l.trim().match(/^(\w[\w-]*)\s*:\s*(.*)$/);
      if (m) obj[m[1]] = parseYamlValue(m[2].trim(), false);
    }
    if (Object.keys(obj).length > 0) return obj;
    return raw;
  }

  // Null
  if (raw === "null" || raw === "~") return null;
  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Number
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

// ─── Skill seeding ──────────────────────────────────

/**
 * Copy bundled skills to ~/.helios/skills/ if they don't already exist.
 * Called on first launch (or upgrade when new skills are added).
 * Never overwrites user-edited files.
 */
export function seedBundledSkills(): void {
  let files: string[];
  try {
    files = readdirSync(BUNDLED_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return; // No bundled dir
  }

  mkdirSync(USER_DIR, { recursive: true });

  for (const file of files) {
    try {
      copyFileSync(join(BUNDLED_DIR, file), join(USER_DIR, file), fsConstants.COPYFILE_EXCL);
    } catch {
      // Already exists — don't overwrite user edits
    }
  }
}

// ─── Skill loading ───────────────────────────────────

export function parseSkillFile(filePath: string, source: Skill["source"]): Skill | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;

    const { meta, body } = parsed;
    const name = meta.name as string;
    const description = meta.description as string;
    if (!name || !description) return null;

    const config: SkillConfig = {
      name,
      description,
      args: meta.args as SkillConfig["args"],
      model: (meta.model as string) ?? null,
      reasoning: (meta.reasoning as string) ?? null,
      provider: (meta.provider as SkillConfig["provider"]) ?? null,
      loop: meta.loop === true,
      delay_ms: typeof meta.delay_ms === "number" ? meta.delay_ms : undefined,
      loop_message: (meta.loop_message as string) ?? undefined,
    };

    // Parse tools — can be a simple list (shorthand for allow) or object with allow/deny
    if (meta.tools) {
      if (Array.isArray(meta.tools)) {
        config.tools = { allow: meta.tools as string[] };
      } else if (typeof meta.tools === "object") {
        config.tools = meta.tools as SkillToolAccess;
      }
    }

    return { name, description, source, filePath, config, template: body };
  } catch {
    return null;
  }
}

function loadDir(dir: string, source: Skill["source"]): Skill[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => parseSkillFile(join(dir, f), source))
      .filter((s): s is Skill => s !== null);
  } catch {
    return [];
  }
}

/**
 * Discover all skills. Priority: project > user.
 * Bundled skills live in USER_DIR after seeding (see seedBundledSkills).
 * Project skills override user skills with the same name.
 */
export function discoverSkills(projectDir?: string): Skill[] {
  const byName = new Map<string, Skill>();

  for (const skill of loadDir(USER_DIR, "user")) {
    byName.set(skill.name, skill);
  }
  if (projectDir) {
    for (const skill of loadDir(join(projectDir, ".helios", "skills"), "project")) {
      byName.set(skill.name, skill);
    }
  }

  return Array.from(byName.values());
}

/** Render a template with {arg} placeholders replaced. */
export function renderTemplate(template: string, args: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => args[key] ?? match);
}
