#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_INSTALLER="$ROOT_DIR/deploy/install.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'install_upgrade_test: %s\n' "$*" >&2
  exit 1
}

assert_env() { # $1=file $2=key $3=value
  local actual
  actual="$(sed -n "s/^$2=//p" "$1" | tail -n1)"
  [[ $actual == "$3" ]] || fail "$2=$actual, want $3"
}

FAKE_BIN="$TMP_ROOT/bin"
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
printf '%s\n' "$url" >>"$FAKE_CURL_LOG"
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
if [[ ${1:-} == compose && ${2:-} == version ]]; then
  exit 0
fi
if [[ ${1:-} == compose && ${2:-} == config && ${3:-} == --quiet ]]; then
  exit 0
fi
exit 91
EOF
chmod +x "$FAKE_BIN/docker"

make_bundle() { # $1=directory $2=version $3=compose-marker $4=installer-marker
  local bundle=$1 version=$2 compose_marker=$3 installer_marker=$4
  mkdir -p "$bundle/images"
  cp "$SOURCE_INSTALLER" "$bundle/install.sh"
  cp "$ROOT_DIR/docker-compose.yml" "$bundle/docker-compose.yml"
  printf '\n# %s\n' "$compose_marker" >>"$bundle/docker-compose.yml"
  cp "$ROOT_DIR/.env.example" "$bundle/.env.example"
  printf '%s\n' "$installer_marker" >>"$bundle/install.sh"
  chmod +x "$bundle/install.sh"
  cat >"$bundle/images/manifest.env" <<EOF
AGENT_COMPOSE_IMAGE=registry.example/agent-compose:$version
AGENT_COMPOSE_FRONTEND_VERSION=$version-ui
AGENT_COMPOSE_FRONTEND_IMAGE=registry.example/agent-compose-ui:$version-ui
DEFAULT_IMAGE=registry.example/agent-compose-guest:$version
EOF
}

make_existing_install() { # $1=directory
  local target=$1
  mkdir -p "$target/data"
  printf 'existing-db\n' >"$target/data/data.db"
  cp "$ROOT_DIR/docker-compose.yml" "$target/docker-compose.yml"
  cat >"$target/.env" <<'EOF'
AUTH_USERNAME=operator
AUTH_PASSWORD=keep-password
AUTH_SECRET=keep-secret
AGENT_COMPOSE_IMAGE=registry.example/agent-compose:v-old
AGENT_COMPOSE_FRONTEND_VERSION=v-old-ui
AGENT_COMPOSE_FRONTEND_IMAGE=registry.example/agent-compose-ui:v-old-ui
DEFAULT_IMAGE=registry.example/agent-compose-guest:v-old
AGENT_COMPOSE_DATA_DIR=./data
COMPOSE_FILE=docker-compose.yml
EOF
  cat >"$target/.installer-state.env" <<'EOF'
AGENT_COMPOSE_IMAGE=registry.example/agent-compose:v-old
AGENT_COMPOSE_FRONTEND_VERSION=v-old-ui
AGENT_COMPOSE_FRONTEND_IMAGE=registry.example/agent-compose-ui:v-old-ui
DEFAULT_IMAGE=registry.example/agent-compose-guest:v-old
EOF
}

OLD_BUNDLE="$TMP_ROOT/local-old"
REMOTE_PAYLOAD_ROOT="$TMP_ROOT/remote-payload"
REMOTE_BUNDLE="$REMOTE_PAYLOAD_ROOT/agent-compose-installer"
make_bundle "$OLD_BUNDLE" v-old local-old-bundle '# local-old-installer'
make_bundle "$REMOTE_BUNDLE" v-latest remote-latest-bundle '# remote-latest-installer'

REMOTE_ARCHIVE="$TMP_ROOT/agent-compose-installer.tar.gz"
tar -czf "$REMOTE_ARCHIVE" -C "$REMOTE_PAYLOAD_ROOT" agent-compose-installer
REMOTE_SHASUMS="$TMP_ROOT/SHASUMS256.txt"
(
  cd "$TMP_ROOT"
  sha256sum agent-compose-installer.tar.gz >SHASUMS256.txt
)

run_upgrade() { # $1=target, remaining installer args
  local target=$1
  shift
  env \
    PATH="$FAKE_BIN:$PATH" \
    FAKE_CURL_LOG="$FAKE_CURL_LOG" \
    FAKE_REMOTE_ARCHIVE="$REMOTE_ARCHIVE" \
    FAKE_REMOTE_SHASUMS="$REMOTE_SHASUMS" \
    AGENT_COMPOSE_REPO=example/agent-compose \
    AGENT_COMPOSE_KVM_DETECT_PATH="$TMP_ROOT/missing-kvm" \
    AGENT_COMPOSE_YES=1 \
    bash "$OLD_BUNDLE/install.sh" --dir "$target" --yes --no-start "$@"
}

# The regression: an installer extracted from v-old must fetch latest instead
# of silently reinstalling its adjacent v-old manifest.
FAKE_CURL_LOG="$TMP_ROOT/latest-curl.log"
: >"$FAKE_CURL_LOG"
latest_target="$TMP_ROOT/latest-target"
make_existing_install "$latest_target"
run_upgrade "$latest_target" --upgrade
grep -Fxq 'https://github.com/example/agent-compose/releases/latest/download/agent-compose-installer.tar.gz' "$FAKE_CURL_LOG" \
  || fail 'default upgrade did not download the latest release bundle'
assert_env "$latest_target/.env" AGENT_COMPOSE_IMAGE registry.example/agent-compose:v-latest
assert_env "$latest_target/.env" AGENT_COMPOSE_FRONTEND_IMAGE registry.example/agent-compose-ui:v-latest-ui
grep -Fq '# remote-latest-bundle' "$latest_target/docker-compose.yml" \
  || fail 'default upgrade did not install remote Compose files'
grep -Fq '# remote-latest-installer' "$latest_target/install.sh" \
  || fail 'default upgrade did not install the remote installer'

# --version selects an exact release URL while still avoiding the stale local
# bundle.
FAKE_CURL_LOG="$TMP_ROOT/version-curl.log"
: >"$FAKE_CURL_LOG"
version_target="$TMP_ROOT/version-target"
make_existing_install "$version_target"
run_upgrade "$version_target" --upgrade --version v-target
grep -Fxq 'https://github.com/example/agent-compose/releases/download/v-target/agent-compose-installer.tar.gz' "$FAKE_CURL_LOG" \
  || fail 'versioned upgrade did not download the selected release bundle'

printf 'install_upgrade_test: ok\n'
