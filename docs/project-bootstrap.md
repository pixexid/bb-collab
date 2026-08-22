# Project registration and bootstrap

`bb collab register-project` is the named bootstrap seam. It accepts only the
fields in `registerProjectRequestSchema` and delegates to the existing
`bootstrap` resolver. A new tenant is authorized by a current source-tenant
governor claim and an adopted source Decision; the resolver atomically derives
the target's verified bb-collab plugin actor and records its genesis receipt.

```sh
bb collab register-project --project PROJECT_ID --request '{
  "projectId": "PROJECT_ID",
  "idempotencyKey": "register-UNIQUE-ATTEMPT",
  "bootstrapAuthority": {
    "derivationId": "DERIVATION_ID",
    "genesisReceiptId": "GENESIS_RECEIPT_ID",
    "sourceProjectId": "SOURCE_PROJECT_ID",
    "sourceGovernanceEpoch": 7,
    "sourceFenceToken": "SOURCE_FENCE_TOKEN",
    "authorizingDecisionId": "DECISION_ID",
    "authorizingDispositionSequence": 1
  },
  "config": {
    "permissionMode": "full",
    "visibility": "visible",
    "repositoryTargets": ["REPO_TARGET_ID"]
  },
  "targets": [{
    "repoTargetId": "REPO_TARGET_ID",
    "sourceId": "SOURCE_ID",
    "hostId": "HOST_ID",
    "path": "NATIVE_SOURCE_PATH",
    "remoteUrl": null,
    "defaultBranch": "main"
  }]
}'
```

`PROJECT_ID` must equal `request.projectId`. The caller supplies the exact
target identity, source authority identity, adopted Decision identity, config,
and idempotency key; the target actor receipt is not caller-supplied. The
source head must still be `target_active` at the supplied exact fence and epoch,
its governor actor must be a verified bb-collab plugin actor, and the Decision
must be the current adopted disposition in that source tenant. Unknown fields,
missing fields, duplicate target IDs, malformed config, secret values, foreign
config mappings, stale source fences, non-plugin source actors, and wrong or
unadopted Decisions refuse before a write. The RPC equivalent is
`registerProject` with the same input object.

An `OK` result includes `currentConfigRevision: 1`,
`currentGovernanceEpoch: 1`, exact target digests, the fence token, and a
canonical mutation receipt plus the source governor, Decision, derivation, and
genesis receipt identities. The `bootstrap_derivation_receipts` audit row binds
one genesis receipt to exactly one named target and source authority. Repeating
the exact request returns the same receipt with `replay: true`; reusing its
idempotency key for different content returns `IDEMPOTENCY_KEY_CONFLICT`.
Reusing or retargeting a consumed derivation/genesis receipt refuses, and a
target conflict leaves the existing target unchanged. The seam calls no GitHub.

The current root of trust is host-local operator control exercised through the
verified bb-collab plugin actor and adopted Decision. Host-issued operator
receipts from get-bb/bb#1541 are the preferred future root; when that surface
is available, bootstrap authority must be re-ruled before changing this seam.

## Minimum safe Phase-3 tenant-binding sequence

1. Resolve the native BB project, source, host, and any managed environment;
   retain their exact IDs and verify that the source belongs to the project.
2. Obtain the source tenant's current governor fence/epoch and adopted
   authorizing Decision through canonical reads, then run `register-project`
   once with the exact target identity and bootstrap authority bundle.
3. Run `bb collab doctor --project PROJECT_ID --json` and export the project;
   stop on any unknown, foreign, stale, or incomplete result.
4. Claim the next governorship epoch with the returned epoch and fence token,
   then establish each configured role generation through the existing
   actor-receipt-gated `qualification_observation_record` and
   `role_generation_succession` requests.
5. Bind work only after the project, current config, governorship, role heads,
   and exact repository target all agree. Do not deploy, reload, create
   external projections, or mutate the amiga repository as part of bootstrap.

## Seat topology proven by the runtime

The schema keys both `project_governorship_heads` and
`role_generation_heads` by `project_id`; `roleRequirementSchema` makes the
director and project-orchestrator project-scoped. The role-context preflight
also requires the holder thread and environment to belong to the request's
exact project. Therefore the current runtime does not support one native
director thread holding multiple tenant governorships. Use one project-scoped
director and one project-scoped orchestrator per tenant; worker and reviewer
seats bind to that tenant's exact repository targets. The isolated second-tenant
test in `tests/server.test.ts` bootstraps two projects, preserves the first
export, and establishes all three configured non-director role generations for
the second.
