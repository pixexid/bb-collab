# Issue #57 mechanism 1: turn-terminal discipline

The lane watcher treats an open assignment lane as anomalous when its worker
is idle without a canonical terminal receipt and without a pending SDK
interaction. It steers that worker directly exactly once per unresolved
anomaly, coalescing repeated
poll/realtime observations until the worker becomes active, reports a
terminal receipt, waits on an external interaction, or is archived/deleted.
Supervisor threads are observers only and are never steer targets.

This bridge is temporary: delete the watcher auto-steer path when BB provides
an equivalent native turn-terminal event with reliable pending-wait and
terminal-receipt coverage.
