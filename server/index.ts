import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
// restart trigger: 2026-04-02

import cors from "cors";
import express, { type Express } from "express";

import { DIST_DIR } from "./lib/constants.js";
import { initializeDatabaseFromEnv, seedInitialIdentityVersions } from "./lib/db.js";
import { startSessionIngester, setLiveEntryCallback } from "./lib/session-ingester.js";
import { env } from "./lib/env.js";
import { errorHandler, notFoundHandler } from "./lib/http.js";
import { IncidentProcessor } from "./monitor/incidents/processor.js";
import { NotificationDispatcher } from "./monitor/notifications/dispatcher.js";
import { EmailDestination } from "./monitor/notifications/email.js";
import { SlackDestination } from "./monitor/notifications/slack.js";
import { TelegramDestination } from "./monitor/notifications/telegram.js";
import { WebhookDestination } from "./monitor/notifications/webhook.js";
import { MonitorScheduler } from "./monitor/scheduler.js";
import { agentsRouter } from "./routes/agents.js";
import { analyticsRouter } from "./routes/analytics.js";
import { bootstrapRouter } from "./routes/bootstrap.js";
import { cronRouter } from "./routes/cron.js";
import { healthRouter } from "./routes/health.js";
import { memoryRouter } from "./routes/memory.js";
import { monitorRouter } from "./routes/monitor.js";
import { sessionsRouter } from "./routes/sessions.js";
import { pluginsRouter } from "./routes/plugins.js";
import { skillsRouter } from "./routes/skills.js";
import { systemRouter } from "./routes/system.js";
import { LiveFeedBridge } from "./ws/live-feed.js";

const ALLOWED_TAILSCALE_ORIGIN_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*ts\.net(?::\d+)?$/i;
const ALLOWED_TAILSCALE_MAGIC_RE = /^https?:\/\/[a-z0-9-]+(?::\d+)?$/i;

export function createApp(): Express {
  initializeDatabaseFromEnv();

  const app = express();

  app.use(
    cors({
      origin(origin, callback) {
        if (
          !origin ||
          /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
          ALLOWED_TAILSCALE_ORIGIN_RE.test(origin) ||
          ALLOWED_TAILSCALE_MAGIC_RE.test(origin)
        ) {
          callback(null, true);
          return;
        }
        callback(new Error("Origin not allowed"));
      },
    }),
  );
  app.use(express.json({ limit: "256kb" }));

  app.use("/api", healthRouter);
  app.use("/api/system", systemRouter);
  app.use("/api/bootstrap", bootstrapRouter);
  app.use("/api/sessions", sessionsRouter);
  app.use("/api/cron", cronRouter);
  app.use("/api/memory", memoryRouter);
  app.use("/api/agents", agentsRouter);
  app.use("/api/skills", skillsRouter);
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/plugins", pluginsRouter);
  app.use("/api/monitor", monitorRouter);

  if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
  }

  app.use((_req, res, next) => {
    const indexPath = path.join(DIST_DIR, "index.html");
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
      return;
    }
    next();
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export function createHttpServer(options: { attachLiveFeed?: boolean } = {}): {
  app: Express;
  server: http.Server;
  liveFeed: LiveFeedBridge | null;
  monitorScheduler: MonitorScheduler;
} {
  const app = createApp();
  const server = http.createServer(app);
  const liveFeed = options.attachLiveFeed === false ? null : new LiveFeedBridge();
  const dispatcher = new NotificationDispatcher(env.monitorMode);
  dispatcher.register(new TelegramDestination(env.monitorTelegramBotToken, env.monitorTelegramChatId, env.monitorTelegramTopicId));
  dispatcher.register(new SlackDestination(env.monitorSlackWebhookUrl));
  dispatcher.register(new EmailDestination(env.monitorEmailEndpoint, env.monitorEmailApiKey, env.monitorEmailFrom, env.monitorEmailTo));
  dispatcher.register(new WebhookDestination(env.monitorWebhookUrl, env.monitorWebhookSecret));
  const incidentProcessor = new IncidentProcessor(dispatcher.toHandler());
  const monitorScheduler = new MonitorScheduler(incidentProcessor, dispatcher);

  // Make liveFeed and scheduler accessible to routes via app.locals
  app.locals.liveFeed = liveFeed;
  app.locals.monitorScheduler = monitorScheduler;

  liveFeed?.attach(server);

  return { app, server, liveFeed, monitorScheduler };
}

export function startServer(options: { attachLiveFeed?: boolean; startIngester?: boolean } = {}): http.Server {
  const { server, liveFeed, monitorScheduler } = createHttpServer({ attachLiveFeed: options.attachLiveFeed });
  seedInitialIdentityVersions(env.workspaceDir);

  server.listen(env.port, () => {
    console.log(`OpenClaw dashboard backend listening on http://localhost:${env.port}`);
    monitorScheduler.start();
    if (options.startIngester !== false) {
      // Wire session ingester to broadcast new entries through the live feed
      if (liveFeed) {
        setLiveEntryCallback((entry) => {
          liveFeed.broadcastSynthetic({
            type: "event",
            event: "session",
            payload: {
              stream: entry.kind,
              sessionKey: entry.sessionKey,
              entryId: entry.entryId,
              ts: new Date(entry.timestamp).getTime(),
              data: {
                text: entry.text,
                sender: entry.sender,
                toolName: entry.toolName,
                agentId: entry.agentId,
                channel: entry.channel,
              },
            },
          });
        });
      }
      startSessionIngester().catch((err) => console.error("[session-ingester] Failed to start:", err));
    }
  });

  server.on("close", () => {
    monitorScheduler.stop();
  });

  return server;
}

function isMainModule(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  startServer();
}
