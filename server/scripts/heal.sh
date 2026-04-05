#!/usr/bin/env bash
# heal.sh — One-shot self-healing for common OpenClaw gateway issues.
#
# Adapted from openclaw-ops (MIT License, Cathryn Lavery).
# https://github.com/cathrynlavery/openclaw-ops
#
# Usage: heal.sh [--dry-run] [--target gateway|auth|exec|cron|sessions|all] [--json]
#
# Cross-platform: Linux (systemd) and macOS (launchctl).

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────
DRY_RUN=false
TARGET="all"
JSON_OUTPUT=false
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
CONFIG_FILE="$OPENCLAW_HOME/openclaw.json"

FIXED=()
BROKEN=()
MANUAL=()

# ── Colors (disabled if not TTY) ────────────────────────────────────────────
if [[ -t 1 ]]; then
  GRN='\033[0;32m'; RED='\033[0;31m'; YLW='\033[0;33m'; BLD='\033[1m'; RST='\033[0m'
else
  GRN=''; RED=''; YLW=''; BLD=''; RST=''
fi

log_ok()    { echo -e "${GRN}[fixed]${RST} $*"; }
log_err()   { echo -e "${RED}[broken]${RST} $*"; }
log_warn()  { echo -e "${YLW}[manual]${RST} $*"; }
log_info()  { echo -e "[info] $*"; }
log_dry()   { echo -e "${YLW}[dry-run]${RST} would: $*"; }

# ── Parse flags ─────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)  DRY_RUN=true;    shift ;;
    --json)     JSON_OUTPUT=true; shift ;;
    --target)   TARGET="$2";     shift 2 ;;
    *)          echo "Unknown flag: $1"; exit 1 ;;
  esac
done

# ── OS detection ────────────────────────────────────────────────────────────
OS="$(uname -s)"
is_linux() { [[ "$OS" == "Linux" ]]; }
is_macos() { [[ "$OS" == "Darwin" ]]; }

# ── Helpers ─────────────────────────────────────────────────────────────────
gateway_port() {
  python3 -c "
import json, sys, os
cfg = os.path.expanduser(sys.argv[1])
try:
    data = json.load(open(cfg))
    port = data.get('gateway', {}).get('port', 18789)
    print(port)
except Exception:
    print(18789)
" "$CONFIG_FILE" 2>/dev/null || echo "18789"
}

gateway_running() {
  local port
  port="$(gateway_port)"
  curl -sf --connect-timeout 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1
}

config_get() {
  python3 -c "
import json, sys, os, functools
cfg_path = os.path.expanduser(sys.argv[1])
keys = sys.argv[2].split('.')
try:
    data = json.load(open(cfg_path))
    val = functools.reduce(lambda d, k: d[k], keys, data)
    print(val if not isinstance(val, bool) else str(val).lower())
except Exception:
    print('')
" "$CONFIG_FILE" "$1" 2>/dev/null || true
}

config_set() {
  local key_path="$1" value="$2"
  python3 -c "
import json, sys, os
cfg_path = os.path.expanduser(sys.argv[1])
keys = sys.argv[2].split('.')
value = sys.argv[3]

# Coerce types
if value.lower() in ('true', 'false'):
    value = value.lower() == 'true'
elif value.isdigit():
    value = int(value)

with open(cfg_path) as f:
    data = json.load(f)

obj = data
for k in keys[:-1]:
    obj = obj.setdefault(k, {})
obj[keys[-1]] = value

with open(cfg_path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" "$CONFIG_FILE" "$key_path" "$value" 2>/dev/null
}

# ══════════════════════════════════════════════════════════════════════════════
# Repair targets
# ══════════════════════════════════════════════════════════════════════════════

heal_gateway() {
  log_info "Checking gateway..."

  if gateway_running; then
    log_info "Gateway is responding"
    return
  fi

  log_err "Gateway is not responding"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "restart gateway"
    MANUAL+=("Gateway restart needed")
    return
  fi

  # Attempt restart
  local restarted=false
  if is_linux; then
    if systemctl --user restart openclaw-gateway.service 2>/dev/null; then
      restarted=true
    fi
  elif is_macos; then
    if command -v openclaw >/dev/null 2>&1; then
      openclaw gateway restart 2>/dev/null && restarted=true
    fi
  fi

  if [[ "$restarted" == "true" ]]; then
    sleep 3
    if gateway_running; then
      log_ok "Gateway restarted successfully"
      FIXED+=("Gateway restarted")
    else
      log_err "Gateway restarted but still not responding"
      BROKEN+=("Gateway restart failed")
    fi
  else
    log_err "Could not restart gateway"
    BROKEN+=("Gateway restart failed")
  fi
}

heal_auth() {
  log_info "Checking auth profiles..."

  local profiles_path="$OPENCLAW_HOME/agents/direct/agent/auth-profiles.json"
  if [[ ! -f "$profiles_path" ]]; then
    log_err "Auth profiles file missing: $profiles_path"
    BROKEN+=("Auth profiles missing")
    return
  fi

  local profile_count
  profile_count=$(python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    profiles = data.get('profiles', {})
    print(len(profiles))
except Exception:
    print(0)
" "$profiles_path" 2>/dev/null || echo "0")

  if [[ "$profile_count" -eq 0 ]]; then
    log_err "No auth profiles configured"
    BROKEN+=("No auth profiles")
  else
    log_info "Found $profile_count auth profile(s)"
  fi

  # Check gateway auth mode
  local auth_mode
  auth_mode=$(config_get "gateway.auth.mode")
  if [[ "$auth_mode" == "none" ]]; then
    log_err "gateway.auth.mode = none (insecure, removed in v2026.1.29)"
    if [[ "$DRY_RUN" == "true" ]]; then
      log_dry "set gateway.auth.mode to token"
      MANUAL+=("Set gateway.auth.mode to token")
    else
      config_set "gateway.auth.mode" "token"
      log_ok "Set gateway.auth.mode = token"
      FIXED+=("Auth mode set to token")
    fi
  elif [[ -n "$auth_mode" ]]; then
    log_info "gateway.auth.mode = $auth_mode"
  fi
}

heal_exec() {
  log_info "Checking exec approvals..."

  local approvals_file="$OPENCLAW_HOME/exec-approvals.json"
  if [[ ! -f "$approvals_file" ]]; then
    log_warn "exec-approvals.json not found — exec approval daemon may not be configured"
    MANUAL+=("Missing exec-approvals.json")
    return
  fi

  # Check defaults
  local security ask fallback
  security=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d.get('defaults',{}).get('security',''))" "$approvals_file" 2>/dev/null || true)
  ask=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d.get('defaults',{}).get('ask',''))" "$approvals_file" 2>/dev/null || true)
  fallback=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d.get('defaults',{}).get('askFallback',''))" "$approvals_file" 2>/dev/null || true)

  if [[ "$security" != "full" ]]; then
    log_warn "exec-approvals defaults.security = '$security' (should be 'full' for cron)"
    if [[ "$DRY_RUN" == "true" ]]; then
      log_dry "set defaults.security to full"
    else
      python3 -c "
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data.setdefault('defaults', {})['security'] = 'full'
data['defaults']['ask'] = 'off'
data['defaults']['askFallback'] = 'full'
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" "$approvals_file" 2>/dev/null
      log_ok "Set exec-approvals defaults: security=full, ask=off, askFallback=full"
      FIXED+=("Exec approval defaults configured")
    fi
  else
    log_info "exec-approvals defaults.security = full"
  fi

  # Check openclaw.json tools.exec
  local exec_security
  exec_security=$(config_get "tools.exec.security")
  if [[ "$exec_security" != "full" ]] && [[ -n "$exec_security" ]]; then
    log_warn "openclaw.json tools.exec.security = '$exec_security' (should be 'full')"
    if [[ "$DRY_RUN" == "true" ]]; then
      log_dry "set tools.exec.security to full"
    else
      config_set "tools.exec.security" "full"
      log_ok "Set tools.exec.security = full"
      FIXED+=("Exec security set to full")
    fi
  fi
}

heal_cron() {
  log_info "Checking cron jobs..."

  local jobs_file="$OPENCLAW_HOME/cron/jobs.json"
  if [[ ! -f "$jobs_file" ]]; then
    log_info "No cron jobs file found"
    return
  fi

  # Find disabled jobs that were auto-disabled due to errors
  local disabled_jobs
  disabled_jobs=$(python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    jobs = data if isinstance(data, list) else data.get('jobs', [])
    for job in jobs:
        if not job.get('enabled', True) and job.get('consecutiveErrors', 0) > 0:
            print(job.get('id', 'unknown'))
except Exception:
    pass
" "$jobs_file" 2>/dev/null || true)

  if [[ -z "$disabled_jobs" ]]; then
    log_info "No auto-disabled cron jobs found"
    return
  fi

  while IFS= read -r job_id; do
    [[ -z "$job_id" ]] && continue
    if [[ "$DRY_RUN" == "true" ]]; then
      log_dry "re-enable cron job: $job_id"
      MANUAL+=("Re-enable cron job: $job_id")
    else
      if command -v cron-cli >/dev/null 2>&1; then
        cron-cli enable "$job_id" 2>/dev/null && {
          log_ok "Re-enabled cron job: $job_id"
          FIXED+=("Re-enabled cron job: $job_id")
        } || {
          log_err "Failed to re-enable cron job: $job_id"
          BROKEN+=("Failed to re-enable: $job_id")
        }
      else
        log_warn "cron-cli not found — cannot re-enable $job_id"
        MANUAL+=("Re-enable cron job: $job_id (cron-cli not in PATH)")
      fi
    fi
  done <<< "$disabled_jobs"
}

heal_sessions() {
  log_info "Checking for stuck sessions..."

  local agents_dir="$OPENCLAW_HOME/agents"
  if [[ ! -d "$agents_dir" ]]; then
    log_info "No agents directory found"
    return
  fi

  local stuck_count=0
  local threshold_sec=3600  # 1 hour

  while IFS= read -r session_file; do
    [[ -z "$session_file" ]] && continue
    local size
    size=$(stat -c%s "$session_file" 2>/dev/null || stat -f%z "$session_file" 2>/dev/null || echo "0")

    # Flag sessions > 10MB as potentially stuck
    if [[ "$size" -gt 10485760 ]]; then
      local name
      name=$(basename "$session_file")
      log_warn "Large session file ($((size / 1048576))MB): $name"
      MANUAL+=("Large session: $name (${size}B)")
      ((stuck_count++)) || true
    fi
  done < <(find "$agents_dir" -name "*.jsonl" -newer /dev/null -mmin -60 2>/dev/null || true)

  if [[ $stuck_count -eq 0 ]]; then
    log_info "No stuck sessions detected"
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════════════

if [[ "$DRY_RUN" == "true" ]]; then
  log_info "Running in dry-run mode — no changes will be made"
fi

case "$TARGET" in
  all)
    heal_gateway
    heal_auth
    heal_exec
    heal_cron
    heal_sessions
    ;;
  gateway)  heal_gateway ;;
  auth)     heal_auth ;;
  exec)     heal_exec ;;
  cron)     heal_cron ;;
  sessions) heal_sessions ;;
  *) echo "Unknown target: $TARGET"; exit 1 ;;
esac

# ── Summary ─────────────────────────────────────────────────────────────────

if [[ "$JSON_OUTPUT" == "true" ]]; then
  python3 -c "
import json, sys
fixed = sys.argv[1].split('|') if sys.argv[1] else []
broken = sys.argv[2].split('|') if sys.argv[2] else []
manual = sys.argv[3].split('|') if sys.argv[3] else []
print(json.dumps({
    'success': len(broken) == 0,
    'fixed': [f for f in fixed if f],
    'broken': [b for b in broken if b],
    'manual': [m for m in manual if m],
    'fixedCount': len([f for f in fixed if f]),
    'brokenCount': len([b for b in broken if b]),
    'manualCount': len([m for m in manual if m]),
}))
" "$(IFS='|'; echo "${FIXED[*]:-}")" "$(IFS='|'; echo "${BROKEN[*]:-}")" "$(IFS='|'; echo "${MANUAL[*]:-}")"
else
  echo ""
  echo "════════════════════════════════════════"
  if [[ ${#FIXED[@]} -gt 0 ]]; then
    echo -e "${GRN}Fixed (${#FIXED[@]}):${RST}"
    for f in "${FIXED[@]}"; do echo "  + $f"; done
  fi
  if [[ ${#BROKEN[@]} -gt 0 ]]; then
    echo -e "${RED}Still broken (${#BROKEN[@]}):${RST}"
    for b in "${BROKEN[@]}"; do echo "  - $b"; done
  fi
  if [[ ${#MANUAL[@]} -gt 0 ]]; then
    echo -e "${YLW}Needs manual action (${#MANUAL[@]}):${RST}"
    for m in "${MANUAL[@]}"; do echo "  ? $m"; done
  fi
  if [[ ${#FIXED[@]} -eq 0 ]] && [[ ${#BROKEN[@]} -eq 0 ]] && [[ ${#MANUAL[@]} -eq 0 ]]; then
    echo -e "${GRN}All checks passed — nothing to fix${RST}"
  fi
  echo "════════════════════════════════════════"
fi

# Exit non-zero if anything is broken
[[ ${#BROKEN[@]} -eq 0 ]]
