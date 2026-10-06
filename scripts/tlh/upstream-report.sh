#!/usr/bin/env bash
#
# scripts/tlh/upstream-report.sh
#
# SIGNAL ONLY — NOT AUTHORITATIVE.
#
# Reports whether a newer stable upstream desktop tag exists beyond the last
# ledger intake. See docs/tlh/UPSTREAM-SYNC.md §8.
#
# The single source of truth for what has been integrated is the git DAG and
# .upstream-ledger.jsonl. This script never overrides the ledger.
#
# This script makes NO repository worktree changes. It fetches upstream refs
# (read-only remote update only). If upstream is absent or fetch fails it
# degrades gracefully and exits 0.
#
# Usage:
#   bash scripts/tlh/upstream-report.sh

set -euo pipefail

LEDGER=".upstream-ledger.jsonl"

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required but not installed. Install it (e.g. brew install jq) and retry." >&2
  exit 1
fi
STABLE_TAG_PATTERN='^upstream/desktop-v[0-9]+\.[0-9]+\.[0-9]+$'

banner() {
  echo "============================================================"
  echo " tlh-gui upstream-report: SIGNAL ONLY — NOT AUTHORITATIVE"
  echo " Source of truth: git DAG + .upstream-ledger.jsonl"
  echo " (see docs/tlh/UPSTREAM-SYNC.md)"
  echo "============================================================"
}

banner

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git work tree. Aborting." >&2
  exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo
  echo "No 'upstream' remote configured. Skipping report."
  echo "Add it with: git remote add upstream https://github.com/get-bb/bb.git"
  exit 0
fi

echo
echo "Fetching upstream refs (git fetch upstream --no-tags)..."
if ! git fetch upstream --no-tags '+refs/tags/desktop-v*:refs/tags/upstream/desktop-v*' 2>&1; then
  echo "Warning: fetch exited non-zero; report may be based on stale data." >&2
fi

echo
echo "---- Latest stable upstream tag ----"
LATEST_TAG=$(git tag --list 'upstream/desktop-v*' --sort=-v:refname \
  | grep -E "$STABLE_TAG_PATTERN" \
  | head -n1 || true)

if [ -z "$LATEST_TAG" ]; then
  echo "No stable upstream/desktop-vX.Y.Z tags found locally."
  LATEST_TAG=""
else
  LATEST_SHORT="${LATEST_TAG#upstream/}"
  LATEST_COMMIT=$(git rev-list -n1 "$LATEST_TAG" 2>/dev/null || echo "unknown")
  echo "Latest stable tag : $LATEST_SHORT"
  echo "Tag commit        : $LATEST_COMMIT"
fi

echo
echo "---- Last intake from ledger ----"
if [ ! -f "$LEDGER" ]; then
  echo "Ledger not found: $LEDGER" >&2
  LAST_REF=""
else
  LAST_ROW=$(grep -v '^[[:space:]]*$' "$LEDGER" | tail -n1)
  if [ -z "$LAST_ROW" ]; then
    echo "Error: ledger exists but contains no non-empty rows." >&2
    exit 1
  fi
  LAST_REF=$(printf '%s' "$LAST_ROW" | jq -r '.upstream_ref // empty')
  LAST_STATUS=$(printf '%s' "$LAST_ROW" | jq -r '.status // empty')
  LAST_COMMIT=$(printf '%s' "$LAST_ROW" | jq -r '.commit // empty')
  if [ -z "$LAST_REF" ]; then
    echo "Error: required field 'upstream_ref' is missing or empty in the last ledger row." >&2
    exit 1
  fi
  if [ -z "$LAST_STATUS" ]; then
    echo "Error: required field 'status' is missing or empty in the last ledger row." >&2
    exit 1
  fi
  echo "Last intake ref   : $LAST_REF"
  echo "Last intake status: $LAST_STATUS"
  echo "Last intake commit: $LAST_COMMIT"
fi

echo
echo "---- Update check ----"
if [ -z "$LATEST_TAG" ]; then
  echo "Cannot determine latest stable tag; skipping comparison."
elif [ -z "$LAST_REF" ]; then
  echo "Cannot read last intake ref from ledger; skipping comparison."
else
  LAST_TAG_FULL="upstream/${LAST_REF}"
  if [ "$LATEST_TAG" = "$LAST_TAG_FULL" ]; then
    echo "Fork is current: last intake ($LAST_REF) matches latest stable tag."
  else
    LATEST_VER="${LATEST_TAG#upstream/desktop-v}"
    LAST_VER="${LAST_REF#desktop-v}"
    HIGHER=$(printf '%s\n%s\n' "$LAST_VER" "$LATEST_VER" | sort -V | tail -n1)
    if [ "$HIGHER" = "$LATEST_VER" ]; then
      echo "Newer stable tag available: $LATEST_SHORT (last intake: $LAST_REF)"
      echo
      echo "---- Commit count between last intake and latest stable tag ----"
      if git rev-parse --verify "$LAST_TAG_FULL" >/dev/null 2>&1; then
        COMMIT_COUNT=$(git rev-list --count "${LAST_TAG_FULL}..${LATEST_TAG}" 2>/dev/null || echo "unknown")
        echo "Commits in range ${LAST_REF}..${LATEST_SHORT}: $COMMIT_COUNT"
        echo
        echo "---- Diffstat summary (last intake → latest stable tag) ----"
        git diff --stat "${LAST_TAG_FULL}" "${LATEST_TAG}" 2>/dev/null | tail -n3 || echo "(diffstat unavailable)"
      else
        echo "Cannot resolve $LAST_TAG_FULL locally; skipping commit count and diffstat."
      fi
    else
      echo "Warning: local upstream tags look stale (latest local tag $LATEST_SHORT is older than last intake $LAST_REF)."
      echo "Suggest running: git fetch upstream"
    fi
  fi
fi

echo
echo "============================================================"
echo " Reminder: this output is SIGNAL ONLY. Do not use it to skip"
echo " ledger bookkeeping or intake review. Consult"
echo " .upstream-ledger.jsonl and the git DAG for the authoritative"
echo " record of what has been integrated."
echo "============================================================"
