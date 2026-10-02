#!/usr/bin/env bash
# Snapshots the central agent records into the reserved orphan branch without touching any checkout.
set -euo pipefail

SOURCE_DIR="${AGENT_RECORDS_SOURCE:-$HOME/development/lsy-404@agents_memory/lsy-404@gitedge}"
BRANCH="${AGENT_RECORDS_BRANCH:-agent-records}"

[ -d "$SOURCE_DIR" ] || { echo "Agent records directory not found: $SOURCE_DIR" >&2; exit 1; }

GIT_COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"
TEMP_INDEX="$(mktemp -u)"
trap 'rm -f "$TEMP_INDEX"' EXIT

# A temporary index keeps the repository's real index and working trees untouched.
cd "$SOURCE_DIR"
export GIT_INDEX_FILE="$TEMP_INDEX"
git --git-dir="$GIT_COMMON_DIR" --work-tree="$SOURCE_DIR" add -A -- . ':!.DS_Store' ':!**/.DS_Store'
TREE="$(git --git-dir="$GIT_COMMON_DIR" write-tree)"

PARENT="$(git --git-dir="$GIT_COMMON_DIR" rev-parse -q --verify "refs/heads/$BRANCH" || true)"
if [ -n "$PARENT" ] && [ "$(git --git-dir="$GIT_COMMON_DIR" rev-parse "$PARENT^{tree}")" = "$TREE" ]; then
  echo "$BRANCH is already up to date ($PARENT)"
  exit 0
fi

COMMIT="$(git --git-dir="$GIT_COMMON_DIR" commit-tree "$TREE" ${PARENT:+-p "$PARENT"} -m "Sync agent records $(date +%F)")"
git --git-dir="$GIT_COMMON_DIR" update-ref "refs/heads/$BRANCH" "$COMMIT"
echo "$BRANCH -> $COMMIT"
