# Project registration and bootstrap

`bb collab register-project` is the named bootstrap seam. It accepts only the
fields in `registerProjectRequestSchema` and delegates to the existing
`bootstrap` resolver. A new tenant is authorized by a current source-tenant
governor claim and an adopted source Decision; the resolver atomically derives
a one-shot target genesis receipt and a distinct verified bb-collab operational
actor.

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
must be the current adopted disposition in that source tenant. The Decision
must also be `operator_only`, project-scoped (`repoTargetId: null`), and have
the exact immutable scope `{ operation: "cross_project_bootstrap",
sourceProjectId, targetProjectId, repoTargetId: null }` plus options
`{ rootOfTrust: "host_local_operator" }`. Unknown fields, missing fields,
duplicate target IDs, malformed config, secret values, foreign config mappings,
stale source fences, non-plugin source actors, unrelated Decision classes, and
wrong source/target/scope/options or unadopted Decisions refuse before a write.
The RPC equivalent is
`registerProject` with the same input object.

An `OK` result includes `currentConfigRevision: 1`,
`currentGovernanceEpoch: 1`, exact target digests, the fence token, and a
canonical mutation receipt plus the source governor, Decision, derivation,
genesis receipt, and distinct operational actor identities. The
`bootstrap_derivation_receipts` audit row binds one genesis receipt and one
operational actor to exactly one named target and source authority. The genesis
receipt is never the target governorship actor and `requireActor` rejects it for
every later mutation class; post-bootstrap mutations use only the returned
operational actor receipt. Repeating
the exact request returns the same receipt with `replay: true`; reusing its
idempotency key for different content returns `IDEMPOTENCY_KEY_CONFLICT`.
Reusing or retargeting a consumed derivation/genesis receipt refuses, and a
target conflict leaves the existing target unchanged. The seam calls no GitHub.
The v29 migration preserves a v28 target whose epoch-1 governorship still names
the genesis receipt: that legacy receipt remains usable only as the current
governor for ordinary target mutations, while the same receipt is always
refused as a bootstrap source. New derivations use the distinct operational
receipt. The generic `apply` RPC accepts this authority only through the exact
`registerProject` projection; target Decisions and other mutation fields are
rejected before the transaction.

The current root of trust is host-local operator control exercised through the
verified bb-collab plugin actor and adopted Decision. Host-issued operator
receipts from get-bb/bb#1541 are the preferred future root; when that surface
is available, bootstrap authority must be re-ruled before changing this seam.
The exact bootstrap Decision also persists the source project, current
governance epoch, fence, plugin actor receipt, and receipt digest as an
immutable authority-root binding; creation and later disposition must resolve
the same current root.

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

## Domain-scoped seat topology

The schema keys `role_generation_heads` by `project_id`, role, and configured
`domain_id`. Each domain declares its task classes and exact role profiles;
workers and reviewers additionally bind to exact repository targets. Existing
configs are represented by one append-only reserved `default` domain. The
role-context preflight still requires the holder thread and environment to
belong to the exact project, and domain is carried through role standing,
succession, WorkItems, attempts, waits, and watchdog keys. Capacity remains a
project-wide admission count while queue and diagnostic identity remains
domain-scoped.

## BenchBait first-cutover boundary

At the first BenchBait cutover, the current seat becomes the editorial-domain
Managing Editor canonical fact. The code-domain seat is a fresh generation;
code work remains held until exact qualification, domain route, project-wide
capacity, Doctor, and export proofs all pass. This section records a boundary,
not a deployment or a claim that the cutover has occurred.

## Stall Guard dependency and Phase-3 activation check

Stall Guard discovers tenants only from the canonical `project_config_heads`
inventory. For each exact project it rereads the active config revision and
repository targets, then binds queue-label inventory, canonical capacity and
lane evidence, waits, episode state, idempotency, and the current role-holder
wake route to that project. Missing, replaced, malformed, partial, slow, or
unavailable evidence is a project-local blind result and cannot authorize a
wake or alter another project's state.

Phase 3 may activate a tenant only after bootstrap has returned `OK`, doctor
and export are clean for that project, the current governorship and role
generations are established, and the Stall Guard two-project isolation,
capacity/wait contamination, and exact-head wake checks pass. Phase 0 itself
does not register a tenant, deploy, reload, or mutate an external repository.
