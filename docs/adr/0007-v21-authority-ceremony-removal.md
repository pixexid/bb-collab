# ADR 0007: Contract v21 — authority-ceremony removal

- Status: accepted
- Date: 2026-08-17
- Scope: the authority-ceremony removal and its contract version
- Authority: operator ruling

## Decision

> "the operator ruled the entire authority-ceremony stack deleted with NO replacement framework."

Authority now lives in the role instructions. Workers act within role and ask
the orchestrator when blocked; the orchestrator decides within its authority
and asks the director beyond it. The director holds standing approval over its
own class and orchestrator asks, then tells the operator what was approved and
why. Approval is a message from the tier that owns the decision, nothing more.

Only credentials and accounts, real spend, legal matters, product direction,
and destructive-irreversible actions are operator-only. They go to the
operator as plain questions, and the operator’s typed reply settles them.

## Contract version

`CONTRACT_VERSION` moves from 20 to 21. This passes the version-bump test:
a session still running on the v20 text would keep trusting receipt machinery
that no longer exists. The removal is therefore an obligation change, not a
wording, example, or relocation change.

## Consequences

There is no replacement framework. The removed authority ceremony does not
become a registry, gate, confirmation, approval mechanism, or second store.
The role instructions and their canonical rules carry the operating behavior.

This supersedes the authority-ceremony portions of ADRs 0001–0005. Their
historical decisions remain readable; only the removed machinery is
superseded.
