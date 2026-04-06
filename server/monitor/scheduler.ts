import {
  runAuthProfilesCheck,
  runCronScheduleDriftChecks,
  runCronStalenessChecks,
  runCronStatusChecks,
  runDiskCheck,
  runExecSecurityCheck,
  runGatewayCheck,
  runPostUpdateCheck,
} from "./checks/core.js";
import { runSecurityScanCheck } from "./checks/security.js";
import {
  runAuthErrorsCheck,
  runDeadRunsCheck,
  runEventFlowCheck,
  runRetryLoopsCheck,
  runStuckRunsCheck,
  runToolErrorsCheck,
  runToolFailuresCheck,
} from "./checks/session.js";
import { IncidentProcessor } from "./incidents/processor.js";
import type { NotificationDispatcher } from "./notifications/dispatcher.js";

type SchedulerTask = {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
};

const STARTUP_GRACE_MS = 60_000;

export class MonitorScheduler {
  private readonly tasks: SchedulerTask[];
  private digestTimer: NodeJS.Timeout | null = null;
  private readonly dispatcher: NotificationDispatcher | null;

  constructor(private readonly processor: IncidentProcessor, dispatcher?: NotificationDispatcher) {
    this.dispatcher = dispatcher ?? null;
    this.tasks = [
      {
        name: "gateway",
        intervalMs: 10_000,
        timer: null,
        inFlight: false,
        run: async () => {
          await this.processor.processCheck(await runGatewayCheck());
        },
      },
      {
        name: "cron-status",
        intervalMs: 60_000,
        timer: null,
        inFlight: false,
        run: async () => {
          const results = await runCronStatusChecks();
          for (const result of results) {
            await this.processor.processCheck(result);
          }
        },
      },
      {
        name: "cron-staleness",
        intervalMs: 60_000,
        timer: null,
        inFlight: false,
        run: async () => {
          const results = await runCronStalenessChecks();
          for (const result of results) {
            await this.processor.processCheck(result);
          }
        },
      },
      {
        name: "cron-schedule-drift",
        intervalMs: 5 * 60_000, // Every 5 minutes — drift is less urgent than status
        timer: null,
        inFlight: false,
        run: async () => {
          const results = await runCronScheduleDriftChecks();
          for (const result of results) {
            await this.processor.processCheck(result);
          }
        },
      },
      {
        name: "post-update",
        intervalMs: 60_000, // Check every minute after an update
        timer: null,
        inFlight: false,
        run: async () => {
          const result = await runPostUpdateCheck();
          if (result) await this.processor.processCheck(result);
        },
      },
      {
        name: "disk",
        intervalMs: 60_000,
        timer: null,
        inFlight: false,
        run: async () => {
          await this.processor.processCheck(await runDiskCheck());
        },
      },
      {
        name: "auth-profiles",
        intervalMs: 5 * 60_000,
        timer: null,
        inFlight: false,
        run: async () => {
          await this.processor.processCheck(await runAuthProfilesCheck());
        },
      },
      {
        name: "exec-security",
        intervalMs: 5 * 60_000,
        timer: null,
        inFlight: false,
        run: async () => {
          await this.processor.processCheck(await runExecSecurityCheck());
        },
      },
      // --- Session-level checks ---
      {
        name: "event-flow",
        intervalMs: 30_000,
        timer: null,
        inFlight: false,
        run: async () => {
          await this.processor.processCheck(runEventFlowCheck());
        },
      },
      {
        name: "tool-failures",
        intervalMs: 60_000,
        timer: null,
        inFlight: false,
        run: async () => {
          await this.processor.processCheck(runToolFailuresCheck());
        },
      },
      {
        name: "tool-errors",
        intervalMs: 60_000,
        timer: null,
        inFlight: false,
        run: async () => {
          await this.processor.processCheck(runToolErrorsCheck());
        },
      },
      {
        name: "dead-runs",
        intervalMs: 60_000,
        timer: null,
        inFlight: false,
        run: async () => {
          await this.processor.processCheck(runDeadRunsCheck());
        },
      },
      {
        name: "stuck-runs",
        intervalMs: 60_000,
        timer: null,
        inFlight: false,
        run: async () => {
          await this.processor.processCheck(runStuckRunsCheck());
        },
      },
      {
        name: "retry-loops",
        intervalMs: 60_000,
        timer: null,
        inFlight: false,
        run: async () => {
          await this.processor.processCheck(runRetryLoopsCheck());
        },
      },
      {
        name: "auth-errors",
        intervalMs: 60_000,
        timer: null,
        inFlight: false,
        run: async () => {
          await this.processor.processCheck(runAuthErrorsCheck());
        },
      },
      // --- Incident escalation check ---
      {
        name: "escalation-check",
        intervalMs: 5 * 60_000,
        timer: null,
        inFlight: false,
        run: async () => {
          await this.processor.runEscalationCheck();
        },
      },
      // --- Security scan ---
      {
        name: "security-scan",
        intervalMs: 30 * 60_000,
        timer: null,
        inFlight: false,
        run: async () => {
          await this.processor.processCheck(await runSecurityScanCheck());
        },
      },
    ];
  }

  start(): void {
    console.log(`[monitor] Starting scheduler (${STARTUP_GRACE_MS / 1000}s grace period before first checks)`);
    setTimeout(() => {
      console.log("[monitor] Grace period complete — starting checks");
      for (const task of this.tasks) {
        void this.runTask(task);
        task.timer = setInterval(() => {
          void this.runTask(task);
        }, task.intervalMs);
      }
    }, STARTUP_GRACE_MS);

    this.scheduleDigest();
  }

  stop(): void {
    for (const task of this.tasks) {
      if (task.timer) {
        clearInterval(task.timer);
        task.timer = null;
      }
    }
    if (this.digestTimer) {
      clearTimeout(this.digestTimer);
      this.digestTimer = null;
    }
  }

  /** Send the daily digest immediately (for testing). */
  async sendDigestNow(): Promise<void> {
    if (this.dispatcher) {
      await this.dispatcher.sendDailyDigest();
    }
  }

  private scheduleDigest(): void {
    if (!this.dispatcher) return;

    const digestHour = Number(process.env.OPENCLAW_MONITOR_DIGEST_HOUR ?? "8");
    const msUntilNext = this.msUntilHour(digestHour);
    console.log(`[monitor] Daily digest scheduled for ${digestHour}:00 local (${Math.round(msUntilNext / 60_000)}m from now)`);

    this.digestTimer = setTimeout(() => {
      void this.runDigest();
      // After first fire, repeat every 24 hours
      this.digestTimer = setInterval(() => {
        void this.runDigest();
      }, 24 * 60 * 60_000);
    }, msUntilNext);
  }

  private async runDigest(): Promise<void> {
    console.log("[monitor] Sending daily digest");
    try {
      await this.dispatcher!.sendDailyDigest();
    } catch (error) {
      console.error("[monitor] Daily digest failed", error);
    }
  }

  private msUntilHour(hour: number): number {
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, 0, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime() - now.getTime();
  }

  async runAllNow(): Promise<void> {
    for (const task of this.tasks) {
      await this.runTask(task);
    }
  }

  private async runTask(task: SchedulerTask): Promise<void> {
    if (task.inFlight) {
      return;
    }

    task.inFlight = true;
    try {
      await task.run();
    } catch (error) {
      console.error(`[monitor:${task.name}] check failed`, error);
    } finally {
      task.inFlight = false;
    }
  }
}
