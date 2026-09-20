#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/resource-identity-one-shot-reset.sh [options]

One-shot reset helper for the resource identity rollout.

This script does not migrate legacy data into the new identity model. It stops
the daemon, moves incompatible local state to a timestamped backup directory,
and optionally starts the daemon again so the new version can initialize fresh
storage.

Options:
  --data-dir DIR        agent-compose data directory. Default: ./data
  --compose-file FILE   docker compose file. Default: docker-compose.yml
  --service NAME        compose service name. Default: agent-compose
  --container NAME      container name used as fallback. Default: agent-compose
  --backup-dir DIR      backup parent directory. Default: <data-dir>/.resource-identity-backups
  --yes                 run without confirmation
  --dry-run             print actions without changing files or containers
  --no-stop             do not stop the daemon before moving state
  --restart             start the compose service after reset
  -h, --help            show this help

Examples:
  scripts/resource-identity-one-shot-reset.sh --yes --restart
  scripts/resource-identity-one-shot-reset.sh --data-dir /data/agent-compose --yes
EOF
}

log() {
  printf '[resource-identity-reset] %s\n' "$*"
}

die() {
  printf '[resource-identity-reset] error: %s\n' "$*" >&2
  exit 1
}

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[resource-identity-reset] dry-run:'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

confirm() {
  if [[ "$ASSUME_YES" == "1" || "$DRY_RUN" == "1" ]]; then
    return 0
  fi
  cat <<EOF
This will move legacy agent-compose local state out of:
  $DATA_DIR

Backup destination:
  $BACKUP_DIR/$STAMP

The new daemon will start with a fresh data.db and fresh runtime state.
EOF
  printf 'Continue? [y/N] '
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) die "aborted" ;;
  esac
}

abs_path() {
  local path="$1"
  if [[ "$path" = /* ]]; then
    printf '%s\n' "$path"
    return 0
  fi
  printf '%s/%s\n' "$PWD" "$path"
}

compose_cmd_available() {
  docker compose version >/dev/null 2>&1
}

compose_service_exists() {
  [[ -f "$COMPOSE_FILE" ]] || return 1
  compose_cmd_available || return 1
  docker compose --project-directory "$COMPOSE_PROJECT_DIR" -f "$COMPOSE_FILE" config --services 2>/dev/null | grep -Fxq "$SERVICE"
}

stop_daemon() {
  if [[ "$NO_STOP" == "1" ]]; then
    log "skip stopping daemon (--no-stop)"
    return 0
  fi
  if compose_service_exists; then
    log "stopping compose service $SERVICE"
    run docker compose --project-directory "$COMPOSE_PROJECT_DIR" -f "$COMPOSE_FILE" stop "$SERVICE"
    return 0
  fi
  if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER"; then
    log "stopping container $CONTAINER"
    run docker stop "$CONTAINER"
    return 0
  fi
  log "daemon container not found; continuing"
}

restart_daemon() {
  if [[ "$RESTART" != "1" ]]; then
    return 0
  fi
  if ! compose_service_exists; then
    die "cannot restart: compose service $SERVICE not found in $COMPOSE_FILE"
  fi
  log "starting compose service $SERVICE"
  run docker compose --project-directory "$COMPOSE_PROJECT_DIR" -f "$COMPOSE_FILE" up -d "$SERVICE"
}

move_if_exists() {
  local source="$1"
  local dest_dir="$2"
  if [[ ! -e "$source" ]]; then
    return 0
  fi
  run mkdir -p "$dest_dir"
  log "moving $(basename "$source") to $dest_dir/"
  run mv "$source" "$dest_dir/"
}

print_sqlite_summary() {
  local db="$1"
  if [[ ! -f "$db" ]] || ! command -v sqlite3 >/dev/null 2>&1; then
    return 0
  fi
  log "legacy sqlite summary:"
  sqlite3 "$db" <<'SQL' || true
.headers on
.mode column
SELECT 'project' AS table_name, COUNT(*) AS rows FROM project
UNION ALL SELECT 'project_agent', COUNT(*) FROM project_agent
UNION ALL SELECT 'project_scheduler', COUNT(*) FROM project_scheduler
UNION ALL SELECT 'project_run', COUNT(*) FROM project_run
UNION ALL SELECT 'agent_definition', COUNT(*) FROM agent_definition
UNION ALL SELECT 'loader', COUNT(*) FROM loader;
SQL
}

DATA_DIR="./data"
COMPOSE_FILE="docker-compose.yml"
SERVICE="agent-compose"
CONTAINER="agent-compose"
BACKUP_DIR=""
ASSUME_YES="0"
DRY_RUN="0"
NO_STOP="0"
RESTART="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir)
      DATA_DIR="${2:-}"
      [[ -n "$DATA_DIR" ]] || die "--data-dir requires a value"
      shift 2
      ;;
    --compose-file)
      COMPOSE_FILE="${2:-}"
      [[ -n "$COMPOSE_FILE" ]] || die "--compose-file requires a value"
      shift 2
      ;;
    --service)
      SERVICE="${2:-}"
      [[ -n "$SERVICE" ]] || die "--service requires a value"
      shift 2
      ;;
    --container)
      CONTAINER="${2:-}"
      [[ -n "$CONTAINER" ]] || die "--container requires a value"
      shift 2
      ;;
    --backup-dir)
      BACKUP_DIR="${2:-}"
      [[ -n "$BACKUP_DIR" ]] || die "--backup-dir requires a value"
      shift 2
      ;;
    --yes)
      ASSUME_YES="1"
      shift
      ;;
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    --no-stop)
      NO_STOP="1"
      shift
      ;;
    --restart)
      RESTART="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

DATA_DIR="$(abs_path "$DATA_DIR")"
COMPOSE_FILE="$(abs_path "$COMPOSE_FILE")"
COMPOSE_PROJECT_DIR="$(dirname "$COMPOSE_FILE")"
if [[ -z "$BACKUP_DIR" ]]; then
  BACKUP_DIR="$DATA_DIR/.resource-identity-backups"
else
  BACKUP_DIR="$(abs_path "$BACKUP_DIR")"
fi
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET_BACKUP="$BACKUP_DIR/$STAMP"

[[ -d "$DATA_DIR" ]] || die "data directory does not exist: $DATA_DIR"

print_sqlite_summary "$DATA_DIR/data.db"
confirm
stop_daemon

run mkdir -p "$TARGET_BACKUP"

for file in data.db data.db-wal data.db-shm; do
  move_if_exists "$DATA_DIR/$file" "$TARGET_BACKUP"
done

for dir in sessions docker boxlite microsandbox image-cache loaders; do
  move_if_exists "$DATA_DIR/$dir" "$TARGET_BACKUP"
done

log "backup created at $TARGET_BACKUP"
log "preserved directories not moved: images, work, .resource-identity-backups"
restart_daemon
log "done"
