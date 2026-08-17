# ADR 0002: Contract v17 — director/orchestrator role split

Status: accepted. Implements stated operator direction of 2026-08-16. The
director and project-orchestrator are separate roles with independent
succession; this contract change creates neither a live role holder nor a
paired succession action.

Supersedes: the contract v14 director-seat placement under the
`project-orchestrator` role, the contract v15 current-generation exemption
attached to that placement, and the already-shipped v16 witness-holder
refusal as the immediately preceding contract.

## 1. Context

Defect GH-114: the live gen-2 `project-orchestrator` record binds an
archived GH-72 handoff-witness thread (`thr_pd39icjc8x`) instead of the live
director seat (`thr_gsb7m77ciz`). The witness-refusal fix (GH-117) prevents
recurrence. Supervisor adjudication (2026-08-16) then ruled:

- The gen-2 record stays retired-but-readable, SUPERSEDED, never mutated;
  its value is forensic.
- The intended correction (bind the director seat canonically) is
  UNREPRESENTABLE in config revision 3: `director-seat` is a requirement
  under `project-orchestrator`, which resolves exactly one holder, while
  director and orchestrator are two live seats. A model that cannot
  represent two live seats is nonconforming to the operator's stated
  direction of paired succession.
- The staged config amendment `pint_vcs2kjeux3` (adding director-seat under
  the old role shape) is HELD; revision 4 introduces the requirement under
  the new role in one coherent step.

## 2. Decision

Contract v17 splits the director into its own logical role.

- `ROLE_IDS` admits four logical roles: `director`, `project-orchestrator`,
  `worker`, `independent-reviewer`. `director` is project-scoped with zero
  writing-lane capacity. Scoping rules otherwise unchanged.
- The `director-seat` role requirement migrates from role
  `project-orchestrator` to role `director`. Its executed profile
  (`pi/kimi-coding/k3/high`, full/default/visible) and its exact Opus-medium
  standby profile are unchanged. The standby carries no authority, lease,
  assignment, dispatch target, or traffic, as before.
- First-generation exemption: the v15 current-generation exemption is
  superseded by a v17 first-generation exemption scoped to the NEW role.
  Qualification recording and the first-generation creation for role
  `director` generation 1 may use the approved unmanaged canonical
  environment only for holder `thr_gsb7m77ciz`, environment
  `env_3znzsxb7ce`, and source `src_x8veidmpik`. The exemption admits no
  writing, no succession beyond generation 1, no foreign or stale contexts,
  and no future generations; every later `director` generation requires the
  existing managed, isolated worktree and exact source/environment checks.
- The orphaned `project-orchestrator` generation 2 (witness-bound) is not
  migrated, repaired, or mutated. It remains readable and is operationally
  retired by the orchestrator's own natural succession under the existing
  rules.
- `CONTRACT_VERSION` becomes 17 and `contractDigest` changes
  (roleCapacityPolicy roleIds/scoping, directorSeatPolicy role reference,
  exemption shape). `SCHEMA_VERSION` remains 11; schema, migrations,
  and the approver registry are unchanged. `config_revision` additionally
  requires the exact current `approverAttestation`-derived plugin actor bound
  to its operator receipt; a verified but unlinked actor, including a role
  actor, refuses before any write.
- Cached-consumer bump test: enumerate all four cached consumers; each
  rereads contract v17 or refuses v16; record expected=4 attempted=4
  verified=4 and emit a durable rollout receipt. Zero-work is not success.

## 3. Consequences

- The director first-generation creation runs as instrumented drill zero:
  null predecessor, the existing `role_generation_succession` machinery, the
  full graded evidence set (executed profile from the execution event, exact
  environment/source identifiers, mutation receipt and idempotency key,
  holder-state resolution proof, witness-refusal firing proof, zero tells on
  the retired seat). It is single-seat and does not count toward the paired
  cycles. It remains receipt-gated; the qualification observation it cites
  is a fresh receipt-gated recording (prior observations expire and expiry
  is inert to existing records — foundation.ts:274/:295, :5610-5613,
  :5687/:5692).
- Known execution risk for drill zero: the bounded native reader window
  (256 events) does not cover the director thread's history (5413 events);
  the evidence path (explicit native event citation vs reader window) must
  be settled before the receipt boundary, without weakening correlation
  refusal.
- After revision 4 lands cleanly, the parked `pint_vcs2kjeux3` interaction
  must be explicitly DISMISSED (console action; operator or supervisor).
  The director seat reports when revision 4 is clean; the dismissal itself
  is not a fleet act.
- Naming: drill records say "director first-generation creation", never
  "gen-3 succession".
- Code surface: `ROLE_IDS` (foundation.ts:15), roleCapacityPolicy and
  directorSeatPolicy in contractDigest (:727+), the director-seat
  superRefine checks (:1145-1163), the exemption schema (:1112), and the
  bump test including a persisted discriminating policy test proving stale
  v16 consumers refuse.

## 4. Later corrective history

Contract v18 did not revise this director/orchestrator decision. It corrected
the rollout assembler so its four consumers are real production paths: the
registered RPC `doctor` handler, CLI `doctor` dispatcher, and two named
live-project stale-policy clone validations. Contract v19 supersedes its receipt
currency with the provenance-marker rollout: the v19 receipt alone is current;
v18 or missing evidence is unknown. See [ADR 0003](0003-cached-consumer-rollout-repair.md).
