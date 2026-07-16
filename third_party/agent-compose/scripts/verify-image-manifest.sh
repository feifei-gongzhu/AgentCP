#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
usage: verify-image-manifest.sh --image IMAGE_REF [--platforms OS/ARCH[,OS/ARCH...]]

Inspect a remote image index with Docker Buildx and require exactly the expected
runtime platforms. Buildx attestation manifests using the standard
unknown/unknown platform and attestation-manifest annotation are ignored.

Defaults:
  --platforms linux/amd64,linux/arm64
EOF
}

die() {
  printf 'verify-image-manifest: %s\n' "$*" >&2
  exit 1
}

IMAGE_REF=
EXPECTED_PLATFORMS=linux/amd64,linux/arm64

while [[ $# -gt 0 ]]; do
  case $1 in
    --image)
      [[ $# -ge 2 ]] || die '--image requires a value'
      IMAGE_REF=$2
      shift 2
      ;;
    --platforms)
      [[ $# -ge 2 ]] || die '--platforms requires a value'
      EXPECTED_PLATFORMS=$2
      shift 2
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

[[ -n $IMAGE_REF ]] || die '--image is required'
[[ -n $EXPECTED_PLATFORMS ]] || die '--platforms must not be empty'
command -v docker >/dev/null 2>&1 || die 'docker with Buildx is required'
command -v jq >/dev/null 2>&1 || die 'jq is required'

expected_json=$(jq -cn --arg csv "$EXPECTED_PLATFORMS" '$csv | split(",")')
if ! jq -e '
  length > 0
  and all(.[]; type == "string" and test("^[a-z0-9][a-z0-9_.-]*/[a-z0-9][a-z0-9_.-]*$"))
  and length == (unique | length)
' >/dev/null <<<"$expected_json"; then
  die '--platforms must be a unique comma-separated list of OS/ARCH values without spaces'
fi

if ! raw_manifest=$(docker buildx imagetools inspect --raw "$IMAGE_REF"); then
  die "manifest inspection failed: $IMAGE_REF"
fi
if ! manifest_documents=$(jq -cs '.' <<<"$raw_manifest"); then
  die "manifest inspection returned invalid JSON: $IMAGE_REF"
fi
if ! jq -e 'length == 1 and (.[0] | type == "object")' >/dev/null <<<"$manifest_documents"; then
  die "manifest inspection must return exactly one JSON object: $IMAGE_REF"
fi
manifest=$(jq -c '.[0]' <<<"$manifest_documents")

if ! jq -e '
  .schemaVersion == 2
  and (.mediaType == "application/vnd.oci.image.index.v1+json"
       or .mediaType == "application/vnd.docker.distribution.manifest.list.v2+json")
  and (.manifests | type == "array")
' >/dev/null <<<"$manifest"; then
  media_type=$(jq -r '.mediaType // "<missing>"' <<<"$manifest")
  die "expected an OCI image index or Docker manifest list (mediaType=$media_type)"
fi

runtime_platforms=$(jq -c '
  def is_attestation:
    .platform.os == "unknown"
    and .platform.architecture == "unknown"
    and .annotations["vnd.docker.reference.type"] == "attestation-manifest";
  [
    .manifests[]
    | select(is_attestation | not)
    | if (.platform | type) == "object"
         and (.platform.os | type) == "string"
         and (.platform.architecture | type) == "string"
      then "\(.platform.os)/\(.platform.architecture)"
      else "<invalid-platform-descriptor>"
      end
  ]
' <<<"$manifest")

platform_analysis=$(jq -cn \
  --argjson expected "$expected_json" \
  --argjson actual "$runtime_platforms" '
  ($actual | unique) as $actual_unique
  | {
      expected: ($expected | sort),
      actual: ($actual | sort),
      missing: (($expected - $actual_unique) | sort),
      unexpected: (($actual_unique - $expected) | sort),
      duplicates: ($actual | group_by(.) | map(select(length > 1) | .[0]) | sort)
    }
')

if jq -e '
  (.missing | length) == 0
  and (.unexpected | length) == 0
  and (.duplicates | length) == 0
' >/dev/null <<<"$platform_analysis"; then
  expected_display=$(jq -r '.expected | join(",")' <<<"$platform_analysis")
  printf 'Verified %s: platforms=%s\n' "$IMAGE_REF" "$expected_display"
  exit 0
fi

printf 'verify-image-manifest: platform mismatch for %s\n' "$IMAGE_REF" >&2
printf '  expected:   %s\n' "$(jq -c '.expected' <<<"$platform_analysis")" >&2
printf '  actual:     %s\n' "$(jq -c '.actual' <<<"$platform_analysis")" >&2
printf '  missing:    %s\n' "$(jq -c '.missing' <<<"$platform_analysis")" >&2
printf '  unexpected: %s\n' "$(jq -c '.unexpected' <<<"$platform_analysis")" >&2
printf '  duplicates: %s\n' "$(jq -c '.duplicates' <<<"$platform_analysis")" >&2
exit 1
