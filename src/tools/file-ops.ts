import type { ToolDefinition } from "../providers/types.js";
import type { ConnectionPool } from "../remote/connection-pool.js";
import { shellQuote, toolError } from "../ui/format.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const MAX_BINARY_SIZE = 10 * 1024 * 1024; // 10MB raw
const MAX_BINARY_OUTPUT = 14 * 1024 * 1024; // ~14MB for base64-encoded output

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

function getExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot).toLowerCase() : "";
}

export function createReadFileTool(pool: ConnectionPool): ToolDefinition {
  return {
    name: "read_file",
    description:
      "Read a file's contents. Supports text files (with line offset/limit), images (.png, .jpg, .jpeg, .gif, .webp), and PDFs (.pdf). For images and PDFs, returns visual content that you can see directly.",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: 'Machine to read from (use "local" for this machine)',
        },
        path: {
          type: "string",
          description: "Absolute path to the file",
        },
        offset: {
          type: "number",
          description: "Line number to start from (1-indexed, default: 1). Ignored for images/PDFs.",
        },
        limit: {
          type: "number",
          description: "Max lines to return (default: 200). Ignored for images/PDFs.",
        },
      },
      required: ["machine_id", "path"],
    },
    execute: async (args) => {
      const machineId = args.machine_id as string;
      const path = args.path as string;
      const ext = getExtension(path);

      // Binary file — base64 encode for multimodal viewing
      if (IMAGE_EXTENSIONS.has(ext) || PDF_EXTENSIONS.has(ext)) {
        const sizeResult = await pool.exec(machineId, `wc -c < ${shellQuote(path)}`);
        if (sizeResult.exitCode !== 0) {
          return toolError(sizeResult.stderr.trim() || `File not found: ${path}`);
        }
        const fileSize = parseInt(sizeResult.stdout.trim(), 10);
        if (isNaN(fileSize) || fileSize === 0) {
          return toolError("File is empty or not found");
        }
        if (fileSize > MAX_BINARY_SIZE) {
          return toolError(`File too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max for visual reading: 10MB.`);
        }

        const b64Result = await pool.exec(
          machineId,
          `base64 < ${shellQuote(path)}`,
          { maxOutput: MAX_BINARY_OUTPUT },
        );
        if (b64Result.exitCode !== 0) {
          return toolError(b64Result.stderr.trim() || "Failed to read file");
        }

        const mediaType = MIME_TYPES[ext] ?? "application/octet-stream";
        const data = b64Result.stdout.replace(/\s/g, "");
        const label = mediaType === "application/pdf" ? "PDF" : "Image";
        const filename = path.split("/").pop() ?? path;

        return JSON.stringify({
          __multimodal: true,
          text: `[${label}: ${filename} (${(fileSize / 1024).toFixed(1)}KB)]`,
          attachments: [{ mediaType, data }],
        });
      }

      // Text file — existing behavior
      const offset = (args.offset as number) ?? 1;
      const limit = (args.limit as number) ?? 200;
      const end = offset + limit - 1;
      const result = await pool.exec(
        machineId,
        `sed -n '${offset},${end}p' ${shellQuote(path)}`,
      );

      if (result.exitCode !== 0) {
        return toolError(result.stderr.trim() || `exit code ${result.exitCode}`);
      }

      // Count total lines for context
      const wcResult = await pool.exec(machineId, `wc -l < ${shellQuote(path)}`);
      const totalLines = parseInt(wcResult.stdout.trim(), 10) || 0;

      return JSON.stringify({
        content: result.stdout,
        lines: { from: offset, to: Math.min(end, totalLines), total: totalLines },
      });
    },
  };
}

export function createWriteFileTool(pool: ConnectionPool): ToolDefinition {
  return {
    name: "write_file",
    description:
      "Create or overwrite a file. Use this to write training scripts, configs, or data files.",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: 'Machine to write to (use "local" for this machine)',
        },
        path: {
          type: "string",
          description: "Absolute path for the file",
        },
        content: {
          type: "string",
          description: "Full file content to write",
        },
        append: {
          type: "boolean",
          description: "Append instead of overwrite (default: false)",
        },
      },
      required: ["machine_id", "path", "content"],
    },
    execute: async (args) => {
      const machineId = args.machine_id as string;
      const path = args.path as string;
      const content = args.content as string;
      const append = (args.append as boolean) ?? false;

      // Ensure parent directory exists
      const dir = path.replace(/\/[^/]+$/, "");
      if (dir && dir !== path) {
        await pool.exec(machineId, `mkdir -p ${shellQuote(dir)}`);
      }

      const op = append ? ">>" : ">";
      // Use heredoc to handle multi-line content safely
      // Heredoc implicitly adds a trailing newline, so strip one from content to avoid doubling
      const body = content.endsWith("\n") ? content.slice(0, -1) : content;
      const heredocTag = "_HELIOS_EOF_" + Math.random().toString(36).slice(2, 8);
      const result = await pool.exec(
        machineId,
        `cat ${op} ${shellQuote(path)} <<'${heredocTag}'\n${body}\n${heredocTag}`,
      );

      if (result.exitCode !== 0) {
        return toolError(result.stderr.trim() || `exit code ${result.exitCode}`);
      }

      const wcResult = await pool.exec(machineId, `wc -l < ${shellQuote(path)}`);
      const totalLines = parseInt(wcResult.stdout.trim(), 10) || 0;

      return JSON.stringify({ written: path, lines: totalLines });
    },
  };
}

export function createPatchFileTool(pool: ConnectionPool): ToolDefinition {
  return {
    name: "patch_file",
    description:
      "Edit a file by replacing a specific string with new content. Read the file first to see the exact text to match.",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: 'Machine where the file lives (use "local" for this machine)',
        },
        path: {
          type: "string",
          description: "Absolute path to the file",
        },
        old_string: {
          type: "string",
          description: "Exact text to find and replace (must appear exactly once in the file)",
        },
        new_string: {
          type: "string",
          description: "Replacement text",
        },
      },
      required: ["machine_id", "path", "old_string", "new_string"],
    },
    execute: async (args) => {
      const machineId = args.machine_id as string;
      const path = args.path as string;
      const oldStr = args.old_string as string;
      const newStr = args.new_string as string;

      // Read current file
      const readResult = await pool.exec(machineId, `cat ${shellQuote(path)}`);
      if (readResult.exitCode !== 0) {
        return toolError(readResult.stderr.trim() || "Failed to read file");
      }

      const content = readResult.stdout;
      const count = content.split(oldStr).length - 1;

      if (count === 0) {
        return toolError("old_string not found in file");
      }
      if (count > 1) {
        return toolError(`old_string found ${count} times — must be unique. Include more surrounding context.`);
      }

      const patched = content.replace(oldStr, newStr);

      // Write back using heredoc
      // Strip trailing newline since heredoc adds one implicitly
      const body = patched.endsWith("\n") ? patched.slice(0, -1) : patched;
      const heredocTag = "_HELIOS_EOF_" + Math.random().toString(36).slice(2, 8);
      const writeResult = await pool.exec(
        machineId,
        `cat > ${shellQuote(path)} <<'${heredocTag}'\n${body}\n${heredocTag}`,
      );

      if (writeResult.exitCode !== 0) {
        return toolError(writeResult.stderr.trim() || "Failed to write file");
      }

      return JSON.stringify({ patched: path });
    },
  };
}

