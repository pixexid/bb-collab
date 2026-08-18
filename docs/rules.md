# Working rules

> "the deletion mandate forbids CEREMONY — mechanism that asks something of the operator or the fleet; it does not forbid PLUMBING that removes the need for copies."

## One review pass per PR

> One independent cold review; fix what it finds; the orchestrator verifies the fixed head itself; merge. Never re-request review on a fixed head; remaining edge cases become follow-up issues. A confirmed serious defect still blocks; the bar is “confirmed serious”, not “the reviewer found one more thing”.

## Proof must discriminate

> Before citing evidence, ask: could this pass in a world where my claim is false? Silently skipped tests, report-only alerts, and load-lines without content checks are activity, not proof. When a signature changes, “fails against pre-fix source” degrades to a compile error and discriminates nothing.

A mechanism's own status surface outranks any correlation assembled from logs. Before citing a log correlation as proof that something did not happen, [name the status surface you checked first](#a-status-read-is-evidence-about-the-moment-it-was-read); if you cannot name one, you have not checked. A negative result also needs proof the mechanism was live during the window — "nothing was delivered" and "nothing ran" are indistinguishable without receipts.

Apply this to your own evidence, not only to evidence you are reviewing. Verifying that a message was really sent says nothing about whether what it said was true; provenance, delivery and truth are three separate claims.

Quote what is there rather than what it means: a paraphrase inside quotation marks is a fabricated citation even when the semantics are right.

## Canonical source, no restated copies

> Docs point at the one canonical definition; a restated command or value is a cache that goes stale silently. State the rule and the check, never a current runtime value.

## Version-bump test

> Bump the contract version iff a session still running on the old text would keep doing something now prohibited, keep trusting something now false, or fail to do something newly required. Wording, examples, and relocations never bump.

## Question is not delegation

> A question gets an answer; a delegation is a frozen bounded work order with an exact deliverable and no open question. Never both in one message. An acknowledgement is not a deliverable.

## Delegation return path

Every delegation names its return path: `do X, report DONE | BLOCKED | WAITING <what, and what event wakes me> to me`. For example: `WAITING PR-171 review; stall-guard artifact leg wakes me`. The return path makes silence attributable; the [silence/watch rule](#silence-is-a-defect-signal) makes it detectable. Neither is sufficient alone: a missing answer is not a delegation, and a wait cannot say who owes an unreported result without the return path.

A WAITING on the same thing past about 24 hours surfaces to the orchestrator as “wait went stale: chase the external or re-plan.” A WAITING claim without a live waker is a stall from day one. When a worker declares a waker, the orchestrator confirms that the named waker exists at check time before accepting the wait. This matters because WAITING is self-declared by the party who benefits from not being chased; confirmation turns that claim into evidence. Resolve the named waker live—never maintain a list of valid wakers here.

The declarer owes the same check. Before ending a turn in `WAITING`, name the event and confirm it exists; if the next step is yours, or the event has already fired, take it. Orchestrator confirmation catches a phantom wait after it exists, which is one stall too late.

## Silence is a defect signal

When you send another seat a blocking question, set the watch in the same act: run `bb thread wait <their-thread> --status idle --timeout <bounded>`, always with an explicit bounded timeout, then check your own inbound for the answer. If their thread is idle and inbound has no answer, it was never sent or delivered: re-ask once, bundled. After the second watch, if there is still no answer, escalate to the operator or supervisor with `director unresponsive`; do not loop a third time. The same pattern applies downward to every lane blocking on you. It is one wait, one inbox check, and at most one re-ask—no polling and no timers.

## Quiet with startable work is a defect state

Intake is not a thing you do when you think of it. It fires on every wake, and the check is two counts: `startable > 0 AND lanes < cap`. If both hold, the fleet is in a defect state and the wake's first act is a dispatch. Labels are queue truth; an unlabelled issue is not in the queue, so labelling is part of filing.

Silence proves nothing here. On 2026-08-18 the fleet sat idle for about six hours, silent for the last four and a half, with eighteen startable issues, zero lanes, and six hourly watchdog cycles that were all correctly quiet — the ledger was all-terminal, so the watchdog had nothing to see. The state was found by the operator. A mechanism that only watches declared work cannot detect work nobody has declared yet, which is why the check belongs to the seat and not only to the timer.

Free capacity is a ceiling, not a quota. Dispatching a colliding lane to reach the cap breaks [one writer per lane](#one-writer-per-lane), and that rule wins: an idle seat is cheaper than two writers on one surface. When capacity is free but every remaining item collides, that is the no-dispatch reason — say it.

This rule exists in the repository because the same rule lived in chat first and evaporated with the context that held it. A rule in a conversation is a cache with no source.

## A lane-completion turn ends with a dispatch or a reason

> An orchestrator's turn that reports a lane finishing never ends there. It ends with the next dispatch, or with the explicit reason there is none.

A bare completion reads as progress while leaving the fleet stopped, and it hides the intake check rather than failing it. The reason, when there is one, is a specific claim someone can check — every startable item collides with a held surface, the board is empty, capacity is full — never "nothing obvious right now".

## Completion is native; the verdict is ours

bb already tells a parent thread when a child finishes: it emits `child-completed`, `child-failed`, `child-interrupted`, and `child-outcome-batch`, and `threads.childSummary` reads the same ground. Do not build completion notification — wire the native signal.

What the platform does not tell you is the part that matters. bb tells you a child finished; it does not tell you whether the child succeeded. The notification is native; the verdict is ours. That is what the `DONE | BLOCKED | WAITING` return path carries, and why the vocabulary stands on top of a signal we no longer write ourselves.

## A message is delivered when it lands, consumed when the reply addresses it

A message is delivered when it lands in the recipient's thread, and consumed when their reply addresses it. The sender owns both checks.

Delivery is not the same as sending: a transport can accept a message and never deliver it, so confirm at the recipient's log rather than at your own send. Consumption is not the same as delivery: a reply that ignores what was asked — the coalescing shape, where a directive is acknowledged and dismissed — counts as not consumed. Chase it; do not count it.

Any tell requiring action names its expected reply in the `DONE | BLOCKED | WAITING` vocabulary, and the sender carries an open item until that reply arrives. An unanswered directive past the timer floor is chased exactly like any other stall: an owed reply sits alongside an owed `DONE`. No read receipts, no acknowledgement packets, no ceremony — the three-word vocabulary and the timer already close the loop. The only change is that senders track what they are owed.

## Lifecycle disposition

Every pull request carries exactly one disposition line: `Closes #NN` plus `Acceptance: complete`, or `Related GH-NN` naming an OPEN issue, or `No issue:` followed by a reason. Run both canonical body gates before pushing: `scripts/pr-lifecycle.mjs` for disposition and `scripts/check-review-tier.mjs` for exactly one line matching its `Review tier` declaration pattern. Tier A is forced by any path matched by that script's `tierA` patterns, including its authority/approval/atomicity/concurrency/cutover/migration/provenance/receipt/spend keyword pattern; Tier C applies only when no Tier-A path matches and every path matches its `tierC` patterns. Because `dist/` is Tier A, a docs-only `docs/rules.md` edit that regenerates `dist/role-briefs.json` requires Tier A.

Commit messages carry no linkage at all unless the pull request closes an issue and the commit names that same issue with a closing keyword. A `Related` or `Ref` mention in a commit message fails the gate even when the pull-request body is correct, because the checker treats any commit-side mention that is not an exact closing match as a conflict.

## Platform check before you design

Before writing a coordination rule or a line of coordination code, enumerate what bb natively does in that area — from the actual docs, CLI help, and plugin API, not from memory. A native mechanism replaces building; prose that duplicates a native signal is a stale copy waiting to diverge. This is the ladder's "does the platform already do it" rung, made explicit: the check is step one of designing any coordination mechanism, not a review afterthought.

## One writer per lane

> One branch, one owner. Stakeholders coordinate by message; nobody opens a parallel edit of the same lane.

Check what is already assigned before dispatching. Keeping the fleet busy is not a reason to open a second writer on a surface someone already holds; an idle seat is cheaper than duplicated work.

## Off-matrix work stands on its evidence

> Finished, reviewed, green work stands on its evidence and is never re-run for provenance alone. The provenance deviation is recorded in the pull-request body as it merged.

Discovering that a lane ran on an unratified model, or at the wrong reasoning level, does not retroactively make its output wrong. Re-running it would cost real work to buy a receipt, and the receipt would say nothing the review and the tests do not already say. Record what actually executed, and judge the work by what it produced.

This cuts the other way too. "It worked out" is not ratification, and a good outcome from an unplaced model is evidence for a probe to weigh, never a substitute for one.

## A ruling disposes its own subordinate instances

> When the same pattern surfaces again below a ruling that already covers it, apply the ruling. It returns to the deciding seat only when it presents new evidence, or when it resists the ruling's reasoning.

Re-asking a settled question costs a round trip and buys nothing, and it teaches the seat below to stop thinking at the first resemblance. The test is not "is this the same case" but "does the ruling's reasoning reach this one". A model unratified for placement is still unratified when its name appears inside a row about something else; ratification-by-containment does not exist, so that instance is disposed, not escalated.

Two things a seat owes when it disposes rather than escalates: say that it did, and say which ruling it applied. A disposition recorded as if it were a fresh decision is indistinguishable from a seat exceeding its authority.

## Blast radius

> Every decision sweeps its own blast radius in the same act. Open issues, open PRs, and queued lane specs are caches of older decisions; a decision changing an artifact’s existence, owner, shape, or terminology invalidates them silently. Each affected item gets a one-line update or closure at decision time, not when someone trips over it. A sweep that names artifacts reads them; relayed labels are unverified by definition.

Closing an issue is a decision with blast radius: an open PR whose disposition line says `Related GH-N` fails its lifecycle gate the moment N closes.

## A status read is evidence about the moment it was read

> Registry state and live state are different substrates. Before acting on "X is dead", re-read or address X directly — a status field is already history when you read it; [the status surface you cite must be the one you checked](#proof-must-discriminate). The same gap applies to your checkout versus the repo, and to a source file versus the deployed artifact.

## Two notions of one fact

> When one stored value answers two different questions, it will eventually answer one of them wrongly. Split it at the point the second meaning appears, not after the false read. A dead field left in place "but ignored" is a trap for the next reader: ignoring is a property of today's code, not of the data.

## Test the claim, not the routing

> Where a mechanism asserts a condition, assert that the condition is true when asserted. Tests that check the right inputs select the right branch all pass while the emitted sentence is false, and they keep passing if a later path reaches the same output another way.

A late mechanism is recoverable; a lying one is not. In anything that notifies, the failure that matters most is not silence — it is a false assertion at the highest-authority tier, because that tier is trained to act on what arrives.

## A mechanism under investigation stops talking

> Freezing the investigation is not freezing the subject. A mechanism being examined for asserting false conditions is silenced while it is examined, or it keeps emitting into the record you are trying to read.

## The ladder applies to operations

> Before ordering the heavy mechanism, ask which lighter one already covers it. Runtime configuration beats a rebuild. Reaching for the largest available action is the same reflex the ladder exists to interrupt, pointed at operations instead of code.
