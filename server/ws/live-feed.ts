import type { IncomingMessage } from "node:http";
import crypto from "node:crypto";
import os from "node:os";

import { WebSocket, WebSocketServer } from "ws";

import { env } from "../lib/env.js";
import { ingestGatewayEvent } from "../lib/event-ingester.js";
import { parseSessionKey } from "../lib/event-ingester.js";
import {
  recordGatewayAuthFailure,
  recordGatewayAuthSuccess,
  recordGatewayChallenge,
  recordGatewayClosed,
  recordGatewayConnected,
  recordGatewayConnecting,
  recordGatewayEventSeen,
} from "../monitor/runtime-state.js";

type BrowserFilter = {
  agents?: string[];
  channels?: string[];
};

type ClientState = {
  socket: WebSocket;
  filter: BrowserFilter;
};

type ParsedFeedMessage = {
  agentId?: string;
  channel?: string;
  type?: string;
  event?: string;
  payload?: {
    sessionKey?: string;
    id?: string;
    command?: string;
    args?: string[];
    cwd?: string;
    agentId?: string;
    resolvedPath?: string;
    timeoutMs?: number;
    decision?: string;
  };
};

// ---------------------------------------------------------------------------
// Exec Approval Tracking
// ---------------------------------------------------------------------------

export type PendingApproval = {
  id: string;
  command: string;
  args: string[];
  cwd: string | null;
  agentId: string | null;
  resolvedPath: string | null;
  receivedAt: number;
  timeoutMs: number | null;
};

type RpcCallback = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

export class LiveFeedBridge {
  private readonly clients = new Set<ClientState>();
  private browserServer: WebSocketServer | null = null;
  private gatewaySocket: WebSocket | null = null;
  private reconnectDelayMs = 1_000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private gatewayConnectRequestId: string | null = null;
  private gatewayStatus: "disconnected" | "connecting" | "connected" = "disconnected";

  // Exec approval tracking
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly rpcCallbacks = new Map<string, RpcCallback>();

  /**
   * Broadcast a synthetic event to all connected browser clients.
   * Used by the session ingester to push user messages and tool calls
   * that the gateway doesn't stream over WebSocket.
   */
  broadcastSynthetic(event: {
    type: string;
    event: string;
    payload: Record<string, unknown>;
  }): void {
    const raw = JSON.stringify(event);
    for (const client of this.clients) {
      client.socket.send(raw);
    }
  }

  getPendingApprovals(): PendingApproval[] {
    // Prune expired approvals
    const now = Date.now();
    for (const [id, approval] of this.pendingApprovals) {
      if (approval.timeoutMs && now - approval.receivedAt > approval.timeoutMs) {
        this.pendingApprovals.delete(id);
      }
    }
    return Array.from(this.pendingApprovals.values())
      .sort((a, b) => b.receivedAt - a.receivedAt);
  }

  async resolveApproval(id: string, decision: "allow-once" | "allow-always" | "deny"): Promise<boolean> {
    if (!this.gatewaySocket || this.gatewaySocket.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway not connected");
    }

    const requestId = crypto.randomUUID();
    const message = JSON.stringify({
      type: "req",
      id: requestId,
      method: "exec.approval.resolve",
      params: { id, decision },
    });

    return new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rpcCallbacks.delete(requestId);
        reject(new Error("Gateway RPC timeout"));
      }, 10_000);

      this.rpcCallbacks.set(requestId, {
        resolve: () => {
          clearTimeout(timeout);
          this.rpcCallbacks.delete(requestId);
          this.pendingApprovals.delete(id);
          resolve(true);
        },
        reject: (err) => {
          clearTimeout(timeout);
          this.rpcCallbacks.delete(requestId);
          reject(err);
        },
      });

      this.gatewaySocket!.send(message);
    });
  }

  attach(server: import("node:http").Server): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.browserServer = wss;

    server.on("upgrade", (request: IncomingMessage, socket, head) => {
      if (request.url !== "/ws") {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (clientSocket) => {
        const state: ClientState = { socket: clientSocket, filter: {} };
        this.clients.add(state);
        clientSocket.send(JSON.stringify({ type: "gateway_status", status: this.gatewayStatus }));

        clientSocket.on("message", (raw) => {
          try {
            const parsed = JSON.parse(raw.toString()) as { type?: string; agents?: string[]; channels?: string[] };
            if (parsed.type === "filter") {
              state.filter = {
                agents: Array.isArray(parsed.agents) ? parsed.agents.filter((value) => typeof value === "string") : [],
                channels: Array.isArray(parsed.channels)
                  ? parsed.channels.filter((value) => typeof value === "string")
                  : [],
              };
            }
          } catch {
            clientSocket.send(JSON.stringify({ type: "error", error: "Invalid filter message" }));
          }
        });

        clientSocket.on("close", () => {
          this.clients.delete(state);
        });
      });
    });

    this.connectGateway();
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const client of this.clients) {
      client.socket.close();
    }
    this.clients.clear();

    this.browserServer?.close();
    this.browserServer = null;

    this.gatewaySocket?.close();
    this.gatewaySocket = null;
    this.gatewayStatus = "disconnected";
    this.gatewayConnectRequestId = null;
  }

  private connectGateway(): void {
    if (this.gatewaySocket && this.gatewaySocket.readyState === WebSocket.OPEN) {
      return;
    }

    const socket = new WebSocket(env.gatewayWs, {
      headers: {
        Authorization: `Bearer ${env.gatewayToken}`,
      },
    });

    this.gatewaySocket = socket;

    socket.on("open", () => {
      this.reconnectDelayMs = 1_000;
      this.gatewayStatus = "connecting";
      recordGatewayConnecting();
      this.broadcastRaw(JSON.stringify({ type: "gateway_status", status: this.gatewayStatus }));
    });

    socket.on("message", (payload) => {
      const raw = payload.toString();
      const parsed = this.parseGatewayMessage(raw);
      if (!parsed) {
        return;
      }

      const maybeHandshake = this.handleGatewayHandshake(socket, parsed);
      if (maybeHandshake) {
        return;
      }

      // Handle RPC responses for our resolve calls
      if (this.handleRpcResponse(parsed)) {
        return;
      }

      // Track exec approval events
      this.handleApprovalEvent(parsed);

      // Ingest into SQLite
      ingestGatewayEvent(raw);
      recordGatewayEventSeen();

      for (const client of this.clients) {
        if (this.matchesFilter(parsed, client.filter)) {
          client.socket.send(raw);
        }
      }
    });

    socket.on("close", (code) => {
      this.gatewayStatus = "disconnected";
      recordGatewayClosed(code);
      this.broadcastRaw(JSON.stringify({ type: "gateway_status", status: this.gatewayStatus }));
      this.scheduleReconnect();
    });

    socket.on("error", () => {
      socket.close();
    });
  }

  private parseGatewayMessage(raw: string): ParsedFeedMessage | null {
    try {
      return JSON.parse(raw) as ParsedFeedMessage;
    } catch {
      return null;
    }
  }

  private handleGatewayHandshake(
    socket: WebSocket,
    parsed: ParsedFeedMessage & { event?: string; ok?: boolean; id?: string; payload?: { nonce?: string } },
  ): boolean {
    if (parsed.type === "event" && parsed.event === "connect.challenge" && parsed.payload?.nonce) {
      recordGatewayChallenge();
      const requestId = crypto.randomUUID();
      this.gatewayConnectRequestId = requestId;
      socket.send(
        JSON.stringify({
          type: "req",
          id: requestId,
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            auth: {
              token: env.gatewayToken,
            },
            client: {
              id: "openclaw-probe",
              version: "0.1.0",
              mode: "backend",
              platform: os.platform(),
              displayName: "OpenClaw Dashboard",
              instanceId: crypto.randomUUID(),
            },
          },
        }),
      );
      return true;
    }

    if (parsed.type === "res" && parsed.ok && parsed.id === this.gatewayConnectRequestId) {
      this.gatewayStatus = "connected";
      recordGatewayConnected();
      recordGatewayAuthSuccess();
      this.broadcastRaw(JSON.stringify({ type: "gateway_status", status: this.gatewayStatus }));
      this.gatewayConnectRequestId = null;
      return true;
    }

    if (parsed.type === "res" && !parsed.ok && parsed.id === this.gatewayConnectRequestId) {
      recordGatewayAuthFailure(parsed as Record<string, unknown>);
      return true;
    }

    return false;
  }

  private matchesFilter(parsed: ParsedFeedMessage, filter: BrowserFilter): boolean {
    if (!filter.agents?.length && !filter.channels?.length) {
      return true;
    }

    const sessionKey = parsed.payload?.sessionKey;
    const derived = sessionKey ? parseSessionKey(sessionKey) : null;
    const agentId = parsed.agentId ?? derived?.agentId;
    const channel = parsed.channel ?? derived?.channel;

    if (filter.agents?.length && (!agentId || !filter.agents.includes(agentId))) {
      return false;
    }
    if (filter.channels?.length && (!channel || !filter.channels.includes(channel))) {
      return false;
    }
    return true;
  }

  private handleApprovalEvent(parsed: ParsedFeedMessage): void {
    if (parsed.type !== "event" || !parsed.payload) return;

    if (parsed.event === "exec.approval.requested") {
      const p = parsed.payload;
      if (!p.id || !p.command) return;
      this.pendingApprovals.set(p.id, {
        id: p.id,
        command: p.command,
        args: p.args ?? [],
        cwd: p.cwd ?? null,
        agentId: p.agentId ?? null,
        resolvedPath: p.resolvedPath ?? null,
        receivedAt: Date.now(),
        timeoutMs: p.timeoutMs ?? null,
      });
    }

    if (parsed.event === "exec.approval.resolved") {
      const p = parsed.payload;
      if (p.id) {
        this.pendingApprovals.delete(p.id);
      }
    }
  }

  private handleRpcResponse(parsed: ParsedFeedMessage & { id?: string; ok?: boolean; error?: unknown }): boolean {
    if (parsed.type !== "res" || !parsed.id) return false;
    const callback = this.rpcCallbacks.get(parsed.id);
    if (!callback) return false;

    if (parsed.ok) {
      callback.resolve(parsed);
    } else {
      callback.reject(new Error(String(parsed.error ?? "RPC failed")));
    }
    return true;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectGateway();
    }, this.reconnectDelayMs);

    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
  }

  private broadcastRaw(raw: string): void {
    for (const client of this.clients) {
      client.socket.send(raw);
    }
  }
}
