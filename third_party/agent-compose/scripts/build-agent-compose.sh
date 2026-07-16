#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

IMAGE_NAME="${IMAGE_NAME:-agent-compose:latest}"
DOCKERFILE="${DOCKERFILE:-Dockerfile}"
BUILD_CONTEXT="${BUILD_CONTEXT:-$ROOT_DIR}"
VERSION="${VERSION:-$(git -C "$ROOT_DIR" describe --always --tags --long 2>/dev/null || git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null || echo 'unknown')}"
REGISTRY_MIRROR_VALUE="${REGISTRY_MIRROR:-docker.io}"
GOPROXY_VALUE="${GOPROXY:-https://goproxy.cn,direct}"

HTTP_PROXY_VALUE="${HTTP_PROXY:-}"
HTTPS_PROXY_VALUE="${HTTPS_PROXY:-}"
ALL_PROXY_VALUE="${ALL_PROXY:-}"
NO_PROXY_VALUE="${NO_PROXY:-${no_proxy:-}}"

cd "$ROOT_DIR"

build_args=(
  -f "$DOCKERFILE"
  -t "$IMAGE_NAME"
  --build-arg "VERSION=$VERSION"
  --build-arg "HTTP_PROXY=$HTTP_PROXY_VALUE"
  --build-arg "HTTPS_PROXY=$HTTPS_PROXY_VALUE"
  --build-arg "ALL_PROXY=$ALL_PROXY_VALUE"
  --build-arg "NO_PROXY=$NO_PROXY_VALUE"
  --build-arg "REGISTRY_MIRROR=$REGISTRY_MIRROR_VALUE"
  --build-arg "GOPROXY=$GOPROXY_VALUE"
)

if [[ "$(basename "$DOCKERFILE")" == "Dockerfile.agent-compose-local" ]]; then
  build_args+=(
    --build-context "boxlite-local=$ROOT_DIR/build/boxlite"
    --build-context "microsandbox-local=$ROOT_DIR/build/microsandbox"
  )
fi

if [[ "${NO_CACHE:-}" == "1" ]]; then
  build_args+=(--no-cache)
fi

docker build "${build_args[@]}" "$BUILD_CONTEXT"
