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

## Delegation return path

Every delegation names its return path: `do X, report DONE | BLOCKED | WAITING <what, and what event wakes me> to me`. For example: `WAITING PR-171 review; stall-guard artifact leg wakes me`. The return path makes silence attributable; the [silence/watch rule](#silence-is-a-defect-signal) makes it detectable. Neither is sufficient alone: a missing answer is not a delegation, and a wait cannot say who owes an unreported result without the return path.

A WAITING on the same thing past about 24 hours surfaces to the orchestrator as “wait went stale: chase the external or re-plan.” A WAITING claim without a live waker is a stall from day one. When a worker declares a waker, the orchestrator confirms that the named waker exists at check time before accepting the wait. This matters because WAITING is self-declared by the party who benefits from not being chased; confirmation turns that claim into evidence. Resolve the named waker live—never maintain a list of valid wakers here.

## Silence is a defect signal

When you send another seat a blocking question, set the watch in the same act: run `bb thread wait <their-thread> --status idle --timeout <bounded>`, always with an explicit bounded timeout, then check your own inbound for the answer. If their thread is idle and inbound has no answer, it was never sent or delivered: re-ask once, bundled. After the second watch, if there is still no answer, escalate to the operator or supervisor with `director unresponsive`; do not loop a third time. The same pattern applies downward to every lane blocking on you. It is one wait, one inbox check, and at most one re-ask—no polling and no timers.

## A message is delivered when it lands, consumed when the reply addresses it

A message is delivered when it lands in the recipient's thread, and consumed when their reply addresses it. The sender owns both checks.

Delivery is not the same as sending: a transport can accept a message and never deliver it, so confirm at the recipient's log rather than at your own send. Consumption is not the same as delivery: a reply that ignores what was asked — the coalescing shape, where a directive is acknowledged and dismissed — counts as not consumed. Chase it; do not count it.

Any tell requiring action names its expected reply in the `DONE | BLOCKED | WAITING` vocabulary, and the sender carries an open item until that reply arrives. An unanswered directive past the timer floor is chased exactly like any other stall: an owed reply sits alongside an owed `DONE`. No read receipts, no acknowledgement packets, no ceremony — the three-word vocabulary and the timer already close the loop. The only change is that senders track what they are owed.

## Lifecycle disposition

Every pull request carries exactly one disposition line: `Closes #NN` plus `Acceptance: complete`, or `Related GH-NN` naming an OPEN issue, or `No issue:` followed by a reason. `scripts/pr-lifecycle.mjs` is the canonical check — run it against your body before pushing rather than discovering the rule from a red pipeline.

Commit messages carry no linkage at all unless the pull request closes an issue and the commit names that same issue with a closing keyword. A `Related` or `Ref` mention in a commit message fails the gate even when the pull-request body is correct, because the checker treats any commit-side mention that is not an exact closing match as a conflict.

## Platform check before you design

Before writing a coordination rule or a line of coordination code, enumerate what bb natively does in that area — from the actual docs, CLI help, and plugin API, not from memory. A native mechanism replaces building; prose that duplicates a native signal is a stale copy waiting to diverge. This is the ladder's "does the platform already do it" rung, made explicit: the check is step one of designing any coordination mechanism, not a review afterthought.

## One writer per lane

> One branch, one owner. Stakeholders coordinate by message; nobody opens a parallel edit of the same lane.

## Blast radius

> Every decision sweeps its own blast radius in the same act. Open issues, open PRs, and queued lane specs are caches of older decisions; a decision changing an artifact’s existence, owner, shape, or terminology invalidates them silently. Each affected item gets a one-line update or closure at decision time, not when someone trips over it. A sweep that names artifacts reads them; relayed labels are unverified by definition.

Closing an issue is a decision with blast radius: an open PR whose disposition line says `Related GH-N` fails its lifecycle gate the moment N closes.
