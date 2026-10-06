# TLH Patch Inventory

This table records the deliberate fork-only deltas and safeguards that must survive future released-tag intakes for `diegopetrucci/tlh-gui`. Read [`docs/tlh/UPSTREAM-SYNC.md`](./UPSTREAM-SYNC.md) first.

Fork rationale lives here, not in code comments (upstream `AGENTS.md` forbids code comments).

| Delta or safeguard | Why | Key files | Re-verify on intake? |
| --- | --- | --- | --- |
| TLH fork governance docs | Fork-owned sync playbook, patch inventory, and ledger. Not present upstream. | `docs/tlh/UPSTREAM-SYNC.md`, `docs/tlh/patch-inventory.md`, `.upstream-ledger.jsonl` | yes — confirm these files are not overwritten |
| Fork scripts | Fork-owned reporting helper not present upstream. | `scripts/tlh/upstream-report.sh` | yes — confirm not overwritten |
| AGENTS.md TLH section | Prepended TLH fork section pointing to governance docs and intake rules. Upstream AGENTS.md content left unchanged below it. | `AGENTS.md` | yes — re-apply or rebase section above upstream content |
| Fork CI workflow | Pending the CI ticket (tg-uduk); upstream workflows stay disabled via repo settings. | `.github/workflows/tlh-ci.yml` | yes — confirm upstream intake does not re-enable upstream workflows |
| Telemetry off by default, no bb PostHog key | `DEFAULT_BB_TELEMETRY=false` and `DEFAULT_BB_POSTHOG_API_KEY=''` so the fork never sends anonymous usage data to bb's PostHog project. The server's `createTelemetryService` returns the noop service when `apiKey` is empty or `enabled` is false. The in-app toggle remains visible but has no effect unless the operator sets both env vars. | `packages/config/src/env-vars.ts` | yes — after intake verify `DEFAULT_BB_TELEMETRY` is `false` and `DEFAULT_BB_POSTHOG_API_KEY` is `''`; grep for `phc_tejoY` must return nothing |
| Desktop identity and update feed | Rebrands the packaged desktop app from upstream `bb`/`dev.bb.desktop` identity to `tlh gui`/`com.thelastharness.gui` and points the update feed at `diegopetrucci/tlh-gui` releases. Stable and nightly variants updated. Icons unchanged. | `apps/desktop/scripts/desktop-release-channel.mjs`, `apps/desktop/scripts/desktop-release-channel.d.mts`, `apps/desktop/electron-builder.config.json`, `apps/desktop/src/desktop-update-provider.ts`, `apps/desktop/test/desktop-update-provider.test.ts`, `apps/desktop/test/electron-builder-config.test.ts`, `apps/desktop/test/electron-builder-windows-config.test.ts`, `apps/desktop/test/app-paths.test.ts`, `apps/desktop/test/desktop-linux-window-options.test.ts`, `packages/desktop-contract/test/version-feed.test.ts` | yes — after intake run `grep -rn 'dev.bb.desktop\|get-bb/bb/releases' apps/desktop packages/desktop-contract --include=*.ts --include=*.mjs --include=*.json --exclude-dir=node_modules` and confirm no matches; re-apply patch if needed |

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
