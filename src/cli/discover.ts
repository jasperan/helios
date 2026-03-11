/**
 * `helios discover [interests]` — background literature discovery mode.
 * Slowly browses papers and ingests findings into memory.
 * Runs until Ctrl+C.
 */

import { Effect, Option } from "effect";
import { Command, Args, Options } from "@effect/cli";

const interests = Args.text({ name: "interests" }).pipe(
  Args.withDescription("Research interests / topics to focus on"),
  Args.optional,
);

const delayOpt = Options.integer("delay").pipe(
  Options.withAlias("d"),
  Options.withDescription("Seconds between iterations (default: 60)"),
  Options.optional,
);

export const discover = Command.make(
  "discover",
  { interests, delay: delayOpt },
  ({ interests: interestsOpt, delay: delayOpt }) =>
    Effect.promise(async () => {
      const { createRuntime } = await import("../init.js");
      const { executeSkill } = await import("../skills/executor.js");

      const runtime = await createRuntime();

      if (!runtime.orchestrator.currentProvider) {
        process.stderr.write("No active provider. Authenticate first with 'helios auth login'.\n");
        runtime.cleanup();
        process.exit(1);
      }

      const skill = runtime.skillRegistry.get("discover");
      if (!skill) {
        process.stderr.write("discover skill not found.\n");
        runtime.cleanup();
        process.exit(1);
      }

      // Override delay if specified
      const delay = Option.getOrUndefined(delayOpt);
      if (delay !== undefined) {
        skill.config.delay_ms = delay * 1000;
      }

      const interestsText = Option.getOrUndefined(interestsOpt) ?? "general ML research";

      process.stderr.write(`Starting background discovery on: ${interestsText}\n`);
      process.stderr.write(`Delay between iterations: ${Math.round((skill.config.delay_ms ?? 60_000) / 1000)}s\n`);
      process.stderr.write(`Press Ctrl+C to stop.\n\n`);

      const abortController = new AbortController();
      process.on("SIGINT", () => abortController.abort());

      try {
        for await (const event of executeSkill(
          skill,
          { interests: interestsText },
          `Begin your background discovery on: ${interestsText}`,
          {
            orchestrator: runtime.orchestrator,
            allTools: runtime.orchestrator.getTools(),
            signal: abortController.signal,
          },
        )) {
          if (event.type === "text" && event.delta) {
            process.stdout.write(event.delta);
          }
          if (event.type === "error") {
            process.stderr.write(`\nError: ${event.error.message}\n`);
            if (!event.recoverable) break;
          }
          if (event.type === "done") {
            process.stdout.write("\n---\n");
          }
        }
      } finally {
        process.stdout.write("\n");
        runtime.cleanup();
      }
    }),
);
