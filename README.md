# Claw Monitor

Claw Monitor makes OpenClaw reliable. It watches your instance, runs health checks, opens incidents when something breaks, and notifies you so you or an agent can fix it before it compounds.

## Getting Started

The full setup is in [docs/ONBOARDING.md](docs/ONBOARDING.md). It's written for agents. Point your OpenClaw or Claude Code at that file and it will handle cloning, environment discovery, build, skill installation, and notification setup. There's a manual section at the bottom if you'd rather do it yourself.

The short version:

```bash
git clone https://github.com/dodo-digital/ClawMonitor.git
cd ClawMonitor
npm install
cp .env.example .env   # fill in your gateway URL, token, and paths
npm run build
npm link               # installs the CLIs globally
npm start              # http://localhost:18801
```

Requires Node 22+.

## Dashboard

The web dashboard runs on Express + React and connects to your OpenClaw gateway over WebSocket and HTTP. Access it at `http://localhost:<PORT>` (default 18801). No auth required if you're running it behind Tailscale or localhost.

Pages:

- **Dashboard** - system health, incident counts, session activity, quick actions
- **Incidents** - open/resolved incidents with full event timelines and notification delivery history
- **Sessions** - browse sessions by agent and channel, read full transcripts with tool calls inline
- **Live Feed** - real-time WebSocket stream of gateway events with agent/channel filtering
- **Cron Jobs** - both Linux crontab and OpenClaw internal cron in one view, with toggle switches and log viewing
- **Identity** - bootstrap file editor with character budgets and injection order
- **Memory** - QMD search tester and file browser across memory and PARA directories
- **Agents** - agent configs, ACP status, model availability, auth profiles
- **Skills** and **Plugins** - what's installed and active

## CLIs

Two command-line tools ship with Claw Monitor and are available globally after `npm link`:

### `monitor`

Queries the SQLite database directly. No server needed.

```bash
monitor status                    # overview: incidents, checks, sessions, runs
monitor incidents --status open   # what's broken right now
monitor incident 42               # full detail with event timeline
monitor checks --type cron        # health check results by type
monitor runs --session <key>      # agent runs for a specific session
monitor run <run_id>              # messages + tool calls for a single run
monitor tools --failed            # failed tool calls
monitor search "deployment"       # full-text search across conversations
monitor resume <run_id>           # output a run as injectable context
```

### `cron-cli`

Manages cron jobs across both Linux crontab and OpenClaw internal cron.

```bash
cron-cli list                     # all jobs, both layers
cron-cli health                   # what's failing
cron-cli debug <job-id>           # config + health + logs in one dump
cron-cli enable <job-id>          # turn a job on
cron-cli test <job-id>            # run it now and check the output
cron-cli add --id my-job ...      # register a new job
```

## Skills

Claw Monitor includes two skills that teach agents how to use the CLIs autonomously. Install them into your OpenClaw `skills/` directory or Claude Code's `.claude/skills/` to let agents diagnose problems, inspect incidents, debug cron failures, and trace bad runs without needing you.

- **Monitor skill** (`skills/monitor/SKILL.md`) - how to check system health, investigate incidents, drill into runs, and debug tool failures
- **Cron CLI skill** (`skills/cron-cli/SKILL.md`) - how to list, debug, enable/disable, and test cron jobs across both scheduling layers

## Health Checks

The monitor runs checks on a schedule and opens incidents automatically when something fails:

| Check | What it watches |
|-------|-----------------|
| `gateway.connection` | Gateway reachable and responding |
| `gateway.event_flow` | WebSocket events flowing normally |
| `cron.job_status` | Cron jobs completing successfully |
| `cron.job_staleness` | Jobs that haven't run when expected |
| `system.disk` | Disk usage thresholds |
| `auth.profile_integrity` | Auth profiles valid and non-expired |
| `exec.security_config` | Exec permissions configured safely |
| `session.dead_runs` | Runs that started but never finished |
| `session.stuck_runs` | Runs that have been going too long |
| `session.tool_failures` | Elevated tool failure rates |
| `session.retry_loops` | Agents stuck in retry loops |
| `session.auth_errors` | Authentication failures in sessions |

## Notifications

Configure in `.env`. Supports digest mode (one summary per day at a set hour) or realtime mode (immediate alert per incident). Channels: Telegram, Slack, email, webhooks. See `.env.example` for all the variables.

## License

MIT
