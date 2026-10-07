# Upstream Sync Playbook (non-rebase, released-tag-only model)

This document is the source of truth for how this fork (`diegopetrucci/tlh-gui`) integrates changes from `get-bb/bb` (upstream). The fork stays reviewable and close to upstream without replaying TLH changes on `upstream/main`.

## 1. Intake boundary: released stable desktop tags only

An intake covers exactly one upstream **released stable desktop version tag** matching `desktop-vX.Y.Z` (for example `desktop-v0.45.0`) and the commits reachable from that tag as part of the released history.

**Never** intake from:
- `upstream/main` or any moving branch
- `desktop-latest`, `desktop-nightly`
- `pr-evidence*`, `android-testing`, `plugin-*`, `desktop-src-*` tags
- Any unreleased commit range or coherent feature cluster

Skipping a release is fine. Each ledger row covers one intake. A later stable tag can adopt the skipped changes when reviewed as a whole.

## 2. Integration mechanism: merge commit PRs

Each released-tag intake is integrated through:

1. Create integration branch from `main`: `git checkout -b upstream-intake-desktop-vX.Y.Z main`
2. Merge the tag with no-fast-forward: `git merge --no-ff upstream/desktop-vX.Y.Z`
3. Open a PR into `main` and merge with a **merge commit** (never squash or rebase).

**Never squash or rebase** intake work. The shared merge-base is required given upstream churn, and rewriting fork SHAs weakens reviewability and makes the patch history harder to audit.

Each intake should produce:

- one integration branch `upstream-intake-desktop-vX.Y.Z`,
- one fork PR merged into `main` with a merge commit,
- one ledger row appended to `.upstream-ledger.jsonl`, and
- patch-inventory updates in `docs/tlh/patch-inventory.md` if a TLH delta was added, removed, or re-verified.

## 3. Exception-only ledger plus git DAG are authoritative

**Path:** `.upstream-ledger.jsonl`

The ledger is JSONL, one JSON object per line, with one record per intake. New intake records append at the bottom; factual corrections amend the existing intake record in place and must not append duplicate rows.

Field schema:

| Field | Meaning |
| --- | --- |
| `date` | Intake integration date (`YYYY-MM-DD`). |
| `upstream_ref` | Released upstream tag covered by the intake. |
| `commit` | Exact upstream tag commit SHA. |
| `intake_type` | `release` — the only accepted intake type. Any between-release intake would require a separately approved policy change. |
| `integration_pr` | Fork PR number/link, or `n/a (baseline)` for the baseline row. |
| `status` | `adopted`, `adopted-with-exceptions`, `rejected`, or `baseline`. |
| `exceptions` | Array of `{ "ref": "...", "reason": "..." }` objects; empty array when nothing was excluded. |
| `notes` | Free-text context for maintainers. |

The **git DAG plus `.upstream-ledger.jsonl` are authoritative**. Heuristics such as `git cherry` or `git patch-id` may be useful hints, but they never override the DAG/ledger record.

A `baseline` row is informational only. It marks the historical fork base; it does **not** assert that every upstream change after that base has been adopted.

## 4. Fresh-clone remote setup

After cloning `diegopetrucci/tlh-gui`, configure the upstream remote with these repo-local settings:

```sh
git remote add upstream https://github.com/get-bb/bb.git
git remote set-url --push upstream no-push
git config --replace-all remote.upstream.fetch '+refs/heads/main:refs/remotes/upstream/main'
git config --add remote.upstream.fetch '+refs/tags/*:refs/tags/upstream/*'
git config remote.upstream.tagOpt --no-tags
git config remote.upstream.pruneTags false
git config remote.origin.pruneTags false
git config push.followTags false
git fetch upstream
```

**Verification:** `git tag -l | grep -v '^upstream/'` should print nothing (all fetched upstream tags land under `upstream/*`). A subsequent `git fetch origin` should leave `git tag -l 'upstream/*'` non-empty.

These repo-local configs are intentional:
- `remote.upstream.tagOpt=--no-tags`: stops automatic tag following into the plain `refs/tags` namespace on every `git fetch upstream`.
- `remote.upstream.pruneTags=false`: required because a global `fetch.pruneTags=true` makes git fetch add an implicit `refs/tags/*:refs/tags/*` refspec, which would create un-namespaced copies of upstream tags (observed during bootstrap). This setting suppresses that behaviour for the upstream remote.
- `remote.origin.pruneTags=false`: with a global `fetch.pruneTags=true`, `git fetch origin` prunes every local tag that origin lacks; because `upstream/*` tags are never pushed to origin, all of them would be deleted (observed after the bootstrap PR merge — all upstream tags were removed and had to be re-fetched). This setting preserves namespaced upstream tags across origin fetches.
- `push.followTags=false`: stops a global `push.followTags=true` from pushing upstream's annotated tags to origin.

The prefix-namespaced tag refspec (`+refs/tags/*:refs/tags/upstream/*`) means moving upstream tags (`desktop-latest`, `desktop-nightly`) are force-updated under `upstream/*` and never collide with fork tags. Fork release tags use `tlh-gui-v*`.

## 5. Workflow policy

Upstream GitHub Actions workflows stay disabled via GitHub repo settings. They are **never edited**. After each intake:

1. List current workflows: `gh api repos/diegopetrucci/tlh-gui/actions/workflows`
2. Identify and disable any new upstream workflows added since the previous intake.

Fork CI lives in `.github/workflows/tlh-ci.yml` (added by a later ticket) and is independent of upstream workflows.

## 6. Conflict guidance

Fork-owned paths that take precedence in merge conflicts:

- `docs/tlh/` — fork governance docs (this directory)
- `scripts/tlh/` — fork scripts
- `.upstream-ledger.jsonl` — intake ledger
- `.gnosis/` — project memory
- `.github/workflows/tlh-ci.yml` — fork CI

For conflicts in shared paths:
- Prefer config or plugin changes over core patches where possible.
- Upstream `AGENTS.md` forbids code comments; rationale for core patches lives in `docs/tlh/patch-inventory.md`, not in code.

## 7. TLH patch inventory

**Path:** `docs/tlh/patch-inventory.md`

This file lists deliberate fork-only deltas and the items deliberately left unchanged. Re-verify all inventory rows after every intake.

## 8. Reporting helpers are non-authoritative

`scripts/tlh/upstream-report.sh` is a read-only operator aid only. It summarizes whether a newer stable tag exists and a diffstat between the last intake and the latest tag. It must never be treated as proof of adoption or as a substitute for ledger bookkeeping.
