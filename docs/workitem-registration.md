# Canonical WorkItem registration

Use the existing authorized apply path. It is a direct invocation, not a new
queue wrapper:

```sh
bb collab apply --project "$PROJECT_ID" --request '{
  "projectId": "'"$PROJECT_ID"'",
  "operationClass": "work_item_create",
  "idempotencyKey": "lane-<lane-id>-work-item-create-<unique-attempt>",
  "actorReceiptId": "<verified-actor-receipt-id>",
  "expectedConfigRevision": <current-config-revision>,
  "expectedGovernanceEpoch": <current-governance-epoch>,
  "expectedFenceToken": "<current-fence-token>",
  "repoTargetId": "<exact-repository-target-id>",
  "expectedResourceRevision": null,
  "workItem": {
    "workItemId": "<new-work-item-id>",
    "title": "<lane title>",
    "body": "<frozen lane brief>"
  }
}'
```

Replace every angle-bracket value with the current store facts for the
project. Do not use the currently running lane's thread as a substitute for a
verified actor receipt, and do not run this against `proj_a8zzfsx36j` from a
test or fixture.

The request envelope is defined by `applyRequestSchema` in
`src/foundation.ts`: `projectId`, `operationClass`, and `idempotencyKey` are
required; `actorReceiptId`, `expectedConfigRevision`, `expectedGovernanceEpoch`,
`expectedFenceToken`, `repoTargetId`, and `expectedResourceRevision` carry the
authorization and compare-and-set guards; `workItem` must contain exactly
`workItemId`, `title`, and `body`. `parseApplyRequest` rejects unknown or
mis-shaped fields. The resolver computes `mutationRequestDigest` from the
normalized request and records it with the mutation receipt; there is no
caller-supplied `digest` field.

The live CLI parses the JSON, requires `--project` to equal `request.projectId`,
then calls `applyLiveAuthorizedMutation` in `server.ts`. The create resolver
requires the current config, governor, verified actor receipt, exact repository
target, and `expectedResourceRevision: null`; it creates the WorkItem in
`proposed` state and returns the canonical mutation receipt.
