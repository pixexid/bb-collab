# Companion Watcher

The watcher bootstraps from BB's native project inventory (`bb.sdk.projects.list()`); the personal project is excluded by that native default. Each inventory row is evaluated independently.

For each project, the watcher reads the canonical `bb collab export --project <project-id>` snapshot from the BB data directory resolved by `bb.sdk.system.config()`. The export manifest and every project-owned row must match that project ID before candidate evaluation. GitHub evidence uses the repository URL from the same inventory row. Backoff, companion threads, pending judgments, candidate IDs, anchors, fingerprints, evidence, and wake routing remain project-scoped.

Phase-3 activation is read-only: run the two-project fixture controls and the truncation/blindness mutants, then the repository verification and reachability gates. Activation requires that a malformed or incomplete project silences only itself and that duplicate issue, PR, work-item, and queue identifiers cannot cross-route.
