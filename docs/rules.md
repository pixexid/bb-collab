# Working rules

> "the deletion mandate forbids CEREMONY — mechanism that asks something of the operator or the fleet; it does not forbid PLUMBING that removes the need for copies."

Every rule below is enforceable law; the origin stories live in git history and the issues each rule cites. Section titles are stable anchors — other docs link to them; never rename one.

## One review pass per PR

> One independent cold review; fix what it finds; the orchestrator verifies the fixed head itself; merge. Never re-request review on a fixed head; remaining edge cases become follow-up issues. A confirmed serious defect still blocks — the bar is "confirmed serious", not "the reviewer found one more thing".

## Proof must discriminate

> Before citing evidence, ask: could this pass in a world where my claim is false? Silently skipped tests, report-only alerts, and load-lines without content checks are activity, not proof.

A filtered run that matched nothing exits zero and prints a passing summary: take the exact test name from the diff and read the executed count, not the exit code. A negative result needs proof the mechanism was live during the window — "nothing was delivered" and "nothing ran" are indistinguishable without receipts. Never verify from absence without a positive control: a quiet plugin and a broken logger look identical; close deploys and watcher changes with one self-emitted line. Provenance, delivery, and truth are three separate claims. Quote what is there, not what it means — a paraphrase inside quotation marks is a fabricated citation even when the semantics are right.

## Canonical source, no restated copies

> Docs point at the one canonical definition; a restated command or value is a cache that goes stale silently. State the rule and the check, never a current runtime value.

## Version-bump test

> Bump `INSTRUCTION_CONTRACT_VERSION` iff a session still running on the old instruction text would keep doing something now prohibited, keep trusting something now false, or fail to do something newly required. Wording, examples, and relocations never bump. This governs the instruction contract in `AGENTS.md`, not the separate `RUNTIME_CONTRACT_VERSION` in `src/foundation.ts`, whose value feeds `contractDigest` and whose bump is a runtime cached-consumer compatibility decision.

## Question is not delegation

> A question gets an answer; a delegation is a frozen bounded work order with an exact deliverable and no open question. Never both in one message. An acknowledgement is not a deliverable.

## Delegation return path

> Every delegation names its return path: `do X, report DONE | BLOCKED | WAITING <what, and what event wakes me> to me`. The return path makes silence attributable; the [silence/watch rule](#silence-is-a-defect-signal) makes it detectable.

A WAITING claim without a live waker is a stall from day one. The declarer names the waking event and confirms it exists before ending the turn — if the next step is yours, or the event already fired, take it. The orchestrator confirms the named waker exists at check time before accepting the wait, because WAITING is self-declared by the party who benefits from not being chased. A WAITING on the same thing past ~24 hours surfaces to the orchestrator as "wait went stale: chase the external or re-plan." Resolve the named waker live — never maintain a list of valid wakers.

## A work order owns bounds, not method

> The author owns the coordination bounds: exact scope, surfaces held elsewhere, gates, return path, and hard prohibitions — including destructive or irreversible acts and required trust-boundary protections. Those are constraints, not implementation steps. The author's implementation analysis is a reading to check, never a method the lane must follow; the lane reads the code and chooses the method within the bounds. If evidence disproves the order's reading or no compliant method exists, a well-evidenced `BLOCKED` is a successful return, not a failure to obey.

## Silence is a defect signal

> A blocking question and its watch are one act: run `bb thread wait <their-thread> --status idle --timeout <bounded>`, always bounded, then check your own inbound for the answer. Idle plus no answer means never sent or delivered: re-ask once, bundled. Still nothing after the second watch: escalate with `director unresponsive` — never loop a third time. One wait, one inbox check, at most one re-ask: no polling, no timers. The same pattern applies downward to every lane blocking on you.

## Quiet with startable work is a defect state

> Intake fires on every wake. The check is two counts: `startable > 0 AND lanes < cap`. If both hold, the fleet is in a defect state and the wake's first act is a dispatch.

Labels are queue truth: an unlabelled issue is not in the queue, so labelling is part of filing. A watchdog sees declared work only; work nobody declared is the seat's check, not the timer's — six correctly-quiet watchdog cycles once accompanied six idle hours with eighteen startable issues. Free capacity is a ceiling, not a quota: dispatching a colliding lane to reach the cap breaks [one writer per lane](#one-writer-per-lane), and that rule wins. When every remaining item collides, that is the no-dispatch reason — say it.

## Epic decomposition and readiness

> An epic is planning-only: each child is independently mergeable and declares `sliceId`, `dependsOn`, `readiness`, and `estimateHours`. A child is startable only when every dependency is merged and readiness is true. Deferred or operator-wait children keep `queueBlocked: false`; no child estimate may exceed 8 hours.

## A lane-completion turn ends with a dispatch or a reason

> An orchestrator's turn that reports a lane finishing ends with the next dispatch, or with the explicit reason there is none — a specific checkable claim (every startable item collides with a held surface, the board is empty, capacity is full), never "nothing obvious right now".

## Completion is native; the verdict is ours

> bb natively emits `child-completed`, `child-failed`, `child-interrupted`, and `child-outcome-batch`; `threads.childSummary` reads the same ground. Never build completion notification — wire the native signal. bb tells you a child finished; it does not tell you whether the child succeeded. The notification is native; the verdict is ours, and it is what the `DONE | BLOCKED | WAITING` return path carries.

## A message is delivered when it lands, consumed when the reply addresses it

> Delivery is confirmed at the recipient's log, never at your own send result — a transport can accept a message and never deliver it. Consumption is a reply that addresses what was asked; an acknowledge-and-dismiss counts as not consumed — chase it, do not count it.

Any tell requiring action names its expected reply in `DONE | BLOCKED | WAITING`; the sender tracks what it is owed and chases it like any other stall. No read receipts, no acknowledgement packets.

Modes: `auto` is the default tell — delivers now, starts a turn on an idle thread. `queue` is for genuinely batch-later payloads to a busy recipient; queue arrival does not wake. `steer` when the payload bears on the turn running right now. Queue-awareness is a standing duty: open every busy stretch with a queue check on yourself; held messages outrank self-imposed work; no turn ends with an unread queue it had the chance to read. Results flow push, not pull: a finishing worker sends its report; if you are polling a session to learn an outcome, that delegation's return path was missing — fix the brief, not your ticker.

## External-party content uses the inbox

> Actionable content intended for the operator outside the current conversation goes through `send_to_operator`; leaving it only in a turn output is a delivery defect.

The bound is the intended delivery path, not the word "operator": a direct reply to an operator participating in the current conversation stays in it; a lane receipt goes to its named fleet return path; decisions and evidence land in their canonical stores. The same inbox surface carries messages to the supervisor, while the `SUPERVISOR-REPORT` marker convention remains in force until its separately governed retirement. If the tool is absent or refuses, report that failure through the return path — printing the intended message and calling it delivered repeats the defect the inbox exists to remove.

## Operator Inbox communication doctrine

> The Operator Inbox is the sole wire for all operator-bound traffic in every tenant. A needs-decision ask is a separate explicit blocking question, not progress mixed into a digest. Phase boundaries, blocked escalations, and mandated-loop `DONE` reports are concise Inbox messages. Routine progress is a low-frequency batched digest. BB chat is not an operator channel. A `replyToOperatorMessage` reply is intake truth: consume it from the Inbox record and do not treat an unrelated chat message or an unobserved reply as an answer. Keep public messages free of private paths, settings, message contents, and incident-private values.

## Project-agnostic by construction

> New or changed surfaces that store, read, or route project-owned data require the exact `project_id` as an explicit dimension; never substitute an ambient, default, or hardcoded project. A missing or null project never matches. The rule does not attach a fake project to genuinely global state, does not require a retroactive audit of untouched surfaces, and binds the project-owned behavior introduced or changed by the current work.

## Lifecycle disposition

> Every pull request carries exactly one disposition line: `Closes #NN` plus `Acceptance: complete`, or `Related GH-NN` naming an OPEN issue, or `No issue:` followed by a reason. Run both canonical body gates before pushing: `scripts/pr-lifecycle.mjs` and `scripts/check-review-tier.mjs` (exactly one line matching its `Review tier` pattern). Tier A is forced by any path matched by that script's `tierA` patterns; Tier C applies only when no Tier-A path matches and every path matches `tierC`. Because `dist/` is Tier A, a docs-only `docs/rules.md` edit that regenerates `dist/role-briefs.json` requires Tier A.

Commit messages carry no linkage at all unless the PR closes an issue and the commit names that same issue with a closing keyword; any other commit-side mention fails the gate even when the body is correct.

## Platform check before you design

> Before writing a coordination rule or a line of coordination code, enumerate what bb natively does in that area — from the actual docs, CLI help, and plugin API, not from memory. A native mechanism replaces building; prose that duplicates a native signal is a stale copy waiting to diverge. This is step one of designing any coordination mechanism, not a review afterthought.

## One writer per lane

> One branch, one owner. Stakeholders coordinate by message; nobody opens a parallel edit of the same lane. Check what is already assigned before dispatching: an idle seat is cheaper than two writers on one surface.

## Off-matrix work stands on its evidence

> Off-matrix AUTHORING that later receives a valid matrix-qualified independent review stands on its evidence and is never re-run for provenance alone; the deviation is recorded in the pull-request body as it merged.

The rule stops at the gate: it does NOT extend to a review, qualification, or release artifact, where the off-matrix work IS the gate ([threat model](threat-model.md)); the remedy is a qualified review, never an argument about quality. Requested-profile mismatch fails closed at dispatch. A Tier-A reviewer may inspect and return a provisional verdict before execution-profile proof is available; the parent accepts it only after the exact reviewer turn has completed and the native thread is idle, using the canonical [provisional-verdict acceptance gate](operations-model.md#provisional-tier-a-verdict-acceptance). A provider-native executed-profile readback returning UNKNOWN is retried once after forcing or confirming idle on that same exact turn. Persistent UNKNOWN rejects the provisional verdict and consumes the sole replacement; a second replacement failure blocks and escalates. "It worked out" is not ratification: a good outcome from an unplaced model is evidence for a probe, never a substitute for one.

## A ruling disposes its own subordinate instances

> When the same pattern surfaces again below a ruling that already covers it, apply the ruling — but only when the instance falls inside the ruling's own stated subject AND inside your existing authority. Uncertainty about either goes back up.

Inside the stated subject means inside what the ruling actually addressed, not an extension you infer from its rationale — ratification-by-containment does not exist. Inside existing authority means the act is one you could already take under your role and current work order; a ruling settles a question, it never enlarges a seat. Naming the ruling you applied is disclosure for audit, not a guard; a seat owes both conditions and the disclosure.

## Merge is not deploy is not reload

> A change is not live until a deployed revision CONTAINING it is what host supervision is running. Merged, deployed, and loaded are three states; reporting the first as the third is the most comfortable error available.

The check is per-change: name the deployed revision, establish containment and supervision — equality with `main` is not the test. "Merged, not deployed" is a complete and honest terminal status. Deploys run under the standing policy: orchestrator-run under standing authorization, zero-lane lull, store snapshot before, store-verified after, deployed SHA recorded in the handoff. Path plugins update via checkout-advance plus `bb plugin reload <id>`; `bb plugin update` refuses pinned sources.

The deploy policy splits by surface. Canonical/store/fleet-state plugins retain
the zero-lane lull, pre-deploy snapshot, and post-deploy store verification.
For view-only threads, lanes, and inbox plugins, visibility is evaluated first:
Tier-A gates are the merge gate, then deploy immediately with the pre-deploy
snapshot, exact checkout advance, reload of only that plugin ID, verification
of live asset-route bytes, and a recorded deployed SHA plus snapshot. The
operator evaluates the live interactive surface; feedback becomes a fix-forward
issue.

## Directional UI/UX changes require an operator checkpoint

> A pre-merge visual checkpoint is required only when the operator explicitly asks for it or the change is a directional redesign. Then show synthetic screenshots or a live demo, give a one-line summary, and ask explicitly for `APPROVE` or `ADJUST`. Operator silence holds the merge; it is not approval.

The canonical evidence is attached to the PR or its governed handoff. A
view-only plugin that is not an explicit-request or directional-redesign case
uses the live deployment path above rather than a pre-merge screenshot gate.

## An escalation's premises are checkable claims

> Verify the MATERIAL premises before executing — the ones that, if false, change what the act does. Each needs an identified authoritative check; a material premise you cannot resolve goes back up, named unresolved, instead of being assumed.

Ask what the act becomes if the fact is false: if "the same act", stop checking. A seat that executes on a relayed fact inherits it. This binds downward — the seat writing a frozen work order owes the checks a lane cannot easily question — and upward: an unchecked material fact handed to a decider is the same defect. Reading is an act-time discipline: re-read live inputs, including an issue's fresh comments, in the same breath as the act — step-zero is a dispatch-time act, not a composition-time one.

## A completeness search names its surfaces

> A completeness claim states which surfaces it searched and under which names — and the surfaces have to be the ones its own claim depends on.

A claim about current canonical state is complete from the canonical live surface; archived material is irrelevant to it. A claim about whether something has happened before is different: fleet history lives in threads, and threads archive — issues and docs are the surfaces least likely to hold finished work. Search the concept's names, not one spelling: a renamed thing hides its own introduction, and the gap is invisible because the search returns results. "I searched" is not a finding; "I searched open issues, docs, and archived threads, for both X and its earlier bare form" is one a reader can check and extend.

## A candidate in production is a drill instrument with two stamps

> Unmerged code reaches the production deploy worktree only as a pre-authorized drill instrument, and the pull-request body records both the deploy and the event that ENDED the unmerged exposure. An exposure window without a documented end is an unaudited window.

The closing event is usually a restore (a reload stamp, verified independently — deployed revision, artifact mtime, absence of a candidate-only string) or a merge of the exact running SHA (auditable from git containment). Record which kind actually ended it; demanding a restore stamp for a window that closed by merge demands a stamp that does not exist. Host loading is an operator act; this rule governs the record.

## A recovery timebox starts at the observed failure

> A clock measuring RECOVERY starts at the first native observation of the failure, never at a scheduled or presumed start — otherwise a failure that never happened manufactures a false mechanism-failure finding. A drill's other clocks (an injection-phase timebox) legitimately start at the scheduled event; do not collapse the two. One clock asks whether the mechanism recovered the seat, the other whether anything broke it, and they start at different events because they measure different claims.

## A seat is the worst witness to its own outage

> Liveness comes from native state, never from a seat's account of its own continuity. A recovered seat's "I was working the whole time" is generated by the very process whose absence is in question — an artifact of the thing being asked about. This is the [premise rule](#an-escalations-premises-are-checkable-claims) applied to yourself: when the question is whether a seat was reachable, alive, or interrupted, the answer comes from the native record and the seat's narrative is not admitted.

## Write for a stranger

> Credentials, private-project internals, personal data, and host details stay out of issues, PRs, comments, and commits. Credentials includes locations, key names, shapes, lengths, and ports — individually harmless, collectively a map. Internals means designs, schemas, business content; naming a project is fine. Host details means usernames, home paths, tooling layout — not the OS, architecture, tool version, or loopback binding a reproducible record needs. Where specifics are genuinely needed: the public artifact carries the abstract record and disposition; specifics live in local durable state by id. An issue unreadable without a credential-adjacent detail is a finding about the issue, not a licence to publish one.

Two narrowing techniques, neither of which settles a question: check disclosure by shape without re-disclosing (length, character class, padding — a clean result means "no conventionally-shaped credential found", never "no credential"); narrow live-versus-fixture by searching every surface where the value would matter (absence shifts the burden, never proves illustrative). Reading a credential file: ask for shape, not contents — a search for key *names* that prints matching *lines* prints the values.

## Spawn against a fetched ref

> Fleet spawns pass `--base-branch origin/main`; never bare `main`, which silently resolves the stale local ref (measured 14 commits behind on 2026-08-19). Refresh a stale base with `git fetch origin main:main`; if `main` is checked out and that refuses by design, use `git pull --ff-only`. Standing until [get-bb/bb#1917](https://github.com/get-bb/bb/issues/1917) lands.

## The no-dispatch reason is the second half of the intake check

> `startable > 0 AND lanes < cap` asks whether there is capacity and startable work; surface collision decides whether dispatch is possible, and only the seat holding the lanes can answer. The collision map in a no-dispatch reason is the missing half of the check, not courtesy. A reason may point at a standing one unchanged — restating an identical map hourly is noise. Surface occupancy is deliberately NOT encoded into the wake condition: no canonical source can compute it, and a confident condition on an unverifiable input is how permanently-true wakes happen.

## A ruling names its seat and its surface

> Before ruling an act executable, name both the seat that will perform it and the surface it will perform it through. A ruling missing either routes upward or waits — it never routes to improvisation, because the improvisation nearest to hand is usually the thing the ruling was trying to prevent.

Establish that a surface is really absent before saying so — a truncated help listing is not absence, and a false absence defers real work and writes the error into doctrine. This check is made when the ruling is written, by the seat writing it; it is prose about intent and is deliberately not mechanized.

## Blast radius

> Every decision sweeps its own blast radius in the same act. Open issues, open PRs, and queued lane specs are caches of older decisions; a decision changing an artifact's existence, owner, shape, or terminology invalidates them silently. Each affected item gets a one-line update or closure at decision time, not when someone trips over it. A sweep that names artifacts reads them; relayed labels are unverified by definition.

Closing an issue is a decision with blast radius: an open PR whose disposition line says `Related GH-N` fails its lifecycle gate the moment N closes. A governance-level change — a severance, a contract bump, a matrix re-ratification — sweeps BEFORE its pull request merges. A change that renames nothing and removes no mechanism sweeps nothing, and says so.

## A status read is evidence about the moment it was read

> Registry state and live state are different substrates. Before acting on "X is dead", re-read or address X directly — a status field is already history when you read it. The same gap applies to your checkout versus the repo, and to a source file versus the deployed artifact.

A read does not reserve what it read: two callers gated on "the target is idle" can both clear the check. Narrowing the window is not closing it — name a mechanism that closes or tolerates the race and state what remains open; serialising a sender closes it among that sender's callers only.

## Two notions of one fact

> When one stored value answers two different questions, it will eventually answer one of them wrongly. Split it at the point the second meaning appears, not after the false read. A dead field left in place "but ignored" is a trap for the next reader: ignoring is a property of today's code, not of the data.

## Test the claim, not the routing

> Where a mechanism asserts a condition, assert that the condition is true when asserted. Tests that check the right inputs select the right branch all pass while the emitted sentence is false. A late mechanism is recoverable; a lying one is not. In anything that notifies, the failure that matters most is a false assertion at the highest-authority tier, because that tier is trained to act on what arrives.

## A mechanism under investigation stops talking

> A mechanism being examined for asserting false conditions is silenced while it is examined, or it keeps emitting into the record you are trying to read. Freezing the investigation is not freezing the subject.

## The ladder applies to operations

> Before ordering the heavy mechanism, ask which lighter one already covers it. Runtime configuration beats a rebuild. Reaching for the largest available action is the same reflex the ladder exists to interrupt, pointed at operations instead of code.

## A spawn's return value is not evidence its order arrived

> [Delivery is confirmed at the recipient's log](#a-message-is-delivered-when-it-lands-consumed-when-the-reply-addresses-it), and spawn adds two obligations. Prompt loss is invisible to its victim: the first instruction is the one that can vanish, the thread has no context to notice the gap against, and it idles indistinguishably from an ordered thread on every status surface. Delivery is not acceptance: a correctly refused malformed order idles exactly like a finished one. The check is that a valid order was accepted and its [owed outcome](#delegation-return-path) is pending or reported. A thread that spent its startup exploring unprompted is not reusable as a cold reviewer: archive it and spawn again.

## A dispatched lane is seated by its dispatch prompt

> A lane dispatched with a work prompt is seated by that prompt: the dispatcher must include the complete role brief in it. Plugin role-brief delivery is supplementary and can never seat a first turn — the `thread.created` callback observes a completed creation and delivers at a later turn boundary at best. A dispatcher that omits the brief has made a dispatch defect, not delegated seating. The succession path's `deliverSucceededSeatBrief` supplements succession; it does not replace the role brief in a lane-dispatch prompt.

## A check that agrees with nobody is a plumbing suspect

> When your check contradicts two independent verifications, audit your check's wiring before reporting the claim false — wrong test-name filters, dist-compared-to-dist, and exit codes swallowed by pipes all print confident results in a sound check's words. Disagreement is a triage signal about where to look first, not proof either way. Agreement is not proof either — roles can reuse one broken mechanism; counting agreement measures votes, not evidence. The bar remains [discriminating](#proof-must-discriminate), mechanism-independent evidence.

## A fix to an observable surface verifies itself in production

> Where the surface can be observed safely, with authority, and without provoking the failure, the fix is not confirmed until that surface shows the correction in production — one read after deploy is the difference between believing the mechanism works and having watched it work. Where observation would require a destructive act, an external notification, a security-relevant path, or reproducing a rare failure, do not stage it: say plainly what was confirmed in test and what remains unobserved in production.

## Label the proof class, because a safety test is not a discrimination test

> A test that passes both before and after a change is not evidence the change did anything — but it can be worth keeping as a guard on an invariant. Say which one it is: presenting a guard as discrimination inflates the evidence; discarding it because it does not discriminate loses a real check.

## A fix must not weaken the check it fixes

> The protection the fix was not meant to remove must survive it — by preservation or by replacement, deliberately and said out loud. The canonical precedent is [#237](https://github.com/pixexid/bb-collab/pull/237): spill path added, cap dropped. A bound can be genuinely wrong and need relaxing — #237 itself relaxed a false refusal, rightly. What is forbidden is losing a protection as a side effect of fixing what it failed to catch.

## Where an order's input crosses a trust boundary, its protections are not optional

> The author-side of the rule above, bounded to that case: a protection guarding the boundary that caller-controlled input crosses is mandatory and is stated in those words in the order. Not every scalar needs a ceiling; what is mandatory is the boundary protection. If a lane's defect traces to a permissive brief, name which part is the order's fault before asking for the fix — it is not a moved goalpost when the order admits its own error.

## Worked example: a constraint is not a bound until you check the violating path

> Finding a real constraint and reasoning from it to a limit is not establishing the limit: check the constraint against the code path that would violate it — two real far-apart events once satisfied a citation that nothing bound to *that request*. Match the flagging language to what was established: "unestablished-and-worried", not "implicit and fragile".

## A check written against an assumed shape has never been tested

> Before trusting a check, exercise it against a captured instance of the shape it must catch and a captured instance of the near-miss it must tolerate; confirm it fires on the first and stays silent on the second. Captured means taken from the mechanism, not imagined from a model of it; a fixture recording a real payload counts, staging a live failure to satisfy this does not.

## A written warning is not a mechanism

> Where a rule can be enforced by something that runs, prefer that to something a reader must remember — a brief said "don't commit rebuilt artifact metadata", the lane did it anyway, and the freshness gate stopped it; the brief and the gate said the same thing and only one of them worked. This is a preference about where to spend effort, not a claim instructions are worthless: the gate exists because someone wrote the rule down first.

## A test that injects a guard's answer does not cover that guard

> Injection is ordinary and often proves plenty — supplying page responses while executing the real pagination loop is genuine evidence about that loop. The narrow failure is injecting the answer of the very guard whose correctness is being claimed: the suite then exercises the fixture instead of the guard. Before citing a green test as coverage of a guard, name the guard's own code path and say whether the test executed it.

## Coverage is an epistemic state

> Do not report armed until the persisted eligible-thread inventory has been reconciled; unreadable inventory is blind and loud. Keep unobserved, unreadable, and known outcomes distinct: a partial detector names the population it cannot cover and why, instead of presenting partial coverage as fleet-wide certainty.

## A caller-controlled check is not a check

> When the caller controls every input a check uses, it cannot establish the property it claims to check. A digest over public row fields is decorative against a writer who chooses all of them.

## Fallback-only routing observability is blind to uniformity

> A routing signal that only records fallback cannot observe a path where no decision was made; the instrument and the failure are disjoint.

## Spawn flags are a choice, not a template

> Spawn flags record a routing choice, not a reusable template; the note explaining them is the evidence that a choice was made rather than inherited. If the note is hard to write, the routing is wrong.

## A rebase invalidates a head-bound approval

> An approval bound to a pre-rebase head is evidence about a head that no longer exists. A clean merge is not semantic equivalence — tests can auto-merge without conflict and still be semantically wrong. Re-run the checks that exercise the changed surface.

## A reconstructed mutant head is evidence-class reduced

> A head rebuilt from context after a self-reverted mutant proves the reconstruction is self-consistent, not that it is the work. Keep scratch commits or a stash as mutant restore points so the tested head remains identifiable.

## A migration cannot pin a live population

> A migration that pins a population number is wrong about the population by the time it runs; a count copied from an earlier read is not the population at migration time.

## An active-thread tell is not a durable send

> A tell into an active thread has returned success while the message landed in neither the event log nor the queue. Verify delivery at the recipient's log, never at the sender's send result.

## An unexercisable capability is an unexploded claim

> A capability that cannot be exercised through a sanctioned path is not dormant value; it is an unexploded claim on the record. An API or field's existence is not evidence of coverage when no sanctioned path can exercise it.

## Report the term that governs the latency

> When two terms govern a latency, change and report the dominant one; moving the minor term and reporting in the major term's units is a check answering the wrong question.
