# bb-collab / llm-collab migration ledger

Audit date: 2026-08-13 (America/Los_Angeles). This is a read-only disposition
report. No GitHub issue, task, repository document, branch, PR, or project state
was created, edited, closed, or transitioned.

## Scope and live authority

- Source repository: `pixexid/llm-collab`, exact source fence and clean local
  authority `f988d9711d3778f751e4ec0e32ebbf7b0893c80f`.
- Source reading: current `AGENTS.md`, `README.md`, `docs/multi-project.md`,
  `docs/workflows/README.md`, `session-startup.md`,
  `collab-thread-quickstart.md`, `orchestrator-sessions.md`,
  `task-intake-and-delegation.md`, `bb-workers.md`, and
  `bb-native-cutover-runbook.md` at that fence.
- Open source issue query: live GitHub `is:issue state:open` for
  `pixexid/llm-collab`; 40 issue records. Open PR #824 is not an issue and is
  excluded from the 40; it references #774 and is not merged, so #774 remains
  open. The query was made against GitHub, not a cached issue list.
- bb-collab documentation was read from current `main` commit
  `6ac879620be1f051a8a0c873776728e745480c18`:
  - founding ADR blob `9971a21ab04ee0451f887e9700efd4981e236438`;
  - import manifest blob `b9f5f0a399da5705ed1c2aa610fd9e214834c98d`;
  - roadmap blob `76fcadb38a6094eb5be5ec73f8d9a9fc4b31461c`;
  - `AGENTS.md` blob `56df822ab67aeac9ce6d8dfd96d9f9a0d092f994`.
- Current bb-collab issue-only ledger: 14 issues, one open (#5) and 13
  closed (#1, #3, #4, #7, #8, #10, #13, #15, #17, #18, #21, #22, #23).
  Pull requests are not counted as issues.

The governing rule is distill-and-migrate: carry surviving invariants, typed
evidence, and probes into the one bb-collab authority; do not fork or bulk-copy
llm-collab mechanisms. One collab governs one project. Until a project is
actually cut over, llm-collab remains the maintenance authority for its legacy
runtime, source contract, state, and operational tooling.

Disposition meanings used below:

- `MIGRATE`: a surviving mechanism or invariant belongs in bb-collab, either in
  an existing contract/issue or in a proposed missing BB-native roadmap item.
- `LEGACY-STAYS`: source-runtime maintenance, project-state handling, or
  evidence remains with llm-collab until the affected project cuts over.
- `CLOSE-OBSOLETE`: the open source issue as a whole is superseded; preserve
  only the explicitly surviving distilled evidence or proof.
- `DUPLICATE-ALREADY-MIGRATED`: the surviving mechanism is already represented
  by the founding contract, roadmap, or closed bb-collab issue; do not open a
  second successor seam.

## Disposition counts

| Disposition | Count |
| --- | ---: |
| MIGRATE | 12 |
| LEGACY-STAYS | 21 |
| CLOSE-OBSOLETE | 2 |
| DUPLICATE-ALREADY-MIGRATED | 5 |
| **Total open llm-collab issues** | **40** |

## Open llm-collab issue ledger

Every current open llm-collab issue is listed exactly once.

### MIGRATE

- [GH-755 — glm-5.2 re-trial criteria: source-coordinate fidelity and reasoning-language drift, both graded](https://github.com/pixexid/llm-collab/issues/755) — **MIGRATE** — model-specific re-entry criteria distill into executed-profile qualification and evidence, not a model-branded authority rule. **Order:** after role qualification schema and before admitting a profile to a role. **Destination:** existing bb-collab #10 (qualification/RoleGeneration) and #15 (evidence); one generic qualification surface. **Cutover:** conditional only for a role that depends on this profile; not a global cutover blocker.
- [GH-784 — Harness is not identity: replace harness-named authority constants with descriptor-based identity behind a resolver](https://github.com/pixexid/llm-collab/issues/784) — **MIGRATE** — authority must resolve a project role and generation from typed provenance rather than provider, model, harness, or display strings. **Order:** before converting any authority consumer. **Destination:** founding ADR §3/§5/§6 and existing bb-collab #3, #10, #13, #15, #17, and #22. **Cutover:** Yes; this is a core authority invariant.
- [GH-787 — Role lease and epoch store: one supervisor lease, one orchestrator lease per project, monotonic epochs](https://github.com/pixexid/llm-collab/issues/787) — **MIGRATE** — split the v1 monotonic governorship/manual role-generation requirement from renewable lease and automatic-failover behavior. **Order:** v1 maps to roadmap steps 5 and 7; renewable leases wait for the first-adopter gate. **Destination:** existing #1, #3, and #10 for v1; proposed P5 for post-v1 leases. **Cutover:** Yes for the v1 fence/role proof; no for deferred renewable leases.
- [GH-788 — Capacity and failover controller: candidate selection, provider states, degraded safe mode](https://github.com/pixexid/llm-collab/issues/788) — **MIGRATE** — preserve explicit capacity observations and safe degraded behavior without letting a stale signal invent authority or silently downgrade a role. **Order:** after leases and first-adopter evidence. **Destination:** proposed P6; existing #10 remains the role/qualification seam. **Cutover:** No; explicitly post-v1.
- [GH-789 — BB bus adapter: project/role envelopes, acknowledgement, dedupe, promotion retargeting](https://github.com/pixexid/llm-collab/issues/789) — **MIGRATE** — carry only a possible BB transport adapter; the transport must not become a second message ledger or authority store. **Order:** after first-adopter evidence and role/epoch support. **Destination:** proposed P7; founding ADR §§2, 6, and 14 are the boundary. **Cutover:** No; custom transport is post-v1 and conditional on evidence.
- [GH-790 — Operator plugin profile and runbook: pinned manifest, role permissions, rollback path](https://github.com/pixexid/llm-collab/issues/790) — **MIGRATE** — preserve reviewed plugin version/permission/rollback evidence without allowing an adopted plugin to own governance state. **Order:** after the first-adopter gate, with #5 remaining the privileged-mutation prerequisite. **Destination:** proposed P4; existing #5 owns the BB-host operator receipt. **Cutover:** No; the manifest classifies it as post-v1.
- [GH-800 — Unify repo-target and candidate-head selectors for sanctioned review tooling](https://github.com/pixexid/llm-collab/issues/800) — **MIGRATE** — one exact project/repository-target resolver must distinguish writer base rules from read-only candidate-head review. **Order:** after exact target configuration and before native review attach. **Destination:** founding ADR §4/§6, existing #7 and #13, and proposed P2 for the live BB adapter seam. **Cutover:** Yes when the cutover uses candidate review or multiple repository targets.
- [GH-815 — Make claim_task preflight target the task's verified managed worktree](https://github.com/pixexid/llm-collab/issues/815) — **MIGRATE** — preflight must judge the task's exact verified environment and repository target, never a convenient canonical checkout. **Order:** after WorkItem/Assignment target binding and before activation/review. **Destination:** existing #7 and #13 plus roadmap step 10; proposed P2 supplies the BB-native environment evidence. **Cutover:** Yes for any project whose activation/review uses managed worktrees.
- [GH-818 — Make post-merge cleanup report exact blockers separately from preserved worktrees](https://github.com/pixexid/llm-collab/issues/818) — **MIGRATE** — cleanup must distinguish exact destructive blockers from preserved evidence and never turn an empty loop into success. **Order:** roadmap step 10 after assignment/review evidence. **Destination:** existing #13 and #22, with the founding ADR cleanup refusal contract; no second cleanup ledger. **Cutover:** Yes for a project using the cleanup gate.
- [GH-820 — Make claim_task release evidence select the task repository target](https://github.com/pixexid/llm-collab/issues/820) — **MIGRATE** — release evidence must bind to the task's exact registered repository target instead of a singular project fallback. **Order:** after #7 target projection and before release/closure. **Destination:** existing #7 and #22 plus roadmap step 10. **Cutover:** Yes for multi-repository projects; otherwise the source remains the maintenance owner.
- [GH-822 — Qualify DeepSeek V4 Flash and Pro on Pi; benchmark Pro against K3](https://github.com/pixexid/llm-collab/issues/822) — **MIGRATE** — a new provider/model is only an immutable executed-profile observation with a graded fixture, never catalog presence or a requested tuple. **Order:** merge with #755 under generic qualification; do not make it a model-branded founding issue. **Destination:** existing #10 and #13, with #15 evidence relations. **Cutover:** conditional on selecting these profiles; not a global blocker.
- [GH-823 — Make project preflight watcher_status failures carry actionable detail](https://github.com/pixexid/llm-collab/issues/823) — **MIGRATE** — a fail-closed refusal must retain bounded mechanism detail, not an empty diagnostic that cannot distinguish the cause. **Order:** with the conformance/preflight evidence seam, after exact target selection. **Destination:** existing #3/#18 doctor and export evidence, with proposed P3 fixtures; do not port a marker watcher. **Cutover:** conditional readiness evidence; not a separate global authority blocker.

### LEGACY-STAYS

- [GH-562 — bb as the adopted managed runtime adapter and operator workbench (adoption record + standing customization backlog)](https://github.com/pixexid/llm-collab/issues/562) — **LEGACY-STAYS** — this records llm-collab's runtime/workbench adoption and customization policy, not canonical bb-collab work state. **Order:** retain as source adoption evidence until the affected project cuts over. **Destination:** none; bb-collab owns native facts through its plugin boundary, while product/runtime extensions remain project-scoped. **Cutover:** No separate blocker; preserve the record for the handoff.
- [GH-565 — Worker profiles: one worker per task/thread, tiered by model capability and cost](https://github.com/pixexid/llm-collab/issues/565) — **LEGACY-STAYS** — model/cost routing policy is an orchestrator/runtime choice; bb-collab records requested versus executed profiles and qualification evidence but does not become a provider broker. **Order:** source policy remains active until a project extension and target role policy exist. **Destination:** evidence seams in existing #10/#13, no new core issue. **Cutover:** Conditional for projects using the tier policy; not a global blocker.
- [GH-703 — Cross-project unread backlog: 2,397 entries across 22 chats — disposition deliberately deferred](https://github.com/pixexid/llm-collab/issues/703) — **LEGACY-STAYS** — unread chat history is legacy state/evidence, not a new WorkItem or authority ledger. **Order:** freeze, retain by digest/location, and resolve during the affected project handoff. **Destination:** MigrationRun evidence/read-only legacy retention; no full chat replay. **Cutover:** No for target activation; source retirement still needs an explicit retention disposition.
- [GH-718 — bb_spawn.py --new-environment worktree can never succeed: environmentId is null until the worktree is provisioned](https://github.com/pixexid/llm-collab/issues/718) — **LEGACY-STAYS** — this is a live llm-collab BB adapter/provisioning defect and the manifest requires a current-version probe before encoding a workaround. **Order:** run the cheap compatibility probe before P2 or any workaround. **Destination:** no direct successor until the probe proves a missing BB capability; P2 is the only possible BB-native follow-up. **Cutover:** Yes only for a lane that needs new managed-worktree provisioning; not a universal blocker.
- [GH-726 — Multi-project separation on the bb workbench: invariants, per-seam decisions, and test matrix (umbrella)](https://github.com/pixexid/llm-collab/issues/726) — **LEGACY-STAYS** — the umbrella verifies current llm-collab project-scoped registries, inboxes, hooks, and state trees; it is not a second bb-collab authority. **Order:** finish affected source seam proofs before freezing that project. **Destination:** target invariants already exist in founding ADR §§2–5 and closed #3/#7/#18; retain the source test matrix in llm-collab. **Cutover:** Yes for a project with unresolved cross-project source seams; no new target issue.
- [GH-751 — AX/app-preference instructions surviving in prose — stragglers (maintenance stream, not a lane)](https://github.com/pixexid/llm-collab/issues/751) — **LEGACY-STAYS** — this is source documentation hygiene for the conditional AX fallback, not a bb-collab authority mechanism. **Order:** correct or retire the source prose before source retirement. **Destination:** none; the target uses BB as the normal surface and preserves only app-exclusive conditions. **Cutover:** No for a BB-only cutover; conditional if the affected source docs remain in the operational path.
- [GH-760 — Operator-routing prose after v22: maintenance stream, not a sweep — the boundary is not pattern-decidable](https://github.com/pixexid/llm-collab/issues/760) — **LEGACY-STAYS** — current operator-only boundaries belong to the llm-collab contract and its cached-consumer rollout, not a duplicate target prose store. **Order:** reconcile source docs against `AGENTS.md` before freezing the source. **Destination:** none; bb-collab has its own operator policy in ADR §12. **Cutover:** Yes for source freeze/retirement safety, but not a missing BB-native implementation.
- [GH-763 — post_merge_cleanup.py aborts on a dead worktree registration instead of skipping it loudly](https://github.com/pixexid/llm-collab/issues/763) — **LEGACY-STAYS** — the failing process is llm-collab's cleanup tool; its source fix must remain one seam and loud about dead registrations. **Order:** before relying on the source cleanup gate for the handoff. **Destination:** no separate target issue; the target contract is carried by #818 and ADR §7. **Cutover:** Conditional on using this source cleanup path; not a universal target blocker.
- [GH-771 — Inline doc checks are the wrong shape: eval-log snapshot breaks on lane-keyed rows, version probe is unbounded](https://github.com/pixexid/llm-collab/issues/771) — **LEGACY-STAYS** — these are source workflow-check shape defects, and the retired checks must not be bulk-copied into bb-collab. **Order:** resolve or demote them before the source contract claims those checks. **Destination:** none; target evidence uses its own bounded doctor/receipt contract. **Cutover:** No direct blocker; source documentation must remain truthful.
- [GH-773 — Decision: reasoning-level enforcement at plan_spawn is refused for now — v17's ungated explicit path stands](https://github.com/pixexid/llm-collab/issues/773) — **LEGACY-STAYS** — this is a source routing/adjudication decision with a concrete revisit trigger, not a canonical target authority rule. **Order:** retain the ruling until its incident trigger or a new governed decision. **Destination:** existing #13 records requested/executed profile separation; no target enforcement issue. **Cutover:** No.
- [GH-774 — pr_watch settle gate accepts an empty-bodied review as 'review_seen' — it settles exactly when the pass is starting](https://github.com/pixexid/llm-collab/issues/774) — **LEGACY-STAYS** — the source watcher confuses a review container with terminal evidence; open PR #824 is not merged, so the defect is not current proof of closure. **Order:** source fix or explicit freeze before relying on that gate. **Destination:** target review truth is already expressed by #4/#22, but the source issue is not silently marked done. **Cutover:** Yes if the source review gate remains active; no separate target issue.
- [GH-780 — Contract rollout has no enumerate-consuming-projects step: v23's label requirement silently blocked two projects' entire backlogs](https://github.com/pixexid/llm-collab/issues/780) — **LEGACY-STAYS** — this is the llm-collab contract rollout procedure and project enumeration, not a second target queue. **Order:** enumerate and reconcile source projects before any source contract requirement is enforced. **Destination:** target conformance/ProjectConfig in #3 and ADR §§4/8; no copied label rollout. **Cutover:** Yes for applying the source contract safely; not a missing target feature.
- [GH-781 — A fully-blocked queue is indistinguishable from a healthy one: report refused-for-missing-state as a distinct count](https://github.com/pixexid/llm-collab/issues/781) — **LEGACY-STAYS** — this is source queue-health reporting around GitHub issue labels; labels are projections, not bb-collab authority. **Order:** source queue maintenance before affected project operation. **Destination:** no target issue; WorkItem state and typed refusals live in #7/#3. **Cutover:** No.
- [GH-785 — TLS capture does not state its own epistemics: a clean chain sampled after a real failure reads as a phantom failure](https://github.com/pixexid/llm-collab/issues/785) — **LEGACY-STAYS** — the forensic capture header explains the source diagnostic's timing and evidence ceiling; it is not collaboration state. **Order:** source diagnostic maintenance as needed. **Destination:** none. **Cutover:** No.
- [GH-798 — Mirror BB-environment orchestrator handoffs to canonical project state](https://github.com/pixexid/llm-collab/issues/798) — **LEGACY-STAYS** — the requested mirror is a host-side path into llm-collab project state and must not become a second authority. **Order:** preserve exact source handoff and ownership through the project freeze. **Destination:** MigrationRun evidence and source handoff retention; no bb-collab mirror store. **Cutover:** Yes for an affected project whose handoff is needed for succession; not a global target feature.
- [GH-799 — Remove the retired leading-positional watcher requirement after GH-779](https://github.com/pixexid/llm-collab/issues/799) — **LEGACY-STAYS** — the runtime matcher is already order-independent, but the stale belief remains in source contract prose and must be cleaned there. **Order:** source contract cleanup and cached-consumer proof before source retirement. **Destination:** none; do not create a target watcher requirement. **Cutover:** Yes for truthful source freeze; no bb-collab implementation block.
- [GH-807 — Update stale BB client fixture-version comment](https://github.com/pixexid/llm-collab/issues/807) — **LEGACY-STAYS** — this is a source test comment with no runtime or authority mechanism. **Order:** opportunistic source hygiene. **Destination:** none. **Cutover:** No.
- [GH-809 — Map native provider tool capabilities for BB workers](https://github.com/pixexid/llm-collab/issues/809) — **LEGACY-STAYS** — installed provider/tool listings are source qualification evidence and must not be turned into authority or unattended app control. **Order:** after source governance/profile lanes settle. **Destination:** bb-collab consumes bounded QualificationObservation evidence through #10; the matrix itself stays project/runtime policy. **Cutover:** Conditional on the project's chosen worker profiles; not global.
- [GH-814 — Define canonical TASK ID grammar before widening supervisor scope](https://github.com/pixexid/llm-collab/issues/814) — **LEGACY-STAYS** — `TASK-*` grammar is a source task-contract concern; bb-collab's WorkItem identity and typed ExternalWorkRef do not require copying that legacy syntax. **Order:** source task contract before any source scope widening. **Destination:** #7 WorkItem/ExternalWorkRef preserves legacy identifiers as references only. **Cutover:** No.
- [GH-816 — Encode the 2026-08-12 governance restructure in the tracked contract](https://github.com/pixexid/llm-collab/issues/816) — **LEGACY-STAYS** — this is a source contract/version rollout and spawn-surface change; the target founding contract already has its own role/delegation boundary. **Order:** reconcile the source contract and cached consumers before source freeze. **Destination:** no second target prose contract; #1/ADR §6 is the target authority. **Cutover:** Yes for source freeze/retirement safety, not a new target issue.
- [GH-817 — Harden release-closure watcher run selection, trigger refs, and timeout semantics](https://github.com/pixexid/llm-collab/issues/817) — **LEGACY-STAYS** — release watcher run identity/ref/timeout selection is source tooling; target stores exact release evidence but does not import this watcher implementation. **Order:** source release gate before relying on it for closure. **Destination:** ADR §7 and roadmap step 10 are the distilled target invariant. **Cutover:** Conditional when source release evidence is part of the affected project; no global target blocker.

### CLOSE-OBSOLETE

- [GH-85 — Epic: Make llm-collab a standalone, runtime-agnostic agent session bus](https://github.com/pixexid/llm-collab/issues/85) — **CLOSE-OBSOLETE** — the whole standalone-bus implementation premise is superseded by BB as the runtime and by bb-collab's one-plugin authority; preserve only the manifest's ratified clauses and evidence. **Order:** retain the source issue body as digestable historical evidence, then close after the surviving clauses are referenced. **Destination:** founding ADR, import manifest, and roadmap; no daemon, generic bus, watcher fleet, or second ledger. **Cutover:** No; its implementation plan must not be a cutover dependency.
- [GH-159 — Bind activation leases to unforgeable caller capabilities](https://github.com/pixexid/llm-collab/issues/159) — **CLOSE-OBSOLETE** — the source lease/caller-capability design is replaced by bb-collab's governorship epoch/token, typed actor, role generation, and single resolver. **Order:** close only after the stale/forged activation negative proofs in existing #3/#10/#13 are accepted. **Destination:** existing #3, #10, #13, and ADR §§5–6; no second lease authority. **Cutover:** No separate blocker; the successor proof is part of v1 cutover readiness.

### DUPLICATE-ALREADY-MIGRATED

- [GH-630 — Build a custom bb plugin supplying what the built-in plugins lack (single plan; supersedes 619/620)](https://github.com/pixexid/llm-collab/issues/630) — **DUPLICATE-ALREADY-MIGRATED** — the custom-plugin plan is already distilled into the bb-collab founding contract and closed foundation slices; retain native probes as conformance evidence, not a second plan. **Order:** use existing #3/#4/#7/#8/#10/#13/#15/#17/#18/#21/#22/#23 evidence. **Destination:** those existing issues and the import manifest. **Cutover:** No separate blocker; missing proof remains governed by the existing gates.
- [GH-686 — Canonical-write gate accepts a caller-supplied registry_revision without a currency check](https://github.com/pixexid/llm-collab/issues/686) — **DUPLICATE-ALREADY-MIGRATED** — the latent source seam is not reachable under current callers and its required current-revision behavior is already a typed bb-collab resolver invariant. **Order:** no source workaround; retain the audit as historical evidence. **Destination:** existing #3/#18 and ADR §§4–5. **Cutover:** No.
- [GH-786 — Epic: BB-native supervisor and orchestrator resilience (roles, leases, capacity, transport)](https://github.com/pixexid/llm-collab/issues/786) — **DUPLICATE-ALREADY-MIGRATED** — its umbrella/dependency order is already replaced by bb-collab roadmap step 14 and the separated #787–#790 distilled requirements; do not preserve its claim that llm-collab remains the durable authority for a cut-over project. **Order:** first-adopter evidence precedes the post-v1 work. **Destination:** roadmap step 14 plus proposed P4–P7. **Cutover:** No; the umbrella itself is not a v1 gate.
- [GH-812 — Add sanctioned read-only candidate attachment mode to bb_spawn](https://github.com/pixexid/llm-collab/issues/812) — **DUPLICATE-ALREADY-MIGRATED** — the candidate mode is explicitly folded into the single #800 selector seam and the target's exact candidate/Assignment contract; no second launcher or review authority. **Order:** #800/P2 after exact target binding. **Destination:** existing #7/#13 and ADR §§4/6, with the live adapter completion in proposed P2. **Cutover:** No separate blocker beyond the unified #800/P2 gate.
- [GH-813 — Encode dissolved-supervisor governance and depth-one worker subagents](https://github.com/pixexid/llm-collab/issues/813) — **DUPLICATE-ALREADY-MIGRATED** — the current role/delegation boundary is already absorbed into the founding contract and worker brief rules; a cached second supervisor contract or second spawn path is prohibited. **Order:** source-specific contract work remains #816; target behavior follows ADR §6 and existing #10/#13/#17. **Destination:** founding ADR, `AGENTS.md`, and the closed role/assignment slices. **Cutover:** No separate target blocker.

## Proposed bb-collab roadmap issues for missing BB-native work

These are proposals only; no issue was created. They exclude work already
represented by the current bb-collab ledger and exclude legacy llm-collab
maintenance. They are ordered by dependency.

### P1 — Complete MigrationRun and one-governor cutover proof for one project

**Dependencies:** existing #3, #7, #10, #13, #15, #17, #22, #23; upstream
bb-collab #5 must provide the non-forgeable operator receipt before privileged
activation.

**Paste-ready body:**

```markdown
## Goal

Implement roadmap step 11 for one project without copying llm-collab's
implementation or creating a second authority. The bb-collab plugin remains
shadow/read-only until every cutover proof passes.

## Acceptance

- export a deterministic logical manifest/records/artifact index/checksum set;
- import idempotently by source system, project, and export digest;
- inventory every sanctioned llm-collab mutator and exercise one refusal canary
  per mutation class;
- quiesce writers, freeze the source, rotate one shared CAS epoch/token, and
  prove no dual writer or projection path exists;
- prove exact keys, heads, holds, evidence, repository targets, projections,
  unresolved work, and event sequences equivalent before target activation;
- activate one target epoch, run one ordinary lane, and retain rollback and
  fix-forward evidence with the correct post-write boundary; and
- leave the source read-only with durable evidence rather than deleting legacy
  state.

## Boundaries

No raw database copy as the migration contract, bulk issue/task replay, second
queue/ledger, manual database edit, production mutation without the BB-host
operator receipt, or generic reverse migration promise.
```

### P2 — Activate one sanctioned BB-native managed-worktree and candidate-attach path

**Dependencies:** existing #13 and exact target/config seams; #5 for governed
activation; distilled source requirements #718, #800, and #812.

**Paste-ready body:**

```markdown
## Goal

Complete the one native BB execution path needed by Assignment/ExecutionAttempt
for a first adopter. Do not add a second launcher, bus, authority store, or
review mode.

## Acceptance

- a new managed worktree receives a verified native environment identity before
  attach, or refuses with a typed ambiguity/no-environment result;
- writer assignments retain the origin/default-branch ancestor rule;
- read-only review accepts an exact candidate ahead of the default branch only
  in an explicit read-only candidate mode;
- project, config revision, repo target, branch/base/candidate, environment,
  actual provider/model/reasoning, permission, visibility, first-action receipt,
  and terminal DONE|BLOCKED evidence are all exact and correlated;
- dispatch ambiguity becomes DISPATCH_UNKNOWN and suppresses blind retry;
- dirty, moved, foreign, missing, or ambiguous environments refuse before
  mutation; and
- the negative tests prove that removing each target/candidate/receipt guard
  fails the gate.

## Boundaries

Reuse the existing Assignment/ExecutionAttempt resolver and BB native facts.
Do not port bb_spawn.py wholesale, create a second transport, or grant a
read-only candidate attachment any write/task/queue/authority capability.
```

### P3 — Finish adversarial conformance doctor and first-adopter cutover gate

**Dependencies:** P1 and P2, existing #4, #21, and #22.

**Paste-ready body:**

```markdown
## Goal

Finish roadmap steps 12 and 13 as one bounded release gate for a quiet standard
one- or two-repository project.

## Acceptance

- the read-only doctor and explicit apply/verify report subject, mechanism,
  expected, attempted, and verified counts, including zero work;
- wrong project/repository, stale config, stale role, stale epoch/token,
  duplicate writer, missing execution receipt, connector silence, moved review
  head, dirty environment, projection drift, unmanaged activity, import/hash
  mismatch, canonical-store unavailability, and empty watcher detail each fail
  closed without mutation;
- one routine non-spend, non-production-migration WorkItem reaches exact-head
  review, release evidence, and closure;
- the run takes no more than four operator hours and requires no shared code
  edit, manual database edit, hand-built role file, bulk-label loop, watcher,
  or spawn exception; and
- every project-local extension gap is recorded without expanding the founding
  core.
```

### P4 — Post-v1: add a reviewed bb-collab plugin profile and rollback runbook

**Dependencies:** P3 and #5; source requirement distilled from #790.

**Paste-ready body:**

```markdown
## Goal

Define the reviewed operational profile for the full-trust bb-collab plugin
after the first-adopter evidence exists.

## Acceptance

- every plugin/version/commit is pinned and the exact BB/SDK compatibility is
  recorded;
- role permissions, visibility, secret references, install, upgrade, disable,
  rollback, and recovery paths are explicit;
- no adopted plugin owns WorkItem, lane, review, release, or authority state;
- the rollback path is exercised once with evidence; and
- privileged apply remains blocked unless the host-issued operator receipt is
  present and independently qualified.

## Boundaries

No token file, shared secret, account-switching automation, second authority,
or automatic model downgrade.
```

### P5 — Post-v1: add renewable role leases with epoch-fenced succession

**Dependencies:** P3; extends existing #10 and ProjectGovernorship rather than
creating another lease store; distilled future portion of #787.

**Paste-ready body:**

```markdown
## Goal

Add renewable leases only after first-adopter evidence proves a concrete need.
Keep logical RoleGeneration and ProjectGovernorship as the only authority
seams.

## Acceptance

- one governed lease mechanism records monotonic role epochs and expiry;
- stale, resumed, foreign, or replayed holders refuse before mutation;
- promotion and renewal are atomic, auditable, project-scoped, and idempotent;
- a lease failure cannot create a second current role head; and
- fixtures cover expiry, restart, promotion, stale action, and project crossing.

## Boundaries

No second lease database, heartbeat daemon, provider retry override, or
automatic authority invention before the explicit capacity/failover gate.
```

### P6 — Post-v1: add evidence-driven capacity and degraded-safe-mode control

**Dependencies:** P5; distilled future portion of #788.

**Paste-ready body:**

```markdown
## Goal

Replace a stalled qualified role only when exact capacity evidence and a
governed candidate decision permit it.

## Acceptance

- provider/account/machine capacity observations are separate from role
  identity and carry freshness and uncertainty;
- a stale or unknown signal never appears healthy;
- candidate selection is explicit and does not change an active Assignment's
  profile;
- no eligible candidate enters a degraded safe mode that permits only bounded
  existing work and read-only inspection; and
- failover drills prove both provider failure and no-candidate refusal.

## Boundaries

No silent model downgrade, self-promotion, automatic protected/irreversible
work, or capacity authority outside the canonical resolver.
```

### P7 — Post-v1: add an optional BB transport adapter without a second ledger

**Dependencies:** P3 and P5; distilled future portion of #789.

**Paste-ready body:**

```markdown
## Goal

Add a BB-local transport only if first-adopter evidence shows the existing
native path cannot carry a required collaboration envelope.

## Acceptance

- envelopes name exact project, role generation, assignment/message identity,
  correlation, and epoch;
- acknowledgement, dedupe, stale-role rejection, and restart reconciliation
  are typed and idempotent;
- project A cannot deliver into project B and ambient status cannot wake a role;
- transport failure remains evidence and never becomes authority; and
- delivery history is reconciled against the one canonical bb-collab store.

## Boundaries

The adapter is not a message ledger, queue, resolver, watcher fleet, daemon,
promotion authority, or reverse migration path. Do not copy llm-collab's
mailbox implementation.
```

## Top dependency chain

`bb-collab #5 operator receipt` → `P1 MigrationRun/shared one-governor
cutover` → `P2 native managed-worktree/candidate attach` → `P3 adversarial
doctor + first adopter` → `P5 leases` → `P6 capacity/failover`; `P4 plugin
profile` is parallel after P3/#5, and `P7 transport` is parallel after P3/P5.

The current bb-collab main branch is not cut over: production apply remains
`OPERATOR_AUTH_REQUIRED`, the plugin has not been installed/reloaded/activated
against live project authority, and the migration/first-adopter evidence is
not yet complete. This report records those facts; it does not change them.
