import { MemoryStore, type MemoryNode } from "./memory-store.js";

const GLOBAL_SESSION_ID = "__global__";
const GLOBAL_PREFIX = "/global/";

/**
 * Routes memory operations: paths starting with /global/ go to a shared
 * global store, everything else goes to the session-scoped store.
 *
 * The global store persists across sessions — it's where the agent stores
 * priors, paper summaries, dataset info, environment snapshots, and anything
 * that should survive beyond a single experiment session.
 *
 * Implements the same interface as MemoryStore so it's a drop-in replacement.
 */
export class GlobalMemoryRouter extends MemoryStore {
  private global: MemoryStore;

  constructor(sessionId: string) {
    super(sessionId);
    this.global = new MemoryStore(GLOBAL_SESSION_ID);
  }

  private isGlobal(path: string): boolean {
    return path === "/global/" || path === "/global" || path.startsWith(GLOBAL_PREFIX);
  }

  /** Strip /global prefix so the global store sees paths like /papers/foo. */
  private toGlobalPath(path: string): string {
    if (path === "/global/" || path === "/global") return "/";
    return path.slice(GLOBAL_PREFIX.length - 1); // "/global/papers/x" → "/papers/x"
  }

  /** Add /global prefix back to paths from the global store. */
  private fromGlobalPath(path: string): string {
    if (path === "/") return "/global/";
    return "/global" + path; // "/papers/x" → "/global/papers/x"
  }

  private mapNode(node: MemoryNode): MemoryNode {
    return { ...node, path: this.fromGlobalPath(node.path) };
  }

  // ─── Overrides ─────────────────────────────────────

  override ls(dirPath = "/"): MemoryNode[] {
    if (dirPath === "/") {
      // At root, merge session children + a synthetic /global/ entry
      const sessionChildren = super.ls("/");
      const globalChildren = this.global.ls("/").map((n) => this.mapNode(n));

      // If global store has anything, add /global/ as a virtual directory
      const hasGlobalContent = this.global.count() > 0;
      const hasGlobalDir = sessionChildren.some((n) => n.path === "/global/");

      if (hasGlobalContent && !hasGlobalDir) {
        const globalDir: MemoryNode = {
          path: "/global/",
          gist: "shared knowledge (persists across sessions)",
          content: null,
          isDir: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        return [globalDir, ...sessionChildren.filter((n) => !n.path.startsWith("/global"))];
      }
      return sessionChildren;
    }

    if (this.isGlobal(dirPath)) {
      return this.global.ls(this.toGlobalPath(dirPath)).map((n) => this.mapNode(n));
    }
    return super.ls(dirPath);
  }

  override tree(dirPath = "/"): Array<{ path: string; gist: string; isDir: boolean }> {
    if (dirPath === "/" || dirPath === "") {
      // Merge session tree + global tree (prefixed)
      const sessionTree = super.tree("/");
      const globalTree = this.global.tree("/").map((n) => ({
        ...n,
        path: this.fromGlobalPath(n.path),
      }));
      // Insert global entries, sorted
      return [...globalTree, ...sessionTree].sort((a, b) => a.path.localeCompare(b.path));
    }

    if (this.isGlobal(dirPath)) {
      return this.global.tree(this.toGlobalPath(dirPath)).map((n) => ({
        ...n,
        path: this.fromGlobalPath(n.path),
      }));
    }
    return super.tree(dirPath);
  }

  override read(path: string): MemoryNode | null {
    if (this.isGlobal(path)) {
      const node = this.global.read(this.toGlobalPath(path));
      return node ? this.mapNode(node) : null;
    }
    return super.read(path);
  }

  override write(path: string, gist: string, content?: string | null): void {
    if (this.isGlobal(path)) {
      this.global.write(this.toGlobalPath(path), gist, content);
      return;
    }
    super.write(path, gist, content);
  }

  override rm(path: string): number {
    if (this.isGlobal(path)) {
      return this.global.rm(this.toGlobalPath(path));
    }
    return super.rm(path);
  }

  override exists(path: string): boolean {
    if (this.isGlobal(path)) {
      return this.global.exists(this.toGlobalPath(path));
    }
    return super.exists(path);
  }

  override count(): number {
    return super.count() + this.global.count();
  }

  override formatTree(dirPath = "/"): string {
    const nodes = this.tree(dirPath);
    if (nodes.length === 0) return "(empty)";

    const lines: string[] = [];
    for (const node of nodes) {
      const parts = node.path.split("/").filter(Boolean);
      const depth = parts.length - 1;
      const indent = "  ".repeat(depth);
      const name = parts[parts.length - 1] + (node.isDir ? "/" : "");
      lines.push(`${indent}${name}: ${node.gist}`);
    }
    return lines.join("\n");
  }
}
