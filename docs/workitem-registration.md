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
    "body": "<frozen lane brief>",
    "githubIssue": { "issueNumber": <existing-issue-number> }
  }
}'
```

Replace every angle-bracket value with the current store facts for the
project. Do not use the currently running lane's thread as a substitute for a
verified actor receipt, and do not run this against `proj_a8zzfsx36j` from a
test or fixture.

Read the current store facts through doctor:

```sh
export PROJECT_ID="<project-id>"
bb collab doctor --project "$PROJECT_ID" --json
```

The `evidence.workItemRegistrations` array contains one copy-ready guard object
per current repository target. Select the object whose `repoTargetId` is the
exact target for the new WorkItem; it supplies `projectId`, `operationClass`,
`actorReceiptId`, `expectedConfigRevision`, `expectedGovernanceEpoch`,
`expectedFenceToken`, `repoTargetId`, and `expectedResourceRevision`. If doctor
refuses or the target is absent, stop and resolve the live store state; do not
substitute a thread, seat, stale target, or unverified receipt.

`idempotencyKey`, `workItem.workItemId`, `workItem.title`, and `workItem.body`
do not belong in doctor because they are caller-created values for the new
registration, not current store facts.

For a WorkItem that tracks an existing GitHub issue, include the typed
`workItem.githubIssue.issueNumber`. The exact owner/repository comes from the
stored `repoTargetId` mapping; registration validates that mapping and writes
the WorkItem and its `external_work_refs` identity in one transaction. The
binding remains `projection_state: "pending"` until a projection is separately
verified, and registration never invokes GitHub or creates an issue.

Historical rows are handled only by the explicit, one-shot command below. It
does not run during plugin load, and an unresolved row leaves no binding:

```sh
bb collab github-issue-backfill --project "$PROJECT_ID"
```

The command bounds candidates to its persisted epoch, accepts only an exact
`wi-gh-NNN` candidate plus a read-only exact-repository issue check, and records
`completed` or `degraded` results without retrying automatically on later
loads.

The request envelope is defined by `applyRequestSchema` in
`src/foundation.ts`: `projectId`, `operationClass`, and `idempotencyKey` are
required; `actorReceiptId`, `expectedConfigRevision`, `expectedGovernanceEpoch`,
`expectedFenceToken`, `repoTargetId`, and `expectedResourceRevision` carry the
authorization and compare-and-set guards; `workItem` must contain exactly
`workItemId`, `title`, `body`, and optional `githubIssue.issueNumber`.
`parseApplyRequest` rejects unknown or mis-shaped fields. The resolver computes
`mutationRequestDigest` from the normalized request and records it with the
mutation receipt; there is no caller-supplied `digest` field.

The live CLI parses the JSON, requires `--project` to equal `request.projectId`,
then calls `applyLiveAuthorizedMutation` in `server.ts`. The create resolver
requires the current config, governor, verified actor receipt, exact repository
target, and `expectedResourceRevision: null`; it creates the WorkItem in
`proposed` state and returns the canonical mutation receipt.

To resolve a durably fenced `delivery_ambiguous` GitHub projection, use the
same documented CLI apply seam with the exact previously verified observation:

```json
{
  "operationClass": "github_issue_projection",
  "projectionKind": "github_issue",
  "projectionRecoveryEvidence": {
    "kind": "github_issue_unchanged",
    "owner": "<mapped-owner>",
    "repo": "<mapped-repo>",
    "issueNumber": 667,
    "externalRevision": "<last-observed-external-revision>"
  }
}
```

Include the normal project, actor, config, governorship, repository-target,
resource-revision, WorkItem, and idempotency fields. The live CLI supplies the
GitHub adapter only for this recovery request; it rereads the exact mapped
issue and resets the ref to `pending` only when the unchanged observation proves
the attempted write did not land. Ordinary projection apply remains fenced.

For a `drifted` GitHub projection, supply a fresh observation of the exact bound
issue instead. The CLI rereads that issue, verifies its identity and revision,
records the new observation, and resets the ref to `pending`:

```json
{
  "projectionRecoveryEvidence": {
    "kind": "github_issue_observed",
    "owner": "<mapped-owner>",
    "repo": "<mapped-repo>",
    "issueNumber": 667,
    "externalRevision": "<current-external-revision>"
  }
}
```
