# Ponytail

**Canonical source:** the ponytail skill itself — highest-versioned copy under
`~/.claude/plugins/cache/ponytail/ponytail/<version>/.openclaw/skills/ponytail/SKILL.md`
(read by bb workers through the `ponytail` bb-user skill router). Do not edit
this file to change ponytail behavior; the canonical skill owns that.

This file is a **non-canonical summary** kept only so repository readers know
the doctrine exists without opening the skill.

## Ladder summary (non-canonical)

1. Does this need to exist at all? (YAGNI)
2. Already in this codebase? Reuse before re-implementing.
3. Stdlib does it? Use it.
4. Native platform feature covers it? Use it.
5. Already-installed dependency solves it? Use it.
6. Can it be one line? One line.
7. Only then: minimum code that works.

Deletion over addition; no unrequested abstractions; shortest working diff
after understanding the whole path. Never simplify away trust-boundary
validation, error handling that prevents data loss, or security measures.
