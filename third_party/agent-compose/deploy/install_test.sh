#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE_INSTALLER="$ROOT_DIR/deploy/install.sh"

fail() {
  printf 'install_test: %s\n' "$*" >&2
  exit 1
}

assert_status() {
  local want=$1
  if [[ $RUN_STATUS -ne $want ]]; then
    printf 'stdout:\n' >&2
    sed 's/^/  /' "$RUN_STDOUT" >&2
    printf 'stderr:\n' >&2
    sed 's/^/  /' "$RUN_STDERR" >&2
    fail "status=$RUN_STATUS, want $want"
  fi
}

assert_success() {
  assert_status 0
}

assert_failure() {
  if [[ $RUN_STATUS -eq 0 ]]; then
    fail 'installer unexpectedly succeeded'
  fi
}

assert_contains() {
  local file=$1 text=$2
  grep -F -- "$text" "$file" >/dev/null || {
    printf 'file %s:\n' "$file" >&2
    sed 's/^/  /' "$file" >&2
    fail "missing expected text: $text"
  }
}

assert_not_contains() {
  local file=$1 text=$2
  if grep -F -- "$text" "$file" >/dev/null; then
    printf 'file %s:\n' "$file" >&2
    sed 's/^/  /' "$file" >&2
    fail "unexpected text: $text"
  fi
}

assert_env() {
  local file=$1 key=$2 want=$3 values count
  values=$(grep "^${key}=" "$file" 2>/dev/null || true)
  count=$(grep -c "^${key}=" "$file" 2>/dev/null || true)
  [[ $count -eq 1 ]] || fail "$file has $count active $key assignments, want 1"
  [[ ${values#*=} == "$want" ]] || fail "$file $key=${values#*=}, want $want"
}

assert_mode() {
  local file=$1 want=$2 got
  got=$(stat -c '%a' "$file")
  [[ $got == "$want" ]] || fail "$file mode=$got, want $want"
}

assert_installed_sequence() { # $1=install-dir $2=expected newline-delimited argv
  local install_dir=$1 expected=$2 actual
  actual=$(grep -F "cwd=$install_dir|" "$FAKE_DOCKER_LOG" | sed 's/^.*|args=//; s/ $//' || true)
  if [[ "$actual" != "$expected" ]]; then
    printf 'fake Docker log:\n' >&2
    sed 's/^/  /' "$FAKE_DOCKER_LOG" >&2
    printf 'actual installed sequence:\n%s\nexpected:\n%s\n' "$actual" "$expected" >&2
    fail 'installed Compose call sequence mismatch'
  fi
}

TMP_ROOT=$(mktemp -d)
PRESERVED_BACKUPS=()
cleanup_test() {
  local backup
  chmod -R u+w -- "$TMP_ROOT" 2>/dev/null || true
  rm -rf -- "$TMP_ROOT"
  for backup in "${PRESERVED_BACKUPS[@]}"; do
    rm -rf -- "$backup"
  done
}
trap cleanup_test EXIT

FAKE_BIN="$TMP_ROOT/fake-bin"
FAKE_DOCKER_LOG="$TMP_ROOT/fake-docker.log"
FAKE_DOCKER_COUNTER="$TMP_ROOT/fake-docker.counter"
FAKE_DOCKER_STATE="$TMP_ROOT/fake-docker.state"
REAL_MKTEMP=$(command -v mktemp)
FAKE_REMOTE_DIR="$TMP_ROOT/fake-release"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

output=''
url=''
while [[ $# -gt 0 ]]; do
  case $1 in
    -o)
      output=${2:?missing curl output}
      shift 2
      ;;
    -*) shift ;;
    *)
      url=$1
      shift
      ;;
  esac
done
case $url in
  */agent-compose-installer.tar.gz) cp "$FAKE_REMOTE_ARCHIVE" "$output" ;;
  */SHASUMS256.txt) cp "$FAKE_REMOTE_SHASUMS" "$output" ;;
  *) exit 22 ;;
esac
EOF
chmod +x "$FAKE_BIN/curl"

cat >"$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

selection='<absent>'
if [[ -f .env ]]; then
  value=$(grep '^COMPOSE_FILE=' .env 2>/dev/null | tail -n1 || true)
  if [[ -n "$value" ]]; then
    selection=${value#*=}
  elif grep -q '^COMPOSE_FILE=$' .env 2>/dev/null; then
    selection=''
  fi
fi
process_selection=${COMPOSE_FILE-<unset>}
data_dir=./data
if [[ -f .env ]]; then
  value=$(grep -E '^(export[[:space:]]+)?AGENT_COMPOSE_DATA_DIR=' .env 2>/dev/null | tail -n1 || true)
  [[ -z $value ]] || data_dir=${value#*=}
fi
{
  printf 'cwd=%s|process=%s|file=%s|args=' "$PWD" "$process_selection" "$selection"
  printf '%s ' "$@"
  printf '\n'
} >>"$FAKE_DOCKER_LOG"

[[ ${1:-} == compose ]] || exit 90
case ${2:-} in
  version)
    if [[ -n ${FAKE_DOCKER_VERSION_SYMLINK_TARGET:-} ]]; then
      ln -s "$FAKE_DOCKER_VERSION_SYMLINK_VICTIM" "$FAKE_DOCKER_VERSION_SYMLINK_TARGET"
    fi
    exit 0
    ;;
  config)
    [[ ${3:-} == --quiet ]] || exit 91
    [[ $selection != '' ]] || exit 95
    if [[ $selection == *docker-compose.kvm.yml* && ! -f docker-compose.kvm.yml ]]; then
      exit 92
    fi
    [[ ${FAKE_DOCKER_FAIL_COMMAND:-} == config ]] && exit 41
    exit 0
    ;;
  pull)
    [[ ${FAKE_DOCKER_FAIL_COMMAND:-} == pull ]] && exit 42
    exit 0
    ;;
  up)
    [[ ${3:-} == -d ]] || exit 93
    if [[ ${FAKE_DOCKER_FAIL_COMMAND:-} == up-once || ${FAKE_DOCKER_FAIL_COMMAND:-} == up-once-down-fails ]]; then
      count=$(cat "$FAKE_DOCKER_COUNTER" 2>/dev/null || printf '0')
      if [[ $count -eq 0 ]]; then
        printf '1\n' >"$FAKE_DOCKER_COUNTER"
        mkdir -p "$data_dir"
        printf 'partial\n' >"$data_dir/fake-partial"
        exit 43
      fi
    fi
    rm -f ./data/fake-partial ./data/agent-compose/fake-partial
    printf 'running\n' >"$FAKE_DOCKER_STATE"
    exit 0
    ;;
  down)
    [[ ${3:-} == --remove-orphans ]] || exit 96
    [[ ${FAKE_DOCKER_FAIL_COMMAND:-} == up-once-down-fails ]] && exit 45
    rm -f ./data/fake-partial ./data/agent-compose/fake-partial "$FAKE_DOCKER_STATE"
    exit 0
    ;;
  *)
    exit 94
    ;;
esac
EOF
cat >"$FAKE_BIN/mktemp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# Restoration creates temporary files beside managed destinations. Inject that
# boundary failure directly so the test behaves consistently for root (which
# may bypass directory write bits) and ordinary users.
if [[ ${FAKE_MKTEMP_FAIL_RESTORE:-0} == 1 && ${1:-} == *.installer-restore.XXXXXX ]]; then
  exit 73
fi
exec "$REAL_MKTEMP" "$@"
EOF
chmod +x "$FAKE_BIN/docker" "$FAKE_BIN/mktemp"

make_bundle() { # $1=name $2=with-overlay(0|1)
  BUNDLE="$TMP_ROOT/$1-bundle"
  mkdir -p "$BUNDLE/images"
  cp "$SOURCE_INSTALLER" "$BUNDLE/install.sh"
  cp "$ROOT_DIR/docker-compose.yml" "$BUNDLE/docker-compose.yml"
  cp "$ROOT_DIR/.env.example" "$BUNDLE/.env.example"
  if [[ $2 -eq 1 ]]; then
    cp "$ROOT_DIR/docker-compose.kvm.yml" "$BUNDLE/docker-compose.kvm.yml"
  fi
  chmod +x "$BUNDLE/install.sh"
  cat >"$BUNDLE/images/manifest.env" <<'EOF'
AGENT_COMPOSE_IMAGE=registry.example/agent-compose:v-test
AGENT_COMPOSE_FRONTEND_VERSION=v-ui
AGENT_COMPOSE_FRONTEND_IMAGE=registry.example/agent-compose-ui:v-ui
DEFAULT_IMAGE=registry.example/agent-compose-guest:v-test
EOF
}

write_user_env() { # $1=file
  cat >"$1" <<'EOF'
AUTH_USERNAME=operator
AUTH_PASSWORD=user-password
AUTH_SECRET=user-secret
AGENT_COMPOSE_IMAGE=custom.example/daemon:keep
AGENT_COMPOSE_FRONTEND_VERSION=keep-ui
AGENT_COMPOSE_FRONTEND_IMAGE=custom.example/ui:keep
DEFAULT_IMAGE=custom.example/guest:keep
CUSTOM_SETTING=keep-me
EOF
  chmod 640 "$1"
}

RUN_STDOUT="$TMP_ROOT/stdout"
RUN_STDERR="$TMP_ROOT/stderr"
RUN_STATUS=0
FAKE_DOCKER_FAIL_COMMAND=''
FAKE_DOCKER_VERSION_SYMLINK_TARGET=''
FAKE_DOCKER_VERSION_SYMLINK_VICTIM=''
FAKE_MKTEMP_FAIL_RESTORE=0

run_installer() { # $1=bundle $2=install-dir $3=kvm-path, remaining=args
  local bundle=$1 install_dir=$2 kvm_path=$3
  shift 3
  rm -rf "$FAKE_REMOTE_DIR"
  mkdir -p "$FAKE_REMOTE_DIR"
  tar -czf "$FAKE_REMOTE_DIR/agent-compose-installer.tar.gz" \
    -C "$(dirname "$bundle")" "$(basename "$bundle")"
  (
    cd "$FAKE_REMOTE_DIR"
    sha256sum agent-compose-installer.tar.gz >SHASUMS256.txt
  )
  : >"$RUN_STDOUT"
  : >"$RUN_STDERR"
  : >"$FAKE_DOCKER_LOG"
  : >"$FAKE_DOCKER_COUNTER"
  rm -f "$FAKE_DOCKER_STATE"
  set +e
  env \
    PATH="$FAKE_BIN:$PATH" \
    FAKE_DOCKER_LOG="$FAKE_DOCKER_LOG" \
    FAKE_DOCKER_COUNTER="$FAKE_DOCKER_COUNTER" \
    FAKE_DOCKER_STATE="$FAKE_DOCKER_STATE" \
    FAKE_DOCKER_FAIL_COMMAND="$FAKE_DOCKER_FAIL_COMMAND" \
    FAKE_DOCKER_VERSION_SYMLINK_TARGET="$FAKE_DOCKER_VERSION_SYMLINK_TARGET" \
    FAKE_DOCKER_VERSION_SYMLINK_VICTIM="$FAKE_DOCKER_VERSION_SYMLINK_VICTIM" \
    FAKE_MKTEMP_FAIL_RESTORE="$FAKE_MKTEMP_FAIL_RESTORE" \
    REAL_MKTEMP="$REAL_MKTEMP" \
    FAKE_REMOTE_ARCHIVE="$FAKE_REMOTE_DIR/agent-compose-installer.tar.gz" \
    FAKE_REMOTE_SHASUMS="$FAKE_REMOTE_DIR/SHASUMS256.txt" \
    AGENT_COMPOSE_KVM_DETECT_PATH="$kvm_path" \
    AGENT_COMPOSE_YES=1 \
    COMPOSE_FILE=hostile-parent.yml \
    COMPOSE_PATH_SEPARATOR=';' \
    COMPOSE_ENV_FILES=/missing/host.env \
    COMPOSE_DISABLE_ENV_FILE=1 \
    COMPOSE_PROFILES=with-ui \
    COMPOSE_PROJECT_NAME=hostile-parent \
    bash "$bundle/install.sh" --dir "$install_dir" --yes "$@" >"$RUN_STDOUT" 2>"$RUN_STDERR"
  RUN_STATUS=$?
  set -e
}

real_compose_json() { # $1=install-dir
  (
    cd "$1"
    unset COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME
    docker compose config --format json
  )
}

MISSING_KVM="$TMP_ROOT/missing-kvm"
PRESENT_KVM="$TMP_ROOT/present-kvm"
: >"$PRESENT_KVM"

# New Docker-only --no-start install persists the base file, copies the optional
# overlay, protects secrets, quotes a spaced path, and never pulls or starts.
make_bundle new-base 1
base_install="$TMP_ROOT/install base"
run_installer "$BUNDLE" "$base_install" "$MISSING_KVM" --no-start
assert_success
assert_env "$base_install/.env" COMPOSE_FILE docker-compose.yml
assert_env "$base_install/.env" AGENT_COMPOSE_DATA_DIR ./data
assert_mode "$base_install/.env" 600
assert_mode "$base_install/.installer-state.env" 600
assert_mode "$base_install/docker-compose.yml" 644
assert_mode "$base_install/docker-compose.kvm.yml" 644
assert_mode "$base_install/install.sh" 755
cmp "$BUNDLE/docker-compose.kvm.yml" "$base_install/docker-compose.kvm.yml" >/dev/null || fail 'KVM overlay was not copied'
assert_contains "$RUN_STDERR" 'persisting Docker-only Compose selection'
assert_contains "$RUN_STDOUT" 'agent-compose installation prepared'
assert_not_contains "$RUN_STDOUT" 'agent-compose is ready'
printf -v quoted_base_install '%q' "$base_install"
assert_contains "$RUN_STDOUT" "cd $quoted_base_install && docker compose up -d"
assert_contains "$FAKE_DOCKER_LOG" "cwd=$base_install|process=<unset>|file=docker-compose.yml|args=compose config --quiet "
assert_not_contains "$FAKE_DOCKER_LOG" 'args=compose pull '
assert_not_contains "$FAKE_DOCKER_LOG" 'args=compose up -d '
assert_installed_sequence "$base_install" 'compose config --quiet'
[[ -d $base_install/data ]] || fail 'new install did not create the current data directory'
[[ ! -e $base_install/data/agent-compose ]] || fail 'new install unexpectedly created the legacy data directory'
base_json=$(real_compose_json "$base_install")
jq -e '.services["agent-compose"].privileged != true and ((.services["agent-compose"].devices // []) | length == 0)' >/dev/null <<<"$base_json"
jq -e --arg source "$base_install/data" 'any(.services["agent-compose"].volumes[]; .source == $source and .target == "/data")' >/dev/null <<<"$base_json"

# Upgrades preserve the only populated layout and persist it so later Compose
# runs cannot silently switch databases. Ambiguous dual-database installs stop
# before mutation until the operator selects the authoritative store.
make_bundle data-layout 1
legacy_data_install="$TMP_ROOT/legacy-data-layout"
mkdir -p "$legacy_data_install/data/agent-compose"
printf 'legacy-db\n' >"$legacy_data_install/data/agent-compose/data.db"
write_user_env "$legacy_data_install/.env"
printf '%s\n' 'COMPOSE_FILE=docker-compose.yml' >>"$legacy_data_install/.env"
run_installer "$BUNDLE" "$legacy_data_install" "$MISSING_KVM" --upgrade --no-start
assert_success
assert_env "$legacy_data_install/.env" AGENT_COMPOSE_DATA_DIR ./data/agent-compose
assert_contains "$RUN_STDERR" 'legacy data detected'
assert_contains "$RUN_STDOUT" "Data dir:     $legacy_data_install/data/agent-compose"
assert_contains "$legacy_data_install/data/agent-compose/data.db" legacy-db
legacy_data_json=$(real_compose_json "$legacy_data_install")
jq -e --arg source "$legacy_data_install/data/agent-compose" 'any(.services["agent-compose"].volumes[]; .source == $source and .target == "/data")' >/dev/null <<<"$legacy_data_json"

current_data_install="$TMP_ROOT/current-data-layout"
mkdir -p "$current_data_install/data"
printf 'current-db\n' >"$current_data_install/data/data.db"
write_user_env "$current_data_install/.env"
printf '%s\n' 'COMPOSE_FILE=docker-compose.yml' >>"$current_data_install/.env"
run_installer "$BUNDLE" "$current_data_install" "$MISSING_KVM" --upgrade --no-start
assert_success
assert_env "$current_data_install/.env" AGENT_COMPOSE_DATA_DIR ./data
assert_contains "$current_data_install/data/data.db" current-db

ambiguous_data_install="$TMP_ROOT/ambiguous-data-layout"
mkdir -p "$ambiguous_data_install/data/agent-compose"
printf 'current-db\n' >"$ambiguous_data_install/data/data.db"
printf 'legacy-db\n' >"$ambiguous_data_install/data/agent-compose/data.db"
write_user_env "$ambiguous_data_install/.env"
printf '%s\n' 'COMPOSE_FILE=docker-compose.yml' >>"$ambiguous_data_install/.env"
ambiguous_env_before=$(sha256sum "$ambiguous_data_install/.env")
run_installer "$BUNDLE" "$ambiguous_data_install" "$MISSING_KVM" --upgrade --no-start
assert_failure
assert_contains "$RUN_STDERR" 'both current and legacy data stores exist'
[[ $(sha256sum "$ambiguous_data_install/.env") == "$ambiguous_env_before" ]] || fail 'ambiguous data preflight changed .env'
[[ ! -e $ambiguous_data_install/docker-compose.yml ]] || fail 'ambiguous data preflight installed Compose files'
printf '%s\n' 'AGENT_COMPOSE_DATA_DIR=./data/agent-compose' >>"$ambiguous_data_install/.env"
run_installer "$BUNDLE" "$ambiguous_data_install" "$MISSING_KVM" --upgrade --no-start
assert_success
assert_env "$ambiguous_data_install/.env" AGENT_COMPOSE_DATA_DIR ./data/agent-compose

# New KVM install uses the dual persisted selection for config, pull, and up.
make_bundle new-kvm 1
kvm_install="$TMP_ROOT/install-kvm"
run_installer "$BUNDLE" "$kvm_install" "$PRESENT_KVM"
assert_success
assert_env "$kvm_install/.env" COMPOSE_FILE 'docker-compose.yml:docker-compose.kvm.yml'
for args in 'compose config --quiet ' 'compose pull ' 'compose up -d '; do
  assert_contains "$FAKE_DOCKER_LOG" "cwd=$kvm_install|process=<unset>|file=docker-compose.yml:docker-compose.kvm.yml|args=$args"
done
assert_installed_sequence "$kvm_install" $'compose config --quiet\ncompose pull\ncompose up -d'
kvm_json=$(real_compose_json "$kvm_install")
jq -e '.services["agent-compose"].privileged == true and .services["agent-compose"].devices[0].source == "/dev/kvm"' >/dev/null <<<"$kvm_json"

# Installer-managed refs advance on upgrade, but a later user override is not
# overwritten even when managed state exists.
make_bundle managed-images 1
managed_install="$TMP_ROOT/managed-images"
run_installer "$BUNDLE" "$managed_install" "$MISSING_KVM" --no-start
assert_success
assert_env "$managed_install/.env" AGENT_COMPOSE_IMAGE 'registry.example/agent-compose:v-test'
assert_env "$managed_install/.installer-state.env" AGENT_COMPOSE_IMAGE 'registry.example/agent-compose:v-test'
sed -i 's/:v-test/:v-next/g' "$BUNDLE/images/manifest.env"
run_installer "$BUNDLE" "$managed_install" "$PRESENT_KVM" --upgrade --no-start
assert_success
assert_env "$managed_install/.env" AGENT_COMPOSE_IMAGE 'registry.example/agent-compose:v-next'
assert_env "$managed_install/.installer-state.env" AGENT_COMPOSE_IMAGE 'registry.example/agent-compose:v-next'
sed -i 's#^AGENT_COMPOSE_IMAGE=.*#AGENT_COMPOSE_IMAGE=custom.example/managed-override:keep#' "$managed_install/.env"
sed -i 's/:v-next/:v-third/g' "$BUNDLE/images/manifest.env"
run_installer "$BUNDLE" "$managed_install" "$MISSING_KVM" --upgrade --no-start
assert_success
assert_env "$managed_install/.env" AGENT_COMPOSE_IMAGE 'custom.example/managed-override:keep'
assert_env "$managed_install/.installer-state.env" AGENT_COMPOSE_IMAGE 'registry.example/agent-compose:v-next'

make_bundle coincidental-image 1
coincidental_install="$TMP_ROOT/coincidental-image"
run_installer "$BUNDLE" "$coincidental_install" "$MISSING_KVM" --no-start
assert_success
sed -i 's#^AGENT_COMPOSE_IMAGE=.*#AGENT_COMPOSE_IMAGE=registry.example/agent-compose:v-next#' "$coincidental_install/.env"
sed -i 's/:v-test/:v-next/g' "$BUNDLE/images/manifest.env"
run_installer "$BUNDLE" "$coincidental_install" "$MISSING_KVM" --upgrade --no-start
assert_success
assert_env "$coincidental_install/.env" AGENT_COMPOSE_IMAGE 'registry.example/agent-compose:v-next'
assert_env "$coincidental_install/.installer-state.env" AGENT_COMPOSE_IMAGE 'registry.example/agent-compose:v-test'
sed -i 's/:v-next/:v-third/g' "$BUNDLE/images/manifest.env"
run_installer "$BUNDLE" "$coincidental_install" "$MISSING_KVM" --upgrade --no-start
assert_success
assert_env "$coincidental_install/.env" AGENT_COMPOSE_IMAGE 'registry.example/agent-compose:v-next'
assert_env "$coincidental_install/.installer-state.env" AGENT_COMPOSE_IMAGE 'registry.example/agent-compose:v-test'

# Existing explicit custom and explicitly empty selections are user-owned.
make_bundle explicit 1
explicit_install="$TMP_ROOT/explicit"
mkdir -p "$explicit_install"
write_user_env "$explicit_install/.env"
printf '%s\n' 'COMPOSE_FILE=docker-compose.yml:custom.yml' >>"$explicit_install/.env"
explicit_owner=$(stat -c '%u:%g' "$explicit_install/.env")
cat >"$explicit_install/custom.yml" <<'EOF'
services:
  agent-compose:
    labels:
      installer-test: custom
EOF
run_installer "$BUNDLE" "$explicit_install" "$MISSING_KVM" --no-start
assert_success
assert_env "$explicit_install/.env" COMPOSE_FILE 'docker-compose.yml:custom.yml'
for pair in \
  'AUTH_PASSWORD=user-password' \
  'AUTH_SECRET=user-secret' \
  'AGENT_COMPOSE_IMAGE=custom.example/daemon:keep' \
  'AGENT_COMPOSE_FRONTEND_IMAGE=custom.example/ui:keep' \
  'DEFAULT_IMAGE=custom.example/guest:keep' \
  'CUSTOM_SETTING=keep-me'; do
  assert_contains "$explicit_install/.env" "$pair"
done
assert_mode "$explicit_install/.env" 600
[[ $(stat -c '%u:%g' "$explicit_install/.env") == "$explicit_owner" ]] || fail 'existing .env ownership changed'
run_installer "$BUNDLE" "$explicit_install" "$PRESENT_KVM" --upgrade --no-start
assert_success
assert_env "$explicit_install/.env" COMPOSE_FILE 'docker-compose.yml:custom.yml'
assert_env "$explicit_install/.env" AUTH_PASSWORD user-password
assert_env "$explicit_install/.env" AUTH_SECRET user-secret
assert_env "$explicit_install/.env" AGENT_COMPOSE_IMAGE 'custom.example/daemon:keep'
run_installer "$BUNDLE" "$explicit_install" "$MISSING_KVM"
assert_success
assert_installed_sequence "$explicit_install" $'compose config --quiet\ncompose pull\ncompose up -d'
for args in 'compose config --quiet ' 'compose pull ' 'compose up -d '; do
  assert_contains "$FAKE_DOCKER_LOG" "cwd=$explicit_install|process=<unset>|file=docker-compose.yml:custom.yml|args=$args"
done

empty_install="$TMP_ROOT/explicit-empty"
mkdir -p "$empty_install"
write_user_env "$empty_install/.env"
printf '%s\n' 'COMPOSE_FILE=' >>"$empty_install/.env"
empty_before=$(sha256sum "$empty_install/.env")
empty_mode_before=$(stat -c '%a' "$empty_install/.env")
run_installer "$BUNDLE" "$empty_install" "$PRESENT_KVM" --no-start
assert_failure
assert_contains "$RUN_STDERR" 'restored managed files'
assert_env "$empty_install/.env" COMPOSE_FILE ''
[[ $(sha256sum "$empty_install/.env") == "$empty_before" ]] || fail 'invalid explicit-empty .env was not restored'
[[ $(stat -c '%a' "$empty_install/.env") == "$empty_mode_before" ]] || fail 'invalid explicit-empty .env mode was not restored'
[[ ! -e "$empty_install/docker-compose.yml" && ! -e "$empty_install/docker-compose.kvm.yml" ]] || fail 'invalid explicit-empty selection left managed Compose files'
empty_probe="$TMP_ROOT/empty-compose-probe"
mkdir -p "$empty_probe"
cp "$ROOT_DIR/docker-compose.yml" "$empty_probe/docker-compose.yml"
printf '%s\n' 'COMPOSE_FILE=' >"$empty_probe/.env"
set +e
(
  cd "$empty_probe"
  unset COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME
  docker compose config --quiet
) >"$TMP_ROOT/empty-probe.stdout" 2>"$TMP_ROOT/empty-probe.stderr"
empty_probe_status=$?
set -e
[[ $empty_probe_status -ne 0 ]] || fail 'real Compose unexpectedly accepted explicit empty COMPOSE_FILE'

exported_install="$TMP_ROOT/exported-selection"
mkdir -p "$exported_install"
write_user_env "$exported_install/.env"
printf '%s\n' 'export COMPOSE_FILE=docker-compose.yml:docker-compose.kvm.yml' >>"$exported_install/.env"
run_installer "$BUNDLE" "$exported_install" "$PRESENT_KVM" --no-start
assert_success
assert_contains "$exported_install/.env" 'export COMPOSE_FILE=docker-compose.yml:docker-compose.kvm.yml'
[[ $(grep -c '^COMPOSE_FILE=' "$exported_install/.env" 2>/dev/null || true) -eq 0 ]] || fail 'exported selection gained a plain duplicate assignment'
exported_json=$(real_compose_json "$exported_install")
jq -e '.services["agent-compose"].privileged == true and .services["agent-compose"].devices[0].source == "/dev/kvm"' >/dev/null <<<"$exported_json"
run_installer "$BUNDLE" "$exported_install" "$MISSING_KVM" --upgrade --no-start
assert_success
assert_contains "$exported_install/.env" 'export COMPOSE_FILE=docker-compose.yml:docker-compose.kvm.yml'
[[ $(grep -c '^COMPOSE_FILE=' "$exported_install/.env" 2>/dev/null || true) -eq 0 ]] || fail 'exported selection changed during upgrade'

exported_user_install="$TMP_ROOT/exported-user-values"
mkdir -p "$exported_user_install"
cat >"$exported_user_install/.env" <<'EOF'
AUTH_USERNAME=operator
export AUTH_PASSWORD=exported-password
export AUTH_SECRET=exported-secret
export AGENT_COMPOSE_IMAGE=custom.example/exported-daemon:keep
export AGENT_COMPOSE_FRONTEND_VERSION=exported-ui
export AGENT_COMPOSE_FRONTEND_IMAGE=custom.example/exported-ui:keep
export DEFAULT_IMAGE=custom.example/exported-guest:keep
COMPOSE_FILE=docker-compose.yml
EOF
chmod 640 "$exported_user_install/.env"
run_installer "$BUNDLE" "$exported_user_install" "$MISSING_KVM" --upgrade --no-start
assert_success
for pair in \
  'export AUTH_PASSWORD=exported-password' \
  'export AUTH_SECRET=exported-secret' \
  'export AGENT_COMPOSE_IMAGE=custom.example/exported-daemon:keep' \
  'export AGENT_COMPOSE_FRONTEND_IMAGE=custom.example/exported-ui:keep' \
  'export DEFAULT_IMAGE=custom.example/exported-guest:keep'; do
  assert_contains "$exported_user_install/.env" "$pair"
done
for key in AUTH_PASSWORD AUTH_SECRET AGENT_COMPOSE_IMAGE AGENT_COMPOSE_FRONTEND_IMAGE DEFAULT_IMAGE; do
  [[ $(grep -c "^${key}=" "$exported_user_install/.env" 2>/dev/null || true) -eq 0 ]] || fail "exported $key gained a plain duplicate"
done
assert_not_contains "$exported_user_install/.installer-state.env" 'AGENT_COMPOSE_IMAGE='

# Compose and dotenv use the last active assignment. Append-style user
# overrides must therefore win over earlier empty/installer-managed values.
duplicate_install="$TMP_ROOT/duplicate-values"
mkdir -p "$duplicate_install"
cat >"$duplicate_install/.env" <<'EOF'
AUTH_USERNAME=operator
AUTH_PASSWORD=user-password
AUTH_SECRET=
AUTH_SECRET=last-user-secret
AGENT_COMPOSE_IMAGE=registry.example/agent-compose:v-old
AGENT_COMPOSE_IMAGE=custom.example/last-daemon:keep
AGENT_COMPOSE_FRONTEND_VERSION=keep-ui
AGENT_COMPOSE_FRONTEND_IMAGE=custom.example/ui:keep
DEFAULT_IMAGE=custom.example/guest:keep
COMPOSE_FILE=docker-compose.yml
EOF
printf '%s\n' 'AGENT_COMPOSE_IMAGE=registry.example/agent-compose:v-old' >"$duplicate_install/.installer-state.env"
run_installer "$BUNDLE" "$duplicate_install" "$MISSING_KVM" --upgrade --no-start
assert_success
[[ $(grep -c '^AUTH_SECRET=last-user-secret$' "$duplicate_install/.env") -eq 1 ]] || fail 'last duplicate secret was not preserved'
[[ $(grep -c '^AUTH_SECRET=$' "$duplicate_install/.env") -eq 1 ]] || fail 'earlier duplicate secret was rewritten'
[[ $(grep -c '^AGENT_COMPOSE_IMAGE=custom.example/last-daemon:keep$' "$duplicate_install/.env") -eq 1 ]] || fail 'last duplicate image override was not preserved'
[[ $(grep -c '^AGENT_COMPOSE_IMAGE=registry.example/agent-compose:v-old$' "$duplicate_install/.env") -eq 1 ]] || fail 'earlier managed image entry was rewritten'
assert_env "$duplicate_install/.installer-state.env" AGENT_COMPOSE_IMAGE 'registry.example/agent-compose:v-old'

commented_install="$TMP_ROOT/commented-only"
mkdir -p "$commented_install"
write_user_env "$commented_install/.env"
printf '%s\n' '# COMPOSE_FILE=docker-compose.yml:docker-compose.kvm.yml' >>"$commented_install/.env"
run_installer "$BUNDLE" "$commented_install" "$MISSING_KVM" --no-start
assert_success
assert_env "$commented_install/.env" COMPOSE_FILE docker-compose.yml
assert_contains "$commented_install/.env" '# COMPOSE_FILE=docker-compose.yml:docker-compose.kvm.yml'

# Legacy installs choose once; later upgrades never toggle with host KVM state.
legacy_dual="$TMP_ROOT/legacy-dual"
mkdir -p "$legacy_dual"
write_user_env "$legacy_dual/.env"
run_installer "$BUNDLE" "$legacy_dual" "$PRESENT_KVM" --no-start
assert_success
assert_env "$legacy_dual/.env" COMPOSE_FILE 'docker-compose.yml:docker-compose.kvm.yml'
run_installer "$BUNDLE" "$legacy_dual" "$MISSING_KVM" --upgrade --no-start
assert_success
assert_env "$legacy_dual/.env" COMPOSE_FILE 'docker-compose.yml:docker-compose.kvm.yml'
assert_env "$legacy_dual/.env" AUTH_PASSWORD user-password
assert_env "$legacy_dual/.env" AUTH_SECRET user-secret
assert_env "$legacy_dual/.env" AGENT_COMPOSE_IMAGE 'custom.example/daemon:keep'

legacy_base="$TMP_ROOT/legacy-base"
mkdir -p "$legacy_base"
write_user_env "$legacy_base/.env"
run_installer "$BUNDLE" "$legacy_base" "$MISSING_KVM" --no-start
assert_success
assert_env "$legacy_base/.env" COMPOSE_FILE docker-compose.yml

legacy_ref_install="$TMP_ROOT/legacy-official-ref"
mkdir -p "$legacy_ref_install"
write_user_env "$legacy_ref_install/.env"
sed -i 's#^AGENT_COMPOSE_IMAGE=.*#AGENT_COMPOSE_IMAGE=registry.example/agent-compose:v-legacy#' "$legacy_ref_install/.env"
run_installer "$BUNDLE" "$legacy_ref_install" "$MISSING_KVM" --upgrade --no-start
assert_success
assert_env "$legacy_ref_install/.env" AGENT_COMPOSE_IMAGE 'registry.example/agent-compose:v-legacy'
assert_not_contains "$legacy_ref_install/.installer-state.env" 'AGENT_COMPOSE_IMAGE='
run_installer "$BUNDLE" "$legacy_base" "$PRESENT_KVM" --upgrade --no-start
assert_success
assert_env "$legacy_base/.env" COMPOSE_FILE docker-compose.yml

# A KVM auto-selection without any available overlay fails before mutation;
# Docker-only legacy bundles remain installable with the explicit base choice.
make_bundle missing-overlay 0
missing_overlay_install="$TMP_ROOT/missing-overlay"
run_installer "$BUNDLE" "$missing_overlay_install" "$PRESENT_KVM" --no-start
assert_failure
assert_contains "$RUN_STDERR" 'KVM detected'
[[ ! -e "$missing_overlay_install" ]] || fail 'failed overlay preflight mutated install target'

old_bundle_install="$TMP_ROOT/old-bundle-base"
run_installer "$BUNDLE" "$old_bundle_install" "$MISSING_KVM" --no-start
assert_success
assert_env "$old_bundle_install/.env" COMPOSE_FILE docker-compose.yml
[[ ! -e "$old_bundle_install/docker-compose.kvm.yml" ]] || fail 'legacy bundle unexpectedly created overlay'

retained_overlay_install="$TMP_ROOT/retained-overlay"
mkdir -p "$retained_overlay_install"
write_user_env "$retained_overlay_install/.env"
cp "$ROOT_DIR/docker-compose.kvm.yml" "$retained_overlay_install/docker-compose.kvm.yml"
retained_overlay_hash=$(sha256sum "$retained_overlay_install/docker-compose.kvm.yml")
run_installer "$BUNDLE" "$retained_overlay_install" "$PRESENT_KVM" --no-start
assert_success
assert_env "$retained_overlay_install/.env" COMPOSE_FILE 'docker-compose.yml:docker-compose.kvm.yml'
[[ $(sha256sum "$retained_overlay_install/docker-compose.kvm.yml") == "$retained_overlay_hash" ]] || fail 'installed overlay changed when bundle omitted it'

make_bundle new-failure 1
new_failure_install="$TMP_ROOT/new-failure"
FAKE_DOCKER_FAIL_COMMAND=config
run_installer "$BUNDLE" "$new_failure_install" "$PRESENT_KVM" --no-start
FAKE_DOCKER_FAIL_COMMAND=''
assert_failure
assert_contains "$RUN_STDERR" 'restored managed files'
[[ ! -e "$new_failure_install" ]] || fail 'failed new install left a partial target'

# Pull failure restores every managed file and mode, never runs up, and leaves
# no installer temporary files or newly copied overlay behind.
make_bundle rollback 1
rollback_install="$TMP_ROOT/rollback"
mkdir -p "$rollback_install/data/agent-compose"
printf 'legacy-db\n' >"$rollback_install/data/agent-compose/data.db"
cp "$ROOT_DIR/docker-compose.yml" "$rollback_install/docker-compose.yml"
printf '%s\n' '# old installer' >"$rollback_install/install.sh"
chmod 700 "$rollback_install/install.sh"
write_user_env "$rollback_install/.env"
printf '%s\n' 'COMPOSE_FILE=docker-compose.yml' >>"$rollback_install/.env"
before_compose=$(sha256sum "$rollback_install/docker-compose.yml")
before_installer=$(sha256sum "$rollback_install/install.sh")
before_env=$(sha256sum "$rollback_install/.env")
before_env_mode=$(stat -c '%a' "$rollback_install/.env")
FAKE_DOCKER_FAIL_COMMAND=pull
run_installer "$BUNDLE" "$rollback_install" "$PRESENT_KVM"
FAKE_DOCKER_FAIL_COMMAND=''
assert_failure
assert_contains "$RUN_STDERR" 'restored managed files'
assert_not_contains "$FAKE_DOCKER_LOG" 'args=compose up -d '
assert_installed_sequence "$rollback_install" $'compose config --quiet\ncompose pull'
[[ $(sha256sum "$rollback_install/docker-compose.yml") == "$before_compose" ]] || fail 'compose file was not rolled back'
[[ $(sha256sum "$rollback_install/install.sh") == "$before_installer" ]] || fail 'installer was not rolled back'
[[ $(sha256sum "$rollback_install/.env") == "$before_env" ]] || fail '.env was not rolled back'
[[ $(stat -c '%a' "$rollback_install/.env") == "$before_env_mode" ]] || fail '.env mode was not rolled back'
[[ ! -e "$rollback_install/docker-compose.kvm.yml" ]] || fail 'new overlay survived rollback'
[[ ! -e "$rollback_install/.installer-state.env" ]] || fail 'new installer state survived rollback'
if find "$rollback_install" -maxdepth 1 -name '*.installer-*' -print -quit | grep -q .; then
  fail 'installer temporary file survived rollback'
fi

# When restoration itself is blocked, the installer reports and retains the
# out-of-tree backup instead of deleting the only recovery copy.
incomplete_install="$TMP_ROOT/incomplete-rollback"
mkdir -p "$incomplete_install/data/agent-compose"
printf 'legacy-db\n' >"$incomplete_install/data/agent-compose/data.db"
cp "$ROOT_DIR/docker-compose.yml" "$incomplete_install/docker-compose.yml"
printf '%s\n' '# recovery source installer' >"$incomplete_install/install.sh"
write_user_env "$incomplete_install/.env"
printf '%s\n' 'COMPOSE_FILE=docker-compose.yml' >>"$incomplete_install/.env"
FAKE_DOCKER_FAIL_COMMAND=pull
FAKE_MKTEMP_FAIL_RESTORE=1
run_installer "$BUNDLE" "$incomplete_install" "$PRESENT_KVM"
FAKE_DOCKER_FAIL_COMMAND=''
FAKE_MKTEMP_FAIL_RESTORE=0
assert_failure
assert_contains "$RUN_STDERR" 'recovery was incomplete'
preserved_backup=$(sed -n 's/^.*backups retained at //p' "$RUN_STDERR" | tail -n1)
[[ -n $preserved_backup && -d $preserved_backup ]] || fail 'incomplete rollback backup was not retained'
PRESERVED_BACKUPS+=("$preserved_backup")
[[ -f $preserved_backup/docker-compose.yml.present ]] || fail 'retained backup lacks Compose presence marker'
[[ -f $preserved_backup/docker-compose.yml ]] || fail 'retained backup lacks original Compose file'
[[ -f $preserved_backup/.env.present ]] || fail 'retained backup lacks .env presence marker'
[[ -f $preserved_backup/.env ]] || fail 'retained backup lacks original .env'
FAKE_DOCKER_FAIL_COMMAND=up-once
run_installer "$BUNDLE" "$rollback_install" "$PRESENT_KVM"
FAKE_DOCKER_FAIL_COMMAND=''
assert_failure
assert_contains "$RUN_STDERR" 'restored managed files'
assert_contains "$FAKE_DOCKER_LOG" 'args=compose pull '
assert_contains "$FAKE_DOCKER_LOG" 'args=compose up -d '
[[ $(sha256sum "$rollback_install/docker-compose.yml") == "$before_compose" ]] || fail 'compose file was not rolled back after up failure'
[[ $(sha256sum "$rollback_install/install.sh") == "$before_installer" ]] || fail 'installer was not rolled back after up failure'
[[ $(sha256sum "$rollback_install/.env") == "$before_env" ]] || fail '.env was not rolled back after up failure'
[[ $(stat -c '%a' "$rollback_install/.env") == "$before_env_mode" ]] || fail '.env mode was not rolled back after up failure'
[[ ! -e "$rollback_install/docker-compose.kvm.yml" ]] || fail 'new overlay survived up-failure rollback'
[[ ! -e "$rollback_install/.installer-state.env" ]] || fail 'new installer state survived up-failure rollback'
assert_installed_sequence "$rollback_install" $'compose config --quiet\ncompose pull\ncompose up -d\ncompose up -d'
[[ -f "$FAKE_DOCKER_STATE" ]] || fail 'existing stack was not reconciled after up failure'
[[ ! -e "$rollback_install/data/agent-compose/fake-partial" ]] || fail 'partial runtime marker survived existing-install recovery'

# Never reconcile an existing stack against candidate/mixed files when the
# managed-file restoration itself is incomplete.
restore_failure_install="$TMP_ROOT/restore-failure"
mkdir -p "$restore_failure_install/data/agent-compose"
printf 'legacy-db\n' >"$restore_failure_install/data/agent-compose/data.db"
cp "$ROOT_DIR/docker-compose.yml" "$restore_failure_install/docker-compose.yml"
printf '%s\n' '# old restore-failure installer' >"$restore_failure_install/install.sh"
write_user_env "$restore_failure_install/.env"
printf '%s\n' 'COMPOSE_FILE=docker-compose.yml' >>"$restore_failure_install/.env"
restore_failure_before=$(sha256sum "$restore_failure_install/.env" | cut -d' ' -f1)
FAKE_DOCKER_FAIL_COMMAND=up-once
FAKE_MKTEMP_FAIL_RESTORE=1
run_installer "$BUNDLE" "$restore_failure_install" "$PRESENT_KVM"
FAKE_DOCKER_FAIL_COMMAND=''
FAKE_MKTEMP_FAIL_RESTORE=0
assert_failure
assert_contains "$RUN_STDERR" 'recovery was incomplete'
assert_installed_sequence "$restore_failure_install" $'compose config --quiet\ncompose pull\ncompose up -d'
[[ ! -e $FAKE_DOCKER_STATE ]] || fail 'failed restoration unexpectedly reconciled existing stack'
preserved_backup=$(sed -n 's/^.*backups retained at //p' "$RUN_STDERR" | tail -n1)
[[ -n $preserved_backup && -d $preserved_backup ]] || fail 'failed restoration backup was not retained'
PRESERVED_BACKUPS+=("$preserved_backup")
[[ $(sha256sum "$preserved_backup/.env" | cut -d' ' -f1) == "$restore_failure_before" ]] || fail 'retained backup lacks original existing .env'
make_bundle new-up-failure 1
new_up_failure="$TMP_ROOT/new-up-failure"
FAKE_DOCKER_FAIL_COMMAND=up-once
run_installer "$BUNDLE" "$new_up_failure" "$PRESENT_KVM"
FAKE_DOCKER_FAIL_COMMAND=''
assert_failure
assert_contains "$RUN_STDERR" 'restored managed files'
assert_installed_sequence "$new_up_failure" $'compose config --quiet\ncompose pull\ncompose up -d\ncompose down --remove-orphans'
[[ ! -e "$new_up_failure" ]] || fail 'failed new up left install data or managed files'
[[ ! -e "$FAKE_DOCKER_STATE" ]] || fail 'failed new up left fake runtime state'

# If fresh-install orphan cleanup also fails, keep both the candidate project
# and a reported recovery snapshot so the operator can retry Compose cleanup.
new_down_failure="$TMP_ROOT/new-down-failure"
FAKE_DOCKER_FAIL_COMMAND=up-once-down-fails
run_installer "$BUNDLE" "$new_down_failure" "$PRESENT_KVM"
FAKE_DOCKER_FAIL_COMMAND=''
assert_failure
assert_contains "$RUN_STDERR" 'recovery was incomplete'
assert_installed_sequence "$new_down_failure" $'compose config --quiet\ncompose pull\ncompose up -d\ncompose down --remove-orphans'
assert_env "$new_down_failure/.env" COMPOSE_FILE 'docker-compose.yml:docker-compose.kvm.yml'
[[ -f $new_down_failure/docker-compose.yml && -f $new_down_failure/docker-compose.kvm.yml ]] || fail 'failed cleanup removed candidate Compose files'
[[ -e $new_down_failure/data/fake-partial ]] || fail 'failed cleanup repro did not retain partial runtime marker'
preserved_backup=$(sed -n 's/^.*backups retained at //p' "$RUN_STDERR" | tail -n1)
[[ -n $preserved_backup && -d $preserved_backup/recovery-install ]] || fail 'failed cleanup recovery snapshot was not retained'
PRESERVED_BACKUPS+=("$preserved_backup")
cmp "$new_down_failure/.env" "$preserved_backup/recovery-install/.env" >/dev/null || fail 'recovery snapshot lacks candidate .env'
cmp "$new_down_failure/docker-compose.yml" "$preserved_backup/recovery-install/docker-compose.yml" >/dev/null || fail 'recovery snapshot lacks candidate Compose file'

# Managed-file symlinks and ambiguous legacy path separators fail safely.
make_bundle unsafe 1
unsafe_install="$TMP_ROOT/unsafe"
mkdir -p "$unsafe_install"
victim="$TMP_ROOT/victim-env"
printf '%s\n' 'AUTH_SECRET=do-not-touch' >"$victim"
ln -s "$victim" "$unsafe_install/.env"
run_installer "$BUNDLE" "$unsafe_install" "$MISSING_KVM" --no-start
assert_failure
assert_contains "$RUN_STDERR" 'refusing unsafe managed-file target'
assert_contains "$victim" 'AUTH_SECRET=do-not-touch'

symlink_target="$TMP_ROOT/symlink-target"
symlink_install="$TMP_ROOT/symlink-install"
mkdir -p "$symlink_target"
ln -s "$symlink_target" "$symlink_install"
for symlink_spelling in "$symlink_install" "$symlink_install/" "$symlink_install/."; do
  run_installer "$BUNDLE" "$symlink_spelling" "$MISSING_KVM" --no-start
  assert_failure
  assert_contains "$RUN_STDERR" 'refusing install path with symlink components'
done
[[ -z $(find "$symlink_target" -mindepth 1 -print -quit) ]] || fail 'symlink install target was modified'

race_install="$TMP_ROOT/race-install"
race_victim="$TMP_ROOT/race-victim"
mkdir -p "$race_victim"
FAKE_DOCKER_VERSION_SYMLINK_TARGET="$race_install"
FAKE_DOCKER_VERSION_SYMLINK_VICTIM="$race_victim"
run_installer "$BUNDLE" "$race_install" "$MISSING_KVM" --no-start
FAKE_DOCKER_VERSION_SYMLINK_TARGET=''
FAKE_DOCKER_VERSION_SYMLINK_VICTIM=''
assert_failure
assert_contains "$RUN_STDERR" 'refusing install path changed through symlink components'
[[ -z $(find "$race_victim" -mindepth 1 -print -quit) ]] || fail 'late symlink target was modified'

data_race_install="$TMP_ROOT/data-race-install"
data_race_victim="$TMP_ROOT/data-race-victim"
mkdir -p "$data_race_install" "$data_race_victim"
write_user_env "$data_race_install/.env"
printf '%s\n' 'COMPOSE_FILE=docker-compose.yml' >>"$data_race_install/.env"
FAKE_DOCKER_VERSION_SYMLINK_TARGET="$data_race_install/data"
FAKE_DOCKER_VERSION_SYMLINK_VICTIM="$data_race_victim"
run_installer "$BUNDLE" "$data_race_install" "$MISSING_KVM" --no-start
FAKE_DOCKER_VERSION_SYMLINK_TARGET=''
FAKE_DOCKER_VERSION_SYMLINK_VICTIM=''
assert_failure
assert_contains "$RUN_STDERR" 'refusing unsafe data-directory target'
[[ -z $(find "$data_race_victim" -mindepth 1 -print -quit) ]] || fail 'late data symlink target was modified'

unsafe_data_install="$TMP_ROOT/unsafe-data"
mkdir -p "$unsafe_data_install/data"
printf '%s\n' 'preserve-data-sentinel' >"$unsafe_data_install/data/agent-compose"
unsafe_data_before=$(sha256sum "$unsafe_data_install/data/agent-compose")
run_installer "$BUNDLE" "$unsafe_data_install" "$MISSING_KVM" --no-start
assert_failure
assert_contains "$RUN_STDERR" 'refusing unsafe data-directory target'
[[ $(sha256sum "$unsafe_data_install/data/agent-compose") == "$unsafe_data_before" ]] || fail 'nonregular data target changed'

separator_install="$TMP_ROOT/separator"
mkdir -p "$separator_install"
write_user_env "$separator_install/.env"
printf '%s\n' 'COMPOSE_PATH_SEPARATOR=;' >>"$separator_install/.env"
before_separator=$(sha256sum "$separator_install/.env")
run_installer "$BUNDLE" "$separator_install" "$MISSING_KVM" --no-start
assert_failure
assert_contains "$RUN_STDERR" 'requires an explicit COMPOSE_FILE'
[[ $(sha256sum "$separator_install/.env") == "$before_separator" ]] || fail 'separator preflight changed .env'

printf 'Installer KVM selection, persistence, preservation, and rollback contracts passed\n'
