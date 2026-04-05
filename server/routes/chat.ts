import { Router } from "express";

import { env } from "../lib/env.js";
import { asyncHandler } from "../lib/http.js";
import { HttpError } from "../lib/errors.js";

export const chatRouter = Router();

/**
 * Proxy chat completions to the OpenClaw gateway.
 * Supports streaming (SSE) and non-streaming modes.
 */
chatRouter.post(
  "/completions",
  asyncHandler(async (req, res) => {
    const { messages, model, stream } = req.body as {
      messages?: Array<{ role: string; content: string }>;
      model?: string;
      stream?: boolean;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      throw new HttpError("messages array is required", 400);
    }

    const gatewayUrl = `${env.gatewayUrl}/v1/chat/completions`;

    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.gatewayToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model ?? "openclaw/acp-clawmonitor",
        messages,
        stream: stream ?? true,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new HttpError(`Gateway error: ${response.status} ${body.slice(0, 200)}`, response.status);
    }

    if (stream !== false && response.body) {
      // Pipe the SSE stream straight through
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } finally {
        reader.releaseLock();
        res.end();
      }
    } else {
      const data = await response.json();
      res.json(data);
    }
  }),
);

/** List available models from the gateway. */
chatRouter.get(
  "/models",
  asyncHandler(async (_req, res) => {
    try {
      const response = await fetch(`${env.gatewayUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${env.gatewayToken}` },
      });
      const data = await response.json();
      res.json(data);
    } catch {
      res.json({ data: [] });
    }
  }),
);
