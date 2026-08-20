# GH-228: execution-profile provenance

## Recommendation

Adopt option 1 in two platform-gated phases. Rename the stored profile to
`requested_*`, including its digest and every qualification, eligibility, and
role-generation digest consumer. Do not add or populate executed fields
until BB exposes an authoritative executed-profile fact. When that surface
exists, add separate executed fields and fail closed when they are absent.

Keep the existing fallback refusal and exact request/accepted/started/completed
correlation chain. They prove that the request reached one completed provider
turn and reject the one observable divergence, `provider/modelFallback`; they
do not turn `client/turn/requested` into executed evidence or detect quiet
substitution.

This is the only option that makes the schema answer one question per value.
It also prevents a future executed tuple from being written over, or compared
as though it were interchangeable with, the historical request tuple.

## Measured live population

Read from the live canonical store on 2026-08-19. A row counted as populated
when any of the four subject columns was non-null; in this population, every
such row had all four non-null.

| Origin | Rows | Rows with subject `actual_*` values | Interpretation |
| --- | ---: | ---: | --- |
| `work_item` | 64 | 0 | Reconstructed attempt history; it observed no profile |
| `role_holder` | 4 | 4 | Live role-context recording path |
| **Total** | **68** | **4** | 64 of 68 rows (94.1%) are backfilled and empty |

There are no `assignment` or other-origin rows in the live population. The four
populated attempts have three distinct profile digests. Those digests currently
join six qualification observations, four role generations, and three
eligibility projections. The migration population is therefore small, but the
populated rows are load-bearing authority evidence rather than low-value
history.

The count is reproducible with:

```sql
SELECT origin,
       COUNT(*) AS rows,
       SUM(CASE WHEN actual_model IS NOT NULL
                  OR actual_reasoning_level IS NOT NULL
                  OR actual_permission_mode IS NOT NULL
                  OR actual_service_tier IS NOT NULL
                THEN 1 ELSE 0 END) AS populated
FROM execution_attempts
GROUP BY origin;
```

## Digest blast radius

The stored names are not independent labels. `resolveRoleContext` hashes the
profile tuple into `profileDigest`; the same digest is stored or propagated as:

- `execution_attempts.requested_profile_digest` (renamed from `actual_profile_digest`);
- `qualification_observations.requested_profile_digest` (renamed from `executed_profile_digest`);
- `eligibility_projections.requested_profile_digest`, including its primary key;
- `role_generations.holder_requested_profile_digest`.

Historical role-holder `attempt_digest` values cover that value under the
legacy `actualProfileDigest` key and also cover the holder-context digest. Qualification
evidence, observation, eligibility-derivation, mutation, and receipt digests
then cover the profile digest or records containing it. A migration must treat
this as one digest graph. Renaming only the leaf columns would leave executed
names and digest identities attesting request data.

Historical digests are not silently recomputed in place. The migration
preserves their bytes as the legacy request-derived digest shape, renames every
semantic consumer in the graph, and uses a request-domain digest
for new rows. The later executed fields must use a separately domain-tagged
digest even when the tuple happens to equal the request. This avoids making an
equal requested and executed tuple the same provenance claim.

### Option 1: rename to requested, add executed only with a platform fact

This has the largest visible rename but the clearest bounded migration. It must
relabel the four populated values and `actual_profile_digest` to requested names;
rename or type the qualification, eligibility, and role-generation digest
consumers as request-derived legacy evidence; preserve the existing four
`attempt_digest` values byte-for-byte; and update every verifier, export, receipt, and
projection that follows those digests. The 45 `work_item` attempts remain null
and must not be backfilled with invented profile data.

The later platform-gated phase adds a separate executed digest graph rather
than reusing the request digest. Until then, executed-profile checks return
unknown. This option is recommended because the migration cost buys truthful
semantics and a clean destination for authoritative evidence.

### Option 2: keep the names and add provenance

This still requires a migration. For the provenance to be authoritative, it
must be covered by `attempt_digest` and by a domain-separated profile digest;
otherwise the same digest can describe either requested or executed provenance
and the new column can drift without invalidating the existing claim. That
forces versioning or recomputation through the same qualification,
role-generation, eligibility, evidence, receipt, and projection chain as
option 1, while retaining misleading `actual_*` readers. It saves column
renames but not the hard digest work, so it is not recommended.

### Option 3: keep the schema and document it

This has no byte-level migration: `attempt_digest` and all profile-related
digests remain unchanged. That is also its failure. They continue to attest a
request-sourced tuple under executed names, and every uncorrected reader must
remember an exception that the schema itself contradicts. The fallback guard
makes the values accurate only in divergence cases BB can distinguish; it
cannot support an executed-profile claim in the quiet-substitution case. This
option preserves the defect and is rejected.

## GH-79 and GH-215

GH-79's conformance half does **not** unblock when the rename lands. It becomes
honest: requested-policy conformance can be checked, while executed-policy
conformance must report unknown. It unblocks only after BB supplies a distinct
executed-profile fact and the second phase records it. The design prevents a
false conformance pass; it does not manufacture the missing observation.

GH-215 likewise becomes achievable by the local schema design but is not
achieved by it. BB must first expose model, reasoning level, permission mode,
and service tier as executed facts distinct from the request. Populating the
future executed fields from the current event would merely restate GH-215 and
recreate GH-228 under new columns. Until the upstream surface in
get-bb/bb#1787 exists, those fields must be absent and the result unknown.

## Version and rollout decisions

The append-only migration moves `SCHEMA_VERSION` from 20 to 21 and keeps
`MIGRATIONS.length === SCHEMA_VERSION + 13`. Runtime `CONTRACT_VERSION` remains
22: cached-consumer freshness requires both schema and contract equality, and
an executed counterfactual proves that observations at schema 20 / contract 22
are refused 0/4 after the schema bump. The instruction contract moves from 33
to 34 because an old session would keep trusting a now-false executed-profile
claim, satisfying the rule's "keep trusting something now false" clause.

The governed cached-consumer rollout remains in its already-waived `unknown`,
0/4 state. GH-375 discharged the unrunnable rollout with direct probes because
GH-241 leaves no role-kind actor receipt able to authorize it. This migration
does not create that condition and does not claim to resolve it.
