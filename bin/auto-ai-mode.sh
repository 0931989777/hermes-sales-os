#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/HMBM/banmoc-hermes-messenger-bot"
ENV_FILE="$APP_DIR/.env"
LOG_FILE="$APP_DIR/auto-ai-mode.log"
SERVICE_NAME="hermes-hmbm-messenger-bot.service"
HERMES_BIN="/usr/local/bin/banmoc-hermes-hmbm"
LOCK_FILE="/tmp/hmbm-auto-ai-mode.lock"

log() {
  printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG_FILE"
}

set_fast_sales_reply() {
  local value="$1"
  if grep -q '^FAST_SALES_REPLY_ENABLED=' "$ENV_FILE"; then
    sed -i "s/^FAST_SALES_REPLY_ENABLED=.*/FAST_SALES_REPLY_ENABLED=$value/" "$ENV_FILE"
  else
    printf '\nFAST_SALES_REPLY_ENABLED=%s\n' "$value" >> "$ENV_FILE"
  fi
}

current_fast_sales_reply() {
  awk -F= '/^FAST_SALES_REPLY_ENABLED=/ {print $2; found=1} END {if (!found) print ""}' "$ENV_FILE"
}

looks_like_model_failure() {
  local output="$1"
  grep -Eiq 'API call failed|provider failed|HTTP 5[0-9][0-9]|No available channel|distributor|request id:' <<< "$output"
}

main() {
  cd "$APP_DIR"
  mkdir -p "$(dirname "$LOG_FILE")"

  local output status
  set +e
  output="$(timeout 90s "$HERMES_BIN" "Tra loi dung mot tu: OK" 2>&1)"
  status=$?
  set -e

  if [[ $status -eq 0 ]] && [[ -n "${output//[[:space:]]/}" ]] && ! looks_like_model_failure "$output"; then
    if [[ "$(current_fast_sales_reply)" != "false" ]]; then
      cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S).auto-ai"
      set_fast_sales_reply false
      systemctl restart "$SERVICE_NAME"
      log "model healthy; disabled FAST_SALES_REPLY_ENABLED and restarted $SERVICE_NAME"
    else
      log "model healthy; AI mode already enabled"
    fi
    exit 0
  fi

  if [[ "$(current_fast_sales_reply)" != "true" ]]; then
    cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S).fallback"
    set_fast_sales_reply true
    systemctl restart "$SERVICE_NAME"
    log "model unhealthy; enabled FAST_SALES_REPLY_ENABLED and restarted $SERVICE_NAME"
  else
    log "model unhealthy; fallback mode already enabled"
  fi
}

(
  flock -n 9 || exit 0
  main
) 9>"$LOCK_FILE"
