# Working rules

> "the deletion mandate forbids CEREMONY — mechanism that asks something of the operator or the fleet; it does not forbid PLUMBING that removes the need for copies."

## One review pass per PR

> One independent cold review; fix what it finds; the orchestrator verifies the fixed head itself; merge. Never re-request review on a fixed head; remaining edge cases become follow-up issues. A confirmed serious defect still blocks; the bar is “confirmed serious”, not “the reviewer found one more thing”.

## Proof must discriminate

> Before citing evidence, ask: could this pass in a world where my claim is false? Silently skipped tests, report-only alerts, and load-lines without content checks are activity, not proof. When a signature changes, “fails against pre-fix source” degrades to a compile error and discriminates nothing.

## Canonical source, no restated copies

> Docs point at the one canonical definition; a restated command or value is a cache that goes stale silently. State the rule and the check, never a current runtime value.

## Version-bump test

> Bump the contract version iff a session still running on the old text would keep doing something now prohibited, keep trusting something now false, or fail to do something newly required. Wording, examples, and relocations never bump.

## Question is not delegation

> A question gets an answer; a delegation is a frozen bounded work order with an exact deliverable and no open question. Never both in one message. An acknowledgement is not a deliverable.

## Silence is a defect signal

When you send another seat a blocking question, set the watch in the same act: run `bb thread wait <their-thread> --status idle --timeout <bounded>`, always with an explicit bounded timeout, then check your own inbound for the answer. If their thread is idle and inbound has no answer, it was never sent or delivered: re-ask once, bundled. After the second watch, if there is still no answer, escalate to the operator or supervisor with `director unresponsive`; do not loop a third time. The same pattern applies downward to every lane blocking on you. It is one wait, one inbox check, and at most one re-ask—no polling and no timers.

## One writer per lane

> One branch, one owner. Stakeholders coordinate by message; nobody opens a parallel edit of the same lane.

## Blast radius

> Every decision sweeps its own blast radius in the same act. Open issues, open PRs, and queued lane specs are caches of older decisions; a decision changing an artifact’s existence, owner, shape, or terminology invalidates them silently. Each affected item gets a one-line update or closure at decision time, not when someone trips over it. A sweep that names artifacts reads them; relayed labels are unverified by definition.

Closing an issue is a decision with blast radius: an open PR whose disposition line says `Related GH-N` fails its lifecycle gate the moment N closes.
