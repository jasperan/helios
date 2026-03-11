export interface SkillArgDef {
  type: "string" | "number" | "boolean";
  description?: string;
  required?: boolean;
}

export interface SkillToolAccess {
  allow?: string[];
  deny?: string[];
}

export interface SkillConfig {
  name: string;
  description: string;
  args?: Record<string, SkillArgDef>;
  tools?: SkillToolAccess;
  /** Override model for the sub-session (null = inherit). */
  model?: string | null;
  /** Override reasoning effort (null = inherit). */
  reasoning?: string | null;
  /** "other" routes to the non-active provider (for consult). */
  provider?: "other" | "claude" | "openai" | null;
  /** If true, the skill re-invokes itself in a loop until interrupted. */
  loop?: boolean;
  /** Delay in ms between loop iterations (default: 60000). Only meaningful when loop=true. */
  delay_ms?: number;
  /** Message sent on subsequent loop iterations (supports {iteration} placeholder). */
  loop_message?: string;
}

export interface Skill {
  name: string;
  description: string;
  source: "user" | "project";
  filePath: string;
  config: SkillConfig;
  /** The prompt template (markdown body after frontmatter). */
  template: string;
}
