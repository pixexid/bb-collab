# Project registration and bootstrap

`bb collab register-project` is the named bootstrap seam. It accepts only the
fields in `registerProjectRequestSchema` and delegates to the existing
`bootstrap` resolver; it does not create an actor receipt or infer a project
from the current checkout.

```sh
bb collab register-project --project PROJECT_ID --request '{
  "projectId": "PROJECT_ID",
  "idempotencyKey": "register-UNIQUE-ATTEMPT",
  "actorReceiptId": "VERIFIED_ACTOR_RECEIPT",
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
project and repository identities, config, idempotency key, and verified actor;
unknown fields, missing fields, duplicate target IDs, malformed config, secret
values, and foreign config mappings refuse before a write. The RPC equivalent
is `registerProject` with the same input object.

An `OK` result includes `currentConfigRevision: 1`,
`currentGovernanceEpoch: 1`, exact target digests, the fence token, and a
canonical mutation receipt. Repeating the exact request returns the same
receipt with `replay: true`; reusing its idempotency key for different content
returns `IDEMPOTENCY_KEY_CONFLICT`. A missing or foreign actor returns a typed
refusal. The seam never mints authority, writes a production project during
tests, or calls GitHub.

## Minimum safe Phase-3 tenant-binding sequence

1. Resolve the native BB project, source, host, and any managed environment;
   retain their exact IDs and verify that the source belongs to the project.
2. Run `register-project` once with the exact caller-supplied `projectId`,
   target, immutable config, and authorized actor receipt.
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
