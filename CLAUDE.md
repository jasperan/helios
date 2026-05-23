# Helios

Autonomous ML research agent TUI. Runs a self-directed loop: plan experiments, launch them (locally or over SSH), parse metrics, compare runs, iterate until a goal is met. Supports Claude, OpenAI, and vLLM providers.

## Stack

- **Runtime**: Node.js 20+, TypeScript (ES2022, NodeNext modules)
- **UI**: Ink (React-based terminal UI) + fullscreen-ink
- **LLM providers**: `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`
- **Storage**: SQLite via `better-sqlite3` (`~/.helios/helios.db`)
- **SSH**: `ssh2`
- **Testing**: Vitest
- **Effects**: `effect` + `@effect/cli`

## Commands

```bash
npm run dev        # tsx src/bootstrap.ts — run without building
npm run build      # tsc + copy bundled skills to dist/
npm start          # node dist/bootstrap.js
npm test           # vitest run
npm run test:watch # vitest (watch mode)
```

## Layout

```
src/
  bootstrap.ts          Entry point
  app.tsx               Root Ink component
  cli/                  CLI subcommands (auth, sessions, watch, replay, etc.)
  core/                 Orchestrator, state machine, monitor, stickies
  tools/                Agent tool implementations (remote-exec, memory, metrics, etc.)
  providers/            LLM provider types, SSE streaming, retry logic
  memory/               Context gate, memory store, experiment tracker, token estimator
  metrics/              Metric parser, store, analyzer, resource tracking
  remote/               SSH executor, connection pool, file sync
  scheduler/            Sleep manager, trigger scheduler, SSH batcher
  skills/               Skill loader, executor, registry
  subagent/             Subagent manager and scoped memory
  store/                SQLite database, session store, migrations, preferences
  hub/                  AgentHub collaboration client
  experiments/          Git-based experiment branching
  ui/                   Theme, layout, markdown renderer, command handling
  acp/                  Agent communication protocol (server/transport)
```

## Conventions

- Strict TypeScript; all files under `src/`, compiled to `dist/`
- Module system: ESM throughout (`"type": "module"`)
- Tests co-located with source (`*.test.ts`) or in `src/__tests__/`
- Zod used for schema validation (provider types, config, tool inputs)
- Data stored in `~/.helios/`; project config in `helios.json` (walk up from cwd)
- Skills are Markdown files in `~/.helios/skills/` or `.helios/skills/` (project-local)
