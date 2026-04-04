import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeSignature, WebhookDestination } from "../../../monitor/notifications/webhook.js";
import { makePayload } from "./fixtures.js";

describe("WebhookDestination", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("isEnabled returns false when URL is null", () => {
    expect(new WebhookDestination(null, null).isEnabled()).toBe(false);
  });

  it("isEnabled returns true when URL is set (secret optional)", () => {
    expect(new WebhookDestination("https://example.com/hook", null).isEnabled()).toBe(true);
    expect(new WebhookDestination("https://example.com/hook", "secret").isEnabled()).toBe(true);
  });

  it("sends JSON payload with correct headers", async () => {
    const dest = new WebhookDestination("https://example.com/hook", null);
    const result = await dest.send(makePayload());

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://example.com/hook");

    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-ClawMonitor-Event"]).toBe("opened");
    expect(headers["X-ClawMonitor-Timestamp"]).toBeDefined();
    // No signature header when secret is null
    expect(headers["X-ClawMonitor-Signature"]).toBeUndefined();

    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.eventType).toBe("opened");
    expect(body.incident.id).toBe(1);
    expect(body.check.checkType).toBe("system.disk");
  });

  it("includes HMAC signature when secret is set", async () => {
    const dest = new WebhookDestination("https://example.com/hook", "my-secret");
    await dest.send(makePayload());

    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-ClawMonitor-Signature"]).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it("computeSignature produces correct HMAC", () => {
    const signature = computeSignature("secret", "1234567890", '{"test":true}');
    const expected = crypto.createHmac("sha256", "secret").update('1234567890.{"test":true}').digest("hex");
    expect(signature).toBe(expected);
  });

  it("signature can be verified by the receiver", async () => {
    const secret = "webhook-secret-123";
    const dest = new WebhookDestination("https://example.com/hook", secret);
    await dest.send(makePayload());

    const options = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    const body = options.body as string;
    const timestamp = headers["X-ClawMonitor-Timestamp"];
    const receivedSig = headers["X-ClawMonitor-Signature"].replace("sha256=", "");

    // Receiver-side verification
    const expectedSig = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    expect(receivedSig).toBe(expectedSig);
  });

  it("returns failure on non-ok response", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("server error", { status: 500 }));

    const dest = new WebhookDestination("https://example.com/hook", null);
    const result = await dest.send(makePayload());

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(500);
  });

  it("returns failure on network error", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Connection refused"));

    const dest = new WebhookDestination("https://example.com/hook", null);
    const result = await dest.send(makePayload());

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("Connection refused");
  });
});
