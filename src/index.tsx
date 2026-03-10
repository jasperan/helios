#!/usr/bin/env node

import React from "react";
import { withFullScreen } from "fullscreen-ink";
import { App } from "./app.js";
import { createMouseFilter } from "./ui/mouse-filter.js";
import { VERSION } from "./version.js";

// Parse CLI args
const args = process.argv.slice(2);
let providerArg: "claude" | "openai" | undefined;
let claudeModeArg: "cli" | "api" | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if ((arg === "--provider" || arg === "-p") && args[i + 1]) {
    const p = args[i + 1];
    if (p === "claude" || p === "openai") {
      providerArg = p;
    } else {
      console.error(`Unknown provider: ${p}. Use "claude" or "openai".`);
      process.exit(1);
    }
    i++;
  } else if (arg === "--claude-mode" && args[i + 1]) {
    const m = args[i + 1];
    if (m === "cli" || m === "api") {
      claudeModeArg = m;
    } else {
      console.error(`Unknown claude mode: ${m}. Use "cli" or "api".`);
      process.exit(1);
    }
    i++;
  } else if (arg === "--version" || arg === "-v" || arg === "-V") {
    console.log(`helios ${VERSION}`);
    process.exit(0);
  } else if (arg === "--help" || arg === "-h") {
    console.log(`
Helios ${VERSION} - Autonomous ML Research Agent

Usage: helios [options]

Options:
  -p, --provider <claude|openai>  Model provider (default: claude)
  --claude-mode <cli|api>         Force Claude auth mode (cli = Agent SDK, api = API key)
  -v, --version                   Show version
  -h, --help                      Show this help

Environment:
  ANTHROPIC_API_KEY  Claude API key (for Claude provider with API key auth)

Auth:
  Claude: Install \`claude\` CLI and run \`claude login\`, or set ANTHROPIC_API_KEY
  OpenAI: OAuth login via ChatGPT Plus/Pro on first run
`);
    process.exit(0);
  }
}

// Filter mouse escape sequences from stdin before Ink sees them
const { filteredStdin, mouseEmitter } = createMouseFilter(process.stdin);

// fullscreen-ink handles alternate screen buffer + cursor hiding
const { start, waitUntilExit } = withFullScreen(
  <App defaultProvider={providerArg} claudeMode={claudeModeArg} mouseEmitter={mouseEmitter} />,
  { exitOnCtrlC: false, stdin: filteredStdin as any },
);

await start();
await waitUntilExit();
process.exit(0);
