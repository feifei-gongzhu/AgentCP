#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: with-go-toolchain.sh <command> [args...]" >&2
  exit 2
fi

go_bin="${GO:-go}"
go_root="$("$go_bin" env GOROOT)"
go_version="$("$go_bin" env GOVERSION 2>/dev/null || "$go_bin" version | awk '{print $3}')"

if [[ -z "$go_root" || ! -x "$go_root/bin/go" ]]; then
  echo "resolved Go root is invalid: ${go_root:-<empty>}" >&2
  exit 1
fi

export GOROOT="$go_root"
export PATH="$go_root/bin:$PATH"

tool_version="$(go tool compile -V | awk '{version=$3; if ($4 != "") version=version "-" $4; print version}')"
if [[ "$tool_version" != "$go_version" ]]; then
  echo "Go toolchain mismatch: go is $go_version but compile is $tool_version" >&2
  echo "GOROOT=$GOROOT" >&2
  echo "PATH=$PATH" >&2
  exit 1
fi

exec "$@"
