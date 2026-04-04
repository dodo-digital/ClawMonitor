import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CheckResult = {
  workspaceId: string;
  checkType: string;
  targetKey: string;
  status: "healthy";
  severity: "info";
  summary: string;
  evidence: Record<string, never>;
  observedAt: string;
  dedupeKey: string;
  title: string;
};

function check(checkType: string): CheckResult {
  return {
    workspaceId: "default",
    checkType,
    targetKey: checkType,
    status: "healthy",
    severity: "info",
    summary: `${checkType} ok`,
    evidence: {},
    observedAt: "2026-04-03T00:00:00.000Z",
    dedupeKey: `default:${checkType}:healthy`,
    title: checkType,
  };
}

async function loadScheduler(options?: {
  gatewayResult?: Promise<CheckResult> | CheckResult;
  gatewayError?: Error;
  cronStatusResults?: CheckResult[];
  cronStalenessResults?: CheckResult[];
}) {
  const core = {
    runGatewayCheck: vi.fn().mockImplementation(async () => {
      if (options?.gatewayError) {
        throw options.gatewayError;
      }
      return await options?.gatewayResult ?? check("gateway.connection");
    }),
    runCronStatusChecks: vi.fn().mockResolvedValue(options?.cronStatusResults ?? [check("cron.job_status")]),
    runCronStalenessChecks: vi.fn().mockResolvedValue(options?.cronStalenessResults ?? [check("cron.job_staleness")]),
    runDiskCheck: vi.fn().mockResolvedValue(check("system.disk")),
    runAuthProfilesCheck: vi.fn().mockResolvedValue(check("auth.profile_integrity")),
    runExecSecurityCheck: vi.fn().mockResolvedValue(check("exec.security_config")),
  };

  const session = {
    runEventFlowCheck: vi.fn().mockReturnValue(check("events.flow")),
    runToolFailuresCheck: vi.fn().mockReturnValue(check("tools.failures")),
    runDeadRunsCheck: vi.fn().mockReturnValue(check("runs.dead")),
    runStuckRunsCheck: vi.fn().mockReturnValue(check("runs.stuck")),
    runRetryLoopsCheck: vi.fn().mockReturnValue(check("runs.retry_loops")),
    runAuthErrorsCheck: vi.fn().mockReturnValue(check("auth.errors")),
  };

  vi.doMock("../../monitor/checks/core.js", () => core);
  vi.doMock("../../monitor/checks/session.js", () => session);

  const { MonitorScheduler } = await import("../../monitor/scheduler.js");
  return { MonitorScheduler, core, session };
}

describe("MonitorScheduler", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T07:30:00.000Z"));
  });

  afterEach(() => {
    delete process.env.OPENCLAW_MONITOR_DIGEST_HOUR;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("waits for the startup grace period before running checks and keeps intervals active", async () => {
    const { MonitorScheduler, core, session } = await loadScheduler();
    const processCheck = vi.fn(async () => {});
    const scheduler = new MonitorScheduler({ processCheck } as never);

    scheduler.start();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(processCheck).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(core.runGatewayCheck).toHaveBeenCalledTimes(1);
    expect(session.runEventFlowCheck).toHaveBeenCalledTimes(1);
    expect(core.runCronStatusChecks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(core.runGatewayCheck).toHaveBeenCalledTimes(7);
    expect(session.runEventFlowCheck).toHaveBeenCalledTimes(3);
    expect(core.runCronStatusChecks).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("prevents overlapping executions for a task", async () => {
    let resolveGateway!: (value: CheckResult) => void;
    const pendingGateway = new Promise<CheckResult>((resolve) => {
      resolveGateway = resolve;
    });

    const { MonitorScheduler, core } = await loadScheduler({ gatewayResult: pendingGateway });
    const processCheck = vi.fn(async () => {});
    const scheduler = new MonitorScheduler({ processCheck } as never);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(core.runGatewayCheck).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(core.runGatewayCheck).toHaveBeenCalledTimes(1);

    resolveGateway(check("gateway.connection"));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(core.runGatewayCheck).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("schedules the daily digest and supports immediate dispatch", async () => {
    process.env.OPENCLAW_MONITOR_DIGEST_HOUR = "8";

    const { MonitorScheduler } = await loadScheduler();
    const processCheck = vi.fn(async () => {});
    const sendDailyDigest = vi.fn(async () => {});
    const scheduler = new MonitorScheduler({ processCheck } as never, { sendDailyDigest } as never);

    scheduler.start();
    expect(sendDailyDigest).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(sendDailyDigest).toHaveBeenCalledTimes(1);

    await scheduler.sendDigestNow();
    expect(sendDailyDigest).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(sendDailyDigest).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });

  it("continues running later checks when one task fails", async () => {
    const gatewayError = new Error("gateway down");
    const { MonitorScheduler } = await loadScheduler({
      gatewayError,
    });
    const processCheck = vi.fn(async () => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduler = new MonitorScheduler({ processCheck } as never);

    await scheduler.runAllNow();

    expect(processCheck).toHaveBeenCalledTimes(11);
    expect(errorSpy).toHaveBeenCalledWith("[monitor:gateway] check failed", gatewayError);
  });
});
