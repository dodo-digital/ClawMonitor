import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SlackDestination } from "../../../monitor/notifications/slack.js";
import { makePayload } from "./fixtures.js";

describe("SlackDestination", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("isEnabled returns false when webhook URL is null", () => {
    expect(new SlackDestination(null).isEnabled()).toBe(false);
  });

  it("isEnabled returns true when webhook URL is set", () => {
    expect(new SlackDestination("https://hooks.slack.com/test").isEnabled()).toBe(true);
  });

  it("sends Block Kit payload to webhook URL", async () => {
    const dest = new SlackDestination("https://hooks.slack.com/test");
    const result = await dest.send(makePayload());

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/test");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.blocks).toBeInstanceOf(Array);
    expect(body.blocks[0].type).toBe("header");
    expect(body.blocks[0].text.text).toContain("Incident Opened");
  });

  it("returns failure on non-ok response", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("invalid_token", { status: 403 }));

    const dest = new SlackDestination("https://hooks.slack.com/test");
    const result = await dest.send(makePayload());

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it("returns failure on network error", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("DNS resolution failed"));

    const dest = new SlackDestination("https://hooks.slack.com/test");
    const result = await dest.send(makePayload());

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("DNS resolution failed");
  });
});
