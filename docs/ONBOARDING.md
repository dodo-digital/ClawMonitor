# Claw Monitor Onboarding

> **This document is meant to be read by your OpenClaw agent, Claude Code, or any other coding agent you're using to set up Claw Monitor.** If you're a human, feel free to read through — but I recommend just pointing your agent at this file and letting it handle the setup. There's a short [manual setup section](#human-setup-without-an-agent) at the bottom if you prefer doing it yourself.

---

## For Agents: How to Use This Document

Follow these steps in order. **Do the work yourself.** Search the filesystem, read config files, test connections. Only ask the user for input when you've exhausted every way to find the answer on your own — and even then, be specific about what you need.

The guiding principle: the user pointed you at this file because they want you to handle this. Respect that by being resourceful.

---

## Step 1: Check Prerequisites

### Node.js

```bash
node --version
```

Require v22+. If missing or too old, install it (use `nvm`, the system package manager, or whatever's already on the machine). Only ask the user if you can't install it yourself due to permissions.

### Build tools

Native module compilation needs a C toolchain:

```bash
# Linux — check for gcc
gcc --version 2>/dev/null

# macOS — check for Xcode CLI tools
xcode-select -p 2>/dev/null
```

If missing: on Linux, install `build-essential` and `python3`. On macOS, run `xcode-select --install`. If you need `sudo` and don't have it, tell the user the exact command to run.

### OpenClaw gateway

```bash
curl -sf http://127.0.0.1:18789/v1/models > /dev/null 2>&1
```

If that fails, check other common ports (18780-18800). Check for a running process:

```bash
ps aux | grep -i openclaw | grep -v grep
```

Check systemd:

```bash
systemctl --user status openclaw-gateway 2>/dev/null
```

If the gateway genuinely isn't running and you can't start it, tell the user. Otherwise, keep going.

---

## Step 2: Clone and Install

```bash
git clone https://github.com/dodo-digital/ClawMonitor.git
cd ClawMonitor
npm install
```

If `npm install` fails on `better-sqlite3`, it's missing build tools — go back to Step 1.

---

## Step 3: Discover Configuration

You need six values for the `.env` file. Find all of them yourself.

### OPENCLAW_HOME

Search in this order:

1. `$OPENCLAW_HOME` environment variable
2. `~/.openclaw/` (check for `openclaw.json` inside it)
3. Broader search: `find ~ -maxdepth 3 -name "openclaw.json" -type f 2>/dev/null | head -5`

### Gateway URL, WebSocket URL, and Token

Read `$OPENCLAW_HOME/openclaw.json`. Parse it as JSON and extract:

- **Port**: `gateway.port` (default: `18789`)
- **Token**: `gateway.auth.token`

Construct:
- `OPENCLAW_GATEWAY_URL=http://127.0.0.1:{port}`
- `OPENCLAW_GATEWAY_WS=ws://127.0.0.1:{port}`
- `OPENCLAW_GATEWAY_TOKEN={token}`

If the token isn't in `openclaw.json`, also check:
- `$OPENCLAW_HOME/.env`
- Systemd environment files: `~/.config/systemd/user/openclaw-gateway.service.d/*.conf`
- `/etc/openclaw-secrets` (may need elevated permissions)

### Workspace

```
OPENCLAW_WORKSPACE=$OPENCLAW_HOME/workspace
```

Verify it exists. If not, check `openclaw.json` for agent workspace overrides under `agents.list[*].workspace`.

### Port

Default: `18801`. Check if it's free:

```bash
lsof -ti tcp:18801 2>/dev/null
```

If taken, increment until you find a free one.

---

## Step 4: Write .env and Build

Write the `.env` file in the ClawMonitor directory:

```bash
OPENCLAW_GATEWAY_URL=http://127.0.0.1:{gateway_port}
OPENCLAW_GATEWAY_WS=ws://127.0.0.1:{gateway_port}
OPENCLAW_GATEWAY_TOKEN={discovered_token}
OPENCLAW_HOME={discovered_home}
OPENCLAW_WORKSPACE={discovered_workspace}
PORT={chosen_port}
OPENCLAW_MONITOR_MODE=digest
OPENCLAW_MONITOR_DIGEST_HOUR=8
```

Build and install the CLIs globally:

```bash
npm run build
npm link
```

This makes two commands available system-wide:

- **`monitor`** — query the SQLite database directly (incidents, checks, sessions, runs, tool calls)
- **`cron-cli`** — manage cron cron-cli (list, health, debug, enable/disable, test, add)

Verify they work:

```bash
monitor --help
cron-cli --help
```

---

## Step 5: Install Skills

Claw Monitor ships with two skills that teach agents how to use the CLIs. Install them so your OpenClaw agent and/or Claude Code can debug and manage the system autonomously.

### For OpenClaw agents

Copy the skills into the OpenClaw skills directory:

```bash
cp -r {clawmonitor_dir}/skills/monitor $OPENCLAW_HOME/skills/monitor
cp -r {clawmonitor_dir}/skills/cron-cli $OPENCLAW_HOME/skills/cron-cli
```

### For Claude Code

Copy the skills into the Claude Code project skills directory. Find the right location:

```bash
# Check if a project-level .claude/skills/ directory exists
ls ~/.claude/skills/ 2>/dev/null

# If it exists, copy there:
cp -r {clawmonitor_dir}/skills/monitor ~/.claude/skills/monitor
cp -r {clawmonitor_dir}/skills/cron-cli ~/.claude/skills/cron-cli
```

If neither location exists, create it:

```bash
mkdir -p ~/.claude/skills
cp -r {clawmonitor_dir}/skills/monitor ~/.claude/skills/monitor
cp -r {clawmonitor_dir}/skills/cron-cli ~/.claude/skills/cron-cli
```

### What the skills do

- **Monitor skill** — teaches the agent how to check system health, investigate incidents, drill into agent runs, and debug tool failures using the `monitor` CLI
- **Schedule skill** — teaches the agent how to list, debug, enable/disable, and test cron cron-cli using the `cron-cli` CLI

Once installed, the agent can autonomously diagnose problems with the deployment — checking incidents, inspecting failing cron cron-cli, and tracing bad agent runs — without needing to ask you.

---

## Step 6: Start the Dashboard and Verify

```bash
node build/server/index.js &
sleep 3
```

Verify everything works:

```bash
# Gateway connected?
curl -sf http://localhost:{PORT}/api/health

# Dashboard loads?
curl -sf -o /dev/null -w "%{http_code}" http://localhost:{PORT}/
```

If the gateway shows disconnected, re-check the token and URL. The most common mistake is a stale or wrong token — re-read `openclaw.json` to confirm.

Stop the test server:

```bash
kill %1 2>/dev/null
```

---

## Step 7: Notifications

**This is the one place you should ask the user what they want.** You can't guess notification preferences.

Ask them once, covering everything:

> Claw Monitor is installed and connected to your gateway. The last thing to configure is how you want to be notified when something goes wrong.
>
> **Channels** (pick any combination, or none):
> - Telegram
> - Slack
> - Email
> - Webhook (signed HTTP POST to a URL)
>
> **Timing:**
> - Daily digest (default) — one summary per day
> - Realtime — immediate alert on every incident
>
> What would you like?

Based on their answer, collect only what you need:

### Telegram

You need: bot token, chat ID, and optionally a topic ID.

Before asking, check if OpenClaw already has Telegram configured:

```bash
# Check openclaw.json for existing Telegram config
grep -i telegram $OPENCLAW_HOME/openclaw.json
```

If there's an existing bot token and chat ID in the OpenClaw config, ask the user if they want to reuse them for monitoring alerts. If not, or if nothing exists, ask:

> I need your Telegram bot token and chat ID. If you don't have a bot yet, create one via [@BotFather](https://t.me/BotFather) and add it to your group.

### Slack

You need: an incoming webhook URL.

> What's your Slack webhook URL? (Create one at https://api.slack.com/messaging/webhooks)

### Email

You need: API endpoint, API key, from address, to address.

> What email service and address should I send alerts to?

### Webhook

You need: URL and signing secret.

Generate the secret yourself:

```bash
openssl rand -hex 32
```

> What URL should I send webhook notifications to? I've generated a signing secret: `{secret}` — save this to verify payloads on your end.

### Write the notification config

Append the chosen notification settings to `.env`. See `.env.example` for all variable names. Update `OPENCLAW_MONITOR_MODE` to `realtime` if they chose that.

---

## Step 8: Production Service (Linux)

On Linux, set this up without asking — it's the right thing to do for production. On macOS, skip this step.

Create `~/.config/systemd/user/claw-monitor.service`:

```ini
[Unit]
Description=Claw Monitor
After=network.target

[Service]
Type=simple
WorkingDirectory={absolute_path_to_clawmonitor}
ExecStart=/usr/bin/node build/server/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile={absolute_path_to_clawmonitor}/.env

[Install]
WantedBy=default.target
```

Verify the `ExecStart` node path is correct:

```bash
which node
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable claw-monitor
systemctl --user start claw-monitor
```

Ensure it survives logout:

```bash
loginctl show-user $USER --property=Linger | grep -q "yes" || sudo loginctl enable-linger $USER
```

Verify:

```bash
systemctl --user status claw-monitor
curl -sf http://localhost:{PORT}/api/health
```

If `enable-linger` needs sudo and you don't have it, tell the user the exact command.

---

## Step 9: Report to the User

Tell the user what you did and what's running:

> Claw Monitor is live.
>
> - **Dashboard**: http://localhost:{PORT}
> - **Gateway**: connected at {gateway_url}
> - **CLIs**: `monitor` and `cron-cli` installed globally
> - **Skills**: installed to {OpenClaw / Claude Code / both}
> - **Notifications**: {channels configured, or "none — dashboard only"}
> - **Mode**: {digest at X:00 / realtime}
> - **Service**: {running as systemd service / running manually}
>
> Try `monitor status` to see system health from the command line, or open the dashboard in a browser.
> Health checks start producing results after 60 seconds.

---

## Troubleshooting Reference

| Symptom | Cause | Fix |
|---------|-------|-----|
| `npm install` fails on `better-sqlite3` | Missing C toolchain | Install `build-essential` (Linux) or Xcode CLI tools (macOS) |
| Gateway disconnected | Wrong token or URL | Re-read `$OPENCLAW_HOME/openclaw.json` for `gateway.auth.token` and `gateway.port` |
| Dashboard 404 | Frontend not built | Run `npx vite build` in the ClawMonitor directory |
| "Missing required environment variable" | Incomplete `.env` | All 6 core vars are required — see Step 4 |
| Checks show "unknown" | 60-second startup grace period | Wait a minute |
| Notifications not arriving (digest mode) | Digest fires once daily | Test with `curl -X POST http://localhost:{PORT}/api/monitor/digest/send` |
| Port in use | Another process on that port | `lsof -ti tcp:{PORT}` to find it; pick a different port in `.env` |
| systemd shows "failed" | Startup error | `journalctl --user -u claw-monitor --no-pager -n 50` |

---

## Human Setup (Without an Agent)

If you're setting this up manually:

1. Clone: `git clone https://github.com/dodo-digital/ClawMonitor.git && cd ClawMonitor`
2. Install: `npm install && npm run build && npm link`
3. Configure: `cp .env.example .env` and fill in your values
   - Gateway port and token are in `~/.openclaw/openclaw.json` under `gateway.port` and `gateway.auth.token`
4. Install skills: `cp -r skills/monitor skills/cron-cli ~/.openclaw/skills/` (for OpenClaw) or `cp -r skills/monitor skills/cron-cli ~/.claude/skills/` (for Claude Code)
5. Run: `npm start`
6. Open `http://localhost:18801`
7. Try the CLIs: `monitor status` and `cron-cli list`
8. Add notification config to `.env` as needed (see `.env.example` for all options)
9. Optionally set up as a systemd service (see Step 8 above for the unit file)
