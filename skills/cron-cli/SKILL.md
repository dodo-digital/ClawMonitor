# Cron CLI Skill

Unified management of all scheduled cron-cli across both Linux crontab and OpenClaw internal cron.

## CLI

The `cron-cli` command is installed globally with Claw Monitor. Run `cron-cli --help` for usage.

## Architecture

Two scheduling layers exist:

- **Linux crontab** (chungbot user) — runs bash/python scripts directly. Jobs include memory pipeline, infrastructure, data sync.
- **OpenClaw internal cron** (`~/.openclaw/cron/jobs.json`) — spins up agent sessions with prompts.

The **registry** at `~/.openclaw/cron/registry.yaml` is the single source of truth for all cron-cli across both layers.

## Commands

### List all jobs
```bash
cron-cli list
cron-cli list --layer linux
cron-cli list --layer openclaw
cron-cli list --category memory-pipeline
cron-cli list --status failing
cron-cli list --status disabled
cron-cli list --layer linux --status healthy
```

### Show full details for a job
```bash
cron-cli show memory-rollup
cron-cli show oc-daily-note-summary
```

### View logs
```bash
cron-cli logs daily-brief
cron-cli logs memory-agent --lines 50
```

### Health check
```bash
cron-cli health                    # All jobs
cron-cli health --id daily-brief   # Single job
```

### Debug a broken job
```bash
cron-cli debug daily-brief
# Shows: config + health + recent logs in one dump
```

### Enable / Disable
```bash
cron-cli enable oc-bizdev-daily
cron-cli disable oc-rufus-loop-15min
```

For OpenClaw jobs, this updates both the registry and jobs.json.
For Linux jobs, you still need to manually comment/uncomment in `crontab -e`.

### Test a job
```bash
cron-cli test memory-rollup
# Runs the command, captures output, checks against expects
```

For OpenClaw jobs, it prints the `openclaw cron run --id <uuid>` command instead.

### Add a new job
```bash
cron-cli add \
  --id my-new-job \
  --name "My New Job" \
  --schedule "0 */4 * * *" \
  --layer linux \
  --command "cd ~/.openclaw/workspace && python3 scripts/my-script.py" \
  --category data-sync \
  --description "Syncs data from source X every 4 hours"
```

For OpenClaw jobs:
```bash
cron-cli add \
  --id oc-daily-review \
  --name "Daily Review" \
  --schedule "0 8 * * *" \
  --layer openclaw \
  --prompt "Review overnight incidents and summarize them for operators." \
  --agent direct \
  --session-target isolated \
  --thinking medium \
  --timeout 900 \
  --category agent-task \
  --description "Runs the daily operator review"
```

### Edit an existing job
```bash
cron-cli edit memory-rollup --schedule "*/5 * * * *"
cron-cli edit oc-bizdev-daily --enabled false
cron-cli edit daily-brief --description "Updated description"
```

### Delete a job
```bash
cron-cli delete old-job
```

## Common Workflows

### "What's failing right now?"
```bash
cron-cli list --status failing
# Then for each failing job:
cron-cli debug <id>
```

### "Debug a broken cron"
```bash
cron-cli debug daily-brief
# This shows config, health check result, and recent log output
# If the log shows the issue, fix the script
# Then test:
cron-cli test daily-brief
```

### "Create a new daily job"
```bash
# 1. Write the script
# 2. Add to registry + crontab
cron-cli add --id my-daily-job --name "My Daily Job" \
  --schedule "0 6 * * *" --layer linux \
  --command "cd ~/.openclaw/workspace && ./scripts/my-job.sh" \
  --category agent-task --description "Does X every morning at 6am"
# 3. Verify it
cron-cli show my-daily-job
```

### "Find all memory pipeline jobs"
```bash
cron-cli list --category memory-pipeline
```

### "Check if the memory pipeline is healthy"
```bash
cron-cli list --category memory-pipeline --status failing
```

## Categories

| Category | Description |
|----------|-------------|
| `data-sync` | Syncs data from external sources (Granola, etc.) |
| `memory-pipeline` | Memory rollup, extraction, decay, QMD indexing |
| `monitoring` | Health checks and verification |
| `agent-task` | Agent-driven tasks (goals, daily notes, biz-dev) |
| `build` | Autonomous build sessions, tool foundry |
| `infrastructure` | Updates, token refresh, session cleanup |

## Key File Paths

| File | Purpose |
|------|---------|
| `~/.openclaw/cron/registry.yaml` | Source of truth for all cron cron-cli |
| `~/.openclaw/cron/jobs.json` | OpenClaw internal cron definitions |
| `~/.openclaw/cron/runs/<id>.jsonl` | Per-job run history (OpenClaw jobs) |
| `/tmp/*.log` | Log files for Linux cron cron-cli |
| `~/.openclaw/dashboard.sqlite` | Dashboard database |

## Reading JSONL Run History Directly

For OpenClaw jobs, run history is stored in `~/.openclaw/cron/runs/<openclaw_id>.jsonl`. Each line is a JSON object with fields like `startedAt`, `status`, `durationMs`, `output`.

```bash
# Last 5 runs for a job
tail -5 ~/.openclaw/cron/runs/goals-daily-checklist.jsonl | python3 -m json.tool
```

## Cross-Reference with Monitor CLI

Use the `monitor` CLI to query the dashboard database directly:

```bash
monitor checks --type cron    # See cron-related health checks
monitor status                # Overall system health
```

## Rules

1. **Always use the CLI** — do not edit `jobs.json` directly for enable/disable/add operations.
2. **Registry is truth** — if a job is not in registry.yaml, it should not be running.
3. **Check health before making changes** — run `cron-cli health` to understand current state.
4. **Test after changes** — use `cron-cli test <id>` for Linux cron-cli after modifying scripts.
5. **For OpenClaw jobs**, use `openclaw cron run --id <uuid>` to trigger a manual run.
6. **Linux adds are crontab-aware** — `cron-cli add --layer linux ...` now writes the cron line too, unless one already exists for that log path.
7. **Linux enable/disable is still advisory** — those commands update the registry, but actual comment/uncomment changes in crontab remain manual.
