---
name: openclaw-ops
description: Use when troubleshooting, healing, securing, or performing health checks on the OpenClaw gateway — including exec approvals, cron jobs, agent sessions, security compliance, and operational maintenance.
---

# OpenClaw Ops

You are an expert OpenClaw administrator. Handle fast operational triage (health checks, auto-repair) and configuration management — security, exec approvals, cron jobs, sessions, and channels.

Adapted from [openclaw-ops](https://github.com/cathrynlavery/openclaw-ops) by Cathryn Lavery (MIT License).

## Self-Healing Scripts

Scripts live in the ClawMonitor repo at `~/projects/clawmonitor/server/scripts/`.

| Script | Purpose |
|--------|---------|
| `heal.sh` | One-shot fix: gateway, auth mode, exec approvals, crons, stuck sessions |
| `watchdog.sh` | Runs every 5 min via cron: HTTP health check, auto-restart, escalate after 3 failures |
| `check-update.sh` | Detect version changes, explain breaking changes, auto-fix with `--auto-fix` |

### Running scripts

```bash
# One-time heal (dry run first):
bash ~/projects/clawmonitor/server/scripts/heal.sh --dry-run --target all
bash ~/projects/clawmonitor/server/scripts/heal.sh --target all

# Post-upgrade triage:
bash ~/projects/clawmonitor/server/scripts/check-update.sh
bash ~/projects/clawmonitor/server/scripts/check-update.sh --auto-fix

# JSON output for programmatic use:
bash ~/projects/clawmonitor/server/scripts/heal.sh --json --target all
bash ~/projects/clawmonitor/server/scripts/check-update.sh --json
```

### Dashboard integration

The ClawMonitor dashboard exposes these via API:
- `POST /api/system/heal` — run heal with `{ target, dryRun }` body
- `POST /api/system/heal/triage` — run check-update with `{ autoFix }` body
- `GET /api/system/heal/history` — recent heal runs
- `GET /api/security/scan` — run compliance scan
- `GET /api/security/latest` — last cached scan result

The Dashboard page has a "Self-Heal" button. The Security page shows compliance scoring.

### Watchdog cron

The watchdog runs every 5 minutes via Linux crontab:
```
*/5 * * * * OPENCLAW_HOME=/home/chungbot/.openclaw bash /home/chungbot/projects/clawmonitor/server/scripts/watchdog.sh
```

View watchdog log: `tail -f ~/.openclaw/logs/watchdog.log`

### Escalation model

1. **Tier 1** — HTTP ping every 5 min via cron
2. **Tier 2** — Gateway restart + `heal.sh` if restart doesn't recover
3. **Tier 3** — Log escalation after 3 failed attempts in 15 min; requires manual intervention

## CLIs

Use ClawMonitor's CLIs for inspection:

```bash
monitor status                     # System overview
monitor incidents --status open    # What's broken
monitor checks --type cron         # Cron health
cron-cli list                      # All cron jobs
cron-cli health                    # What's failing
cron-cli debug <job-id>            # Deep dive on a job
```

## Fix Priority (Health Check Mode)

When running a health check, fix in this order:

1. **Version** — must be v2026.2.12+ (critical CVEs below that)
2. **Auth issues** — blocks all agent activity
3. **Exec approvals** — empty allowlists cause silent failures
4. **Auto-disabled crons** — silent failures, easy to miss
5. **Stuck sessions** — agent appears unresponsive
6. **Config errors** — causes restart warnings

## Step 0: Version Gate

Always verify the version before doing anything else.

```bash
openclaw --version
```

Versions before v2026.2.12 contain critical security vulnerabilities. If outdated:
```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw gateway restart
```

## 1. Gateway Status

```bash
fuser -v 18789/tcp                                    # Verify process
systemctl --user status openclaw-gateway              # Service status
tail -100 ~/.openclaw/logs/gateway.err.log            # Recent errors
```

## 2. Auth

Read `~/.openclaw/agents/direct/agent/auth-profiles.json` — verify tokens present.

Search `gateway.err.log` for: `"401"`, `"auth profile failure state"`, `"cooldown"`

If auth broken:
```bash
openclaw models auth setup-token --provider anthropic
```

Note: Anthropic OAuth tokens are blocked for OpenClaw — only direct API keys work.

## 3. Exec Approvals

Exec approvals have **two independent layers** — both must be correct or agents will stall.

### Layer 1: Per-agent allowlists

```bash
cat ~/.openclaw/exec-approvals.json
```

Named agent entries with empty allowlists `[]` shadow the `*` wildcard. For each agent:
```bash
openclaw approvals allowlist add --agent <agent-name> "*"
```

### Layer 2: Exec policy settings

**`~/.openclaw/exec-approvals.json`** — verify `defaults` block:
```json
{
  "defaults": {
    "security": "full",
    "ask": "off",
    "askFallback": "full"
  }
}
```

**`~/.openclaw/openclaw.json`** — verify exec tool settings:
```json
{
  "tools": {
    "exec": {
      "security": "full",
      "strictInlineEval": false
    }
  }
}
```

Set via CLI:
```bash
openclaw config set tools.exec.security full
openclaw config set tools.exec.strictInlineEval false
openclaw gateway restart
```

**Symptoms when Layer 2 is broken:** Agents message with `/approve <id> allow-always`, logs show `exec.approval.waitDecision` timeouts, complex commands blocked even though simple ones work.

## 4. Cron Jobs

```bash
cron-cli list --status failing       # See what's broken
cron-cli health                      # Health summary
```

Re-enable auto-disabled jobs:
```bash
cron-cli enable <job-id>
```

## 5. Agent Sessions

For each agent, check `~/.openclaw/agents/<id>/sessions/`:
- Session files >10MB
- Same content appearing 10+ times (rapid-fire loop)
- Recent assistant messages with `content:[]` and 0 tokens

If stuck: reset in sessions.json by setting `sessionId` and `sessionFile` to null.

## 6. Security Compliance

Run via dashboard (`/security` page) or API:
```bash
curl http://ubuntu-4gb-ash-1.tail1d5130.ts.net:18801/api/security/scan
```

Checks exec posture, credential exposure, skill drift, and auth health. Score 0-100.

Recommended settings:
- `gateway.auth.mode`: `token`
- `tools.exec.security`: `full`
- `sandbox.mode`: `all`
- `dmPolicy`: `pairing`

## Error Patterns

| Error | Cause | Fix |
|-------|-------|-----|
| `Gateway not reachable` | Service not running | `systemctl --user restart openclaw-gateway` |
| `Auth failed` | Invalid API key/token | `openclaw models auth setup-token --provider anthropic` |
| `exec.approval.waitDecision` timeout | Empty allowlist or wrong exec policy | Fix allowlists + Layer 2 settings |
| `auth mode "none"` | Removed in v2026.1.29 | `openclaw config set gateway.auth.mode token` |
| `Unknown model: claude-cli/...` | cliBackends key wrong | Check `agents.defaults.cliBackends` in openclaw.json |

## After Fixes

- Note if gateway restart is needed
- Summarize in three buckets: **broken**, **fixed**, **needs manual action**
- Run `openclaw doctor` for final validation
