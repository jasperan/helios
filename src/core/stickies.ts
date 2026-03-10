export interface StickyNote {
  num: number;
  text: string;
  createdAt: number;
}

/**
 * Manages sticky notes — persistent reminders injected into every model turn.
 * Notes are numbered starting from 1.
 */
export class StickyManager {
  private notes: StickyNote[] = [];
  private nextNum = 1;

  add(text: string): StickyNote {
    const note: StickyNote = {
      num: this.nextNum++,
      text,
      createdAt: Date.now(),
    };
    this.notes.push(note);
    return note;
  }

  remove(num: number): boolean {
    const idx = this.notes.findIndex((n) => n.num === num);
    if (idx === -1) return false;
    this.notes.splice(idx, 1);
    return true;
  }

  list(): StickyNote[] {
    return [...this.notes];
  }

  count(): number {
    return this.notes.length;
  }

  /** Format sticky notes for injection into the model's context. */
  formatForModel(): string | null {
    if (this.notes.length === 0) return null;

    const lines = this.notes.map(
      (n) => `  [${n.num}] ${n.text}`,
    );

    return [
      "⚠️ STICKY NOTES — The user has pinned the following reminders. Keep these at the forefront of your thinking at ALL times:",
      ...lines,
    ].join("\n");
  }
}
