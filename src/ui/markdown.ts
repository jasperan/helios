import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

function buildTerminalOptions(width: number): Record<string, unknown> {
  return {
    firstHeading: (text: string) => `\x1b[1;33m${text}\x1b[0m`,
    heading: (text: string) => `\x1b[33m${text}\x1b[0m`,
    strong: (text: string) => `\x1b[1;37m${text}\x1b[0m`,
    em: (text: string) => `\x1b[3;33m${text}\x1b[0m`,
    codespan: (code: string) => `\x1b[33;48;5;236m ${code} \x1b[0m`,
    code: (code: string) => `\x1b[90m${"─".repeat(40)}\x1b[0m\n${code}\n\x1b[90m${"─".repeat(40)}\x1b[0m`,
    listitem: (text: string) => `  \x1b[33m▹\x1b[0m ${text}`,
    hr: () => `\x1b[33m${"━".repeat(40)}\x1b[0m`,
    link: (href: string, _title: string, text: string) =>
      `\x1b[4;33m${text}\x1b[0m (${href})`,
    blockquote: (text: string) => `\x1b[33m┃\x1b[0m ${text}`,
    width,
    tableOptions: {
      chars: {
        top: "─",
        "top-mid": "┬",
        "top-left": "┌",
        "top-right": "┐",
        bottom: "─",
        "bottom-mid": "┴",
        "bottom-left": "└",
        "bottom-right": "┘",
        left: "│",
        "left-mid": "├",
        mid: "─",
        "mid-mid": "┼",
        right: "│",
        "right-mid": "┤",
        middle: "│",
      },
      wordWrap: true,
      wrapOnWordBoundary: true,
    },
    reflowText: true,
    showSectionPrefix: false,
    tab: 2,
  };
}

// Cache the Marked instance keyed by width to avoid re-creating on every render
let cachedWidth = 0;
let cachedMarked: Marked | null = null;

function getMarked(width: number): Marked {
  if (cachedMarked && cachedWidth === width) return cachedMarked;
  cachedWidth = width;
  cachedMarked = new Marked();
  cachedMarked.use(markedTerminal(buildTerminalOptions(width)) as Parameters<Marked["use"]>[0]);
  return cachedMarked;
}

/**
 * Render markdown string to styled terminal text.
 * Returns plain string with ANSI escape codes.
 * Accepts optional width for table/text reflow (defaults to terminal width).
 */
export function renderMarkdown(input: string, width?: number): string {
  if (!input) return "";
  const w = width ?? process.stdout.columns ?? 80;
  const m = getMarked(w);
  const result = m.parse(input) as string;
  // Trim trailing newlines that marked adds
  return result.replace(/\n+$/, "");
}
