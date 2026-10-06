# TLH Patch Inventory

This table records the deliberate fork-only deltas and safeguards that must survive future released-tag intakes for `diegopetrucci/tlh-gui`. Read [`docs/tlh/UPSTREAM-SYNC.md`](./UPSTREAM-SYNC.md) first.

Fork rationale lives here, not in code comments (upstream `AGENTS.md` forbids code comments).

| Delta or safeguard | Why | Key files | Re-verify on intake? |
| --- | --- | --- | --- |
| TLH fork governance docs | Fork-owned sync playbook, patch inventory, and ledger. Not present upstream. | `docs/tlh/UPSTREAM-SYNC.md`, `docs/tlh/patch-inventory.md`, `.upstream-ledger.jsonl` | yes — confirm these files are not overwritten |
| Fork scripts | Fork-owned reporting helper not present upstream. | `scripts/tlh/upstream-report.sh` | yes — confirm not overwritten |
| AGENTS.md TLH section | Prepended TLH fork section pointing to governance docs and intake rules. Upstream AGENTS.md content left unchanged below it. | `AGENTS.md` | yes — re-apply or rebase section above upstream content |
| Fork CI workflow | Pending the CI ticket (tg-uduk); upstream workflows stay disabled via repo settings. | `.github/workflows/tlh-ci.yml` | yes — confirm upstream intake does not re-enable upstream workflows |

## Deliberately unchanged

The following upstream surfaces are kept identical to upstream to minimise divergence and merge conflicts. Do not rename, rebrand, or remove them without a separately approved ticket.

- **`~/.bb` data directory**
- **Port 38886 (server) and port 38887 (host-daemon)** — per `packages/config/src/runtime.ts`
- **`bb` CLI name**
- **`BB_*` environment variables** — `BB_DATA_DIR`, `BB_SERVER_PORT`, etc.
- **In-app `bb` wording and icons**
- **bb online services** — accounts, Connect, marketplace, and AI gateway endpoints
- **`apps/mobile`** — mobile app and in-app mobile download links

**Running alongside real bb:** set `BB_DATA_DIR` and `BB_SERVER_PORT` to separate values to run the fork alongside an upstream bb installation without data or port conflicts.

## Planned deltas

The following deltas are planned but not yet implemented. Each requires a separately approved ticket.

| Delta | Notes |
| --- | --- |
| `tlh` as default Pi bridge command | `BB_PI_BRIDGE_COMMAND=tlh` plus session-dir placement for the TLH runtime. |
| Mobile app fork | Bundle IDs, Expo/EAS project, Apple dev/TestFlight, Android APK release, push notifications, `bb://` scheme and `getbb.app` universal links, mobile CI, and repointed mobile download links. |
| Fork desktop release pipeline | Separate update feed; nothing to serve until the pipeline exists. |
