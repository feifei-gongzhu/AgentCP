#!/usr/bin/env bash
#
# agent-compose installer
#
# Configures and starts the agent-compose docker-compose stack, pulling the
# multi-arch container images from the registry (ghcr.io by default; Docker
# selects the right architecture automatically).
#
# Run it from an extracted installer archive or via `curl ... | bash`. On first
# run it generates an admin password and prints it to the terminal.

set -euo pipefail

# --------------------------------------------------------------------------
# Defaults (override via flags or env)
# --------------------------------------------------------------------------
REPO="${AGENT_COMPOSE_REPO:-chaitin/agent-compose}"
INSTALL_DIR="${AGENT_COMPOSE_INSTALL_DIR:-./agent-compose}"
VERSION="latest"
FRONTEND_VERSION="${AGENT_COMPOSE_FRONTEND_VERSION:-latest}"
IMAGE_PREFIX=""
PORT=""
NO_START=0
UPGRADE=0
YES="${AGENT_COMPOSE_YES:-0}"
# Test seam: production uses /dev/kvm; deterministic installer tests point this
# at an existing or missing temporary path without touching the host device.
KVM_DETECT_PATH="${AGENT_COMPOSE_KVM_DETECT_PATH:-/dev/kvm}"

log()  { printf '\033[0;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33mwarn:\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[0;31merror:\033[0m %s\n' "$*" >&2; }
die()  { err "$@"; exit 1; }

usage() {
  cat <<'EOF'
agent-compose installer

Usage: install.sh [options]

Options:
  --dir <path>           Install directory (default: ./agent-compose)
  --port <port>          Host port for the web UI (default: 80)
  --version <vX.Y.Z>     Release version to install (default: latest)
  --image-prefix <ref>   Pull images from this prefix (mirror / private registry)
                         instead of the default registry
  --upgrade              Update an existing install to the latest release
  --no-start             Lay down files but do not pull images or start
  -y, --yes              Run without the interactive confirmation prompt
  -h, --help             Show this help

Environment:
  AGENT_COMPOSE_REPO          GitHub repo for downloads (owner/name)
  AGENT_COMPOSE_INSTALL_DIR   Same as --dir
  AGENT_COMPOSE_FRONTEND_VERSION
                              Frontend image tag to use with --image-prefix
                              when no bundle manifest is available (default: latest)
  AGENT_COMPOSE_YES=1         Same as --yes
EOF
}

# --------------------------------------------------------------------------
# Arg parsing
# --------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)          INSTALL_DIR="${2:?--dir needs a value}"; shift 2 ;;
    --port)         PORT="${2:?--port needs a value}"; shift 2 ;;
    --version)      VERSION="${2:?--version needs a value}"; shift 2 ;;
    --image-prefix) IMAGE_PREFIX="${2:?--image-prefix needs a value}"; shift 2 ;;
    --upgrade)      UPGRADE=1; shift ;;
    --no-start)     NO_START=1; shift ;;
    -y|--yes)       YES=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "unknown option: $1 (try --help)" ;;
  esac
done

[ "$(uname -s)" = "Linux" ] || warn "this installer targets Linux; '$(uname -s)' may not work for the docker-compose stack"

# --------------------------------------------------------------------------
# Secret generation / env helpers
# --------------------------------------------------------------------------
gen_hex() { # $1 = byte count
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

gen_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-24
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-24
  fi
}

set_env() { # $1=file $2=key $3=value
  local file="$1" key="$2" value="$3"
  if has_active_env "$file" "$key"; then
    cp -p "$file" "${file}.tmp"
    awk -v k="$key" -v v="$value" '
      {
        lines[NR] = $0
        line = $0
        sub(/^[[:space:]]*/, "", line)
        sub(/^export[[:space:]]+/, "", line)
        equals = index(line, "=")
        candidate = substr(line, 1, equals - 1)
        sub(/[[:space:]]*$/, "", candidate)
        if (equals > 0 && candidate == k) {
          last = NR
        }
      }
      END {
        for (i = 1; i <= NR; i++) {
          if (i == last) {
            original_equals = index(lines[i], "=")
            print substr(lines[i], 1, original_equals) v
          } else {
            print lines[i]
          }
        }
      }
    ' "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

get_env() { # $1=file $2=key -> value (may be empty)
  awk -v k="$2" '
    {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      sub(/^export[[:space:]]+/, "", line)
      equals = index(line, "=")
      candidate = substr(line, 1, equals - 1)
      sub(/[[:space:]]*$/, "", candidate)
    }
    equals > 0 && candidate == k {
      value = substr(line, equals + 1)
      sub(/\r$/, "", value)
      result = value
      found = 1
    }
    END {
      if (found) {
        print result
      }
    }
  ' "$1" 2>/dev/null || true
}

has_active_env() { # $1=file $2=key -> assignment exists, including an empty value
  grep -Eq "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*=" "$1" 2>/dev/null
}

truthy() {
  case "${1:-}" in
    1|yes|YES|true|TRUE|y|Y) return 0 ;;
    *) return 1 ;;
  esac
}

select_data_dir() {
  local configured current_db legacy_db
  current_db="$INSTALL_DIR/data/data.db"
  legacy_db="$INSTALL_DIR/data/agent-compose/data.db"

  if has_active_env "$EXISTING_ENV_FILE" AGENT_COMPOSE_DATA_DIR; then
    configured="$(get_env "$EXISTING_ENV_FILE" AGENT_COMPOSE_DATA_DIR)"
    case "$configured" in
      ./data|data) DATA_DIR_REL=./data ;;
      ./data/agent-compose|data/agent-compose) DATA_DIR_REL=./data/agent-compose ;;
      *)
        die "AGENT_COMPOSE_DATA_DIR must be ./data or ./data/agent-compose when using the installer"
        ;;
    esac
  elif [ -f "$current_db" ] && [ -f "$legacy_db" ]; then
    die "both current and legacy data stores exist; set AGENT_COMPOSE_DATA_DIR to ./data or ./data/agent-compose in $EXISTING_ENV_FILE before retrying"
  elif [ -f "$legacy_db" ]; then
    DATA_DIR_REL=./data/agent-compose
    warn "legacy data detected at $INSTALL_DIR/data/agent-compose; preserving its mount path"
  else
    DATA_DIR_REL=./data
  fi

  DATA_DIR_PATH="$INSTALL_DIR/${DATA_DIR_REL#./}"
  [ ! -d "$DATA_DIR_PATH" ] || DATA_DIR_EXISTED=1
}

apply_image_refs() { # $1=file $2=mode(install|set-missing|upgrade) $3=managed-state
  local file="$1" mode="$2" state_file="$3" key value pair current managed
  if [ -n "$IMAGE_PREFIX" ]; then
    for pair in \
      "AGENT_COMPOSE_IMAGE=${IMAGE_PREFIX}/agent-compose:${IMAGE_VERSION}" \
      "AGENT_COMPOSE_FRONTEND_VERSION=${FRONTEND_VERSION}" \
      "AGENT_COMPOSE_FRONTEND_IMAGE=${IMAGE_PREFIX}/agent-compose-ui:${FRONTEND_VERSION}" \
      "DEFAULT_IMAGE=${IMAGE_PREFIX}/agent-compose-guest:${IMAGE_VERSION}"; do
      key="${pair%%=*}"
      value="${pair#*=}"
      current="$(get_env "$file" "$key")"
      managed="$(get_env "$state_file" "$key")"
      apply_image_ref "$file" "$state_file" "$mode" "$key" "$value" "$current" "$managed"
    done
  elif [ -f "$MANIFEST" ]; then
    while IFS='=' read -r key value; do
      case "$key" in
        AGENT_COMPOSE_IMAGE|AGENT_COMPOSE_FRONTEND_VERSION|AGENT_COMPOSE_FRONTEND_IMAGE|DEFAULT_IMAGE)
          current="$(get_env "$file" "$key")"
          managed="$(get_env "$state_file" "$key")"
          apply_image_ref "$file" "$state_file" "$mode" "$key" "$value" "$current" "$managed"
          ;;
      esac
    done < "$MANIFEST"
  fi
}

apply_image_ref() { # $1=env $2=state $3=mode $4=key $5=desired $6=current $7=managed
  local file="$1" state_file="$2" mode="$3" key="$4" desired="$5" current="$6" managed="$7"
  if [ "$mode" = "install" ] || [ -z "$current" ]; then
    set_env "$file" "$key" "$desired"
    set_env "$state_file" "$key" "$desired"
    log "Set $key in $file"
  elif [ "$mode" = "upgrade" ] && [ -n "$managed" ] && [ "$current" = "$managed" ]; then
    set_env "$file" "$key" "$desired"
    set_env "$state_file" "$key" "$desired"
    log "Updated installer-managed $key in $file"
  elif [ -n "$managed" ] && [ "$current" = "$managed" ]; then
    warn "$key has a newer installer-managed value available; use --upgrade to update it"
  elif [ "$current" != "$desired" ]; then
    warn "$key is user-managed; keeping existing image ref"
  fi
}

# --------------------------------------------------------------------------
# Locate bundle source (bundled vs remote)
# --------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
BUNDLE_SRC=""
TMP_DIR=""
WORK_DIR=""
ROLLBACK_DIR=""
INSTALL_DIR_ABS=""
INSTALL_MUTATED=0
INSTALL_SUCCEEDED=0
INSTALL_DIR_EXISTED=0
INSTALL_DIR_CREATED=0
INSTALL_DIR_CREATED_PATH=""
DATA_DIR_REL=""
DATA_DIR_PATH=""
DATA_DIR_EXISTED=0
PREVIOUS_INSTALL=0
UP_ATTEMPTED=0
installer_temp_files=()

managed_files=(docker-compose.yml docker-compose.kvm.yml install.sh .env .installer-state.env)

snapshot_candidate_for_recovery() {
  local name recovery_dir="$ROLLBACK_DIR/recovery-install"
  mkdir -p "$recovery_dir" || return 1
  for name in "${managed_files[@]}"; do
    if [ -f "$INSTALL_DIR_ABS/$name" ]; then
      cp -p "$INSTALL_DIR_ABS/$name" "$recovery_dir/$name" || return 1
    fi
  done
}

restore_installation() {
  local name destination temporary restore_status=0
  [ -n "$ROLLBACK_DIR" ] && [ -n "$INSTALL_DIR_ABS" ] || return 0
  for name in "${managed_files[@]}"; do
    destination="$INSTALL_DIR_ABS/$name"
    if [ -f "$ROLLBACK_DIR/$name.present" ]; then
      if ! temporary="$(mktemp "${destination}.installer-restore.XXXXXX")"; then
        restore_status=1
        continue
      fi
      installer_temp_files+=("$temporary")
      if ! cp -p "$ROLLBACK_DIR/$name" "$temporary" || ! mv -f "$temporary" "$destination"; then
        restore_status=1
      fi
    else
      rm -f "$destination" || restore_status=1
    fi
  done
  if [ "$DATA_DIR_EXISTED" -eq 0 ]; then
    if [ -L "$INSTALL_DIR_ABS/data" ] || [ -L "$INSTALL_DIR_ABS/data/agent-compose" ]; then
      restore_status=1
    else
      rm -rf "$DATA_DIR_PATH" || restore_status=1
      if [ "$DATA_DIR_REL" = "./data/agent-compose" ]; then
        rmdir "$INSTALL_DIR_ABS/data" 2>/dev/null || true
      fi
    fi
  fi
  if [ "$INSTALL_DIR_EXISTED" -eq 0 ]; then
    rm -rf "$INSTALL_DIR_ABS" || restore_status=1
  fi
  return "$restore_status"
}

cleanup() {
  local status=$? restore_status=0 recovery_status=0 preserve_rollback=0 temporary
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$INSTALL_MUTATED" -eq 1 ] && [ "$INSTALL_SUCCEEDED" -eq 0 ]; then
    if [ "$UP_ATTEMPTED" -eq 1 ] && [ "$PREVIOUS_INSTALL" -eq 0 ]; then
      if ! run_installed_compose down --remove-orphans >/dev/null 2>&1; then
        recovery_status=1
        snapshot_candidate_for_recovery || restore_status=1
      fi
    fi
    if [ "$UP_ATTEMPTED" -eq 1 ] && [ "$PREVIOUS_INSTALL" -eq 0 ] && [ "$recovery_status" -ne 0 ]; then
      # Keep the candidate project in place so the operator still has the
      # exact Compose selection and credentials required to remove orphans.
      restore_status=1
    else
      restore_installation || restore_status=1
    fi
    if [ "$UP_ATTEMPTED" -eq 1 ] && [ "$PREVIOUS_INSTALL" -eq 1 ] && [ "$restore_status" -eq 0 ]; then
      run_installed_compose up -d >/dev/null 2>&1 || recovery_status=1
    fi
    if [ "$restore_status" -eq 0 ] && [ "$recovery_status" -eq 0 ]; then
      warn "installation failed; restored managed files in $INSTALL_DIR_ABS"
    else
      preserve_rollback=1
      warn "installation failed and recovery was incomplete in $INSTALL_DIR_ABS; backups retained at $ROLLBACK_DIR"
    fi
  elif [ "$status" -ne 0 ] && [ "$INSTALL_DIR_CREATED" -eq 1 ] && [ "$INSTALL_MUTATED" -eq 0 ]; then
    rmdir "$INSTALL_DIR_CREATED_PATH" 2>/dev/null || true
  fi
  for temporary in "${installer_temp_files[@]}"; do
    rm -f "$temporary"
  done
  [ -z "$TMP_DIR" ] || rm -rf "$TMP_DIR"
  [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"
  if [ "$preserve_rollback" -eq 0 ]; then
    [ -z "$ROLLBACK_DIR" ] || rm -rf "$ROLLBACK_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT

# images/manifest.env only exists in a real installer bundle, so it
# disambiguates from a source checkout that also has a docker-compose.yml.
# An ordinary install uses that adjacent bundle. Upgrade always downloads the
# selected release so an old extracted installer cannot silently reinstall
# itself.
ADJACENT_BUNDLE=0
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/docker-compose.yml" ] \
   && [ -f "$SCRIPT_DIR/images/manifest.env" ]; then
  ADJACENT_BUNDLE=1
fi
if [ "$ADJACENT_BUNDLE" -eq 1 ] && [ "$UPGRADE" -eq 0 ]; then
  BUNDLE_SRC="$SCRIPT_DIR"
  log "Running from extracted bundle: $BUNDLE_SRC"
else
  command -v curl >/dev/null 2>&1 || die "curl is required for remote install"
  command -v tar  >/dev/null 2>&1 || die "tar is required for remote install"
  asset="agent-compose-installer.tar.gz"
  if [ "$VERSION" = "latest" ]; then
    url="https://github.com/${REPO}/releases/latest/download/${asset}"
  else
    url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
  fi
  TMP_DIR="$(mktemp -d)"
  log "Downloading ${asset} (${VERSION})"
  curl -fsSL -o "$TMP_DIR/$asset" "$url" || die "download failed: $url"
  shasums_url="${url%/*}/SHASUMS256.txt"
  if curl -fsSL -o "$TMP_DIR/SHASUMS256.txt" "$shasums_url" 2>/dev/null; then
    if ( cd "$TMP_DIR" && awk -v a="$asset" '$2 == a || $2 == "./" a' SHASUMS256.txt | sha256sum -c - >/dev/null 2>&1 ); then
      log "Checksum OK"
    else
      die "checksum verification failed for $asset"
    fi
  else
    warn "checksum file unavailable; skipping verification"
  fi
  tar -xzf "$TMP_DIR/$asset" -C "$TMP_DIR"
  BUNDLE_SRC="$(find "$TMP_DIR" -maxdepth 2 -name docker-compose.yml -exec dirname {} \; | head -n1)"
  [ -n "$BUNDLE_SRC" ] || die "extracted bundle is missing docker-compose.yml"
fi

# --------------------------------------------------------------------------
# Bundle and target preflight
# --------------------------------------------------------------------------
command -v realpath >/dev/null 2>&1 || die "realpath is required for safe install-path validation"
INSTALL_DIR_LEXICAL="$(realpath -ms -- "$INSTALL_DIR")"
INSTALL_DIR_RESOLVED="$(realpath -m -- "$INSTALL_DIR")"
if [ "$INSTALL_DIR_LEXICAL" != "$INSTALL_DIR_RESOLVED" ]; then
  die "refusing install path with symlink components: $INSTALL_DIR"
fi
INSTALL_DIR="$INSTALL_DIR_LEXICAL"

validate_install_path_identity() {
  local lexical resolved
  lexical="$(realpath -ms -- "$INSTALL_DIR")"
  resolved="$(realpath -m -- "$INSTALL_DIR")"
  [ "$lexical" = "$INSTALL_DIR" ] && [ "$resolved" = "$INSTALL_DIR" ] && [ ! -L "$INSTALL_DIR" ] \
    || die "refusing install path changed through symlink components: $INSTALL_DIR"
}

validate_data_paths() {
  local data_path
  for data_path in "$INSTALL_DIR/data" "$INSTALL_DIR/data/agent-compose"; do
    if [ -L "$data_path" ] || { [ -e "$data_path" ] && [ ! -d "$data_path" ]; }; then
      die "refusing unsafe data-directory target: $data_path"
    fi
  done
}

for required in docker-compose.yml .env.example; do
  [ -f "$BUNDLE_SRC/$required" ] && [ ! -L "$BUNDLE_SRC/$required" ] \
    || die "installer bundle is missing regular file $required"
done
if [ -e "$BUNDLE_SRC/docker-compose.kvm.yml" ] || [ -L "$BUNDLE_SRC/docker-compose.kvm.yml" ]; then
  [ -f "$BUNDLE_SRC/docker-compose.kvm.yml" ] && [ ! -L "$BUNDLE_SRC/docker-compose.kvm.yml" ] \
    || die "installer bundle KVM overlay must be a regular file"
fi
if [ -L "$INSTALL_DIR" ]; then
  die "refusing symlink install directory: $INSTALL_DIR"
fi
if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
  die "install target exists and is not a directory: $INSTALL_DIR"
fi
[ -d "$INSTALL_DIR" ] && INSTALL_DIR_EXISTED=1
validate_data_paths
for name in "${managed_files[@]}"; do
  target="$INSTALL_DIR/$name"
  if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
    die "refusing unsafe managed-file target: $target"
  fi
done

KVM_AVAILABLE=0
[ -e "$KVM_DETECT_PATH" ] && KVM_AVAILABLE=1
KVM_OVERLAY_AVAILABLE=0
if [ -f "$BUNDLE_SRC/docker-compose.kvm.yml" ] || [ -f "$INSTALL_DIR/docker-compose.kvm.yml" ]; then
  KVM_OVERLAY_AVAILABLE=1
fi

EXISTING_ENV_FILE="$INSTALL_DIR/.env"
select_data_dir
COMPOSE_SELECTION_EXPLICIT=0
if has_active_env "$EXISTING_ENV_FILE" COMPOSE_FILE; then
  COMPOSE_SELECTION_EXPLICIT=1
  COMPOSE_STATE="existing COMPOSE_FILE selection will be preserved"
  if [ "$KVM_AVAILABLE" -eq 0 ]; then
    warn "$KVM_DETECT_PATH not present; preserving the existing explicit Compose selection"
  fi
elif has_active_env "$EXISTING_ENV_FILE" COMPOSE_PATH_SEPARATOR; then
  die "existing COMPOSE_PATH_SEPARATOR requires an explicit COMPOSE_FILE before installation"
elif [ "$KVM_AVAILABLE" -eq 1 ]; then
  [ "$KVM_OVERLAY_AVAILABLE" -eq 1 ] \
    || die "KVM detected at $KVM_DETECT_PATH but docker-compose.kvm.yml is unavailable"
  COMPOSE_STATE="docker-compose.yml:docker-compose.kvm.yml (KVM enabled)"
else
  COMPOSE_STATE="docker-compose.yml (Docker-only; KVM unavailable)"
  warn "$KVM_DETECT_PATH not present; persisting Docker-only Compose selection"
fi

# --------------------------------------------------------------------------
# Prerequisites
# --------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
  COMPOSE_DISPLAY="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
  COMPOSE_DISPLAY="docker-compose"
else
  die "docker compose (v2) is required"
fi

# --------------------------------------------------------------------------
# Explicit confirmation before changing the installation directory
# --------------------------------------------------------------------------
if [ -f "$INSTALL_DIR/.env" ]; then
  ENV_STATE="existing .env will be preserved"
else
  ENV_STATE="new .env will be created with generated credentials"
fi
if [ "$UPGRADE" -eq 1 ]; then
  IMAGE_STATE="installer-managed image refs will be updated; custom refs will be preserved"
else
  IMAGE_STATE="existing image refs in .env will be kept"
fi
if [ "$NO_START" -eq 1 ]; then
  START_STATE="stack will not be started (--no-start)"
else
  START_STATE="images will be pulled and the stack will be started"
fi

cat <<EOF

agent-compose deployment plan
  Source:       $BUNDLE_SRC
  Target dir:   $INSTALL_DIR
  Data dir:     $DATA_DIR_PATH
  Config:       $ENV_STATE
  Compose:      $COMPOSE_STATE
  Images:       $IMAGE_STATE
  Start:        $START_STATE

EOF

if ! truthy "$YES"; then
  if [ ! -r /dev/tty ]; then
    die "confirmation requires a TTY; rerun with --yes or AGENT_COMPOSE_YES=1"
  fi
  printf 'Continue? [y/N] ' > /dev/tty
  read -r answer < /dev/tty
  case "$answer" in
    y|Y|yes|YES) ;;
    *) die "installation cancelled" ;;
  esac
fi

# --------------------------------------------------------------------------
# Build candidate files without changing the installation
# --------------------------------------------------------------------------
WORK_DIR="$(mktemp -d)"
cp "$BUNDLE_SRC/docker-compose.yml" "$WORK_DIR/docker-compose.yml"
if [ -f "$BUNDLE_SRC/docker-compose.kvm.yml" ]; then
  cp "$BUNDLE_SRC/docker-compose.kvm.yml" "$WORK_DIR/docker-compose.kvm.yml"
elif [ -f "$INSTALL_DIR/docker-compose.kvm.yml" ]; then
  cp "$INSTALL_DIR/docker-compose.kvm.yml" "$WORK_DIR/docker-compose.kvm.yml"
fi
if [ -f "$BUNDLE_SRC/install.sh" ]; then
  cp "$BUNDLE_SRC/install.sh" "$WORK_DIR/install.sh"
fi

# Manifest pins the compose image refs to this release's version.
MANIFEST="$BUNDLE_SRC/images/manifest.env"
IMAGE_VERSION="$VERSION"
if [ -f "$MANIFEST" ]; then
  ref="$(get_env "$MANIFEST" AGENT_COMPOSE_IMAGE)"
  [ -n "$ref" ] && IMAGE_VERSION="${ref##*:}"
fi

GENERATED_PASSWORD=""
ENV_FILE="$INSTALL_DIR/.env"
CANDIDATE_ENV="$WORK_DIR/.env"
STATE_FILE="$INSTALL_DIR/.installer-state.env"
CANDIDATE_STATE="$WORK_DIR/.installer-state.env"
if [ -f "$STATE_FILE" ]; then
  cp -p "$STATE_FILE" "$CANDIDATE_STATE"
else
  : >"$CANDIDATE_STATE"
fi
if [ ! -f "$ENV_FILE" ]; then
  cp "$BUNDLE_SRC/.env.example" "$CANDIDATE_ENV"

  set_env "$CANDIDATE_ENV" AUTH_SECRET "$(gen_hex 32)"

  GENERATED_PASSWORD="$(gen_password)"
  set_env "$CANDIDATE_ENV" AUTH_PASSWORD "$GENERATED_PASSWORD"

  apply_image_refs "$CANDIDATE_ENV" install "$CANDIDATE_STATE"
  [ -n "$PORT" ] && set_env "$CANDIDATE_ENV" AGENT_COMPOSE_HTTP_PORT "$PORT"
else
  cp -p "$ENV_FILE" "$CANDIDATE_ENV"
  warn "$ENV_FILE already exists; preserving configured settings"
  if [ -z "$(get_env "$CANDIDATE_ENV" AUTH_SECRET)" ]; then
    set_env "$CANDIDATE_ENV" AUTH_SECRET "$(gen_hex 32)"
    log "Generated missing AUTH_SECRET in $ENV_FILE"
  fi
  if [ -z "$(get_env "$CANDIDATE_ENV" AUTH_PASSWORD)" ]; then
    GENERATED_PASSWORD="$(gen_password)"
    set_env "$CANDIDATE_ENV" AUTH_PASSWORD "$GENERATED_PASSWORD"
    log "Generated missing AUTH_PASSWORD in $ENV_FILE"
  fi
  if [ "$UPGRADE" -eq 1 ]; then
    apply_image_refs "$CANDIDATE_ENV" upgrade "$CANDIDATE_STATE"
  else
    apply_image_refs "$CANDIDATE_ENV" set-missing "$CANDIDATE_STATE"
  fi
  [ -n "$PORT" ] && set_env "$CANDIDATE_ENV" AGENT_COMPOSE_HTTP_PORT "$PORT"
fi

set_env "$CANDIDATE_ENV" AGENT_COMPOSE_DATA_DIR "$DATA_DIR_REL"

if [ "$COMPOSE_SELECTION_EXPLICIT" -eq 0 ]; then
  if [ "$KVM_AVAILABLE" -eq 1 ]; then
    set_env "$CANDIDATE_ENV" COMPOSE_FILE "docker-compose.yml:docker-compose.kvm.yml"
  else
    set_env "$CANDIDATE_ENV" COMPOSE_FILE "docker-compose.yml"
  fi
fi
chmod 600 "$CANDIDATE_ENV"
chmod 600 "$CANDIDATE_STATE"

# --------------------------------------------------------------------------
# Atomically promote managed files, with rollback on any later failure
# --------------------------------------------------------------------------
atomic_install_file() { # $1=source $2=destination $3=mode
  local source="$1" destination="$2" mode="$3" preserve_metadata="${4:-0}" temporary
  temporary="$(mktemp "${destination}.installer-tmp.XXXXXX")"
  installer_temp_files+=("$temporary")
  if [ "$preserve_metadata" -eq 1 ]; then
    cp -p "$source" "$temporary"
  else
    cp "$source" "$temporary"
  fi
  chmod "$mode" "$temporary"
  mv -f "$temporary" "$destination"
}

ROLLBACK_DIR="$(mktemp -d)"
validate_install_path_identity
mkdir -p -- "$INSTALL_DIR"
validate_install_path_identity
validate_data_paths
if [ "$INSTALL_DIR_EXISTED" -eq 0 ]; then
  INSTALL_DIR_CREATED=1
  INSTALL_DIR_CREATED_PATH="$INSTALL_DIR"
fi
INSTALL_DIR_ABS="$(cd -P -- "$INSTALL_DIR" && pwd)"
[ "$INSTALL_DIR_ABS" = "$INSTALL_DIR" ] \
  || die "refusing install path changed during creation: $INSTALL_DIR"
INSTALL_DIR="$INSTALL_DIR_ABS"
ENV_FILE="$INSTALL_DIR/.env"
DATA_DIR_PATH="$INSTALL_DIR/${DATA_DIR_REL#./}"
for name in "${managed_files[@]}"; do
  target="$INSTALL_DIR/$name"
  if [ -f "$target" ]; then
    cp -p "$target" "$ROLLBACK_DIR/$name"
    touch "$ROLLBACK_DIR/$name.present"
  fi
done
if [ -f "$ROLLBACK_DIR/docker-compose.yml.present" ] && [ -f "$ROLLBACK_DIR/.env.present" ]; then
  PREVIOUS_INSTALL=1
fi

INSTALL_MUTATED=1
atomic_install_file "$WORK_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml" 644
if [ -f "$BUNDLE_SRC/docker-compose.kvm.yml" ]; then
  atomic_install_file "$WORK_DIR/docker-compose.kvm.yml" "$INSTALL_DIR/docker-compose.kvm.yml" 644
fi
if [ -f "$WORK_DIR/install.sh" ]; then
  atomic_install_file "$WORK_DIR/install.sh" "$INSTALL_DIR/install.sh" 755
fi
atomic_install_file "$CANDIDATE_ENV" "$ENV_FILE" 600 1
atomic_install_file "$CANDIDATE_STATE" "$INSTALL_DIR/.installer-state.env" 600 1
validate_data_paths
mkdir -p "$DATA_DIR_PATH"
if [ ! -f "$ROLLBACK_DIR/.env.present" ]; then
  log "Created $ENV_FILE"
fi

# --------------------------------------------------------------------------
# Validate and start using the persisted project .env selection
# --------------------------------------------------------------------------
run_installed_compose() {
  (
    cd "$INSTALL_DIR"
    unset COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME
    "${COMPOSE_CMD[@]}" "$@"
  )
}

run_installed_compose config --quiet

HTTP_PORT="$(get_env "$ENV_FILE" AGENT_COMPOSE_HTTP_PORT)"; HTTP_PORT="${HTTP_PORT:-80}"
USERNAME="$(get_env "$ENV_FILE" AUTH_USERNAME)"; USERNAME="${USERNAME:-admin}"
printf -v INSTALL_DIR_SHELL '%q' "$INSTALL_DIR"

if [ "$NO_START" -eq 1 ]; then
  log "Skipping start (--no-start). Run later with: cd $INSTALL_DIR_SHELL && $COMPOSE_DISPLAY up -d"
else
  log "Pulling images and starting the stack"
  run_installed_compose pull
  UP_ATTEMPTED=1
  run_installed_compose up -d
fi
INSTALL_SUCCEEDED=1

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
printf '\n'
if [ "$NO_START" -eq 1 ]; then
  printf '\033[0;32m============= agent-compose installation prepared =============\033[0m\n'
else
  printf '\033[0;32m================ agent-compose is ready ================\033[0m\n'
fi
printf '  URL:        http://localhost:%s\n' "$HTTP_PORT"
printf '  Directory:  %s\n' "$INSTALL_DIR"
printf '  Compose:    %s\n' "$COMPOSE_STATE"
if [ -n "$GENERATED_PASSWORD" ]; then
  printf '\n  \033[1mLogin credentials (generated, shown only once):\033[0m\n'
  printf '    Username: %s\n' "$USERNAME"
  printf '    Password: \033[1m%s\033[0m\n' "$GENERATED_PASSWORD"
  printf '  Stored in %s (key AUTH_PASSWORD).\n' "$ENV_FILE"
else
  printf '\n  Credentials unchanged; see AUTH_PASSWORD in %s.\n' "$ENV_FILE"
fi
printf '\n  Manage: cd %s && %s [ps|logs -f|down]\n' "$INSTALL_DIR_SHELL" "$COMPOSE_DISPLAY"
printf '\033[0;32m========================================================\033[0m\n'
