#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
VERIFIER="$ROOT_DIR/scripts/verify-image-manifest.sh"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf -- "$TEST_ROOT"' EXIT

fail() {
  printf 'test-verify-image-manifest: %s\n' "$*" >&2
  exit 1
}

FAKE_BIN="$TEST_ROOT/fake-bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 5 ]] || exit 90
[[ $1 == buildx && $2 == imagetools && $3 == inspect && $4 == --raw ]] || exit 91
[[ $5 == "${FAKE_EXPECTED_IMAGE:-}" ]] || exit 92
printf '%s\n' "$#" >"$FAKE_DOCKER_ARGC"
printf '%s\n' "$5" >"$FAKE_DOCKER_IMAGE_ARG"
[[ ${FAKE_DOCKER_FAIL:-0} != 1 ]] || exit 93
printf '%s\n' "${FAKE_MANIFEST_JSON:-}"
EOF
chmod 0755 "$FAKE_BIN/docker"

RUN_STDOUT="$TEST_ROOT/stdout"
RUN_STDERR="$TEST_ROOT/stderr"
RUN_STATUS=0
FAKE_DOCKER_ARGC="$TEST_ROOT/docker-argc"
FAKE_DOCKER_IMAGE_ARG="$TEST_ROOT/docker-image-arg"
export FAKE_DOCKER_ARGC FAKE_DOCKER_IMAGE_ARG

run_verifier() {
  set +e
  PATH="$FAKE_BIN:$PATH" "$VERIFIER" "$@" >"$RUN_STDOUT" 2>"$RUN_STDERR"
  RUN_STATUS=$?
  set -e
}

assert_success() {
  [[ $RUN_STATUS -eq 0 ]] || {
    sed 's/^/stdout: /' "$RUN_STDOUT" >&2
    sed 's/^/stderr: /' "$RUN_STDERR" >&2
    fail "status=$RUN_STATUS, expected success"
  }
}

assert_failure() {
  [[ $RUN_STATUS -ne 0 ]] || fail 'verifier unexpectedly succeeded'
}

assert_stderr() {
  grep -F -- "$1" "$RUN_STDERR" >/dev/null \
    || fail "stderr lacks expected text: $1"
}

oci_success='{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.index.v1+json",
  "manifests": [
    {"digest":"sha256:amd64","platform":{"os":"linux","architecture":"amd64"}},
    {"digest":"sha256:amd64-att","platform":{"os":"unknown","architecture":"unknown"},"annotations":{"vnd.docker.reference.type":"attestation-manifest"}},
    {"digest":"sha256:arm64","platform":{"os":"linux","architecture":"arm64"}},
    {"digest":"sha256:arm64-att","platform":{"os":"unknown","architecture":"unknown"},"annotations":{"vnd.docker.reference.type":"attestation-manifest"}}
  ]
}'
docker_success='{
  "schemaVersion": 2,
  "mediaType": "application/vnd.docker.distribution.manifest.list.v2+json",
  "manifests": [
    {"digest":"sha256:arm64","platform":{"os":"linux","architecture":"arm64"}},
    {"digest":"sha256:amd64","platform":{"os":"linux","architecture":"amd64"}}
  ]
}'
missing_arch='{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.index.v1+json",
  "manifests": [
    {"digest":"sha256:amd64","platform":{"os":"linux","architecture":"amd64"}}
  ]
}'
duplicate_arch='{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.index.v1+json",
  "manifests": [
    {"digest":"sha256:amd64-a","platform":{"os":"linux","architecture":"amd64"}},
    {"digest":"sha256:amd64-b","platform":{"os":"linux","architecture":"amd64"}},
    {"digest":"sha256:arm64","platform":{"os":"linux","architecture":"arm64"}}
  ]
}'
unexpected_arch='{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.index.v1+json",
  "manifests": [
    {"digest":"sha256:amd64","platform":{"os":"linux","architecture":"amd64"}},
    {"digest":"sha256:arm64","platform":{"os":"linux","architecture":"arm64"}},
    {"digest":"sha256:s390x","platform":{"os":"linux","architecture":"s390x"}}
  ]
}'

image_ref='registry.example/agent-compose:v-test'
FAKE_EXPECTED_IMAGE=$image_ref FAKE_MANIFEST_JSON=$oci_success run_verifier --image "$image_ref"
assert_success
grep -F 'platforms=linux/amd64,linux/arm64' "$RUN_STDOUT" >/dev/null \
  || fail 'success output lacks expected platforms'

FAKE_EXPECTED_IMAGE=$image_ref FAKE_MANIFEST_JSON=$docker_success run_verifier \
  --image "$image_ref" --platforms linux/arm64,linux/amd64
assert_success

FAKE_EXPECTED_IMAGE=$image_ref FAKE_MANIFEST_JSON=$missing_arch run_verifier --image "$image_ref"
assert_failure
assert_stderr '"linux/arm64"'
assert_stderr 'missing:'

FAKE_EXPECTED_IMAGE=$image_ref FAKE_MANIFEST_JSON=$duplicate_arch run_verifier --image "$image_ref"
assert_failure
assert_stderr 'duplicates:'
assert_stderr '"linux/amd64"'

FAKE_EXPECTED_IMAGE=$image_ref FAKE_MANIFEST_JSON=$unexpected_arch run_verifier --image "$image_ref"
assert_failure
assert_stderr 'unexpected:'
assert_stderr '"linux/s390x"'

FAKE_EXPECTED_IMAGE=$image_ref FAKE_MANIFEST_JSON='not-json' run_verifier --image "$image_ref"
assert_failure
assert_stderr 'invalid JSON'

FAKE_EXPECTED_IMAGE=$image_ref FAKE_DOCKER_FAIL=1 FAKE_MANIFEST_JSON=$oci_success \
  run_verifier --image "$image_ref"
assert_failure
assert_stderr 'manifest inspection failed'

injection_marker="$TEST_ROOT/argv-injection"
hostile_ref="registry.example/agent-compose:v-test;touch $injection_marker"
FAKE_EXPECTED_IMAGE=$hostile_ref FAKE_MANIFEST_JSON=$oci_success run_verifier --image "$hostile_ref"
assert_success
[[ $(<"$FAKE_DOCKER_ARGC") == 5 ]] || fail 'image reference changed Docker argv count'
[[ $(<"$FAKE_DOCKER_IMAGE_ARG") == "$hostile_ref" ]] || fail 'image reference was not passed as one exact argv value'
[[ ! -e $injection_marker ]] || fail 'image reference was evaluated by a shell'

printf 'test-verify-image-manifest: all checks passed\n'
