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

## External-party content uses the inbox

> Once the inbox tool is available to the session, actionable content intended for the operator outside the current conversation goes through `send_to_operator`; leaving it only in a turn output is a delivery defect.

The bound is the intended delivery path, not the word “operator.” A direct reply to an operator who is participating in the current conversation stays in that conversation; a lane receipt still goes to its named fleet return path; and decisions and evidence still land in their canonical stores. The same inbox surface carries messages addressed to the supervisor, while the existing `SUPERVISOR-REPORT` marker convention remains in force until its separately governed retirement.

If the tool is absent or refuses the send, report that failure through the existing return path. Printing the intended message and calling it delivered would repeat the defect the inbox exists to remove.

## Project-agnostic by construction

> New or changed surfaces that store, read, or route project-owned data require the exact `project_id` as an explicit dimension and never substitute an ambient, default, or hardcoded project.

Project boundaries apply on every write and read: a missing or null project never matches. The rule does not attach a fake project to genuinely global state, and it does not require a retroactive audit of untouched surfaces. It binds the project-owned behavior introduced or changed by the current work.

## Lifecycle disposition

Every pull request carries exactly one disposition line: `Closes #NN` plus `Acceptance: complete`, or `Related GH-NN` naming an OPEN issue, or `No issue:` followed by a reason. Run both canonical body gates before pushing: `scripts/pr-lifecycle.mjs` for disposition and `scripts/check-review-tier.mjs` for exactly one line matching its `Review tier` declaration pattern. Tier A is forced by any path matched by that script's `tierA` patterns, including its authority/approval/atomicity/concurrency/cutover/migration/provenance/receipt/spend keyword pattern; Tier C applies only when no Tier-A path matches and every path matches its `tierC` patterns. Because `dist/` is Tier A, a docs-only `docs/rules.md` edit that regenerates `dist/role-briefs.json` requires Tier A.

Commit messages carry no linkage at all unless the pull request closes an issue and the commit names that same issue with a closing keyword. A `Related` or `Ref` mention in a commit message fails the gate even when the pull-request body is correct, because the checker treats any commit-side mention that is not an exact closing match as a conflict.

## Platform check before you design

Before writing a coordination rule or a line of coordination code, enumerate what bb natively does in that area — from the actual docs, CLI help, and plugin API, not from memory. A native mechanism replaces building; prose that duplicates a native signal is a stale copy waiting to diverge. This is the ladder's "does the platform already do it" rung, made explicit: the check is step one of designing any coordination mechanism, not a review afterthought.

## One writer per lane

> One branch, one owner. Stakeholders coordinate by message; nobody opens a parallel edit of the same lane.

Check what is already assigned before dispatching. Keeping the fleet busy is not a reason to open a second writer on a surface someone already holds; an idle seat is cheaper than duplicated work.

## Off-matrix work stands on its evidence

> Off-matrix AUTHORING that later receives a valid matrix-qualified independent review stands on its evidence and is never re-run for provenance alone. The deviation is recorded in the pull-request body as it merged.

Discovering that an implementation lane ran on an unratified model, or at the wrong reasoning level, does not retroactively make its output wrong. The review and the tests still discriminate; re-running would cost real work to buy a receipt that says nothing they do not already say.

The rule stops at the gate. It does NOT extend to a review, a qualification, or a release artifact, because there the off-matrix work IS the gate and no later check stands behind it. An unqualified reviewer's thoroughness is not a substitute for qualification: [absent or contradictory qualification cannot satisfy a review gate](threat-model.md), and an executed-profile mismatch fails closed. A Tier-A review performed by a model the matrix does not admit for review leaves the gate unsatisfied however good the review was, and the remedy is a qualified review, not an argument about quality.

This cuts the other way too. "It worked out" is not ratification, and a good outcome from an unplaced model is evidence for a probe to weigh, never a substitute for one.

## A ruling disposes its own subordinate instances

> When the same pattern surfaces again below a ruling that already covers it, apply the ruling — but only when the instance falls inside the ruling's own stated subject AND inside the applying seat's existing authority. Uncertainty about either goes back up.

Re-asking a settled question costs a round trip and buys nothing, and it teaches the seat below to stop thinking at the first resemblance. But "the reasoning reaches this case" is the applying seat's own conclusion, and a rule resting on it alone is not a boundary — it is permission to expand quietly. Both conditions are required, and neither is satisfied by the seat finding the new case similar.

Inside the ruling's stated subject means the instance sits within what the ruling actually addressed, not within an extension the seat infers from its rationale. A model unratified for placement is still unratified when its name appears inside a row about something else — ratification-by-containment does not exist — so that instance is disposed. A question the ruling never reached is escalated even when the same reasoning would plainly settle it.

Inside existing authority means the act is one the seat could already take under its role and its current work order. A ruling does not enlarge a seat; it settles a question a seat was already entitled to act on.

Saying which ruling was applied is disclosure, not a guard — it makes the decision auditable afterwards and does nothing to bound it beforehand. The two conditions bound it; the disclosure records it. A seat owes both.

## Merge is not deploy is not reload

> A change is not live until a deployed revision CONTAINING it is what host supervision is running. The deploy layer is part of the change, not a step after it.

A merged PR changes what the repository says. It changes nothing about what is running until the deployed artifact is built from a commit containing it and whatever supervises it on the host is running that artifact. Those are three states, and reporting the first as though it were the third is the most comfortable error available.

The check is per-change and cheap: name the deployed revision, and establish that it contains the change and that supervision is on it. Equality with `main` is not the test — it proves a stronger claim than any single change needs, and it fails true ones. A deploy at `60e830a` really does have that revision's watchdog live even after `main` advances past it; demanding equality would call that claim false.

When the deployed revision does not contain the change, say so. "Merged, not deployed" is a complete and honest terminal status, and a fleet can act on it. Loading it on the host is an operator act; this rule governs what a seat may claim, not who may deploy.

## An escalation's premises are checkable claims

> Verify the MATERIAL premises before executing — the ones that, if false, change what the act does. Each needs an identified authoritative check; a material premise you cannot resolve goes back up instead of being assumed.

An escalation arrives with urgency attached, and urgency is exactly what makes its premises feel settled. They are not. A seat that executes on a relayed fact inherits it: if the fact was wrong, the act was wrong, whoever supplied the premise.

Material is the whole bound, and without it this rule is unfollowable and will be applied selectively after the fact. "These scripts were deleted from `main`" is material to an order to retire them, and one existence test settles it. The spelling of a reporter's name in the same message is not material and has no authoritative check worth running. Ask what the act becomes if the fact is false: if the answer is "the same act", stop checking.

A material premise with no authoritative check available, or one that can only be sampled and may have changed since, is not verified by trying harder. Name it as unresolved and return it upward; executing on it anyway is the defect this rule exists to stop.

It binds downward, where a frozen work order carries facts a lane cannot easily question, and the seat writing the order owes the checks. It binds upward too: a premise handed to a deciding seat determines what it decides, so handing up an unchecked material fact is the same defect wearing a different hat.

## A completeness search names its surfaces

> A completeness claim states which surfaces it searched and under which names, and the surfaces have to be the ones its own claim depends on.

A claim about current canonical state is complete from the canonical live surface, and archived material is irrelevant to it — going wider there would contradict [canonical source, no restated copies](#canonical-source-no-restated-copies).

A claim about whether something has happened before is different, and that is where live-only searching fails. Fleet history lives in threads, and threads archive. Issues and documents are the surfaces a seat reaches for first, and they are the ones least likely to hold the thing that already happened. Work that ran, decided something, and finished leaves its record where nobody is looking.

Search the concept's names, not one spelling. A thing renamed between its introduction and your search hides its own introduction: searching for the current name finds where it was made explicit, not where it began, and the gap is invisible because the search returns results.

State the surfaces and the names. "I searched" is not a finding; "I searched open issues, docs, and archived threads, for both X and its earlier bare form" is one a reader can check and extend.

## A candidate in production is a drill instrument with two stamps

> Unmerged code reaches the production deploy worktree only as a pre-authorized drill instrument, and the pull-request body records both the deploy and the event that ENDED the unmerged exposure. An exposure window without a documented end is an unaudited window.

Installing a candidate to prove it works is legitimate and sometimes the only way to prove it. What is not legitimate is leaving the record with an opening and no closing, because a reader then cannot tell a twenty-five-minute drill from code that quietly stayed.

A restore is the usual closing event and carries a reload stamp. It is not the only one: a candidate that is reviewed and merged while its exact SHA keeps running has ended its unmerged exposure without anything being reloaded, and that closure is auditable from git containment rather than from a stamp. Record whichever event actually ended it, and say which kind it was — demanding a restore stamp for a window that closed by merge would demand a stamp that does not exist.

Where the closing event is a restore, verify it independently of its own stamp — the deployed revision, the build artifact's mtime, and the absence of a string that exists only in the candidate. A restore claimed by the party that deployed is the claim most worth a second surface.

This says nothing about who may deploy. Host loading is an operator act; this governs what may be installed unmerged, and what the record must show afterwards.

## A recovery timebox starts at the observed failure

> A clock measuring RECOVERY starts at the first native observation of the failure, never at a scheduled or presumed start.

A recovery timebox counted from when the failure was supposed to happen measures the wrong interval, and if the failure never happened it manufactures a mechanism failure out of nothing. That enters the record as "the mechanism did not recover the seat in twenty minutes" when the true statement is "the seat was never in the failure state" — a false negative indistinguishable from a real finding.

This binds the recovery clock only. A drill may legitimately run other clocks from a scheduled start: an injection-phase timebox begins when the injector was supposed to fire, and its expiry is a real result — it proves the injection failed. Do not collapse the two. One clock asks whether the mechanism recovered the seat; the other asks whether anything broke it in the first place, and they start at different events because they measure different claims.

The same discipline that keeps a wake from being credited to the wrong signal keeps a clock from being counted against the wrong state.

## A seat is the worst witness to its own outage

> Liveness comes from native state, never from a seat's account of its own continuity. A seat's report about itself is a premise like any other, and a material one gets the authoritative check.

A killed seat cannot observe its own death. A recovered seat remembers working through its own outage, because the only account it can produce is generated by the process whose absence is in question — so "I was working the whole time" is not weak evidence of liveness, it is an artifact of the thing being asked about. From inside there is no signal at all.

This is the [premise rule](#an-escalations-premises-are-checkable-claims) applied where it is hardest to remember it applies. An inference about your own state feels like observation rather than inference, which is what makes it the last premise anyone thinks to check. When the question is whether a seat was reachable, alive, or interrupted, the answer comes from the native record and the seat's narrative is not admitted.

## Write for a stranger

> Every issue, pull request, comment and commit message on a public repository is written for a stranger's eyes. Credentials, private-project internals and personal data stay out of them, along with host details that map an environment rather than describe a reproducible fact.

Operator directive: public repo, write for a stranger.

Credentials means more than values. Locations, key names, shapes, lengths and ports are individually harmless and collectively a map, and the map is the thing worth withholding. Private-project internals means designs, schemas and business content; naming a project is unavoidable and fine. Host details means usernames, home paths and tooling layout — not the operating system, an architecture, a tool version or a loopback binding, which a reproducible bug or deployment record needs and which reveal nothing an attacker could not assume.

Where specifics are genuinely needed, the public artifact carries the abstract record and its disposition, and the specifics live in local durable state, referenced by id. That bound matters: an artifact still has to explain its own decision. An issue that cannot be understood without a credential-adjacent detail is a finding about the issue, not a licence to publish one.

Two techniques worth keeping, because both were learned the hard way. Both narrow a question; neither settles one, and stating which is which is part of using them.

A disclosure claim can be **checked by shape without re-disclosing**. Length distribution, character class and padding report whether *credential-shaped patterns* are present — not whether a secret is. A short passphrase, a PIN, or a value that looks like ordinary text passes a shape check untouched, so a clean result means "no conventionally-shaped credential found", never "no credential". Say which bound your check carried. The value of the method is that an auditor who reads the artifact to verify becomes another copy of the exposure, and shape avoids that.

A **live-versus-fixture** question is narrowed by looking for the value everywhere it would matter, rather than by reading the artifact that mentions it. Absence across the surfaces you searched is evidence about those surfaces at that moment — it does not prove the value is illustrative. It may be revoked, live somewhere you cannot search, or simply unknown. Treat a clean search as shifting the burden, not as a verdict, and name the surfaces per [completeness search](#a-completeness-search-names-its-surfaces) and the moment per [status read](#a-status-read-is-evidence-about-the-moment-it-was-read).

And when reading a credential file for any reason: ask for shape, not contents. A search for key *names* that prints matching *lines* prints the values too.

## Spawn against a fetched ref

> Dispatch against a base whose exact object you have just fetched and verified. A bare local branch name is not that unless you have checked it.

A bare `main` resolves to a local ref that lags silently. Eight merges behind in one evening: a scoping read cited matrix text that no longer existed, and a grader's worktree lacked the specification it was grading against.

The invariant is the object, not the spelling. A local branch fast-forwarded from upstream and confirmed at the exact SHA is a correct base; a remote-tracking ref nobody fetched is not. What the rule forbids is dispatching against a name whose current object you have not established.

A lane on a stale tree does not look stale. It reads files that exist, quotes them accurately, and reports confidently — no refusal, no error, nothing that reads as degraded. That is what makes it worse than a missing file.

This rule is scaffolding, not principle: it describes a workaround for a spawn surface that does not fetch. Delete it when the surface does.

## The no-dispatch reason is the second half of the intake check

> The wake asks whether there is capacity and startable work. The seat answers whether any of it is reachable, and the answer is recorded either way. An unanswered wake is incomplete, not silent.

`startable > 0 AND lanes < cap` is not the condition that decides whether dispatch is possible. Surface collision is, and no canonical source can compute it — the seat holding the lanes is the only party that can. So the collision map in a no-dispatch reason is not courtesy; it is the missing half of the check, supplied where it can be supplied.

A reason may point at a standing one. Restating an unchanged collision map every hour is noise, and this asks for an answer rather than a recital.

What this deliberately does **not** do is encode surface occupancy into the wake condition. That would require the mechanism to know which files a lane holds, which no canonical source can currently claim, and a confident condition on an unverifiable input is exactly how a permanently-true wake and a dead-source counter both happened. A wake that fires slightly too often, answered by a seat that states the map, is cheaper than a mechanism that computes collisions and gets them wrong in silence.

## A ruling names its seat and its surface

> Before ruling an act executable, name both the seat that will perform it and the surface it will perform it through. A ruling missing either routes upward or waits — it never routes to improvisation.

Naming a seat is not enough on its own: a named seat can lack a usable surface, and a named surface can be held by someone else. The pair is the check.

Twice in one evening a ruling named an act with no surface behind it. Setting the project's sticky spawn default has no command — `bb settings` exposes general preferences, experiments, keyboard, usage, version and reload, and nothing for spawn defaults; the only affordance is the app's model picker. A deploy was executable only because a repointable worktree happened to exist, which is availability rather than design. Both were discovered by a seat going to do the thing and finding no way — the expensive moment, because the work is planned and the lane is dispatched or about to be.

A third apparent instance was not one, and it is the more useful lesson. A ruling to create a project was reported unexecutable because `bb project` seemed to have no create command. It has one; the seat had read a truncated help listing and concluded absence from a list it had cut short. So this rule cuts both ways: name the surface, and establish it is really absent before saying so, because a false absence defers real work and a doctrine written on one carries the error forward.

The failure mode is not the missing surface. It is what a seat does next: the improvisation nearest to hand is usually the thing the ruling was trying to prevent, and it presents itself as the pragmatic option.

This rule met its first real case within the hour. A ruling to bootstrap a project into governance turned out to need an actor receipt that no shipped surface can mint — every production reference reads, only test fixtures write, and the ceremony that once minted them was deliberately removed. The improvisation available was inserting a receipt into the store by hand, which would have fabricated exactly the authority the resolver exists to verify and would have passed every check the system has. The gap and the temptation arrived together, and the temptation was the more dangerous half.

This is not detectable mechanically and should not be built. A ruling's named act lives in prose, not in canonical or platform state, so identifying it would mean interpreting text, and interpretation needs a model in a path that is deliberately model-free. It is a check made when the ruling is written, by the seat writing it.

Naming the seat and its surface is usually one line, and sometimes reveals that one of them is missing — which is the point, provided the absence is checked rather than assumed.

## Blast radius

> Every decision sweeps its own blast radius in the same act. Open issues, open PRs, and queued lane specs are caches of older decisions; a decision changing an artifact’s existence, owner, shape, or terminology invalidates them silently. Each affected item gets a one-line update or closure at decision time, not when someone trips over it. A sweep that names artifacts reads them; relayed labels are unverified by definition.

Closing an issue is a decision with blast radius: an open PR whose disposition line says `Related GH-N` fails its lifecycle gate the moment N closes.

A governance-level change — a severance, a contract bump, a matrix re-ratification — sweeps **before its pull request merges**, not afterwards. One severance left six issues describing mechanisms that no longer existed, four of them still labelled startable. The sweep is proportional to what the change touches: a bump that renames nothing and removes no mechanism sweeps nothing, and says so.

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

## A spawn's return value is not evidence its order arrived

> [Delivery is confirmed at the recipient's log](#a-message-is-delivered-when-it-lands-consumed-when-the-reply-addresses-it), not at your own send. Spawn is that rule's hardest case and adds two obligations it does not cover. First, prompt loss at spawn is invisible to its victim: the first instruction an agent would ever receive is the one that can vanish, so it has no prior context to notice the gap against, and the thread is alive, idle, producing output on whatever it finds, and indistinguishable on every status surface from one that received its order. Second, delivery is not acceptance. An agent can receive an order, correctly refuse it as malformed, and go idle looking exactly like one that finished — action, but with the delegated work undone. So the check is not that the text arrived, nor merely that the recipient did something, but that a valid order was accepted and its [owed outcome](#delegation-return-path) is pending or reported: `DONE`, `BLOCKED` or `WAITING`. A thread that spent its startup exploring unprompted is not reusable as a cold reviewer; archive it and spawn again.

## A check that agrees with nobody is a plumbing suspect

> When your check contradicts two independent verifications, audit your check's wiring before you report the claim false. Three times in one night the plumbing of a check, not its subject, produced the wrong answer: a test-name filter that selected a different test, a dist comparison that compared two build outputs to each other, and an exit code swallowed by a pipe. Each printed a confident result in the same words a sound check would have used. Disagreement is a triage signal about where to look first; it is not proof either way. Agreement is not proof either — roles can reuse one broken mechanism, and counting how many agreed measures votes rather than evidence. The bar remains [discriminating](#proof-must-discriminate), mechanism-independent evidence.

## A fix to an observable surface verifies itself in production

> Where the surface can be observed safely, with authority, and without provoking the failure, the fix is not confirmed until that surface shows the correction in production. A capacity field that reported hardcoded zeros is confirmed when the deployed system names the real lanes, not when a test asserts it would — one read after deploy, and it is the difference between believing the mechanism works and having watched it work. Where observation would require a destructive act, an external notification, a security-relevant path, or reproducing a rare failure, do not stage it to satisfy this rule: say plainly what was confirmed in test and what remains unobserved in production.

## Label the proof class, because a safety test is not a discrimination test

> A test that passes both before and after a change is not evidence the change did anything — but it can still be worth keeping, as a guard on an invariant that must not later break. Say which one it is. A test written to guard atomicity that also passes against the unfixed code proves the property holds, not that this work established it. Presenting a guard as discrimination inflates the evidence; discarding it because it does not discriminate loses a real check.

## A fix must not weaken the check it fixes

> Do not remove the bound the check enforced, do not write a guard that sees only the instance you were shown, and do not drop the cap the spill path was meant to replace. The cleanest phrasing came from a reviewer: *half the [#237](https://github.com/pixexid/bb-collab/pull/237) precedent — spill path added, cap dropped.* Three lanes in one night produced the same shape in three forms: array bounds deleted rather than the caller chunked, a leak guard hardcoded to the single word it had been shown, and a trust-boundary cap removed alongside the pagination that replaced it. Each fixed the symptom the test could see and weakened the check the test could not. A bound can be genuinely wrong and need relaxing — [#237](https://github.com/pixexid/bb-collab/pull/237) itself relaxed a false aggregate row refusal, and was right to. The rule is not that protection may never loosen; it is that the protection the fix was not meant to remove must survive it, by preservation or by replacement, deliberately and said out loud. What is forbidden is losing it as a side effect of fixing what it failed to catch.

## Where an order's input crosses a trust boundary, its protections are not optional

> The author-side of the rule above, and it is bounded to that case rather than to caller input generally. A brief that called a total-work ceiling "fine and probably wanted" made a mandatory protection optional on input the caller controls, and the lane that omitted it had followed the order. Not every constraint on ordinary input is mandatory and not every scalar needs a ceiling; what is mandatory is the protection guarding the boundary the input crosses, stated in those words. If a lane's defect traces to a permissive brief, name which part is the order's fault before asking for the fix — it is not a moved goalpost when the order admits its own error.

## Worked example: a constraint is not a bound until you check the violating path

> An application of [Proof must discriminate](#proof-must-discriminate) and [the material-premise rule](#an-escalations-premises-are-checkable-claims), not a new obligation — kept because the instance is instructive. Finding a real constraint and reasoning from it to a limit is not the same as establishing the limit. A cited completion event must exist and must follow the request, which is true — but nothing required it to be *that request's* completion, so a citation naming two real far-apart events walked hundreds of pages the constraint appeared to forbid. Check the constraint against the code path that would violate it, and match the flagging language to what was established: "implicit and fragile" reads as established-then-worried when the honest state was unestablished-and-worried.

## A check written against an assumed shape has never been tested

> A guard is only as good as the mechanism it actually observes. A reply-delivery confirmation waited for an event type that the transport never emits, so it recorded every successful delivery as a failure; a CSS leak guard matched an assumed substring rather than an observed class token, so it passed leaks whose names collided with unrelated source text. Both were written from a plausible model of the mechanism instead of a captured example of it. Before trusting a check, exercise it against a captured instance of the shape it must catch and a captured instance of the near-miss it must tolerate, and confirm it fires on the first and stays silent on the second. Captured means taken from the mechanism, not imagined from a model of it; a test fixture recording a real payload counts, and staging a live failure to satisfy this does not.
