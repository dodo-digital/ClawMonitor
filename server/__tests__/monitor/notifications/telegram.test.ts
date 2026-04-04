import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TelegramDestination } from "../../../monitor/notifications/telegram.js";
import { makePayload } from "./fixtures.js";

describe("TelegramDestination", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("isEnabled returns false when token or chatId is null", () => {
    expect(new TelegramDestination(null, null).isEnabled()).toBe(false);
    expect(new TelegramDestination("token", null).isEnabled()).toBe(false);
    expect(new TelegramDestination(null, "chatId").isEnabled()).toBe(false);
  });

  it("isEnabled returns true when both are set", () => {
    expect(new TelegramDestination("token", "chatId").isEnabled()).toBe(true);
  });

  it("sends correctly formatted request to Telegram API", async () => {
    const dest = new TelegramDestination("bot123", "chat456");
    const result = await dest.send(makePayload());

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botbot123/sendMessage");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.chat_id).toBe("chat456");
    expect(body.parse_mode).toBe("MarkdownV2");
    expect(body.text).toContain("Incident opened");
  });

  it("returns failure result on non-ok response", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("bad request", { status: 400 }));

    const dest = new TelegramDestination("bot123", "chat456");
    const result = await dest.send(makePayload());

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.errorMessage).toContain("400");
  });

  it("returns failure result on network error", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const dest = new TelegramDestination("bot123", "chat456");
    const result = await dest.send(makePayload());

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("ECONNREFUSED");
  });

  it("returns failure when not configured", async () => {
    const dest = new TelegramDestination(null, null);
    const result = await dest.send(makePayload());

    expect(result.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
