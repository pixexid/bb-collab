import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineRpcContract } from "@bb/plugin-sdk";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import plugin from "../server.js";
import {
  DEFERRED_ISSUE_3_OUTCOMES,
  CONTRACT_VERSION,
  MAX_EXPORT_ROWS,
  MIGRATIONS,
  MIGRATION_STATES,
  MIGRATION_STEPS,
  PLUGIN_ID,
  SCHEMA_VERSION,
  TABLES,
  applyFixtureMutation,
  applyAuthorizedMutation,
  cachedConsumerRolloutEvidence,
  canonicalJson,
  contractDigest,
  databaseIsReady,
  doctor,
  explicitExecutionInputSources,
  exportFoundation,
  persistInterimOperatorReceipt,
  operatorRequestDigest,
  legacyRequestDigest,
  schemaDigest,
  sha256,
  type ApplyRequest,
  type ExportPayload,
  type FoundationResult,
  type NativeAssignmentInspection,
} from "../src/foundation.js";
import {
  applyWithFixtureReceipt,
  DeterministicGitHubIssueAdapter,
  DeterministicNativeAssignmentAdapter,
  DeterministicReviewFactReader,
  DeterministicRoleFactReader,
  seedFixtureDecision,
  seedVerifiedFixtureReceipt,
} from "../src/test-support.js";

const PROJECT_ID = "proj_test";
const FOREIGN_PROJECT_ID = "proj_foreign";
const RECEIPT_ID = "receipt-test";
const TARGET_ID = "target-main";
const SECOND_TARGET_ID = "target-second";
const WORK_ITEM_ID = "work-item-1";
const GITHUB_OWNER = "example";
const GITHUB_REPO = "project";
const CONNECTOR_HOST = "github.test";
const ROLE_THREAD_ID = "thread-holder";
const ROLE_ENVIRONMENT_ID = "environment-holder";
const ROLE_REQUEST_EVENT_ID = "event-request";
const ROLE_COMPLETION_EVENT_ID = "event-completion";
const ROLE_PROFILE = {
  providerId: "codex",
  model: "gpt-5.6-sol",
  reasoningLevel: "high",
  permissionMode: "full",
  serviceTier: "default",
  visibility: "visible" as const,
};
const ROLE_PROFILE_DIGEST = sha256(canonicalJson(ROLE_PROFILE));
const BASE_SHA = "a".repeat(40);
const CANDIDATE_SHA = "b".repeat(40);
const H1_CANDIDATE_SHA = "c".repeat(40);
const H0_TREE_DIGEST = sha256("tree-h0");
const H1_TREE_DIGEST = sha256("tree-h1");
const REVIEW_FILES = ["src/foundation.ts"];
const REVIEW_AUTHORS = [{ name: "Writer", email: "writer@example.test" }];
const REVIEW_COMMITTERS = [{ name: "Committer", email: "committer@example.test" }];
const FROZEN_BRIEF = "# Frozen assignment\nImplement the exact bounded change.";
const FROZEN_BRIEF_DIGEST = sha256(FROZEN_BRIEF);

function roleConfig(connector: "required" | "optional" | "prohibited" = "optional") {
  const config = structuredClone(bootstrapRequest().config) as {
    extensions: { bbCollab: Record<string, unknown> };
  };
  config.extensions.bbCollab.roleRequirements = [
    { roleRequirementId: "orchestrator-v1", roleId: "project-orchestrator", repoTargetId: null, executedProfile: ROLE_PROFILE },
    { roleRequirementId: "reviewer-v1", roleId: "independent-reviewer", repoTargetId: TARGET_ID, executedProfile: ROLE_PROFILE },
  ];
  config.extensions.bbCollab.reviewPolicy = {
    connectors: [{ repoTargetId: TARGET_ID, connectorId: "connector-review", policy: connector }],
  };
  return config;
}

function roleReader(
  mutate?: (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => void,
) {
  const facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0] = {
    thread: {
      id: ROLE_THREAD_ID,
      projectId: PROJECT_ID,
      environmentId: ROLE_ENVIRONMENT_ID,
      providerId: ROLE_PROFILE.providerId,
      status: "idle",
      visibility: "visible",
    },
    events: [
      {
        id: ROLE_REQUEST_EVENT_ID,
        seq: 1,
        type: "client/turn/requested",
        data: {
          requestId: "request-1",
          execution: {
            model: ROLE_PROFILE.model,
            reasoningLevel: ROLE_PROFILE.reasoningLevel,
            permissionMode: ROLE_PROFILE.permissionMode,
            serviceTier: ROLE_PROFILE.serviceTier,
            source: "client/turn/requested",
          },
        },
      },
      { id: "event-accepted", seq: 2, type: "turn/input/accepted", data: { clientRequestId: "request-1", providerThreadId: "provider-thread-1" } },
      { id: "event-started", seq: 3, type: "turn/started", data: { providerThreadId: "provider-thread-1" } },
      { id: ROLE_COMPLETION_EVENT_ID, seq: 4, type: "turn/completed", data: { providerThreadId: "provider-thread-1", status: "completed" } },
    ],
    environment: {
      id: ROLE_ENVIRONMENT_ID,
      projectId: PROJECT_ID,
      hostId: "host-main",
      path: "/workspace/project",
      managed: true,
      isGitRepo: true,
      isWorktree: true,
      workspaceProvisionType: "managed-worktree",
      branchName: "bb/role-holder",
      baseBranch: "main",
      defaultBranch: "main",
      mergeBaseBranch: null,
      status: "ready",
    },
    project: projectFacts(),
    host: { id: "host-main", status: "connected", maxPermissionMode: "full" },
    version: "0.37.0",
  };
  mutate?.(facts);
  return new DeterministicRoleFactReader(facts);
}

function qualificationRequest(fenceToken: string, overrides: Partial<ApplyRequest> = {}): ApplyRequest {
  return {
    projectId: PROJECT_ID,
    operationClass: "qualification_observation_record",
    idempotencyKey: "qualification-1",
    actorReceiptId: RECEIPT_ID,
    expectedConfigRevision: 1,
    expectedGovernanceEpoch: 1,
    expectedFenceToken: fenceToken,
    repoTargetId: null,
    roleId: "project-orchestrator",
    roleRequirementId: "orchestrator-v1",
    qualificationId: "qualification-1",
    roleContext: {
      threadId: ROLE_THREAD_ID,
      requestEventId: ROLE_REQUEST_EVENT_ID,
      requestEventSeq: 1,
      completionEventId: ROLE_COMPLETION_EVENT_ID,
      completionEventSeq: 4,
    },
    qualificationOutcome: "qualified",
    observedAtMs: 100,
    expiresAtMs: 9_999_999_999_999,
    reasonCode: "fixture_passed",
    fixtureContextDigest: "fixture-v1",
    declaredProfile: ROLE_PROFILE,
    ...overrides,
  };
}

function successionRequest(fenceToken: string, overrides: Partial<ApplyRequest> = {}): ApplyRequest {
  return {
    projectId: PROJECT_ID,
    operationClass: "role_generation_succession",
    idempotencyKey: "succession-1",
    actorReceiptId: RECEIPT_ID,
    expectedConfigRevision: 1,
    expectedGovernanceEpoch: 1,
    expectedFenceToken: fenceToken,
    repoTargetId: null,
    roleId: "project-orchestrator",
    roleRequirementId: "orchestrator-v1",
    qualificationId: "qualification-1",
    expectedGeneration: null,
    predecessorGeneration: null,
    profileDigest: ROLE_PROFILE_DIGEST,
    fixtureContextDigest: "fixture-v1",
    roleContext: {
      threadId: ROLE_THREAD_ID,
      requestEventId: ROLE_REQUEST_EVENT_ID,
      requestEventSeq: 1,
      completionEventId: ROLE_COMPLETION_EVENT_ID,
      completionEventSeq: 4,
    },
    ...overrides,
  };
}

function projectFacts(projectId = PROJECT_ID) {
  return {
    id: projectId,
    kind: "standard" as const,
    name: "Test project",
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    sources: [
      {
        id: "source-main",
        projectId,
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
        type: "local_path" as const,
        hostId: "host-main",
        path: "/workspace/project",
      },
    ],
  };
}

function hostFor(projectId = PROJECT_ID) {
  const project = projectFacts(projectId);
  return createFakePluginHost({
    pluginId: PLUGIN_ID,
    sdk: {
      system: {
        version: async () => ({
          currentVersion: "0.37.0",
          latestVersion: "0.37.0",
          source: "npm" as const,
          updateAvailable: false,
          isDevelopment: false,
          upgradeCommand: "npx bb-app@latest",
        }),
      },
      projects: {
        get: async () => project,
      },
      hosts: {
        get: async () => ({
          id: "host-main",
          name: "Test host",
          type: "persistent" as const,
          status: "connected" as const,
          maxPermissionMode: "full" as const,
          lastSeenAt: 1,
          lastRejectedProtocolVersion: null,
          createdAt: 1,
          updatedAt: 1,
        }),
      },
    },
  });
}

function bootstrapRequest(
  projectId = PROJECT_ID,
  overrides: Partial<ApplyRequest> = {},
): ApplyRequest {
  return {
    projectId,
    operationClass: "bootstrap",
    idempotencyKey: "bootstrap-1",
    actorReceiptId: RECEIPT_ID,
    expectedConfigRevision: null,
    configRevision: 1,
    expectedGovernanceEpoch: null,
    expectedFenceToken: null,
    repoTargetId: TARGET_ID,
    config: {
      permissionMode: "full",
      visibility: "visible",
      repositoryTargets: [TARGET_ID],
      secretRef: "bb.secret.test",
      extensions: {
        bbCollab: {
          githubIssues: {
            repositoryMappings: [
              { repoTargetId: TARGET_ID, owner: GITHUB_OWNER, repo: GITHUB_REPO, connectorHost: CONNECTOR_HOST },
            ],
            issue: {
              titlePrefix: "[bb] ",
              bodyPrefix: "canonical: ",
              managedLabels: {
                names: ["work-proposed", "work-ready", "work-active", "work-done"],
                byLifecycle: {
                  proposed: ["work-proposed"],
                  ready: ["work-ready"],
                  in_progress: ["work-active"],
                  succeeded: ["work-done"],
                  failed: ["work-done"],
                  cancelled: ["work-done"],
                },
              },
            },
          },
        },
      },
    },
    targets: [
      {
        repoTargetId: TARGET_ID,
        sourceId: "source-main",
        hostId: "host-main",
        path: "/workspace/project",
        remoteUrl: null,
        defaultBranch: "main",
      },
    ],
    ...overrides,
  };
}

function workItemCreateRequest(fenceToken: string, overrides: Partial<ApplyRequest> = {}): ApplyRequest {
  return {
    projectId: PROJECT_ID,
    operationClass: "work_item_create",
    idempotencyKey: "work-item-create-1",
    actorReceiptId: RECEIPT_ID,
    expectedConfigRevision: 1,
    expectedGovernanceEpoch: 1,
    expectedFenceToken: fenceToken,
    repoTargetId: TARGET_ID,
    expectedResourceRevision: null,
    workItem: { workItemId: WORK_ITEM_ID, title: "Ship projection", body: "Keep canonical state local." },
    ...overrides,
  };
}

function transitionRequest(
  fenceToken: string,
  state: ApplyRequest["lifecycleState"],
  expectedResourceRevision: number,
  overrides: Partial<ApplyRequest> = {},
): ApplyRequest {
  return {
    projectId: PROJECT_ID,
    operationClass: "work_item_transition",
    idempotencyKey: `work-item-${state}-${expectedResourceRevision}`,
    actorReceiptId: RECEIPT_ID,
    expectedConfigRevision: 1,
    expectedGovernanceEpoch: 1,
    expectedFenceToken: fenceToken,
    repoTargetId: TARGET_ID,
    expectedResourceRevision,
    workItemId: WORK_ITEM_ID,
    lifecycleState: state,
    ...overrides,
  };
}

function projectionRequest(
  fenceToken: string,
  expectedResourceRevision: number,
  overrides: Partial<ApplyRequest> = {},
): ApplyRequest {
  return {
    projectId: PROJECT_ID,
    operationClass: "github_issue_projection",
    idempotencyKey: `project-github-${expectedResourceRevision}`,
    actorReceiptId: RECEIPT_ID,
    expectedConfigRevision: 1,
    expectedGovernanceEpoch: 1,
    expectedFenceToken: fenceToken,
    repoTargetId: TARGET_ID,
    expectedResourceRevision,
    workItemId: WORK_ITEM_ID,
    projectionKind: "github_issue",
    ...overrides,
  };
}

async function loadedHost(projectId = PROJECT_ID) {
  const host = hostFor(projectId);
  await plugin(host.bb);
  return host;
}

function seedAndBootstrap(host: ReturnType<typeof hostFor>, projectId = PROJECT_ID, overrides: Partial<ApplyRequest> = {}) {
  const db = host.bb.storage.database();
  seedVerifiedFixtureReceipt(db, { projectId, receiptId: RECEIPT_ID });
  const request = bootstrapRequest(projectId, overrides);
  const result = applyWithFixtureReceipt(db, request);
  expect(result.outcome).toBe("OK");
  return {
    db,
    request,
    result,
    fenceToken: (result.evidence as { fenceToken: string }).fenceToken,
  };
}

function directDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "bb-collab-issue3-"));
  const path = join(directory, "data.db");
  const db = new Database(path);
  databaseIsReady(db);
  for (const statement of MIGRATIONS) db.exec(statement);
  return { db, path, directory };
}

const MIGRATION_ID = "migration-1";
const MIGRATION_DECISION_ID = "migration-decision";
const SOURCE_SNAPSHOT_DIGEST = sha256("source-snapshot");

function currentGovernor(db: Database.Database) {
  return db.prepare("SELECT governance_epoch, fence_token, state FROM project_governorship_heads WHERE project_id = ?").get(PROJECT_ID) as {
    governance_epoch: number;
    fence_token: string;
    state: "source_active" | "frozen" | "target_active" | "retired";
  };
}

function repositoryTargetsDigest(db: Database.Database) {
  return sha256(canonicalJson(db.prepare(
    `SELECT repo_target_id, source_id, host_id, path, remote_url, default_branch, target_digest
     FROM repository_targets WHERE project_id = ? AND config_revision = 1 ORDER BY repo_target_id`,
  ).all(PROJECT_ID)));
}

function seedMigrationAuthority(db: Database.Database) {
  seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID, actorKind: "operator", subjectId: "fixture-operator" });
  const bootstrap = applyWithFixtureReceipt(db, bootstrapRequest());
  expect(bootstrap.outcome).toBe("OK");
  seedFixtureDecision(db, {
    projectId: PROJECT_ID,
    decisionId: MIGRATION_DECISION_ID,
    scope: { operation: "migration", projectId: PROJECT_ID },
    decisionClass: "assignment_admission",
    options: { sourceSystem: "llm-collab", targetRuntimeId: PLUGIN_ID },
  });
  db.prepare(
    `INSERT INTO decision_dispositions
      (decision_id, disposition_sequence, disposition, actor_receipt_id, reason_json, created_at_ms, idempotency_key)
     VALUES (?, 1, 'adopted', ?, ?, 1, 'migration-decision-adopted')`,
  ).run(MIGRATION_DECISION_ID, RECEIPT_ID, canonicalJson({ reason: "fixture cutover authorized" }));
  return currentGovernor(db);
}

function migrationPrepareRequest(
  governor: ReturnType<typeof currentGovernor>,
  overrides: Partial<ApplyRequest> = {},
): ApplyRequest {
  return {
    projectId: PROJECT_ID,
    operationClass: "migration_prepare",
    idempotencyKey: "migration-prepare",
    actorReceiptId: RECEIPT_ID,
    expectedConfigRevision: 1,
    configRevision: 1,
    expectedGovernanceEpoch: governor.governance_epoch,
    expectedFenceToken: governor.fence_token,
    expectedResourceRevision: null,
    migration: {
      migrationId: MIGRATION_ID,
      sourceSystem: "llm-collab",
      sourceRuntimeId: "llm-collab-runtime",
      targetRuntimeId: PLUGIN_ID,
      sourceContractDigest: contractDigest,
      sourceSchemaDigest: schemaDigest,
      sourceSnapshotDigest: SOURCE_SNAPSHOT_DIGEST,
      decisionId: MIGRATION_DECISION_ID,
      decisionDispositionSequence: 1,
      retentionUntilMs: 9_999_999_999_999,
    },
    ...overrides,
  };
}

function migrationStepRequest(
  db: Database.Database,
  step: (typeof MIGRATION_STEPS)[number],
  input: Partial<NonNullable<ApplyRequest["migrationStep"]>> = {},
  overrides: Partial<ApplyRequest> = {},
): ApplyRequest {
  const governor = currentGovernor(db);
  const run = db.prepare("SELECT resource_revision FROM migration_runs WHERE project_id = ? AND migration_id = ?").get(PROJECT_ID, MIGRATION_ID) as {
    resource_revision: number;
  };
  return {
    projectId: PROJECT_ID,
    operationClass: "migration_step",
    idempotencyKey: `migration-${step}-${run.resource_revision}`,
    actorReceiptId: RECEIPT_ID,
    expectedConfigRevision: 1,
    configRevision: 1,
    expectedGovernanceEpoch: governor.governance_epoch,
    expectedFenceToken: governor.fence_token,
    expectedResourceRevision: run.resource_revision,
    migrationStep: {
      migrationId: MIGRATION_ID,
      step,
      proofDigest: sha256(step),
      repositoryTargetsDigest: repositoryTargetsDigest(db),
      ...input,
    },
    ...overrides,
  };
}

function prepareMigration(db: Database.Database) {
  const prepare = applyWithFixtureReceipt(db, migrationPrepareRequest(seedMigrationAuthority(db)));
  expect(prepare).toMatchObject({ outcome: "OK", currentResourceRevision: 1, evidence: { state: "prepared" } });
  return prepare;
}

function freezeMigration(db: Database.Database) {
  prepareMigration(db);
  expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "record_inventory", { proofDigest: sha256("inventory") }))).toMatchObject({ outcome: "OK", currentResourceRevision: 2 });
  expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "record_quiescence", { proofDigest: sha256("quiescence") }))).toMatchObject({ outcome: "OK", currentResourceRevision: 3 });
  const freeze = applyWithFixtureReceipt(db, migrationStepRequest(db, "freeze", { canaries: { expected: 3, attempted: 3, verified: 3 } }));
  expect(freeze).toMatchObject({ outcome: "OK", currentResourceRevision: 4, evidence: { state: "frozen" } });
  return freeze;
}

function fixtureExport(db: Database.Database): ExportPayload {
  const exported = exportFoundation(db, PROJECT_ID);
  expect(exported.outcome).toBe("OK");
  return exported.export!;
}

function resealArtifactExport(payload: ExportPayload, mutate: (artifact: ExportPayload["artifactIndex"][number]) => void): ExportPayload {
  const resealed = structuredClone(payload);
  mutate(resealed.artifactIndex[0]!);
  for (const artifact of resealed.artifactIndex) {
    const redacted = JSON.parse(artifact.redactedJson);
    const durableRef = JSON.parse(artifact.durableRefJson);
    artifact.redactedJson = canonicalJson(redacted);
    artifact.durableRefJson = canonicalJson(durableRef);
    artifact.redactedDigest = sha256(artifact.redactedJson);
    artifact.artifactIdentityDigest = sha256(canonicalJson({
      projectId: PROJECT_ID,
      evidenceId: artifact.evidenceId,
      evidenceKind: artifact.evidenceKind,
      sourceKind: artifact.sourceKind,
      sourceRef: artifact.sourceRef,
      executionAttemptId: artifact.executionAttemptId,
      contentDigest: artifact.contentDigest,
      redactedDigest: artifact.redactedDigest,
      durableRef: JSON.parse(artifact.durableRefJson),
    }));
  }
  resealed.manifest.artifactIndexDigest = sha256(canonicalJson(resealed.artifactIndex));
  const rootInput = { ...resealed.manifest };
  delete (rootInput as Partial<ExportPayload["manifest"]>).exportRootDigest;
  resealed.manifest.exportRootDigest = sha256(canonicalJson(rootInput));
  resealed.checksums = {
    "artifact-index.json": resealed.manifest.artifactIndexDigest,
    "manifest.json": sha256(canonicalJson(resealed.manifest)),
    "records.ndjson": resealed.manifest.recordsDigest,
  };
  return resealed;
}

function recordMigrationExport(db: Database.Database) {
  const exported = fixtureExport(db);
  const ceiling = (db.prepare("SELECT MAX(event_sequence) AS ceiling FROM state_events WHERE project_id = ?").get(PROJECT_ID) as { ceiling: number }).ceiling;
  const result = applyWithFixtureReceipt(db, migrationStepRequest(db, "record_export", {
    sourceEventCeiling: ceiling,
    sourceSnapshotDigest: SOURCE_SNAPSHOT_DIGEST,
    export: exported,
  }));
  expect(result).toMatchObject({ outcome: "OK", currentResourceRevision: 5, evidence: { state: "exported", sourceExportDigest: exported.manifest.exportRootDigest } });
  return exported;
}

function activateMigration(db: Database.Database) {
  freezeMigration(db);
  const exported = recordMigrationExport(db);
  const importRootDigest = sha256(canonicalJson({
    sourceExportDigest: exported.manifest.exportRootDigest,
    targetRuntimeId: PLUGIN_ID,
    configRevision: 1,
    repositoryTargetsDigest: repositoryTargetsDigest(db),
  }));
  expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "record_import", {
    proofDigest: importRootDigest,
    export: exported,
    importRootDigest,
  }))).toMatchObject({ outcome: "OK", currentResourceRevision: 6, evidence: { state: "imported" } });
  const equivalenceDigest = sha256(canonicalJson({
    sourceExportDigest: exported.manifest.exportRootDigest,
    importRootDigest,
    sourceSnapshotDigest: SOURCE_SNAPSHOT_DIGEST,
    repositoryTargetsDigest: repositoryTargetsDigest(db),
  }));
  expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "record_equivalence", {
    proofDigest: equivalenceDigest,
    export: exported,
    equivalenceDigest,
  }))).toMatchObject({ outcome: "OK", currentResourceRevision: 7, evidence: { state: "equivalent" } });
  const activate = applyWithFixtureReceipt(db, migrationStepRequest(db, "activate"));
  expect(activate).toMatchObject({ outcome: "OK", currentResourceRevision: 8, evidence: { state: "target_active" } });
  return { exported, activate };
}

function seedEvidenceArtifact(db: Database.Database, evidenceId: string, payloadBytes = 0) {
  const redactedJson = canonicalJson({ evidenceId, redacted: true });
  const durableRefJson = canonicalJson({ kind: "fixture", ref: evidenceId, fixtureContent: "x".repeat(payloadBytes) });
  const artifact = {
    projectId: PROJECT_ID,
    evidenceId,
    evidenceKind: "test",
    sourceKind: "test",
    sourceRef: `fixture:${evidenceId}`,
    executionAttemptId: null,
    contentDigest: sha256(`content:${evidenceId}`),
    redactedDigest: sha256(redactedJson),
    durableRef: JSON.parse(durableRefJson),
  };
  db.prepare(
    `INSERT INTO evidence_artifacts
      (project_id, evidence_id, evidence_kind, source_kind, source_ref, execution_attempt_id,
       content_digest, redacted_json, redacted_digest, durable_ref_json, artifact_identity_digest, created_at_ms)
     VALUES (?, ?, 'test', 'test', ?, NULL, ?, ?, ?, ?, ?, 1)`,
  ).run(
    PROJECT_ID,
    evidenceId,
    artifact.sourceRef,
    artifact.contentDigest,
    redactedJson,
    artifact.redactedDigest,
    durableRefJson,
    sha256(canonicalJson(artifact)),
  );
}

function seedAssignmentDatabase(
  db: Database.Database,
  options: { writingLaneCeiling?: number; inProgress?: boolean } = {},
) {
  seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
  const config = roleConfig();
  if (options.writingLaneCeiling !== undefined) {
    (config.extensions.bbCollab as Record<string, unknown>).writingLaneCeiling = options.writingLaneCeiling;
  }
  const bootstrapped = applyFixtureMutation(db, bootstrapRequest(PROJECT_ID, { config }));
  const fenceToken = (bootstrapped.evidence as { fenceToken: string }).fenceToken;
  expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
  expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "ready", 1)).outcome).toBe("OK");
  if (options.inProgress) {
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "in_progress", 2)).outcome).toBe("OK");
  }
  expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken), null, roleReader()).outcome).toBe("OK");
  const succession = applyWithFixtureReceipt(db, successionRequest(fenceToken), null, roleReader());
  const holderExecutionAttemptId = (succession.evidence as { holderExecutionAttemptId: string }).holderExecutionAttemptId;
  seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: "role-actor-assignment", actorKind: "role", subjectId: holderExecutionAttemptId, roleId: "project-orchestrator", roleGeneration: 1 });
  return { fenceToken, workItemRevision: options.inProgress ? 3 : 2 };
}

async function assignmentFixture(options: {
  writingLaneCeiling?: number;
  connectorPolicy?: "required" | "optional" | "prohibited";
  targetDefaultBranch?: string;
} = {}) {
  const host = await loadedHost();
  const config = roleConfig(options.connectorPolicy);
  if (options.writingLaneCeiling !== undefined) {
    (config.extensions.bbCollab as Record<string, unknown>).writingLaneCeiling = options.writingLaneCeiling;
  }
  const targets = options.targetDefaultBranch
    ? bootstrapRequest().targets!.map((target) => ({ ...target, defaultBranch: options.targetDefaultBranch! }))
    : undefined;
  const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config, ...(targets ? { targets } : {}) });
  expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
  expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "ready", 1)).outcome).toBe("OK");
  expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken), null, roleReader()).outcome).toBe("OK");
  const succession = applyWithFixtureReceipt(db, successionRequest(fenceToken), null, roleReader());
  expect(succession.outcome).toBe("OK");
  const holderExecutionAttemptId = (succession.evidence as { holderExecutionAttemptId: string }).holderExecutionAttemptId;
  seedVerifiedFixtureReceipt(db, {
    projectId: PROJECT_ID,
    receiptId: "role-actor-assignment",
    actorKind: "role",
    subjectId: holderExecutionAttemptId,
    roleId: "project-orchestrator",
    roleGeneration: 1,
  });
  return { host, db, fenceToken, holderExecutionAttemptId };
}

function activateReviewer(db: Database.Database, fenceToken: string) {
  const roleContext = {
    threadId: "thread-reviewer",
    requestEventId: "event-reviewer-request",
    requestEventSeq: 1,
    completionEventId: "event-reviewer-completion",
    completionEventSeq: 4,
  };
  const facts = () => roleReader((input) => {
    input.thread.id = roleContext.threadId;
    input.thread.environmentId = "environment-reviewer";
    input.environment.id = "environment-reviewer";
    input.events[0]!.id = roleContext.requestEventId;
    input.events[3]!.id = roleContext.completionEventId;
  });
  expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
    idempotencyKey: "qualification-reviewer",
    repoTargetId: TARGET_ID,
    roleId: "independent-reviewer",
    roleRequirementId: "reviewer-v1",
    qualificationId: "qualification-reviewer",
    roleContext,
  }), null, facts()).outcome).toBe("OK");
  const succession = applyWithFixtureReceipt(db, successionRequest(fenceToken, {
    idempotencyKey: "succession-reviewer",
    repoTargetId: TARGET_ID,
    roleId: "independent-reviewer",
    roleRequirementId: "reviewer-v1",
    qualificationId: "qualification-reviewer",
    roleContext,
  }), null, facts());
  expect(succession.outcome).toBe("OK");
  const successorContext = {
    threadId: "thread-reviewer-successor",
    requestEventId: "event-reviewer-successor-request",
    requestEventSeq: 1,
    completionEventId: "event-reviewer-successor-completion",
    completionEventSeq: 4,
  };
  const successorFacts = () => roleReader((input) => {
    input.thread.id = successorContext.threadId;
    input.thread.environmentId = "environment-reviewer-successor";
    input.environment.id = "environment-reviewer-successor";
    input.events[0]!.id = successorContext.requestEventId;
    input.events[3]!.id = successorContext.completionEventId;
  });
  expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
    idempotencyKey: "qualification-reviewer-successor",
    repoTargetId: TARGET_ID,
    roleId: "independent-reviewer",
    roleRequirementId: "reviewer-v1",
    qualificationId: "qualification-reviewer-successor",
    roleContext: successorContext,
  }), null, successorFacts()).outcome).toBe("OK");
  const successor = applyWithFixtureReceipt(db, successionRequest(fenceToken, {
    idempotencyKey: "succession-reviewer-successor",
    repoTargetId: TARGET_ID,
    roleId: "independent-reviewer",
    roleRequirementId: "reviewer-v1",
    qualificationId: "qualification-reviewer-successor",
    roleContext: successorContext,
    expectedGeneration: 1,
    predecessorGeneration: 1,
  }), null, successorFacts());
  expect(successor.outcome).toBe("OK");
  seedVerifiedFixtureReceipt(db, {
    projectId: PROJECT_ID,
    receiptId: "role-actor-reviewer",
    actorKind: "role",
    subjectId: (successor.evidence as { holderExecutionAttemptId: string }).holderExecutionAttemptId,
    roleId: "independent-reviewer",
    roleGeneration: 2,
  });
}

function advanceOrchestrator(db: Database.Database, fenceToken: string): string {
  const roleContext = {
    threadId: "thread-orchestrator-successor",
    requestEventId: "event-orchestrator-successor-request",
    requestEventSeq: 1,
    completionEventId: "event-orchestrator-successor-completion",
    completionEventSeq: 4,
  };
  const facts = () => roleReader((input) => {
    input.thread.id = roleContext.threadId;
    input.thread.environmentId = "environment-orchestrator-successor";
    input.environment.id = "environment-orchestrator-successor";
    input.events[0]!.id = roleContext.requestEventId;
    input.events[3]!.id = roleContext.completionEventId;
  });
  expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
    idempotencyKey: "qualification-orchestrator-successor",
    qualificationId: "qualification-orchestrator-successor",
    roleContext,
  }), null, facts()).outcome).toBe("OK");
  const succession = applyWithFixtureReceipt(db, successionRequest(fenceToken, {
    idempotencyKey: "succession-orchestrator-successor",
    qualificationId: "qualification-orchestrator-successor",
    roleContext,
    expectedGeneration: 1,
    predecessorGeneration: 1,
  }), null, facts());
  expect(succession.outcome).toBe("OK");
  const receiptId = "role-actor-orchestrator-successor";
  seedVerifiedFixtureReceipt(db, {
    projectId: PROJECT_ID,
    receiptId,
    actorKind: "role",
    subjectId: (succession.evidence as { holderExecutionAttemptId: string }).holderExecutionAttemptId,
    roleId: "project-orchestrator",
    roleGeneration: 2,
  });
  return receiptId;
}

function assignmentPrepareRequest(
  fenceToken: string,
  assignmentId = "assignment-1",
  overrides: Partial<ApplyRequest> = {},
): ApplyRequest {
  return {
    projectId: PROJECT_ID,
    operationClass: "assignment_prepare",
    idempotencyKey: `prepare-${assignmentId}`,
    actorReceiptId: "role-actor-assignment",
    expectedConfigRevision: 1,
    expectedGovernanceEpoch: 1,
    expectedFenceToken: fenceToken,
    repoTargetId: TARGET_ID,
    expectedResourceRevision: 2,
    assignment: {
      assignmentId,
      workItemId: WORK_ITEM_ID,
      assignmentKind: "write",
      laneId: "lane-main",
      roleRequirementId: "orchestrator-v1",
      roleId: "project-orchestrator",
      roleGeneration: 1,
      branchName: `bb/${assignmentId}`,
      baseSha: BASE_SHA,
      candidateSemantics: "base",
      candidateSha: null,
      environment: {
        bbServerId: "bb-server-test",
        environmentId: `environment-${assignmentId}`,
        sourceId: "source-main",
        hostId: "host-main",
        path: "/workspace/project",
        mode: "managed-worktree",
      },
      frozenBriefVersion: 1,
      frozenBriefDigest: FROZEN_BRIEF_DIGEST,
      requestedProfile: ROLE_PROFILE,
      dispatchKind: "spawn",
      attachThreadId: null,
      parentAssignmentId: null,
      depth: 0,
      deadlineAtMs: Date.now() + 60_000,
    },
    ...overrides,
  };
}

function assignmentPhaseRequest(
  fenceToken: string,
  operationClass: "assignment_dispatch" | "assignment_reconcile" | "assignment_terminal",
  assignmentId: string,
  executionAttemptId: string,
  overrides: Partial<ApplyRequest> = {},
): ApplyRequest {
  return {
    projectId: PROJECT_ID,
    operationClass,
    idempotencyKey: `${operationClass}-${assignmentId}`,
    actorReceiptId: "role-actor-assignment",
    expectedConfigRevision: 1,
    expectedGovernanceEpoch: 1,
    expectedFenceToken: fenceToken,
    repoTargetId: TARGET_ID,
    expectedResourceRevision: 2,
    assignmentId,
    executionAttemptId,
    frozenBriefContent: FROZEN_BRIEF,
    ...overrides,
  };
}

function assignmentTerminalReport(
  assignmentId: string,
  executionAttemptId: string,
  native: { nativeReceiptDigest: string; actualProfileDigest: string; threadId: string },
  overrides: Partial<NonNullable<ApplyRequest["terminalReport"]>> = {},
): NonNullable<ApplyRequest["terminalReport"]> {
  const branchName = `bb/${assignmentId}`;
  const receivedAtMs = Date.now();
  return {
    receiptVersion: 1,
    outcome: "DONE",
    projectId: PROJECT_ID,
    assignmentId,
    executionAttemptId,
    workItemId: WORK_ITEM_ID,
    roleId: "project-orchestrator",
    roleGeneration: 1,
    repoTargetId: TARGET_ID,
    environmentId: `environment-${assignmentId}`,
    threadId: native.threadId,
    branchName,
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    nativeReceiptDigest: native.nativeReceiptDigest,
    actualProfileDigest: native.actualProfileDigest,
    candidateObservationDigest: sha256(canonicalJson({ branchName, baseSha: BASE_SHA, candidateSha: CANDIDATE_SHA })),
    reasonCode: "writer_done",
    evidence: [{ kind: "test", digest: sha256(`tests-${assignmentId}`), ref: "fixture" }],
    reportedAtMs: receivedAtMs,
    receiptEventId: `terminal-event-${assignmentId}`,
    receiptEventSeq: 10,
    receivedAtMs,
    ...overrides,
  };
}

function decisionCreateRequest(
  fenceToken: string,
  decisionId = "decision-v5",
  overrides: Partial<ApplyRequest> = {},
): ApplyRequest {
  return {
    projectId: PROJECT_ID,
    operationClass: "decision_create",
    idempotencyKey: `create-${decisionId}`,
    actorReceiptId: "role-actor-assignment",
    expectedConfigRevision: 1,
    expectedGovernanceEpoch: 1,
    expectedFenceToken: fenceToken,
    repoTargetId: TARGET_ID,
    decision: {
      decisionId,
      repoTargetId: TARGET_ID,
      scope: { operation: "assignment" },
      decisionClass: "assignment_admission",
      options: { mode: "exact" },
      resourceRevision: 1,
    },
    ...overrides,
  };
}

function decisionDispositionRequest(
  fenceToken: string,
  decisionId = "decision-v5",
  expectedResourceRevision = 1,
  overrides: Partial<ApplyRequest> = {},
): ApplyRequest {
  return {
    projectId: PROJECT_ID,
    operationClass: "decision_disposition",
    idempotencyKey: `disposition-${decisionId}-${expectedResourceRevision}`,
    actorReceiptId: "role-actor-assignment",
    expectedConfigRevision: 1,
    expectedGovernanceEpoch: 1,
    expectedFenceToken: fenceToken,
    repoTargetId: TARGET_ID,
    decisionId,
    disposition: "adopted",
    expectedResourceRevision,
    reason: { mechanism: "fixture" },
    ...overrides,
  };
}

function decisionArtifact(
  evidenceId: string,
  overrides: Partial<NonNullable<ApplyRequest["decisionEvidence"]>[number]> = {},
): NonNullable<ApplyRequest["decisionEvidence"]>[number] {
  return {
    evidenceId,
    evidenceKind: "advisory_read",
    sourceKind: "helper",
    sourceRef: `fixture:${evidenceId}`,
    executionAttemptId: null,
    contentDigest: sha256(`content:${evidenceId}`),
    redactedJson: canonicalJson({ summary: evidenceId }),
    durableRefJson: canonicalJson({ ref: `fixture:${evidenceId}` }),
    relationKind: "advisory_read",
    relation: { purpose: "condition" },
    ...overrides,
  };
}

function reviewDecisionCreateRequest(
  fenceToken: string,
  connector: "required" | "optional" | "prohibited" = "optional",
  decisionId = "review-decision",
  overrides: Partial<ApplyRequest> = {},
): ApplyRequest {
  return decisionCreateRequest(fenceToken, decisionId, {
    idempotencyKey: `create-${decisionId}`,
    decision: {
      decisionId,
      repoTargetId: TARGET_ID,
      scope: {
        targets: [{
          workItemId: WORK_ITEM_ID,
          repoTargetId: TARGET_ID,
          configRevision: 1,
          baseSha: BASE_SHA,
          h0CandidateSha: CANDIDATE_SHA,
          h0TreeDigest: H0_TREE_DIGEST,
          tierAEntries: REVIEW_FILES,
        }],
      },
      decisionClass: "review_adjudication",
      options: {
        connectors: [{ repoTargetId: TARGET_ID, connectorId: "connector-review", policy: connector }],
      },
      resourceRevision: 1,
    },
    ...overrides,
  });
}

function completeFixtureAssignment(
  db: Database.Database,
  fenceToken: string,
  input: {
    assignmentId: string;
    assignmentKind: "write" | "review" | "probe";
    candidateSha: string;
  },
) {
  const reviewer = input.assignmentKind !== "write";
  const actorReceiptId = reviewer ? "role-actor-reviewer" : "role-actor-assignment";
  const roleId = reviewer ? "independent-reviewer" : "project-orchestrator";
  const roleRequirementId = reviewer ? "reviewer-v1" : "orchestrator-v1";
  const template = assignmentPrepareRequest(fenceToken, input.assignmentId);
  const adapter = new DeterministicNativeAssignmentAdapter();
  const prepared = applyWithFixtureReceipt(db, {
    ...template,
    actorReceiptId,
    expectedResourceRevision: 3,
    assignment: {
      ...template.assignment!,
      assignmentKind: input.assignmentKind,
      laneId: reviewer ? `review-${input.assignmentId}` : `writer-${input.assignmentId}`,
      roleRequirementId,
      roleId,
      roleGeneration: reviewer ? 2 : 1,
      candidateSemantics: reviewer ? "frozen" : "base",
      candidateSha: reviewer ? input.candidateSha : null,
    },
  }, null, null, adapter);
  expect(prepared.outcome).toBe("OK");
  const executionAttemptId = (prepared.evidence as { executionAttemptId: string }).executionAttemptId;
  const delivered = applyWithFixtureReceipt(db, assignmentPhaseRequest(
    fenceToken,
    "assignment_dispatch",
    input.assignmentId,
    executionAttemptId,
    { actorReceiptId, expectedResourceRevision: 3 },
  ), null, null, adapter);
  expect(delivered.outcome).toBe("OK");
  const native = delivered.evidence as { nativeReceiptDigest: string; actualProfileDigest: string; threadId: string };
  const terminal = applyWithFixtureReceipt(db, assignmentPhaseRequest(
    fenceToken,
    "assignment_terminal",
    input.assignmentId,
    executionAttemptId,
    {
      actorReceiptId,
      expectedResourceRevision: 3,
      terminalReport: assignmentTerminalReport(input.assignmentId, executionAttemptId, native, {
        roleId,
        roleGeneration: reviewer ? 2 : 1,
        candidateSha: input.candidateSha,
        candidateObservationDigest: sha256(canonicalJson({
          branchName: `bb/${input.assignmentId}`,
          baseSha: BASE_SHA,
          candidateSha: input.candidateSha,
        })),
        reasonCode: `${input.assignmentKind}_done`,
      }),
    },
  ), null, null, adapter);
  expect(terminal.outcome).toBe("OK");
  const terminalReportDigest = (terminal.evidence as { terminalReportDigest: string }).terminalReportDigest;
  return {
    adapter,
    assignmentId: input.assignmentId,
    executionAttemptId,
    native,
    evidence: decisionArtifact(`delegated-${input.assignmentId}`, {
      evidenceKind: "delegated_action_receipt",
      sourceKind: "delegated_action",
      sourceRef: `execution:${executionAttemptId}`,
      assignmentId: input.assignmentId,
      executionAttemptId,
      contentDigest: terminalReportDigest,
      redactedJson: canonicalJson({ outcome: "DONE" }),
      durableRefJson: canonicalJson({ assignmentId: input.assignmentId, executionAttemptId }),
      relationKind: "delegated_action_receipt",
      terminalReportDigest,
      actualProfileDigest: native.actualProfileDigest,
      nativeReceiptDigest: native.nativeReceiptDigest,
    }),
  };
}

async function preparedReview(connectorPolicy: "required" | "optional" | "prohibited" = "optional") {
  const { db, fenceToken } = await assignmentFixture({ connectorPolicy });
  activateReviewer(db, fenceToken);
  expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "in_progress", 2)).outcome).toBe("OK");
  expect(applyWithFixtureReceipt(db, reviewDecisionCreateRequest(fenceToken, connectorPolicy, "review-evidence-decision"))).toMatchObject({ outcome: "OK" });
  const write = completeFixtureAssignment(db, fenceToken, { assignmentKind: "write", assignmentId: "write-assignment", candidateSha: CANDIDATE_SHA });
  const review = completeFixtureAssignment(db, fenceToken, { assignmentKind: "review", assignmentId: "review-assignment", candidateSha: CANDIDATE_SHA });
  review.evidence.relation = {
    relationRole: "final_review",
    workItemId: WORK_ITEM_ID,
    repoTargetId: TARGET_ID,
    configRevision: 1,
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    treeDigest: H0_TREE_DIGEST,
    changedFiles: REVIEW_FILES,
    tierAEntries: REVIEW_FILES,
    writeAssignmentId: write.assignmentId,
    writeExecutionAttemptId: write.executionAttemptId,
    authors: REVIEW_AUTHORS,
    committers: REVIEW_COMMITTERS,
  };
  const reader = new DeterministicReviewFactReader();
  reader.facts = {
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
    repoTargetId: TARGET_ID,
    writeAssignmentId: write.assignmentId,
    writeExecutionAttemptId: write.executionAttemptId,
    branchName: `bb/${write.assignmentId}`,
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    treeDigest: H0_TREE_DIGEST,
    changedFiles: REVIEW_FILES,
    authors: REVIEW_AUTHORS,
    committers: REVIEW_COMMITTERS,
  };
  const request = (extraEvidence: NonNullable<ApplyRequest["decisionEvidence"]> = [], overrides: Partial<ApplyRequest> = {}) =>
    decisionDispositionRequest(fenceToken, "review-evidence-decision", 1, {
      conditions: [{ kind: "evidence_required", evidenceIds: [review.evidence.evidenceId] }],
      decisionEvidence: [review.evidence, ...extraEvidence],
      ...overrides,
    });
  return { db, fenceToken, write, review, reader, request };
}

function connectorEvidence(state: "available" | "absent" | "degraded" | "unknown", terminal: boolean) {
  return decisionArtifact(`connector-${state}-${terminal}`, {
    evidenceKind: "connector",
    sourceKind: "connector",
    sourceRef: "connector:connector-review",
    relationKind: "supporting",
    relation: {
      relationRole: "connector_h0",
      workItemId: WORK_ITEM_ID,
      repoTargetId: TARGET_ID,
      h0CandidateSha: CANDIDATE_SHA,
      h0TreeDigest: H0_TREE_DIGEST,
      connectorId: "connector-review",
      state,
      terminal,
    },
  });
}

describe("bb-collab plugin boundary", () => {
  it("loads one CLI/RPC seam and refuses production apply before any write", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    const request = bootstrapRequest();
    const before = exportFoundation(db, PROJECT_ID);

    const rpc = await host.harness.callRpc("apply", request);
    expect(rpc).toMatchObject({ outcome: "OPERATOR_RECEIPT_REQUIRED", expected: 1, attempted: 0, verified: 0 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    const cli = await host.harness.runCli([
      "apply",
      "--project",
      PROJECT_ID,
      "--request",
      JSON.stringify(request),
    ]);
    expect(cli.exitCode).toBe(2);
    expect(JSON.parse(cli.stdout)).toMatchObject({ outcome: "OPERATOR_RECEIPT_REQUIRED" });
    expect(host.harness.inspection.registrations.services.map((service) => service.name)).toEqual(["lane-watcher"]);
    expect(host.harness.inspection.registrations.schedules).toEqual([]);
    expect(host.harness.inspection.registrations.rpcMethods.sort()).toEqual(["apply", "doctor", "export", "lanes", "operatorReceipt", "reorderPinned", "setSidebarCollapse", "setThreadState", "sidebarCollapseState", "threadModels", "threadStates"]);
  });

  it("authorizes exact interim receipts through the same RPC and CLI seam", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID, actorKind: "operator", subjectId: "operator-1" });
    const request = { ...bootstrapRequest(), candidateHead: CANDIDATE_SHA };
    const receipt = persistInterimOperatorReceipt(db, {
      projectId: PROJECT_ID,
      mutationClass: request.operationClass,
      candidateHead: CANDIDATE_SHA,
      idempotencyKey: request.idempotencyKey,
      requestDigest: operatorRequestDigest(request),
      callerThreadId: "operator-thread",
      requestedFromBackground: false,
      callerPluginId: PLUGIN_ID,
    }, 1);
    const authorized = { ...request, operatorReceiptId: receipt.receiptId };

    const rpc = await host.harness.callRpc("apply", authorized);
    expect(rpc).toMatchObject({ outcome: "OK", mutationReceipt: { operationClass: "bootstrap", operatorReceiptId: receipt.receiptId } });
    expect(db.prepare("SELECT operator_receipt_id FROM state_events WHERE project_id = ?").get(PROJECT_ID)).toEqual({ operator_receipt_id: receipt.receiptId });
    expect(db.prepare("SELECT operator_receipt_id FROM mutation_receipts WHERE project_id = ? AND idempotency_key = ?").get(PROJECT_ID, request.idempotencyKey)).toEqual({ operator_receipt_id: receipt.receiptId });
    expect(db.prepare("SELECT consumed_event_sequence FROM operator_receipts WHERE receipt_id = ?").get(receipt.receiptId)).toEqual({ consumed_event_sequence: 1 });
    const cli = await host.harness.runCli(["apply", "--project", PROJECT_ID, "--request", JSON.stringify(authorized)]);
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ outcome: "OK" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM state_events WHERE project_id = ?").get(PROJECT_ID)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE project_id = ?").get(PROJECT_ID)).toEqual({ count: 1 });
    const beforeReuse = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", { ...request, idempotencyKey: "bootstrap-distinct", operatorReceiptId: receipt.receiptId })).toMatchObject({ outcome: "OPERATOR_RECEIPT_REUSED" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeReuse);
  });

  it("cannot reuse one receipt for two migration steps", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    prepareMigration(db);
    const first = migrationStepRequest(db, "record_inventory", { proofDigest: sha256("inventory") });
    const authorizedRequest = { ...first, candidateHead: CANDIDATE_SHA };
    const receipt = persistInterimOperatorReceipt(db, {
      projectId: PROJECT_ID,
      mutationClass: "migration_step",
      candidateHead: CANDIDATE_SHA,
      idempotencyKey: first.idempotencyKey,
      requestDigest: operatorRequestDigest(authorizedRequest),
      callerThreadId: "operator-thread",
      requestedFromBackground: false,
      callerPluginId: PLUGIN_ID,
    }, 1);
    const authorized = { ...authorizedRequest, operatorReceiptId: receipt.receiptId };
    expect(await host.harness.callRpc("apply", authorized)).toMatchObject({ outcome: "OK" });
    const beforeSecond = exportFoundation(db, PROJECT_ID);
    const second = migrationStepRequest(db, "record_quiescence", { proofDigest: sha256("quiescence") }, { operatorReceiptId: receipt.receiptId, candidateHead: CANDIDATE_SHA });
    expect(await host.harness.callRpc("apply", second)).toMatchObject({ outcome: "OPERATOR_RECEIPT_REUSED" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeSecond);
  });

  it("replays a v7-era mutation receipt with its legacy digest", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
    const request = bootstrapRequest();
    const committed = applyFixtureMutation(db, request);
    expect(committed.outcome).toBe("OK");
    expect(legacyRequestDigest(request)).not.toBe(operatorRequestDigest(request));
    db.prepare("UPDATE mutation_receipts SET request_digest = ? WHERE project_id = ? AND idempotency_key = ?").run(legacyRequestDigest(request), PROJECT_ID, request.idempotencyKey);
    expect(applyFixtureMutation(db, request)).toEqual(committed);
  });

  it("refuses receipt-bound adapter reserve/finalize operations before any adapter call", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    const { fenceToken } = seedAssignmentDatabase(db);
    const prepAdapter = new DeterministicNativeAssignmentAdapter();
    const prepared = applyFixtureMutation(db, assignmentPrepareRequest(fenceToken), null, null, prepAdapter);
    const executionAttemptId = (prepared.evidence as { executionAttemptId: string }).executionAttemptId;
    const request = { ...assignmentPhaseRequest(fenceToken, "assignment_dispatch", "assignment-1", executionAttemptId), candidateHead: CANDIDATE_SHA };
    const receipt = persistInterimOperatorReceipt(db, {
      projectId: PROJECT_ID,
      mutationClass: "assignment_dispatch",
      candidateHead: CANDIDATE_SHA,
      idempotencyKey: request.idempotencyKey,
      requestDigest: operatorRequestDigest(request),
      callerThreadId: "operator-thread",
      requestedFromBackground: false,
      callerPluginId: PLUGIN_ID,
    }, 1);
    const before = exportFoundation(db, PROJECT_ID);
    const adapter = new DeterministicNativeAssignmentAdapter();
    expect(applyAuthorizedMutation(db, { ...request, operatorReceiptId: receipt.receiptId }, null, null, adapter)).toMatchObject({ outcome: "OPERATOR_RECEIPT_TWO_PHASE_UNSUPPORTED" });
    expect(adapter.dispatchCalls).toHaveLength(0);
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("refuses receipt-bound GitHub reserve/finalize before reservation or adapter mutation", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyFixtureMutation(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    const request = { ...projectionRequest(fenceToken, 1), candidateHead: CANDIDATE_SHA };
    const receipt = persistInterimOperatorReceipt(db, {
      projectId: PROJECT_ID,
      mutationClass: "github_issue_projection",
      candidateHead: CANDIDATE_SHA,
      idempotencyKey: request.idempotencyKey,
      requestDigest: operatorRequestDigest(request),
      callerThreadId: "operator-thread",
      requestedFromBackground: false,
      callerPluginId: PLUGIN_ID,
    }, 1);
    const before = exportFoundation(db, PROJECT_ID);
    const adapter = new DeterministicGitHubIssueAdapter();
    expect(applyAuthorizedMutation(db, { ...request, operatorReceiptId: receipt.receiptId }, adapter)).toMatchObject({ outcome: "OPERATOR_RECEIPT_TWO_PHASE_UNSUPPORTED" });
    expect(adapter.mutationCalls).toHaveLength(0);
    expect(adapter.readCalls).toHaveLength(0);
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("fixture-only projection window cannot append after receipt consumption", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyFixtureMutation(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    const request = { ...projectionRequest(fenceToken, 1), candidateHead: CANDIDATE_SHA };
    const receipt = persistInterimOperatorReceipt(db, {
      projectId: PROJECT_ID,
      mutationClass: "github_issue_projection",
      candidateHead: CANDIDATE_SHA,
      idempotencyKey: request.idempotencyKey,
      requestDigest: operatorRequestDigest(request),
      callerThreadId: "operator-thread",
      requestedFromBackground: false,
      callerPluginId: PLUGIN_ID,
    }, 1);
    const beforeEvents = (db.prepare("SELECT COUNT(*) AS count FROM state_events").get() as { count: number }).count;
    const beforeReceipts = (db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts").get() as { count: number }).count;
    const adapter = new DeterministicGitHubIssueAdapter();
    const result = applyFixtureMutation(db, { ...request, operatorReceiptId: receipt.receiptId }, adapter);
    expect(result.outcome).toBe("EXTERNAL_DELIVERY_AMBIGUOUS");
    expect(adapter.mutationCalls).toHaveLength(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM state_events").get() as { count: number }).count).toBe(beforeEvents + 1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts").get() as { count: number }).count).toBe(beforeReceipts);
    expect(db.prepare("SELECT consumed_event_sequence FROM operator_receipts WHERE receipt_id = ?").get(receipt.receiptId)).toEqual({ consumed_event_sequence: beforeEvents + 1 });
  });

  it("rejects every invalid receipt binding before any canonical write", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    const base = { ...bootstrapRequest(), candidateHead: CANDIDATE_SHA };
    const before = exportFoundation(db, PROJECT_ID);
    const receipt = (projectId: string, mutationClass: ApplyRequest["operationClass"], id: string) => persistInterimOperatorReceipt(db, {
      projectId,
      mutationClass,
      candidateHead: CANDIDATE_SHA,
      idempotencyKey: base.idempotencyKey,
      requestDigest: operatorRequestDigest(base),
      callerThreadId: `thread-${id}`,
      requestedFromBackground: false,
      callerPluginId: PLUGIN_ID,
    }, 1);

    expect((await host.harness.callRpc("apply", base) as FoundationResult).outcome).toBe("OPERATOR_RECEIPT_REQUIRED");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
    const foreign = receipt(FOREIGN_PROJECT_ID, "bootstrap", "foreign");
    expect((await host.harness.callRpc("apply", { ...base, operatorReceiptId: foreign.receiptId }) as FoundationResult).outcome).toBe("OPERATOR_RECEIPT_FOREIGN");
    const stale = receipt(PROJECT_ID, "bootstrap", "stale");
    expect((await host.harness.callRpc("apply", { ...base, operatorReceiptId: stale.receiptId, candidateHead: H1_CANDIDATE_SHA }) as FoundationResult).outcome).toBe("OPERATOR_RECEIPT_STALE");
    const mismatched = receipt(PROJECT_ID, "config_revision", "mismatch");
    expect((await host.harness.callRpc("apply", { ...base, operatorReceiptId: mismatched.receiptId }) as FoundationResult).outcome).toBe("OPERATOR_RECEIPT_STALE");
    const malformed = receipt(PROJECT_ID, "bootstrap", "malformed");
    db.prepare("UPDATE operator_receipts SET binding_digest = 'bad' WHERE receipt_id = ?").run(malformed.receiptId);
    expect((await host.harness.callRpc("apply", { ...base, operatorReceiptId: malformed.receiptId }) as FoundationResult).outcome).toBe("OPERATOR_RECEIPT_INVALID");
    const retired = receipt(PROJECT_ID, "bootstrap", "retired");
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE operator_receipts SET status = 'retired' WHERE receipt_id = ?").run(retired.receiptId);
    db.pragma("ignore_check_constraints = OFF");
    const beforeInvalidApplications = exportFoundation(db, PROJECT_ID);
    expect((await host.harness.callRpc("apply", { ...base, operatorReceiptId: retired.receiptId }) as FoundationResult).outcome).toBe("OPERATOR_RECEIPT_RETIRED");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeInvalidApplications);
    expect(db.prepare("SELECT COUNT(*) AS count FROM state_events WHERE project_id = ?").get(PROJECT_ID)).toEqual({ count: 0 });
  });

  it("proves fixture bootstrap, read-only doctor, deterministic export, and exact BB fact reads", async () => {
    const host = await loadedHost();
    const { db } = seedAndBootstrap(host);
    const changesBeforeDoctor = db.prepare("SELECT total_changes() AS count").get();

    const doctorResult = await host.harness.callRpc("doctor", { projectId: PROJECT_ID });
    expect(doctorResult).toMatchObject({ outcome: "OK", expected: 2, attempted: 2, verified: 2 });
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(changesBeforeDoctor);
    expect(host.harness.inspection.sdk.callsTo("system.version")).toHaveLength(1);
    expect(host.harness.inspection.sdk.callsTo("projects.get")).toEqual([[{ projectId: PROJECT_ID }]]);
    expect(host.harness.inspection.sdk.callsTo("hosts.get")).toEqual([[{ hostId: "host-main" }]]);

    const first = await host.harness.callRpc("export", { projectId: PROJECT_ID });
    const second = await host.harness.callRpc("export", { projectId: PROJECT_ID });
    expect(second).toEqual(first);
    expect(first).toMatchObject({ outcome: "OK", expected: 8, attempted: 8, verified: 8 });
    expect((first as { export: { manifest: { schemaVersion: number } } }).export.manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect((first as { export: { manifest: { migrationStatementIds: number[]; schemaDigest: string } } }).export.manifest.migrationStatementIds).toEqual(
      Array.from({ length: MIGRATIONS.length }, (_, index) => index),
    );
    expect((first as { export: { checksums: Record<string, string> } }).export.checksums).toHaveProperty("records.ndjson");
    expect((first as { export: ExportPayload }).export).toMatchObject({
      artifactIndex: [],
      checksums: { "artifact-index.json": sha256("[]") },
    });
  });

  it("returns a deterministic bounded result past the export row ceiling", () => {
    const { db, directory } = directDatabase();
    try {
      for (let index = 0; index <= MAX_EXPORT_ROWS; index += 1) {
        seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: `export-${index}` });
      }
      const first = exportFoundation(db, PROJECT_ID);
      const second = exportFoundation(db, PROJECT_ID);
      expect(first).toEqual(second);
      expect(first).toMatchObject({
        outcome: "EXPORT_BOUNDED",
        expected: MAX_EXPORT_ROWS + 1,
        attempted: MAX_EXPORT_ROWS + 1,
        verified: 0,
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("counts the derived artifact index against the existing export byte ceiling", () => {
    const { db, directory } = directDatabase();
    try {
      seedMigrationAuthority(db);
      seedEvidenceArtifact(db, "large-artifact", 270 * 1024);
      expect(exportFoundation(db, PROJECT_ID)).toMatchObject({ outcome: "EXPORT_BOUNDED", verified: 0 });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("appends the v8 one-request receipt columns and rolls every cached consumer forward", () => {
    expect(SCHEMA_VERSION).toBe(8);
    expect(CONTRACT_VERSION).toBe(3);
    expect(MIGRATIONS).toHaveLength(21);
    expect(sha256(MIGRATIONS.slice(0, -2).join("\n"))).toBe("97fd37424ea09eeb134998f57ae50f97e9b64c7e2fce877f1220e8194b05b774");
    expect(MIGRATIONS.at(-3)?.match(/CREATE UNIQUE INDEX/gu)).toHaveLength(2);
    expect(MIGRATIONS.at(-2)?.match(/CREATE TABLE/gu)).toHaveLength(1);
    expect(MIGRATIONS.at(-2)).toContain("operator_receipts");
    expect(MIGRATIONS.at(-1)).toContain("operator_receipt_id");
    expect(TABLES).toContain("migration_runs");
    expect(MIGRATION_STATES).toEqual([
      "prepared", "frozen", "exported", "imported", "equivalent", "target_active", "exercised", "retired", "rolled_back", "fix_forward_required",
    ]);
    expect(MIGRATION_STEPS).toEqual([
      "record_inventory", "record_quiescence", "freeze", "record_export", "record_import", "record_equivalence", "activate", "record_exercise", "retire", "rollback", "mark_fix_forward_required",
    ]);
    expect(cachedConsumerRolloutEvidence(7)).toMatchObject({ oldSchemaVersion: 7, newSchemaVersion: 8, action: "refused", expected: 4, attempted: 4, verified: 0 });
    expect(cachedConsumerRolloutEvidence(8)).toMatchObject({ oldSchemaVersion: 7, newSchemaVersion: 8, action: "reread", expected: 4, attempted: 4, verified: 4 });

    const { db, directory } = directDatabase();
    try {
      expect((db.prepare("PRAGMA table_info(migration_runs)").all() as Array<{ name: string }>).map((row) => row.name)).toEqual([
        "migration_id", "project_id", "source_system", "source_runtime_id", "target_runtime_id", "source_contract_digest", "source_schema_digest",
        "source_export_digest", "config_revision", "decision_id", "decision_disposition_sequence", "state", "resource_revision", "source_event_ceiling",
        "source_snapshot_digest", "source_governor_epoch", "target_governor_epoch", "mutator_inventory_digest", "quiescence_digest", "import_root_digest",
        "equivalence_digest", "recovery_digest", "retention_until_ms", "created_at_ms", "updated_at_ms",
      ]);
      expect((db.prepare("PRAGMA table_info(operator_receipts)").all() as Array<{ name: string }>).map((row) => row.name)).toEqual(expect.arrayContaining([
        "idempotency_key", "request_digest", "consumed_at_ms", "consumed_event_sequence",
      ]));
      expect((db.prepare("PRAGMA table_info(state_events)").all() as Array<{ name: string }>).map((row) => row.name)).toContain("operator_receipt_id");
      expect((db.prepare("PRAGMA table_info(mutation_receipts)").all() as Array<{ name: string }>).map((row) => row.name)).toContain("operator_receipt_id");
      expect((db.prepare("PRAGMA index_list(migration_runs)").all() as Array<{ name: string; unique: number; partial: number }>).filter((row) => row.name.startsWith("migration_runs_"))).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "migration_runs_final_export_identity", unique: 1, partial: 1 }),
        expect.objectContaining({ name: "migration_runs_one_open", unique: 1, partial: 1 }),
      ]));
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prepares one sanctioned run, binds adopted authority, and enforces open/final identities", () => {
    const { db, directory } = directDatabase();
    try {
      const governor = seedMigrationAuthority(db);
      const beforeRefusal = exportFoundation(db, PROJECT_ID);
      expect(applyWithFixtureReceipt(db, migrationPrepareRequest(governor, {
        idempotencyKey: "migration-unadopted",
        migration: { ...migrationPrepareRequest(governor).migration!, decisionDispositionSequence: 2 },
      })).outcome).toBe("INVALID_INPUT");
      expect(applyWithFixtureReceipt(db, migrationPrepareRequest(governor, {
        idempotencyKey: "migration-actor-missing",
        actorReceiptId: null,
      })).outcome).toBe("ACTOR_RECEIPT_REQUIRED");
      seedVerifiedFixtureReceipt(db, { projectId: FOREIGN_PROJECT_ID, receiptId: "migration-foreign-actor" });
      expect(applyWithFixtureReceipt(db, migrationPrepareRequest(governor, {
        idempotencyKey: "migration-actor-foreign",
        actorReceiptId: "migration-foreign-actor",
      })).outcome).toBe("ACTOR_RECEIPT_FOREIGN");
      expect(applyWithFixtureReceipt(db, migrationPrepareRequest(governor, {
        idempotencyKey: "migration-config-stale",
        expectedConfigRevision: 0,
      })).outcome).toBe("PROJECT_CONFIG_STALE");
      expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeRefusal);

      const request = migrationPrepareRequest(governor);
      const prepared = applyWithFixtureReceipt(db, request);
      expect(applyWithFixtureReceipt(db, request)).toEqual(prepared);
      expect(applyWithFixtureReceipt(db, { ...request, migration: { ...request.migration!, sourceRuntimeId: "conflict" } }).outcome).toBe("IDEMPOTENCY_KEY_CONFLICT");
      expect(db.prepare("SELECT state, resource_revision, source_export_digest, source_governor_epoch, target_governor_epoch FROM migration_runs").get()).toEqual({
        state: "prepared", resource_revision: 1, source_export_digest: null, source_governor_epoch: 2, target_governor_epoch: 1,
      });
      expect(currentGovernor(db)).toMatchObject({ governance_epoch: 2, state: "source_active" });

      expect(() => db.exec(`INSERT INTO migration_runs SELECT 'migration-open-2', project_id, source_system, source_runtime_id, target_runtime_id,
        source_contract_digest, source_schema_digest, source_export_digest, config_revision, decision_id, decision_disposition_sequence, state,
        resource_revision, source_event_ceiling, source_snapshot_digest, source_governor_epoch, target_governor_epoch, mutator_inventory_digest,
        quiescence_digest, import_root_digest, equivalence_digest, recovery_digest, retention_until_ms, created_at_ms, updated_at_ms FROM migration_runs`)).toThrow();
      const finalDigest = sha256("same-final-export");
      db.prepare("UPDATE migration_runs SET state = 'retired', source_export_digest = ? WHERE migration_id = ?").run(finalDigest, MIGRATION_ID);
      expect(() => db.exec(`INSERT INTO migration_runs SELECT 'migration-final-2', project_id, source_system, source_runtime_id, target_runtime_id,
        source_contract_digest, source_schema_digest, source_export_digest, config_revision, decision_id, decision_disposition_sequence, 'rolled_back',
        resource_revision, source_event_ceiling, source_snapshot_digest, source_governor_epoch, target_governor_epoch, mutator_inventory_digest,
        quiescence_digest, import_root_digest, equivalence_digest, recovery_digest, retention_until_ms, created_at_ms, updated_at_ms FROM migration_runs`)).toThrow();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs the closed lifecycle with exact replay/CAS, canonical export/import, and target-safe retirement", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    prepareMigration(db);
    const inventory = migrationStepRequest(db, "record_inventory", { proofDigest: sha256("inventory") });
    const recordedInventory = applyWithFixtureReceipt(db, inventory);
    expect(applyWithFixtureReceipt(db, inventory)).toEqual(recordedInventory);
    expect(applyWithFixtureReceipt(db, { ...inventory, migrationStep: { ...inventory.migrationStep!, proofDigest: sha256("inventory-conflict") } }).outcome).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "record_quiescence", { proofDigest: sha256("quiescence") }))).toMatchObject({ outcome: "OK", currentResourceRevision: 3 });

    const beforeForeignTarget = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "freeze", {
      repositoryTargetsDigest: sha256("foreign-targets"),
      canaries: { expected: 3, attempted: 3, verified: 3 },
    }, { idempotencyKey: "freeze-foreign-targets" }))).toMatchObject({ outcome: "IMPORT_EQUIVALENCE_FAILED" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeForeignTarget);

    const beforeIncomplete = exportFoundation(db, PROJECT_ID);
    const incomplete = migrationStepRequest(db, "freeze", { canaries: { expected: 3, attempted: 3, verified: 2 } });
    expect(applyWithFixtureReceipt(db, incomplete)).toMatchObject({ outcome: "SOURCE_FREEZE_UNPROVEN", expected: 3, attempted: 3, verified: 2 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeIncomplete);
    expect(db.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = ?").get(incomplete.idempotencyKey)).toBeUndefined();

    const stale = migrationStepRequest(db, "freeze", { canaries: { expected: 3, attempted: 3, verified: 3 } }, { expectedResourceRevision: 2, idempotencyKey: "freeze-stale-revision" });
    expect(applyWithFixtureReceipt(db, stale).outcome).toBe("RESOURCE_REVISION_STALE");
    const wrongToken = migrationStepRequest(db, "freeze", { canaries: { expected: 3, attempted: 3, verified: 3 } }, { expectedFenceToken: "wrong", idempotencyKey: "freeze-wrong-token" });
    expect(applyWithFixtureReceipt(db, wrongToken).outcome).toBe("GOVERNOR_EPOCH_STALE");
    expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "freeze", { canaries: { expected: 3, attempted: 3, verified: 3 } }))).toMatchObject({ outcome: "OK", currentResourceRevision: 4 });

    seedEvidenceArtifact(db, "evidence-z");
    seedEvidenceArtifact(db, "evidence-a");
    const firstExport = fixtureExport(db);
    expect(fixtureExport(db)).toEqual(firstExport);
    expect(firstExport.artifactIndex.map((artifact) => artifact.evidenceId)).toEqual(["evidence-a", "evidence-z"]);
    expect(firstExport.checksums).toEqual({
      "artifact-index.json": sha256(canonicalJson(firstExport.artifactIndex)),
      "manifest.json": sha256(canonicalJson(firstExport.manifest)),
      "records.ndjson": sha256(firstExport.recordsNdjson),
    });
    expect(firstExport.manifest).toMatchObject({ contractVersion: 3, contractDigest });
    const artifactImportCeiling = (db.prepare("SELECT MAX(event_sequence) AS ceiling FROM state_events WHERE project_id = ?").get(PROJECT_ID) as { ceiling: number }).ceiling;
    const beforeArtifactImportGuards = exportFoundation(db, PROJECT_ID);
    const secretMetadata = resealArtifactExport(firstExport, (artifact) => {
      artifact.redactedJson = canonicalJson({ secret: "fixture-secret" });
    });
    expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "record_export", {
      sourceEventCeiling: artifactImportCeiling,
      sourceSnapshotDigest: SOURCE_SNAPSHOT_DIGEST,
      export: secretMetadata,
    }, { idempotencyKey: "record-export-secret-metadata" }))).toMatchObject({ outcome: "EVIDENCE_REDACTION_INVALID" });
    const oversizedMetadata = resealArtifactExport(firstExport, (artifact) => {
      artifact.durableRefJson = canonicalJson({ metadata: "x".repeat(17 * 1024) });
    });
    expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "record_export", {
      sourceEventCeiling: artifactImportCeiling,
      sourceSnapshotDigest: SOURCE_SNAPSHOT_DIGEST,
      export: oversizedMetadata,
    }, { idempotencyKey: "record-export-oversized-metadata" }))).toMatchObject({ outcome: "EVIDENCE_REDACTION_INVALID" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeArtifactImportGuards);
    const invalidTransition = migrationStepRequest(db, "record_import", { proofDigest: sha256("invalid"), export: firstExport, importRootDigest: sha256("invalid") });
    expect(applyWithFixtureReceipt(db, invalidTransition).outcome).toBe("INVALID_INPUT");

    const invalidReference = structuredClone(firstExport);
    invalidReference.artifactIndex[0]!.durableRefJson = canonicalJson({ kind: "fixture", ref: "foreign-artifact" });
    invalidReference.manifest.artifactIndexDigest = sha256(canonicalJson(invalidReference.artifactIndex));
    const invalidRootInput = { ...invalidReference.manifest };
    delete (invalidRootInput as Partial<ExportPayload["manifest"]>).exportRootDigest;
    invalidReference.manifest.exportRootDigest = sha256(canonicalJson(invalidRootInput));
    invalidReference.checksums = {
      "artifact-index.json": invalidReference.manifest.artifactIndexDigest,
      "manifest.json": sha256(canonicalJson(invalidReference.manifest)),
      "records.ndjson": invalidReference.manifest.recordsDigest,
    };
    const beforeInvalidReference = exportFoundation(db, PROJECT_ID);
    const invalidReferenceCeiling = (db.prepare("SELECT MAX(event_sequence) AS ceiling FROM state_events WHERE project_id = ?").get(PROJECT_ID) as { ceiling: number }).ceiling;
    expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "record_export", {
      sourceEventCeiling: invalidReferenceCeiling,
      sourceSnapshotDigest: SOURCE_SNAPSHOT_DIGEST,
      export: invalidReference,
    }, { idempotencyKey: "record-export-invalid-reference" }))).toMatchObject({ outcome: "IMPORT_EQUIVALENCE_FAILED" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeInvalidReference);

    const exported = recordMigrationExport(db);
    const beforeInvalidImport = exportFoundation(db, PROJECT_ID);
    const invalidExport = structuredClone(exported);
    invalidExport.checksums["records.ndjson"] = sha256("tampered");
    expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "record_import", {
      proofDigest: sha256("invalid-import"), export: invalidExport, importRootDigest: sha256("invalid-import"),
    }))).toMatchObject({ outcome: "IMPORT_EQUIVALENCE_FAILED" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeInvalidImport);

    const importRootDigest = sha256(canonicalJson({
      sourceExportDigest: exported.manifest.exportRootDigest, targetRuntimeId: PLUGIN_ID, configRevision: 1, repositoryTargetsDigest: repositoryTargetsDigest(db),
    }));
    expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "record_import", { proofDigest: importRootDigest, export: exported, importRootDigest }))).toMatchObject({ outcome: "OK", currentResourceRevision: 6 });
    const wrongEquivalence = migrationStepRequest(db, "record_equivalence", { proofDigest: sha256("wrong-equivalence"), export: exported, equivalenceDigest: sha256("wrong-equivalence") });
    const beforeWrongEquivalence = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, wrongEquivalence).outcome).toBe("IMPORT_EQUIVALENCE_FAILED");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeWrongEquivalence);
    const equivalenceDigest = sha256(canonicalJson({
      sourceExportDigest: exported.manifest.exportRootDigest, importRootDigest, sourceSnapshotDigest: SOURCE_SNAPSHOT_DIGEST, repositoryTargetsDigest: repositoryTargetsDigest(db),
    }));
    expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "record_equivalence", { proofDigest: equivalenceDigest, export: exported, equivalenceDigest }))).toMatchObject({ outcome: "OK", currentResourceRevision: 7 });
    expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "activate"))).toMatchObject({ outcome: "OK", currentResourceRevision: 8 });
    expect(currentGovernor(db)).toMatchObject({ governance_epoch: 4, state: "target_active" });
    expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "record_exercise"))).toMatchObject({ outcome: "OK", currentResourceRevision: 9 });
    expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "retire"))).toMatchObject({ outcome: "OK", currentResourceRevision: 10 });
    expect(currentGovernor(db)).toMatchObject({ governance_epoch: 4, state: "target_active" });
    expect(db.prepare("SELECT state, resource_revision FROM migration_runs").get()).toEqual({ state: "retired", resource_revision: 10 });
    expect(db.prepare("SELECT DISTINCT event_type FROM state_events WHERE aggregate_type = 'migration_run'").all()).toEqual([{ event_type: "migration_run_changed" }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM state_events WHERE aggregate_type = 'migration_run'").get()).toEqual({ count: 10 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE operation_class IN ('migration_prepare', 'migration_step')").get()).toEqual({ count: 10 });
  });

  it("keeps pre-target rollback reversible and post-target recovery fix-forward only", () => {
    const before = directDatabase();
    try {
      prepareMigration(before.db);
      const recoveryDigest = sha256("pre-target-recovery");
      expect(applyWithFixtureReceipt(before.db, migrationStepRequest(before.db, "rollback", { proofDigest: recoveryDigest, recoveryDigest }))).toMatchObject({
        outcome: "OK", evidence: { state: "rolled_back" },
      });
      expect(currentGovernor(before.db)).toMatchObject({ state: "source_active", governance_epoch: 3 });
    } finally {
      before.db.close();
      rmSync(before.directory, { recursive: true, force: true });
    }

    const after = directDatabase();
    try {
      activateMigration(after.db);
      const targetHead = currentGovernor(after.db);
      const recoveryDigest = sha256("post-target-recovery");
      const rollback = migrationStepRequest(after.db, "rollback", { proofDigest: recoveryDigest, recoveryDigest });
      const fixForward = applyWithFixtureReceipt(after.db, rollback);
      expect(fixForward).toMatchObject({ outcome: "MIGRATION_FIX_FORWARD_REQUIRED", evidence: { state: "fix_forward_required" } });
      expect(applyWithFixtureReceipt(after.db, rollback)).toEqual(fixForward);
      expect(currentGovernor(after.db)).toEqual(targetHead);
      expect(after.db.prepare("SELECT state, recovery_digest FROM migration_runs").get()).toEqual({ state: "fix_forward_required", recovery_digest: recoveryDigest });
      expect(applyWithFixtureReceipt(after.db, migrationStepRequest(after.db, "rollback", { proofDigest: recoveryDigest, recoveryDigest })).outcome).toBe("INVALID_INPUT");
    } finally {
      after.db.close();
      rmSync(after.directory, { recursive: true, force: true });
    }
  });

  it("serializes prepare, freeze, and activate contenders across two real SQLite connections", () => {
    const { db: firstDb, path, directory } = directDatabase();
    const secondDb = new Database(path);
    databaseIsReady(secondDb);
    try {
      const governor = seedMigrationAuthority(firstDb);
      const prepareA = migrationPrepareRequest(governor, { idempotencyKey: "prepare-race-a" });
      const prepareB = migrationPrepareRequest(governor, { idempotencyKey: "prepare-race-b", migration: { ...migrationPrepareRequest(governor).migration!, migrationId: "migration-race-b" } });
      expect(applyWithFixtureReceipt(firstDb, prepareA).outcome).toBe("OK");
      expect(applyWithFixtureReceipt(secondDb, prepareB).outcome).toBe("GOVERNOR_EPOCH_STALE");
      expect(firstDb.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = 'prepare-race-b'").get()).toBeUndefined();

      expect(applyWithFixtureReceipt(firstDb, migrationStepRequest(firstDb, "record_inventory", { proofDigest: sha256("inventory") })).outcome).toBe("OK");
      expect(applyWithFixtureReceipt(firstDb, migrationStepRequest(firstDb, "record_quiescence", { proofDigest: sha256("quiescence") })).outcome).toBe("OK");
      const freezeA = migrationStepRequest(firstDb, "freeze", { canaries: { expected: 2, attempted: 2, verified: 2 } }, { idempotencyKey: "freeze-race-a" });
      const freezeB = { ...freezeA, idempotencyKey: "freeze-race-b" };
      const eventsBeforeFreeze = (firstDb.prepare("SELECT COUNT(*) AS count FROM state_events").get() as { count: number }).count;
      expect(applyWithFixtureReceipt(firstDb, freezeA).outcome).toBe("OK");
      expect(applyWithFixtureReceipt(secondDb, freezeB).outcome).toBe("RESOURCE_REVISION_STALE");
      expect(firstDb.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = 'freeze-race-b'").get()).toBeUndefined();
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM state_events").get()).toEqual({ count: eventsBeforeFreeze + 1 });

      const exported = recordMigrationExport(firstDb);
      const importRootDigest = sha256(canonicalJson({ sourceExportDigest: exported.manifest.exportRootDigest, targetRuntimeId: PLUGIN_ID, configRevision: 1, repositoryTargetsDigest: repositoryTargetsDigest(firstDb) }));
      expect(applyWithFixtureReceipt(firstDb, migrationStepRequest(firstDb, "record_import", { proofDigest: importRootDigest, export: exported, importRootDigest })).outcome).toBe("OK");
      const equivalenceDigest = sha256(canonicalJson({ sourceExportDigest: exported.manifest.exportRootDigest, importRootDigest, sourceSnapshotDigest: SOURCE_SNAPSHOT_DIGEST, repositoryTargetsDigest: repositoryTargetsDigest(firstDb) }));
      expect(applyWithFixtureReceipt(firstDb, migrationStepRequest(firstDb, "record_equivalence", { proofDigest: equivalenceDigest, export: exported, equivalenceDigest })).outcome).toBe("OK");
      const activateA = migrationStepRequest(firstDb, "activate", {}, { idempotencyKey: "activate-race-a" });
      const activateB = { ...activateA, idempotencyKey: "activate-race-b" };
      const eventsBeforeActivate = (firstDb.prepare("SELECT COUNT(*) AS count FROM state_events").get() as { count: number }).count;
      expect(applyWithFixtureReceipt(firstDb, activateA).outcome).toBe("OK");
      expect(applyWithFixtureReceipt(secondDb, activateB).outcome).toBe("RESOURCE_REVISION_STALE");
      expect(firstDb.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = 'activate-race-b'").get()).toBeUndefined();
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM state_events").get()).toEqual({ count: eventsBeforeActivate + 1 });
    } finally {
      secondDb.close();
      firstDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reopens byte-identical at prepared, frozen, and target-active fixture boundaries", () => {
    for (const stage of ["prepared", "frozen", "target_active"] as const) {
      const fixture = directDatabase();
      let reopened: Database.Database | null = null;
      try {
        if (stage === "prepared") prepareMigration(fixture.db);
        if (stage === "frozen") freezeMigration(fixture.db);
        if (stage === "target_active") activateMigration(fixture.db);
        const before = exportFoundation(fixture.db, PROJECT_ID);
        fixture.db.close();
        reopened = new Database(fixture.path);
        databaseIsReady(reopened);
        expect(reopened.prepare("SELECT state FROM migration_runs").get()).toEqual({ state: stage });
        expect(exportFoundation(reopened, PROJECT_ID)).toEqual(before);
      } finally {
        reopened?.close();
        if (fixture.db.open) fixture.db.close();
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    }
  });

  it("doctor reports the active run, expired retention, and unresolved proof without writing", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    prepareMigration(db);
    db.prepare("UPDATE migration_runs SET retention_until_ms = 0 WHERE migration_id = ?").run(MIGRATION_ID);
    const changes = db.prepare("SELECT total_changes() AS count").get();
    expect(await host.harness.callRpc("doctor", { projectId: PROJECT_ID })).toMatchObject({
      outcome: "OK",
      evidence: {
        activeMigrationRun: { migration_id: MIGRATION_ID, state: "prepared", retentionExpired: true, unresolvedProof: ["mutator_inventory", "quiescence"] },
      },
    });
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
  });

  it("rejects stale config without changing any foundation bytes", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    const before = exportFoundation(db, PROJECT_ID);
    const stale = applyWithFixtureReceipt(db, {
      ...bootstrapRequest(),
      operationClass: "config_revision",
      idempotencyKey: "config-stale",
      expectedConfigRevision: 0,
      configRevision: 1,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
      config: { permissionMode: "auto" },
      targets: [{ ...bootstrapRequest().targets![0]!, defaultBranch: "develop" }],
    });
    expect(stale.outcome).toBe("PROJECT_CONFIG_STALE");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("rejects wrong governor epochs and tokens without writes", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    const before = exportFoundation(db, PROJECT_ID);
    const request = {
      ...bootstrapRequest(),
      operationClass: "config_revision" as const,
      expectedConfigRevision: 1,
      configRevision: 2,
      config: { permissionMode: "auto", visibility: "visible", repositoryTargets: [TARGET_ID] },
      targets: [{ ...bootstrapRequest().targets![0]!, defaultBranch: "develop" }],
    };
    const wrongEpoch = applyWithFixtureReceipt(db, {
      ...request,
      idempotencyKey: "governor-wrong-epoch",
      expectedGovernanceEpoch: 99,
      expectedFenceToken: fenceToken,
    });
    expect(wrongEpoch.outcome).toBe("GOVERNOR_EPOCH_STALE");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    const wrongToken = applyWithFixtureReceipt(db, {
      ...request,
      idempotencyKey: "governor-wrong-token",
      expectedGovernanceEpoch: 1,
      expectedFenceToken: "wrong-token",
    });
    expect(wrongToken.outcome).toBe("GOVERNOR_EPOCH_STALE");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("returns the original receipt on duplicate idempotency and refuses conflicting reuse", async () => {
    const host = await loadedHost();
    const { db, request } = seedAndBootstrap(host);
    const replay = applyWithFixtureReceipt(db, request);
    expect(replay).toEqual(applyWithFixtureReceipt(db, request));

    const beforeConflict = exportFoundation(db, PROJECT_ID);
    const conflict = applyWithFixtureReceipt(db, {
      ...request,
      config: { permissionMode: "auto", different: true },
    });
    expect(conflict.outcome).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeConflict);
    expect(db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts").get()).toEqual({ count: 1 });
  });

  it("rejects missing, unknown, and foreign actor receipts before bootstrap mutation", async () => {
    const missingHost = await loadedHost();
    const missingDb = missingHost.bb.storage.database();
    const missing = applyWithFixtureReceipt(missingDb, bootstrapRequest(PROJECT_ID, { actorReceiptId: null }));
    expect(missing.outcome).toBe("ACTOR_RECEIPT_REQUIRED");
    expect(missingDb.prepare("SELECT COUNT(*) AS count FROM project_config_revisions").get()).toEqual({ count: 0 });

    const unknownHost = await loadedHost();
    const unknownDb = unknownHost.bb.storage.database();
    const unknown = applyWithFixtureReceipt(unknownDb, bootstrapRequest(PROJECT_ID, { actorReceiptId: "missing" }));
    expect(unknown.outcome).toBe("ACTOR_RECEIPT_UNKNOWN");
    expect(unknownDb.prepare("SELECT COUNT(*) AS count FROM state_events").get()).toEqual({ count: 0 });

    const foreignHost = await loadedHost();
    const foreignDb = foreignHost.bb.storage.database();
    seedVerifiedFixtureReceipt(foreignDb, { projectId: FOREIGN_PROJECT_ID, receiptId: RECEIPT_ID });
    const foreign = applyWithFixtureReceipt(foreignDb, bootstrapRequest(PROJECT_ID));
    expect(foreign.outcome).toBe("ACTOR_RECEIPT_FOREIGN");
    expect(foreignDb.prepare("SELECT COUNT(*) AS count FROM project_config_heads").get()).toEqual({ count: 0 });
  });

  it("reports canonical-store unavailability without attempting a write", () => {
    expect(applyFixtureMutation(null, bootstrapRequest())).toMatchObject({
      outcome: "CANONICAL_STORE_UNAVAILABLE",
      expected: 1,
      attempted: 0,
      verified: 0,
    });
  });

  it("reports an unknown BB project without changing the real SQLite state", async () => {
    const { db, directory } = directDatabase();
    try {
      const before = exportFoundation(db, PROJECT_ID);
      const result = await doctor(
        db,
        {
          system: {
            version: async () => ({
              currentVersion: "0.37.0",
              latestVersion: "0.37.0",
              source: "npm" as const,
              updateAvailable: false,
              isDevelopment: false,
              upgradeCommand: "npx bb-app@latest",
            }),
          },
          projects: { get: async () => { throw new Error("unknown project"); } },
          hosts: { get: async () => { throw new Error("not reached"); } },
        },
        PROJECT_ID,
      );
      expect(result.outcome).toBe("PROJECT_UNKNOWN");
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports an incomplete governor head as unavailable without mutation", () => {
    const { db, directory } = directDatabase();
    try {
      seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      const configJson = canonicalJson({ permissionMode: "full", visibility: "visible" });
      db.prepare(
        `INSERT INTO project_config_revisions
          (project_id, config_revision, canonical_config_json, config_digest, created_at_ms)
         VALUES (?, 1, ?, ?, 1)`,
      ).run(PROJECT_ID, configJson, sha256(configJson));
      db.prepare(
        "INSERT INTO project_config_heads (project_id, config_revision, updated_at_ms) VALUES (?, 1, 1)",
      ).run(PROJECT_ID);
      // Test-only corrupt-state fixture: no sanctioned issue #3 operation creates a config without a governor head.
      const before = exportFoundation(db, PROJECT_ID);
      const result = applyFixtureMutation(db, {
        ...bootstrapRequest(),
        operationClass: "config_revision",
        idempotencyKey: "governor-missing",
        expectedConfigRevision: 1,
        configRevision: 2,
        expectedGovernanceEpoch: 1,
        expectedFenceToken: "missing",
        config: { permissionMode: "auto", visibility: "visible", repositoryTargets: [TARGET_ID] },
        targets: [{ ...bootstrapRequest().targets![0]!, defaultBranch: "develop" }],
      });
      expect(result.outcome).toBe("GOVERNOR_UNAVAILABLE");
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records the frozen cutover outcome as deferred for issue #3", () => {
    expect(DEFERRED_ISSUE_3_OUTCOMES).toEqual(["PROJECT_FROZEN"]);
  });

  it("serializes two real SQLite governorship contenders and leaves no loser receipt or event", async () => {
    const { db: firstDb, path, directory } = directDatabase();
    const secondDb = new Database(path);
    databaseIsReady(secondDb);
    try {
      seedVerifiedFixtureReceipt(firstDb, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      seedVerifiedFixtureReceipt(firstDb, { projectId: PROJECT_ID, receiptId: "receipt-second" });
      const firstBootstrap = applyFixtureMutation(firstDb, bootstrapRequest());
      const fenceToken = (firstBootstrap.evidence as { fenceToken: string }).fenceToken;
      const baseClaim = {
        projectId: PROJECT_ID,
        operationClass: "governor_claim" as const,
        actorReceiptId: RECEIPT_ID,
        expectedConfigRevision: 1,
        expectedGovernanceEpoch: 1,
        expectedFenceToken: fenceToken,
        runtimeId: "runtime-a",
      };
      // better-sqlite3 calls are synchronous; BEGIN IMMEDIATE serializes contenders, so the second connection observes the winner's stale epoch/token.
      const winner = applyFixtureMutation(firstDb, { ...baseClaim, idempotencyKey: "claim-a" });
      const loser = applyFixtureMutation(secondDb, {
        ...baseClaim,
        actorReceiptId: "receipt-second",
        idempotencyKey: "claim-b",
        runtimeId: "runtime-b",
      });
      expect(winner.outcome).toBe("OK");
      expect(loser.outcome).toBe("GOVERNOR_CAS_FAILED");
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM project_governorship_heads").get()).toEqual({ count: 1 });
      expect(firstDb.prepare("SELECT governance_epoch FROM project_governorship_heads").get()).toEqual({ governance_epoch: 2 });
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM mutation_receipts").get()).toEqual({ count: 2 });
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM state_events").get()).toEqual({ count: 2 });
      expect(firstDb.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = 'claim-b'").get()).toBeUndefined();
    } finally {
      secondDb.close();
      firstDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps disposition history append-only and rejects stale resource revisions", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, {
      config: roleConfig(),
      decision: {
        decisionId: "decision-1",
        repoTargetId: TARGET_ID,
        scope: { operation: "review" },
        decisionClass: "assignment_admission",
        options: {},
        resourceRevision: 1,
      },
    });
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken), null, roleReader()).outcome).toBe("OK");
    const succession = applyWithFixtureReceipt(db, successionRequest(fenceToken), null, roleReader());
    const holderExecutionAttemptId = (succession.evidence as { holderExecutionAttemptId: string }).holderExecutionAttemptId;
    seedVerifiedFixtureReceipt(db, {
      projectId: PROJECT_ID,
      receiptId: "role-actor-decision",
      actorKind: "role",
      subjectId: holderExecutionAttemptId,
      roleId: "project-orchestrator",
      roleGeneration: 1,
    });
    const first = applyWithFixtureReceipt(db, {
      projectId: PROJECT_ID,
      operationClass: "decision_disposition",
      idempotencyKey: "disposition-1",
      actorReceiptId: "role-actor-decision",
      expectedConfigRevision: 1,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
      repoTargetId: TARGET_ID,
      decisionId: "decision-1",
      disposition: "adopted",
      expectedResourceRevision: 1,
      reason: { source: "fixture" },
    });
    expect(first.outcome).toBe("OK");
    const stale = applyWithFixtureReceipt(db, {
      projectId: PROJECT_ID,
      operationClass: "decision_disposition",
      idempotencyKey: "disposition-stale",
      actorReceiptId: "role-actor-decision",
      expectedConfigRevision: 1,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
      repoTargetId: TARGET_ID,
      decisionId: "decision-1",
      disposition: "rejected",
      expectedResourceRevision: 1,
      reason: { source: "stale" },
    });
    expect(stale.outcome).toBe("RESOURCE_REVISION_STALE");
    expect(db.prepare("SELECT disposition_sequence FROM decision_dispositions").all()).toEqual([{ disposition_sequence: 1 }]);
  });

  it("creates immutable typed Decisions and keeps helper, Pro, legacy, and fixture receipts evidence-only", async () => {
    const { db, fenceToken } = await assignmentFixture();
    const create = decisionCreateRequest(fenceToken);
    const created = applyWithFixtureReceipt(db, create);
    expect(created).toMatchObject({ outcome: "OK", currentResourceRevision: 1 });
    expect(applyWithFixtureReceipt(db, create)).toEqual(created);

    const beforeDrift = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken, "decision-v5", {
      idempotencyKey: "create-decision-v5-drift",
      decision: { ...create.decision!, options: { mode: "different" } },
    })).outcome).toBe("DECISION_IDENTITY_CONFLICT");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeDrift);
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken, "decision-class-unknown", {
      idempotencyKey: "create-decision-class-unknown",
      decision: { ...create.decision!, decisionId: "decision-class-unknown", decisionClass: "unknown_class" },
    })).outcome).toBe("DECISION_CLASS_UNKNOWN");

    for (const actorKind of ["fixture", "helper", "pro", "legacy"] as const) {
      const receiptId = `decision-${actorKind}`;
      seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId, actorKind });
      const before = exportFoundation(db, PROJECT_ID);
      expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 1, {
        idempotencyKey: `disposition-${actorKind}`,
        actorReceiptId: receiptId,
      })).outcome).toBe("ACTOR_RECEIPT_UNVERIFIED");
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
    }

    const helper = decisionArtifact("evidence-helper");
    const pro = decisionArtifact("evidence-pro", { sourceKind: "pro" });
    const disposition = decisionDispositionRequest(fenceToken, "decision-v5", 1, {
      conditions: [{ kind: "evidence_required", evidenceIds: [helper.evidenceId, pro.evidenceId] }],
      decisionEvidence: [helper, pro],
    });
    const adopted = applyWithFixtureReceipt(db, disposition);
    expect(adopted).toMatchObject({ outcome: "OK", currentResourceRevision: 2, evidence: { evidenceIds: [helper.evidenceId, pro.evidenceId] } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM evidence_artifacts").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM decision_evidence").get()).toEqual({ count: 2 });
    expect((db.prepare("PRAGMA table_info(evidence_artifacts)").all() as Array<{ name: string }>).map((row) => row.name)).not.toContain("actor_receipt_id");
    expect((db.prepare("PRAGMA table_info(decision_evidence)").all() as Array<{ name: string }>).map((row) => row.name)).not.toContain("actor_receipt_id");

    const legacy = decisionArtifact("evidence-legacy", {
      evidenceKind: "legacy_claim",
      sourceKind: "legacy_claim",
      sourceRef: "legacy:accepted_by",
      redactedJson: canonicalJson({ accepted_by: "legacy-harness-name", unresolved: true }),
      relationKind: "legacy_claim",
      relation: { authorityEffect: "none" },
    });
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 2, {
      idempotencyKey: "disposition-reuse-artifact",
      disposition: "rejected",
      decisionEvidence: [helper, legacy],
    })).outcome).toBe("OK");
    expect(db.prepare("SELECT COUNT(*) AS count FROM evidence_artifacts").get()).toEqual({ count: 3 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM decision_evidence").get()).toEqual({ count: 4 });
    expect(db.prepare("SELECT evidence_kind, source_kind, redacted_json FROM evidence_artifacts WHERE evidence_id = ?").get(legacy.evidenceId)).toEqual({
      evidence_kind: "legacy_claim",
      source_kind: "legacy_claim",
      redacted_json: legacy.redactedJson,
    });
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken, "decision-reuse", {
      idempotencyKey: "create-decision-reuse",
      decision: { ...create.decision!, decisionId: "decision-reuse" },
    })).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-reuse", 1, {
      idempotencyKey: "disposition-cross-decision-reuse",
      disposition: "rejected",
      decisionEvidence: [helper],
    })).outcome).toBe("OK");
    expect(db.prepare("SELECT COUNT(*) AS count FROM evidence_artifacts").get()).toEqual({ count: 3 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM decision_evidence").get()).toEqual({ count: 5 });

    const beforeConflict = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 3, {
      idempotencyKey: "disposition-evidence-conflict",
      disposition: "rejected",
      decisionEvidence: [{ ...helper, contentDigest: sha256("different") }],
    })).outcome).toBe("EVIDENCE_IDENTITY_CONFLICT");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeConflict);
    expect(applyWithFixtureReceipt(db, { ...disposition, reason: { mechanism: "changed" } }).outcome).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("requires the current qualified role holder for Decision authority", async () => {
    const { db, fenceToken, holderExecutionAttemptId } = await assignmentFixture();
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken)).outcome).toBe("OK");
    seedVerifiedFixtureReceipt(db, {
      projectId: PROJECT_ID,
      receiptId: "role-wrong-generation",
      actorKind: "role",
      subjectId: holderExecutionAttemptId,
      roleId: "project-orchestrator",
      roleGeneration: 2,
    });
    seedVerifiedFixtureReceipt(db, {
      projectId: PROJECT_ID,
      receiptId: "role-wrong-holder",
      actorKind: "role",
      subjectId: "foreign-holder",
      roleId: "project-orchestrator",
      roleGeneration: 1,
    });
    for (const [receiptId, outcome] of [["role-wrong-generation", "ROLE_GENERATION_STALE"], ["role-wrong-holder", "ROLE_HOLDER_MISMATCH"]]) {
      const before = exportFoundation(db, PROJECT_ID);
      expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 1, {
        idempotencyKey: `disposition-${receiptId}`,
        actorReceiptId: receiptId,
      })).outcome).toBe(outcome);
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
    }
    db.prepare("UPDATE eligibility_projections SET effective_status = 'ineligible' WHERE role_requirement_id = 'orchestrator-v1'").run();
    const beforeUnqualified = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 1, {
      idempotencyKey: "disposition-unqualified-role",
    })).outcome).toBe("ROLE_UNQUALIFIED");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeUnqualified);
    db.prepare("UPDATE eligibility_projections SET effective_status = 'eligible' WHERE role_requirement_id = 'orchestrator-v1'").run();
    db.prepare("UPDATE role_generations SET status = 'retired' WHERE role_id = 'project-orchestrator' AND generation = 1").run();
    const beforeRetired = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 1, {
      idempotencyKey: "disposition-retired-role",
    })).outcome).toBe("ROLE_NOT_ACTIVE");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeRetired);
  });

  it("keeps review Decision authority with the project orchestrator and the reviewer evidence-only", async () => {
    const { db, fenceToken } = await assignmentFixture();
    activateReviewer(db, fenceToken);
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "in_progress", 2)).outcome).toBe("OK");
    const create = reviewDecisionCreateRequest(fenceToken, "optional", "review-decision", {
      idempotencyKey: "create-review-decision-reviewer",
      actorReceiptId: "role-actor-reviewer",
    });
    const beforeReviewerCreate = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, create).outcome).toBe("ROLE_HOLDER_MISMATCH");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeReviewerCreate);

    expect(applyWithFixtureReceipt(db, {
      ...create,
      idempotencyKey: "create-review-decision-orchestrator",
      actorReceiptId: "role-actor-assignment",
    }).outcome).toBe("OK");
    const beforeReviewerDisposition = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "review-decision", 1, {
      idempotencyKey: "reject-review-decision-reviewer",
      actorReceiptId: "role-actor-reviewer",
      disposition: "rejected",
    })).outcome).toBe("ROLE_HOLDER_MISMATCH");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeReviewerDisposition);
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "review-decision", 1, {
      idempotencyKey: "reject-review-decision-orchestrator",
      disposition: "rejected",
    })).outcome).toBe("OK");
  });

  it("derives holds and validates supersede and revert references without editing history", async () => {
    const { db, fenceToken } = await assignmentFixture();
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken)).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 1, {
      disposition: "proposed",
      holdAction: "set",
      holdCode: "operator-review",
    })).outcome).toBe("OK");
    const held = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 2, {
      idempotencyKey: "adopt-while-held",
    })).outcome).toBe("DECISION_DISPOSITION_INVALID");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(held);
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 2, {
      idempotencyKey: "clear-hold",
      disposition: "rejected",
      holdAction: "clear",
      holdCode: "operator-review",
      holdReferenceSequence: 1,
    })).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 3, {
      idempotencyKey: "adopt-after-clear",
    })).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 4, {
      idempotencyKey: "supersede-adoption",
      disposition: "superseded",
      supersedesDispositionSequence: 3,
    })).outcome).toBe("OK");
    const beforeRepeatedSupersede = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 5, {
      idempotencyKey: "repeat-supersede",
      disposition: "superseded",
      supersedesDispositionSequence: 3,
    })).outcome).toBe("DECISION_REFERENCE_INVALID");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeRepeatedSupersede);
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 5, {
      idempotencyKey: "adopt-for-revert",
    })).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 6, {
      idempotencyKey: "revoke-exact",
      disposition: "revoked",
      revertsDispositionSequence: 5,
    })).outcome).toBe("OK");
    const beforeRepeatedRevert = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 7, {
      idempotencyKey: "repeat-revert",
      disposition: "revoked",
      revertsDispositionSequence: 5,
    })).outcome).toBe("DECISION_REFERENCE_INVALID");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeRepeatedRevert);
    expect(db.prepare("SELECT disposition_sequence, disposition FROM decision_dispositions ORDER BY disposition_sequence").all()).toEqual([
      { disposition_sequence: 1, disposition: "proposed" },
      { disposition_sequence: 2, disposition: "rejected" },
      { disposition_sequence: 3, disposition: "adopted" },
      { disposition_sequence: 4, disposition: "superseded" },
      { disposition_sequence: 5, disposition: "adopted" },
      { disposition_sequence: 6, disposition: "revoked" },
    ]);
  });

  it("refuses malformed, raw, secret-like, oversized, and unsatisfied Decision evidence", async () => {
    const { db, fenceToken } = await assignmentFixture();
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken)).outcome).toBe("OK");
    const base = decisionArtifact("bad-evidence");
    const cases: Array<[string, NonNullable<ApplyRequest["decisionEvidence"]>[number], string]> = [
      ["malformed", { ...base, redactedJson: "{" }, "MALFORMED_JSON"],
      ["noncanonical", { ...base, redactedJson: "{\"z\":1,\"a\":2}" }, "EVIDENCE_REDACTION_INVALID"],
      ["secret", { ...base, redactedJson: canonicalJson({ apiToken: "hidden" }) }, "EVIDENCE_REDACTION_INVALID"],
      ["raw", { ...base, redactedJson: canonicalJson({ rawOutput: "worker bytes" }) }, "EVIDENCE_REDACTION_INVALID"],
      ["oversized", { ...base, redactedJson: canonicalJson({ summary: "x".repeat(17 * 1024) }) }, "EVIDENCE_REDACTION_INVALID"],
    ];
    for (const [name, evidence, outcome] of cases) {
      const before = exportFoundation(db, PROJECT_ID);
      expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 1, {
        idempotencyKey: `bad-evidence-${name}`,
        decisionEvidence: [evidence],
      })).outcome, name).toBe(outcome);
      expect(exportFoundation(db, PROJECT_ID), name).toEqual(before);
    }
    const beforeMissing = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 1, {
      idempotencyKey: "missing-condition-evidence",
      conditions: [{ kind: "evidence_required", evidenceIds: ["missing"] }],
    })).outcome).toBe("EVIDENCE_REQUIRED");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeMissing);
  });

  it("binds delegated Decision evidence only to one exact successful terminal Assignment attempt", async () => {
    const { db, fenceToken } = await assignmentFixture();
    const adapter = new DeterministicNativeAssignmentAdapter();
    const prepared = applyWithFixtureReceipt(db, assignmentPrepareRequest(fenceToken), null, null, adapter);
    const executionAttemptId = (prepared.evidence as { executionAttemptId: string }).executionAttemptId;
    const delivered = applyWithFixtureReceipt(
      db,
      assignmentPhaseRequest(fenceToken, "assignment_dispatch", "assignment-1", executionAttemptId),
      null,
      null,
      adapter,
    );
    const native = delivered.evidence as { nativeReceiptDigest: string; actualProfileDigest: string; threadId: string };
    const terminal = applyWithFixtureReceipt(
      db,
      assignmentPhaseRequest(fenceToken, "assignment_terminal", "assignment-1", executionAttemptId, {
        terminalReport: assignmentTerminalReport("assignment-1", executionAttemptId, native),
      }),
      null,
      null,
      adapter,
    );
    const terminalDigest = (terminal.evidence as { terminalReportDigest: string }).terminalReportDigest;
    expect(terminal.outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken)).outcome).toBe("OK");
    const delegated = decisionArtifact("delegated-done", {
      evidenceKind: "delegated_action_receipt",
      sourceKind: "delegated_action",
      sourceRef: `execution:${executionAttemptId}`,
      assignmentId: "assignment-1",
      executionAttemptId,
      contentDigest: terminalDigest,
      redactedJson: canonicalJson({ outcome: "DONE" }),
      durableRefJson: canonicalJson({ assignmentId: "assignment-1", executionAttemptId }),
      relationKind: "delegated_action_receipt",
      terminalReportDigest: terminalDigest,
      actualProfileDigest: native.actualProfileDigest,
      nativeReceiptDigest: native.nativeReceiptDigest,
    });
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 1, {
      conditions: [{ kind: "evidence_required", evidenceIds: [delegated.evidenceId] }],
      decisionEvidence: [delegated],
    })).outcome).toBe("OK");
    expect(db.prepare("SELECT evidence_id, disposition_sequence FROM decision_evidence").all()).toEqual([
      { evidence_id: delegated.evidenceId, disposition_sequence: 1 },
    ]);

    const negativeCases: Array<[string, Partial<typeof delegated>, string]> = [
      ["assignment", { assignmentId: "foreign-assignment" }, "EXECUTION_CONTEXT_FOREIGN"],
      ["terminal", { contentDigest: sha256("wrong"), terminalReportDigest: sha256("wrong") }, "EXECUTION_CONTEXT_FOREIGN"],
      ["profile", { actualProfileDigest: sha256("wrong") }, "EXECUTION_PROFILE_MISMATCH"],
      ["native", { nativeReceiptDigest: sha256("wrong") }, "EXECUTION_CONTEXT_FOREIGN"],
    ];
    for (const [name, override, outcome] of negativeCases) {
      const before = exportFoundation(db, PROJECT_ID);
      expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 2, {
        idempotencyKey: `delegated-negative-${name}`,
        disposition: "rejected",
        decisionEvidence: [{ ...delegated, evidenceId: `delegated-${name}`, ...override }],
      })).outcome, name).toBe(outcome);
      expect(exportFoundation(db, PROJECT_ID), name).toEqual(before);
    }

    for (const [name, column, value, outcome] of [
      ["dispatch", "state", "dispatch_unknown", "DISPATCH_UNKNOWN"],
      ["blocked", "state", "blocked", "TERMINAL_REPORT_REQUIRED"],
      ["failed", "state", "failed", "TERMINAL_REPORT_REQUIRED"],
      ["nonterminal", "state", "running", "TERMINAL_REPORT_REQUIRED"],
      ["conflict", "conflicting_terminal_digest", sha256("conflict"), "TERMINAL_REPORT_AMBIGUOUS"],
    ] as const) {
      const original = (db.prepare(`SELECT ${column} AS value FROM execution_attempts WHERE execution_attempt_id = ?`).get(executionAttemptId) as { value: unknown }).value;
      db.prepare(`UPDATE execution_attempts SET ${column} = ? WHERE execution_attempt_id = ?`).run(value, executionAttemptId);
      const before = exportFoundation(db, PROJECT_ID);
      expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 2, {
        idempotencyKey: `delegated-state-${name}`,
        disposition: "rejected",
        decisionEvidence: [{ ...delegated, evidenceId: `delegated-state-${name}` }],
      })).outcome, name).toBe(outcome);
      expect(exportFoundation(db, PROJECT_ID), name).toEqual(before);
      db.prepare(`UPDATE execution_attempts SET ${column} = ? WHERE execution_attempt_id = ?`).run(original, executionAttemptId);
    }
  });

  it("requires exact terminal review Assignment evidence for review adjudication", async () => {
    const { db, fenceToken } = await assignmentFixture();
    activateReviewer(db, fenceToken);
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "in_progress", 2)).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, reviewDecisionCreateRequest(fenceToken, "optional", "review-evidence-decision"))).toMatchObject({ outcome: "OK" });

    const write = completeFixtureAssignment(db, fenceToken, { assignmentKind: "write", assignmentId: "write-assignment", candidateSha: CANDIDATE_SHA });
    const review = completeFixtureAssignment(db, fenceToken, { assignmentKind: "review", assignmentId: "review-assignment", candidateSha: CANDIDATE_SHA });
    const probe = completeFixtureAssignment(db, fenceToken, { assignmentKind: "probe", assignmentId: "probe-assignment", candidateSha: CANDIDATE_SHA });
    const reader = new DeterministicReviewFactReader();
    reader.facts = {
      projectId: PROJECT_ID,
      workItemId: WORK_ITEM_ID,
      repoTargetId: TARGET_ID,
      writeAssignmentId: write.assignmentId,
      writeExecutionAttemptId: write.executionAttemptId,
      branchName: `bb/${write.assignmentId}`,
      baseSha: BASE_SHA,
      candidateSha: CANDIDATE_SHA,
      treeDigest: H0_TREE_DIGEST,
      changedFiles: REVIEW_FILES,
      authors: REVIEW_AUTHORS,
      committers: REVIEW_COMMITTERS,
    };
    review.evidence.relation = {
      relationRole: "final_review",
      workItemId: WORK_ITEM_ID,
      repoTargetId: TARGET_ID,
      configRevision: 1,
      baseSha: BASE_SHA,
      candidateSha: CANDIDATE_SHA,
      treeDigest: H0_TREE_DIGEST,
      changedFiles: REVIEW_FILES,
      tierAEntries: REVIEW_FILES,
      writeAssignmentId: write.assignmentId,
      writeExecutionAttemptId: write.executionAttemptId,
      authors: REVIEW_AUTHORS,
      committers: REVIEW_COMMITTERS,
    };
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "review-evidence-decision", 1, {
      conditions: [{ kind: "evidence_required", evidenceIds: [review.evidence.evidenceId] }],
      decisionEvidence: [review.evidence],
    }), null, null, null, reader).outcome).toBe("OK");

    const expectRefusal = (name: string, evidence: typeof review.evidence, outcome: string) => {
      const before = exportFoundation(db, PROJECT_ID);
      expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "review-evidence-decision", 2, {
        idempotencyKey: `review-evidence-${name}`,
        disposition: "rejected",
        decisionEvidence: [evidence],
      })).outcome, name).toBe(outcome);
      expect(exportFoundation(db, PROJECT_ID), name).toEqual(before);
    };

    expectRefusal("write", write.evidence, "EXECUTION_CONTEXT_FOREIGN");
    expectRefusal("probe", probe.evidence, "EXECUTION_CONTEXT_FOREIGN");
    expectRefusal("missing", {
      ...review.evidence,
      evidenceId: "delegated-missing",
      sourceRef: "execution:missing-execution",
      assignmentId: "missing-assignment",
      executionAttemptId: "missing-execution",
    }, "RESOURCE_UNKNOWN");
    expectRefusal("foreign", {
      ...review.evidence,
      evidenceId: "delegated-foreign",
      assignmentId: "foreign-assignment",
    }, "EXECUTION_CONTEXT_FOREIGN");

    db.prepare("UPDATE execution_attempts SET state = 'running' WHERE execution_attempt_id = ?").run(review.executionAttemptId);
    expectRefusal("nonterminal", { ...review.evidence, evidenceId: "delegated-nonterminal" }, "TERMINAL_REPORT_REQUIRED");
    db.prepare("UPDATE execution_attempts SET state = 'done' WHERE execution_attempt_id = ?").run(review.executionAttemptId);
    db.prepare("UPDATE execution_attempts SET conflicting_terminal_digest = ? WHERE execution_attempt_id = ?").run(sha256("conflict"), review.executionAttemptId);
    expectRefusal("ambiguous", { ...review.evidence, evidenceId: "delegated-ambiguous" }, "TERMINAL_REPORT_AMBIGUOUS");
    db.prepare("UPDATE execution_attempts SET conflicting_terminal_digest = NULL WHERE execution_attempt_id = ?").run(review.executionAttemptId);
    expectRefusal("digest", {
      ...review.evidence,
      evidenceId: "delegated-digest",
      contentDigest: sha256("wrong"),
      terminalReportDigest: sha256("wrong"),
    }, "EXECUTION_CONTEXT_FOREIGN");
  });

  it("validates per-target connector mappings and freezes the exact config entry", async () => {
    const host = await loadedHost();
    for (const [name, connectors, outcome] of [
      ["duplicate", [
        { repoTargetId: TARGET_ID, connectorId: "connector-review", policy: "optional" },
        { repoTargetId: TARGET_ID, connectorId: "connector-review", policy: "required" },
      ], "INVALID_INPUT"],
      ["unsorted", [
        { repoTargetId: TARGET_ID, connectorId: "z", policy: "optional" },
        { repoTargetId: TARGET_ID, connectorId: "a", policy: "optional" },
      ], "INVALID_INPUT"],
      ["foreign", [{ repoTargetId: "target-foreign", connectorId: "connector-review", policy: "optional" }], "REPO_TARGET_FOREIGN"],
    ] as const) {
      const projectId = `project-${name}`;
      const receiptId = `receipt-${name}`;
      const db = host.bb.storage.database();
      seedVerifiedFixtureReceipt(db, { projectId, receiptId, subjectId: "fixture-user" });
      const request = bootstrapRequest();
      (request.config as { extensions: { bbCollab: Record<string, unknown> } }).extensions.bbCollab.reviewPolicy = { connectors };
      expect(applyWithFixtureReceipt(db, { ...request, projectId, actorReceiptId: receiptId, idempotencyKey: `bootstrap-${name}` }).outcome).toBe(outcome);
    }

    const { db, fenceToken } = await assignmentFixture();
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "in_progress", 2)).outcome).toBe("OK");
    const before = exportFoundation(db, PROJECT_ID);
    const mismatched = reviewDecisionCreateRequest(fenceToken, "optional");
    (mismatched.decision!.options as { connectors: Array<{ policy: string }> }).connectors[0]!.policy = "required";
    expect(applyWithFixtureReceipt(db, mismatched).outcome).toBe("PROJECT_CONFIG_STALE");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    const oversized = reviewDecisionCreateRequest(fenceToken, "optional", "review-oversized");
    const target = ((oversized.decision!.scope as { targets: Array<{ tierAEntries: string[] }> }).targets[0]!);
    target.tierAEntries = Array.from({ length: 64 }, (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(250)}`);
    expect(applyWithFixtureReceipt(db, oversized).outcome).toBe("MALFORMED_JSON");
  });

  it("enforces connector required, optional, and prohibited without a connector-call seam", async () => {
    const requiredMissing = await preparedReview("required");
    const requiredBefore = exportFoundation(requiredMissing.db, PROJECT_ID);
    expect(applyWithFixtureReceipt(requiredMissing.db, requiredMissing.request(), null, null, null, requiredMissing.reader).outcome).toBe("EXTERNAL_CAPABILITY_REQUIRED");
    expect(requiredMissing.reader.readCalls).toHaveLength(0);
    expect(exportFoundation(requiredMissing.db, PROJECT_ID)).toEqual(requiredBefore);

    const requiredAvailable = await preparedReview("required");
    expect(applyWithFixtureReceipt(requiredAvailable.db, requiredAvailable.request([connectorEvidence("available", true)]), null, null, null, requiredAvailable.reader).outcome).toBe("OK");
    expect(requiredAvailable.reader.readCalls).toHaveLength(1);

    const requiredDegraded = await preparedReview("required");
    expect(applyWithFixtureReceipt(requiredDegraded.db, requiredDegraded.request([connectorEvidence("degraded", true)]), null, null, null, requiredDegraded.reader).outcome).toBe("EXTERNAL_CAPABILITY_REQUIRED");
    expect(requiredDegraded.reader.readCalls).toHaveLength(0);

    const optional = await preparedReview("optional");
    expect(applyWithFixtureReceipt(optional.db, optional.request([connectorEvidence("absent", true)]), null, null, null, optional.reader).outcome).toBe("OK");

    const prohibited = await preparedReview("prohibited");
    const eventCount = (prohibited.db.prepare("SELECT COUNT(*) AS count FROM state_events").get() as { count: number }).count;
    const receiptCount = (prohibited.db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts").get() as { count: number }).count;
    const artifactCount = (prohibited.db.prepare("SELECT COUNT(*) AS count FROM evidence_artifacts").get() as { count: number }).count;
    for (const disposition of ["proposed", "rejected", "adopted"] as const) {
      const before = exportFoundation(prohibited.db, PROJECT_ID);
      const request = prohibited.request([connectorEvidence("available", true)], {
        idempotencyKey: `review-prohibited-${disposition}`,
        disposition,
      });
      expect(applyWithFixtureReceipt(prohibited.db, request, null, null, null, prohibited.reader).outcome, disposition).toBe("INVALID_INPUT");
      expect(exportFoundation(prohibited.db, PROJECT_ID), disposition).toEqual(before);
    }
    expect(prohibited.reader.readCalls).toHaveLength(0);
    expect(prohibited.db.prepare("SELECT COUNT(*) AS count FROM state_events").get()).toEqual({ count: eventCount });
    expect(prohibited.db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts").get()).toEqual({ count: receiptCount });
    expect(prohibited.db.prepare("SELECT COUNT(*) AS count FROM evidence_artifacts").get()).toEqual({ count: artifactCount });
    expect(applyWithFixtureReceipt(prohibited.db, prohibited.request([], {
      idempotencyKey: "review-prohibited-rejected",
      disposition: "adopted",
    }), null, null, null, prohibited.reader).outcome).toBe("OK");
    expect(prohibited.reader.readCalls).toHaveLength(1);
    expect(String(applyFixtureMutation)).not.toContain("connectorAdapter");

    const prohibitedLocal = await preparedReview("prohibited");
    expect(applyWithFixtureReceipt(prohibitedLocal.db, prohibitedLocal.request(), null, null, null, prohibitedLocal.reader).outcome).toBe("OK");
  });

  it("fails closed on missing or inexact review facts before any canonical mutation", async () => {
    const fixture = await preparedReview();
    const baseline = structuredClone(fixture.reader.facts!);
    for (const [name, mutate, outcome] of [
      ["missing", () => { fixture.reader.facts = null; }, "BB_FACTS_UNAVAILABLE"],
      ["branch", () => { fixture.reader.facts = { ...baseline, branchName: "bb/other" }; }, "ASSIGNMENT_HEAD_STALE"],
      ["target", () => { fixture.reader.facts = { ...baseline, repoTargetId: SECOND_TARGET_ID }; }, "ASSIGNMENT_HEAD_STALE"],
      ["head", () => { fixture.reader.facts = { ...baseline, candidateSha: H1_CANDIDATE_SHA }; }, "ASSIGNMENT_HEAD_STALE"],
      ["tree", () => { fixture.reader.facts = { ...baseline, treeDigest: H1_TREE_DIGEST }; }, "ASSIGNMENT_HEAD_STALE"],
      ["diff", () => { fixture.reader.facts = { ...baseline, changedFiles: ["tests/server.test.ts"] }; }, "ASSIGNMENT_HEAD_STALE"],
      ["author", () => { fixture.reader.facts = { ...baseline, authors: [{ name: "Other", email: "other@example.test" }] }; }, "ASSIGNMENT_HEAD_STALE"],
      ["committer", () => { fixture.reader.facts = { ...baseline, committers: [{ name: "Other", email: "other@example.test" }] }; }, "ASSIGNMENT_HEAD_STALE"],
    ] as const) {
      mutate();
      const before = exportFoundation(fixture.db, PROJECT_ID);
      const request = fixture.request([], { idempotencyKey: `review-facts-${name}` });
      expect(applyWithFixtureReceipt(fixture.db, request, null, null, null, fixture.reader).outcome, name).toBe(outcome);
      expect(exportFoundation(fixture.db, PROJECT_ID), name).toEqual(before);
      fixture.reader.facts = structuredClone(baseline);
    }

    const stale = fixture.request([], { idempotencyKey: "review-stale-cas", expectedResourceRevision: 2 });
    const calls = fixture.reader.readCalls.length;
    expect(applyWithFixtureReceipt(fixture.db, stale, null, null, null, fixture.reader).outcome).toBe("RESOURCE_REVISION_STALE");
    expect(fixture.reader.readCalls).toHaveLength(calls);
  });

  it("replays before fact reads and rejects a conflicting idempotency key", async () => {
    const fixture = await preparedReview();
    const request = fixture.request();
    const first = applyWithFixtureReceipt(fixture.db, request, null, null, null, fixture.reader);
    expect(first.outcome).toBe("OK");
    expect(fixture.reader.readCalls).toHaveLength(1);
    expect(applyWithFixtureReceipt(fixture.db, request, null, null, null, fixture.reader)).toEqual(first);
    expect(fixture.reader.readCalls).toHaveLength(1);
    expect(applyWithFixtureReceipt(fixture.db, { ...request, reason: { mechanism: "changed" } }, null, null, null, fixture.reader).outcome).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(fixture.reader.readCalls).toHaveLength(1);
  });

  it("rechecks Decision CAS after the external review-fact read", async () => {
    const fixture = await preparedReview();
    fixture.reader.onRead = () => {
      fixture.db.prepare("UPDATE decisions SET current_resource_revision = 2 WHERE decision_id = 'review-evidence-decision'").run();
    };
    const dispositions = (fixture.db.prepare("SELECT COUNT(*) AS count FROM decision_dispositions").get() as { count: number }).count;
    const artifacts = (fixture.db.prepare("SELECT COUNT(*) AS count FROM evidence_artifacts").get() as { count: number }).count;
    expect(applyWithFixtureReceipt(fixture.db, fixture.request([], { idempotencyKey: "review-cas-race" }), null, null, null, fixture.reader).outcome).toBe("RESOURCE_REVISION_STALE");
    expect(fixture.reader.readCalls).toHaveLength(1);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM decision_dispositions").get()).toEqual({ count: dispositions });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM evidence_artifacts").get()).toEqual({ count: artifacts });
    expect(fixture.db.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = 'review-cas-race'").get()).toBeUndefined();
  });

  it("revalidates every referenced Assignment against current authority, resource, intent, and target state", async () => {
    const expectReferenceRefusal = (
      fixture: Awaited<ReturnType<typeof preparedReview>>,
      request: ApplyRequest,
      outcome: string,
    ) => {
      const before = exportFoundation(fixture.db, PROJECT_ID);
      expect(before.outcome).toBe("OK");
      expect(applyWithFixtureReceipt(fixture.db, request, null, null, null, fixture.reader).outcome).toBe(outcome);
      expect(fixture.reader.readCalls).toHaveLength(0);
      expect(exportFoundation(fixture.db, PROJECT_ID)).toEqual(before);
      expect(fixture.db.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = ?").get(request.idempotencyKey)).toBeUndefined();
    };

    const governance = await preparedReview();
    const claim = applyWithFixtureReceipt(governance.db, {
      projectId: PROJECT_ID,
      operationClass: "governor_claim",
      idempotencyKey: "review-reference-governor-advance",
      actorReceiptId: RECEIPT_ID,
      expectedConfigRevision: 1,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: governance.fenceToken,
      runtimeId: "runtime-review-successor",
    });
    expect(claim.outcome).toBe("OK");
    const successorFence = (claim.evidence as { fenceToken: string }).fenceToken;
    expectReferenceRefusal(governance, governance.request([], {
      idempotencyKey: "review-reference-governance-stale",
      expectedGovernanceEpoch: 2,
      expectedFenceToken: successorFence,
    }), "ASSIGNMENT_HEAD_STALE");

    const workItem = await preparedReview();
    expect(applyWithFixtureReceipt(workItem.db, transitionRequest(workItem.fenceToken, "succeeded", 3)).outcome).toBe("OK");
    expectReferenceRefusal(workItem, workItem.request([], { idempotencyKey: "review-reference-work-item-stale" }), "ASSIGNMENT_HEAD_STALE");

    const role = await preparedReview();
    const successorActorReceiptId = advanceOrchestrator(role.db, role.fenceToken);
    expectReferenceRefusal(role, role.request([], {
      idempotencyKey: "review-reference-role-stale",
      actorReceiptId: successorActorReceiptId,
    }), "ROLE_GENERATION_STALE");

    const digest = await preparedReview();
    digest.db.prepare("UPDATE assignments SET assignment_digest = ? WHERE assignment_id = ?").run(sha256("corrupt-assignment-digest"), digest.write.assignmentId);
    expectReferenceRefusal(digest, digest.request([], { idempotencyKey: "review-reference-digest-corrupt" }), "ASSIGNMENT_HEAD_STALE");

    const linkage = await preparedReview();
    linkage.db.prepare("UPDATE execution_attempts SET assignment_digest = ? WHERE execution_attempt_id = ?").run(sha256("corrupt-attempt-linkage"), linkage.write.executionAttemptId);
    expectReferenceRefusal(linkage, linkage.request([], { idempotencyKey: "review-reference-linkage-corrupt" }), "ASSIGNMENT_HEAD_STALE");

    const intent = await preparedReview();
    intent.db.prepare("UPDATE assignments SET requested_model = 'tampered-model' WHERE assignment_id = ?").run(intent.write.assignmentId);
    expectReferenceRefusal(intent, intent.request([], { idempotencyKey: "review-reference-intent-corrupt" }), "ROLE_REQUIREMENT_UNKNOWN");

    const target = await preparedReview();
    const movedTarget = {
      repoTargetId: TARGET_ID,
      sourceId: "source-main",
      hostId: "host-main",
      path: "/workspace/moved",
      remoteUrl: null,
      defaultBranch: "main",
    };
    target.db.prepare("UPDATE repository_targets SET path = ?, target_digest = ? WHERE project_id = ? AND repo_target_id = ? AND config_revision = 1")
      .run(movedTarget.path, sha256(canonicalJson(movedTarget)), PROJECT_ID, TARGET_ID);
    expectReferenceRefusal(target, target.request([], { idempotencyKey: "review-reference-target-moved" }), "EXECUTION_CONTEXT_FOREIGN");
  });

  it("rejects non-independent lane, role, generation, profile, and terminal facts before reading Git evidence", async () => {
    const fixture = await preparedReview();
    const mutations = [
      ["lane", "UPDATE assignments SET lane_id = 'writer-write-assignment' WHERE assignment_id = 'review-assignment'", "UPDATE assignments SET lane_id = 'review-review-assignment' WHERE assignment_id = 'review-assignment'", "ASSIGNMENT_HEAD_STALE"],
      ["role", "UPDATE assignments SET role_id = 'project-orchestrator', role_generation = 1 WHERE assignment_id = 'review-assignment'; UPDATE execution_attempts SET role_id = 'project-orchestrator', role_generation = 1 WHERE execution_attempt_id = ?", "UPDATE assignments SET role_id = 'independent-reviewer', role_generation = 2 WHERE assignment_id = 'review-assignment'; UPDATE execution_attempts SET role_id = 'independent-reviewer', role_generation = 2 WHERE execution_attempt_id = ?", "ROLE_REQUIREMENT_UNKNOWN"],
      ["generation", "UPDATE assignments SET role_generation = 1 WHERE assignment_id = 'review-assignment'; UPDATE execution_attempts SET role_generation = 1 WHERE execution_attempt_id = ?", "UPDATE assignments SET role_generation = 2 WHERE assignment_id = 'review-assignment'; UPDATE execution_attempts SET role_generation = 2 WHERE execution_attempt_id = ?", "ROLE_GENERATION_STALE"],
      ["profile", "UPDATE execution_attempts SET actual_permission_mode = 'read' WHERE execution_attempt_id = ?", "UPDATE execution_attempts SET actual_permission_mode = 'full' WHERE execution_attempt_id = ?", "ASSIGNMENT_HEAD_STALE"],
      ["blocked", "UPDATE execution_attempts SET state = 'blocked' WHERE execution_attempt_id = ?", "UPDATE execution_attempts SET state = 'done' WHERE execution_attempt_id = ?", "TERMINAL_REPORT_REQUIRED"],
      ["conflict", `UPDATE execution_attempts SET conflicting_terminal_digest = '${sha256("review-conflict")}' WHERE execution_attempt_id = ?`, "UPDATE execution_attempts SET conflicting_terminal_digest = NULL WHERE execution_attempt_id = ?", "TERMINAL_REPORT_AMBIGUOUS"],
    ] as const;
    for (const [name, applySql, restoreSql, outcome] of mutations) {
      const execute = (sql: string) => {
        for (const statement of sql.split(";")) {
          if (statement.includes("?")) fixture.db.prepare(statement).run(fixture.review.executionAttemptId);
          else fixture.db.prepare(statement).run();
        }
      };
      execute(applySql);
      const before = exportFoundation(fixture.db, PROJECT_ID);
      expect(applyWithFixtureReceipt(fixture.db, fixture.request([], { idempotencyKey: `review-structural-${name}` }), null, null, null, fixture.reader).outcome, name).toBe(outcome);
      expect(exportFoundation(fixture.db, PROJECT_ID), name).toEqual(before);
      execute(restoreSql);
    }
    expect(fixture.reader.readCalls).toHaveLength(0);
  });

  it("permits one bounded H0-to-H1 amendment and derives the cap from legal evidence rows", async () => {
    const fixture = await preparedReview();
    const h1Write = completeFixtureAssignment(fixture.db, fixture.fenceToken, { assignmentKind: "write", assignmentId: "write-amendment", candidateSha: H1_CANDIDATE_SHA });
    const h1Review = completeFixtureAssignment(fixture.db, fixture.fenceToken, { assignmentKind: "review", assignmentId: "review-amendment", candidateSha: H1_CANDIDATE_SHA });
    h1Review.evidence.relation = {
      relationRole: "final_review",
      workItemId: WORK_ITEM_ID,
      repoTargetId: TARGET_ID,
      configRevision: 1,
      baseSha: BASE_SHA,
      candidateSha: H1_CANDIDATE_SHA,
      treeDigest: H1_TREE_DIGEST,
      changedFiles: REVIEW_FILES,
      tierAEntries: REVIEW_FILES,
      writeAssignmentId: h1Write.assignmentId,
      writeExecutionAttemptId: h1Write.executionAttemptId,
      authors: REVIEW_AUTHORS,
      committers: REVIEW_COMMITTERS,
    };
    fixture.reader.facts = {
      ...fixture.reader.facts!,
      writeAssignmentId: h1Write.assignmentId,
      writeExecutionAttemptId: h1Write.executionAttemptId,
      branchName: `bb/${h1Write.assignmentId}`,
      candidateSha: H1_CANDIDATE_SHA,
      treeDigest: H1_TREE_DIGEST,
    };
    const amendment = decisionArtifact("review-amendment-scope", {
      evidenceKind: "review_ready",
      sourceKind: "review_ready",
      sourceRef: "review-ready:h1",
      relationKind: "supporting",
      relation: {
        relationRole: "amendment_scope",
        workItemId: WORK_ITEM_ID,
        repoTargetId: TARGET_ID,
        baseSha: BASE_SHA,
        h0AssignmentId: fixture.review.assignmentId,
        h0CandidateSha: CANDIDATE_SHA,
        h0TreeDigest: H0_TREE_DIGEST,
        h1AssignmentId: h1Review.assignmentId,
        h1CandidateSha: H1_CANDIDATE_SHA,
        h1TreeDigest: H1_TREE_DIGEST,
        allowedChangedFiles: REVIEW_FILES,
        actualChangedFiles: REVIEW_FILES,
      },
    });
    const adopted = decisionDispositionRequest(fixture.fenceToken, "review-evidence-decision", 1, {
      conditions: [{ kind: "evidence_required", evidenceIds: [h1Review.evidence.evidenceId] }],
      decisionEvidence: [connectorEvidence("absent", true), amendment, h1Review.evidence],
    });
    expect(applyWithFixtureReceipt(fixture.db, adopted, null, null, null, fixture.reader).outcome).toBe("OK");
    expect(fixture.db.prepare("SELECT evidence_kind, source_kind FROM evidence_artifacts WHERE evidence_id = ?").get(amendment.evidenceId)).toEqual({ evidence_kind: "review_ready", source_kind: "review_ready" });
    expect(fixture.db.prepare("SELECT relation_kind, json_extract(relation_json, '$.relationRole') AS role FROM decision_evidence WHERE evidence_id = ?").get(amendment.evidenceId)).toEqual({ relation_kind: "supporting", role: "amendment_scope" });

    const second = { ...amendment, evidenceId: "review-amendment-second", sourceRef: "review-ready:h2" };
    const repeatedReview = { ...h1Review.evidence, evidenceId: "delegated-review-amendment-second" };
    const before = exportFoundation(fixture.db, PROJECT_ID);
    expect(applyWithFixtureReceipt(fixture.db, decisionDispositionRequest(fixture.fenceToken, "review-evidence-decision", 2, {
      idempotencyKey: "review-second-amendment",
      conditions: [{ kind: "evidence_required", evidenceIds: [repeatedReview.evidenceId] }],
      decisionEvidence: [second, repeatedReview],
    }), null, null, null, fixture.reader).outcome).toBe("REVIEW_AMENDMENT_CAP");
    expect(exportFoundation(fixture.db, PROJECT_ID)).toEqual(before);

    const rerunConnector = { ...connectorEvidence("absent", true), evidenceId: "connector-amendment-rerun", sourceRef: "connector:rerun" };
    expect(applyWithFixtureReceipt(fixture.db, decisionDispositionRequest(fixture.fenceToken, "review-evidence-decision", 2, {
      idempotencyKey: "review-amendment-connector-rerun",
      conditions: [{ kind: "evidence_required", evidenceIds: [repeatedReview.evidenceId] }],
      decisionEvidence: [rerunConnector, repeatedReview],
    }), null, null, null, fixture.reader).outcome).toBe("INVALID_INPUT");
    expect(fixture.reader.readCalls).toHaveLength(1);
  });

  it("rejects an amendment with a stale referenced H0 Assignment without reads or writes", async () => {
    const fixture = await preparedReview();
    const h1Write = completeFixtureAssignment(fixture.db, fixture.fenceToken, { assignmentKind: "write", assignmentId: "write-amendment-stale-h0", candidateSha: H1_CANDIDATE_SHA });
    const h1Review = completeFixtureAssignment(fixture.db, fixture.fenceToken, { assignmentKind: "review", assignmentId: "review-amendment-stale-h0", candidateSha: H1_CANDIDATE_SHA });
    h1Review.evidence.relation = {
      relationRole: "final_review",
      workItemId: WORK_ITEM_ID,
      repoTargetId: TARGET_ID,
      configRevision: 1,
      baseSha: BASE_SHA,
      candidateSha: H1_CANDIDATE_SHA,
      treeDigest: H1_TREE_DIGEST,
      changedFiles: REVIEW_FILES,
      tierAEntries: REVIEW_FILES,
      writeAssignmentId: h1Write.assignmentId,
      writeExecutionAttemptId: h1Write.executionAttemptId,
      authors: REVIEW_AUTHORS,
      committers: REVIEW_COMMITTERS,
    };
    fixture.reader.facts = {
      ...fixture.reader.facts!,
      writeAssignmentId: h1Write.assignmentId,
      writeExecutionAttemptId: h1Write.executionAttemptId,
      branchName: `bb/${h1Write.assignmentId}`,
      candidateSha: H1_CANDIDATE_SHA,
      treeDigest: H1_TREE_DIGEST,
    };
    const amendment = decisionArtifact("review-amendment-stale-h0", {
      evidenceKind: "review_ready",
      sourceKind: "review_ready",
      sourceRef: "review-ready:stale-h0",
      relationKind: "supporting",
      relation: {
        relationRole: "amendment_scope",
        workItemId: WORK_ITEM_ID,
        repoTargetId: TARGET_ID,
        baseSha: BASE_SHA,
        h0AssignmentId: fixture.review.assignmentId,
        h0CandidateSha: CANDIDATE_SHA,
        h0TreeDigest: H0_TREE_DIGEST,
        h1AssignmentId: h1Review.assignmentId,
        h1CandidateSha: H1_CANDIDATE_SHA,
        h1TreeDigest: H1_TREE_DIGEST,
        allowedChangedFiles: REVIEW_FILES,
        actualChangedFiles: REVIEW_FILES,
      },
    });
    fixture.db.prepare("UPDATE assignments SET assignment_digest = ? WHERE assignment_id = ?").run(sha256("corrupt-h0-amendment-reference"), fixture.review.assignmentId);
    const request = decisionDispositionRequest(fixture.fenceToken, "review-evidence-decision", 1, {
      idempotencyKey: "review-amendment-stale-h0",
      conditions: [{ kind: "evidence_required", evidenceIds: [h1Review.evidence.evidenceId] }],
      decisionEvidence: [amendment, h1Review.evidence],
    });
    const before = exportFoundation(fixture.db, PROJECT_ID);
    const counts = Object.fromEntries(["evidence_artifacts", "decision_evidence", "state_events", "actor_receipts", "mutation_receipts"].map((table) => [table, (fixture.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
    expect(applyWithFixtureReceipt(fixture.db, request, null, null, null, fixture.reader).outcome).toBe("ASSIGNMENT_HEAD_STALE");
    expect(fixture.reader.readCalls).toHaveLength(0);
    expect(exportFoundation(fixture.db, PROJECT_ID)).toEqual(before);
    for (const [table, count] of Object.entries(counts)) {
      expect((fixture.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, table).toBe(count);
    }
    expect(fixture.db.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = ?").get(request.idempotencyKey)).toBeUndefined();
  });

  it("rejects changed-base and out-of-scope amendments without reading facts", async () => {
    const fixture = await preparedReview();
    const h1Write = completeFixtureAssignment(fixture.db, fixture.fenceToken, { assignmentKind: "write", assignmentId: "write-amendment", candidateSha: H1_CANDIDATE_SHA });
    const h1Review = completeFixtureAssignment(fixture.db, fixture.fenceToken, { assignmentKind: "review", assignmentId: "review-amendment", candidateSha: H1_CANDIDATE_SHA });
    const relation = {
      relationRole: "amendment_scope", workItemId: WORK_ITEM_ID, repoTargetId: TARGET_ID, baseSha: BASE_SHA,
      h0AssignmentId: fixture.review.assignmentId, h0CandidateSha: CANDIDATE_SHA, h0TreeDigest: H0_TREE_DIGEST,
      h1AssignmentId: h1Review.assignmentId, h1CandidateSha: H1_CANDIDATE_SHA, h1TreeDigest: H1_TREE_DIGEST,
      allowedChangedFiles: REVIEW_FILES, actualChangedFiles: REVIEW_FILES,
    };
    const amendment = decisionArtifact("review-amendment-scope", {
      evidenceKind: "review_ready",
      sourceKind: "review_ready",
      sourceRef: "review-ready:h1",
      relationKind: "supporting",
      relation,
    });
    for (const [name, changed] of [
      ["base", { baseSha: "d".repeat(40) }],
      ["files", { actualChangedFiles: ["server.ts"] }],
    ] as const) {
      const evidence = { ...amendment, evidenceId: `review-amendment-${name}`, relation: { ...relation, ...changed } };
      const before = exportFoundation(fixture.db, PROJECT_ID);
      expect(applyWithFixtureReceipt(fixture.db, fixture.request([evidence], { idempotencyKey: `review-amendment-${name}` }), null, null, null, fixture.reader).outcome).toBe("REVIEW_SCOPE_MISMATCH");
      expect(exportFoundation(fixture.db, PROJECT_ID)).toEqual(before);
    }
    expect(fixture.reader.readCalls).toHaveLength(0);
  });

  it("keeps the amendment changed-file subset guard mutation-discriminating", async () => {
    const fixture = await preparedReview();
    const h1Write = completeFixtureAssignment(fixture.db, fixture.fenceToken, { assignmentKind: "write", assignmentId: "write-amendment-subset", candidateSha: H1_CANDIDATE_SHA });
    const h1Review = completeFixtureAssignment(fixture.db, fixture.fenceToken, { assignmentKind: "review", assignmentId: "review-amendment-subset", candidateSha: H1_CANDIDATE_SHA });
    const actualChangedFiles = ["server.ts"];
    h1Review.evidence.relation = {
      relationRole: "final_review",
      workItemId: WORK_ITEM_ID,
      repoTargetId: TARGET_ID,
      configRevision: 1,
      baseSha: BASE_SHA,
      candidateSha: H1_CANDIDATE_SHA,
      treeDigest: H1_TREE_DIGEST,
      changedFiles: actualChangedFiles,
      tierAEntries: REVIEW_FILES,
      writeAssignmentId: h1Write.assignmentId,
      writeExecutionAttemptId: h1Write.executionAttemptId,
      authors: REVIEW_AUTHORS,
      committers: REVIEW_COMMITTERS,
    };
    fixture.reader.facts = {
      ...fixture.reader.facts!,
      writeAssignmentId: h1Write.assignmentId,
      writeExecutionAttemptId: h1Write.executionAttemptId,
      branchName: `bb/${h1Write.assignmentId}`,
      candidateSha: H1_CANDIDATE_SHA,
      treeDigest: H1_TREE_DIGEST,
      changedFiles: actualChangedFiles,
    };
    const amendment = decisionArtifact("review-amendment-subset", {
      evidenceKind: "review_ready",
      sourceKind: "review_ready",
      sourceRef: "review-ready:subset",
      relationKind: "supporting",
      relation: {
        relationRole: "amendment_scope",
        workItemId: WORK_ITEM_ID,
        repoTargetId: TARGET_ID,
        baseSha: BASE_SHA,
        h0AssignmentId: fixture.review.assignmentId,
        h0CandidateSha: CANDIDATE_SHA,
        h0TreeDigest: H0_TREE_DIGEST,
        h1AssignmentId: h1Review.assignmentId,
        h1CandidateSha: H1_CANDIDATE_SHA,
        h1TreeDigest: H1_TREE_DIGEST,
        allowedChangedFiles: REVIEW_FILES,
        actualChangedFiles,
      },
    });
    const request = decisionDispositionRequest(fixture.fenceToken, "review-evidence-decision", 1, {
      idempotencyKey: "review-amendment-subset",
      conditions: [{ kind: "evidence_required", evidenceIds: [h1Review.evidence.evidenceId] }],
      decisionEvidence: [amendment, h1Review.evidence],
    });
    const before = exportFoundation(fixture.db, PROJECT_ID);
    expect(applyWithFixtureReceipt(fixture.db, request, null, null, null, fixture.reader).outcome).toBe("REVIEW_SCOPE_MISMATCH");
    expect(fixture.reader.readCalls).toHaveLength(0);
    expect(exportFoundation(fixture.db, PROJECT_ID)).toEqual(before);
  });

  it("rolls back review disposition artifacts, relations, events, and receipts after late SQLite failures", async () => {
    for (const [name, table] of [["event", "state_events"], ["receipt", "mutation_receipts"]] as const) {
      const fixture = await preparedReview();
      const when = table === "state_events"
        ? "NEW.event_type = 'decision_disposition_appended'"
        : "NEW.operation_class = 'decision_disposition'";
      fixture.db.exec(`CREATE TEMP TRIGGER fail_review_${name}
        BEFORE INSERT ON ${table}
        WHEN ${when}
        BEGIN SELECT RAISE(ABORT, 'injected late constraint'); END`);
      const before = exportFoundation(fixture.db, PROJECT_ID);
      expect(before.outcome).toBe("OK");
      expect(applyWithFixtureReceipt(fixture.db, fixture.request([], { idempotencyKey: `review-rollback-${name}` }), null, null, null, fixture.reader).outcome).toBe("CANONICAL_STORE_UNAVAILABLE");
      const after = exportFoundation(fixture.db, PROJECT_ID);
      expect(after.outcome).toBe("OK");
      expect(after.export?.manifest.recordsDigest).toBe(before.export?.manifest.recordsDigest);
      expect(after.export?.checksums).toEqual(before.export?.checksums);
    }
  });

  it("rolls back Decision revision, disposition, artifacts, relations, event, and receipt after a late SQLite failure", async () => {
    const { db, fenceToken } = await assignmentFixture();
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken)).outcome).toBe("OK");
    db.exec(`CREATE TEMP TRIGGER fail_decision_receipt
      BEFORE INSERT ON mutation_receipts
      WHEN NEW.operation_class = 'decision_disposition'
      BEGIN SELECT RAISE(ABORT, 'injected late constraint'); END`);
    const before = exportFoundation(db, PROJECT_ID);
    const failed = applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 1, {
      decisionEvidence: [decisionArtifact("rollback-evidence")],
    }));
    expect(failed.outcome).toBe("CANONICAL_STORE_UNAVAILABLE");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
    expect(db.prepare("SELECT current_resource_revision FROM decisions WHERE decision_id = 'decision-v5'").get()).toEqual({ current_resource_revision: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM decision_dispositions WHERE decision_id = 'decision-v5'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM evidence_artifacts").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM decision_evidence").get()).toEqual({ count: 0 });
    db.exec("DROP TRIGGER fail_decision_receipt");
  });

  it("migrates v4 to v5 without manufacturing typed authority for existing Decision rows", () => {
    const db = new Database(":memory:");
    databaseIsReady(db);
    try {
      for (const statement of MIGRATIONS) db.exec(statement);
      seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      const bootstrap = applyFixtureMutation(db, bootstrapRequest());
      const fenceToken = (bootstrap.evidence as { fenceToken: string }).fenceToken;
      const scopeJson = canonicalJson({ legacy: true });
      db.prepare(
        `INSERT INTO decisions
          (decision_id, project_id, config_revision, repo_target_id, scope_json, scope_digest, current_resource_revision)
         VALUES ('legacy-decision', ?, 1, ?, ?, ?, 1)`,
      ).run(PROJECT_ID, TARGET_ID, scopeJson, sha256(scopeJson));
      expect(db.prepare("SELECT decision_class, options_json, decision_identity_digest FROM decisions WHERE decision_id = 'legacy-decision'").get()).toEqual({
        decision_class: null,
        options_json: null,
        decision_identity_digest: null,
      });
      const before = exportFoundation(db, PROJECT_ID);
      expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "legacy-decision", 1, {
        actorReceiptId: RECEIPT_ID,
        idempotencyKey: "legacy-decision-refusal",
      })).outcome).toBe("DECISION_IDENTITY_CONFLICT");
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
      expect((before.export?.manifest.tableCounts ?? {})).toMatchObject({ evidence_artifacts: 0, decision_evidence: 0 });
    } finally {
      db.close();
    }
  });

  it("reports deterministic v5 Decision and evidence integrity without adopting or repairing state", async () => {
    const { host, db, fenceToken } = await assignmentFixture();
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken)).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "decision-v5", 1, {
      disposition: "proposed",
      holdAction: "set",
      holdCode: "review",
      decisionEvidence: [decisionArtifact("doctor-evidence")],
    })).outcome).toBe("OK");
    const legacyScope = canonicalJson({ legacy: true });
    db.prepare(
      `INSERT INTO decisions
        (decision_id, project_id, config_revision, repo_target_id, scope_json, scope_digest, current_resource_revision)
       VALUES ('doctor-legacy', ?, 1, ?, ?, ?, 1)`,
    ).run(PROJECT_ID, TARGET_ID, legacyScope, sha256(legacyScope));
    const before = exportFoundation(db, PROJECT_ID);
    const changesBefore = db.prepare("SELECT total_changes() AS count").get();
    const first = await host.harness.callRpc("doctor", { projectId: PROJECT_ID });
    const second = await host.harness.callRpc("doctor", { projectId: PROJECT_ID });
    expect(second).toEqual(first);
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(changesBefore);
    expect(first).toMatchObject({
      outcome: "OK",
      evidence: {
        decisionIntegrity: {
          unresolvedDecisions: [{ decisionId: "doctor-legacy", reason: "DECISION_IDENTITY_CONFLICT" }],
          issues: [],
          derivedHolds: [{ decisionId: "decision-v5", holdCode: "review", setterSequence: 1 }],
          artifactCount: 1,
          relationCount: 1,
        },
        cachedConsumers: { oldSchemaVersion: 7, newSchemaVersion: 8, expected: 4, attempted: 4, verified: 4 },
        schema: { version: 8 },
      },
    });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    db.prepare("UPDATE evidence_artifacts SET redacted_digest = ? WHERE evidence_id = 'doctor-evidence'").run(sha256("tampered"));
    const corruptedBefore = exportFoundation(db, PROJECT_ID);
    const corrupted = await host.harness.callRpc("doctor", { projectId: PROJECT_ID });
    expect(corrupted).toMatchObject({
      outcome: "OK",
      evidence: { decisionIntegrity: { issues: expect.arrayContaining([{ evidenceId: "doctor-evidence", reason: "evidence_artifact_digest_invalid" }]) } },
    });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(corruptedBefore);
  });

  it("reopens the real SQLite file and recovers the committed idempotent receipt", () => {
    const { db, path, directory } = directDatabase();
    try {
      seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      const committed = applyFixtureMutation(db, bootstrapRequest());
      const before = exportFoundation(db, PROJECT_ID);
      db.close();
      const reopened = new Database(path);
      databaseIsReady(reopened);
      try {
        expect(applyFixtureMutation(reopened, bootstrapRequest())).toEqual(committed);
        expect(exportFoundation(reopened, PROJECT_ID)).toEqual(before);
        expect(reopened.prepare("SELECT COUNT(*) AS count FROM state_events").get()).toEqual({ count: 1 });
      } finally {
        reopened.close();
      }
    } finally {
      if (db.open) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("classifies unexpected mutation errors without leaking internal details", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
    const before = exportFoundation(db, PROJECT_ID);
    const result = (() => {
      const clock = vi.spyOn(Date, "now").mockImplementation(() => {
        throw new Error("sensitive internal detail");
      });
      try {
        return applyFixtureMutation(db, bootstrapRequest());
      } finally {
        clock.mockRestore();
      }
    })();
    expect(result).toMatchObject({ outcome: "INTERNAL_ERROR", message: "internal mutation error" });
    expect(result.message).not.toContain("sensitive internal detail");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("preserves state across the official harness reload lifecycle", async () => {
    const host = await loadedHost();
    const { db } = seedAndBootstrap(host);
    const before = exportFoundation(db, PROJECT_ID);
    const reloaded = await host.harness.lifecycle.reload(plugin);
    expect(await reloaded.harness.callRpc("export", { projectId: PROJECT_ID })).toEqual(before);
    await reloaded.harness.lifecycle.dispose();
  });

  it("keeps target resolution fail-closed and rejects malformed/non-JSON RPC boundaries", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    const before = exportFoundation(db, PROJECT_ID);
    const missingTarget = applyWithFixtureReceipt(db, {
      ...bootstrapRequest(),
      operationClass: "config_revision",
      idempotencyKey: "target-missing",
      expectedConfigRevision: 1,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
      config: undefined,
      targets: undefined,
      repoTargetId: undefined,
    });
    expect(missingTarget.outcome).toBe("REPO_TARGET_REQUIRED");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    const foreignTarget = applyWithFixtureReceipt(db, {
      ...bootstrapRequest(),
      operationClass: "config_revision",
      idempotencyKey: "target-foreign",
      expectedConfigRevision: 1,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
      config: undefined,
      targets: undefined,
      repoTargetId: "foreign-target",
    });
    expect(foreignTarget.outcome).toBe("REPO_TARGET_FOREIGN");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    await expect(host.harness.callRpc("doctor", { projectId: PROJECT_ID, extra: true })).rejects.toThrow();

    const bad = createFakePluginHost({ pluginId: "bad-boundary" });
    const badContract = defineRpcContract({
      bad: {
        input: z.null(),
        output: z.unknown(),
      },
    });
    bad.bb.rpc.register(badContract, {
      bad: () => ({ ok: BigInt(1) }) as never,
    });
    await expect(bad.harness.callRpc("bad", null)).rejects.toThrow(/non_json_result|not a JSON value/iu);
  });

  it("rejects secret material in config before the first mutation", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
    const result = applyWithFixtureReceipt(db, bootstrapRequest(PROJECT_ID, { config: { apiKey: "plaintext" } }));
    expect(result.outcome).toBe("CONFIG_SECRET_FORBIDDEN");
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_config_revisions").get()).toEqual({ count: 0 });
  });

  it("rejects duplicate targets and selectors absent from the collection", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
    const before = exportFoundation(db, PROJECT_ID);
    const target = bootstrapRequest().targets![0]!;
    const duplicate = applyWithFixtureReceipt(db, bootstrapRequest(PROJECT_ID, {
      idempotencyKey: "duplicate-targets",
      targets: [target, { ...target, sourceId: "source-other", path: "/workspace/other" }],
    }));
    expect(duplicate.outcome).toBe("INVALID_INPUT");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    const empty = applyWithFixtureReceipt(db, bootstrapRequest(PROJECT_ID, {
      idempotencyKey: "empty-targets",
      targets: [],
    }));
    expect(empty.outcome).toBe("REPO_TARGET_REQUIRED");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    const foreignSelector = applyWithFixtureReceipt(db, bootstrapRequest(PROJECT_ID, {
      idempotencyKey: "foreign-selector",
      repoTargetId: "target-foreign",
    }));
    expect(foreignSelector.outcome).toBe("REPO_TARGET_FOREIGN");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("supports an immutable config revision and stable target id", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    const appended = applyWithFixtureReceipt(db, {
      ...bootstrapRequest(),
      operationClass: "config_revision",
      idempotencyKey: "config-2",
      expectedConfigRevision: 1,
      configRevision: 2,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
      config: { permissionMode: "auto", visibility: "visible", repositoryTargets: [TARGET_ID] },
      targets: [{ ...bootstrapRequest().targets![0]!, defaultBranch: "develop" }],
    });
    expect(appended.outcome).toBe("OK");
    expect(db.prepare("SELECT config_revision FROM project_config_heads").get()).toEqual({ config_revision: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_config_revisions").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT repo_target_id FROM repository_targets ORDER BY config_revision").all()).toEqual([
      { repo_target_id: TARGET_ID },
      { repo_target_id: TARGET_ID },
    ]);
  });

  it("creates multiple targets through the resolver and rejects an ambiguous selector", async () => {
    const { db, path, directory } = directDatabase();
    try {
      seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      const initial = applyFixtureMutation(db, bootstrapRequest());
      const fenceToken = (initial.evidence as { fenceToken: string }).fenceToken;
      const secondTarget = {
        ...bootstrapRequest().targets![0]!,
        repoTargetId: SECOND_TARGET_ID,
        sourceId: "source-second",
        path: "/workspace/second",
      };
      const expanded = applyFixtureMutation(db, {
        ...bootstrapRequest(),
        operationClass: "config_revision",
        idempotencyKey: "targets-2",
        expectedConfigRevision: 1,
        configRevision: 2,
        expectedGovernanceEpoch: 1,
        expectedFenceToken: fenceToken,
        repoTargetId: null,
        config: { permissionMode: "auto", visibility: "visible", repositoryTargets: [TARGET_ID, SECOND_TARGET_ID] },
        targets: [bootstrapRequest().targets![0]!, secondTarget],
      });
      expect(expanded).toMatchObject({ outcome: "OK", expected: 3, attempted: 3, verified: 3 });
      expect(db.prepare("SELECT repo_target_id FROM repository_targets WHERE config_revision = 2 ORDER BY repo_target_id").all()).toEqual([
        { repo_target_id: TARGET_ID },
        { repo_target_id: SECOND_TARGET_ID },
      ]);
      const before = exportFoundation(db, PROJECT_ID);
      const result = applyFixtureMutation(db, {
        ...bootstrapRequest(),
        operationClass: "config_revision",
        idempotencyKey: "ambiguous-target",
        expectedConfigRevision: 2,
        configRevision: 3,
        expectedGovernanceEpoch: 1,
        expectedFenceToken: fenceToken,
        config: undefined,
        targets: undefined,
        repoTargetId: null,
      });
      expect(result.outcome).toBe("REPO_TARGET_AMBIGUOUS");
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces the frozen WorkItem lifecycle, exact target, and resource-revision CAS", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    const created = applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken));
    expect(created).toMatchObject({ outcome: "OK", currentResourceRevision: 1 });
    expect(db.prepare("SELECT lifecycle_state, resource_revision FROM work_items").get()).toEqual({ lifecycle_state: "proposed", resource_revision: 1 });

    const beforeInvalid = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "succeeded", 1))).toMatchObject({ outcome: "WORK_ITEM_STATE_INVALID", attempted: 0 });
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "ready", 1, { idempotencyKey: "wrong-target", repoTargetId: "target-other" }))).toMatchObject({ outcome: "REPO_TARGET_FOREIGN", attempted: 0 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeInvalid);

    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "ready", 1))).toMatchObject({ outcome: "OK", currentResourceRevision: 2 });
    const afterWinner = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "in_progress", 1, { idempotencyKey: "stale-transition" }))).toMatchObject({
      outcome: "WORK_ITEM_REVISION_STALE",
      currentResourceRevision: 2,
      expectedResourceRevision: 1,
    });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(afterWinner);
    expect(db.prepare("SELECT COUNT(*) AS count FROM state_events WHERE aggregate_type = 'work_item'").get()).toEqual({ count: 2 });
  });

  it("creates one exact GitHub projection, replays idempotently, and survives plugin reload", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    const adapter = new DeterministicGitHubIssueAdapter();
    const request = projectionRequest(fenceToken, 1);
    const projected = applyWithFixtureReceipt(db, request, adapter);
    expect(projected).toMatchObject({ outcome: "OK", expected: 1, attempted: 1, verified: 1 });
    expect(adapter.mutationCalls).toEqual([
      expect.objectContaining({ kind: "create", owner: GITHUB_OWNER, repo: GITHUB_REPO, addLabels: ["work-proposed"], removeLabels: [] }),
    ]);
    expect(db.prepare("SELECT projection_state, issue_number, projected_resource_revision FROM external_work_refs").get()).toEqual({
      projection_state: "current",
      issue_number: 1,
      projected_resource_revision: 1,
    });
    expect(db.prepare("SELECT lifecycle_state FROM work_items").get()).toEqual({ lifecycle_state: "proposed" });

    const reads = adapter.readCalls.length;
    expect(applyWithFixtureReceipt(db, request, null)).toEqual(projected);
    const unavailable = new DeterministicGitHubIssueAdapter();
    unavailable.available = false;
    expect(applyWithFixtureReceipt(db, request, unavailable)).toEqual(projected);
    expect(unavailable.mutationCalls).toHaveLength(0);
    expect(unavailable.readCalls).toHaveLength(0);
    expect(adapter.mutationCalls).toHaveLength(1);
    expect(adapter.readCalls).toHaveLength(reads);
    const conflictRequest = { ...request, workItemId: "different-work-item" };
    const conflict = applyWithFixtureReceipt(db, conflictRequest, null);
    expect(conflict).toEqual(applyWithFixtureReceipt(db, conflictRequest, unavailable));
    expect(conflict.outcome).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(adapter.mutationCalls).toHaveLength(1);

    const beforeReload = exportFoundation(db, PROJECT_ID);
    const reloaded = await host.harness.lifecycle.reload(plugin);
    const reloadedDb = reloaded.bb.storage.database();
    expect(exportFoundation(reloadedDb, PROJECT_ID)).toEqual(beforeReload);
    expect(applyWithFixtureReceipt(reloadedDb, request, adapter)).toEqual(projected);
    expect(adapter.mutationCalls).toHaveLength(1);
    await reloaded.harness.lifecycle.dispose();
  });

  it("refuses unknown, stale, unmapped, mismatched, and conflicting projection targets before adapter mutation", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    const adapter = new DeterministicGitHubIssueAdapter();
    const before = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1, { workItemId: "missing" }), adapter).outcome).toBe("WORK_ITEM_UNKNOWN");
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 2, { idempotencyKey: "stale-projection" }), adapter).outcome).toBe("WORK_ITEM_REVISION_STALE");
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1, { idempotencyKey: "wrong-projection-target", repoTargetId: SECOND_TARGET_ID }), adapter).outcome).toBe("REPO_TARGET_FOREIGN");
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1, { idempotencyKey: "wrong-connector" }), new DeterministicGitHubIssueAdapter("other-host")).outcome).toBe("EXTERNAL_TARGET_MISMATCH");
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1, { idempotencyKey: "no-capability" }), null).outcome).toBe("EXTERNAL_CAPABILITY_REQUIRED");
    const unmappedProject = "proj_unmapped";
    const unmappedReceipt = "receipt-unmapped";
    const unmappedWorkItem = "foreign-only-work-item";
    seedVerifiedFixtureReceipt(db, { projectId: unmappedProject, receiptId: unmappedReceipt });
    const unmappedBootstrap = applyWithFixtureReceipt(db, bootstrapRequest(unmappedProject, {
      idempotencyKey: "bootstrap-unmapped",
      actorReceiptId: unmappedReceipt,
      config: { permissionMode: "full", visibility: "visible", repositoryTargets: [TARGET_ID] },
    }));
    const unmappedFence = (unmappedBootstrap.evidence as { fenceToken: string }).fenceToken;
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(unmappedFence, {
      projectId: unmappedProject,
      idempotencyKey: "create-unmapped",
      actorReceiptId: unmappedReceipt,
      workItem: { workItemId: unmappedWorkItem, title: "Unmapped", body: "Fixture" },
    })).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, projectionRequest(unmappedFence, 1, {
      projectId: unmappedProject,
      idempotencyKey: "project-unmapped",
      actorReceiptId: unmappedReceipt,
      workItemId: unmappedWorkItem,
    }), adapter).outcome).toBe("EXTERNAL_TARGET_REQUIRED");
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1, {
      idempotencyKey: "foreign-work-item",
      workItemId: unmappedWorkItem,
    }), adapter).outcome).toBe("WORK_ITEM_FOREIGN");
    expect(adapter.mutationCalls).toHaveLength(0);
    expect(adapter.readCalls).toHaveLength(0);
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1), adapter).outcome).toBe("OK");
    db.prepare("UPDATE external_work_refs SET owner = 'foreign-owner'").run();
    const calls = adapter.mutationCalls.length;
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1, { idempotencyKey: "foreign-ref" }), adapter).outcome).toBe("EXTERNAL_REF_CONFLICT");
    expect(adapter.mutationCalls).toHaveLength(calls);
  });

  it("treats external delete and close as non-authoritative without replacement creation", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    const adapter = new DeterministicGitHubIssueAdapter();
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1), adapter).outcome).toBe("OK");
    const original = adapter.snapshot(GITHUB_OWNER, GITHUB_REPO, 1)!;
    adapter.remove(GITHUB_OWNER, GITHUB_REPO, 1);
    const missingRequest = projectionRequest(fenceToken, 1, { idempotencyKey: "missing-external" });
    expect(applyWithFixtureReceipt(db, missingRequest, adapter).outcome).toBe("EXTERNAL_NOT_FOUND");
    expect(db.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = 'missing-external'").get()).toBeUndefined();
    expect(adapter.mutationCalls).toHaveLength(1);
    expect(db.prepare("SELECT lifecycle_state FROM work_items").get()).toEqual({ lifecycle_state: "proposed" });

    adapter.put(original);
    expect(applyWithFixtureReceipt(db, missingRequest, adapter).outcome).toBe("OK");
    const unavailableRequest = projectionRequest(fenceToken, 1, { idempotencyKey: "unavailable-external" });
    adapter.readOutcomes.push("unavailable");
    expect(applyWithFixtureReceipt(db, unavailableRequest, adapter).outcome).toBe("EXTERNAL_UNAVAILABLE");
    expect(db.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = 'unavailable-external'").get()).toBeUndefined();
    expect(applyWithFixtureReceipt(db, unavailableRequest, adapter).outcome).toBe("OK");

    adapter.put({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      issueNumber: 1,
      title: "[bb] Ship projection",
      body: "canonical: Keep canonical state local.",
      state: "closed",
      labels: ["work-proposed"],
      externalRevision: "manual-close",
    });
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1, { idempotencyKey: "closed-external" }), adapter).outcome).toBe("EXTERNAL_DIVERGED");
    expect(adapter.mutationCalls).toHaveLength(1);
    expect(db.prepare("SELECT lifecycle_state FROM work_items").get()).toEqual({ lifecycle_state: "proposed" });
    expect(db.prepare("SELECT projection_state FROM external_work_refs").get()).toEqual({ projection_state: "drifted" });
  });

  it("preserves unmanaged labels while projecting a canonical lifecycle transition", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    const adapter = new DeterministicGitHubIssueAdapter();
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1), adapter).outcome).toBe("OK");
    const external = adapter.snapshot(GITHUB_OWNER, GITHUB_REPO, 1)!;
    adapter.put({ ...external, labels: [...external.labels, "human-triage"], externalRevision: "manual-unmanaged-label" });
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "ready", 1)).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 2), adapter).outcome).toBe("OK");
    expect(adapter.mutationCalls[1]).toMatchObject({
      kind: "update",
      addLabels: ["work-ready"],
      removeLabels: ["work-proposed"],
    });
    expect(adapter.snapshot(GITHUB_OWNER, GITHUB_REPO, 1)?.labels).toEqual(["human-triage", "work-ready"]);
    expect(db.prepare("SELECT lifecycle_state, resource_revision FROM work_items").get()).toEqual({ lifecycle_state: "ready", resource_revision: 2 });
  });

  it("durably fences contradictory delivery and suppresses same/new-key retry after reopen", () => {
    const { db, path, directory } = directDatabase();
    try {
      seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      const bootstrapped = applyFixtureMutation(db, bootstrapRequest());
      const fenceToken = (bootstrapped.evidence as { fenceToken: string }).fenceToken;
      expect(applyFixtureMutation(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
      const adapter = new DeterministicGitHubIssueAdapter();
      adapter.nextMutationOutcome = "wrong_identity";
      const mutate = adapter.mutate.bind(adapter);
      let reservationInsideMutation: unknown;
      adapter.mutate = (input) => {
        reservationInsideMutation = db.prepare(
          `SELECT state_events.event_type, state_events.actor_receipt_id, actor_receipts.verification_state,
                  external_work_refs.projection_state
           FROM state_events
           JOIN actor_receipts ON actor_receipts.project_id = state_events.project_id
             AND actor_receipts.receipt_id = state_events.actor_receipt_id
           JOIN external_work_refs ON external_work_refs.project_id = state_events.project_id
             AND external_work_refs.work_item_id = state_events.aggregate_id
           WHERE state_events.event_type = 'github_issue_projection_reserved'
           ORDER BY state_events.event_sequence DESC LIMIT 1`,
        ).get();
        return mutate(input);
      };
      const request = projectionRequest(fenceToken, 1);
      const ambiguous = applyFixtureMutation(db, request, adapter);
      expect(ambiguous).toMatchObject({ outcome: "EXTERNAL_DELIVERY_AMBIGUOUS", attempted: 1, verified: 0 });
      expect(reservationInsideMutation).toEqual({
        event_type: "github_issue_projection_reserved",
        actor_receipt_id: RECEIPT_ID,
        verification_state: "verified",
        projection_state: "pending",
      });
      expect(adapter.mutationCalls).toHaveLength(1);
      expect(db.prepare("SELECT projection_state FROM external_work_refs").get()).toEqual({ projection_state: "delivery_ambiguous" });
      const before = exportFoundation(db, PROJECT_ID);
      db.close();

      const reopened = new Database(path);
      databaseIsReady(reopened);
      try {
        expect(reopened.prepare(
          "SELECT event_type, actor_receipt_id FROM state_events WHERE event_type = 'github_issue_projection_reserved'",
        ).get()).toEqual({ event_type: "github_issue_projection_reserved", actor_receipt_id: RECEIPT_ID });
        const retryAdapter = new DeterministicGitHubIssueAdapter();
        expect(applyFixtureMutation(reopened, request, retryAdapter)).toEqual(ambiguous);
        expect(applyFixtureMutation(reopened, { ...request, idempotencyKey: "new-key-after-ambiguity" }, retryAdapter).outcome).toBe("EXTERNAL_DELIVERY_AMBIGUOUS");
        expect(retryAdapter.mutationCalls).toHaveLength(0);
        expect(retryAdapter.readCalls).toHaveLength(0);
        expect(exportFoundation(reopened, PROJECT_ID)).toEqual(before);
      } finally {
        reopened.close();
      }
    } finally {
      if (db.open) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("durably fences an update whose exact read-back is lost", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    const adapter = new DeterministicGitHubIssueAdapter();
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1), adapter).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "ready", 1)).outcome).toBe("OK");
    adapter.readOutcomes.push("normal", "missing");
    const request = projectionRequest(fenceToken, 2);
    const ambiguous = applyWithFixtureReceipt(db, request, adapter);
    expect(ambiguous.outcome).toBe("EXTERNAL_DELIVERY_AMBIGUOUS");
    expect(adapter.mutationCalls).toHaveLength(2);
    expect(db.prepare(
      "SELECT event_type, actor_receipt_id FROM state_events WHERE event_type = 'github_issue_projection_reserved' ORDER BY event_sequence",
    ).all()).toEqual([
      { event_type: "github_issue_projection_reserved", actor_receipt_id: RECEIPT_ID },
      { event_type: "github_issue_projection_reserved", actor_receipt_id: RECEIPT_ID },
    ]);
    expect(db.prepare("SELECT projection_state FROM external_work_refs").get()).toEqual({ projection_state: "delivery_ambiguous" });
    const calls = adapter.mutationCalls.length;
    expect(applyWithFixtureReceipt(db, request, adapter)).toEqual(ambiguous);
    expect(applyWithFixtureReceipt(db, { ...request, idempotencyKey: "update-after-ambiguous" }, adapter).outcome).toBe("EXTERNAL_DELIVERY_AMBIGUOUS");
    expect(adapter.mutationCalls).toHaveLength(calls);
  });

  it("fences a WorkItem transition/projection race after the one external mutation", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    const adapter = new DeterministicGitHubIssueAdapter();
    const mutate = adapter.mutate.bind(adapter);
    adapter.mutate = (input) => {
      const snapshot = mutate(input);
      expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "ready", 1, { idempotencyKey: "race-winner" })).outcome).toBe("OK");
      return snapshot;
    };
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1), adapter).outcome).toBe("EXTERNAL_DELIVERY_AMBIGUOUS");
    expect(adapter.mutationCalls).toHaveLength(1);
    expect(db.prepare("SELECT lifecycle_state, resource_revision FROM work_items").get()).toEqual({ lifecycle_state: "ready", resource_revision: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM state_events WHERE aggregate_type = 'work_item'").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT projection_state FROM external_work_refs").get()).toEqual({ projection_state: "pending" });
  });

  it("never overwrites a newer reservation or finalized ref with stale projection context", async () => {
    const driftHost = await loadedHost();
    const { db: driftDb, fenceToken: driftFence } = seedAndBootstrap(driftHost);
    expect(applyWithFixtureReceipt(driftDb, workItemCreateRequest(driftFence)).outcome).toBe("OK");
    const driftAdapter = new DeterministicGitHubIssueAdapter();
    expect(applyWithFixtureReceipt(driftDb, projectionRequest(driftFence, 1), driftAdapter).outcome).toBe("OK");
    const drifted = driftAdapter.snapshot(GITHUB_OWNER, GITHUB_REPO, 1)!;
    driftAdapter.put({ ...drifted, state: "closed", externalRevision: "manual-close" });
    const read = driftAdapter.read.bind(driftAdapter);
    driftAdapter.read = (owner, repo, issueNumber) => {
      const snapshot = read(owner, repo, issueNumber);
      driftDb.prepare(
        `UPDATE external_work_refs SET projection_state = 'pending', desired_digest = 'newer-desired',
         last_idempotency_key = 'newer-reservation', last_request_digest = 'newer-request'
         WHERE project_id = ? AND work_item_id = ?`,
      ).run(PROJECT_ID, WORK_ITEM_ID);
      return snapshot;
    };
    expect(applyWithFixtureReceipt(driftDb, projectionRequest(driftFence, 1, { idempotencyKey: "stale-drift" }), driftAdapter).outcome).toBe("EXTERNAL_DIVERGED");
    expect(driftDb.prepare("SELECT projection_state, desired_digest, last_idempotency_key FROM external_work_refs").get()).toEqual({
      projection_state: "pending",
      desired_digest: "newer-desired",
      last_idempotency_key: "newer-reservation",
    });
    expect(driftDb.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = 'stale-drift'").get()).toBeUndefined();

    const finalizeHost = await loadedHost();
    const { db: finalizeDb, fenceToken: finalizeFence } = seedAndBootstrap(finalizeHost);
    expect(applyWithFixtureReceipt(finalizeDb, workItemCreateRequest(finalizeFence)).outcome).toBe("OK");
    const finalizeAdapter = new DeterministicGitHubIssueAdapter();
    const mutate = finalizeAdapter.mutate.bind(finalizeAdapter);
    finalizeAdapter.mutate = (input) => {
      const snapshot = mutate(input);
      finalizeDb.prepare(
        `UPDATE external_work_refs SET issue_number = ?, projection_state = 'current',
         projected_resource_revision = 1, desired_digest = 'newer-finalized',
         observed_external_revision = 'newer-revision', observed_external_digest = 'newer-observed',
         last_idempotency_key = 'newer-finalization', last_request_digest = 'newer-request'
         WHERE project_id = ? AND work_item_id = ?`,
      ).run(snapshot.issueNumber, PROJECT_ID, WORK_ITEM_ID);
      return snapshot;
    };
    expect(applyWithFixtureReceipt(finalizeDb, projectionRequest(finalizeFence, 1), finalizeAdapter).outcome).toBe("EXTERNAL_DELIVERY_AMBIGUOUS");
    expect(finalizeDb.prepare("SELECT projection_state, desired_digest, last_idempotency_key FROM external_work_refs").get()).toEqual({
      projection_state: "current",
      desired_digest: "newer-finalized",
      last_idempotency_key: "newer-finalization",
    });
    expect(finalizeDb.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = 'project-github-1'").get()).toBeUndefined();
  });

  it("accepts partial lifecycle-label maps and rejects unknown or undeclared labels", async () => {
    const partialHost = await loadedHost();
    const partialDb = partialHost.bb.storage.database();
    seedVerifiedFixtureReceipt(partialDb, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
    const partialConfig = structuredClone(bootstrapRequest().config) as {
      extensions: { bbCollab: { githubIssues: { issue: { managedLabels: { byLifecycle: Record<string, string[]> } } } } };
    };
    partialConfig.extensions.bbCollab.githubIssues.issue.managedLabels.byLifecycle = { ready: ["work-ready"] };
    expect(applyWithFixtureReceipt(partialDb, bootstrapRequest(PROJECT_ID, { config: partialConfig })).outcome).toBe("OK");

    const invalidLifecycleLabels: Array<[string, Record<string, string[]>]> = [
      ["unknown", { parked: ["work-ready"] }],
      ["undeclared", { ready: ["not-declared"] }],
    ];
    for (const [name, byLifecycle] of invalidLifecycleLabels) {
      const host = await loadedHost();
      const db = host.bb.storage.database();
      seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      const config = structuredClone(bootstrapRequest().config) as typeof partialConfig;
      config.extensions.bbCollab.githubIssues.issue.managedLabels.byLifecycle = byLifecycle;
      expect(applyWithFixtureReceipt(db, bootstrapRequest(PROJECT_ID, { idempotencyKey: `labels-${name}`, config })).outcome).toBe("INVALID_INPUT");
      expect(db.prepare("SELECT COUNT(*) AS count FROM project_config_revisions").get()).toEqual({ count: 0 });
    }
  });

  it("rejects malformed or duplicate namespaced GitHub mappings before bootstrap mutation", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
    const base = bootstrapRequest().config as Record<string, unknown>;
    const extensions = structuredClone(base.extensions) as {
      bbCollab: { githubIssues: { repositoryMappings: unknown[] } };
    };
    extensions.bbCollab.githubIssues.repositoryMappings.push({ repoTargetId: TARGET_ID, owner: "other", repo: "other", connectorHost: CONNECTOR_HOST });
    expect(applyWithFixtureReceipt(db, bootstrapRequest(PROJECT_ID, { config: { ...base, extensions } })).outcome).toBe("INVALID_INPUT");
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_config_revisions").get()).toEqual({ count: 0 });
  });

  it("records immutable qualification and activates one exact first orchestrator generation", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const facts = roleReader();
    const qualified = applyWithFixtureReceipt(db, qualificationRequest(fenceToken), null, facts);
    expect(qualified).toMatchObject({ outcome: "OK", expected: 1, attempted: 1, verified: 1 });
    const activated = applyWithFixtureReceipt(db, successionRequest(fenceToken), null, facts);
    expect(activated).toMatchObject({ outcome: "OK", currentResourceRevision: 1 });
    expect(db.prepare("SELECT role_id, generation, status, predecessor_generation FROM role_generations").get()).toEqual({
      role_id: "project-orchestrator",
      generation: 1,
      status: "active",
      predecessor_generation: null,
    });
    expect(db.prepare("SELECT role_id, current_generation FROM role_generation_heads").get()).toEqual({
      role_id: "project-orchestrator",
      current_generation: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM qualification_observations").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM state_events WHERE aggregate_type IN ('qualification_observation', 'role_generation')").get()).toEqual({ count: 2 });
    const firstExport = exportFoundation(db, PROJECT_ID);
    expect(exportFoundation(db, PROJECT_ID)).toEqual(firstExport);
    expect((firstExport.export?.manifest.tableCounts ?? {})).toMatchObject({
      qualification_observations: 1,
      eligibility_projections: 1,
      role_generations: 1,
      role_generation_heads: 1,
    });
    const rawFacts = roleReader((value) => {
      value.thread.visibility = "hidden";
      value.events[3]!.data.status = "failed";
    });
    expect(rawFacts.facts.thread.visibility).toBe("hidden");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(firstExport);
    const doctorResult = await host.harness.callRpc("doctor", { projectId: PROJECT_ID });
    expect(doctorResult).toMatchObject({
      outcome: "OK",
      evidence: {
        qualificationObservationCount: 1,
        roleGenerationHeads: [{ role_id: "project-orchestrator", current_generation: 1, status: "active" }],
        eligibility: [{ roleRequirementId: "orchestrator-v1", effectiveStatus: "eligible" }],
        cachedConsumers: { expected: 4, attempted: 4, verified: 4 },
      },
    });
    const beforeProductionRefusal = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", successionRequest(fenceToken, { idempotencyKey: "production-role" }))).toMatchObject({
      outcome: "OPERATOR_RECEIPT_REQUIRED",
      expected: 1,
      attempted: 0,
      verified: 0,
    });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeProductionRefusal);
  });

  it("requires exact target binding for the independent reviewer", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const facts = roleReader();
    const reviewerQualification = qualificationRequest(fenceToken, {
      idempotencyKey: "reviewer-qualification",
      repoTargetId: TARGET_ID,
      roleId: "independent-reviewer",
      roleRequirementId: "reviewer-v1",
      qualificationId: "reviewer-qualification",
    });
    const before = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, { ...reviewerQualification, idempotencyKey: "reviewer-missing-target", repoTargetId: null }, null, facts).outcome).toBe("REPO_TARGET_REQUIRED");
    expect(applyWithFixtureReceipt(db, { ...reviewerQualification, idempotencyKey: "reviewer-foreign-target", repoTargetId: SECOND_TARGET_ID }, null, facts).outcome).toBe("REPO_TARGET_FOREIGN");
    const wrongTargetContext = roleReader((value) => {
      value.environment.path = "/workspace/other";
      value.project.sources[0]!.path = "/workspace/other";
    });
    expect(applyWithFixtureReceipt(db, { ...reviewerQualification, idempotencyKey: "reviewer-wrong-context", qualificationId: "reviewer-wrong-context" }, null, wrongTargetContext).outcome).toBe("ROLE_CONTEXT_FOREIGN");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
    expect(applyWithFixtureReceipt(db, reviewerQualification, null, facts).outcome).toBe("OK");
    const reviewerSuccession = successionRequest(fenceToken, {
      idempotencyKey: "reviewer-succession",
      repoTargetId: TARGET_ID,
      roleId: "independent-reviewer",
      roleRequirementId: "reviewer-v1",
      qualificationId: "reviewer-qualification",
    });
    expect(applyWithFixtureReceipt(db, reviewerSuccession, null, facts).outcome).toBe("OK");
    expect(db.prepare("SELECT repo_target_id, status FROM role_generations WHERE role_id = 'independent-reviewer'").get()).toEqual({
      repo_target_id: TARGET_ID,
      status: "active",
    });
  });

  it("decides replay and conflict before role fact access and does not cache transient unknown facts", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const request = qualificationRequest(fenceToken);
    const firstReader = roleReader();
    const committed = applyWithFixtureReceipt(db, request, null, firstReader);
    expect(committed.outcome).toBe("OK");
    const reads = firstReader.readCalls.length;
    expect(applyWithFixtureReceipt(db, request, null, null)).toEqual(committed);
    expect(applyWithFixtureReceipt(db, { ...request, reasonCode: "conflicting-reuse" }, null, null).outcome).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(firstReader.readCalls).toHaveLength(reads);

    const transient = qualificationRequest(fenceToken, { idempotencyKey: "transient-context", qualificationId: "transient-context" });
    const unavailable = roleReader((facts) => { facts.thread.id = "other-thread"; });
    expect(applyWithFixtureReceipt(db, transient, null, unavailable).outcome).toBe("ROLE_CONTEXT_UNKNOWN");
    expect(db.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = 'transient-context'").get()).toBeUndefined();
    expect(applyWithFixtureReceipt(db, transient, null, roleReader()).outcome).toBe("OK");
  });

  it("keeps failed declared-profile evidence immutable and replaces only current eligibility", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const mismatch = qualificationRequest(fenceToken, {
      idempotencyKey: "qualification-mismatch",
      qualificationId: "qualification-mismatch",
      declaredProfile: { ...ROLE_PROFILE, model: "declared-only-model" },
    });
    expect(applyWithFixtureReceipt(db, mismatch, null, roleReader())).toMatchObject({
      outcome: "EXECUTION_PROFILE_MISMATCH",
      attempted: 1,
      verified: 1,
      evidence: { effectiveStatus: "ineligible", reasonCode: "execution_profile_mismatch" },
    });
    expect(db.prepare("SELECT outcome FROM qualification_observations WHERE qualification_id = 'qualification-mismatch'").get()).toEqual({ outcome: "unqualified" });
    expect(applyWithFixtureReceipt(db, successionRequest(fenceToken, {
      idempotencyKey: "mismatch-succession",
      qualificationId: "qualification-mismatch",
    }), null, roleReader()).outcome).toBe("ROLE_UNQUALIFIED");

    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken), null, roleReader()).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
      idempotencyKey: "qualification-2",
      qualificationId: "qualification-2",
      reasonCode: "replacement_passed",
    }), null, roleReader()).outcome).toBe("OK");
    expect(db.prepare("SELECT qualification_id, outcome FROM qualification_observations ORDER BY qualification_id").all()).toEqual([
      { qualification_id: "qualification-1", outcome: "qualified" },
      { qualification_id: "qualification-2", outcome: "qualified" },
      { qualification_id: "qualification-mismatch", outcome: "unqualified" },
    ]);
    expect(db.prepare("SELECT current_qualification_id FROM eligibility_projections").get()).toEqual({ current_qualification_id: "qualification-2" });
  });

  it("refuses hidden, foreign, missing, ambiguous, and incomplete BB holder contexts without mutation", async () => {
    const cases: Array<[string, (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => void, string, Partial<ApplyRequest>?]> = [
      ["hidden", (facts) => { facts.thread.visibility = "hidden"; }, "ROLE_CONTEXT_HIDDEN"],
      ["foreign-thread", (facts) => { facts.thread.projectId = FOREIGN_PROJECT_ID; }, "ROLE_CONTEXT_FOREIGN"],
      ["missing-environment", (facts) => { facts.thread.environmentId = null; }, "ROLE_CONTEXT_REQUIRED"],
      ["foreign-environment", (facts) => { facts.environment.projectId = FOREIGN_PROJECT_ID; }, "ROLE_CONTEXT_FOREIGN"],
      ["source-mismatch", (facts) => { facts.project.sources[0]!.path = "/other"; }, "ROLE_CONTEXT_FOREIGN"],
      ["ambiguous-source", (facts) => { facts.project.sources.push({ ...facts.project.sources[0]!, id: "source-duplicate" }); }, "ROLE_CONTEXT_FOREIGN"],
      ["host-unavailable", (facts) => { facts.host.status = "disconnected"; }, "ROLE_CONTEXT_UNKNOWN"],
      ["missing-start", (facts) => { facts.events = facts.events.filter((event) => event.type !== "turn/started"); }, "EXECUTION_PROFILE_UNKNOWN"],
      ["failed-completion", (facts) => { facts.events[3]!.data.status = "failed"; }, "EXECUTION_PROFILE_UNKNOWN"],
      ["duplicate-completion", (facts) => { facts.events.push({ id: "completion-2", seq: 5, type: "turn/completed", data: { providerThreadId: "provider-thread-1", status: "completed" } }); }, "EXECUTION_COMPLETION_AMBIGUOUS"],
      ["model-fallback", (facts) => {
        facts.events[3]!.seq = 5;
        facts.events.splice(3, 0, { id: "fallback", seq: 4, type: "provider/modelFallback", data: { providerThreadId: "provider-thread-1" } });
      }, "EXECUTION_PROFILE_UNKNOWN", { roleContext: { threadId: ROLE_THREAD_ID, requestEventId: ROLE_REQUEST_EVENT_ID, requestEventSeq: 1, completionEventId: ROLE_COMPLETION_EVENT_ID, completionEventSeq: 5 } }],
    ];
    for (const [name, mutate, outcome, requestOverride] of cases) {
      const host = await loadedHost();
      const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
      const before = exportFoundation(db, PROJECT_ID);
      const result = applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
        idempotencyKey: `context-${name}`,
        qualificationId: `context-${name}`,
        ...requestOverride,
      }), null, roleReader(mutate));
      expect(result.outcome, name).toBe(outcome);
      expect(exportFoundation(db, PROJECT_ID), name).toEqual(before);
    }
  });

  it("serializes role-head contenders and preserves exact state after reopen", () => {
    const { db: firstDb, path, directory } = directDatabase();
    const secondDb = new Database(path);
    databaseIsReady(secondDb);
    try {
      seedVerifiedFixtureReceipt(firstDb, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      const bootstrapped = applyFixtureMutation(firstDb, bootstrapRequest(PROJECT_ID, { config: roleConfig() }));
      const fenceToken = (bootstrapped.evidence as { fenceToken: string }).fenceToken;
      expect(applyWithFixtureReceipt(firstDb, qualificationRequest(fenceToken), null, roleReader()).outcome).toBe("OK");
      expect(applyWithFixtureReceipt(firstDb, successionRequest(fenceToken), null, roleReader()).outcome).toBe("OK");
      expect(applyWithFixtureReceipt(firstDb, qualificationRequest(fenceToken, {
        idempotencyKey: "qualification-2",
        qualificationId: "qualification-2",
      }), null, roleReader()).outcome).toBe("OK");
      const successor = successionRequest(fenceToken, {
        idempotencyKey: "succession-2",
        qualificationId: "qualification-2",
        expectedGeneration: 1,
        predecessorGeneration: 1,
      });
      const winner = applyWithFixtureReceipt(firstDb, successor, null, roleReader());
      const loser = applyWithFixtureReceipt(secondDb, { ...successor, idempotencyKey: "succession-loser" }, null, roleReader());
      expect(winner).toMatchObject({ outcome: "OK", currentResourceRevision: 2 });
      expect(loser).toMatchObject({ outcome: "ROLE_GENERATION_STALE", currentResourceRevision: 2, expectedResourceRevision: 1 });
      expect(firstDb.prepare("SELECT generation, status FROM role_generations ORDER BY generation").all()).toEqual([
        { generation: 1, status: "retired" },
        { generation: 2, status: "active" },
      ]);
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE idempotency_key = 'succession-loser'").get()).toEqual({ count: 0 });
      const beforeReopen = exportFoundation(firstDb, PROJECT_ID);
      firstDb.close();
      const reopened = new Database(path);
      databaseIsReady(reopened);
      try {
        expect(applyWithFixtureReceipt(reopened, successor, null, null)).toEqual(winner);
        expect(exportFoundation(reopened, PROJECT_ID)).toEqual(beforeReopen);
      } finally {
        reopened.close();
      }
    } finally {
      secondDb.close();
      if (firstDb.open) firstDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back successor authority when the late mutation receipt insert fails", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken), null, roleReader()).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, successionRequest(fenceToken), null, roleReader()).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
      idempotencyKey: "late-failure-qualification",
      qualificationId: "late-failure-qualification",
    }), null, roleReader()).outcome).toBe("OK");
    const request = successionRequest(fenceToken, {
      idempotencyKey: "late-receipt-failure",
      qualificationId: "late-failure-qualification",
      expectedGeneration: 1,
      predecessorGeneration: 1,
    });
    const before = exportFoundation(db, PROJECT_ID);
    const facts = roleReader();
    db.exec(`CREATE TEMP TRIGGER fail_late_role_receipt
      BEFORE INSERT ON mutation_receipts
      WHEN NEW.operation_class = 'role_generation_succession'
        AND NEW.idempotency_key = 'late-receipt-failure'
      BEGIN
        SELECT RAISE(ABORT, 'late role receipt failure');
      END`);
    try {
      const failed = applyWithFixtureReceipt(db, request, null, facts);
      expect(failed).toMatchObject({ outcome: "INTERNAL_ERROR", expected: 1, attempted: 0, verified: 0 });
      expect(failed).not.toHaveProperty("mutationReceipt");
      expect(failed).not.toHaveProperty("eventSequence");
      expect(facts.readCalls).toEqual([
        "server.id",
        `thread:${ROLE_THREAD_ID}`,
        `events:${ROLE_THREAD_ID}`,
        `environment:${ROLE_ENVIRONMENT_ID}`,
        `project:${PROJECT_ID}`,
        "host:host-main",
        "system.version",
      ]);
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
      expect(db.prepare("SELECT generation, status, retired_at_ms FROM role_generations ORDER BY generation").all()).toEqual([
        { generation: 1, status: "active", retired_at_ms: null },
      ]);
      expect(db.prepare("SELECT current_generation FROM role_generation_heads").get()).toEqual({ current_generation: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM state_events WHERE idempotency_key = 'late-receipt-failure'").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE idempotency_key = 'late-receipt-failure'").get()).toEqual({ count: 0 });
    } finally {
      db.exec("DROP TRIGGER fail_late_role_receipt");
    }
  });

  it("accepts only a verified current role actor bound to the holder execution reference", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken), null, roleReader()).outcome).toBe("OK");
    const first = applyWithFixtureReceipt(db, successionRequest(fenceToken), null, roleReader());
    const holderExecutionAttemptId = (first.evidence as { holderExecutionAttemptId: string }).holderExecutionAttemptId;
    seedVerifiedFixtureReceipt(db, {
      projectId: PROJECT_ID,
      receiptId: "role-actor-current",
      actorKind: "role",
      subjectId: holderExecutionAttemptId,
      roleId: "project-orchestrator",
      roleGeneration: 1,
    });
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
      idempotencyKey: "role-actor-qualification",
      actorReceiptId: "role-actor-current",
      qualificationId: "role-actor-qualification",
    }), null, roleReader()).outcome).toBe("OK");
    seedVerifiedFixtureReceipt(db, {
      projectId: PROJECT_ID,
      receiptId: "role-actor-wrong-holder",
      actorKind: "role",
      subjectId: "wrong-holder",
      roleId: "project-orchestrator",
      roleGeneration: 1,
    });
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
      idempotencyKey: "wrong-holder-qualification",
      actorReceiptId: "role-actor-wrong-holder",
      qualificationId: "wrong-holder-qualification",
    }), null, roleReader()).outcome).toBe("ROLE_HOLDER_MISMATCH");
    expect(db.prepare("SELECT 1 FROM qualification_observations WHERE qualification_id = 'wrong-holder-qualification'").get()).toBeUndefined();
  });

  it("derives expiry and config staleness at read time without automatic role mutation", async () => {
    const expiryHost = await loadedHost();
    const { db: expiryDb, fenceToken: expiryFence } = seedAndBootstrap(expiryHost, PROJECT_ID, { config: roleConfig() });
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    try {
      expect(applyWithFixtureReceipt(expiryDb, qualificationRequest(expiryFence, { observedAtMs: 50, expiresAtMs: 200 }), null, roleReader()).outcome).toBe("OK");
      expect(applyWithFixtureReceipt(expiryDb, successionRequest(expiryFence), null, roleReader()).outcome).toBe("OK");
      clock.mockReturnValue(300);
      expect(applyWithFixtureReceipt(expiryDb, successionRequest(expiryFence, {
        idempotencyKey: "expired-successor",
        expectedGeneration: 1,
        predecessorGeneration: 1,
      }), null, roleReader()).outcome).toBe("ELIGIBILITY_EXPIRED");
      expect(expiryDb.prepare("SELECT generation, status FROM role_generations").all()).toEqual([{ generation: 1, status: "active" }]);
      expect(await expiryHost.harness.callRpc("doctor", { projectId: PROJECT_ID })).toMatchObject({
        evidence: { eligibility: [{ effectiveStatus: "expired", reasonCode: "eligibility_expired" }] },
      });
    } finally {
      clock.mockRestore();
    }

    const staleHost = await loadedHost();
    const { db: staleDb, fenceToken: staleFence } = seedAndBootstrap(staleHost, PROJECT_ID, { config: roleConfig() });
    expect(applyWithFixtureReceipt(staleDb, qualificationRequest(staleFence), null, roleReader()).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(staleDb, successionRequest(staleFence), null, roleReader()).outcome).toBe("OK");
    const config2 = roleConfig();
    (config2 as Record<string, unknown>).note = "new immutable revision";
    expect(applyWithFixtureReceipt(staleDb, {
      ...bootstrapRequest(PROJECT_ID, { config: config2 }),
      operationClass: "config_revision",
      idempotencyKey: "role-config-2",
      expectedConfigRevision: 1,
      configRevision: 2,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: staleFence,
    }).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(staleDb, successionRequest(staleFence, {
      idempotencyKey: "stale-successor",
      expectedConfigRevision: 2,
      expectedGeneration: 1,
      predecessorGeneration: 1,
    }), null, roleReader()).outcome).toBe("ELIGIBILITY_STALE");
    expect(staleDb.prepare("SELECT generation, status FROM role_generations").all()).toEqual([{ generation: 1, status: "active" }]);
  });

  it("migrates v3 role evidence to v4 without manufacturing a canonical holder attempt", async () => {
    const fixture = await assignmentFixture();
    const { db, host } = fixture;
    const holder = db.prepare("SELECT holder_execution_attempt_id FROM role_generations WHERE role_id = 'project-orchestrator'").get() as { holder_execution_attempt_id: string };
    expect(db.prepare("SELECT origin, state FROM execution_attempts WHERE execution_attempt_id = ?").get(holder.holder_execution_attempt_id)).toEqual({ origin: "role_holder", state: "done" });

    db.pragma("foreign_keys = OFF");
    db.exec("DROP TABLE execution_attempts; DROP TABLE assignments");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATIONS.at(-5)!);
    expect(db.prepare("SELECT 1 FROM execution_attempts WHERE execution_attempt_id = ?").get(holder.holder_execution_attempt_id)).toBeUndefined();
    expect(exportFoundation(db, PROJECT_ID)).toEqual(exportFoundation(db, PROJECT_ID));
    expect(await host.harness.callRpc("doctor", { projectId: PROJECT_ID })).toMatchObject({
      outcome: "OK",
      evidence: { unresolvedRoleHolders: [{ reason: "ROLE_HOLDER_UNRESOLVED", holderExecutionAttemptId: holder.holder_execution_attempt_id }] },
    });
    seedVerifiedFixtureReceipt(db, {
      projectId: PROJECT_ID,
      receiptId: "legacy-role-actor",
      actorKind: "role",
      subjectId: holder.holder_execution_attempt_id,
      roleId: "project-orchestrator",
      roleGeneration: 1,
    });
    expect(applyWithFixtureReceipt(db, qualificationRequest(fixture.fenceToken, {
      idempotencyKey: "legacy-holder-refusal",
      actorReceiptId: "legacy-role-actor",
      qualificationId: "legacy-holder-refusal",
    }), null, roleReader()).outcome).toBe("ROLE_HOLDER_MISMATCH");
    expect(cachedConsumerRolloutEvidence(7)).toMatchObject({ oldSchemaVersion: 7, newSchemaVersion: 8, action: "refused", expected: 4, attempted: 4, verified: 0 });
    expect(cachedConsumerRolloutEvidence(8)).toMatchObject({ oldSchemaVersion: 7, newSchemaVersion: 8, action: "reread", expected: 4, attempted: 4, verified: 4 });
  });

  it("reserves before native dispatch and accepts one exact terminal report", async () => {
    const { db, fenceToken } = await assignmentFixture();
    const adapter = new DeterministicNativeAssignmentAdapter();
    const prepare = assignmentPrepareRequest(fenceToken);
    const prepared = applyWithFixtureReceipt(db, prepare, null, null, adapter);
    expect(prepared).toMatchObject({ outcome: "OK", evidence: { assignmentId: "assignment-1", writingLaneCeiling: 2, activeWriterCount: 1 } });
    expect(applyWithFixtureReceipt(db, prepare, null, null, adapter)).toEqual(prepared);
    expect(adapter.inspectCalls).toHaveLength(1);
    expect(adapter.dispatchCalls).toHaveLength(0);
    const executionAttemptId = (prepared.evidence as { executionAttemptId: string }).executionAttemptId;
    expect(db.prepare("SELECT state FROM execution_attempts WHERE execution_attempt_id = ?").get(executionAttemptId)).toEqual({ state: "prepared" });

    const dispatch = assignmentPhaseRequest(fenceToken, "assignment_dispatch", "assignment-1", executionAttemptId);
    expect(applyWithFixtureReceipt(db, { ...dispatch, idempotencyKey: "dispatch-wrong-brief", frozenBriefContent: `${FROZEN_BRIEF}\nwrong` }, null, null, adapter).outcome).toBe("ASSIGNMENT_HEAD_STALE");
    expect(adapter.dispatchCalls).toHaveLength(0);
    const delivered = applyWithFixtureReceipt(db, dispatch, null, null, adapter);
    expect(delivered).toMatchObject({ outcome: "OK", evidence: { state: "content_delivered", actualProfileDigest: ROLE_PROFILE_DIGEST } });
    expect(adapter.dispatchCalls).toHaveLength(1);
    expect(adapter.dispatchCalls[0]?.executionInputSources).toEqual({
      providerId: "explicit",
      model: "explicit",
      serviceTier: "explicit",
      reasoningLevel: "explicit",
      permissionMode: "explicit",
    });
    expect(adapter.dispatchCalls[0]).toMatchObject({
      candidateSha: null,
      candidateScope: { mode: "write", candidateSemantics: "base", candidateSha: null },
      requestedProfile: { providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "high", permissionMode: "full", visibility: "visible" },
    });
    expect(explicitExecutionInputSources()).toEqual({ providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" });
    const native = delivered.evidence as { nativeReceiptDigest: string; actualProfileDigest: string; threadId: string };
    const terminalReport = {
      receiptVersion: 1 as const,
      outcome: "DONE" as const,
      projectId: PROJECT_ID,
      assignmentId: "assignment-1",
      executionAttemptId,
      workItemId: WORK_ITEM_ID,
      roleId: "project-orchestrator" as const,
      roleGeneration: 1,
      repoTargetId: TARGET_ID,
      environmentId: "environment-assignment-1",
      threadId: native.threadId,
      branchName: "bb/assignment-1",
      baseSha: BASE_SHA,
      candidateSha: CANDIDATE_SHA,
      nativeReceiptDigest: native.nativeReceiptDigest,
      actualProfileDigest: native.actualProfileDigest,
      candidateObservationDigest: sha256(canonicalJson({ branchName: "bb/assignment-1", baseSha: BASE_SHA, candidateSha: CANDIDATE_SHA })),
      reasonCode: "writer_done",
      evidence: [{ kind: "test", digest: sha256("tests"), ref: "fixture" }],
      reportedAtMs: Date.now(),
      receiptEventId: "terminal-event-1",
      receiptEventSeq: 10,
      receivedAtMs: Date.now(),
    };
    const terminal = assignmentPhaseRequest(fenceToken, "assignment_terminal", "assignment-1", executionAttemptId, {
      idempotencyKey: "terminal-assignment-1",
      terminalReport,
    });
    const done = applyWithFixtureReceipt(db, terminal, null, null, adapter);
    expect(done).toMatchObject({ outcome: "OK", evidence: { state: "done", terminalResult: "DONE" } });
    expect(applyWithFixtureReceipt(db, { ...terminal, idempotencyKey: "terminal-identical-replay" }, null, null, adapter)).toEqual(done);
    expect(db.prepare("SELECT state, terminal_result FROM execution_attempts WHERE execution_attempt_id = ?").get(executionAttemptId)).toEqual({ state: "done", terminal_result: "DONE" });

    const conflict = applyWithFixtureReceipt(db, {
      ...terminal,
      idempotencyKey: "terminal-conflict",
      terminalReport: { ...terminalReport, outcome: "BLOCKED", reasonCode: "conflicting" },
    }, null, null, adapter);
    expect(conflict.outcome).toBe("TERMINAL_REPORT_AMBIGUOUS");
    expect(db.prepare("SELECT state, terminal_result, conflicting_terminal_digest FROM execution_attempts WHERE execution_attempt_id = ?").get(executionAttemptId)).toMatchObject({ state: "done", terminal_result: "DONE", conflicting_terminal_digest: expect.any(String) });
    expect(applyWithFixtureReceipt(db, terminal, null, null, adapter)).toEqual(done);
  });

  it("commits one dispatch claim before interleaved callers can reach the native adapter", () => {
    const { db: firstDb, path, directory } = directDatabase();
    const secondDb = new Database(path);
    databaseIsReady(secondDb);
    try {
      const { fenceToken } = seedAssignmentDatabase(firstDb);
      const adapter = new DeterministicNativeAssignmentAdapter();
      const prepared = applyWithFixtureReceipt(firstDb, assignmentPrepareRequest(fenceToken), null, null, adapter);
      const executionAttemptId = (prepared.evidence as { executionAttemptId: string }).executionAttemptId;
      const dispatch = assignmentPhaseRequest(fenceToken, "assignment_dispatch", "assignment-1", executionAttemptId);
      const competingAdapter = new DeterministicNativeAssignmentAdapter();
      const contenders: FoundationResult[] = [];
      adapter.onDispatch = () => {
        contenders.push(applyWithFixtureReceipt(secondDb, dispatch, null, null, competingAdapter));
        contenders.push(applyWithFixtureReceipt(secondDb, { ...dispatch, idempotencyKey: "interleaved-new-key" }, null, null, competingAdapter));
      };

      expect(applyWithFixtureReceipt(firstDb, dispatch, null, null, adapter).outcome).toBe("OK");
      expect(contenders.map((candidate) => candidate.outcome)).toEqual(["DISPATCH_UNKNOWN", "DISPATCH_UNKNOWN"]);
      expect(adapter.dispatchCalls).toHaveLength(1);
      expect(competingAdapter.dispatchCalls).toHaveLength(0);
      expect(firstDb.prepare("SELECT state FROM execution_attempts WHERE execution_attempt_id = ?").get(executionAttemptId)).toEqual({ state: "content_delivered" });
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE idempotency_key LIKE 'assignment-dispatch-claim-%'").get()).toEqual({ count: 1 });
    } finally {
      secondDb.close();
      firstDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the durable dispatch claim after post-native process loss and reopen", () => {
    const { db, path, directory } = directDatabase();
    let reopened: Database.Database | null = null;
    try {
      const { fenceToken } = seedAssignmentDatabase(db);
      const adapter = new DeterministicNativeAssignmentAdapter();
      const prepared = applyWithFixtureReceipt(db, assignmentPrepareRequest(fenceToken), null, null, adapter);
      const executionAttemptId = (prepared.evidence as { executionAttemptId: string }).executionAttemptId;
      const dispatch = assignmentPhaseRequest(fenceToken, "assignment_dispatch", "assignment-1", executionAttemptId);
      adapter.onDispatch = () => db.close();

      expect(applyWithFixtureReceipt(db, dispatch, null, null, adapter).outcome).toBe("DISPATCH_UNKNOWN");
      expect(adapter.dispatchCalls).toHaveLength(1);
      reopened = new Database(path);
      databaseIsReady(reopened);
      expect(reopened.prepare("SELECT state FROM execution_attempts WHERE execution_attempt_id = ?").get(executionAttemptId)).toEqual({ state: "dispatch_unknown" });
      const retryAdapter = new DeterministicNativeAssignmentAdapter();
      expect(applyWithFixtureReceipt(reopened, dispatch, null, null, retryAdapter).outcome).toBe("DISPATCH_UNKNOWN");
      expect(applyWithFixtureReceipt(reopened, { ...dispatch, idempotencyKey: "post-loss-new-key" }, null, null, retryAdapter).outcome).toBe("DISPATCH_UNKNOWN");
      expect(applyWithFixtureReceipt(reopened, assignmentPrepareRequest(fenceToken, "assignment-after-loss"), null, null, retryAdapter).outcome).toBe("LANE_WRITER_EXISTS");
      expect(retryAdapter.dispatchCalls).toHaveLength(0);
    } finally {
      reopened?.close();
      if (db.open) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains terminal conflict after lane reuse without rewriting either history", async () => {
    const { db, fenceToken } = await assignmentFixture();
    const adapter = new DeterministicNativeAssignmentAdapter();
    const preparedA = applyWithFixtureReceipt(db, assignmentPrepareRequest(fenceToken, "lane-a"), null, null, adapter);
    const attemptA = (preparedA.evidence as { executionAttemptId: string }).executionAttemptId;
    const deliveredA = applyWithFixtureReceipt(db, assignmentPhaseRequest(fenceToken, "assignment_dispatch", "lane-a", attemptA), null, null, adapter);
    const reportA = assignmentTerminalReport("lane-a", attemptA, deliveredA.evidence as { nativeReceiptDigest: string; actualProfileDigest: string; threadId: string });
    const terminalA = assignmentPhaseRequest(fenceToken, "assignment_terminal", "lane-a", attemptA, { idempotencyKey: "terminal-lane-a", terminalReport: reportA });
    const original = applyWithFixtureReceipt(db, terminalA, null, null, adapter);
    expect(original.outcome).toBe("OK");

    const preparedB = applyWithFixtureReceipt(db, assignmentPrepareRequest(fenceToken, "lane-b"), null, null, adapter);
    const attemptB = (preparedB.evidence as { executionAttemptId: string }).executionAttemptId;
    expect(preparedB.outcome).toBe("OK");
    const conflict = applyWithFixtureReceipt(db, {
      ...terminalA,
      idempotencyKey: "terminal-lane-a-conflict-after-reuse",
      terminalReport: { ...reportA, outcome: "BLOCKED", reasonCode: "conflict_after_reuse" },
    }, null, null, adapter);
    expect(conflict.outcome).toBe("TERMINAL_REPORT_AMBIGUOUS");
    expect(db.prepare("SELECT state, terminal_result, conflicting_terminal_digest FROM execution_attempts WHERE execution_attempt_id = ?").get(attemptA)).toMatchObject({ state: "done", terminal_result: "DONE", conflicting_terminal_digest: expect.any(String) });
    expect(db.prepare("SELECT state FROM execution_attempts WHERE execution_attempt_id = ?").get(attemptB)).toEqual({ state: "prepared" });
    expect(applyWithFixtureReceipt(db, terminalA, null, null, adapter)).toEqual(original);

    const later = assignmentPrepareRequest(fenceToken, "lane-c", {
      assignment: { ...assignmentPrepareRequest(fenceToken).assignment!, assignmentId: "lane-c", laneId: "lane-free", branchName: "bb/lane-c", environment: { ...assignmentPrepareRequest(fenceToken).assignment!.environment, environmentId: "environment-lane-c" } },
    });
    expect(applyWithFixtureReceipt(db, later, null, null, adapter).outcome).toBe("TERMINAL_REPORT_AMBIGUOUS");
    expect(db.prepare("SELECT COUNT(*) AS count FROM assignments").get()).toEqual({ count: 2 });
  });

  it("treats queued or incomplete content evidence as durable dispatch ambiguity and never retries", async () => {
    const { db, fenceToken } = await assignmentFixture();
    const adapter = new DeterministicNativeAssignmentAdapter();
    const prepared = applyWithFixtureReceipt(db, assignmentPrepareRequest(fenceToken), null, null, adapter);
    const executionAttemptId = (prepared.evidence as { executionAttemptId: string }).executionAttemptId;
    adapter.nextEvidence = { disposition: "confirmed", reasonCode: "queued_only", contentEventId: undefined, contentEventSeq: undefined, contentDigest: undefined };
    const dispatch = assignmentPhaseRequest(fenceToken, "assignment_dispatch", "assignment-1", executionAttemptId);
    expect(applyWithFixtureReceipt(db, dispatch, null, null, adapter).outcome).toBe("DISPATCH_UNKNOWN");
    expect(adapter.dispatchCalls).toHaveLength(1);
    expect(applyWithFixtureReceipt(db, dispatch, null, null, adapter).outcome).toBe("DISPATCH_UNKNOWN");
    expect(applyWithFixtureReceipt(db, { ...dispatch, idempotencyKey: "dispatch-new-key" }, null, null, adapter).outcome).toBe("DISPATCH_UNKNOWN");
    expect(adapter.dispatchCalls).toHaveLength(1);
    expect(db.prepare("SELECT state FROM execution_attempts WHERE execution_attempt_id = ?").get(executionAttemptId)).toEqual({ state: "dispatch_unknown" });

    const reconcile = assignmentPhaseRequest(fenceToken, "assignment_reconcile", "assignment-1", executionAttemptId);
    const retained = db.prepare(
      `SELECT thread_id, provider_thread_id, native_request_id, request_event_id, request_event_seq,
              accepted_event_id, accepted_event_seq, first_action_event_id, first_action_event_seq,
              content_event_id, content_event_seq, content_receipt_digest, actual_profile_digest,
              native_receipt_digest, last_event_seq FROM execution_attempts WHERE execution_attempt_id = ?`,
    ).get(executionAttemptId);
    adapter.nextEvidence = {
      disposition: "refused",
      reasonCode: "empty_refusal",
      assignmentId: undefined,
      executionAttemptId: undefined,
      bbServerId: undefined,
      projectId: undefined,
      environmentId: undefined,
    };
    expect(applyWithFixtureReceipt(db, reconcile, null, null, adapter).outcome).toBe("EXECUTION_CONTEXT_FOREIGN");
    expect(db.prepare("SELECT state FROM execution_attempts WHERE execution_attempt_id = ?").get(executionAttemptId)).toEqual({ state: "dispatch_unknown" });

    adapter.nextEvidence = { providerThreadId: "foreign-provider-thread" };
    const contradiction = applyWithFixtureReceipt(db, { ...reconcile, idempotencyKey: "reconcile-contradiction" }, null, null, adapter);
    expect(contradiction).toMatchObject({ outcome: "DISPATCH_UNKNOWN", evidence: { reasonCode: "retained_native_evidence_contradiction" } });
    expect(db.prepare(
      `SELECT thread_id, provider_thread_id, native_request_id, request_event_id, request_event_seq,
              accepted_event_id, accepted_event_seq, first_action_event_id, first_action_event_seq,
              content_event_id, content_event_seq, content_receipt_digest, actual_profile_digest,
              native_receipt_digest, last_event_seq FROM execution_attempts WHERE execution_attempt_id = ?`,
    ).get(executionAttemptId)).toEqual(retained);
    expect(applyWithFixtureReceipt(db, { ...reconcile, idempotencyKey: "reconcile-exact-native-identity" }, null, null, adapter).outcome).toBe("OK");
    expect(adapter.reconcileCalls).toHaveLength(3);
    expect(db.prepare("SELECT state FROM execution_attempts WHERE execution_attempt_id = ?").get(executionAttemptId)).toEqual({ state: "content_delivered" });
  });

  it("releases capacity only for exact reconciled pre-effect refusal", async () => {
    const { db, fenceToken } = await assignmentFixture();
    const adapter = new DeterministicNativeAssignmentAdapter();
    const prepared = applyWithFixtureReceipt(db, assignmentPrepareRequest(fenceToken), null, null, adapter);
    const executionAttemptId = (prepared.evidence as { executionAttemptId: string }).executionAttemptId;
    adapter.nextEvidence = {
      disposition: "ambiguous",
      reasonCode: "request_outcome_unknown",
      acceptedEventId: undefined,
      acceptedEventSeq: undefined,
      firstActionEventId: undefined,
      firstActionEventSeq: undefined,
      contentEventId: undefined,
      contentEventSeq: undefined,
      contentDigest: undefined,
      actualProfile: undefined,
    };
    expect(applyWithFixtureReceipt(db, assignmentPhaseRequest(fenceToken, "assignment_dispatch", "assignment-1", executionAttemptId), null, null, adapter).outcome).toBe("DISPATCH_UNKNOWN");

    adapter.nextEvidence = {
      disposition: "refused",
      reasonCode: "definitive_pre_effect_refusal",
      acceptedEventId: undefined,
      acceptedEventSeq: undefined,
      firstActionEventId: undefined,
      firstActionEventSeq: undefined,
      contentEventId: undefined,
      contentEventSeq: undefined,
      contentDigest: undefined,
      actualProfile: undefined,
    };
    const refusal = applyWithFixtureReceipt(
      db,
      assignmentPhaseRequest(fenceToken, "assignment_reconcile", "assignment-1", executionAttemptId),
      null,
      null,
      adapter,
    );
    expect(refusal).toMatchObject({ outcome: "EXECUTION_PROFILE_UNKNOWN", evidence: { state: "failed" } });
    expect(applyWithFixtureReceipt(db, assignmentPrepareRequest(fenceToken, "assignment-after-refusal"), null, null, adapter).outcome).toBe("OK");
  });

  it("retains actual profile mismatch and refuses a hidden attach before send", async () => {
    const { db, fenceToken } = await assignmentFixture();
    const mismatchAdapter = new DeterministicNativeAssignmentAdapter();
    const prepared = applyWithFixtureReceipt(db, assignmentPrepareRequest(fenceToken), null, null, mismatchAdapter);
    const executionAttemptId = (prepared.evidence as { executionAttemptId: string }).executionAttemptId;
    mismatchAdapter.nextEvidence = { actualProfile: { ...ROLE_PROFILE, model: "fallback-model" } };
    const mismatch = applyWithFixtureReceipt(
      db,
      assignmentPhaseRequest(fenceToken, "assignment_dispatch", "assignment-1", executionAttemptId),
      null,
      null,
      mismatchAdapter,
    );
    expect(mismatch).toMatchObject({ outcome: "EXECUTION_PROFILE_MISMATCH", evidence: { state: "dispatch_unknown", actualProfileDigest: expect.any(String) } });
    expect((mismatch.evidence as { actualProfileDigest: string }).actualProfileDigest).not.toBe(ROLE_PROFILE_DIGEST);

    const second = await assignmentFixture();
    const attachAdapter = new DeterministicNativeAssignmentAdapter();
    attachAdapter.nextInspection = { threadVisibility: "hidden" };
    const attach = assignmentPrepareRequest(second.fenceToken, "attach-1", {
      assignment: {
        ...assignmentPrepareRequest(second.fenceToken).assignment!,
        assignmentId: "attach-1",
        branchName: "bb/attach-1",
        dispatchKind: "attach",
        attachThreadId: "thread-existing",
        environment: { ...assignmentPrepareRequest(second.fenceToken).assignment!.environment, environmentId: "environment-attach-1" },
      },
    });
    expect(applyWithFixtureReceipt(second.db, attach, null, null, attachAdapter).outcome).toBe("ROLE_CONTEXT_HIDDEN");
    expect(attachAdapter.dispatchCalls).toHaveLength(0);
    expect(second.db.prepare("SELECT COUNT(*) AS count FROM assignments").get()).toEqual({ count: 0 });

    const visible = applyWithFixtureReceipt(second.db, { ...attach, idempotencyKey: "prepare-attach-visible" }, null, null, attachAdapter);
    expect(visible.outcome).toBe("OK");
    const attachAttemptId = (visible.evidence as { executionAttemptId: string }).executionAttemptId;
    expect(applyWithFixtureReceipt(second.db, assignmentPhaseRequest(second.fenceToken, "assignment_dispatch", "attach-1", attachAttemptId), null, null, attachAdapter).outcome).toBe("OK");
    expect(attachAdapter.dispatchCalls[0]).toMatchObject({ dispatchKind: "attach", attachThreadId: "thread-existing" });
  });

  it("retains a late DONE report as blocked terminal evidence", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    try {
      const { db, fenceToken } = await assignmentFixture();
      const adapter = new DeterministicNativeAssignmentAdapter();
      const prepare = assignmentPrepareRequest(fenceToken, "late-1", {
        assignment: { ...assignmentPrepareRequest(fenceToken).assignment!, assignmentId: "late-1", branchName: "bb/late-1", deadlineAtMs: 200, environment: { ...assignmentPrepareRequest(fenceToken).assignment!.environment, environmentId: "environment-late-1" } },
      });
      const prepared = applyWithFixtureReceipt(db, prepare, null, null, adapter);
      const executionAttemptId = (prepared.evidence as { executionAttemptId: string }).executionAttemptId;
      const delivered = applyWithFixtureReceipt(db, assignmentPhaseRequest(fenceToken, "assignment_dispatch", "late-1", executionAttemptId), null, null, adapter);
      const native = delivered.evidence as { nativeReceiptDigest: string; actualProfileDigest: string; threadId: string };
      clock.mockReturnValue(300);
      const report = {
        receiptVersion: 1 as const,
        outcome: "DONE" as const,
        projectId: PROJECT_ID,
        assignmentId: "late-1",
        executionAttemptId,
        workItemId: WORK_ITEM_ID,
        roleId: "project-orchestrator" as const,
        roleGeneration: 1,
        repoTargetId: TARGET_ID,
        environmentId: "environment-late-1",
        threadId: native.threadId,
        branchName: "bb/late-1",
        baseSha: BASE_SHA,
        candidateSha: CANDIDATE_SHA,
        nativeReceiptDigest: native.nativeReceiptDigest,
        actualProfileDigest: native.actualProfileDigest,
        candidateObservationDigest: sha256(canonicalJson({ branchName: "bb/late-1", baseSha: BASE_SHA, candidateSha: CANDIDATE_SHA })),
        reasonCode: "writer_done",
        evidence: [{ kind: "test", digest: sha256("late"), ref: "fixture" }],
        reportedAtMs: 300,
        receiptEventId: "terminal-late",
        receiptEventSeq: 10,
        receivedAtMs: 300,
      };
      expect(applyWithFixtureReceipt(db, assignmentPhaseRequest(fenceToken, "assignment_terminal", "late-1", executionAttemptId, { terminalReport: report }), null, null, adapter)).toMatchObject({
        outcome: "OK",
        evidence: { state: "blocked", terminalResult: "BLOCKED", reportedOutcome: "DONE", reasonCode: "terminal_report_late" },
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("revalidates role generation before dispatch and terminal without failover", async () => {
    const { db, fenceToken } = await assignmentFixture();
    const adapter = new DeterministicNativeAssignmentAdapter();
    const prepared = applyWithFixtureReceipt(db, assignmentPrepareRequest(fenceToken), null, null, adapter);
    const executionAttemptId = (prepared.evidence as { executionAttemptId: string }).executionAttemptId;
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, { idempotencyKey: "qualification-successor", qualificationId: "qualification-successor" }), null, roleReader()).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, successionRequest(fenceToken, { idempotencyKey: "succession-successor", qualificationId: "qualification-successor", expectedGeneration: 1, predecessorGeneration: 1 }), null, roleReader()).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, assignmentPhaseRequest(fenceToken, "assignment_dispatch", "assignment-1", executionAttemptId), null, null, adapter).outcome).toBe("ROLE_GENERATION_STALE");
    expect(adapter.dispatchCalls).toHaveLength(0);
    expect(db.prepare("SELECT state FROM execution_attempts WHERE execution_attempt_id = ?").get(executionAttemptId)).toEqual({ state: "prepared" });
  });

  it("refuses stale or foreign assignment admission before any native side effect", async () => {
    const cases: Array<[string, Partial<ApplyRequest>, string]> = [
      ["stale-config", { expectedConfigRevision: 0 }, "PROJECT_CONFIG_STALE"],
      ["stale-governor", { expectedGovernanceEpoch: 9 }, "GOVERNOR_EPOCH_STALE"],
      ["stale-work-item", { expectedResourceRevision: 1 }, "WORK_ITEM_REVISION_STALE"],
      ["foreign-target", { repoTargetId: "foreign-target" }, "REPO_TARGET_FOREIGN"],
      ["stale-role", { assignment: { ...assignmentPrepareRequest("unused").assignment!, roleGeneration: 2 } }, "ROLE_HOLDER_MISMATCH"],
      ["profile", { assignment: { ...assignmentPrepareRequest("unused").assignment!, requestedProfile: { ...ROLE_PROFILE, permissionMode: "auto" } } }, "EXECUTION_PROFILE_MISMATCH"],
      ["candidate", { assignment: { ...assignmentPrepareRequest("unused").assignment!, candidateSemantics: "frozen", candidateSha: CANDIDATE_SHA } }, "ASSIGNMENT_HEAD_STALE"],
      ["environment", { assignment: { ...assignmentPrepareRequest("unused").assignment!, environment: { ...assignmentPrepareRequest("unused").assignment!.environment, path: "/foreign" } } }, "EXECUTION_CONTEXT_FOREIGN"],
    ];
    for (const [name, overrides, outcome] of cases) {
      const { db, fenceToken } = await assignmentFixture();
      const adapter = new DeterministicNativeAssignmentAdapter();
      const request = assignmentPrepareRequest(fenceToken, `negative-${name}`, {
        ...overrides,
        idempotencyKey: `negative-${name}`,
        assignment: overrides.assignment
          ? { ...overrides.assignment, assignmentId: `negative-${name}`, branchName: `bb/negative-${name}`, environment: { ...overrides.assignment.environment, environmentId: `environment-negative-${name}` } }
          : { ...assignmentPrepareRequest(fenceToken).assignment!, assignmentId: `negative-${name}`, branchName: `bb/negative-${name}`, environment: { ...assignmentPrepareRequest(fenceToken).assignment!.environment, environmentId: `environment-negative-${name}` } },
      });
      expect(applyWithFixtureReceipt(db, request, null, null, adapter).outcome, name).toBe(outcome);
      expect(adapter.dispatchCalls, name).toHaveLength(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM assignments").get(), name).toEqual({ count: 0 });
      expect(db.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = ?").get(request.idempotencyKey), name).toBeUndefined();
    }

    for (const [inspection, outcome] of [
      [{ baseSha: "c".repeat(40) }, "ASSIGNMENT_HEAD_STALE"],
      [{ branchName: "bb/foreign" }, "EXECUTION_CONTEXT_FOREIGN"],
      [{ candidateSha: CANDIDATE_SHA }, "ASSIGNMENT_HEAD_STALE"],
    ] as Array<[Partial<NativeAssignmentInspection>, FoundationResult["outcome"]]>) {
      const { db, fenceToken } = await assignmentFixture();
      const adapter = new DeterministicNativeAssignmentAdapter();
      adapter.nextInspection = inspection;
      expect(applyWithFixtureReceipt(db, assignmentPrepareRequest(fenceToken), null, null, adapter).outcome).toBe(outcome);
      expect(adapter.dispatchCalls).toHaveLength(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM assignments").get()).toEqual({ count: 0 });
    }
  });

  it("seals assignment preparation to resolved clean workspace ancestry and structural candidate scope", async () => {
    const mutationCounts = (db: Database.Database) => ({
      assignments: db.prepare("SELECT COUNT(*) AS count FROM assignments").get(),
      attempts: db.prepare("SELECT COUNT(*) AS count FROM execution_attempts WHERE origin = 'assignment'").get(),
      events: db.prepare("SELECT COUNT(*) AS count FROM state_events").get(),
      receipts: db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts").get(),
    });
    const writer = await assignmentFixture();
    const writerRequest = (name: string) => assignmentPrepareRequest(writer.fenceToken, `workspace-${name}`, {
      idempotencyKey: `workspace-${name}`,
      assignment: {
        ...assignmentPrepareRequest(writer.fenceToken).assignment!,
        assignmentId: `workspace-${name}`,
        branchName: `bb/workspace-${name}`,
        environment: {
          ...assignmentPrepareRequest(writer.fenceToken).assignment!.environment,
          environmentId: `environment-workspace-${name}`,
        },
      },
    });
    const requiredFacts: Array<keyof NativeAssignmentInspection> = [
      "bbServerId", "projectId", "environmentId", "sourceId", "hostId", "environmentPath",
      "environmentMode", "environmentStatus", "branchName", "headSha", "baseSha",
      "defaultBranchName", "defaultBranchHeadSha", "mergeBaseSha",
    ];
    const unresolvedFacts = requiredFacts.flatMap((field) => [
      [`${field}-null`, { [field]: null } as Partial<NativeAssignmentInspection>, "BB_FACTS_UNAVAILABLE" as const],
      [`${field}-missing`, { [field]: undefined } as Partial<NativeAssignmentInspection>, "BB_FACTS_UNAVAILABLE" as const],
    ] as Array<[string, Partial<NativeAssignmentInspection>, FoundationResult["outcome"]]>);
    const writerCases: Array<[string, Partial<NativeAssignmentInspection>, FoundationResult["outcome"]]> = [
      ...unresolvedFacts,
      ["provisioning", { environmentStatus: "provisioning" }, "BB_FACTS_UNAVAILABLE"],
      ["ambiguous", { environmentStatus: "ambiguous" }, "BB_FACTS_UNAVAILABLE"],
      ["unknown-working-tree", { workingTreeState: "unknown" }, "BB_FACTS_UNAVAILABLE"],
      ["unknown-inspection-key", { unknownFact: true } as Partial<NativeAssignmentInspection>, "BB_FACTS_UNAVAILABLE"],
      ["dirty", { workingTreeState: "dirty" }, "EXECUTION_CONTEXT_FOREIGN"],
      ["foreign-environment", { environmentId: "environment-foreign" }, "EXECUTION_CONTEXT_FOREIGN"],
      ["moved", { environmentPath: "/workspace/moved" }, "EXECUTION_CONTEXT_FOREIGN"],
      ["foreign-project", { projectId: FOREIGN_PROJECT_ID }, "EXECUTION_CONTEXT_FOREIGN"],
      ["foreign-source", { sourceId: "source-foreign" }, "EXECUTION_CONTEXT_FOREIGN"],
      ["foreign-host", { hostId: "host-foreign" }, "EXECUTION_CONTEXT_FOREIGN"],
      ["non-managed", { environmentMode: "local-path" }, "EXECUTION_CONTEXT_FOREIGN"],
      ["wrong-branch", { branchName: "bb/foreign" }, "EXECUTION_CONTEXT_FOREIGN"],
      ["stale-head", { headSha: CANDIDATE_SHA }, "ASSIGNMENT_HEAD_STALE"],
      ["writer-head-moved-but-ancestor", { headSha: CANDIDATE_SHA, mergeBaseSha: CANDIDATE_SHA, defaultBranchHeadSha: H1_CANDIDATE_SHA }, "ASSIGNMENT_HEAD_STALE"],
      ["writer-ahead", { defaultBranchHeadSha: CANDIDATE_SHA, mergeBaseSha: CANDIDATE_SHA }, "ASSIGNMENT_HEAD_STALE"],
      ["writer-diverged", { defaultBranchHeadSha: CANDIDATE_SHA, mergeBaseSha: H1_CANDIDATE_SHA }, "ASSIGNMENT_HEAD_STALE"],
    ];
    for (const [name, inspection, outcome] of writerCases) {
      const adapter = new DeterministicNativeAssignmentAdapter();
      adapter.nextInspection = inspection;
      const before = mutationCounts(writer.db);
      const request = writerRequest(name);
      expect(applyWithFixtureReceipt(writer.db, request, null, null, adapter).outcome, name).toBe(outcome);
      expect(adapter.dispatchCalls, name).toHaveLength(0);
      expect(mutationCounts(writer.db), name).toEqual(before);
    }

    const missingAdapterBefore = mutationCounts(writer.db);
    expect(applyWithFixtureReceipt(writer.db, writerRequest("missing-adapter")).outcome).toBe("BB_FACTS_UNAVAILABLE");
    expect(mutationCounts(writer.db)).toEqual(missingAdapterBefore);

    const throwingAdapter = new DeterministicNativeAssignmentAdapter();
    throwingAdapter.onInspect = () => { throw new Error("fixture inspection failure"); };
    const throwingAdapterBefore = mutationCounts(writer.db);
    expect(applyWithFixtureReceipt(writer.db, writerRequest("throwing-adapter"), null, null, throwingAdapter).outcome).toBe("BB_FACTS_UNAVAILABLE");
    expect(throwingAdapter.inspectCalls).toHaveLength(1);
    expect(throwingAdapter.dispatchCalls).toHaveLength(0);
    expect(mutationCounts(writer.db)).toEqual(throwingAdapterBefore);

    const defaultBranch = await assignmentFixture({ targetDefaultBranch: "develop" });
    const defaultBranchAdapter = new DeterministicNativeAssignmentAdapter();
    const defaultBranchBefore = mutationCounts(defaultBranch.db);
    expect(applyWithFixtureReceipt(
      defaultBranch.db,
      assignmentPrepareRequest(defaultBranch.fenceToken, "registered-default-branch"),
      null,
      null,
      defaultBranchAdapter,
    ).outcome).toBe("EXECUTION_CONTEXT_FOREIGN");
    expect(defaultBranchAdapter.dispatchCalls).toHaveLength(0);
    expect(mutationCounts(defaultBranch.db)).toEqual(defaultBranchBefore);

    const writerBehindAdapter = new DeterministicNativeAssignmentAdapter();
    writerBehindAdapter.nextInspection = { defaultBranchHeadSha: CANDIDATE_SHA };
    expect(applyWithFixtureReceipt(writer.db, assignmentPrepareRequest(writer.fenceToken, "writer-behind"), null, null, writerBehindAdapter).outcome).toBe("OK");

    const reviewer = await assignmentFixture();
    expect(applyWithFixtureReceipt(reviewer.db, transitionRequest(reviewer.fenceToken, "in_progress", 2)).outcome).toBe("OK");
    activateReviewer(reviewer.db, reviewer.fenceToken);
    const reviewRequest = assignmentPrepareRequest(reviewer.fenceToken, "review-candidate", {
      actorReceiptId: "role-actor-reviewer",
      expectedResourceRevision: 3,
      assignment: {
        ...assignmentPrepareRequest(reviewer.fenceToken).assignment!,
        assignmentId: "review-candidate",
        assignmentKind: "review",
        laneId: "review-candidate",
        roleRequirementId: "reviewer-v1",
        roleId: "independent-reviewer",
        roleGeneration: 2,
        branchName: "bb/review-candidate",
        candidateSemantics: "frozen",
        candidateSha: CANDIDATE_SHA,
        environment: {
          ...assignmentPrepareRequest(reviewer.fenceToken).assignment!.environment,
          environmentId: "environment-review-candidate",
        },
      },
    });
    const reviewAdapter = new DeterministicNativeAssignmentAdapter();
    const prepared = applyWithFixtureReceipt(reviewer.db, reviewRequest, null, null, reviewAdapter);
    expect(prepared.outcome).toBe("OK");
    const executionAttemptId = (prepared.evidence as { executionAttemptId: string }).executionAttemptId;
    expect(applyWithFixtureReceipt(reviewer.db, assignmentPhaseRequest(
      reviewer.fenceToken,
      "assignment_dispatch",
      "review-candidate",
      executionAttemptId,
      { actorReceiptId: "role-actor-reviewer", expectedResourceRevision: 3 },
    ), null, null, reviewAdapter).outcome).toBe("OK");
    expect(reviewAdapter.dispatchCalls[0]).toMatchObject({
      assignmentKind: "review",
      candidateSha: CANDIDATE_SHA,
      candidateScope: { mode: "read-only", candidateSemantics: "frozen", candidateSha: CANDIDATE_SHA, mutations: "forbidden" },
      requestedProfile: { permissionMode: "full", visibility: "visible" },
    });
    const probeRequest = {
      ...reviewRequest,
      idempotencyKey: "probe-candidate",
      assignment: {
        ...reviewRequest.assignment!,
        assignmentId: "probe-candidate",
        assignmentKind: "probe" as const,
        laneId: "probe-candidate",
        branchName: "bb/probe-candidate",
        environment: { ...reviewRequest.assignment!.environment, environmentId: "environment-probe-candidate" },
      },
    };
    const probeAdapter = new DeterministicNativeAssignmentAdapter();
    const probePrepared = applyWithFixtureReceipt(reviewer.db, probeRequest, null, null, probeAdapter);
    expect(probePrepared.outcome).toBe("OK");
    const probeAttemptId = (probePrepared.evidence as { executionAttemptId: string }).executionAttemptId;
    expect(applyWithFixtureReceipt(reviewer.db, assignmentPhaseRequest(
      reviewer.fenceToken,
      "assignment_dispatch",
      "probe-candidate",
      probeAttemptId,
      { actorReceiptId: "role-actor-reviewer", expectedResourceRevision: 3 },
    ), null, null, probeAdapter).outcome).toBe("OK");
    expect(probeAdapter.dispatchCalls[0]?.candidateScope).toEqual({
      mode: "read-only",
      candidateSemantics: "frozen",
      candidateSha: CANDIDATE_SHA,
      mutations: "forbidden",
    });

    for (const [name, inspection] of [
      ["candidate-head-mismatch", { headSha: H1_CANDIDATE_SHA }],
      ["candidate-non-descendant", { mergeBaseSha: H1_CANDIDATE_SHA }],
    ] as Array<[string, Partial<NativeAssignmentInspection>]>) {
      const fixture = await assignmentFixture();
      expect(applyWithFixtureReceipt(fixture.db, transitionRequest(fixture.fenceToken, "in_progress", 2)).outcome).toBe("OK");
      activateReviewer(fixture.db, fixture.fenceToken);
      const adapter = new DeterministicNativeAssignmentAdapter();
      adapter.nextInspection = inspection;
      const before = mutationCounts(fixture.db);
      const request = {
        ...reviewRequest,
        idempotencyKey: name,
        expectedFenceToken: fixture.fenceToken,
        assignment: {
          ...reviewRequest.assignment!,
          assignmentId: name,
          branchName: `bb/${name}`,
          environment: { ...reviewRequest.assignment!.environment, environmentId: `environment-${name}` },
        },
      };
      expect(applyWithFixtureReceipt(fixture.db, request, null, null, adapter).outcome, name).toBe("ASSIGNMENT_HEAD_STALE");
      expect(mutationCounts(fixture.db)).toEqual(before);
    }

    const relabeled = await assignmentFixture();
    expect(applyWithFixtureReceipt(relabeled.db, transitionRequest(relabeled.fenceToken, "in_progress", 2)).outcome).toBe("OK");
    const relabeledRequest = assignmentPrepareRequest(relabeled.fenceToken, "candidate-relabeled-write", {
      expectedResourceRevision: 3,
      assignment: {
        ...assignmentPrepareRequest(relabeled.fenceToken).assignment!,
        assignmentId: "candidate-relabeled-write",
        candidateSemantics: "frozen",
        candidateSha: CANDIDATE_SHA,
      },
    });
    const beforeRelabeled = mutationCounts(relabeled.db);
    expect(applyWithFixtureReceipt(relabeled.db, relabeledRequest, null, null, new DeterministicNativeAssignmentAdapter()).outcome).toBe("ASSIGNMENT_HEAD_STALE");
    expect(mutationCounts(relabeled.db)).toEqual(beforeRelabeled);
  });

  it("serializes writer lanes and the lower project ceiling while read-only assignments do not count", async () => {
    const { db: firstDb, path, directory } = directDatabase();
    const secondDb = new Database(path);
    let reopenedDb: Database.Database | null = null;
    databaseIsReady(secondDb);
    try {
      const { fenceToken } = seedAssignmentDatabase(firstDb, { writingLaneCeiling: 1, inProgress: true });
      const adapter = new DeterministicNativeAssignmentAdapter();
      const readOnly = assignmentPrepareRequest(fenceToken, "review-1", {
        expectedResourceRevision: 3,
        assignment: {
          ...assignmentPrepareRequest(fenceToken).assignment!,
          assignmentId: "review-1",
          assignmentKind: "review",
          laneId: "review-lane",
          branchName: "bb/review-1",
          candidateSemantics: "frozen",
          candidateSha: CANDIDATE_SHA,
          environment: { ...assignmentPrepareRequest(fenceToken).assignment!.environment, environmentId: "environment-review-1" },
        },
      });
      expect(applyWithFixtureReceipt(firstDb, readOnly, null, null, adapter).outcome).toBe("OK");
      const firstWrite = assignmentPrepareRequest(fenceToken, "writer-1", {
        expectedResourceRevision: 3,
        assignment: { ...assignmentPrepareRequest(fenceToken).assignment!, assignmentId: "writer-1", branchName: "bb/writer-1", environment: { ...assignmentPrepareRequest(fenceToken).assignment!.environment, environmentId: "environment-writer-1" } },
      });
      const preparedWrite = applyWithFixtureReceipt(firstDb, firstWrite, null, null, adapter);
      expect(preparedWrite.outcome).toBe("OK");
      const beforeLoserEvents = (firstDb.prepare("SELECT COUNT(*) AS count FROM state_events").get() as { count: number }).count;
      const loser = assignmentPrepareRequest(fenceToken, "writer-2", {
        idempotencyKey: "prepare-writer-2",
        expectedResourceRevision: 3,
        assignment: { ...assignmentPrepareRequest(fenceToken).assignment!, assignmentId: "writer-2", laneId: "lane-second", branchName: "bb/writer-2", environment: { ...assignmentPrepareRequest(fenceToken).assignment!.environment, environmentId: "environment-writer-2" } },
      });
      expect(applyWithFixtureReceipt(secondDb, loser, null, null, adapter).outcome).toBe("LANE_WRITER_EXISTS");
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM assignments").get()).toEqual({ count: 2 });
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM execution_attempts WHERE origin = 'assignment' AND assignment_kind = 'write'").get()).toEqual({ count: 1 });
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE idempotency_key = 'prepare-writer-2'").get()).toEqual({ count: 0 });
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM state_events").get()).toEqual({ count: beforeLoserEvents });

      const executionAttemptId = (preparedWrite.evidence as { executionAttemptId: string }).executionAttemptId;
      adapter.nextEvidence = { disposition: "ambiguous", reasonCode: "native_transport_ambiguous" };
      const dispatch = assignmentPhaseRequest(fenceToken, "assignment_dispatch", "writer-1", executionAttemptId);
      const ambiguous = applyWithFixtureReceipt(firstDb, dispatch, null, null, adapter);
      expect(ambiguous.outcome).toBe("DISPATCH_UNKNOWN");
      const beforeReopen = exportFoundation(firstDb, PROJECT_ID);

      secondDb.close();
      firstDb.close();
      reopenedDb = new Database(path);
      databaseIsReady(reopenedDb);
      const retryAdapter = new DeterministicNativeAssignmentAdapter();
      expect(applyWithFixtureReceipt(reopenedDb, dispatch, null, null, retryAdapter)).toEqual(ambiguous);
      expect(applyWithFixtureReceipt(reopenedDb, { ...dispatch, idempotencyKey: "dispatch-writer-1-new-key" }, null, null, retryAdapter).outcome).toBe("DISPATCH_UNKNOWN");
      expect(retryAdapter.dispatchCalls).toHaveLength(0);
      expect(exportFoundation(reopenedDb, PROJECT_ID)).toEqual(beforeReopen);
    } finally {
      reopenedDb?.close();
      if (secondDb.open) secondDb.close();
      if (firstDb.open) firstDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serializes interleaved two-connection admission at default and lower ceilings", () => {
    const cases = [
      { name: "default-distinct", ceiling: undefined, secondLane: "lane-second", bothWin: true },
      { name: "default-same-lane", ceiling: undefined, secondLane: "lane-first", bothWin: false },
      { name: "lower-distinct", ceiling: 1, secondLane: "lane-second", bothWin: false },
    ] as const;
    for (const admission of cases) {
      const { db: firstDb, path, directory } = directDatabase();
      const secondDb = new Database(path);
      databaseIsReady(secondDb);
      try {
        const { fenceToken } = seedAssignmentDatabase(firstDb, { writingLaneCeiling: admission.ceiling });
        const firstAdapter = new DeterministicNativeAssignmentAdapter();
        const secondAdapter = new DeterministicNativeAssignmentAdapter();
        const first = assignmentPrepareRequest(fenceToken, `${admission.name}-first`, {
          assignment: { ...assignmentPrepareRequest(fenceToken).assignment!, assignmentId: `${admission.name}-first`, laneId: "lane-first", branchName: `bb/${admission.name}-first`, environment: { ...assignmentPrepareRequest(fenceToken).assignment!.environment, environmentId: `environment-${admission.name}-first` } },
        });
        const second = assignmentPrepareRequest(fenceToken, `${admission.name}-second`, {
          assignment: { ...assignmentPrepareRequest(fenceToken).assignment!, assignmentId: `${admission.name}-second`, laneId: admission.secondLane, branchName: `bb/${admission.name}-second`, environment: { ...assignmentPrepareRequest(fenceToken).assignment!.environment, environmentId: `environment-${admission.name}-second` } },
        });
        const secondResults: FoundationResult[] = [];
        let eventsAfterSecond = 0;
        firstAdapter.onInspect = () => {
          secondResults.push(applyWithFixtureReceipt(secondDb, second, null, null, secondAdapter));
          eventsAfterSecond = (secondDb.prepare("SELECT COUNT(*) AS count FROM state_events").get() as { count: number }).count;
        };
        const firstResult = applyWithFixtureReceipt(firstDb, first, null, null, firstAdapter);

        if (admission.bothWin) {
          expect([firstResult.outcome, secondResults[0]?.outcome]).toEqual(["OK", "OK"]);
          const third = assignmentPrepareRequest(fenceToken, "ceiling-2-third", {
            assignment: { ...assignmentPrepareRequest(fenceToken).assignment!, assignmentId: "ceiling-2-third", laneId: "lane-third", branchName: "bb/ceiling-2-third", environment: { ...assignmentPrepareRequest(fenceToken).assignment!.environment, environmentId: "environment-ceiling-2-third" } },
          });
          expect(applyWithFixtureReceipt(firstDb, third, null, null, firstAdapter).outcome).toBe("LANE_WRITER_EXISTS");
          expect(firstDb.prepare("SELECT COUNT(*) AS count FROM execution_attempts WHERE origin = 'assignment' AND assignment_kind = 'write'").get()).toEqual({ count: 2 });
          expect(firstDb.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE idempotency_key = ?").get(third.idempotencyKey)).toEqual({ count: 0 });
        } else {
          expect(secondResults[0]?.outcome).toBe("OK");
          expect(firstResult.outcome).toBe("LANE_WRITER_EXISTS");
          expect(firstDb.prepare("SELECT COUNT(*) AS count FROM assignments").get()).toEqual({ count: 1 });
          expect(firstDb.prepare("SELECT COUNT(*) AS count FROM execution_attempts WHERE origin = 'assignment' AND assignment_kind = 'write'").get()).toEqual({ count: 1 });
          expect(firstDb.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE idempotency_key = ?").get(first.idempotencyKey)).toEqual({ count: 0 });
          expect((firstDb.prepare("SELECT COUNT(*) AS count FROM state_events").get() as { count: number }).count).toBe(eventsAfterSecond);
        }
      } finally {
        secondDb.close();
        firstDb.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("uses one read-only default and non-zero refusal exits for CLI input", async () => {
    const host = await loadedHost();
    const cli = await host.harness.runCli(["doctor", "--project", PROJECT_ID, "unexpected"]);
    expect(cli.exitCode).toBe(2);
    expect(JSON.parse(cli.stdout).outcome).toBe("INVALID_INPUT");
    const missingProject = await host.harness.runCli(["doctor"]);
    expect(missingProject.exitCode).toBe(2);
    expect(JSON.parse(missingProject.stdout).outcome).toBe("INVALID_INPUT");
  });

  it("keeps fixture insertion outside the production RPC/CLI surface", async () => {
    const host = await loadedHost();
    const registrations = host.harness.inspection.registrations;
    expect(registrations.rpcMethods).not.toContain("seed-fixture-receipt");
    expect(registrations.cli?.commands.map((command) => command.name)).toEqual(["doctor", "export", "apply"]);
    expect(registrations.httpRoutes.map((route) => route.path)).toEqual(["/lanes"]);
    expect(seedFixtureDecision).toBeTypeOf("function");
  });
});
