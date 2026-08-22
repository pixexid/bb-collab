# Companion positive-trigger production exercise

This branch and pull request are synthetic production state for an operator-directed acceptance exercise. They must never merge.

For the companion watcher, the pull request is intentionally actionable while open: after checks pass, the orchestrator owes its closure. An idle orchestrator before the companion wake is the exercised failure condition. The `exercise` label is an accounting marker only; weekly throughput and defect reports exclude this artifact.

Cleanup closes the pull request unmerged, deletes its branch, and removes this worktree.
