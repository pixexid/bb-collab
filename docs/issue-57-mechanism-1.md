# Issue #57 mechanism 1: turn-terminal discipline

The lane watcher treats an open assignment lane as anomalous when its worker
is idle without a canonical terminal receipt and without a pending SDK
interaction. It steers that worker directly exactly once per unresolved
anomaly, coalescing repeated
poll/realtime observations until the worker becomes active, reports a
terminal receipt, waits on an external interaction, or is archived/deleted.
Supervisor threads are observers only and are never steer targets.

Since #93 (registered waits, #57 mechanism 8) the same detector treats an
active registered wait as the only additional legal idle: a worker whose
thread holds a registered wait row is waiting, not stalled, and is not
steered; the wait's own deadline and the durable validator own the wake.
An unregistered "wait" remains an illegal idle reason.

This bridge is temporary: delete the watcher auto-steer path when BB provides
an equivalent native turn-terminal event with reliable pending-wait and
terminal-receipt coverage.
