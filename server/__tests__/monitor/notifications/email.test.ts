import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmailDestination } from "../../../monitor/notifications/email.js";
import { makePayload } from "./fixtures.js";

describe("EmailDestination", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("isEnabled returns false when endpoint or to is null", () => {
    expect(new EmailDestination(null, null, null, null).isEnabled()).toBe(false);
    expect(new EmailDestination("https://api.mail.com/send", null, null, null).isEnabled()).toBe(false);
    expect(new EmailDestination(null, null, null, "admin@example.com").isEnabled()).toBe(false);
  });

  it("isEnabled returns true when endpoint and to are set", () => {
    expect(new EmailDestination("https://api.mail.com/send", null, null, "admin@example.com").isEnabled()).toBe(true);
  });

  it("sends correctly formatted email request", async () => {
    const dest = new EmailDestination("https://api.mail.com/send", "key123", "monitor@claw.ai", "admin@example.com, ops@example.com");
    const result = await dest.send(makePayload());

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.mail.com/send");

    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer key123");

    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.from).toBe("monitor@claw.ai");
    expect(body.to).toEqual(["admin@example.com", "ops@example.com"]);
    expect(body.subject).toContain("INCIDENT");
    expect(body.subject).toContain("Disk usage critical");
    expect(body.text).toContain("Disk usage is at 98%");
  });

  it("uses default from address when not configured", async () => {
    const dest = new EmailDestination("https://api.mail.com/send", null, null, "admin@example.com");
    await dest.send(makePayload());

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.from).toBe("clawmonitor@localhost");
  });

  it("returns failure on non-ok response", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));

    const dest = new EmailDestination("https://api.mail.com/send", null, null, "admin@example.com");
    const result = await dest.send(makePayload());

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(429);
  });
});
