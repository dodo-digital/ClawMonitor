#!/usr/bin/env bash
# watchdog.sh — Runs every 5 minutes via cron.
# Monitors OpenClaw gateway health and auto-heals common issues.
#
# Adapted from openclaw-ops (MIT License, Cathryn Lavery).
# https://github.com/cathrynlavery/openclaw-ops
#
# Install: */5 * * * * OPENCLAW_HOME=/home/chungbot/.openclaw bash /home/chungbot/projects/clawmonitor/server/scripts/watchdog.sh
#
# Cross-platform: Linux (systemd) and macOS (launchctl).

set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEAL_SCRIPT="$SCRIPT_DIR/heal.sh"

LOG_DIR="$OPENCLAW_HOME/logs"
LOG_FILE="$LOG_DIR/watchdog.log"
STATE_FILE="$OPENCLAW_HOME/watchdog-state.json"

MAX_RESTART_ATTEMPTS=3
RESTART_ATTEMPT_WINDOW=900  # 15 minutes

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$STATE_FILE")"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $1" >> "$LOG_FILE"; }

# Trim log to last 500 lines
if [[ -f "$LOG_FILE" ]]; then
  tail -500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

log "── Watchdog tick ────────────────────"

# ── Version tracking ─────────────────────────────────────────────────────────
CURRENT_VERSION=""
if command -v openclaw >/dev/null 2>&1; then
  CURRENT_VERSION="$(openclaw --version 2>/dev/null | head -1 | sed 's/^v//' || true)"
fi

if [[ -n "$CURRENT_VERSION" ]]; then
  python3 -c "
import sys, json, os
from time import gmtime, strftime

state_file = sys.argv[1]
current_version = sys.argv[2]
try:
    d = json.load(open(state_file))
except:
    d = {}
prev = d.get('current_version', '')
d['current_version'] = current_version
d['last_version'] = current_version
if prev and prev != current_version:
    d['previous_version'] = prev
    d['version_changed_at'] = strftime('%Y-%m-%dT%H:%M:%SZ', gmtime())
    d['version_change_pending'] = True
import tempfile
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(state_file), suffix='.tmp')
with os.fdopen(fd, 'w') as out:
    json.dump(d, out)
os.replace(tmp, state_file)
" "$STATE_FILE" "$CURRENT_VERSION" 2>/dev/null || true
fi

# ── Restart tracking ─────────────────────────────────────────────────────────
get_restart_count() {
  python3 -c "
import sys, json, time
state_file = sys.argv[1]
window = int(sys.argv[2])
try:
    d = json.load(open(state_file))
    attempts = [a for a in d.get('restarts', []) if time.time() - a < window]
    print(len(attempts))
except: print(0)
" "$STATE_FILE" "$RESTART_ATTEMPT_WINDOW" 2>/dev/null || echo 0
}

record_restart() {
  python3 -c "
import sys, json, time, os, tempfile
state_file = sys.argv[1]
window = int(sys.argv[2])
try:
    d = json.load(open(state_file))
except:
    d = {}
attempts = [a for a in d.get('restarts', []) if time.time() - a < window]
attempts.append(time.time())
d['restarts'] = attempts
d['last_restart'] = time.time()
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(state_file), suffix='.tmp')
with os.fdopen(fd, 'w') as f:
    json.dump(d, f)
os.replace(tmp, state_file)
" "$STATE_FILE" "$RESTART_ATTEMPT_WINDOW" 2>/dev/null || true
}

clear_restarts() {
  python3 -c "
import sys, json, time, os, tempfile
state_file = sys.argv[1]
try:
    d = json.load(open(state_file))
except:
    d = {}
d['restarts'] = []
d['last_ok'] = time.time()
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(state_file), suffix='.tmp')
with os.fdopen(fd, 'w') as f:
    json.dump(d, f)
os.replace(tmp, state_file)
" "$STATE_FILE" 2>/dev/null || true
}

# ── Gateway port ─────────────────────────────────────────────────────────────
GATEWAY_PORT=$(python3 -c "
import json, sys, os
cfg = os.path.join(sys.argv[1], 'openclaw.json')
try:
    data = json.load(open(cfg))
    print(data.get('gateway', {}).get('port', 18789))
except:
    print(18789)
" "$OPENCLAW_HOME" 2>/dev/null || echo "18789")

GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}/health"

# ── Health check ─────────────────────────────────────────────────────────────
HTTP_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 5 "$GATEWAY_URL" 2>/dev/null || echo "000")

if [[ "$HTTP_STATUS" == "200" ]] || [[ "$HTTP_STATUS" == "401" ]]; then
  log "Gateway healthy (HTTP $HTTP_STATUS)"
  clear_restarts
  exit 0
fi

# ── Gateway is down ──────────────────────────────────────────────────────────
log "Gateway unreachable (HTTP $HTTP_STATUS)"

RESTART_COUNT=$(get_restart_count)
log "Restart attempts in last ${RESTART_ATTEMPT_WINDOW}s: $RESTART_COUNT"

if [[ "$RESTART_COUNT" -ge "$MAX_RESTART_ATTEMPTS" ]]; then
  log "ESCALATION: Max restart attempts ($MAX_RESTART_ATTEMPTS) reached. Gateway down, manual intervention needed."
  log "  Check: tail -50 ~/.openclaw/logs/gateway.err.log"

  # Desktop notification (macOS only, skip on Linux)
  if command -v osascript &>/dev/null; then
    osascript -e 'display notification "OpenClaw gateway is down and not recovering." with title "OpenClaw Watchdog" sound name "Basso"' 2>/dev/null || true
  fi

  exit 1
fi

# ── Attempt recovery ─────────────────────────────────────────────────────────
log "Attempting gateway restart (attempt $((RESTART_COUNT + 1)) of $MAX_RESTART_ATTEMPTS)"
record_restart

# Try systemd first (Linux), then openclaw CLI
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active openclaw-gateway.service >/dev/null 2>&1; then
  systemctl --user restart openclaw-gateway.service 2>>"$LOG_FILE" || true
else
  openclaw gateway restart 2>>"$LOG_FILE" &
fi

sleep 8

# Verify recovery
HTTP_STATUS_AFTER=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 5 "$GATEWAY_URL" 2>/dev/null || echo "000")

if [[ "$HTTP_STATUS_AFTER" == "200" ]] || [[ "$HTTP_STATUS_AFTER" == "401" ]]; then
  log "Gateway recovered (HTTP $HTTP_STATUS_AFTER)"
  exit 0
fi

# ── Simple restart didn't work — run heal.sh ─────────────────────────────────
if [[ -f "$HEAL_SCRIPT" ]]; then
  log "Simple restart failed — running heal.sh"
  bash "$HEAL_SCRIPT" --target all >>"$LOG_FILE" 2>&1 || log "heal.sh exited with errors"
else
  log "heal.sh not found at $HEAL_SCRIPT — skipping"
fi

# Final check
HTTP_FINAL=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 5 "$GATEWAY_URL" 2>/dev/null || echo "000")
if [[ "$HTTP_FINAL" == "200" ]] || [[ "$HTTP_FINAL" == "401" ]]; then
  log "Gateway recovered after heal.sh"
  clear_restarts
  exit 0
else
  log "Gateway still down after heal.sh (HTTP $HTTP_FINAL)"
  exit 1
fi
