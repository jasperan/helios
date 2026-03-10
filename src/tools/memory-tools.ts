import type { ToolDefinition } from "../providers/types.js";
import type { MemoryStore } from "../memory/memory-store.js";

export function createMemoryLsTool(memory: MemoryStore): ToolDefinition {
  return {
    name: "memory_ls",
    description:
      "List children of a memory directory. Shows path + gist for each child. " +
      "This is the index — scan it to see what you have stored and decide what to read.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: 'Directory path to list (default: "/")',
        },
      },
    },
    execute: async (args) => {
      const path = (args.path as string) ?? "/";
      const nodes = memory.ls(path);

      if (nodes.length === 0) {
        return JSON.stringify({ path, children: [], note: "Empty directory" });
      }

      const children = nodes.map((n) => ({
        path: n.path,
        gist: n.gist,
        type: n.isDir ? "dir" : "file",
      }));

      return JSON.stringify({ path, children });
    },
  };
}

export function createMemoryReadTool(memory: MemoryStore): ToolDefinition {
  return {
    name: "memory_read",
    description:
      "Read the full content of a memory node. Use memory_ls first to find what you need, then read specific nodes.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path of the node to read",
        },
      },
      required: ["path"],
    },
    execute: async (args) => {
      const path = args.path as string;
      const node = memory.read(path);

      if (!node) {
        return JSON.stringify({ error: `Not found: ${path}` });
      }

      return JSON.stringify({
        path: node.path,
        gist: node.gist,
        content: node.content,
        type: node.isDir ? "dir" : "file",
        updated_at: node.updatedAt,
      });
    },
  };
}

export function createMemoryWriteTool(memory: MemoryStore): ToolDefinition {
  return {
    name: "memory_write",
    description:
      "Write or update a memory node. Parent directories are auto-created. " +
      "Use this to store observations, hypotheses, decisions, experiment notes — anything worth remembering. " +
      "The gist should be a short label (what this IS), the content is the full detail.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: 'Path for the node (e.g. "/observations/lr-warmup-helps")',
        },
        gist: {
          type: "string",
          description: "Short label/summary (the key in the KV pair, shown in tree listings)",
        },
        content: {
          type: "string",
          description: "Full content (the value). Omit to create a directory.",
        },
      },
      required: ["path", "gist"],
    },
    execute: async (args) => {
      const path = args.path as string;
      const gist = args.gist as string;
      const content = args.content as string | undefined;

      memory.write(path, gist, content);
      return JSON.stringify({ ok: true, path, gist });
    },
  };
}

export function createMemoryRmTool(memory: MemoryStore): ToolDefinition {
  return {
    name: "memory_rm",
    description:
      "Remove a memory node (and all children if it's a directory). Use this to clean up discarded experiments or outdated observations.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to remove",
        },
      },
      required: ["path"],
    },
    execute: async (args) => {
      const path = args.path as string;
      const removed = memory.rm(path);
      return JSON.stringify({ ok: true, path, removed_count: removed });
    },
  };
}

export function createMemoryTools(memory: MemoryStore): ToolDefinition[] {
  return [
    createMemoryLsTool(memory),
    createMemoryReadTool(memory),
    createMemoryWriteTool(memory),
    createMemoryRmTool(memory),
  ];
}
