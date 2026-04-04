import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { collectWebSocketMessage, createTestPaths, removeTestPaths, setTestEnv, type TestPaths } from "../test-helpers.js";

async function listen(server: import("node:http").Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not bind to a TCP port");
  }
  return address.port;
}

describe("live feed bridge", () => {
  let paths: TestPaths;
  let gatewayServer: WebSocketServer;
  let gatewayPort: number;
  let dashboardServer: import("node:http").Server;
  let liveFeed: { close(): void } | null;
  let gatewayClients: WebSocket[];

  beforeEach(async () => {
    vi.resetModules();
    paths = createTestPaths("openclaw-live-feed-");
    gatewayClients = [];
    gatewayServer = new WebSocketServer({ port: 0 });
    await once(gatewayServer, "listening");
    const address = gatewayServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Gateway server did not bind");
    }
    gatewayPort = address.port;

    gatewayServer.on("connection", (socket) => {
      gatewayClients.push(socket);
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-1" } }));
      socket.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString()) as { type?: string; id?: string; method?: string };
        if (parsed.type === "req" && parsed.method === "connect" && parsed.id) {
          socket.send(JSON.stringify({ type: "res", ok: true, id: parsed.id }));
        }
      });
    });

    setTestEnv(paths, {
      OPENCLAW_GATEWAY_WS: `ws://127.0.0.1:${gatewayPort}`,
      OPENCLAW_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    });

    const { createHttpServer } = await import("../../index.js");
    const created = createHttpServer();
    dashboardServer = created.server;
    liveFeed = created.liveFeed;
    await listen(dashboardServer);
  });

  afterEach(async () => {
    liveFeed?.close();
    await new Promise((resolve) => dashboardServer.close(() => resolve(undefined)));
    await new Promise((resolve) => gatewayServer.close(() => resolve(undefined)));

    const dbModule = await import("../../lib/db.js");
    if (typeof dbModule.db !== "undefined") {
      dbModule.db.close();
    }
    await removeTestPaths(paths);
  });

  it("sends gateway status on connect", async () => {
    const address = dashboardServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Dashboard server did not bind");
    }

    const browser = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    await once(browser, "open");
    const message = JSON.parse(await collectWebSocketMessage(browser)) as { type: string; status: string };

    expect(message.type).toBe("gateway_status");
    expect(["connecting", "connected", "disconnected"]).toContain(message.status);

    browser.close();
  });

  it("rejects websocket upgrades outside /ws", async () => {
    const address = dashboardServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Dashboard server did not bind");
    }

    await expect(
      new Promise<void>((resolve, reject) => {
        const browser = new WebSocket(`ws://127.0.0.1:${address.port}/not-ws`);
        browser.once("open", () => reject(new Error("unexpected open")));
        browser.once("error", () => resolve());
      }),
    ).resolves.toBeUndefined();
  });

  it("applies client-side filters to gateway events", async () => {
    const address = dashboardServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Dashboard server did not bind");
    }

    const browser = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    await once(browser, "open");
    await collectWebSocketMessage(browser);

    const received: Array<Record<string, unknown>> = [];
    browser.on("message", (raw) => {
      received.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });

    browser.send(JSON.stringify({ type: "filter", agents: ["direct"] }));

    const gateway = gatewayClients[0];
    gateway.send(JSON.stringify({ agentId: "other", channel: "telegram", kind: "blocked" }));
    gateway.send(JSON.stringify({ agentId: "direct", channel: "telegram", kind: "allowed" }));

    await vi.waitFor(() => {
      expect(received.some((entry) => entry.kind === "allowed")).toBe(true);
    });
    expect(received.some((entry) => entry.kind === "blocked")).toBe(false);

    browser.close();
  });

  it("filters real gateway events by derived session metadata", async () => {
    const address = dashboardServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Dashboard server did not bind");
    }

    const browser = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    await once(browser, "open");
    await collectWebSocketMessage(browser);

    const received: Array<Record<string, unknown>> = [];
    browser.on("message", (raw) => {
      received.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });

    browser.send(JSON.stringify({ type: "filter", agents: ["direct"], channels: ["telegram"] }));

    const gateway = gatewayClients[0];
    gateway.send(JSON.stringify({
      type: "event",
      event: "agent",
      payload: {
        runId: "run-1",
        sessionKey: "agent:other:main",
        stream: "assistant",
        data: { text: "ignore me" },
      },
    }));
    gateway.send(JSON.stringify({
      type: "event",
      event: "agent",
      payload: {
        runId: "run-2",
        sessionKey: "agent:direct:telegram:group:-100:topic:1",
        stream: "assistant",
        data: { text: "allow me" },
      },
    }));

    await vi.waitFor(() => {
      expect(received.some((entry) => (entry.payload as { runId?: string } | undefined)?.runId === "run-2")).toBe(true);
    });
    expect(received.some((entry) => (entry.payload as { runId?: string } | undefined)?.runId === "run-1")).toBe(false);

    browser.close();
  });

  it("drops malformed gateway frames instead of relaying them", async () => {
    const address = dashboardServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Dashboard server did not bind");
    }

    const browser = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    await once(browser, "open");
    await collectWebSocketMessage(browser);

    const received: string[] = [];
    browser.on("message", (raw) => {
      received.push(raw.toString());
    });

    gatewayClients[0]?.send("{not-json");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toEqual([]);
    browser.close();
  });
});
