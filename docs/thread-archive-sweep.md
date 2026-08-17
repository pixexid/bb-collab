# Thread archive sweep (GH-147)

`thread-archive-sweep` runs hourly while the plugin is loaded, once per native BB project. It reports only: scheduled runs never archive a thread. `BB_COLLAB_ARCHIVE_IDLE_H` sets the positive idle floor in hours; the default is 24.

`bb collab archive-sweep --project PROJECT_ID --apply` is the explicit, opt-in archive path. Both modes refuse when thread inventory, protected-set, per-project live-seat allowlist, or per-environment PR reads are unavailable. Protection covers execution attempts, role holders, the director exemption, open/draft PRs, below-floor descendants, assigned children, source-thread forks, and their ancestors, plus the temporary live-seat allowlist. Apply rebuilds the report before each root archive and refuses if that root has changed. The allowlist remains until GH-104 makes live-seat recording complete.
