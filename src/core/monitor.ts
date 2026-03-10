import { EventEmitter } from "node:events";

export interface MonitorConfig {
  intervalMs: number;
  goal: string;
  startedAt: number;
}

export class MonitorManager extends EventEmitter {
  private config: MonitorConfig | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  get isActive(): boolean {
    return this.config !== null;
  }

  get currentConfig(): MonitorConfig | null {
    return this.config;
  }

  start(intervalMs: number, goal: string): MonitorConfig {
    if (this.config) {
      this.stop();
    }

    this.config = {
      intervalMs,
      goal,
      startedAt: Date.now(),
    };

    this.timer = setInterval(() => {
      if (this.config) {
        this.emit("tick", this.config);
      }
    }, intervalMs);

    this.emit("started", this.config);
    return this.config;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const was = this.config;
    this.config = null;
    if (was) {
      this.emit("stopped", was);
    }
  }
}
