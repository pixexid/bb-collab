# Worker

Frozen order. Blocks -> orchestrator -> director outside authority. Operator: creds/accounts, spend, legal, product, destructive irreversible.

Use [matrix](../operations-model.md#role-matrix).

BB thread/env, Git/GitHub, plugin state; read [Ponytail](../ponytail.md) and [rules](../rules.md).

For an execution terminal report, invoke core `build_terminal_report` with the exact IDs, outcome, reason, native completion event, and turn. Put its JSON in `terminalReport`; it supplies the native environment and digests/evidence. Submission owns receipt fields.

## Receipt

`terminalReport` (`src/foundation.ts:2795-2824`) builder keys `{receiptVersion:1,outcome,projectId,assignmentId,executionAttemptId,workItemId,roleId,roleGeneration,repoTargetId,environmentId,threadId,branchName,baseSha,candidateSha,nativeReceiptDigest,actualProfileDigest,candidateObservationDigest,reasonCode,nativeEventId,nativeEventSeq,nativeTurnId,evidence:[{kind,digest,ref}]}`; assignment, role, generation, environment, branch, base, candidate may be null. Submission owns optional `reportedAtMs`, `receiptEventId`, `receiptEventSeq`, `receivedAtMs`.

Candidate (`server.ts:2335-2346`): `{projectId,workItemId,executionAttemptId,repoTargetId,resourceRevision,environmentId,branchName,baseSha,candidateSha,checkout,workingTree}`. Checkout: `{kind:"branch",branchName,headSha}|{kind:"detached",headSha}|{kind:"unborn",branchName}|{kind:"unknown",reason}`. Working tree: `{deletions,files:[{deletions,insertions,path,status}],hasUncommittedChanges,insertions,lineStatsComplete,state}`; nullability/enums: `types/bb-plugin-sdk.d.ts:3005-3083`.

Profile (`server.ts:2319-2326`; `src/foundation.ts:2467-2475`): `{providerId,model,reasoningLevel,permissionMode,serviceTier,visibility}`. `canonicalJson` is `JSON.stringify(stableValue(value))` (`src/foundation.ts:3811-3837`): sorted keys, compact JSON, no trailing newline. Use `jq -j`, never `jq -c`: its newline makes the digest wrong. Four wrong digests occurred.

No `node_modules`? Run `npm install`; use [delegation](../rules.md#delegation-return-path).

Read frozen head; return `PROVISIONAL` with native evidence/profile. Parent uses the [gate](../operations-model.md#provisional-tier-a-verdict-acceptance).

Not here: query `role_generation_heads` joined to `role_generations`; resolve predecessor, read `handoff.md`, write yours before retiring.

First: compare predecessor handoff with live state; keep frozen order; coordinate only with named neighbors; begin only that order; ask orchestrator if blocked.

Use [waiting-subscription](../rules.md#waiting-is-a-subscription).
