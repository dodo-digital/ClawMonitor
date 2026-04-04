# Monitor CLI Skill

Query Claw Monitor's SQLite database directly from the command line. No server needed. Designed for debugging, diagnostics, and observability.

## CLI

The `monitor` command is installed globally with Claw Monitor. Run `monitor --help` for usage.

All commands support `--json` for machine-readable output.

## Commands

### Get an overview

```bash
monitor status
monitor status --json
```

Returns: incident counts by status, health check summary (last hour), active sessions, runs, and failed tool calls.

### List incidents

```bash
monitor incidents                    # All incidents (last 50)
monitor incidents --status open      # Only open incidents
monitor incidents --status resolved  # Only resolved
```

### Inspect a specific incident

```bash
monitor incident 42
```

Shows: full incident detail, event timeline (opened/observed/resolved), and notification delivery history with success/failure.

### Check current health

```bash
monitor checks                       # Latest result per check type
monitor checks --type gateway        # Filter by check type
monitor checks --type cron           # All cron-related checks
monitor checks --type session        # Session anomaly checks
```

Check types: `gateway.connection`, `gateway.event_flow`, `cron.job_status`, `cron.job_staleness`, `system.disk`, `auth.profile_integrity`, `exec.security_config`, `session.dead_runs`, `session.stuck_runs`, `session.tool_failures`, `session.retry_loops`, `session.auth_errors`

### View sessions

```bash
monitor sessions                     # Recent sessions
monitor sessions --agent direct      # Filter by agent
monitor sessions --limit 5           # Limit results
```

### View agent runs

```bash
monitor runs                         # Recent runs
monitor runs --session <key>         # Runs for a specific session
monitor runs --limit 10
```

### Drill into a specific run

```bash
monitor run <run_id>
```

Shows: run metadata, all messages in order, and all tool calls with inputs and success/failure. This is the primary debugging command — use it to see exactly what an agent did during a run.

### View tool calls

```bash
monitor tools                        # Recent tool calls
monitor tools --failed               # Only failed tool calls
monitor tools --name Read            # Filter by tool name
monitor tools --name exec --failed   # Failed exec calls
monitor tools --limit 50
```

### Search conversations

```bash
monitor search "deployment failed"     # Find conversations by keyword
monitor search "cron debug"            # Multi-word search
monitor search "Harrison" --limit 5    # Limit results
```

Uses full-text search (FTS5) for fast ranked results with snippets. Shows numbered results — use the run ID to resume.

### Resume a previous conversation

```bash
monitor resume <run_id>
monitor resume 8e191b7b                # Partial IDs work
```

Outputs the full conversation (messages + tool calls) formatted as context that can be injected into a new session. Use this when the user wants to continue work from a previous conversation.

The typical flow:
1. `monitor search "whatever we were working on"`
2. User picks a result
3. `monitor resume <id>` — outputs the context
4. Continue the work with full awareness of what happened before

### Explore the schema

```bash
monitor tables
```

Shows all tables, their columns, types, and row counts.

### Run raw SQL

```bash
monitor query "SELECT * FROM incidents WHERE severity = 'critical' ORDER BY opened_at DESC LIMIT 5"
```

Only SELECT queries are allowed (read-only safety).

## Common Workflows

### "What's broken right now?"

```bash
monitor status
monitor incidents --status open
# Then for each open incident:
monitor incident <id>
```

### "Debug why a cron job failed"

```bash
cron-cli health                          # Find failing jobs
cron-cli debug <job-id>                  # Config + logs + health
monitor checks --type cron               # Dashboard's view of cron health
monitor incidents --status open          # Any open cron incidents?
```

### "Investigate a bad agent run"

```bash
monitor runs --limit 10                  # Find the run
monitor run <run_id>                     # See messages + tool calls
monitor tools --failed                   # Any tool failures?
```

### "Check if notifications are working"

```bash
monitor incident <id>                    # Shows delivery history
monitor query "SELECT destination_name, success, error_message FROM notification_deliveries ORDER BY created_at DESC LIMIT 10"
```

### "Resume a conversation from a few days ago"

```bash
monitor search "the thing we were working on"
# User picks one from the numbered list
monitor resume <run_id>
# Now you have full context — continue the work
```

### "How much activity in the last 24 hours?"

```bash
monitor status                           # Quick summary
monitor sessions                         # Session list
monitor runs                             # Run list
```

## Environment

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAWMONITOR_DB` | Direct path to database | `$OPENCLAW_HOME/dashboard.sqlite` |
| `OPENCLAW_HOME` | OpenClaw home directory | `~/.openclaw` |

## Rules

1. **Start with `monitor status`** — it gives you the lay of the land in one command.
2. **Use `--json` when piping or parsing** — structured output for programmatic use.
3. **Drill down, don't scan** — go `status` → `incidents` → `incident <id>` → `run <run_id>`. Don't try to read everything at once.
4. **Cross-reference with `cron-cli`** — cron issues often need both tools. `monitor` shows what the dashboard detected, `cron-cli` shows the cron registry and logs.
5. **The `query` command is your escape hatch** — if a built-in command doesn't show what you need, write SQL directly.
