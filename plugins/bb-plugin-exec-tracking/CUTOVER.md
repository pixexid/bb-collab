# Same-id source cutover

This is a deployment runbook. Merging this package does not deploy it.

## Preconditions

- Build and verify the committed package from the exact deployed commit.
- Retain the old source directory and record `bb plugin source exec-tracking --json`.
- Record both settings values with `bb plugin config exec-tracking --json`.
- Disable the old plugin and quiesce producers. Refuse the cutover unless a
  read-only query of `role_wake_dedupe` reports zero `pending = 1` rows.
- Back up the id-scoped plugin database with SQLite's online backup command.

The zero-pending precondition matters because BB 0.39 cannot replace the path
of an installed id in place. Removing a path plugin preserves its id-scoped
`data.db`, but deletes its stored settings; installing the replacement enables
it immediately. With no pending retry rows, the replacement's first load is
fail-closed and inert while its absent settings are restored.

## Cut over

1. Remove `exec-tracking` through `bb plugin remove`.
2. Install this directory through `bb plugin install <absolute-path>`.
3. Restore each exact value through
   `bb plugin config exec-tracking set <key> <value>` and reload once.
4. Verify the source path, settings schema and values, database schema and row
   counts, CLI registration, server-only shape, and plugin health.
5. Run only synthetic/read-only verification. Do not issue a real wake.

Do not edit BB's registration or settings database directly. Do not delete the
old source or the backup until the observation window closes.

## Roll back

1. Disable and remove the replacement while producers remain quiesced.
2. If any database verification differs, restore the backed-up `data.db` before
   loading either implementation.
3. Install the retained old source directory, restore the two exact settings,
   and reload once.
4. Re-run the same source/config/schema/CLI/health checks before producers are
   released.

This rollback is lossless because the plugin id and database path do not change,
the old source is retained, the database is backed up before either load, and
the settings deleted by remove are captured and restored explicitly.
