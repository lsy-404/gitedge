#!/usr/bin/env bash
set -euo pipefail

runner_lock=/opt/gitedge/work/actions/active.lock
worker=
paused=0
elapsed=0

finish() {
  if [[ -n "$worker" ]]; then
    kill -CONT "$worker" 2>/dev/null || true
    kill -TERM "$worker" 2>/dev/null || true
    wait "$worker" 2>/dev/null || true
  fi
}
trap finish EXIT
trap 'exit 0' INT TERM

while ((elapsed < 480)); do
  if [[ -e "$runner_lock" ]]; then
    if [[ -n "$worker" && "$paused" == 0 ]]; then
      kill -STOP "$worker" 2>/dev/null || true
      paused=1
    fi
  elif [[ -z "$worker" ]]; then
    openssl speed -elapsed -seconds 480 -bytes 16384 -evp sha256 >/dev/null 2>&1 &
    worker=$!
  elif [[ "$paused" == 1 ]]; then
    kill -CONT "$worker" 2>/dev/null || true
    paused=0
  fi
  if [[ -n "$worker" ]] && ! kill -0 "$worker" 2>/dev/null; then
    wait "$worker"
    exit
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done
