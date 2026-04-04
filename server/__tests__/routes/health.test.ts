import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createTestPaths, removeTestPaths, setTestEnv, type TestPaths } from "../test-helpers.js";

describe("health routes", () => {
  let paths: TestPaths;

  beforeEach(() => {
    vi.resetModules();
    paths = createTestPaths("openclaw-health-");
    setTestEnv(paths);
  });

  afterEach(async () => {
    const dbModule = await import("../../lib/db.js");
    if (typeof dbModule.db !== "undefined") {
      dbModule.db.close();
    }
    await removeTestPaths(paths);
  });

  it("returns a health envelope", async () => {
    const { createApp } = await import("../../index.js");
    const response = await request(createApp()).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      data: { status: "ok" },
    });
  });

  it("allows localhost and ts.net origins while rejecting lookalikes", async () => {
    const { createApp } = await import("../../index.js");
    const app = createApp();

    const localhost = await request(app).get("/api/health").set("Origin", "http://localhost:5173");
    expect(localhost.status).toBe(200);
    expect(localhost.headers["access-control-allow-origin"]).toBe("http://localhost:5173");

    const tailscale = await request(app).get("/api/health").set("Origin", "https://dashboard.demo.ts.net");
    expect(tailscale.status).toBe(200);
    expect(tailscale.headers["access-control-allow-origin"]).toBe("https://dashboard.demo.ts.net");

    const lookalike = await request(app).get("/api/health").set("Origin", "https://dashboard.demo.ts.net.evil.example");
    expect(lookalike.status).toBe(500);
    expect(lookalike.body).toEqual({
      ok: false,
      error: "Origin not allowed",
    });
  });
});
