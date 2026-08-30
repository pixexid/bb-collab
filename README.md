# bb-collab (retired)

The bb-collab governor is retired. BB native threads, parent delivery, status,
and messages are the collaboration product; this repository ships no watcher,
pulse, scheduler, WorkItem replacement, authority layer, or root plugin.

The only retained package is the independently useful
[`threads-list`](plugins/bb-plugin-threads-list) UI plugin. It does not call or
depend on the retired governor.

- Agent behavior: [AGENTS.md](AGENTS.md)
- One-time drain and retirement: [docs/retirement-runbook.md](docs/retirement-runbook.md)
- Historical governor implementation: use the immutable legacy tag recorded by
  the retirement runbook. Git history before that tag is evidence, not active
  product documentation.
