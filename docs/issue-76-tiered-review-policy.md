# Issue #76: tiered review policy
> Status: The assignment subsystem and lane watcher contract were removed. The assignments table remains as a schema vestige pending consumer enumeration in #192; execution_attempts remains unchanged.


Status: adopted process policy on top of the existing review and Assignment
evidence seams. This is the fresh replacement for the blocked dependency lane.

## Rule

Derive the review tier from touched surfaces. Every pull request body declares
one tier with `Review tier: A`, `Review tier: B`, or `Review tier: C`.

- **Tier A:** authority/provenance, canonical DDL/lifecycle, operator
  receipts/approval, spend, concurrency/atomicity, migration/cutover, or
  review/release policy, including tracked runtime artifacts. Require an
  independent cold review of the exact candidate head before merge.
- **Tier B:** features or refactors with no Tier-A contact. Merge after local
  verification and CI. Run cold review post-merge in parallel; turn findings
  into follow-up work unless a confirmed serious defect requires revert.
- **Tier C:** documentation, mechanical edits, or additive tests. Use local
  verification and CI only; no cold review is required.

The next unrelated lane may start while a Tier-A review runs. Only the Tier-A
candidate's merge waits for its review. A wrong declaration is a review
finding, even when the declaration check and CI are green.

## Existing mechanisms and proof boundary

The stateless `scripts/check-review-tier.mjs` check validates PR metadata and
touched paths through the existing GitHub Verify workflow. It does not create
queue records, canonical state, receipts, schema objects, cached-consumer
versions, or a second authority store. Tier-A and Tier-B cold review evidence
continues to use the existing exact-head Assignment/ExecutionAttempt path.

Inspection against the fresh #77 base found no canonical store, receipt,
schema, or cached-consumer contract change required for #76; no contract or
schema bump is owed. The #77 cap remains the explicit per-orchestrator
`writingLaneCeiling`, default/max 3, with reviews and probes outside the cap.

## Validation

`tests/review-policy.test.ts` proves the required declaration, derives C for
docs/tests, B for ordinary feature code, A for an authority seam, preserves
the A/B/C merge timing rules, and leaves wrong-tiering as a review finding.
