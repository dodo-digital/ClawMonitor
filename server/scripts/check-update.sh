#!/usr/bin/env bash
# check-update.sh — Post-upgrade triage for OpenClaw.
#
# Adapted from openclaw-ops (MIT License, Cathryn Lavery).
# https://github.com/cathrynlavery/openclaw-ops
#
# Usage: check-update.sh [--auto-fix] [--json]

set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
CONFIG_FILE="$OPENCLAW_HOME/openclaw.json"
STATE_FILE="$OPENCLAW_HOME/update-state.json"
AUTO_FIX=false
JSON_OUTPUT=false

# ── Colors ──────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  GRN='\033[0;32m'; RED='\033[0;31m'; YLW='\033[0;33m'; BLD='\033[1m'; RST='\033[0m'
else
  GRN=''; RED=''; YLW=''; BLD=''; RST=''
fi

log_ok()    { echo -e "${GRN}[ok]${RST} $*"; }
log_err()   { echo -e "${RED}[issue]${RST} $*"; }
log_warn()  { echo -e "${YLW}[warn]${RST} $*"; }
log_info()  { echo -e "[info] $*"; }

ISSUES=()
FIXES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto-fix) AUTO_FIX=true; shift ;;
    --json)     JSON_OUTPUT=true; shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

# ── Version detection ───────────────────────────────────────────────────────
get_version() {
  if command -v openclaw >/dev/null 2>&1; then
    openclaw --version 2>/dev/null | head -1 | sed 's/^v//' || echo "unknown"
  else
    echo "unknown"
  fi
}

CURRENT_VERSION="$(get_version)"

# ── Previous version from state ─────────────────────────────────────────────
PREV_VERSION=""
if [[ -f "$STATE_FILE" ]]; then
  PREV_VERSION=$(python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    print(data.get('version', ''))
except Exception:
    print('')
" "$STATE_FILE" 2>/dev/null || true)
fi

# Save current version to state
python3 -c "
import json, sys, os
path = sys.argv[1]
version = sys.argv[2]
data = {}
if os.path.exists(path):
    try:
        data = json.load(open(path))
    except Exception:
        pass
data['version'] = version
data['checked_at'] = __import__('datetime').datetime.utcnow().isoformat() + 'Z'
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" "$STATE_FILE" "$CURRENT_VERSION" 2>/dev/null

# ── Config snapshot ─────────────────────────────────────────────────────────
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

echo ""
echo -e "${BLD}OpenClaw Post-Upgrade Triage${RST}"
echo "══════════════════════════════════════"

if [[ -n "$PREV_VERSION" ]] && [[ "$PREV_VERSION" != "$CURRENT_VERSION" ]]; then
  log_warn "Version changed: $PREV_VERSION -> $CURRENT_VERSION"
else
  log_info "Current version: $CURRENT_VERSION"
fi

echo ""
echo -e "${BLD}Config Snapshot${RST}"
echo "──────────────────────────────────────"
echo "  gateway.auth.mode = $(config_get 'gateway.auth.mode')"
echo "  tools.exec.security = $(config_get 'tools.exec.security')"
echo "  agents.defaults.sandbox.mode = $(config_get 'agents.defaults.sandbox.mode')"

# ── Check for known breaking changes ────────────────────────────────────────
echo ""
echo -e "${BLD}Known Breaking Changes${RST}"
echo "──────────────────────────────────────"

# v2026.2.24: Exec policy Layer 2 defaults changed
exec_security=$(config_get "tools.exec.security")
if [[ "$exec_security" != "full" ]] && [[ -n "$exec_security" ]]; then
  log_err "tools.exec.security = '$exec_security' (should be 'full' since v2026.2.24)"
  ISSUES+=("tools.exec.security not set to full")
  if [[ "$AUTO_FIX" == "true" ]]; then
    python3 -c "
import json, sys, os
path = os.path.expanduser(sys.argv[1])
data = json.load(open(path))
data.setdefault('tools', {}).setdefault('exec', {})['security'] = 'full'
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" "$CONFIG_FILE" 2>/dev/null
    log_ok "Fixed: tools.exec.security = full"
    FIXES+=("Set tools.exec.security to full")
  fi
elif [[ -z "$exec_security" ]]; then
  log_warn "tools.exec.security not set — may default to restrictive mode"
  ISSUES+=("tools.exec.security not explicitly set")
else
  log_ok "tools.exec.security = full"
fi

# v2026.1.29: auth.mode="none" removed
auth_mode=$(config_get "gateway.auth.mode")
if [[ "$auth_mode" == "none" ]]; then
  log_err "gateway.auth.mode = none (removed in v2026.1.29)"
  ISSUES+=("Auth mode set to none")
  if [[ "$AUTO_FIX" == "true" ]]; then
    python3 -c "
import json, sys, os
path = os.path.expanduser(sys.argv[1])
data = json.load(open(path))
data.setdefault('gateway', {}).setdefault('auth', {})['mode'] = 'token'
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" "$CONFIG_FILE" 2>/dev/null
    log_ok "Fixed: gateway.auth.mode = token"
    FIXES+=("Set gateway.auth.mode to token")
  fi
else
  log_ok "gateway.auth.mode = $auth_mode"
fi

# Check exec-approvals.json
approvals_file="$OPENCLAW_HOME/exec-approvals.json"
if [[ -f "$approvals_file" ]]; then
  approvals_security=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d.get('defaults',{}).get('security',''))" "$approvals_file" 2>/dev/null || true)
  if [[ "$approvals_security" != "full" ]] && [[ -n "$approvals_security" ]]; then
    log_err "exec-approvals defaults.security = '$approvals_security' (should be 'full')"
    ISSUES+=("Exec approvals security not full")
    if [[ "$AUTO_FIX" == "true" ]]; then
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
      log_ok "Fixed exec-approvals defaults"
      FIXES+=("Set exec-approvals defaults")
    fi
  else
    log_ok "exec-approvals defaults.security = ${approvals_security:-not set}"
  fi
fi

# Gateway connectivity
echo ""
echo -e "${BLD}Connectivity${RST}"
echo "──────────────────────────────────────"
gateway_port=$(python3 -c "
import json, sys, os
cfg = os.path.expanduser(sys.argv[1])
try:
    data = json.load(open(cfg))
    print(data.get('gateway', {}).get('port', 18789))
except Exception:
    print(18789)
" "$CONFIG_FILE" 2>/dev/null || echo "18789")

if curl -sf --connect-timeout 3 "http://127.0.0.1:$gateway_port/health" >/dev/null 2>&1; then
  log_ok "Gateway responding on port $gateway_port"
else
  log_err "Gateway not responding on port $gateway_port"
  ISSUES+=("Gateway not responding")
fi

# ── Output ──────────────────────────────────────────────────────────────────
if [[ "$JSON_OUTPUT" == "true" ]]; then
  python3 -c "
import json, sys
issues = sys.argv[1].split('|') if sys.argv[1] else []
fixes = sys.argv[2].split('|') if sys.argv[2] else []
print(json.dumps({
    'version': sys.argv[3],
    'previousVersion': sys.argv[4],
    'issues': [i for i in issues if i],
    'fixes': [f for f in fixes if f],
    'issueCount': len([i for i in issues if i]),
    'fixCount': len([f for f in fixes if f]),
    'healthy': len([i for i in issues if i]) == 0,
}))
" "$(IFS='|'; echo "${ISSUES[*]:-}")" "$(IFS='|'; echo "${FIXES[*]:-}")" "$CURRENT_VERSION" "${PREV_VERSION:-}"
else
  echo ""
  echo "════════════════════════════════════════"
  if [[ ${#ISSUES[@]} -eq 0 ]]; then
    echo -e "${GRN}No issues found — system looks healthy${RST}"
  else
    echo -e "${RED}Found ${#ISSUES[@]} issue(s)${RST}"
    if [[ ${#FIXES[@]} -gt 0 ]]; then
      echo -e "${GRN}Applied ${#FIXES[@]} fix(es)${RST}"
    fi
  fi
  echo "════════════════════════════════════════"
fi
