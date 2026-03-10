import { EventEmitter } from "node:events";
import type {
  Trigger,
  TriggerExpression,
  TriggerCondition,
  SleepSession,
  DEFAULT_POLL_INTERVALS,
} from "./triggers/types.js";
import { SSHBatcher } from "./ssh-batcher.js";
import type { ConnectionPool } from "../remote/connection-pool.js";
import { evaluateTimer } from "./triggers/timer.js";
import { evaluateProcessExit } from "./triggers/process-exit.js";
import { evaluateMetric } from "./triggers/metric.js";
import { evaluateFile } from "./triggers/file.js";
import { evaluateResource } from "./triggers/resource.js";

interface TriggerSchedulerEvents {
  wake: [session: SleepSession, reason: string];
  "trigger-update": [trigger: Trigger];
  error: [error: Error, trigger: Trigger];
}

export class TriggerScheduler extends EventEmitter {
  private sessions = new Map<string, SleepSession>();
  private evaluationTimer: NodeJS.Timeout | null = null;
  private batcher: SSHBatcher;
  private baseIntervalMs = 1000;

  constructor(private pool: ConnectionPool) {
    super();
    this.batcher = new SSHBatcher(pool);
  }

  start(session: SleepSession): void {
    this.sessions.set(session.id, session);
    session.trigger.status = "active";

    if (!this.evaluationTimer) {
      this.scheduleNextCycle();
    }
  }

  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.trigger.status = "cancelled";
      this.sessions.delete(sessionId);
    }

    if (this.sessions.size === 0 && this.evaluationTimer) {
      clearTimeout(this.evaluationTimer);
      this.evaluationTimer = null;
    }
  }

  /** Stop all evaluation cycles and clear sessions. Used on app shutdown. */
  stopAll(): void {
    if (this.evaluationTimer) {
      clearTimeout(this.evaluationTimer);
      this.evaluationTimer = null;
    }
    this.sessions.clear();
  }

  /** Handle user input event — wakes any sleeping session */
  onUserMessage(): void {
    for (const [id, session] of this.sessions) {
      session.wakeReason = "user_interrupt";
      session.wokeAt = Date.now();
      session.trigger.status = "satisfied";
      this.sessions.delete(id);
      this.emit("wake", session, "User sent a message");
    }
  }

  private scheduleNextCycle(): void {
    this.evaluationTimer = setTimeout(
      () => this.evaluationCycle(),
      this.baseIntervalMs,
    );
  }

  private async evaluationCycle(): Promise<void> {
    const now = Date.now();

    for (const [id, session] of this.sessions) {
      const trigger = session.trigger;

      // Check deadline
      if (trigger.deadline && now >= trigger.deadline) {
        trigger.status = "expired";
        session.wakeReason = "deadline";
        session.wokeAt = now;
        this.sessions.delete(id);
        this.emit("wake", session, "Deadline reached");
        continue;
      }

      try {
        const satisfied = await this.evaluate(
          trigger.expression,
          "root",
          trigger,
        );
        trigger.lastEvaluatedAt = now;

        if (satisfied) {
          trigger.status = "satisfied";
          trigger.satisfiedAt = now;
          session.wakeReason = "trigger_satisfied";
          session.wokeAt = now;
          this.sessions.delete(id);
          this.emit("wake", session, this.describeTrigger(trigger));
        }

        this.emit("trigger-update", trigger);
      } catch (err) {
        trigger.lastError =
          err instanceof Error ? err.message : String(err);
        this.emit(
          "error",
          err instanceof Error ? err : new Error(String(err)),
          trigger,
        );
      }
    }

    if (this.sessions.size > 0) {
      this.scheduleNextCycle();
    } else if (this.evaluationTimer) {
      clearTimeout(this.evaluationTimer);
      this.evaluationTimer = null;
    }
  }

  private async evaluate(
    expr: TriggerExpression,
    path: string,
    trigger: Trigger,
  ): Promise<boolean> {
    if ("op" in expr) {
      // Composite trigger
      const children = expr.children ?? [];
      if (children.length === 0) return expr.op === "and";
      const results = await Promise.all(
        children.map((child, i) =>
          this.evaluate(child, `${path}.${i}`, trigger),
        ),
      );
      return expr.op === "and"
        ? results.every(Boolean)
        : results.some(Boolean);
    }

    // Check if already satisfied (latching for AND)
    if (trigger.satisfiedLeaves.has(path)) return true;

    const satisfied = await this.evaluateCondition(expr);
    if (satisfied) {
      trigger.satisfiedLeaves.add(path);
    }
    return satisfied;
  }

  private async evaluateCondition(
    condition: TriggerCondition,
  ): Promise<boolean> {
    switch (condition.kind) {
      case "timer":
        return evaluateTimer(condition);
      case "process_exit":
        return evaluateProcessExit(condition, this.pool);
      case "metric":
        return evaluateMetric(condition, this.pool);
      case "file":
        return evaluateFile(condition, this.pool);
      case "resource":
        return evaluateResource(condition, this.pool);
      case "user_message":
        return false; // Handled via onUserMessage()
    }
  }

  private describeTrigger(trigger: Trigger): string {
    const leaves = Array.from(trigger.satisfiedLeaves).join(", ");
    return `Trigger satisfied (conditions: ${leaves}). Reason: ${trigger.sleepReason}`;
  }

  get activeSessions(): SleepSession[] {
    return Array.from(this.sessions.values());
  }
}
