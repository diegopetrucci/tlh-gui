---
name: pi-provider
description: "Inspect BB Pi provider support for message editing and context compaction."
---

# Pi provider

Pi supports editing and rerunning eligible user messages and compacting idle or
errored threads through the core `bb thread edit-message` and `bb thread compact`
commands. Inspect the thread first and use live command help for arguments.
Provider confirmation determines whether the operation completed.

Use the target host's provider catalog for available models and execution options.

## Provider ids

The plugin supplies three providers: `tlh` (The Last Harness; always shown and
the fresh-install default), `tlh-main` (a main-branch build; shown only where
the `tlh-main` CLI is installed) and `pi` (upstream Pi; shown only where the
`pi` CLI is installed). Choose one with `--provider <id>`, for example
`bb thread spawn --provider tlh-main`, and check `bb provider list` for what a
machine offers. `BB_PI_BRIDGE_COMMAND` and `BB_PI_BRIDGE_ARGS` affect only `pi`;
`tlh` and `tlh-main` always launch their own CLI.
