import dotenv from "dotenv";

import { DEFAULT_PORT } from "./constants.js";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? DEFAULT_PORT),
  gatewayUrl: requireEnv("OPENCLAW_GATEWAY_URL"),
  gatewayWs: requireEnv("OPENCLAW_GATEWAY_WS"),
  gatewayToken: requireEnv("OPENCLAW_GATEWAY_TOKEN"),
  openclawHome: requireEnv("OPENCLAW_HOME"),
  workspaceDir: requireEnv("OPENCLAW_WORKSPACE"),
  monitorTelegramBotToken: process.env.OPENCLAW_MONITOR_TELEGRAM_BOT_TOKEN ?? null,
  monitorTelegramChatId: process.env.OPENCLAW_MONITOR_TELEGRAM_CHAT_ID ?? null,
  monitorTelegramTopicId: process.env.OPENCLAW_MONITOR_TELEGRAM_TOPIC_ID ?? null,
  monitorSlackWebhookUrl: process.env.OPENCLAW_MONITOR_SLACK_WEBHOOK_URL ?? null,
  monitorEmailEndpoint: process.env.OPENCLAW_MONITOR_EMAIL_ENDPOINT ?? null,
  monitorEmailApiKey: process.env.OPENCLAW_MONITOR_EMAIL_API_KEY ?? null,
  monitorEmailFrom: process.env.OPENCLAW_MONITOR_EMAIL_FROM ?? null,
  monitorEmailTo: process.env.OPENCLAW_MONITOR_EMAIL_TO ?? null,
  monitorWebhookUrl: process.env.OPENCLAW_MONITOR_WEBHOOK_URL ?? null,
  monitorWebhookSecret: process.env.OPENCLAW_MONITOR_WEBHOOK_SECRET ?? null,
  monitorMode: (process.env.OPENCLAW_MONITOR_MODE ?? "digest") as "realtime" | "digest",
  monitorDigestHour: Number(process.env.OPENCLAW_MONITOR_DIGEST_HOUR ?? "8"),
};
