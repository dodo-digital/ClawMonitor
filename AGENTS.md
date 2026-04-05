# Claw Monitor — Agent Context

You are a debugging and monitoring agent for an OpenClaw instance. Use the CLIs and dashboard DB to inspect, diagnose, and maintain the system.

## CLIs

| Command | Purpose |
|---|---|
| `monitor` | Query the dashboard DB: system status, incidents, sessions, runs, tool calls |
| `cron-cli` | Manage cron jobs: list, inspect, enable/disable, debug, health checks |
| `openclaw` | OpenClaw CLI: agents, sessions, system events, version info |
| `gog` | Google Workspace: Gmail, Calendar, Sheets (test integrations) |
| `calls` | Granola meeting notes: list, search, get, transcript |

## Inspecting the system

### Overall health
```bash
monitor status                    # System overview: incidents, health, active sessions
monitor incidents --status open   # Current open issues
```

### Cron jobs
```bash
cron-cli list                     # All jobs with last run status
cron-cli list --status failing    # Only failing jobs
cron-cli health                   # Health summary
cron-cli debug <job-id>           # Deep dive: recent runs, errors, timing
```

### Sessions and runs
```bash
monitor checks --type session     # Session anomalies
monitor checks --type cron        # Cron execution health
monitor run <run_id>              # Full trace of a specific agent run
```

### Tool call history
```bash
monitor tools                     # Recent tool calls across runs
```

### Gateway
```bash
fuser -v 18789/tcp                # Verify gateway process is running
systemctl --user status openclaw-gateway  # Service status (active exited is NORMAL — it daemonizes)
```

### OpenClaw version
```bash
openclaw --version                # Installed version
npm view openclaw version         # Latest published version
openclaw update status            # Check update availability
```

## OpenClaw file structure

All config lives at `~/.openclaw/`.

| Path | Purpose |
|---|---|
| `openclaw.json` | Central config: models, channels, plugins, memory search paths |
| `workspace/` | Source-of-truth files the agent reads every sweep |
| `skills/` | Agent-level skills (each has a `SKILL.md`) |
| `cron/jobs.json` | Cron job definitions (**manage via `cron-cli`, never edit directly**) |
| `cron/registry.yaml` | Cron registry (enabled + archived) |
| `agents/` | Agent configs, sessions, auth profiles |
| `logs/` | Gateway logs, cache traces, config audit |
| `delivery-queue/` | Async message delivery (check `failed/` for stuck messages) |
| `dashboard.sqlite` | This dashboard's database |

## Making knowledge files visible to the agent

New workspace files must be registered in `openclaw.json` to be discoverable by the agent's memory search.

Add the file's absolute path to the `extraPaths` array at `agents.defaults.memorySearch.extraPaths`.

Verify registration in the dashboard: Memory & Knowledge → Agent Context tab. This shows all registered files, flags missing references, and lists orphaned workspace files not yet registered.

## Key constraints

- `harrison@dododigital.ai` is **read-only**. A shell wrapper at `~/.local/bin/gog` blocks send. This is intentional.
- **Agent configs are symlinked.** Multiple agents share `direct`'s model and auth configs via symlinks.
- Cron jobs should use `sessionTarget: "isolated"` to avoid stale context accumulation.
- Secrets live in `/etc/openclaw-secrets`, loaded via systemd drop-in at `~/.config/systemd/user/openclaw-gateway.service.d/secrets.conf`.
- Crontab must include `~/.local/bin` in PATH or CLIs won't be found.
- QMD does not work on this VPS (no GPU). Ignore QMD-related errors.
- **Do not restart the gateway** — this will terminate your own session.

## Links

Always use Tailscale Magic DNS, never localhost.
- Dashboard: `http://ubuntu-4gb-ash-1.tail1d5130.ts.net:5173`
- API: `http://ubuntu-4gb-ash-1.tail1d5130.ts.net:18801`
- Gateway: port 18789
