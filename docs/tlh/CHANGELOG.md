# tlh-gui release notes

## Unreleased (tlh-gui)

### Thread row actions

- Thread rows now show pin next to archive by default. Saved `rowActions` preferences are unchanged. To restore the old default, run `bb thread-list prefs set rowActions '["bb--core/archive"]'`.

### TLH, TLH main and Pi providers

- Three providers now ship from the Pi plugin: `tlh` ("TLH", always shown, default on fresh installs; saved preferences win), `tlh-main` ("TLH main", shown only where installed, no Install action or release-update checks) and `pi` ("Pi", upstream Pi, shown only where installed).
- On upgrade, bb relabels legacy `pi` to `tlh` once: threads, project defaults, pending interactions, provider settings and automations. `pi` model catalogs are dropped and re-fetched; thread events are unchanged.
- Before relabelling, bb copies the database to `<db>.pre-tlh-provider-ids.bak` (`.1`, `.2`, … if the name exists). To undo, stop bb and restore that file over the database. Downgrading to an earlier version requires restoring the backup.
- The automations plugin database (`~/.bb/plugins/automations/data.db`) is relabelled too but has no backup, so restoring the core backup does not revert it. To revert automations on downgrade, stop bb and run `sqlite3 ~/.bb/plugins/automations/data.db "UPDATE automations SET execution = json_set(execution, '\$.providerId', 'pi') WHERE json_valid(execution) AND json_extract(execution, '\$.providerId') = 'tlh';"`. This also rewrites automations you created as `tlh` after upgrading.
- `BB_PI_BRIDGE_COMMAND` and `BB_PI_BRIDGE_ARGS` now affect only `pi`. If yours pointed at a different executable, relabelled threads now run `tlh`.
- Scripts using `--provider pi` and `~/.bb/config.json` `customModels` entries with `providerId` `pi` now mean upstream Pi; change them to `tlh` to keep using TLH.
- Moving an upstream bb data directory into this fork would relabel its real Pi threads as TLH too.
