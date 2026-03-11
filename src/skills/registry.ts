import type { Skill } from "./types.js";
import { discoverSkills } from "./loader.js";

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private projectDir?: string;

  constructor(projectDir?: string) {
    this.projectDir = projectDir;
  }

  /** Load (or reload) all skills from user + project dirs. */
  load(): void {
    this.skills.clear();
    for (const skill of discoverSkills(this.projectDir)) {
      this.skills.set(skill.name, skill);
    }
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  names(): string[] {
    return Array.from(this.skills.keys());
  }
}
