import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineRpcContract } from "@bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import plugin, { rpcContract } from "../server.js";
import {
  DEFERRED_ISSUE_3_OUTCOMES,
  AUTHORIZED_APPROVER_ID,
  CACHED_CONSUMERS,
  CONTRACT_VERSION,
  DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
  DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION,
  DERIVED_ACTOR_MUTATION_CLASSES,
  EVIDENCE_ONLY_EQUIVALENCE_DISPOSITION,
  LLM_COLLAB_EVIDENCE_RESOURCE_REVISION,
  LLM_COLLAB_MERGED_MAIN_SHA,
  LLM_COLLAB_SOURCE_FENCE,
  MAX_EXPORT_ROWS,
  MAX_EXPORT_BYTES,
  MAX_SOURCE_EVIDENCE_MANIFEST_BYTES,
  MIGRATIONS,
  MIGRATION_STATES,
  MIGRATION_STEPS,
  PREVIOUS_V11_DERIVED_ACTOR_MUTATION_CLASSES,
  PLUGIN_ID,
  SCHEMA_VERSION,
  TABLES,
  assembleV20CachedConsumerRolloutEvidence,
  applyFixtureMutation,
  applyAuthorizedMutation,
  cachedConsumerRolloutEvidence,
  canonicalJson,
  contractDigest,
  databaseIsReady,
  doctor,
  explicitExecutionInputSources,
  exportFoundation,
  operatorReceiptBindingDigest,
  operatorReceiptDigest,
  persistBootstrapOperatorReceipt,
  persistInterimOperatorReceipt,
  operatorAuthorizationDigestProjection,
  operatorRequestDigest,
  probeV20NewLegacyApplyProvenanceRefusal,
  probeV20ConsumedLegacyReplay,
  schemaDigest,
  sha256,
  type ApplyRequest,
  type ExportPayload,
  type FoundationResult,
  type NativeAssignmentInspection,
  type OperatorReceipt,
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
const DIRECTOR_PROFILE = {
  providerId: "pi",
  model: "kimi-coding/k3",
  reasoningLevel: "high",
  permissionMode: "full",
  serviceTier: "default",
  visibility: "visible" as const,
};
const DIRECTOR_STANDBY_PROFILE = {
  providerId: "claude-code",
  model: "claude-opus-5[1m]",
  reasoningLevel: "medium",
  permissionMode: "full",
  serviceTier: "default",
  visibility: "visible" as const,
};
const DIRECTOR_PROFILE_DIGEST = sha256(canonicalJson(DIRECTOR_PROFILE));
const STANDBY_PROFILE = {
  providerId: "luna",
  model: "gpt-5.6-luna",
  reasoningLevel: "high",
  permissionMode: "full",
  serviceTier: "default",
  visibility: "visible" as const,
};
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
    { roleRequirementId: "worker-v1", roleId: "worker", repoTargetId: TARGET_ID, executedProfile: ROLE_PROFILE },
    { roleRequirementId: "reviewer-v1", roleId: "independent-reviewer", repoTargetId: TARGET_ID, executedProfile: ROLE_PROFILE },
  ];
  config.extensions.bbCollab.reviewPolicy = {
    connectors: [{ repoTargetId: TARGET_ID, connectorId: "connector-review", policy: connector }],
  };
  return config;
}

function directorSeatConfig() {
  const config = roleConfig();
  const requirements = config.extensions.bbCollab.roleRequirements as Array<Record<string, unknown>>;
  requirements[0] = {
    roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
    roleId: "director",
    repoTargetId: null,
    executedProfile: DIRECTOR_PROFILE,
    standbyProfile: DIRECTOR_STANDBY_PROFILE,
    writingLaneCapacity: 0,
    firstGenerationExemption: DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION,
  };
  return config;
}

function cachedConsumerObservations(observedSchemaVersion: number, observedContractVersion: number) {
  return CACHED_CONSUMERS.map((name) => ({ name, observedSchemaVersion, observedContractVersion }));
}

function policyProbeReread(name: (typeof CACHED_CONSUMERS)[number], result: Pick<FoundationResult, "outcome">, expectedOutcome: FoundationResult["outcome"]) {
  if (result.outcome !== expectedOutcome) throw new Error(`${name} policy probe did not return ${expectedOutcome}`);
  const reread = cachedConsumerRolloutEvidence(cachedConsumerObservations(SCHEMA_VERSION, CONTRACT_VERSION));
  if (reread.action !== "reread") throw new Error(`${name} did not reread v20`);
  const observation = reread.observations.find((candidate) => candidate.name === name);
  if (!observation) throw new Error(`${name} reread observation is unavailable`);
  return { observedSchemaVersion: observation.observedSchemaVersion, observedContractVersion: observation.observedContractVersion };
}

function receiptProvenanceDigest(receipt: OperatorReceipt, issuanceProvenance: OperatorReceipt["issuanceProvenance"] | null) {
  const { receiptDigest: _receiptDigest, ...identity } = receipt;
  return operatorReceiptDigest({ ...identity, issuanceProvenance });
}

function doctorV20Reread(name: "server.rpcContract" | "server.collabCli", result: FoundationResult) {
  const cachedConsumers = (result.evidence as { cachedConsumers?: { newSchemaVersion?: unknown; newContractVersion?: unknown } } | undefined)?.cachedConsumers;
  if (result.outcome !== "OK" || typeof cachedConsumers?.newSchemaVersion !== "number" || typeof cachedConsumers.newContractVersion !== "number") {
    throw new Error(`${name} did not return cached-consumer evidence`);
  }
  return { observedSchemaVersion: cachedConsumers.newSchemaVersion, observedContractVersion: cachedConsumers.newContractVersion };
}

function directorRoleReader(
  mutate?: (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => void,
) {
  return roleReader((facts) => {
    facts.thread.providerId = DIRECTOR_PROFILE.providerId;
    facts.events[0]!.data.execution = {
      ...facts.events[0]!.data.execution as Record<string, unknown>,
      model: DIRECTOR_PROFILE.model,
      reasoningLevel: DIRECTOR_PROFILE.reasoningLevel,
      permissionMode: DIRECTOR_PROFILE.permissionMode,
      serviceTier: DIRECTOR_PROFILE.serviceTier,
    };
    mutate?.(facts);
  });
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
      title: "Managed role holder",
      titleFallback: "",
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
    roleId: overrides.roleRequirementId === DIRECTOR_SEAT_ROLE_REQUIREMENT_ID ? "director" : "project-orchestrator",
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
    roleId: overrides.roleRequirementId === DIRECTOR_SEAT_ROLE_REQUIREMENT_ID ? "director" : "project-orchestrator",
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
    standbyProfile: overrides.standbyProfile ?? (overrides.roleRequirementId === DIRECTOR_SEAT_ROLE_REQUIREMENT_ID ? DIRECTOR_STANDBY_PROFILE : undefined),
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

function hostFor(
  projectId = PROJECT_ID,
  mutateRoleFacts?: (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => void,
) {
  const project = projectFacts(projectId);
  const roleFacts = roleReader(mutateRoleFacts);
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
      threads: {
        get: async () => ({
          id: roleFacts.facts.thread.id,
          projectId: roleFacts.facts.thread.projectId,
          environmentId: roleFacts.facts.thread.environmentId,
          providerId: roleFacts.facts.thread.providerId,
          title: roleFacts.facts.thread.title,
          titleFallback: roleFacts.facts.thread.titleFallback,
          sectionId: null,
          status: roleFacts.facts.thread.status as "idle",
          parentThreadId: null,
          sourceThreadId: null,
          originKind: null,
          childOrigin: null,
          originPluginId: null,
          visibility: roleFacts.facts.thread.visibility,
          archivedAt: null,
          pinnedAt: null,
          deletedAt: null,
          lastReadAt: null,
          latestAttentionAt: 1,
          createdAt: 1,
          updatedAt: 1,
          runtime: { displayStatus: "idle" as const, hostReconnectGraceExpiresAt: null },
          activeBackgroundAgentCount: 0,
          canSpawnChild: true,
        }),
        events: {
          list: async () => roleFacts.facts.events.map((event) => ({
            id: event.id,
            threadId: roleFacts.facts.thread.id,
            seq: event.seq,
            type: event.type,
            scope: { kind: "thread" as const },
            data: event.data,
            createdAt: event.seq,
          })),
        },
      },
      environments: {
        get: async () => ({
          id: roleFacts.facts.environment.id,
          name: null,
          projectId: roleFacts.facts.environment.projectId,
          hostId: roleFacts.facts.environment.hostId,
          path: roleFacts.facts.environment.path,
          managed: roleFacts.facts.environment.managed,
          isGitRepo: roleFacts.facts.environment.isGitRepo,
          isWorktree: roleFacts.facts.environment.isWorktree,
          workspaceProvisionType: roleFacts.facts.environment.workspaceProvisionType as "managed-worktree",
          branchName: roleFacts.facts.environment.branchName,
          baseBranch: roleFacts.facts.environment.baseBranch,
          defaultBranch: roleFacts.facts.environment.defaultBranch,
          mergeBaseBranch: roleFacts.facts.environment.mergeBaseBranch,
          status: roleFacts.facts.environment.status as "ready",
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

async function loadedHost(
  projectId = PROJECT_ID,
  mutateRoleFacts?: (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => void,
) {
  const host = hostFor(projectId, mutateRoleFacts);
  await plugin(host.bb);
  return host;
}

async function loadedDistHost() {
  const host = hostFor();
  host.harness.sdk.stub("plugins.callRpc", ((input: { method: string; input?: unknown }) =>
    host.harness.callRpc(input.method, input.input)) as never);
  // @ts-expect-error tracked runtime artifact is JavaScript-only by convention.
  const { default: distPlugin } = await import("../dist/server.js");
  await distPlugin(host.bb);
  return host;
}

async function loadedLaneWatcherHost() {
  const host = hostFor();
  let changed: ((event: { entity: string; id: string }) => void) | null = null;
  host.harness.sdk.stub("subscribe", ((input: { callback: (event: { entity: string; id: string }) => void }) => {
    changed = input.callback;
    return () => undefined;
  }) as never);
  await plugin(host.bb);

  const db = host.bb.storage.database();
  const { fenceToken } = seedAssignmentDatabase(db);
  const adapter = new DeterministicNativeAssignmentAdapter();
  const prepared = applyWithFixtureReceipt(db, assignmentPrepareRequest(fenceToken), null, null, adapter);
  expect(prepared.outcome).toBe("OK");
  const executionAttemptId = (prepared.evidence as { executionAttemptId: string }).executionAttemptId;
  db.prepare("UPDATE execution_attempts SET thread_id = ?, state = 'running' WHERE execution_attempt_id = ?").run("worker-1", executionAttemptId);

  let thread = makeThreadResponse({ id: "worker-1", status: "idle", archivedAt: null, deletedAt: null });
  let roleThread = makeThreadResponse({ id: ROLE_THREAD_ID, projectId: PROJECT_ID, status: "idle", archivedAt: null, deletedAt: null });
  let roleReads = 0;
  let failRoleReadAt: number | null = null;
  let changeRoleReadAt: number | null = null;
  let changedRoleThread: Partial<typeof roleThread> = {};
  let roleHolderReads = 0;
  let mutateRoleHolderReadAt: number | null = null;
  let mutateRoleHolderRead: (() => void) | null = null;
  let armRoleHolderMutationAtRoleRead: number | null = null;
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((source: string) => {
    if (source.includes("FROM execution_attempts AS attempts")) {
      roleHolderReads += 1;
      if (roleHolderReads === mutateRoleHolderReadAt) mutateRoleHolderRead?.();
    }
    return prepare(source);
  }) as never);
  let pendingExternalWait = false;
  host.harness.sdk.stub("threads.get", (async ({ threadId }: { threadId: string }) => {
    if (threadId !== ROLE_THREAD_ID) return thread;
    roleReads += 1;
    if (roleReads === failRoleReadAt) throw new Error("role thread unavailable");
    if (roleReads === changeRoleReadAt) roleThread = makeThreadResponse({ ...roleThread, ...changedRoleThread });
    if (roleReads === armRoleHolderMutationAtRoleRead) mutateRoleHolderReadAt = roleHolderReads + 2;
    return roleThread;
  }) as never);
  host.harness.sdk.stub("threads.interactions.list", (async () => pendingExternalWait ? [{ status: "pending" }] : []) as never);
  host.harness.sdk.stub("threads.send", (async () => ({ ok: true })) as never);
  return {
    host,
    changed: changed!,
    setPending(next: boolean) {
      pendingExternalWait = next;
    },
    setThread(next: Partial<typeof thread>) {
      thread = makeThreadResponse({ ...thread, ...next });
    },
    setRoleThread(next: Partial<typeof roleThread>) {
      roleThread = makeThreadResponse({ ...roleThread, ...next });
    },
    setLaneState(state: string) {
      db.prepare("UPDATE execution_attempts SET state = ? WHERE execution_attempt_id = ?").run(state, executionAttemptId);
    },
    failRoleReadAfter(successfulReads: number) {
      failRoleReadAt = roleReads + successfulReads + 1;
    },
    changeRoleThreadAfter(successfulReads: number, next: Partial<typeof roleThread>) {
      changeRoleReadAt = roleReads + successfulReads + 1;
      changedRoleThread = next;
    },
    mutateFinalRoleHolderReadAfter(successfulReads: number, mutate: () => void) {
      armRoleHolderMutationAtRoleRead = roleReads + successfulReads + 1;
      mutateRoleHolderRead = mutate;
    },
    db,
  };
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

function sourceEvidenceManifest(files = [
  { path: "README.md", digest: sha256("README.md") },
  { path: "docs/archive.md", digest: sha256("docs/archive.md") },
]) {
  const manifest = {
    sourceSystem: "llm-collab" as const,
    sourceFence: LLM_COLLAB_SOURCE_FENCE,
    resourceRevision: LLM_COLLAB_EVIDENCE_RESOURCE_REVISION,
    mergedMainSha: LLM_COLLAB_MERGED_MAIN_SHA,
    canonical: false as const,
    files,
  };
  return { ...manifest, manifestDigest: sha256(canonicalJson(manifest)) };
}

function maximalSourceEvidenceManifest() {
  const files = Array.from({ length: MAX_EXPORT_ROWS }, (_, index) => {
    const path = `${String(index).padStart(3, "0")}-${"x".repeat(240)}`;
    return { path, digest: sha256(path) };
  });
  return sourceEvidenceManifest(files);
}

function nonMigrationRows(db: Database.Database) {
  return Object.fromEntries(TABLES.filter((table) => !["migration_runs", "mutation_receipts", "state_events"].includes(table)).map((table) => [
    table,
    table === "decision_dispositions"
      ? db.prepare("SELECT decision_dispositions.* FROM decision_dispositions JOIN decisions ON decisions.decision_id = decision_dispositions.decision_id WHERE decisions.project_id = ? ORDER BY decision_id, disposition_sequence").all(PROJECT_ID)
      : db.prepare(`SELECT * FROM ${table} WHERE project_id = ? ORDER BY rowid`).all(PROJECT_ID),
  ]));
}

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

function seedEvidenceArtifact(db: Database.Database, evidenceId: string, payloadBytes = 0, durableRef?: Record<string, unknown>) {
  const redactedJson = canonicalJson({ evidenceId, redacted: true });
  const durableRefJson = canonicalJson(durableRef ?? { kind: "fixture", ref: evidenceId, fixtureContent: "x".repeat(payloadBytes) });
  const artifact = {
    projectId: PROJECT_ID,
    evidenceId,
    evidenceKind: "test",
    sourceKind: "test",
    sourceRef: `fixture:${evidenceId}`,
    executionAttemptId: null,
    contentDigest: sha256(durableRefJson),
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
  directorSeat?: boolean;
} = {}) {
  const host = await loadedHost();
  const directorSeat = options.directorSeat === true;
  const config = directorSeat ? directorSeatConfig() : roleConfig(options.connectorPolicy);
  if (options.writingLaneCeiling !== undefined) {
    (config.extensions.bbCollab as Record<string, unknown>).writingLaneCeiling = options.writingLaneCeiling;
  }
  const targets = options.targetDefaultBranch
    ? bootstrapRequest().targets!.map((target) => ({ ...target, defaultBranch: options.targetDefaultBranch! }))
    : undefined;
  const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config, ...(targets ? { targets } : {}) });
  expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
  expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "ready", 1)).outcome).toBe("OK");
  const roleFacts = directorSeat ? directorRoleReader() : roleReader();
  expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, directorSeat ? {
    roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
    qualificationId: "director-assignment-qualification",
    declaredProfile: DIRECTOR_PROFILE,
  } : {}), null, roleFacts).outcome).toBe("OK");
  const succession = applyWithFixtureReceipt(db, successionRequest(fenceToken, directorSeat ? {
    roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
    qualificationId: "director-assignment-qualification",
    profileDigest: DIRECTOR_PROFILE_DIGEST,
    standbyProfile: DIRECTOR_STANDBY_PROFILE,
  } : {}), null, directorSeat ? directorRoleReader() : roleReader());
  expect(succession.outcome).toBe("OK");
  const holderExecutionAttemptId = (succession.evidence as { holderExecutionAttemptId: string }).holderExecutionAttemptId;
  seedVerifiedFixtureReceipt(db, {
    projectId: PROJECT_ID,
    receiptId: "role-actor-assignment",
    actorKind: "role",
    subjectId: holderExecutionAttemptId,
    roleId: directorSeat ? "director" : "project-orchestrator",
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
  it("does not steer a thread:changed idle worker with a pending interaction", async () => {
    const fixture = await loadedLaneWatcherHost();
    fixture.setPending(true);

    fixture.changed({ entity: "thread", id: "worker-1" });
    await vi.waitFor(() => expect(fixture.host.harness.inspection.sdk.callsTo("threads.interactions.list")).toHaveLength(1));

    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    await fixture.host.harness.lifecycle.dispose();
  });

  it("keeps deleted workers silent on realtime changes and background polls", async () => {
    const fixture = await loadedLaneWatcherHost();
    fixture.setThread({ deletedAt: Date.now() });

    fixture.changed({ entity: "thread", id: "worker-1" });
    await vi.waitFor(() => expect(fixture.host.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1));
    expect(fixture.host.harness.inspection.sdk.callsTo("threads.interactions.list")).toHaveLength(0);

    const service = fixture.host.harness.behavior.runService("lane-watcher");
    await vi.waitFor(() => expect(fixture.host.harness.inspection.sdk.callsTo("threads.get").length).toBeGreaterThanOrEqual(2));
    service.controller.abort();
    await service.done;

    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    await fixture.host.harness.lifecycle.dispose();
  });

  it("sends once per idle anomaly until a real active resolution", async () => {
    const fixture = await loadedLaneWatcherHost();

    fixture.changed({ entity: "thread", id: "worker-1" });
    fixture.changed({ entity: "thread", id: "worker-1" });
    await vi.waitFor(() => expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1));

    fixture.setThread({ status: "active" });
    fixture.changed({ entity: "thread", id: "worker-1" });
    fixture.setThread({ status: "idle" });
    fixture.changed({ entity: "thread", id: "worker-1" });
    await vi.waitFor(() => expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(2));

    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({
      threadId: "worker-1",
      mode: "steer",
      input: [{ type: "text", visibility: "agent-only" }],
    });

    await fixture.host.harness.lifecycle.dispose();
  });

  it("warns with role-seat evidence on an unreadable final liveness check and stays silent for a healthy holder", async () => {
    let currentNow = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => currentNow);
    const warning = (fixture: Awaited<ReturnType<typeof loadedLaneWatcherHost>>) => fixture.host.harness.inspection.logEntries
      .filter((entry) => entry.level === "warn" && entry.message.startsWith("role steer refused:"));
    const roleSends = (fixture: Awaited<ReturnType<typeof loadedLaneWatcherHost>>) => fixture.host.harness.inspection.sdk.callsTo("threads.send")
      .filter(([input]) => (input as { threadId?: string }).threadId === ROLE_THREAD_ID);
    try {
      const healthy = await loadedLaneWatcherHost();
      healthy.setLaneState("prepared");
      await healthy.host.harness.runCli(["wait-validator", "--cycle"]);
      currentNow = 10 * 60_000;
      await healthy.host.harness.runCli(["wait-validator", "--cycle"]);
      expect(roleSends(healthy)).toHaveLength(1);
      expect(warning(healthy)).toHaveLength(0);
      await healthy.host.harness.lifecycle.dispose();

      currentNow = 0;
      const unreadable = await loadedLaneWatcherHost();
      unreadable.setLaneState("prepared");
      await unreadable.host.harness.runCli(["wait-validator", "--cycle"]);
      unreadable.failRoleReadAfter(1);
      currentNow = 10 * 60_000;
      await unreadable.host.harness.runCli(["wait-validator", "--cycle"]);
      expect(roleSends(unreadable)).toHaveLength(0);
      expect(warning(unreadable)).toEqual([expect.objectContaining({
        message: expect.stringContaining(`project=${PROJECT_ID} role=project-orchestrator@1 holder=`),
      })]);
      expect(warning(unreadable)[0]?.message).toContain(`thread=${ROLE_THREAD_ID} liveness=unknown error=Error: role thread unavailable`);
      await unreadable.host.harness.lifecycle.dispose();
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    ["archived", { archivedAt: 1 }, "archivedAt=1 deletedAt=null"],
    ["deleted", { deletedAt: 1 }, "archivedAt=null deletedAt=1"],
    ["foreign-project", { projectId: "other-project" }, "observedProject=other-project"],
    ["error status", { status: "error" as const }, "status=error"],
    ["title witness", { title: "handoff witness" }, "witness=true"],
    ["fallback witness", { titleFallback: "witness only" }, "witness=true"],
  ])("warns once when the current role holder is %s during periodic evaluation", async (_name, roleThread, evidence) => {
    const fixture = await loadedLaneWatcherHost();
    fixture.setLaneState("prepared");
    fixture.setRoleThread(roleThread);

    await fixture.host.harness.runCli(["wait-validator", "--cycle"]);
    await fixture.host.harness.runCli(["wait-validator", "--cycle"]);
    await fixture.host.harness.runCli(["wait-validator", "--cycle"]);

    const warnings = fixture.host.harness.inspection.logEntries
      .filter((entry) => entry.level === "warn" && entry.message.startsWith("role steer refused:"));
    expect(warnings).toEqual([expect.objectContaining({
      message: expect.stringContaining(`project=${PROJECT_ID} role=project-orchestrator@1 holder=`),
    })]);
    expect(warnings[0]?.message).toContain(`thread=${ROLE_THREAD_ID}`);
    expect(warnings[0]?.message).toContain(evidence);
    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")
      .filter(([input]) => (input as { threadId?: string }).threadId === ROLE_THREAD_ID)).toHaveLength(0);
    await fixture.host.harness.lifecycle.dispose();
  });

  it.each([
    ["active", { status: "active" as const }, "status=active"],
    ["foreign-project", { projectId: "other-project" }, "observedProject=other-project"],
    ["archived", { archivedAt: 1 }, "archivedAt=1"],
    ["deleted", { deletedAt: 1 }, "deletedAt=1"],
    ["title witness", { title: "handoff witness" }, "witness=true"],
    ["fallback witness", { titleFallback: "witness only" }, "witness=true"],
  ])("revalidates final role-holder %s eligibility before steering", async (_name, roleThread, evidence) => {
    let currentNow = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => currentNow);
    try {
      const fixture = await loadedLaneWatcherHost();
      fixture.setLaneState("prepared");
      await fixture.host.harness.runCli(["wait-validator", "--cycle"]);
      fixture.changeRoleThreadAfter(1, roleThread);
      currentNow = 10 * 60_000;
      await fixture.host.harness.runCli(["wait-validator", "--cycle"]);

      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")
        .filter(([input]) => (input as { threadId?: string }).threadId === ROLE_THREAD_ID)).toHaveLength(0);
      const warnings = fixture.host.harness.inspection.logEntries
        .filter((entry) => entry.level === "warn" && entry.message.startsWith("role steer refused:"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain(evidence);
      expect(await fixture.host.bb.storage.kv.get("lane-watcher.role-idle")).toEqual({});

      fixture.setRoleThread({
        projectId: PROJECT_ID,
        status: "idle",
        archivedAt: null,
        deletedAt: null,
        title: "Managed role holder",
        titleFallback: "",
      });
      await fixture.host.harness.runCli(["wait-validator", "--cycle"]);
      currentNow = 20 * 60_000;
      await fixture.host.harness.runCli(["wait-validator", "--cycle"]);
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")
        .filter(([input]) => (input as { threadId?: string }).threadId === ROLE_THREAD_ID)).toHaveLength(1);
      expect(fixture.host.harness.inspection.logEntries
        .filter((entry) => entry.level === "warn" && entry.message.startsWith("role succession required:"))).toHaveLength(0);
      await fixture.host.harness.lifecycle.dispose();
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    ["missing", (fixture: Awaited<ReturnType<typeof loadedLaneWatcherHost>>) => fixture.db.prepare("DELETE FROM role_generation_heads").run(), "holderMatches=0"],
    ["unreadable", (fixture: Awaited<ReturnType<typeof loadedLaneWatcherHost>>) => fixture.db.exec("DROP TABLE role_generation_heads"), "holder=unknown error="],
  ])("warns and records no steer when the final canonical holder is %s", async (_name, mutate, evidence) => {
    let currentNow = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => currentNow);
    try {
      const fixture = await loadedLaneWatcherHost();
      fixture.setLaneState("prepared");
      await fixture.host.harness.runCli(["wait-validator", "--cycle"]);
      fixture.mutateFinalRoleHolderReadAfter(0, () => mutate(fixture));
      currentNow = 10 * 60_000;
      await fixture.host.harness.runCli(["wait-validator", "--cycle"]);

      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")
        .filter(([input]) => (input as { threadId?: string }).threadId === ROLE_THREAD_ID)).toHaveLength(0);
      const warnings = fixture.host.harness.inspection.logEntries
        .filter((entry) => entry.level === "warn" && entry.message.startsWith("role steer refused:"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain(evidence);
      expect(await fixture.host.bb.storage.kv.get("lane-watcher.role-idle")).toEqual({});
      await fixture.host.harness.lifecycle.dispose();
    } finally {
      now.mockRestore();
    }
  });

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
    expect(host.harness.inspection.registrations.schedules.map((schedule) => schedule.name)).toEqual(["wait-validator-liveness", "thread-archive-sweep"]);
    expect(host.harness.inspection.registrations.rpcMethods.sort()).toEqual(["apply", "approverAttestation", "cachedConsumerRollout", "doctor", "export", "lanes", "operatorPassphraseState", "operatorReceipt", "operatorReceiptDecision", "operatorReceiptRequests", "registerWait", "reorderPinned", "setSidebarCollapse", "setThreadState", "sidebarCollapseState", "threadModels", "threadStates"]);
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
      issuanceProvenance: "console",
    }, 1);
    const authorized = { ...request, operatorReceiptId: receipt.receiptId };

    const rpc = await host.harness.callRpc("apply", authorized);
    expect(rpc).toMatchObject({ outcome: "OK", mutationReceipt: { operationClass: "bootstrap", operatorReceiptId: receipt.receiptId } });
    expect(db.prepare("SELECT operator_receipt_id FROM state_events WHERE project_id = ?").get(PROJECT_ID)).toEqual({ operator_receipt_id: receipt.receiptId });
    expect(db.prepare("SELECT operator_receipt_id FROM mutation_receipts WHERE project_id = ? AND idempotency_key = ?").get(PROJECT_ID, request.idempotencyKey)).toEqual({ operator_receipt_id: receipt.receiptId });
    expect(db.prepare("SELECT consumed_event_sequence FROM operator_receipts WHERE receipt_id = ?").get(receipt.receiptId)).toEqual({ consumed_event_sequence: 1 });
    const cli = await host.harness.runCli(["apply", "--project", PROJECT_ID, "--request", JSON.stringify(authorized)]);
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual(rpc);
    expect(db.prepare("SELECT COUNT(*) AS count FROM state_events WHERE project_id = ?").get(PROJECT_ID)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE project_id = ?").get(PROJECT_ID)).toEqual({ count: 1 });
    const fresh = persistInterimOperatorReceipt(db, {
      projectId: PROJECT_ID,
      mutationClass: request.operationClass,
      candidateHead: CANDIDATE_SHA,
      idempotencyKey: request.idempotencyKey,
      requestDigest: operatorRequestDigest(request),
      callerThreadId: "operator-thread-fresh",
      requestedFromBackground: false,
      callerPluginId: PLUGIN_ID,
      issuanceProvenance: "console",
    }, 2);
    const beforeFreshApply = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", { ...authorized, operatorReceiptId: fresh.receiptId })).toMatchObject({ outcome: "OPERATOR_RECEIPT_STALE" });
    expect(db.prepare("SELECT consumed_at_ms FROM operator_receipts WHERE receipt_id = ?").get(fresh.receiptId)).toEqual({ consumed_at_ms: null });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeFreshApply);
    const beforeReuse = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", { ...request, idempotencyKey: "bootstrap-distinct", operatorReceiptId: receipt.receiptId })).toMatchObject({ outcome: "OPERATOR_RECEIPT_REUSED" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeReuse);
  });

  it("derives the plugin actor atomically after bootstrap confirmation and applies with that actor", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    const request = { ...bootstrapRequest(), actorReceiptId: null, candidateHead: CANDIDATE_SHA };
    const operatorInput = {
      projectId: PROJECT_ID,
      mutationClass: "bootstrap" as const,
      candidateHead: CANDIDATE_SHA,
      idempotencyKey: request.idempotencyKey,
      requestDigest: operatorRequestDigest(request),
      callerThreadId: "operator-thread",
      requestedFromBackground: false,
    };
    const pendingResult = host.harness.callRpc("operatorReceipt", operatorInput);
    await vi.waitFor(() => expect(host.harness.inspection.pendingInteractions).toHaveLength(1));
    const interaction = host.harness.inspection.pendingInteractions[0];
    host.harness.behavior.submitInteraction(interaction.id, {
      confirmed: true,
      projectId: PROJECT_ID,
      mutationClass: "bootstrap",
      candidateHead: CANDIDATE_SHA,
      idempotencyKey: request.idempotencyKey,
      requestDigest: operatorInput.requestDigest,
    });
    const issued = await pendingResult;
    expect(issued).toMatchObject({ outcome: "OK", actorReceiptId: expect.any(String) });
    const actorReceiptId = (issued as FoundationResult).actorReceiptId!;
    const operatorReceiptId = (issued as FoundationResult).operatorReceipt!.receiptId;
    expect(db.prepare("SELECT actor_kind, subject_id, verification_state, operator_receipt_id, retirement_condition FROM actor_receipts WHERE receipt_id = ?").get(actorReceiptId)).toEqual({
      actor_kind: "plugin",
      subject_id: PLUGIN_ID,
      verification_state: "verified",
      operator_receipt_id: operatorReceiptId,
      retirement_condition: "host-issued receipt get-bb/bb#1541",
    });
    const applied = await host.harness.callRpc("apply", { ...request, actorReceiptId, operatorReceiptId });
    expect(applied).toMatchObject({ outcome: "OK", mutationReceipt: { operatorReceiptId } });
    expect(db.prepare("SELECT actor_receipt_id, operator_receipt_id FROM state_events WHERE project_id = ?").get(PROJECT_ID)).toEqual({
      actor_receipt_id: actorReceiptId,
      operator_receipt_id: operatorReceiptId,
    });
  });

  it("derives only the ratified actor classes and keeps the operator binding digest compatible", () => {
    const { db, directory } = directDatabase();
    try {
      const allowed = ["bootstrap", "config_revision", "decision_create", "decision_disposition", "work_item_create", "work_item_transition", "qualification_observation_record", "role_generation_succession", "migration_prepare", "migration_step"] as const;
      for (const [index, mutationClass] of allowed.entries()) {
        const operatorReceipt = persistBootstrapOperatorReceipt(db, {
          projectId: PROJECT_ID,
          mutationClass,
          candidateHead: CANDIDATE_SHA,
          idempotencyKey: `derived-${mutationClass}`,
          requestDigest: sha256(`derived-${mutationClass}`),
          callerThreadId: "operator-thread",
          requestedFromBackground: false,
          callerPluginId: PLUGIN_ID,
        }, index + 1);
        expect(db.prepare("SELECT actor_kind, subject_id, verification_state, operator_receipt_id, retirement_condition FROM actor_receipts WHERE receipt_id = ?").get(operatorReceipt.actorReceiptId)).toEqual({
          actor_kind: "plugin",
          subject_id: PLUGIN_ID,
          verification_state: "verified",
          operator_receipt_id: operatorReceipt.operatorReceipt.receiptId,
          retirement_condition: "host-issued receipt get-bb/bb#1541",
        });
      }
      expect(() => persistBootstrapOperatorReceipt(db, {
        projectId: PROJECT_ID,
        mutationClass: "governor_claim",
        candidateHead: CANDIDATE_SHA,
        idempotencyKey: "derived-forbidden",
        requestDigest: sha256("derived-forbidden"),
        callerThreadId: "operator-thread",
        requestedFromBackground: false,
        callerPluginId: PLUGIN_ID,
      })).toThrow();
      expect(db.prepare("SELECT COUNT(*) AS count FROM operator_receipts").get()).toEqual({ count: allowed.length });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("authorizes operator_only Decisions and migration mutations through distinct linked derived receipts", () => {
    const { db, directory } = directDatabase();
    try {
      const authorize = (request: ApplyRequest): ApplyRequest => {
        const unsigned = { ...request, actorReceiptId: null, operatorReceiptId: null, candidateHead: CANDIDATE_SHA };
        const issued = persistBootstrapOperatorReceipt(db, {
          projectId: unsigned.projectId,
          mutationClass: unsigned.operationClass,
          candidateHead: CANDIDATE_SHA,
          idempotencyKey: unsigned.idempotencyKey,
          requestDigest: operatorRequestDigest(unsigned),
          callerThreadId: "operator-thread",
          requestedFromBackground: false,
          callerPluginId: PLUGIN_ID,
        });
        return { ...unsigned, actorReceiptId: issued.actorReceiptId, operatorReceiptId: issued.operatorReceipt.receiptId };
      };

      const bootstrap = authorize(bootstrapRequest(PROJECT_ID, { idempotencyKey: "derived-bootstrap", actorReceiptId: null }));
      const bootstrapped = applyAuthorizedMutation(db, bootstrap);
      expect(bootstrapped.outcome).toBe("OK");
      const fenceToken = (bootstrapped.evidence as { fenceToken: string }).fenceToken;

      const decisionCreate = authorize({
        projectId: PROJECT_ID,
        operationClass: "decision_create",
        idempotencyKey: "derived-decision-create",
        actorReceiptId: null,
        expectedConfigRevision: 1,
        expectedGovernanceEpoch: 1,
        expectedFenceToken: fenceToken,
        repoTargetId: null,
        decision: {
          decisionId: "decision-bb-collab-migration-cutover",
          repoTargetId: null,
          scope: { project: PROJECT_ID, acceptance: ["deterministic_export", "source_fence", "deterministic_import", "equivalence"] },
          decisionClass: "operator_only",
          options: { sourceSystem: "llm-collab", sourceFence: "f988d9711d3778f751e4ec0e32ebbf7b0893c80f", deployedSourceContract: "v36", shadowUntilProofs: true, governorCount: 1 },
          resourceRevision: 1,
        },
      });
      expect(applyAuthorizedMutation(db, decisionCreate)).toMatchObject({ outcome: "OK" });
      expect((db.prepare("SELECT request_digest FROM mutation_receipts WHERE idempotency_key = ?").get(decisionCreate.idempotencyKey) as { request_digest: string }).request_digest).toBe(
        operatorRequestDigest({ ...decisionCreate, actorReceiptId: null, operatorReceiptId: null }),
      );

      const rejectedRoleDecision = authorize({
        ...decisionCreate,
        idempotencyKey: "derived-role-decision",
        actorReceiptId: null,
        operatorReceiptId: null,
        decision: { ...decisionCreate.decision!, decisionId: "derived-role-decision", decisionClass: "assignment_admission" },
      });
      expect(applyAuthorizedMutation(db, rejectedRoleDecision).outcome).toBe("ACTOR_RECEIPT_UNVERIFIED");

      const disposition = authorize({
        projectId: PROJECT_ID,
        operationClass: "decision_disposition",
        idempotencyKey: "derived-decision-adopted",
        actorReceiptId: null,
        expectedConfigRevision: 1,
        expectedGovernanceEpoch: 1,
        expectedFenceToken: fenceToken,
        repoTargetId: null,
        decisionId: "decision-bb-collab-migration-cutover",
        disposition: "adopted",
        expectedResourceRevision: 1,
        reason: { sourceFence: "f988d9711d3778f751e4ec0e32ebbf7b0893c80f" },
      });
      expect(applyAuthorizedMutation(db, disposition)).toMatchObject({ outcome: "OK" });

      const prepare = authorize({
        projectId: PROJECT_ID,
        operationClass: "migration_prepare",
        idempotencyKey: "derived-migration-prepare",
        actorReceiptId: null,
        expectedConfigRevision: 1,
        configRevision: 1,
        expectedGovernanceEpoch: 1,
        expectedFenceToken: fenceToken,
        expectedResourceRevision: null,
        migration: {
          migrationId: "derived-migration",
          sourceSystem: "llm-collab",
          sourceRuntimeId: "llm-collab-runtime",
          targetRuntimeId: PLUGIN_ID,
          sourceContractDigest: contractDigest,
          sourceSchemaDigest: schemaDigest,
          sourceSnapshotDigest: sha256("derived-source-snapshot"),
          decisionId: "decision-bb-collab-migration-cutover",
          decisionDispositionSequence: 1,
          retentionUntilMs: 9_999_999_999_999,
        },
      });
      expect(applyAuthorizedMutation(db, prepare)).toMatchObject({ outcome: "OK" });
      const governor = currentGovernor(db);
      const step = authorize({
        projectId: PROJECT_ID,
        operationClass: "migration_step",
        idempotencyKey: "derived-migration-inventory",
        actorReceiptId: null,
        expectedConfigRevision: 1,
        configRevision: 1,
        expectedGovernanceEpoch: governor.governance_epoch,
        expectedFenceToken: governor.fence_token,
        expectedResourceRevision: 1,
        migrationStep: {
          migrationId: "derived-migration",
          step: "record_inventory",
          proofDigest: sha256("derived-inventory"),
          repositoryTargetsDigest: repositoryTargetsDigest(db),
        },
      });
      expect(applyAuthorizedMutation(db, step)).toMatchObject({ outcome: "OK" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM state_events WHERE operator_receipt_id IS NOT NULL AND actor_receipt_id IN (SELECT receipt_id FROM actor_receipts WHERE actor_kind = 'plugin')").get()).toEqual({ count: 5 });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("registers an operator approver and attests exact derived mutations without UI", async () => {
    const { host, db, fenceToken } = await assignmentFixture();
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: "operator-authorizer", actorKind: "operator", subjectId: "operator-1" });
    const authorizingCreate = decisionCreateRequest(fenceToken, "authorizing-operator", {
      actorReceiptId: "operator-authorizer",
      repoTargetId: null,
      decision: {
        decisionId: "authorizing-operator",
        repoTargetId: null,
        scope: { projectId: PROJECT_ID, purpose: "operator-approver" },
        decisionClass: "operator_only",
        options: { approverId: AUTHORIZED_APPROVER_ID },
        resourceRevision: 1,
      },
    });
    expect(applyWithFixtureReceipt(db, authorizingCreate)).toMatchObject({ outcome: "OK" });
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "authorizing-operator", 1, {
      actorReceiptId: "operator-authorizer",
      repoTargetId: null,
      idempotencyKey: "adopt-authorizing-operator",
    }))).toMatchObject({ outcome: "OK" });
    expect(db.prepare("SELECT project_id, approver_id, authorizing_decision_id, authorizing_disposition_sequence, status, allowed_mutation_classes_json FROM authorized_approvers").get()).toEqual({
      project_id: PROJECT_ID,
      approver_id: AUTHORIZED_APPROVER_ID,
      authorizing_decision_id: "authorizing-operator",
      authorizing_disposition_sequence: 1,
      status: "active",
      allowed_mutation_classes_json: canonicalJson(["bootstrap", "config_revision", "decision_create", "decision_disposition", "work_item_create", "work_item_transition", "qualification_observation_record", "role_generation_succession", "migration_prepare", "migration_step"]),
    });

    const unsigned = decisionCreateRequest(fenceToken, "attested-operator", {
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
      repoTargetId: null,
      decision: {
        decisionId: "attested-operator",
        repoTargetId: null,
        scope: { projectId: PROJECT_ID, purpose: "attested" },
        decisionClass: "operator_only",
        options: { approverId: AUTHORIZED_APPROVER_ID },
        resourceRevision: 1,
      },
    });
    const attestation = {
      projectId: PROJECT_ID,
      mutationClass: "decision_create" as const,
      candidateHead: CANDIDATE_SHA,
      idempotencyKey: unsigned.idempotencyKey,
      requestDigest: operatorRequestDigest(unsigned),
      callerThreadId: "attestor-thread",
      requestedFromBackground: true,
      approverId: AUTHORIZED_APPROVER_ID,
      authorizingDecisionId: "authorizing-operator",
      authorizingDispositionSequence: 1,
    };
    const pendingBefore = host.harness.inspection.pendingInteractions.length;
    const issued = await host.harness.callRpc("approverAttestation", attestation) as FoundationResult;
    expect(issued).toMatchObject({ outcome: "OK", actorReceiptId: expect.any(String), operatorReceipt: {
      approverId: AUTHORIZED_APPROVER_ID,
      authorizingDecisionId: "authorizing-operator",
      authorizingDispositionSequence: 1,
    } });
    expect(host.harness.inspection.pendingInteractions).toHaveLength(pendingBefore);

    const workItemUnsigned = workItemCreateRequest(fenceToken, {
      idempotencyKey: "attested-work-item",
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
      workItem: { workItemId: "attested-work-item", title: "Attested work item", body: "Canonical only." },
    });
    const workItemAttestation = await host.harness.callRpc("approverAttestation", {
      ...attestation,
      mutationClass: "work_item_create",
      idempotencyKey: workItemUnsigned.idempotencyKey,
      requestDigest: operatorRequestDigest(workItemUnsigned),
    }) as FoundationResult;
    expect(await host.harness.callRpc("apply", {
      ...workItemUnsigned,
      actorReceiptId: workItemAttestation.actorReceiptId,
      operatorReceiptId: workItemAttestation.operatorReceipt!.receiptId,
    })).toMatchObject({ outcome: "OK" });

    const transitionUnsigned = transitionRequest(fenceToken, "ready", 1, {
      workItemId: "attested-work-item",
      idempotencyKey: "attested-work-item-ready",
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
    });
    const missingRegistryRequest = { ...transitionUnsigned, idempotencyKey: "attested-work-item-missing-registry" };
    const beforeMissingRegistry = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("approverAttestation", {
      ...attestation,
      mutationClass: "work_item_transition",
      idempotencyKey: missingRegistryRequest.idempotencyKey,
      requestDigest: operatorRequestDigest(missingRegistryRequest),
      authorizingDecisionId: "missing-authorizing-decision",
    })).toMatchObject({ outcome: "AUTHORIZED_APPROVER_UNKNOWN" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeMissingRegistry);

    const transitionAttestation = await host.harness.callRpc("approverAttestation", {
      ...attestation,
      mutationClass: "work_item_transition",
      idempotencyKey: transitionUnsigned.idempotencyKey,
      requestDigest: operatorRequestDigest(transitionUnsigned),
    }) as FoundationResult;
    expect(transitionAttestation).toMatchObject({ outcome: "OK", actorReceiptId: expect.any(String), operatorReceipt: {
      mutationClass: "work_item_transition",
    } });
    const transitionAuthorized = {
      ...transitionUnsigned,
      actorReceiptId: transitionAttestation.actorReceiptId,
      operatorReceiptId: transitionAttestation.operatorReceipt!.receiptId,
    };
    const beforeTransitionRefusals = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", { ...transitionAuthorized, projectId: FOREIGN_PROJECT_ID })).toMatchObject({ outcome: "OPERATOR_RECEIPT_FOREIGN" });
    expect(await host.harness.callRpc("apply", { ...transitionAuthorized, operationClass: "work_item_create" })).toMatchObject({ outcome: "OPERATOR_RECEIPT_STALE" });
    expect(await host.harness.callRpc("apply", { ...transitionAuthorized, candidateHead: H1_CANDIDATE_SHA })).toMatchObject({ outcome: "OPERATOR_RECEIPT_STALE" });
    expect(await host.harness.callRpc("apply", { ...transitionAuthorized, expectedConfigRevision: 0 })).toMatchObject({ outcome: "PROJECT_CONFIG_STALE" });
    expect(await host.harness.callRpc("apply", { ...transitionAuthorized, expectedFenceToken: "stale-fence" })).toMatchObject({ outcome: "GOVERNOR_EPOCH_STALE" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeTransitionRefusals);
    expect(db.prepare("SELECT consumed_at_ms FROM operator_receipts WHERE receipt_id = ?").get(transitionAuthorized.operatorReceiptId)).toEqual({ consumed_at_ms: null });

    const staleResourceRequest = transitionRequest(fenceToken, "ready", 99, {
      workItemId: "attested-work-item",
      idempotencyKey: "attested-work-item-stale-resource",
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
    });
    const staleResourceAttestation = await host.harness.callRpc("approverAttestation", {
      ...attestation,
      mutationClass: "work_item_transition",
      idempotencyKey: staleResourceRequest.idempotencyKey,
      requestDigest: operatorRequestDigest(staleResourceRequest),
    }) as FoundationResult;
    expect(staleResourceAttestation).toMatchObject({ outcome: "OK" });
    const beforeStaleResource = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", {
      ...staleResourceRequest,
      actorReceiptId: staleResourceAttestation.actorReceiptId,
      operatorReceiptId: staleResourceAttestation.operatorReceipt!.receiptId,
    })).toMatchObject({ outcome: "WORK_ITEM_REVISION_STALE" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeStaleResource);

    const appliedTransition = await host.harness.callRpc("apply", transitionAuthorized) as FoundationResult;
    expect(appliedTransition).toMatchObject({ outcome: "OK", currentResourceRevision: 2, mutationReceipt: {
      operationClass: "work_item_transition",
      operatorReceiptId: transitionAuthorized.operatorReceiptId,
    } });
    expect(await host.harness.callRpc("apply", transitionAuthorized)).toEqual(appliedTransition);
    expect(await host.harness.callRpc("apply", { ...transitionAuthorized, idempotencyKey: "attested-work-item-ready-reuse" })).toMatchObject({ outcome: "OPERATOR_RECEIPT_REUSED" });

    const receiptId = issued.operatorReceipt!.receiptId;
    const actorReceiptId = issued.actorReceiptId!;
    const beforeWrong = db.prepare("SELECT COUNT(*) AS count FROM operator_receipts").get();
    for (const wrong of [
      { projectId: "proj-foreign" },
      { mutationClass: "governor_claim" },
      { authorizingDecisionId: "missing-decision" },
      { authorizingDispositionSequence: 2 },
      { approverId: "orchestrator:other" },
    ]) {
      const result = await host.harness.callRpc("approverAttestation", { ...attestation, ...wrong }) as FoundationResult;
      expect(result.outcome).not.toBe("OK");
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM operator_receipts").get()).toEqual(beforeWrong);

    const wrongApplyRequests = [
      { projectId: "proj-foreign" },
      { operationClass: "config_revision" },
      { candidateHead: "c".repeat(40) },
      { idempotencyKey: "wrong-idempotency" },
      { decision: { ...unsigned.decision!, options: { approverId: AUTHORIZED_APPROVER_ID, changed: true } } },
    ];
    const beforeWrongEvents = db.prepare("SELECT COUNT(*) AS count FROM state_events").get();
    for (const wrong of wrongApplyRequests) {
      const refused = await host.harness.callRpc("apply", { ...unsigned, ...wrong, actorReceiptId, operatorReceiptId: receiptId }) as FoundationResult;
      expect(refused.outcome).not.toBe("OK");
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM state_events").get()).toEqual(beforeWrongEvents);
    expect(await host.harness.callRpc("apply", { ...unsigned, actorReceiptId, operatorReceiptId: receiptId })).toMatchObject({ outcome: "OK" });
    expect(await host.harness.callRpc("apply", { ...unsigned, idempotencyKey: "attested-reuse", actorReceiptId, operatorReceiptId: receiptId })).toMatchObject({ outcome: "OPERATOR_RECEIPT_REUSED" });

    const roleUnsigned = decisionCreateRequest(fenceToken, "attested-role", {
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
      repoTargetId: TARGET_ID,
      decision: { ...decisionCreateRequest(fenceToken, "role-template").decision!, decisionId: "attested-role", decisionClass: "assignment_admission" },
    });
    const roleAttestation = await host.harness.callRpc("approverAttestation", {
      ...attestation,
      idempotencyKey: roleUnsigned.idempotencyKey,
      requestDigest: operatorRequestDigest(roleUnsigned),
    }) as FoundationResult;
    expect(await host.harness.callRpc("apply", {
      ...roleUnsigned,
      actorReceiptId: roleAttestation.actorReceiptId,
      operatorReceiptId: roleAttestation.operatorReceipt!.receiptId,
    })).toMatchObject({ outcome: "ACTOR_RECEIPT_UNVERIFIED" });

    const dispositionUnsigned = decisionDispositionRequest(fenceToken, "attested-operator", 1, {
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
      repoTargetId: null,
      idempotencyKey: "attested-operator-adopted",
    });
    const dispositionAttestation = {
      ...attestation,
      mutationClass: "decision_disposition" as const,
      idempotencyKey: dispositionUnsigned.idempotencyKey,
      requestDigest: operatorRequestDigest(dispositionUnsigned),
    };
    const dispositionIssued = await host.harness.callRpc("approverAttestation", dispositionAttestation) as FoundationResult;
    expect(dispositionIssued).toMatchObject({ outcome: "OK", actorReceiptId: expect.any(String), operatorReceipt: expect.objectContaining({
      mutationClass: "decision_disposition",
    }) });
    const dispositionReceiptId = dispositionIssued.operatorReceipt!.receiptId;
    const dispositionActorReceiptId = dispositionIssued.actorReceiptId!;
    const consumedBeforeDisposition = db.prepare("SELECT COUNT(*) AS count FROM operator_receipts WHERE consumed_at_ms IS NOT NULL").get();
    const dispositionApplied = await host.harness.callRpc("apply", {
      ...dispositionUnsigned,
      actorReceiptId: dispositionActorReceiptId,
      operatorReceiptId: dispositionReceiptId,
    }) as FoundationResult;
    expect(dispositionApplied).toMatchObject({ outcome: "OK" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM operator_receipts WHERE consumed_at_ms IS NOT NULL").get()).toEqual({
      count: (consumedBeforeDisposition as { count: number }).count + 1,
    });
    expect(db.prepare("SELECT consumed_at_ms, consumed_event_sequence FROM operator_receipts WHERE receipt_id = ?").get(dispositionReceiptId)).toMatchObject({
      consumed_at_ms: expect.any(Number),
      consumed_event_sequence: expect.any(Number),
    });
    expect(db.prepare("SELECT actor_receipt_id, operator_receipt_id FROM state_events WHERE idempotency_key = ?").get(dispositionUnsigned.idempotencyKey)).toEqual({
      actor_receipt_id: dispositionActorReceiptId,
      operator_receipt_id: dispositionReceiptId,
    });
    expect(db.prepare("SELECT operator_receipt_id FROM mutation_receipts WHERE idempotency_key = ?").get(dispositionUnsigned.idempotencyKey)).toEqual({
      operator_receipt_id: dispositionReceiptId,
    });
    expect(db.prepare("SELECT actor_receipt_id FROM decision_dispositions WHERE decision_id = ? AND disposition_sequence = 1").get("attested-operator")).toEqual({
      actor_receipt_id: dispositionActorReceiptId,
    });
    expect(db.prepare("SELECT status FROM authorized_approvers WHERE authorizing_decision_id = ?").get("authorizing-operator")).toEqual({ status: "revoked" });
    expect(db.prepare("SELECT status FROM authorized_approvers WHERE authorizing_decision_id = ? AND authorizing_disposition_sequence = 1").get("attested-operator")).toEqual({ status: "active" });

    const revocationGapUnsigned = decisionCreateRequest(fenceToken, "revocation-gap", {
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
      repoTargetId: null,
      decision: { ...unsigned.decision!, decisionId: "revocation-gap" },
    });
    const revocationGapIssued = await host.harness.callRpc("approverAttestation", {
      ...dispositionAttestation,
      mutationClass: "decision_create",
      idempotencyKey: revocationGapUnsigned.idempotencyKey,
      requestDigest: operatorRequestDigest(revocationGapUnsigned),
      authorizingDecisionId: "attested-operator",
      authorizingDispositionSequence: 1,
    }) as FoundationResult;
    expect(revocationGapIssued).toMatchObject({ outcome: "OK" });
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "attested-operator", 2, {
      actorReceiptId: "operator-authorizer",
      repoTargetId: null,
      disposition: "revoked",
      revertsDispositionSequence: 1,
      idempotencyKey: "revoke-attested-operator",
    }))).toMatchObject({ outcome: "OK" });
    const beforeRevokedApplyEvents = db.prepare("SELECT COUNT(*) AS count FROM state_events").get();
    const beforeRevokedApplyMutations = db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts").get();
    const refusedAfterRevocation = await host.harness.callRpc("apply", {
      ...revocationGapUnsigned,
      actorReceiptId: revocationGapIssued.actorReceiptId,
      operatorReceiptId: revocationGapIssued.operatorReceipt!.receiptId,
    }) as FoundationResult;
    expect(refusedAfterRevocation).toMatchObject({ outcome: "AUTHORIZED_APPROVER_REVOKED" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM state_events").get()).toEqual(beforeRevokedApplyEvents);
    expect(db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts").get()).toEqual(beforeRevokedApplyMutations);
    expect(db.prepare("SELECT 1 FROM decisions WHERE decision_id = ?").get("revocation-gap")).toBeUndefined();
    expect(db.prepare("SELECT consumed_at_ms FROM operator_receipts WHERE receipt_id = ?").get(revocationGapIssued.operatorReceipt!.receiptId)).toEqual({ consumed_at_ms: null });

    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "authorizing-operator", 2, {
      actorReceiptId: "operator-authorizer",
      repoTargetId: null,
      disposition: "revoked",
      revertsDispositionSequence: 1,
      idempotencyKey: "revoke-authorizing-operator",
    }))).toMatchObject({ outcome: "OK" });
    expect(db.prepare("SELECT status FROM authorized_approvers WHERE project_id = ?").get(PROJECT_ID)).toEqual({ status: "revoked" });
    const revoked = await host.harness.callRpc("approverAttestation", { ...attestation, idempotencyKey: "after-revocation" }) as FoundationResult;
    expect(revoked).toMatchObject({ outcome: "AUTHORIZED_APPROVER_REVOKED" });
  });

  it("survives the v13 approver bump through exact historical re-adoption", async () => {
    const { host, db, fenceToken } = await assignmentFixture();
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: "compat-operator", actorKind: "operator", subjectId: "operator-1" });
    const decisionId = "compat-operator";
    const authorizingCreate = decisionCreateRequest(fenceToken, decisionId, {
      actorReceiptId: "compat-operator",
      repoTargetId: null,
      decision: {
        decisionId,
        repoTargetId: null,
        scope: { projectId: PROJECT_ID, purpose: "v9-compatibility" },
        decisionClass: "operator_only",
        options: { approverId: AUTHORIZED_APPROVER_ID },
        resourceRevision: 1,
      },
    });
    expect(applyWithFixtureReceipt(db, authorizingCreate)).toMatchObject({ outcome: "OK" });
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, decisionId, 1, {
      actorReceiptId: "compat-operator",
      repoTargetId: null,
      idempotencyKey: `${decisionId}-seq1`,
    }))).toMatchObject({ outcome: "OK" });

    const previousJson = canonicalJson(PREVIOUS_V11_DERIVED_ACTOR_MUTATION_CLASSES);
    const currentJson = canonicalJson(DERIVED_ACTOR_MUTATION_CLASSES);
    const setRegistry = (allowedMutationClassesJson: string) => db.prepare(
      `UPDATE authorized_approvers SET allowed_mutation_classes_json = ?
       WHERE project_id = ? AND approver_id = ? AND authorizing_decision_id = ? AND authorizing_disposition_sequence = 1`,
    ).run(allowedMutationClassesJson, PROJECT_ID, AUTHORIZED_APPROVER_ID, decisionId);
    const activeRegistry = () => db.prepare(
      `SELECT authorizing_decision_id, authorizing_disposition_sequence, status, allowed_mutation_classes_json
       FROM authorized_approvers WHERE project_id = ? AND approver_id = ? ORDER BY authorizing_decision_id`,
    ).all(PROJECT_ID, AUTHORIZED_APPROVER_ID);
    setRegistry(previousJson);
    expect(Object.isFrozen(PREVIOUS_V11_DERIVED_ACTOR_MUTATION_CLASSES)).toBe(true);
    expect(activeRegistry()).toEqual([{
      authorizing_decision_id: decisionId,
      authorizing_disposition_sequence: 1,
      status: "active",
      allowed_mutation_classes_json: previousJson,
    }]);

    const attest = async (
      attestedRequest: ApplyRequest,
      mutationClass: ApplyRequest["operationClass"] = attestedRequest.operationClass,
      authorizingDecisionId = decisionId,
      authorizingDispositionSequence = 1,
    ) => host.harness.callRpc("approverAttestation", {
      projectId: attestedRequest.projectId,
      mutationClass,
      candidateHead: attestedRequest.candidateHead ?? CANDIDATE_SHA,
      idempotencyKey: attestedRequest.idempotencyKey,
      requestDigest: operatorRequestDigest(attestedRequest),
      callerThreadId: "v13-approver-matrix-attestor",
      requestedFromBackground: false,
      approverId: AUTHORIZED_APPROVER_ID,
      authorizingDecisionId,
      authorizingDispositionSequence,
    }) as Promise<FoundationResult>;

    const readoptCreate = decisionCreateRequest(fenceToken, "compat-v12-readopt", {
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
      repoTargetId: null,
      decision: {
        decisionId: "compat-v12-readopt",
        repoTargetId: null,
        scope: { projectId: PROJECT_ID, purpose: "v12-authority-maintenance-re-adoption" },
        decisionClass: "operator_only",
        options: { approverId: AUTHORIZED_APPROVER_ID },
        resourceRevision: 1,
      },
    });
    const pendingBeforeReAdoption = host.harness.inspection.pendingInteractions.length;
    const readoptCreateIssue = await attest(readoptCreate);
    expect(readoptCreateIssue).toMatchObject({ outcome: "OK", actorReceiptId: expect.any(String) });
    expect(host.harness.inspection.pendingInteractions).toHaveLength(pendingBeforeReAdoption);
    expect(await host.harness.callRpc("apply", {
      ...readoptCreate,
      actorReceiptId: readoptCreateIssue.actorReceiptId,
      operatorReceiptId: readoptCreateIssue.operatorReceipt!.receiptId,
    })).toMatchObject({ outcome: "OK" });

    const transition = transitionRequest(fenceToken, "ready", 1, {
      workItemId: WORK_ITEM_ID,
      idempotencyKey: "compat-v11-transition",
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
    });
    const beforeOldNewClass = exportFoundation(db, PROJECT_ID);
    expect(await attest(transition, "work_item_transition")).toMatchObject({ outcome: "AUTHORIZED_APPROVER_INVALID" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeOldNewClass);

    const readoptDisposition = decisionDispositionRequest(fenceToken, "compat-v12-readopt", 1, {
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
      repoTargetId: null,
      idempotencyKey: "compat-v12-readopt-adopted",
    });
    const readoptDispositionIssue = await attest(readoptDisposition, "decision_disposition");
    expect(readoptDispositionIssue).toMatchObject({ outcome: "OK", actorReceiptId: expect.any(String) });

    const beforeForeignApply = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", {
      ...readoptDisposition,
      projectId: FOREIGN_PROJECT_ID,
      actorReceiptId: readoptDispositionIssue.actorReceiptId,
      operatorReceiptId: readoptDispositionIssue.operatorReceipt!.receiptId,
    })).toMatchObject({ outcome: "OPERATOR_RECEIPT_FOREIGN" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeForeignApply);

    setRegistry(canonicalJson([...PREVIOUS_V11_DERIVED_ACTOR_MUTATION_CLASSES].reverse()));
    const beforeTamperedApply = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", {
      ...readoptDisposition,
      actorReceiptId: readoptDispositionIssue.actorReceiptId,
      operatorReceiptId: readoptDispositionIssue.operatorReceipt!.receiptId,
    })).toMatchObject({ outcome: "AUTHORIZED_APPROVER_INVALID" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeTamperedApply);
    expect(db.prepare("SELECT consumed_at_ms FROM operator_receipts WHERE receipt_id = ?").get(readoptDispositionIssue.operatorReceipt!.receiptId)).toEqual({ consumed_at_ms: null });
    setRegistry(previousJson);

    expect(await host.harness.callRpc("apply", {
      ...readoptDisposition,
      actorReceiptId: readoptDispositionIssue.actorReceiptId,
      operatorReceiptId: readoptDispositionIssue.operatorReceipt!.receiptId,
    })).toMatchObject({ outcome: "OK" });
    expect(activeRegistry()).toEqual([
      {
        authorizing_decision_id: decisionId,
        authorizing_disposition_sequence: 1,
        status: "revoked",
        allowed_mutation_classes_json: previousJson,
      },
      {
        authorizing_decision_id: "compat-v12-readopt",
        authorizing_disposition_sequence: 1,
        status: "active",
        allowed_mutation_classes_json: currentJson,
      },
    ]);

    const beforeReuse = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", {
      ...readoptDisposition,
      idempotencyKey: "compat-v12-readopt-reuse",
      actorReceiptId: readoptDispositionIssue.actorReceiptId,
      operatorReceiptId: readoptDispositionIssue.operatorReceipt!.receiptId,
    })).toMatchObject({ outcome: "OPERATOR_RECEIPT_REUSED" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeReuse);

    const currentRequest = (mutationClass: ApplyRequest["operationClass"], idempotencyKey: string): ApplyRequest => ({
      projectId: PROJECT_ID,
      operationClass: mutationClass,
      idempotencyKey,
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
      expectedConfigRevision: 1,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
    });
    const invalidSets: Array<[string, string]> = [
      ["malformed", "{not-json"],
      ["object", canonicalJson({ classes: DERIVED_ACTOR_MUTATION_CLASSES })],
      ["v9", canonicalJson([
        "bootstrap",
        "decision_create",
        "decision_disposition",
        "work_item_create",
        "qualification_observation_record",
        "role_generation_succession",
        "migration_prepare",
        "migration_step",
      ])],
      ["extra", canonicalJson([...DERIVED_ACTOR_MUTATION_CLASSES, "governor_claim"])],
      ["subset", canonicalJson(DERIVED_ACTOR_MUTATION_CLASSES.slice(0, -1))],
      ["reordered", canonicalJson([
        DERIVED_ACTOR_MUTATION_CLASSES[1]!,
        DERIVED_ACTOR_MUTATION_CLASSES[0]!,
        ...DERIVED_ACTOR_MUTATION_CLASSES.slice(2),
      ])],
    ];
    for (const [label, classSetJson] of invalidSets) {
      if (label === "malformed") db.pragma("ignore_check_constraints = ON");
      try {
        db.prepare(
          `UPDATE authorized_approvers SET allowed_mutation_classes_json = ?
           WHERE project_id = ? AND approver_id = ? AND authorizing_decision_id = 'compat-v12-readopt' AND authorizing_disposition_sequence = 1`,
        ).run(classSetJson, PROJECT_ID, AUTHORIZED_APPROVER_ID);
      } finally {
        if (label === "malformed") db.pragma("ignore_check_constraints = OFF");
      }
      const invalidRequest = currentRequest("decision_create", `compat-invalid-${label}`);
      const beforeInvalid = exportFoundation(db, PROJECT_ID);
      expect(await attest(invalidRequest, "decision_create", "compat-v12-readopt")).toMatchObject({ outcome: "AUTHORIZED_APPROVER_INVALID" });
      expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeInvalid);
    }
    db.prepare(
      `UPDATE authorized_approvers SET allowed_mutation_classes_json = ?
       WHERE project_id = ? AND approver_id = ? AND authorizing_decision_id = 'compat-v12-readopt' AND authorizing_disposition_sequence = 1`,
    ).run(currentJson, PROJECT_ID, AUTHORIZED_APPROVER_ID);

    for (const mutationClass of DERIVED_ACTOR_MUTATION_CLASSES) {
      const currentIssue = await attest(currentRequest(mutationClass, `compat-current-${mutationClass}`), mutationClass, "compat-v12-readopt");
      expect(currentIssue).toMatchObject({ outcome: "OK", actorReceiptId: expect.any(String), operatorReceipt: { mutationClass } });
    }
    expect(host.harness.inspection.pendingInteractions).toHaveLength(pendingBeforeReAdoption);
  });

  it("authorizes config revisions carrying roleRequirements and refuses before write on mismatches", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: "config-operator", actorKind: "operator", subjectId: "operator-1" });

    const authorizingCreate = decisionCreateRequest(fenceToken, "config-role-approver", {
      actorReceiptId: "config-operator",
      repoTargetId: null,
      decision: {
        decisionId: "config-role-approver",
        repoTargetId: null,
        scope: { projectId: PROJECT_ID, purpose: "config-role-requirements" },
        decisionClass: "operator_only",
        options: { approverId: AUTHORIZED_APPROVER_ID },
        resourceRevision: 1,
      },
    });
    expect(applyWithFixtureReceipt(db, authorizingCreate)).toMatchObject({ outcome: "OK" });
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "config-role-approver", 1, {
      actorReceiptId: "config-operator",
      repoTargetId: null,
      idempotencyKey: "adopt-config-role-approver",
    }))).toMatchObject({ outcome: "OK" });

    const nextConfig = roleConfig();
    (nextConfig.extensions.bbCollab as Record<string, unknown>).writingLaneCeiling = 3;
    const unsigned = bootstrapRequest(PROJECT_ID, {
      operationClass: "config_revision",
      idempotencyKey: "config-role-requirements-2",
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
      expectedConfigRevision: 1,
      configRevision: 2,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
      config: nextConfig,
    });
    const attestationInput = {
      projectId: PROJECT_ID,
      mutationClass: "config_revision" as const,
      candidateHead: CANDIDATE_SHA,
      idempotencyKey: unsigned.idempotencyKey,
      requestDigest: operatorRequestDigest(unsigned),
      callerThreadId: "config-role-attestor",
      requestedFromBackground: false,
      approverId: AUTHORIZED_APPROVER_ID,
      authorizingDecisionId: "config-role-approver",
      authorizingDispositionSequence: 1,
    };
    const issued = await host.harness.callRpc("approverAttestation", attestationInput) as FoundationResult;
    expect(issued).toMatchObject({ outcome: "OK", actorReceiptId: expect.any(String), operatorReceipt: {
      mutationClass: "config_revision",
      issuanceProvenance: "attestation",
      approverId: AUTHORIZED_APPROVER_ID,
      authorizingDecisionId: "config-role-approver",
      authorizingDispositionSequence: 1,
    } });
    expect(db.prepare("SELECT actor_kind, subject_id, operator_receipt_id FROM actor_receipts WHERE receipt_id = ?").get(issued.actorReceiptId)).toEqual({
      actor_kind: "plugin",
      subject_id: PLUGIN_ID,
      operator_receipt_id: issued.operatorReceipt!.receiptId,
    });
    expect(db.prepare("SELECT actor_kind, COUNT(*) AS count FROM actor_receipts GROUP BY actor_kind ORDER BY actor_kind").all()).toEqual([
      { actor_kind: "fixture", count: 1 },
      { actor_kind: "operator", count: 1 },
      { actor_kind: "plugin", count: 1 },
    ]);
    const authorized = {
      ...unsigned,
      actorReceiptId: issued.actorReceiptId!,
      operatorReceiptId: issued.operatorReceipt!.receiptId,
    };
    const attestedWrongTargetUnsigned = {
      ...unsigned,
      idempotencyKey: "config-attested-wrong-target",
      actorReceiptId: null,
      operatorReceiptId: null,
    };
    const attestedWrongTarget = await host.harness.callRpc("approverAttestation", {
      ...attestationInput,
      idempotencyKey: attestedWrongTargetUnsigned.idempotencyKey,
      requestDigest: operatorRequestDigest(attestedWrongTargetUnsigned),
    }) as FoundationResult;
    expect(attestedWrongTarget).toMatchObject({ outcome: "OK", operatorReceipt: { issuanceProvenance: "attestation" } });
    const beforeAttestedWrongActor = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", {
      ...attestedWrongTargetUnsigned,
      actorReceiptId: issued.actorReceiptId,
      operatorReceiptId: attestedWrongTarget.operatorReceipt!.receiptId,
    })).toMatchObject({ outcome: "ACTOR_RECEIPT_UNVERIFIED", attempted: 0, verified: 0 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeAttestedWrongActor);

    const unlinkedPluginReceipt = persistBootstrapOperatorReceipt(db, {
      projectId: PROJECT_ID,
      mutationClass: "config_revision",
      candidateHead: CANDIDATE_SHA,
      idempotencyKey: "config-unlinked-plugin-actor",
      requestDigest: operatorRequestDigest({ ...unsigned, idempotencyKey: "config-unlinked-plugin-actor" }),
      callerThreadId: "config-unlinked-plugin",
      requestedFromBackground: false,
      callerPluginId: PLUGIN_ID,
    });
    const unlinkedPlugin = {
      ...unsigned,
      idempotencyKey: "config-unlinked-plugin-actor",
      actorReceiptId: unlinkedPluginReceipt.actorReceiptId,
      operatorReceiptId: persistInterimOperatorReceipt(db, {
        projectId: PROJECT_ID,
        mutationClass: "config_revision",
        candidateHead: CANDIDATE_SHA,
        idempotencyKey: "config-unlinked-plugin-actor",
        requestDigest: operatorRequestDigest({ ...unsigned, idempotencyKey: "config-unlinked-plugin-actor" }),
        callerThreadId: "config-unlinked-target",
        requestedFromBackground: false,
        callerPluginId: PLUGIN_ID,
        issuanceProvenance: "console",
      }).receiptId,
    };
    const beforeUnlinkedPlugin = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", unlinkedPlugin)).toMatchObject({ outcome: "ACTOR_RECEIPT_UNVERIFIED", attempted: 0, verified: 0 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeUnlinkedPlugin);

    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: "config-role-actor", actorKind: "role", subjectId: "preexisting-holder", roleId: "project-orchestrator", roleGeneration: 1 });
    const roleActorBaseline = db.prepare("SELECT COUNT(*) AS count FROM actor_receipts WHERE actor_kind = 'role'").get() as { count: number };
    const roleAuthorized = { ...authorized, actorReceiptId: "config-role-actor", operatorReceiptId: null };
    const compatibleRoleReceipt = persistInterimOperatorReceipt(db, {
      projectId: PROJECT_ID, mutationClass: "config_revision", candidateHead: CANDIDATE_SHA,
      idempotencyKey: roleAuthorized.idempotencyKey, requestDigest: operatorRequestDigest(roleAuthorized),
      callerThreadId: "config-role-attestor", requestedFromBackground: false, callerPluginId: PLUGIN_ID, issuanceProvenance: "console",
    });
    const beforeRoleActor = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", { ...roleAuthorized, operatorReceiptId: compatibleRoleReceipt.receiptId })).toMatchObject({ outcome: "ACTOR_RECEIPT_UNVERIFIED", attempted: 0, verified: 0 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeRoleActor);

    const beforeRefusals = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", { ...authorized, projectId: FOREIGN_PROJECT_ID })).toMatchObject({ outcome: "OPERATOR_RECEIPT_FOREIGN" });
    expect(await host.harness.callRpc("apply", { ...authorized, operationClass: "work_item_create" })).toMatchObject({ outcome: "OPERATOR_RECEIPT_STALE" });
    expect(await host.harness.callRpc("apply", { ...authorized, candidateHead: H1_CANDIDATE_SHA })).toMatchObject({ outcome: "OPERATOR_RECEIPT_STALE" });
    expect(await host.harness.callRpc("apply", { ...authorized, idempotencyKey: "config-role-requirements-other" })).toMatchObject({ outcome: "OPERATOR_RECEIPT_STALE" });
    expect(await host.harness.callRpc("apply", { ...authorized, config: { ...nextConfig, digestMismatch: true } })).toMatchObject({ outcome: "OPERATOR_RECEIPT_STALE" });
    expect(await host.harness.callRpc("apply", { ...authorized, expectedConfigRevision: 0 })).toMatchObject({ outcome: "PROJECT_CONFIG_STALE" });
    expect(await host.harness.callRpc("apply", { ...authorized, expectedFenceToken: "stale-fence" })).toMatchObject({ outcome: "GOVERNOR_EPOCH_STALE" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeRefusals);
    expect(db.prepare("SELECT consumed_at_ms FROM operator_receipts WHERE receipt_id = ?").get(authorized.operatorReceiptId)).toEqual({ consumed_at_ms: null });

    const applied = await host.harness.callRpc("apply", authorized) as FoundationResult;
    expect(applied).toMatchObject({
      outcome: "OK",
      expected: 2,
      attempted: 2,
      verified: 2,
      currentConfigRevision: 2,
      mutationReceipt: { operationClass: "config_revision", operatorReceiptId: authorized.operatorReceiptId },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM actor_receipts WHERE actor_kind = 'role'").get()).toEqual(roleActorBaseline);
    const stored = db.prepare("SELECT canonical_config_json FROM project_config_revisions WHERE project_id = ? AND config_revision = 2").get(PROJECT_ID) as { canonical_config_json: string };
    const storedConfig = JSON.parse(stored.canonical_config_json) as { extensions: { bbCollab: Record<string, unknown> } };
    expect(storedConfig.extensions.bbCollab.writingLaneCeiling).toBe(3);
    expect(storedConfig.extensions.bbCollab.roleRequirements).toEqual(nextConfig.extensions.bbCollab.roleRequirements);
    expect(storedConfig.extensions.bbCollab.roleRequirements).toEqual(expect.arrayContaining([
      { roleRequirementId: "worker-v1", roleId: "worker", repoTargetId: TARGET_ID, executedProfile: ROLE_PROFILE },
    ]));
    expect(storedConfig.extensions.bbCollab.roleRequirements).toHaveLength(3);
    expect(db.prepare("SELECT actor_receipt_id, operator_receipt_id FROM state_events WHERE idempotency_key = ?").get(unsigned.idempotencyKey)).toEqual({
      actor_receipt_id: authorized.actorReceiptId,
      operator_receipt_id: authorized.operatorReceiptId,
    });
    expect(db.prepare("SELECT consumed_at_ms, consumed_event_sequence FROM operator_receipts WHERE receipt_id = ?").get(authorized.operatorReceiptId)).toMatchObject({
      consumed_at_ms: expect.any(Number),
      consumed_event_sequence: expect.any(Number),
    });
    expect(await host.harness.callRpc("apply", authorized)).toEqual(applied);

    const rejectConfig = async (name: string, config: ReturnType<typeof roleConfig>, outcome: FoundationResult["outcome"], message?: string) => {
      const invalidUnsigned = bootstrapRequest(PROJECT_ID, {
        operationClass: "config_revision",
        idempotencyKey: `config-role-requirements-${name}`,
        actorReceiptId: null,
        operatorReceiptId: null,
        candidateHead: CANDIDATE_SHA,
        expectedConfigRevision: 2,
        configRevision: 3,
        expectedGovernanceEpoch: 1,
        expectedFenceToken: fenceToken,
        config,
      });
      const invalidIssued = await host.harness.callRpc("approverAttestation", {
        ...attestationInput,
        idempotencyKey: invalidUnsigned.idempotencyKey,
        requestDigest: operatorRequestDigest(invalidUnsigned),
      }) as FoundationResult;
      expect(invalidIssued).toMatchObject({ outcome: "OK" });
      const beforeInvalid = exportFoundation(db, PROJECT_ID);
      const rejected = await host.harness.callRpc("apply", {
        ...invalidUnsigned,
        actorReceiptId: invalidIssued.actorReceiptId,
        operatorReceiptId: invalidIssued.operatorReceipt!.receiptId,
      }) as FoundationResult;
      expect(rejected).toMatchObject({ outcome, attempted: 0, verified: 0 });
      if (message) expect(rejected.message).toContain(message);
      expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeInvalid);
      expect(db.prepare("SELECT config_revision FROM project_config_heads WHERE project_id = ?").get(PROJECT_ID)).toEqual({ config_revision: 2 });
      expect(db.prepare("SELECT consumed_at_ms FROM operator_receipts WHERE receipt_id = ?").get(invalidIssued.operatorReceipt!.receiptId)).toEqual({ consumed_at_ms: null });
    };

    const duplicateConfig = roleConfig();
    const duplicateRequirements = duplicateConfig.extensions.bbCollab.roleRequirements as Array<Record<string, unknown>>;
    duplicateRequirements[1] = { ...duplicateRequirements[1]!, roleRequirementId: duplicateRequirements[0]!.roleRequirementId };
    await rejectConfig("duplicate", duplicateConfig, "INVALID_INPUT");

    const duplicateRoleConfig = roleConfig();
    const duplicateRoleRequirements = duplicateRoleConfig.extensions.bbCollab.roleRequirements as Array<Record<string, unknown>>;
    duplicateRoleRequirements[1] = { ...duplicateRoleRequirements[1]!, roleId: "project-orchestrator", repoTargetId: null };
    await rejectConfig("duplicate-role", duplicateRoleConfig, "INVALID_INPUT", "duplicate logical role");

    const foreignRoleConfig = roleConfig();
    const foreignRoleRequirements = foreignRoleConfig.extensions.bbCollab.roleRequirements as Array<Record<string, unknown>>;
    foreignRoleRequirements[1] = { ...foreignRoleRequirements[1]!, roleId: "foreign-role" };
    await rejectConfig("foreign-role", foreignRoleConfig, "INVALID_INPUT");

    const foreignConfig = roleConfig();
    const foreignRequirements = foreignConfig.extensions.bbCollab.roleRequirements as Array<Record<string, unknown>>;
    foreignRequirements.find((requirement) => requirement.roleRequirementId === "worker-v1")!.repoTargetId = SECOND_TARGET_ID;
    await rejectConfig("foreign-target", foreignConfig, "REPO_TARGET_FOREIGN");

    const incorrectScopeConfig = roleConfig();
    const incorrectScopeRequirements = incorrectScopeConfig.extensions.bbCollab.roleRequirements as Array<Record<string, unknown>>;
    incorrectScopeRequirements.find((requirement) => requirement.roleRequirementId === "worker-v1")!.repoTargetId = null;
    await rejectConfig("worker-project-scope", incorrectScopeConfig, "INVALID_INPUT");

    const overCapacityConfig = roleConfig();
    const overCapacityRequirements = overCapacityConfig.extensions.bbCollab.roleRequirements as Array<Record<string, unknown>>;
    overCapacityRequirements.push({ roleRequirementId: "worker-v2", roleId: "worker", repoTargetId: TARGET_ID, executedProfile: ROLE_PROFILE });
    overCapacityRequirements.push({ roleRequirementId: "worker-v3", roleId: "worker", repoTargetId: TARGET_ID, executedProfile: ROLE_PROFILE });
    await rejectConfig("over-capacity", overCapacityConfig, "INVALID_INPUT", "Too big");

    const overLaneCapConfig = roleConfig();
    (overLaneCapConfig.extensions.bbCollab as Record<string, unknown>).writingLaneCeiling = 4;
    await rejectConfig("over-lane-cap", overLaneCapConfig, "INVALID_INPUT", "integer from 0 through 3");
  });

  it("replays a consumed legacy receipt but refuses a new legacy receipt or wrong actor binding", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    const request = (idempotencyKey: string, expectedConfigRevision: number, configRevision: number): ApplyRequest => bootstrapRequest(PROJECT_ID, {
      operationClass: "config_revision",
      idempotencyKey,
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
      expectedConfigRevision,
      configRevision,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
      config: roleConfig(),
    });
    const issueConsoleReceipt = async (unsigned: ApplyRequest) => {
      const pending = host.harness.callRpc("operatorReceipt", {
        projectId: unsigned.projectId,
        mutationClass: unsigned.operationClass,
        candidateHead: unsigned.candidateHead!,
        idempotencyKey: unsigned.idempotencyKey,
        requestDigest: operatorRequestDigest(unsigned),
        callerThreadId: `console-${unsigned.idempotencyKey}`,
        requestedFromBackground: false,
      });
      await vi.waitFor(() => expect(host.harness.inspection.pendingInteractions).toHaveLength(1));
      const interaction = host.harness.inspection.pendingInteractions[0]!;
      host.harness.behavior.submitInteraction(interaction.id, {
        confirmed: true,
        projectId: unsigned.projectId,
        mutationClass: unsigned.operationClass,
        candidateHead: unsigned.candidateHead!,
        idempotencyKey: unsigned.idempotencyKey,
        requestDigest: operatorRequestDigest(unsigned),
      });
      return pending as Promise<FoundationResult>;
    };

    const acceptedUnsigned = request("console-config-accepted", 1, 2);
    const accepted = await issueConsoleReceipt(acceptedUnsigned);
    expect(accepted).toMatchObject({ outcome: "OK", actorReceiptId: expect.any(String), operatorReceipt: { issuanceProvenance: "console" } });
    const acceptedApply = await host.harness.callRpc("apply", {
      ...acceptedUnsigned,
      actorReceiptId: accepted.actorReceiptId,
      operatorReceiptId: accepted.operatorReceipt!.receiptId,
    }) as FoundationResult;
    expect(acceptedApply).toMatchObject({ outcome: "OK" });
    const consumedLegacyFixtureReceiptId = `${accepted.operatorReceipt!.receiptId}-legacy-fixture`;
    db.prepare(
      `INSERT INTO operator_receipts (
        project_id, receipt_id, receipt_type, mutation_class, candidate_head,
        binding_digest, status, retirement_condition, caller_thread_id,
        caller_plugin_id, requested_from_background, receipt_digest, created_at_ms,
        idempotency_key, request_digest, approver_id, authorizing_decision_id,
        authorizing_disposition_sequence, issuance_provenance, consumed_at_ms,
        consumed_event_sequence
      ) SELECT project_id, ?, receipt_type, mutation_class, candidate_head,
        binding_digest, status, retirement_condition, caller_thread_id,
        caller_plugin_id, requested_from_background, ?, created_at_ms,
        idempotency_key, request_digest, approver_id, authorizing_decision_id,
        authorizing_disposition_sequence, NULL, consumed_at_ms,
        consumed_event_sequence
      FROM operator_receipts WHERE receipt_id = ?`,
    ).run(
      consumedLegacyFixtureReceiptId,
      receiptProvenanceDigest({ ...accepted.operatorReceipt!, receiptId: consumedLegacyFixtureReceiptId }, null),
      accepted.operatorReceipt!.receiptId,
    );
    db.prepare("UPDATE mutation_receipts SET operator_receipt_id = ? WHERE project_id = ? AND idempotency_key = ?").run(
      consumedLegacyFixtureReceiptId,
      PROJECT_ID,
      acceptedUnsigned.idempotencyKey,
    );
    db.prepare("UPDATE state_events SET operator_receipt_id = ? WHERE project_id = ? AND operator_receipt_id = ?").run(
      consumedLegacyFixtureReceiptId,
      PROJECT_ID,
      accepted.operatorReceipt!.receiptId,
    );
    const consumedLegacyFixtureActorId = `${accepted.actorReceiptId}-legacy-fixture`;
    db.prepare(
      `INSERT INTO actor_receipts (
        project_id, receipt_id, actor_kind, subject_id, role_id, role_generation,
        verification_state, receipt_digest, issued_at_ms, operator_receipt_id,
        retirement_condition
      ) SELECT project_id, ?, actor_kind, subject_id, role_id, role_generation,
        verification_state, ?, issued_at_ms, ?, retirement_condition
      FROM actor_receipts WHERE receipt_id = ?`,
    ).run(
      consumedLegacyFixtureActorId,
      sha256(canonicalJson({
        projectId: PROJECT_ID,
        receiptId: consumedLegacyFixtureActorId,
        actorKind: "plugin",
        subjectId: PLUGIN_ID,
        roleId: null,
        roleGeneration: null,
        verificationState: "verified",
        operatorReceiptId: consumedLegacyFixtureReceiptId,
        retirementCondition: "host-issued receipt get-bb/bb#1541",
      })),
      consumedLegacyFixtureReceiptId,
      accepted.actorReceiptId,
    );
    db.prepare("UPDATE state_events SET actor_receipt_id = ? WHERE project_id = ? AND actor_receipt_id = ?").run(
      consumedLegacyFixtureActorId,
      PROJECT_ID,
      accepted.actorReceiptId,
    );
    const beforeConsumedLegacyReplay = exportFoundation(db, PROJECT_ID);
    expect(db.prepare("SELECT consumed_at_ms, issuance_provenance FROM operator_receipts WHERE receipt_id = ?").get(consumedLegacyFixtureReceiptId)).toEqual({ consumed_at_ms: expect.any(Number), issuance_provenance: null });
    expect(probeV20ConsumedLegacyReplay(db, PROJECT_ID)).toMatchObject({
      observedSchemaVersion: 12,
      observedContractVersion: 20,
      consumedLegacyReplay: { outcome: "OK" },
    });
    const copiedReceipt = db.prepare("SELECT binding_digest, receipt_digest FROM operator_receipts WHERE receipt_id = ?").get(consumedLegacyFixtureReceiptId) as { binding_digest: string; receipt_digest: string };
    db.prepare("UPDATE operator_receipts SET binding_digest = 'bad' WHERE receipt_id = ?").run(consumedLegacyFixtureReceiptId);
    expect(await host.harness.callRpc("apply", {
      ...acceptedUnsigned,
      actorReceiptId: consumedLegacyFixtureActorId,
      operatorReceiptId: consumedLegacyFixtureReceiptId,
    })).toMatchObject({ outcome: "OPERATOR_RECEIPT_REUSED", attempted: 0, verified: 0 });
    db.prepare("UPDATE operator_receipts SET binding_digest = ? WHERE receipt_id = ?").run(copiedReceipt.binding_digest, consumedLegacyFixtureReceiptId);
    db.prepare("UPDATE operator_receipts SET receipt_digest = 'bad' WHERE receipt_id = ?").run(consumedLegacyFixtureReceiptId);
    expect(await host.harness.callRpc("apply", {
      ...acceptedUnsigned,
      actorReceiptId: consumedLegacyFixtureActorId,
      operatorReceiptId: consumedLegacyFixtureReceiptId,
    })).toMatchObject({ outcome: "OPERATOR_RECEIPT_REUSED", attempted: 0, verified: 0 });
    db.prepare("UPDATE operator_receipts SET receipt_digest = ? WHERE receipt_id = ?").run(copiedReceipt.receipt_digest, consumedLegacyFixtureReceiptId);
    expect(await host.harness.callRpc("apply", {
      ...acceptedUnsigned,
      actorReceiptId: consumedLegacyFixtureActorId,
      operatorReceiptId: consumedLegacyFixtureReceiptId,
    })).toEqual(acceptedApply);
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeConsumedLegacyReplay);
    expect(await host.harness.callRpc("apply", {
      ...acceptedUnsigned,
      actorReceiptId: accepted.actorReceiptId,
      operatorReceiptId: consumedLegacyFixtureReceiptId,
    })).toMatchObject({ outcome: "OPERATOR_RECEIPT_REUSED", attempted: 0, verified: 0 });
    db.prepare("UPDATE operator_receipts SET consumed_event_sequence = consumed_event_sequence + 1 WHERE receipt_id = ?").run(consumedLegacyFixtureReceiptId);
    expect(await host.harness.callRpc("apply", {
      ...acceptedUnsigned,
      actorReceiptId: consumedLegacyFixtureActorId,
      operatorReceiptId: consumedLegacyFixtureReceiptId,
    })).toMatchObject({ outcome: "OPERATOR_RECEIPT_REUSED", attempted: 0, verified: 0 });
    const { consumed_event_sequence: consumedEventSequence } = db.prepare("SELECT consumed_event_sequence FROM operator_receipts WHERE receipt_id = ?").get(consumedLegacyFixtureReceiptId) as { consumed_event_sequence: number };
    db.prepare("UPDATE operator_receipts SET consumed_event_sequence = ? WHERE receipt_id = ?").run(consumedEventSequence - 1, consumedLegacyFixtureReceiptId);
    db.prepare("UPDATE state_events SET operator_receipt_id = ? WHERE project_id = ? AND event_sequence = ?").run(
      accepted.operatorReceipt!.receiptId,
      PROJECT_ID,
      consumedEventSequence - 1,
    );
    expect(await host.harness.callRpc("apply", {
      ...acceptedUnsigned,
      actorReceiptId: consumedLegacyFixtureActorId,
      operatorReceiptId: consumedLegacyFixtureReceiptId,
    })).toMatchObject({ outcome: "OPERATOR_RECEIPT_REUSED", attempted: 0, verified: 0 });

    const wrongActor = await issueConsoleReceipt(request("console-wrong-actor-source", 2, 3));
    const wrongTargetUnsigned = request("console-wrong-actor-target", 2, 3);
    const wrongTarget = await issueConsoleReceipt(wrongTargetUnsigned);
    const wrongTargetId = wrongTarget.operatorReceipt!.receiptId;
    const wrongActorReceiptId = wrongActor.operatorReceipt!.receiptId;
    expect(await host.harness.callRpc("apply", {
      ...wrongTargetUnsigned,
      actorReceiptId: wrongActor.actorReceiptId,
      operatorReceiptId: wrongTargetId,
    })).toMatchObject({ outcome: "ACTOR_RECEIPT_UNVERIFIED", attempted: 0, verified: 0 });
    const wrongActorLegacyDigest = receiptProvenanceDigest(wrongActor.operatorReceipt!, null);
    db.prepare("UPDATE operator_receipts SET issuance_provenance = NULL, receipt_digest = ? WHERE receipt_id = ?").run(wrongActorLegacyDigest, wrongActorReceiptId);
    expect(await host.harness.callRpc("apply", {
      ...wrongTargetUnsigned,
      actorReceiptId: wrongActor.actorReceiptId,
      operatorReceiptId: wrongTargetId,
    })).toMatchObject({ outcome: "ACTOR_RECEIPT_UNVERIFIED", attempted: 0, verified: 0 });

    const legacyUnsigned = request("legacy-console-binding", 2, 3);
    const legacy = await issueConsoleReceipt(legacyUnsigned);
    const legacyDigest = receiptProvenanceDigest(legacy.operatorReceipt!, null);
    db.prepare("UPDATE operator_receipts SET issuance_provenance = NULL, receipt_digest = ? WHERE receipt_id = ?").run(legacyDigest, legacy.operatorReceipt!.receiptId);
    const beforeNewLegacyApply = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", {
      ...legacyUnsigned,
      actorReceiptId: legacy.actorReceiptId,
      operatorReceiptId: legacy.operatorReceipt!.receiptId,
    })).toMatchObject({ outcome: "OPERATOR_RECEIPT_INVALID", attempted: 0, verified: 0 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeNewLegacyApply);

    const malformedAttestationUnsigned = request("malformed-attestation-binding", 2, 3);
    const malformedAttestation = await issueConsoleReceipt(malformedAttestationUnsigned);
    db.prepare("UPDATE operator_receipts SET issuance_provenance = 'attestation', receipt_digest = ? WHERE receipt_id = ?").run(
      receiptProvenanceDigest(malformedAttestation.operatorReceipt!, "attestation"),
      malformedAttestation.operatorReceipt!.receiptId,
    );
    expect(await host.harness.callRpc("apply", {
      ...malformedAttestationUnsigned,
      actorReceiptId: malformedAttestation.actorReceiptId,
      operatorReceiptId: malformedAttestation.operatorReceipt!.receiptId,
    })).toMatchObject({ outcome: "OPERATOR_RECEIPT_INVALID", attempted: 0, verified: 0 });
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
      issuanceProvenance: "console",
    }, 1);
    const authorized = { ...authorizedRequest, operatorReceiptId: receipt.receiptId };
    expect(await host.harness.callRpc("apply", authorized)).toMatchObject({ outcome: "OK" });
    const beforeSecond = exportFoundation(db, PROJECT_ID);
    const second = migrationStepRequest(db, "record_quiescence", { proofDigest: sha256("quiescence") }, { operatorReceiptId: receipt.receiptId, candidateHead: CANDIDATE_SHA });
    expect(await host.harness.callRpc("apply", second)).toMatchObject({ outcome: "OPERATOR_RECEIPT_REUSED" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeSecond);
  });

  it("revalidates an in-flight same-Decision adopted disposition without weakening other receipt paths", async () => {
    const { host, db, fenceToken } = await assignmentFixture();
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: "operator-authorizer", actorKind: "operator", subjectId: "operator-1" });
    const decisionId = "in-flight-operator";
    const create = decisionCreateRequest(fenceToken, decisionId, {
      actorReceiptId: "operator-authorizer",
      repoTargetId: null,
      decision: {
        decisionId,
        repoTargetId: null,
        scope: { projectId: PROJECT_ID, purpose: "in-flight-approver" },
        decisionClass: "operator_only",
        options: { approverId: AUTHORIZED_APPROVER_ID },
        resourceRevision: 1,
      },
    });
    expect(applyWithFixtureReceipt(db, create).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, decisionId, 1, {
      actorReceiptId: "operator-authorizer",
      repoTargetId: null,
      idempotencyKey: `${decisionId}-seq1`,
    })).outcome).toBe("OK");

    const dispositionRequest = (sequence: number): ApplyRequest => decisionDispositionRequest(fenceToken, decisionId, sequence, {
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
      repoTargetId: null,
      idempotencyKey: `${decisionId}-seq${sequence}`,
    });
    const attest = async (request: ApplyRequest) => host.harness.callRpc("approverAttestation", {
      projectId: PROJECT_ID,
      mutationClass: "decision_disposition",
      candidateHead: CANDIDATE_SHA,
      idempotencyKey: request.idempotencyKey,
      requestDigest: operatorRequestDigest(request),
      callerThreadId: "in-flight-attestor",
      requestedFromBackground: false,
      approverId: AUTHORIZED_APPROVER_ID,
      authorizingDecisionId: decisionId,
      authorizingDispositionSequence: 1,
    }) as Promise<FoundationResult>;

    const seq2 = dispositionRequest(2);
    const failedIssue = await attest(seq2);
    expect(failedIssue).toMatchObject({ outcome: "OK" });
    const beforeFailure = exportFoundation(db, PROJECT_ID);
    db.exec(`CREATE TEMP TRIGGER fail_in_flight_receipt
      BEFORE INSERT ON mutation_receipts
      WHEN NEW.operation_class = 'decision_disposition' AND NEW.idempotency_key = '${seq2.idempotencyKey}'
      BEGIN SELECT RAISE(ABORT, 'injected in-flight constraint'); END`);
    try {
      const failed = await host.harness.callRpc("apply", {
        ...seq2,
        actorReceiptId: failedIssue.actorReceiptId,
        operatorReceiptId: failedIssue.operatorReceipt!.receiptId,
      }) as FoundationResult;
      expect(failed.outcome).toBe("CANONICAL_STORE_UNAVAILABLE");
    } finally {
      db.exec("DROP TRIGGER fail_in_flight_receipt");
    }
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeFailure);
    expect(db.prepare("SELECT MAX(disposition_sequence) AS sequence FROM decision_dispositions WHERE decision_id = ?").get(decisionId)).toEqual({ sequence: 1 });
    expect(db.prepare("SELECT authorizing_disposition_sequence, status FROM authorized_approvers WHERE authorizing_decision_id = ? ORDER BY authorizing_disposition_sequence").all(decisionId)).toEqual([
      { authorizing_disposition_sequence: 1, status: "active" },
    ]);
    expect(db.prepare("SELECT consumed_at_ms FROM operator_receipts WHERE receipt_id = ?").get(failedIssue.operatorReceipt!.receiptId)).toEqual({ consumed_at_ms: null });

    const staleSeq3 = dispositionRequest(3);
    const staleIssue = await attest(staleSeq3);
    expect(staleIssue).toMatchObject({ outcome: "OK" });
    const retryIssue = await attest(seq2);
    expect(retryIssue).toMatchObject({ outcome: "OK" });
    const beforeSuccessEvents = (db.prepare("SELECT COUNT(*) AS count FROM state_events").get() as { count: number }).count;
    const beforeSuccessMutations = (db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts").get() as { count: number }).count;
    const applied = await host.harness.callRpc("apply", {
      ...seq2,
      actorReceiptId: retryIssue.actorReceiptId,
      operatorReceiptId: retryIssue.operatorReceipt!.receiptId,
    }) as FoundationResult;
    expect(applied).toMatchObject({ outcome: "OK", eventSequence: beforeSuccessEvents + 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM state_events").get()).toEqual({ count: beforeSuccessEvents + 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts").get()).toEqual({ count: beforeSuccessMutations + 1 });
    expect(db.prepare("SELECT disposition_sequence, disposition, idempotency_key FROM decision_dispositions WHERE decision_id = ? ORDER BY disposition_sequence").all(decisionId)).toEqual([
      { disposition_sequence: 1, disposition: "adopted", idempotency_key: `${decisionId}-seq1` },
      { disposition_sequence: 2, disposition: "adopted", idempotency_key: `${decisionId}-seq2` },
    ]);
    expect(db.prepare("SELECT authorizing_disposition_sequence, status FROM authorized_approvers WHERE authorizing_decision_id = ? ORDER BY authorizing_disposition_sequence").all(decisionId)).toEqual([
      { authorizing_disposition_sequence: 1, status: "revoked" },
      { authorizing_disposition_sequence: 2, status: "active" },
    ]);
    expect(db.prepare("SELECT consumed_at_ms FROM operator_receipts WHERE receipt_id = ?").get(retryIssue.operatorReceipt!.receiptId)).toMatchObject({ consumed_at_ms: expect.any(Number) });

    const beforeReplay = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", {
      ...seq2,
      actorReceiptId: retryIssue.actorReceiptId,
      operatorReceiptId: retryIssue.operatorReceipt!.receiptId,
    })).toEqual(applied);
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeReplay);

    const beforeSecondReceipt = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", {
      ...seq2,
      actorReceiptId: failedIssue.actorReceiptId,
      operatorReceiptId: failedIssue.operatorReceipt!.receiptId,
    })).toMatchObject({ outcome: "OPERATOR_RECEIPT_STALE" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeSecondReceipt);
    expect(db.prepare("SELECT consumed_at_ms FROM operator_receipts WHERE receipt_id = ?").get(failedIssue.operatorReceipt!.receiptId)).toEqual({ consumed_at_ms: null });

    const beforeStale = exportFoundation(db, PROJECT_ID);
    const staleResult = await host.harness.callRpc("apply", {
      ...staleSeq3,
      actorReceiptId: staleIssue.actorReceiptId,
      operatorReceiptId: staleIssue.operatorReceipt!.receiptId,
    }) as FoundationResult;
    expect(staleResult.outcome).toBe("AUTHORIZED_APPROVER_REVOKED");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeStale);
    expect(db.prepare("SELECT consumed_at_ms FROM operator_receipts WHERE receipt_id = ?").get(staleIssue.operatorReceipt!.receiptId)).toEqual({ consumed_at_ms: null });

    const crossDecision = { ...seq2, decisionId: "different-operator-decision", idempotencyKey: "cross-decision" };
    const beforeCrossDecision = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", {
      ...crossDecision,
      actorReceiptId: staleIssue.actorReceiptId,
      operatorReceiptId: staleIssue.operatorReceipt!.receiptId,
    })).toMatchObject({ outcome: "OPERATOR_RECEIPT_STALE" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeCrossDecision);
  });

  it("replays a v7 mutation receipt after the v8 ALTER with the base normalized digest", () => {
    const db = new Database(":memory:");
    databaseIsReady(db);
    try {
      for (const statement of MIGRATIONS.slice(0, -3)) db.exec(statement);
      const request = bootstrapRequest();
      const baseV7Digest = "1a9530eb42af63727dd3001bd7990edf147242a525da64578e5d240c75e80027";
      const committed = { outcome: "OK", subject: PROJECT_ID, expected: 1, attempted: 1, verified: 1 };
      seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      db.prepare(
        `INSERT INTO state_events
          (project_id, event_sequence, aggregate_type, aggregate_id, aggregate_revision,
           event_type, actor_receipt_id, idempotency_key, event_json, created_at_ms)
         VALUES (?, 1, 'project', ?, 1, 'bootstrapped', ?, ?, ?, 1)`,
      ).run(PROJECT_ID, PROJECT_ID, RECEIPT_ID, request.idempotencyKey, canonicalJson({ fixture: true }));
      db.prepare(
        `INSERT INTO mutation_receipts
          (project_id, idempotency_key, operation_class, request_digest,
           outcome_json, committed_event_sequence, created_at_ms)
         VALUES (?, ?, ?, ?, ?, 1, 1)`,
      ).run(PROJECT_ID, request.idempotencyKey, request.operationClass, baseV7Digest, canonicalJson(committed));
      db.exec(MIGRATIONS.at(-3)!);
      db.exec(MIGRATIONS.at(-2)!);
      db.exec(MIGRATIONS.at(-1)!);

      expect(operatorRequestDigest(request)).toBe(baseV7Digest);
      expect(operatorRequestDigest({ ...request, expectedConfigRevision: undefined })).toBe(
        operatorRequestDigest({ ...request, expectedConfigRevision: null }),
      );
      const before = db.prepare("SELECT COUNT(*) AS count FROM state_events").get();
      expect(applyFixtureMutation(db, request)).toEqual(committed);
      expect(db.prepare("SELECT COUNT(*) AS count FROM state_events").get()).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("uses one authorization digest for the amended approver disposition with live guards", async () => {
    const reason = {
      approverId: "orchestrator:bb-collab",
      authorityBootstrapMaintenanceActs: ["approver_re_adoption", "authorized_approver_registry_maintenance", "approver_scope_updates"],
      operationalMutationClasses: ["bootstrap", "decision_create", "decision_disposition", "migration_prepare", "migration_step"],
      crownJewelHumanGate: "operator console approval remains required for authorizing, revoking, or changing this approver and its scope; no derived actor or standing approval bypasses that gate",
      purpose: "operator-authorized standing operational approval",
      retirementCondition: "host-issued receipt get-bb/bb#1541",
    };
    const guarded = {
      projectId: "proj_a8zzfsx36j",
      operationClass: "decision_disposition" as const,
      candidateHead: "892cc01cea251f9943f0cfa963013b5f286bafa4",
      idempotencyKey: "v8-authorized-approver-readopt-892cc01-amended-scope-v2",
      actorReceiptId: null,
      operatorReceiptId: null,
      expectedConfigRevision: 1,
      configRevision: null,
      expectedGovernanceEpoch: 4,
      expectedFenceToken: "0bbaf55e88b7e3908923760d88fa05445722e5395c0e9284",
      repoTargetId: null,
      expectedResourceRevision: 2,
      decisionId: "decision-bb-collab-authorized-approver",
      disposition: "adopted" as const,
      reason,
    };
    const omitted = { ...guarded, expectedConfigRevision: undefined, expectedGovernanceEpoch: undefined, expectedFenceToken: undefined };
    const explicitNull = { ...omitted, expectedConfigRevision: null, expectedGovernanceEpoch: null, expectedFenceToken: null };
    expect(operatorAuthorizationDigestProjection(guarded)).toMatchObject({ expectedConfigRevision: null, expectedGovernanceEpoch: null, expectedFenceToken: null });
    expect(operatorRequestDigest(guarded)).toBe(operatorRequestDigest(omitted));
    expect(operatorRequestDigest(omitted)).toBe(operatorRequestDigest(explicitNull));
    const rebased = { ...guarded, candidateHead: "a92cc01cea251f9943f0cfa963013b5f286bafa4" };
    expect(operatorRequestDigest(rebased)).toBe(operatorRequestDigest(guarded));
    const receiptBinding = (input: typeof guarded) => ({
      projectId: input.projectId,
      mutationClass: input.operationClass,
      candidateHead: input.candidateHead,
      idempotencyKey: input.idempotencyKey,
      requestDigest: operatorRequestDigest(input),
    });
    expect(Object.keys(receiptBinding(guarded)).filter((key) =>
      receiptBinding(guarded)[key as keyof ReturnType<typeof receiptBinding>] !== receiptBinding(rebased)[key as keyof ReturnType<typeof receiptBinding>],
    )).toEqual(["candidateHead"]);
    expect(operatorReceiptBindingDigest(receiptBinding(rebased))).not.toBe(operatorReceiptBindingDigest(receiptBinding(guarded)));
    expect(operatorRequestDigest(guarded)).toBe("72431ae86639a111e0692ae2c0a8f5d4b638784f7a4d1d980791112d9ffa9ff2");
    expect(operatorRequestDigest({ ...guarded, reason: { ...reason, purpose: "different" } })).not.toBe(operatorRequestDigest(guarded));

    const host = await loadedHost(guarded.projectId);
    const { db } = seedAndBootstrap(host, guarded.projectId);
    db.prepare(
      `INSERT INTO project_governorships
        (project_id, governance_epoch, runtime_id, state, fence_token, actor_receipt_id, predecessor_epoch, created_at_ms)
       VALUES (?, 4, 'bb-collab', 'target_active', ?, ?, 1, 1)`,
    ).run(guarded.projectId, guarded.expectedFenceToken, RECEIPT_ID);
    db.prepare("UPDATE project_governorship_heads SET governance_epoch = 4, fence_token = ? WHERE project_id = ?").run(guarded.expectedFenceToken, guarded.projectId);
    seedFixtureDecision(db, {
      projectId: guarded.projectId,
      decisionId: guarded.decisionId,
      repoTargetId: null,
      decisionClass: "operator_only",
      options: { approverId: "orchestrator:bb-collab" },
      resourceRevision: 2,
    });
    const issued = persistBootstrapOperatorReceipt(db, {
      projectId: guarded.projectId,
      mutationClass: guarded.operationClass,
      candidateHead: guarded.candidateHead,
      idempotencyKey: guarded.idempotencyKey,
      requestDigest: operatorRequestDigest(guarded),
      callerThreadId: "fixture-approver-thread",
      requestedFromBackground: false,
      callerPluginId: PLUGIN_ID,
    }, 1);
    const applied = applyAuthorizedMutation(db, {
      ...guarded,
      actorReceiptId: issued.actorReceiptId,
      operatorReceiptId: issued.operatorReceipt.receiptId,
    });
    expect(applied).toMatchObject({ outcome: "OK", mutationReceipt: { requestDigest: "72431ae86639a111e0692ae2c0a8f5d4b638784f7a4d1d980791112d9ffa9ff2" } });
    expect(db.prepare("SELECT consumed_at_ms FROM operator_receipts WHERE receipt_id = ?").get(issued.operatorReceipt.receiptId)).toMatchObject({ consumed_at_ms: expect.any(Number) });
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
      issuanceProvenance: "console",
    }, 1);
    const before = exportFoundation(db, PROJECT_ID);
    const adapter = new DeterministicNativeAssignmentAdapter();
    expect(applyAuthorizedMutation(db, { ...request, operatorReceiptId: receipt.receiptId }, null, null, adapter)).toMatchObject({ outcome: "OPERATOR_RECEIPT_TWO_PHASE_UNSUPPORTED" });
    expect(adapter.dispatchCalls).toHaveLength(0);
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("refuses receipt-bound assignment reconcile before a non-null adapter call", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    const { fenceToken } = seedAssignmentDatabase(db);
    const prepAdapter = new DeterministicNativeAssignmentAdapter();
    const prepared = applyFixtureMutation(db, assignmentPrepareRequest(fenceToken), null, null, prepAdapter);
    const executionAttemptId = (prepared.evidence as { executionAttemptId: string }).executionAttemptId;
    const dispatchAdapter = new DeterministicNativeAssignmentAdapter();
    dispatchAdapter.nextEvidence = { disposition: "ambiguous", reasonCode: "request_outcome_unknown" };
    expect(applyFixtureMutation(db, assignmentPhaseRequest(fenceToken, "assignment_dispatch", "assignment-1", executionAttemptId), null, null, dispatchAdapter).outcome).toBe("DISPATCH_UNKNOWN");
    const request = { ...assignmentPhaseRequest(fenceToken, "assignment_reconcile", "assignment-1", executionAttemptId), candidateHead: CANDIDATE_SHA };
    const receipt = persistInterimOperatorReceipt(db, {
      projectId: PROJECT_ID,
      mutationClass: "assignment_reconcile",
      candidateHead: CANDIDATE_SHA,
      idempotencyKey: request.idempotencyKey,
      requestDigest: operatorRequestDigest(request),
      callerThreadId: "operator-thread",
      requestedFromBackground: false,
      callerPluginId: PLUGIN_ID,
      issuanceProvenance: "console",
    }, 1);
    const before = exportFoundation(db, PROJECT_ID);
    const reconcileAdapter = new DeterministicNativeAssignmentAdapter();
    expect(applyAuthorizedMutation(db, { ...request, operatorReceiptId: receipt.receiptId }, null, null, reconcileAdapter)).toMatchObject({ outcome: "OPERATOR_RECEIPT_TWO_PHASE_UNSUPPORTED" });
    expect(reconcileAdapter.reconcileCalls).toHaveLength(0);
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
      issuanceProvenance: "console",
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
      issuanceProvenance: "console",
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
      issuanceProvenance: "console",
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

  it("audits requested versus executed profiles from canonical assignment receipts", async () => {
    const fixture = await assignmentFixture();
    const prepared = applyWithFixtureReceipt(
      fixture.db,
      assignmentPrepareRequest(fixture.fenceToken),
      null,
      null,
      new DeterministicNativeAssignmentAdapter(),
    );
    expect(prepared.outcome).toBe("OK");
    const audit = await doctor(fixture.db, fixture.host.bb.sdk, PROJECT_ID);
    expect(audit).toMatchObject({
      outcome: "OK",
      evidence: {
        profileAudit: {
          status: "recorded",
          total: 1,
          compliant: 0,
          mismatch: 0,
          unknown: 1,
          entries: [{ status: "unknown", reason: "EXECUTION_PROFILE_UNKNOWN" }],
        },
      },
    });

    const mismatchFixture = await assignmentFixture();
    const mismatchAdapter = new DeterministicNativeAssignmentAdapter();
    const mismatchPrepared = applyWithFixtureReceipt(
      mismatchFixture.db,
      assignmentPrepareRequest(mismatchFixture.fenceToken),
      null,
      null,
      mismatchAdapter,
    );
    const executionAttemptId = (mismatchPrepared.evidence as { executionAttemptId: string }).executionAttemptId;
    mismatchAdapter.nextEvidence = { actualProfile: { ...ROLE_PROFILE, model: "fallback-model" } };
    expect(applyWithFixtureReceipt(
      mismatchFixture.db,
      assignmentPhaseRequest(mismatchFixture.fenceToken, "assignment_dispatch", "assignment-1", executionAttemptId),
      null,
      null,
      mismatchAdapter,
    ).outcome).toBe("EXECUTION_PROFILE_MISMATCH");
    const mismatchAudit = await doctor(mismatchFixture.db, mismatchFixture.host.bb.sdk, PROJECT_ID);
    expect(mismatchAudit).toMatchObject({ evidence: { profileAudit: { compliant: 0, mismatch: 1, unknown: 0 } } });

    const incompleteFixture = await assignmentFixture();
    const incompleteAdapter = new DeterministicNativeAssignmentAdapter();
    const incompletePrepared = applyWithFixtureReceipt(
      incompleteFixture.db,
      assignmentPrepareRequest(incompleteFixture.fenceToken),
      null,
      null,
      incompleteAdapter,
    );
    const incompleteAttemptId = (incompletePrepared.evidence as { executionAttemptId: string }).executionAttemptId;
    incompleteAdapter.nextEvidence = { contentEventId: undefined };
    expect(applyWithFixtureReceipt(
      incompleteFixture.db,
      assignmentPhaseRequest(incompleteFixture.fenceToken, "assignment_dispatch", "assignment-1", incompleteAttemptId),
      null,
      null,
      incompleteAdapter,
    ).outcome).toBe("DISPATCH_UNKNOWN");
    const incompleteAudit = await doctor(incompleteFixture.db, incompleteFixture.host.bb.sdk, PROJECT_ID);
    expect(incompleteAudit).toMatchObject({ evidence: { profileAudit: { compliant: 0, mismatch: 0, unknown: 1 } } });
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

  it("appends the v20 replay rollout contract and rolls every cached consumer forward", () => {
    expect(SCHEMA_VERSION).toBe(12);
    expect(CONTRACT_VERSION).toBe(20);
    expect(MIGRATIONS).toHaveLength(25);
    expect(sha256(MIGRATIONS.slice(0, -1).join("\n"))).toBe("5ee5cd12902e433825558c27b9a20d8bc2e86c5ffe018bf5b59e207d5d2d684e");
    expect(MIGRATIONS.at(-7)?.match(/CREATE UNIQUE INDEX/gu)).toHaveLength(2);
    expect(MIGRATIONS.at(-6)?.match(/CREATE TABLE/gu)).toHaveLength(1);
    expect(MIGRATIONS.at(-6)).toContain("operator_receipts");
    expect(MIGRATIONS.at(-5)).toContain("operator_receipt_id");
    expect(MIGRATIONS.at(-4)).toContain("retirement_condition");
    expect(MIGRATIONS.at(-3)).toContain("authorized_approvers");
    expect(MIGRATIONS.at(-2)).toContain("standby_profile_json");
    expect(MIGRATIONS.at(-1)).toContain("issuance_provenance");
    expect(TABLES).toContain("migration_runs");
    expect(MIGRATION_STATES).toEqual([
      "prepared", "frozen", "exported", "imported", "equivalent", "target_active", "exercised", "retired", "rolled_back", "fix_forward_required",
    ]);
    expect(MIGRATION_STEPS).toEqual([
      "record_inventory", "record_quiescence", "freeze", "record_export", "record_import", "record_equivalence", "activate", "record_exercise", "retire", "rollback", "mark_fix_forward_required",
    ]);
    expect(cachedConsumerRolloutEvidence(cachedConsumerObservations(11, 19))).toMatchObject({
      names: [...CACHED_CONSUMERS],
      oldSchemaVersion: 11,
      newSchemaVersion: 12,
      oldContractVersion: 19,
      newContractVersion: 20,
      action: "refused",
      expected: 4,
      attempted: 4,
      verified: 0,
    });
    expect(cachedConsumerRolloutEvidence(cachedConsumerObservations(12, 20))).toMatchObject({
      oldSchemaVersion: 11,
      newSchemaVersion: 12,
      oldContractVersion: 19,
      newContractVersion: 20,
      action: "reread",
      expected: 4,
      attempted: 4,
      verified: 4,
    });
    expect(cachedConsumerRolloutEvidence(cachedConsumerObservations(12, 19))).toMatchObject({
      names: [...CACHED_CONSUMERS],
      oldSchemaVersion: 11,
      newSchemaVersion: 12,
      oldContractVersion: 19,
      newContractVersion: 20,
      action: "refused",
      expected: 4,
      attempted: 4,
      verified: 0,
    });

    const { db, directory } = directDatabase();
    try {
      expect((db.prepare("PRAGMA table_info(migration_runs)").all() as Array<{ name: string }>).map((row) => row.name)).toEqual([
        "migration_id", "project_id", "source_system", "source_runtime_id", "target_runtime_id", "source_contract_digest", "source_schema_digest",
        "source_export_digest", "config_revision", "decision_id", "decision_disposition_sequence", "state", "resource_revision", "source_event_ceiling",
        "source_snapshot_digest", "source_governor_epoch", "target_governor_epoch", "mutator_inventory_digest", "quiescence_digest", "import_root_digest",
        "equivalence_digest", "recovery_digest", "retention_until_ms", "created_at_ms", "updated_at_ms",
      ]);
      expect((db.prepare("PRAGMA table_info(operator_receipts)").all() as Array<{ name: string }>).map((row) => row.name)).toEqual(expect.arrayContaining([
        "idempotency_key", "request_digest", "consumed_at_ms", "consumed_event_sequence", "issuance_provenance",
      ]));
      expect((db.prepare("PRAGMA table_info(state_events)").all() as Array<{ name: string }>).map((row) => row.name)).toContain("operator_receipt_id");
      expect((db.prepare("PRAGMA table_info(mutation_receipts)").all() as Array<{ name: string }>).map((row) => row.name)).toContain("operator_receipt_id");
      expect((db.prepare("PRAGMA table_info(actor_receipts)").all() as Array<{ name: string }>).map((row) => row.name)).toEqual(expect.arrayContaining(["operator_receipt_id", "retirement_condition"]));
      expect((db.prepare("PRAGMA index_list(migration_runs)").all() as Array<{ name: string; unique: number; partial: number }>).filter((row) => row.name.startsWith("migration_runs_"))).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "migration_runs_final_export_identity", unique: 1, partial: 1 }),
        expect.objectContaining({ name: "migration_runs_one_open", unique: 1, partial: 1 }),
      ]));
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("assembles the production v20 cached-consumer rollout receipt with stale-v19 refusal semantics", async () => {
    expect(CONTRACT_VERSION).toBe(20);
    expect(SCHEMA_VERSION).toBe(12);
    expect(MIGRATIONS).toHaveLength(25);
    expect(schemaDigest).toBe("eacc300f19723e0fd9dc0345509628569bd40b2d4c7740954bfc7e647aff9640");
    expect(contractDigest).toBe("25465d4e38bdfdf4a29d57efcd4d15def14fd77aa529a6fdf19ee4b3903d8407");
    const host = await loadedHost();
    const { db } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const beforeRefusal = exportFoundation(db, PROJECT_ID);
    const evidence = await assembleV20CachedConsumerRolloutEvidence({
      rpcContract: async () => doctorV20Reread("server.rpcContract", rpcContract.doctor.output.parse(
        await host.harness.callRpc("doctor", { projectId: PROJECT_ID }),
      ) as FoundationResult),
      collabCli: async () => doctorV20Reread("server.collabCli", JSON.parse(
        (await host.harness.runCli(["doctor", "--project", PROJECT_ID])).stdout,
      ) as FoundationResult),
      consumedLegacyReplay: async () => ({ ...policyProbeReread("src/foundation.consumedLegacyReplayProbe", { outcome: "OK" }, "OK"), consumedLegacyReplay: { outcome: "OK" } }),
      newLegacyApplyProvenance: async () => ({ ...policyProbeReread("src/foundation.newLegacyApplyProvenanceProbe", probeV20NewLegacyApplyProvenanceRefusal().newApplyRefusal, "OPERATOR_RECEIPT_INVALID"), newApplyRefusal: probeV20NewLegacyApplyProvenanceRefusal().newApplyRefusal }),
    });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeRefusal);
    expect(JSON.parse(evidence.durableRefJson)).toMatchObject({
      reread: { observations: CACHED_CONSUMERS.map((name) => ({ name, observedSchemaVersion: 12, observedContractVersion: 20 })), action: "reread", expected: 4, attempted: 4, verified: 4 },
      consumedLegacyReplay: { outcome: "OK" },
      newApplyGuard: { nullProvenance: { outcome: "OPERATOR_RECEIPT_INVALID" } },
    });
    expect(evidence).toMatchObject({
      evidenceId: "cached-consumer-v20-rollout-receipt",
      evidenceKind: "release",
      sourceKind: "release",
      sourceRef: "live-plugin:dist/server.js",
    });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeRefusal);
  });

  it("refuses v20 rollout evidence when one cached consumer did not execute", async () => {
    const { db, directory } = directDatabase();
    try {
      const rpcContractProbe = vi.fn(async () => ({ observedSchemaVersion: 11, observedContractVersion: 18 }));
      const collabCliProbe = vi.fn(async () => ({ observedSchemaVersion: 11, observedContractVersion: 18 }));
      const serverTestProbe = vi.fn(async () => ({ observedSchemaVersion: 11, observedContractVersion: 18 }));
      await expect(assembleV20CachedConsumerRolloutEvidence({
        rpcContract: rpcContractProbe,
        collabCli: collabCliProbe,
        newLegacyApplyProvenance: serverTestProbe,
      })).rejects.toThrow("all four consumers");
      expect(rpcContractProbe).not.toHaveBeenCalled();
      expect(collabCliProbe).not.toHaveBeenCalled();
      expect(serverTestProbe).not.toHaveBeenCalled();
      expect(db.prepare("SELECT COUNT(*) AS count FROM evidence_artifacts").get()).toEqual({ count: 0 });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the v20 rollout assembler in production rather than test support", () => {
    expect(typeof assembleV20CachedConsumerRolloutEvidence).toBe("function");
    expect(CACHED_CONSUMERS).toEqual([
      "server.rpcContract",
      "server.collabCli",
      "src/foundation.consumedLegacyReplayProbe",
      "src/foundation.newLegacyApplyProvenanceProbe",
    ]);
    expect(readFileSync(new URL("../src/test-support.ts", import.meta.url), "utf8")).not.toContain("assembleV20CachedConsumerRolloutEvidence");
    const serverSource = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    expect(serverSource).toContain("bb.sdk.plugins.callRpc({");
    expect(serverSource).toContain('runCli(db, bb, ["doctor", "--project", request.projectId], cliContext, cliDeps)');
    expect(serverSource).not.toContain("src/test-support");
    expect(serverSource).not.toContain("tests/server.test");
  });

  it("runs distinct production replay and new-apply probes against the configured project without writing", async () => {
    const host = await loadedHost();
    const { db } = seedAndBootstrap(host, PROJECT_ID, { config: directorSeatConfig() });
    const before = exportFoundation(db, PROJECT_ID);
    expect(() => probeV20ConsumedLegacyReplay(db, PROJECT_ID)).toThrow("requires an observed consumed legacy receipt");
    expect(probeV20NewLegacyApplyProvenanceRefusal()).toMatchObject({
      observedSchemaVersion: 12,
      observedContractVersion: 20,
      newApplyRefusal: { outcome: "OPERATOR_RECEIPT_INVALID" },
    });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("refuses test, fixture, and source provenance before a non-live cached-consumer rollout can mutate", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: directorSeatConfig() });
    const actorReceiptId = "cached-consumer-rollout-source-actor";
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: actorReceiptId, actorKind: "operator" });
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken, "cached-consumer-v20-rollout-decision", {
      actorReceiptId,
    }))).toMatchObject({ outcome: "OK" });
    const before = exportFoundation(db, PROJECT_ID);
    for (const sourceRef of ["test:cached-consumer-v20-rollout-receipt", "fixture:cached-consumer-v20-rollout-receipt", "source:server.ts"]) {
      expect(await host.harness.callRpc("cachedConsumerRollout", decisionDispositionRequest(fenceToken, "cached-consumer-v20-rollout-decision", 1, {
        actorReceiptId,
        decisionEvidence: [decisionArtifact("cached-consumer-v20-rollout-receipt", {
          evidenceKind: "test",
          sourceKind: "test",
          sourceRef,
          relationKind: "supporting",
        })],
      }))).toMatchObject({
        outcome: "INVALID_INPUT",
        attempted: 0,
        verified: 0,
        message: "cached-consumer rollout requires the running dist/server.js plugin artifact",
      });
    }
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("refuses a running dist rollout without an observed consumed legacy replay", async () => {
    const host = await loadedDistHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: directorSeatConfig() });
    const actorReceiptId = "cached-consumer-rollout-dist-refusal-actor";
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: actorReceiptId, actorKind: "operator" });
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken, "cached-consumer-v20-rollout-dist-refusal", {
      actorReceiptId,
    }))).toMatchObject({ outcome: "OK" });
    const before = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("cachedConsumerRollout", decisionDispositionRequest(fenceToken, "cached-consumer-v20-rollout-dist-refusal", 1, {
        actorReceiptId,
      }))).toMatchObject({
        outcome: "INVALID_INPUT",
        attempted: 0,
        verified: 0,
        message: "cached-consumer v20 replay proof requires an observed consumed legacy receipt",
      });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("does not synthesize governed cached-consumer rollout success through the running dist seams", async () => {
    const host = await loadedDistHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: directorSeatConfig() });
    const actorReceiptId = "cached-consumer-rollout-dist-actor";
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: actorReceiptId, actorKind: "operator" });
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken, "cached-consumer-v20-rollout-dist", {
      actorReceiptId,
    }))).toMatchObject({ outcome: "OK" });
    const unsigned = {
      ...decisionDispositionRequest(fenceToken, "cached-consumer-v20-rollout-dist", 1, {
        actorReceiptId,
      }),
      candidateHead: CANDIDATE_SHA,
      operatorReceiptId: null,
    };
    const receipt = persistInterimOperatorReceipt(db, {
      projectId: PROJECT_ID,
      mutationClass: unsigned.operationClass,
      candidateHead: CANDIDATE_SHA,
      idempotencyKey: unsigned.idempotencyKey,
      requestDigest: operatorRequestDigest(unsigned),
      callerThreadId: "cached-consumer-rollout-dist-thread",
      requestedFromBackground: false,
      callerPluginId: PLUGIN_ID,
      issuanceProvenance: "console",
    });
    const before = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("cachedConsumerRollout", { ...unsigned, operatorReceiptId: receipt.receiptId })).toMatchObject({
      outcome: "INVALID_INPUT",
      attempted: 0,
      verified: 0,
      message: "cached-consumer v20 replay proof requires an observed consumed legacy receipt",
    });
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toContainEqual([
      expect.objectContaining({ pluginId: PLUGIN_ID, method: "doctor", input: { projectId: PROJECT_ID } }),
    ]);
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("treats a persisted v19 rollout receipt as unknown without migrating or requiring it", async () => {
    const host = await loadedHost();
    const { db } = seedAndBootstrap(host, PROJECT_ID, { config: directorSeatConfig() });
    seedEvidenceArtifact(db, "cached-consumer-v19-rollout-receipt");
    expect(await host.harness.callRpc("doctor", { projectId: PROJECT_ID })).toMatchObject({
      outcome: "OK",
      evidence: {
        cachedConsumers: {
          oldContractVersion: 19,
          newContractVersion: 20,
          action: "unknown",
          expected: 4,
          attempted: 0,
          verified: 0,
        },
      },
    });
  });

  it("refuses cached-consumer rollout evidence on the generic apply route", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: directorSeatConfig() });
    const actorReceiptId = "cached-consumer-rollout-generic-actor";
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: actorReceiptId, actorKind: "operator" });
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken, "cached-consumer-v20-rollout-generic", {
      actorReceiptId,
    }))).toMatchObject({ outcome: "OK" });
    const before = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", decisionDispositionRequest(fenceToken, "cached-consumer-v20-rollout-generic", 1, {
      actorReceiptId,
      decisionEvidence: [decisionArtifact("cached-consumer-v20-rollout-receipt", {
        evidenceKind: "release",
        sourceKind: "release",
        sourceRef: "live-plugin:dist/server.js",
        relationKind: "supporting",
      })],
    }))).toMatchObject({
      outcome: "INVALID_INPUT",
      attempted: 0,
      verified: 0,
      message: "cached-consumer rollout evidence is accepted only through the live rollout caller",
    });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
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
    expect(firstExport.manifest).toMatchObject({ schemaVersion: 12, schemaDigest, contractVersion: 20, contractDigest });
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

  it("records evidence-only source history with exact canonical zero-work", () => {
    const { db, directory } = directDatabase();
    try {
      freezeMigration(db);
      const beforeCanonicalRows = nonMigrationRows(db);
      const manifest = sourceEvidenceManifest();
      const maximal = maximalSourceEvidenceManifest();
      expect(Buffer.byteLength(canonicalJson(maximal), "utf8")).toBeGreaterThan(MAX_SOURCE_EVIDENCE_MANIFEST_BYTES);
      const beforeMaximal = exportFoundation(db, PROJECT_ID);
      const maximalRequest = migrationStepRequest(db, "record_export", {
        sourceSnapshotDigest: SOURCE_SNAPSHOT_DIGEST,
        sourceEvidenceManifest: maximal,
      }, { idempotencyKey: "evidence-maximal-manifest" });
      const maximalResult = applyWithFixtureReceipt(db, maximalRequest);
      expect(maximalResult).toMatchObject({ outcome: "EXPORT_BOUNDED" });
      expect(db.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = ?").get(maximalRequest.idempotencyKey)).toBeUndefined();
      expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeMaximal);
      expect(Buffer.byteLength(beforeMaximal.export!.recordsNdjson, "utf8") + Buffer.byteLength(canonicalJson(beforeMaximal.export!.artifactIndex), "utf8")).toBeLessThanOrEqual(MAX_EXPORT_BYTES);

      const exported = applyWithFixtureReceipt(db, migrationStepRequest(db, "record_export", {
        sourceSnapshotDigest: SOURCE_SNAPSHOT_DIGEST,
        sourceEvidenceManifest: manifest,
      }));
      expect(exported).toMatchObject({ outcome: "OK", currentResourceRevision: 5, evidence: {
        sourceExportKind: "non_canonical_source_evidence",
        sourceExportDigest: manifest.manifestDigest,
      } });
      expect(exported.evidence).not.toHaveProperty("sourceEvidenceManifest");
      expect(db.prepare("SELECT event_json FROM state_events WHERE aggregate_type = 'migration_run' ORDER BY event_sequence DESC LIMIT 1").get()).toMatchObject({
        event_json: expect.not.stringContaining("sourceEvidenceManifest"),
      });
      expect(db.prepare("SELECT outcome_json FROM mutation_receipts WHERE idempotency_key = ?").get(exported.mutationReceipt!.idempotencyKey)).toMatchObject({
        outcome_json: expect.not.stringContaining("sourceEvidenceManifest"),
      });
      expect(db.prepare("SELECT source_event_ceiling, source_export_digest FROM migration_runs").get()).toEqual({
        source_event_ceiling: null,
        source_export_digest: manifest.manifestDigest,
      });

      const beforeStray = exportFoundation(db, PROJECT_ID);
      const strayExportFields = migrationStepRequest(db, "record_export", {
        sourceSnapshotDigest: SOURCE_SNAPSHOT_DIGEST,
        sourceEvidenceManifest: manifest,
        canonicalImport: { expected: 0, attempted: 0, verified: 0 },
        importRootDigest: sha256("stray-import"),
        equivalenceDigest: sha256("stray-equivalence"),
        equivalenceDisposition: EVIDENCE_ONLY_EQUIVALENCE_DISPOSITION,
      }, { idempotencyKey: "evidence-stray-export-fields" });
      expect(applyWithFixtureReceipt(db, strayExportFields).outcome).toBe("INVALID_INPUT");
      expect(db.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = ?").get(strayExportFields.idempotencyKey)).toBeUndefined();
      expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeStray);

      const targetExport = fixtureExport(db);
      const beforeMixed = exportFoundation(db, PROJECT_ID);
      expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "record_import", {
        sourceEvidenceManifest: manifest,
        export: targetExport,
        canonicalImport: { expected: 0, attempted: 0, verified: 0 },
        importRootDigest: sha256("mixed-target-export"),
      }, { idempotencyKey: "evidence-mixed-target-export" })).outcome).toBe("IMPORT_EQUIVALENCE_FAILED");
      expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeMixed);

      const nonzero = migrationStepRequest(db, "record_import", {
        sourceEvidenceManifest: manifest,
        canonicalImport: { expected: 1, attempted: 1, verified: 1 },
        importRootDigest: sha256("nonzero"),
      }, { idempotencyKey: "evidence-nonzero-import" });
      expect(applyWithFixtureReceipt(db, nonzero)).toMatchObject({ outcome: "IMPORT_EQUIVALENCE_FAILED", expected: 1, attempted: 1, verified: 1 });
      expect(db.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = ?").get(nonzero.idempotencyKey)).toBeUndefined();

      const canonicalImport = { expected: 0 as const, attempted: 0 as const, verified: 0 as const };
      const importRootDigest = sha256(canonicalJson({
        sourceExportDigest: manifest.manifestDigest,
        targetRuntimeId: PLUGIN_ID,
        configRevision: 1,
        repositoryTargetsDigest: repositoryTargetsDigest(db),
        canonicalImport,
      }));
      const importedRequest = migrationStepRequest(db, "record_import", {
        sourceEvidenceManifest: manifest,
        canonicalImport,
        importRootDigest,
        proofDigest: importRootDigest,
      });
      const imported = applyWithFixtureReceipt(db, importedRequest);
      expect(imported).toMatchObject({ outcome: "OK", expected: 0, attempted: 0, verified: 0, currentResourceRevision: 6 });
      expect(applyWithFixtureReceipt(db, importedRequest)).toEqual(imported);

      const equivalenceDigest = sha256(canonicalJson({
        sourceExportDigest: manifest.manifestDigest,
        importRootDigest,
        sourceSnapshotDigest: SOURCE_SNAPSHOT_DIGEST,
        repositoryTargetsDigest: repositoryTargetsDigest(db),
        canonicalImport,
        equivalenceDisposition: EVIDENCE_ONLY_EQUIVALENCE_DISPOSITION,
      }));
      const equivalent = applyWithFixtureReceipt(db, migrationStepRequest(db, "record_equivalence", {
        sourceEvidenceManifest: manifest,
        canonicalImport,
        equivalenceDigest,
        proofDigest: equivalenceDigest,
        equivalenceDisposition: EVIDENCE_ONLY_EQUIVALENCE_DISPOSITION,
      }));
      expect(equivalent).toMatchObject({
        outcome: "OK", expected: 0, attempted: 0, verified: 0, currentResourceRevision: 7,
        evidence: { sourceExportKind: "non_canonical_source_evidence", canonicalImport, equivalenceDisposition: EVIDENCE_ONLY_EQUIVALENCE_DISPOSITION },
      });
      expect(nonMigrationRows(db)).toEqual(beforeCanonicalRows);
      expect(db.prepare("SELECT state, resource_revision FROM migration_runs").get()).toEqual({ state: "equivalent", resource_revision: 7 });
      expect(db.prepare("SELECT event_json FROM state_events WHERE aggregate_type = 'migration_run' ORDER BY event_sequence DESC LIMIT 1").get()).toMatchObject({
        event_json: expect.stringContaining(EVIDENCE_ONLY_EQUIVALENCE_DISPOSITION),
      });
      for (const step of ["activate", "record_exercise", "retire"] as const) {
        const beforeBlocked = exportFoundation(db, PROJECT_ID);
        const blockedRequest = migrationStepRequest(db, step, {}, { idempotencyKey: `evidence-${step}-blocked` });
        expect(applyWithFixtureReceipt(db, blockedRequest)).toMatchObject({ outcome: "IMPORT_EQUIVALENCE_FAILED" });
        expect(db.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = ?").get(blockedRequest.idempotencyKey)).toBeUndefined();
        expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeBlocked);
      }

      const recoveryDigest = sha256("evidence-only-release");
      const releaseInput = (overrides: Partial<ApplyRequest> = {}) => migrationStepRequest(db, "rollback", {
        proofDigest: recoveryDigest,
        recoveryDigest,
      }, overrides);
      const beforeInvalidRelease = exportFoundation(db, PROJECT_ID);
      expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "rollback", { proofDigest: sha256("missing-recovery") }, {
        idempotencyKey: "evidence-release-missing-recovery",
      })).outcome).toBe("INVALID_INPUT");
      expect(applyWithFixtureReceipt(db, releaseInput({ idempotencyKey: "evidence-release-wrong-runtime", runtimeId: "wrong-runtime" })).outcome).toBe("IMPORT_EQUIVALENCE_FAILED");
      expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeInvalidRelease);

      const crossBinding = releaseInput({ idempotencyKey: "evidence-release-cross-binding", candidateHead: CANDIDATE_SHA });
      const foreignReceipt = persistInterimOperatorReceipt(db, {
        projectId: FOREIGN_PROJECT_ID,
        mutationClass: "migration_step",
        candidateHead: CANDIDATE_SHA,
        idempotencyKey: crossBinding.idempotencyKey,
        requestDigest: operatorRequestDigest({ ...crossBinding, operatorReceiptId: null }),
        callerThreadId: "foreign-thread",
        requestedFromBackground: false,
        callerPluginId: PLUGIN_ID,
        issuanceProvenance: "console",
      }, 1);
      expect(applyAuthorizedMutation(db, { ...crossBinding, operatorReceiptId: foreignReceipt.receiptId })).toMatchObject({ outcome: "OPERATOR_RECEIPT_FOREIGN" });
      expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeInvalidRelease);

      const unsignedRelease = releaseInput({ idempotencyKey: "evidence-release-authorized", candidateHead: null, operatorReceiptId: null });
      const receipt = persistInterimOperatorReceipt(db, {
        projectId: PROJECT_ID,
        mutationClass: "migration_step",
        candidateHead: CANDIDATE_SHA,
        idempotencyKey: unsignedRelease.idempotencyKey,
        requestDigest: operatorRequestDigest(unsignedRelease),
        callerThreadId: "release-thread",
        requestedFromBackground: false,
        callerPluginId: PLUGIN_ID,
        issuanceProvenance: "console",
      }, 2);
      const authorizedRelease = { ...unsignedRelease, candidateHead: CANDIDATE_SHA, operatorReceiptId: receipt.receiptId };
      const released = applyAuthorizedMutation(db, authorizedRelease);
      expect(released).toMatchObject({
        outcome: "OK",
        currentGovernanceEpoch: 4,
        currentResourceRevision: 8,
        evidence: {
          state: "rolled_back",
          sourceExportKind: "non_canonical_source_evidence",
          governorRelease: { runtimeId: PLUGIN_ID, disposition: "evidence_only_equivalent_rollback" },
        },
        mutationReceipt: { operationClass: "migration_step", operatorReceiptId: receipt.receiptId },
      });
      expect(db.prepare("SELECT project_governorship_heads.state, project_governorships.runtime_id FROM project_governorship_heads JOIN project_governorships USING (project_id, governance_epoch) WHERE project_governorship_heads.project_id = ?").get(PROJECT_ID)).toEqual({ state: "target_active", runtime_id: PLUGIN_ID });
      expect(db.prepare("SELECT operator_receipt_id, idempotency_key, event_json FROM state_events WHERE project_id = ? ORDER BY event_sequence DESC LIMIT 1").get(PROJECT_ID)).toMatchObject({
        operator_receipt_id: receipt.receiptId,
        idempotency_key: authorizedRelease.idempotencyKey,
        event_json: expect.stringContaining("evidence_only_equivalent_rollback"),
      });
      expect(db.prepare("SELECT operator_receipt_id, committed_event_sequence FROM mutation_receipts WHERE project_id = ? AND idempotency_key = ?").get(PROJECT_ID, authorizedRelease.idempotencyKey)).toEqual({
        operator_receipt_id: receipt.receiptId,
        committed_event_sequence: released.eventSequence,
      });
      expect(db.prepare("SELECT consumed_event_sequence FROM operator_receipts WHERE receipt_id = ?").get(receipt.receiptId)).toEqual({ consumed_event_sequence: released.eventSequence });
      expect(db.prepare("SELECT state, recovery_digest FROM migration_runs WHERE project_id = ?").get(PROJECT_ID)).toEqual({ state: "rolled_back", recovery_digest: recoveryDigest });

      const afterRelease = exportFoundation(db, PROJECT_ID);
      expect(applyAuthorizedMutation(db, authorizedRelease)).toEqual(released);
      expect(exportFoundation(db, PROJECT_ID)).toEqual(afterRelease);
      const secondReceipt = persistInterimOperatorReceipt(db, {
        projectId: PROJECT_ID,
        mutationClass: "migration_step",
        candidateHead: CANDIDATE_SHA,
        idempotencyKey: authorizedRelease.idempotencyKey,
        requestDigest: operatorRequestDigest(unsignedRelease),
        callerThreadId: "release-thread-second",
        requestedFromBackground: false,
        callerPluginId: PLUGIN_ID,
        issuanceProvenance: "console",
      }, 3);
      expect(applyAuthorizedMutation(db, { ...authorizedRelease, operatorReceiptId: secondReceipt.receiptId })).toMatchObject({ outcome: "OPERATOR_RECEIPT_STALE" });
      expect(db.prepare("SELECT consumed_at_ms FROM operator_receipts WHERE receipt_id = ?").get(secondReceipt.receiptId)).toEqual({ consumed_at_ms: null });
      const beforeWrongState = exportFoundation(db, PROJECT_ID);
      expect(applyWithFixtureReceipt(db, releaseInput({ idempotencyKey: "evidence-release-wrong-state" })).outcome).toBe("INVALID_INPUT");
      expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeWrongState);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps evidence-only exported rollback on the pre-target source_active path", () => {
    const { db, directory } = directDatabase();
    try {
      freezeMigration(db);
      const manifest = sourceEvidenceManifest();
      expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "record_export", {
        sourceSnapshotDigest: SOURCE_SNAPSHOT_DIGEST,
        sourceEvidenceManifest: manifest,
      }))).toMatchObject({ outcome: "OK", currentResourceRevision: 5, evidence: { state: "exported" } });

      const recoveryDigest = sha256("evidence-exported-rollback");
      const rollbackRequest = migrationStepRequest(db, "rollback", { proofDigest: recoveryDigest, recoveryDigest }, {
        idempotencyKey: "evidence-exported-rollback",
      });
      const eventsBefore = (db.prepare("SELECT COUNT(*) AS count FROM state_events WHERE project_id = ?").get(PROJECT_ID) as { count: number }).count;
      const mutationsBefore = (db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE project_id = ?").get(PROJECT_ID) as { count: number }).count;
      const rollback = applyWithFixtureReceipt(db, rollbackRequest);
      expect(rollback).toMatchObject({
        outcome: "OK",
        currentGovernanceEpoch: 4,
        currentResourceRevision: 6,
        evidence: { state: "rolled_back" },
        mutationReceipt: {
          idempotencyKey: rollbackRequest.idempotencyKey,
          operationClass: "migration_step",
          operatorReceiptId: null,
        },
      });
      expect(rollback.evidence).not.toHaveProperty("governorRelease");
      expect(currentGovernor(db)).toMatchObject({ governance_epoch: 4, state: "source_active" });
      expect(db.prepare(
        `SELECT project_governorships.runtime_id, project_governorships.state
         FROM project_governorships JOIN project_governorship_heads USING (project_id, governance_epoch)
         WHERE project_governorship_heads.project_id = ?`,
      ).get(PROJECT_ID)).toEqual({ runtime_id: "llm-collab-runtime", state: "source_active" });
      expect(db.prepare("SELECT state, source_governor_epoch, target_governor_epoch, recovery_digest FROM migration_runs WHERE project_id = ?").get(PROJECT_ID)).toEqual({
        state: "rolled_back",
        source_governor_epoch: 4,
        target_governor_epoch: 1,
        recovery_digest: recoveryDigest,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM state_events WHERE project_id = ?").get(PROJECT_ID)).toEqual({ count: eventsBefore + 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE project_id = ?").get(PROJECT_ID)).toEqual({ count: mutationsBefore + 1 });
      const event = db.prepare(
        "SELECT event_sequence, actor_receipt_id, operator_receipt_id, idempotency_key, event_json FROM state_events WHERE project_id = ? ORDER BY event_sequence DESC LIMIT 1",
      ).get(PROJECT_ID) as { event_sequence: number; actor_receipt_id: string; operator_receipt_id: string | null; idempotency_key: string; event_json: string };
      expect(event).toMatchObject({
        event_sequence: rollback.eventSequence,
        actor_receipt_id: RECEIPT_ID,
        operator_receipt_id: null,
        idempotency_key: rollbackRequest.idempotencyKey,
      });
      expect(JSON.parse(event.event_json)).toMatchObject({ step: "rollback", priorState: "exported", newState: "rolled_back" });
      const mutation = db.prepare(
        "SELECT operation_class, operator_receipt_id, idempotency_key, request_digest, outcome_json, committed_event_sequence FROM mutation_receipts WHERE project_id = ? AND idempotency_key = ?",
      ).get(PROJECT_ID, rollbackRequest.idempotencyKey) as { operation_class: string; operator_receipt_id: string | null; idempotency_key: string; request_digest: string; outcome_json: string; committed_event_sequence: number };
      expect(mutation).toMatchObject({
        operation_class: "migration_step",
        operator_receipt_id: null,
        idempotency_key: rollbackRequest.idempotencyKey,
        request_digest: rollback.mutationReceipt?.requestDigest,
        committed_event_sequence: rollback.eventSequence,
      });
      expect(JSON.parse(mutation.outcome_json)).toEqual(rollback);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
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
        cachedConsumers: { oldSchemaVersion: 11, newSchemaVersion: 12, action: "unknown", expected: 4, attempted: 0, verified: 0 },
        schema: { version: 12 },
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

  it("refuses witness threads as role holders without writes and accepts a managed live seat", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const witness = () => roleReader((facts) => {
      facts.thread.title = "GH-72 live role handoff witness";
      facts.thread.titleFallback = "Bounded live role-handoff witness only.";
    });

    const beforeQualification = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, { idempotencyKey: "witness-qualification" }), null, witness())).toMatchObject({
      outcome: "ROLE_CONTEXT_WITNESS",
      attempted: 0,
      verified: 0,
    });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeQualification);

    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken), null, roleReader())).toMatchObject({ outcome: "OK" });
    const beforeSuccession = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, successionRequest(fenceToken, { idempotencyKey: "witness-succession" }), null, witness())).toMatchObject({
      outcome: "ROLE_CONTEXT_WITNESS",
      attempted: 0,
      verified: 0,
    });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeSuccession);

    const successor = applyWithFixtureReceipt(db, successionRequest(fenceToken), null, roleReader());
    expect(successor).toMatchObject({ outcome: "OK", evidence: { holderExecutionAttemptId: expect.any(String) } });
    const holder = db.prepare("SELECT origin, state FROM execution_attempts").get();
    expect(holder).toEqual({ origin: "role_holder", state: "done" });
  });

  it("admits only the managed director-seat profile and keeps succession recording-gated", async () => {
    const invalidCases: Array<[string, (requirement: Record<string, unknown>) => void]> = [
      ["provider", (requirement) => { requirement.executedProfile = { ...DIRECTOR_PROFILE, providerId: "codex" }; }],
      ["model", (requirement) => { requirement.executedProfile = { ...DIRECTOR_PROFILE, model: "kimi-coding/k2" }; }],
      ["reasoning", (requirement) => { requirement.executedProfile = { ...DIRECTOR_PROFILE, reasoningLevel: "medium" }; }],
      ["writing", (requirement) => { requirement.writingLaneCapacity = 1; }],
      ["missing-standby", (requirement) => { delete requirement.standbyProfile; }],
      ["missing-first-exemption", (requirement) => { delete requirement.firstGenerationExemption; }],
    ];
    for (const [name, mutate] of invalidCases) {
      const host = await loadedHost();
      const db = host.bb.storage.database();
      seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      const config = directorSeatConfig();
      const requirement = (config.extensions.bbCollab.roleRequirements as Array<Record<string, unknown>>)[0]!;
      mutate(requirement);
      const before = exportFoundation(db, PROJECT_ID);
      expect(applyWithFixtureReceipt(db, bootstrapRequest(PROJECT_ID, { idempotencyKey: `director-invalid-${name}`, config }))).toMatchObject({
        outcome: "INVALID_INPUT",
        attempted: 0,
        verified: 0,
      });
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
      expect(db.prepare("SELECT COUNT(*) AS count FROM project_config_revisions").get()).toEqual({ count: 0 });
    }

    const aliasHost = await loadedHost();
    const aliasDb = aliasHost.bb.storage.database();
    seedVerifiedFixtureReceipt(aliasDb, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
    const aliasConfig = directorSeatConfig();
    const aliasRequirement = (aliasConfig.extensions.bbCollab.roleRequirements as Array<Record<string, unknown>>)[0]!;
    aliasRequirement.roleRequirementId = "director-alias";
    aliasRequirement.executedProfile = ROLE_PROFILE;
    delete aliasRequirement.standbyProfile;
    delete aliasRequirement.writingLaneCapacity;
    delete aliasRequirement.firstGenerationExemption;
    const aliasBefore = exportFoundation(aliasDb, PROJECT_ID);
    const alias = applyWithFixtureReceipt(aliasDb, bootstrapRequest(PROJECT_ID, { idempotencyKey: "director-alias-refusal", config: aliasConfig }));
    expect(alias).toMatchObject({ outcome: "INVALID_INPUT", attempted: 0, verified: 0 });
    expect(alias.message).toContain("director role is reserved for director-seat");
    expect(exportFoundation(aliasDb, PROJECT_ID)).toEqual(aliasBefore);
    expect(aliasDb.prepare("SELECT COUNT(*) AS count FROM project_config_revisions").get()).toEqual({ count: 0 });

    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: directorSeatConfig() });
    const stored = JSON.parse((db.prepare(
      "SELECT canonical_config_json FROM project_config_revisions WHERE project_id = ? AND config_revision = 1",
    ).get(PROJECT_ID) as { canonical_config_json: string }).canonical_config_json) as { extensions: { bbCollab: Record<string, unknown> } };
    expect(stored.extensions.bbCollab.roleRequirements).toEqual(expect.arrayContaining([{
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      roleId: "director",
      repoTargetId: null,
      executedProfile: DIRECTOR_PROFILE,
      standbyProfile: DIRECTOR_STANDBY_PROFILE,
      writingLaneCapacity: 0,
      firstGenerationExemption: DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION,
    }]));

    const request = qualificationRequest(fenceToken, {
      idempotencyKey: "director-qualification",
      qualificationId: "director-qualification",
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      declaredProfile: DIRECTOR_PROFILE,
    });
    expect(applyWithFixtureReceipt(db, successionRequest(fenceToken, {
      idempotencyKey: "director-before-qualification",
      qualificationId: "director-qualification",
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      profileDigest: DIRECTOR_PROFILE_DIGEST,
      standbyProfile: DIRECTOR_STANDBY_PROFILE,
    }), null, directorRoleReader())).toMatchObject({ outcome: "ROLE_UNQUALIFIED", attempted: 0, verified: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM role_generations").get()).toEqual({ count: 0 });
    expect(applyWithFixtureReceipt(db, request, null, directorRoleReader())).toMatchObject({ outcome: "OK" });

    for (const [name, mutate, outcome] of [
      ["provider", (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { facts.thread.providerId = "codex"; }, "EXECUTION_PROFILE_MISMATCH"],
      ["model", (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { (facts.events[0]!.data.execution as Record<string, unknown>).model = "kimi-coding/k2"; }, "EXECUTION_PROFILE_MISMATCH"],
      ["reasoning", (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { (facts.events[0]!.data.execution as Record<string, unknown>).reasoningLevel = "medium"; }, "EXECUTION_PROFILE_MISMATCH"],
      ["environment", (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { facts.environment.managed = false; facts.environment.isWorktree = false; facts.environment.workspaceProvisionType = "unmanaged"; }, "ROLE_CONTEXT_FOREIGN"],
      ["source", (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { facts.project.sources[0]!.hostId = "host-foreign"; }, "ROLE_CONTEXT_FOREIGN"],
    ] as const) {
      const before = exportFoundation(db, PROJECT_ID);
      expect(applyWithFixtureReceipt(db, successionRequest(fenceToken, {
        idempotencyKey: `director-refusal-${name}`,
        qualificationId: "director-qualification",
        roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
        profileDigest: DIRECTOR_PROFILE_DIGEST,
        standbyProfile: DIRECTOR_STANDBY_PROFILE,
      }), null, directorRoleReader(mutate))).toMatchObject({ outcome, attempted: 0, verified: 0 });
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
    }

    const stale = applyWithFixtureReceipt(db, successionRequest(fenceToken, {
      idempotencyKey: "director-stale-config",
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      profileDigest: DIRECTOR_PROFILE_DIGEST,
      expectedConfigRevision: 2,
      standbyProfile: DIRECTOR_STANDBY_PROFILE,
    }), null, directorRoleReader());
    expect(stale).toMatchObject({ outcome: "PROJECT_CONFIG_STALE", attempted: 0, verified: 0 });
    const foreign = applyWithFixtureReceipt(db, successionRequest(fenceToken, {
      idempotencyKey: "director-foreign-config",
      projectId: FOREIGN_PROJECT_ID,
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      qualificationId: "director-qualification",
      profileDigest: DIRECTOR_PROFILE_DIGEST,
      standbyProfile: DIRECTOR_STANDBY_PROFILE,
    }), null, directorRoleReader((facts) => { facts.project.id = FOREIGN_PROJECT_ID; }));
    expect(foreign).toMatchObject({ outcome: "ROLE_CONTEXT_FOREIGN", attempted: 0, verified: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM assignments").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM execution_attempts").get()).toEqual({ count: 0 });

    const activated = applyWithFixtureReceipt(db, successionRequest(fenceToken, {
      idempotencyKey: "director-first-generation-creation",
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      qualificationId: "director-qualification",
      profileDigest: DIRECTOR_PROFILE_DIGEST,
      standbyProfile: DIRECTOR_STANDBY_PROFILE,
    }), null, directorRoleReader());
    expect(activated).toMatchObject({ outcome: "OK", currentResourceRevision: 1 });
    expect(db.prepare("SELECT role_id, generation, status FROM role_generations").get()).toEqual({
      role_id: "director",
      generation: 1,
      status: "active",
    });
  });

  it("admits only the exact director first generation on the unmanaged canonical environment", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: directorSeatConfig() });
    const firstContext = {
      threadId: DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION.holderThreadId,
      requestEventId: "director-first-request",
      requestEventSeq: 1,
      completionEventId: "director-first-completion",
      completionEventSeq: 4,
    };
    const firstReader = (mutate?: (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => void) => directorRoleReader((facts) => {
      facts.thread.id = firstContext.threadId;
      facts.thread.environmentId = DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION.environmentId;
      facts.environment.id = DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION.environmentId;
      facts.environment.managed = false;
      facts.environment.isWorktree = false;
      facts.environment.workspaceProvisionType = "unmanaged";
      facts.environment.path = "/Users/pixexid/Projects/bb-collab";
      facts.project.sources[0]!.id = DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION.sourceId;
      facts.project.sources[0]!.path = "/Users/pixexid/Projects/bb-collab";
      facts.events[0]!.id = firstContext.requestEventId;
      facts.events[3]!.id = firstContext.completionEventId;
      mutate?.(facts);
    });
    const qualification = qualificationRequest(fenceToken, {
      idempotencyKey: "director-first-qualification",
      qualificationId: "director-first-qualification",
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      roleContext: firstContext,
      declaredProfile: DIRECTOR_PROFILE,
    });
    for (const [name, roleContext, mutate, outcome] of [
      ["reordered-triple", { ...firstContext, threadId: DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION.environmentId }, undefined, "ROLE_CONTEXT_UNKNOWN"],
      ["foreign-holder", firstContext, (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { facts.thread.id = "thr_foreign"; }, "ROLE_CONTEXT_UNKNOWN"],
      ["foreign-environment", firstContext, (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { facts.thread.environmentId = "env_foreign"; facts.environment.id = "env_foreign"; }, "ROLE_CONTEXT_FOREIGN"],
      ["foreign-source", firstContext, (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { facts.project.sources[0]!.id = "src_foreign"; }, "ROLE_CONTEXT_FOREIGN"],
    ] as const) {
      const before = exportFoundation(db, PROJECT_ID);
      expect(applyWithFixtureReceipt(db, {
        ...qualification,
        idempotencyKey: `director-first-${name}`,
        qualificationId: `director-first-${name}`,
        roleContext,
      }, null, firstReader(mutate))).toMatchObject({ outcome, attempted: 0, verified: 0 });
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
    }
    expect(applyWithFixtureReceipt(db, qualification, null, firstReader())).toMatchObject({ outcome: "OK", attempted: 1, verified: 1 });
    expect(applyWithFixtureReceipt(db, successionRequest(fenceToken, {
      idempotencyKey: "director-first-generation",
      qualificationId: qualification.qualificationId,
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      roleContext: firstContext,
      profileDigest: DIRECTOR_PROFILE_DIGEST,
      standbyProfile: DIRECTOR_STANDBY_PROFILE,
    }), null, firstReader())).toMatchObject({ outcome: "OK", currentResourceRevision: 1 });
    const beforeRetry = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, { ...qualification, idempotencyKey: "director-first-after-head", qualificationId: "director-first-after-head" }, null, firstReader())).toMatchObject({ outcome: "ROLE_CONTEXT_FOREIGN", attempted: 0, verified: 0 });
    expect(applyWithFixtureReceipt(db, successionRequest(fenceToken, {
      idempotencyKey: "director-future-unmanaged-generation",
      qualificationId: qualification.qualificationId,
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      roleContext: firstContext,
      expectedGeneration: 1,
      predecessorGeneration: 1,
      profileDigest: DIRECTOR_PROFILE_DIGEST,
      standbyProfile: DIRECTOR_STANDBY_PROFILE,
    }), null, firstReader())).toMatchObject({ outcome: "ROLE_CONTEXT_FOREIGN", attempted: 0, verified: 0 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeRetry);
  });

  it("refuses unmanaged director contexts beyond the exact first generation", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: directorSeatConfig() });
    const currentContext = {
      threadId: DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION.holderThreadId,
      requestEventId: "director-current-request",
      requestEventSeq: 1,
      completionEventId: "director-current-completion",
      completionEventSeq: 4,
    };
    const currentManagedReader = () => directorRoleReader((facts) => {
      facts.thread.id = currentContext.threadId;
      facts.thread.environmentId = DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION.environmentId;
      facts.environment.id = DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION.environmentId;
      facts.project.sources[0]!.id = DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION.sourceId;
      facts.events[0]!.id = currentContext.requestEventId;
      facts.events[3]!.id = currentContext.completionEventId;
    });
    const generationOneQualification = qualificationRequest(fenceToken, {
      idempotencyKey: "director-current-generation-one-qualification",
      qualificationId: "director-current-generation-one-qualification",
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      declaredProfile: DIRECTOR_PROFILE,
    });
    expect(applyWithFixtureReceipt(db, generationOneQualification, null, directorRoleReader()).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, successionRequest(fenceToken, {
      idempotencyKey: "director-current-generation-one-succession",
      qualificationId: generationOneQualification.qualificationId,
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      profileDigest: DIRECTOR_PROFILE_DIGEST,
      standbyProfile: DIRECTOR_STANDBY_PROFILE,
    }), null, directorRoleReader()).outcome).toBe("OK");

    const generationTwoQualification = qualificationRequest(fenceToken, {
      idempotencyKey: "director-current-generation-two-qualification",
      qualificationId: "director-current-generation-two-qualification",
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      roleContext: currentContext,
      declaredProfile: DIRECTOR_PROFILE,
    });
    expect(applyWithFixtureReceipt(db, generationTwoQualification, null, currentManagedReader()).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, successionRequest(fenceToken, {
      idempotencyKey: "director-current-generation-two-succession",
      qualificationId: generationTwoQualification.qualificationId,
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      profileDigest: DIRECTOR_PROFILE_DIGEST,
      roleContext: currentContext,
      expectedGeneration: 1,
      predecessorGeneration: 1,
      standbyProfile: DIRECTOR_STANDBY_PROFILE,
    }), null, currentManagedReader()).outcome).toBe("OK");
    expect(db.prepare("SELECT current_generation FROM role_generation_heads WHERE project_id = ? AND role_id = ?").get(PROJECT_ID, "director")).toEqual({ current_generation: 2 });

    const currentUnmanagedReader = (mutate?: (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => void) => directorRoleReader((facts) => {
      facts.thread.id = currentContext.threadId;
      facts.thread.environmentId = DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION.environmentId;
      facts.environment.id = DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION.environmentId;
      facts.environment.managed = false;
      facts.environment.isWorktree = false;
      facts.environment.workspaceProvisionType = "unmanaged";
      facts.environment.path = "/Users/pixexid/Projects/bb-collab";
      facts.project.sources[0]!.id = DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION.sourceId;
      facts.project.sources[0]!.path = "/Users/pixexid/Projects/bb-collab";
      facts.events[0]!.id = currentContext.requestEventId;
      facts.events[3]!.id = currentContext.completionEventId;
      mutate?.(facts);
    });
    const currentQualification = qualificationRequest(fenceToken, {
      idempotencyKey: "director-current-unmanaged-qualification",
      qualificationId: "director-current-unmanaged-qualification",
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      roleContext: currentContext,
      declaredProfile: DIRECTOR_PROFILE,
    });
    const rejected = applyWithFixtureReceipt(db, currentQualification, null, currentUnmanagedReader());
    expect(rejected).toMatchObject({ outcome: "ROLE_CONTEXT_FOREIGN", attempted: 0, verified: 0 });
    expect(applyWithFixtureReceipt(db, currentQualification, null, currentUnmanagedReader())).toEqual(rejected);

    for (const [name, mutate, outcome] of [
      ["holder", (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { facts.thread.projectId = FOREIGN_PROJECT_ID; }, "ROLE_CONTEXT_FOREIGN"],
      ["environment", (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { facts.thread.environmentId = "env_foreign"; facts.environment.id = "env_foreign"; }, "ROLE_CONTEXT_FOREIGN"],
      ["source", (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { facts.project.sources[0]!.id = "src_foreign"; }, "ROLE_CONTEXT_FOREIGN"],
      ["path", (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { facts.environment.path = "/foreign/source"; }, "ROLE_CONTEXT_FOREIGN"],
      ["managed", (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { facts.environment.managed = true; }, "ROLE_CONTEXT_FOREIGN"],
      ["git-repo", (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { facts.environment.isGitRepo = false; }, "ROLE_CONTEXT_FOREIGN"],
      ["worktree", (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { facts.environment.isWorktree = true; }, "ROLE_CONTEXT_FOREIGN"],
      ["provision", (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { facts.environment.workspaceProvisionType = "managed-worktree"; }, "ROLE_CONTEXT_FOREIGN"],
      ["profile", (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => { (facts.events[0]!.data.execution as Record<string, unknown>).model = "kimi-coding/k2"; }, "ROLE_CONTEXT_FOREIGN"],
    ] as const) {
      const before = exportFoundation(db, PROJECT_ID);
      const request = { ...currentQualification, idempotencyKey: `director-current-refusal-${name}`, qualificationId: `director-current-refusal-${name}` };
      expect(applyWithFixtureReceipt(db, request, null, currentUnmanagedReader(mutate)), name).toMatchObject({ outcome, attempted: 0, verified: 0 });
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
    }

    for (const expectedGeneration of [1, 3]) {
      const before = exportFoundation(db, PROJECT_ID);
      const request = successionRequest(fenceToken, {
        idempotencyKey: `director-current-wrong-generation-${expectedGeneration}`,
        qualificationId: currentQualification.qualificationId,
        roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
        profileDigest: DIRECTOR_PROFILE_DIGEST,
        roleContext: currentContext,
        expectedGeneration,
        predecessorGeneration: expectedGeneration,
        standbyProfile: DIRECTOR_STANDBY_PROFILE,
      });
      expect(applyWithFixtureReceipt(db, request, null, currentUnmanagedReader())).toMatchObject({ outcome: "ROLE_CONTEXT_FOREIGN", attempted: 0, verified: 0 });
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
    }

    const futureContext = {
      threadId: "director-future-managed",
      requestEventId: "director-future-request",
      requestEventSeq: 1,
      completionEventId: "director-future-completion",
      completionEventSeq: 4,
    };
    const futureManagedReader = directorRoleReader((facts) => {
      facts.thread.id = futureContext.threadId;
      facts.thread.environmentId = "environment-director-future";
      facts.environment.id = "environment-director-future";
      facts.events[0]!.id = futureContext.requestEventId;
      facts.events[3]!.id = futureContext.completionEventId;
    });
    const futureQualification = qualificationRequest(fenceToken, {
      idempotencyKey: "director-future-generation-qualification",
      qualificationId: "director-future-generation-qualification",
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      roleContext: futureContext,
      declaredProfile: DIRECTOR_PROFILE,
    });
    expect(applyWithFixtureReceipt(db, futureQualification, null, futureManagedReader).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, successionRequest(fenceToken, {
      idempotencyKey: "director-future-generation-succession",
      qualificationId: futureQualification.qualificationId,
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      roleContext: futureContext,
      expectedGeneration: 2,
      predecessorGeneration: 2,
      profileDigest: DIRECTOR_PROFILE_DIGEST,
      standbyProfile: DIRECTOR_STANDBY_PROFILE,
    }), null, futureManagedReader).outcome).toBe("OK");
    const beforeFutureUnmanaged = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, {
      ...currentQualification,
      idempotencyKey: "director-current-unmanaged-after-future-head",
      qualificationId: "director-current-unmanaged-after-future-head",
    }, null, currentUnmanagedReader())).toMatchObject({ outcome: "ROLE_CONTEXT_FOREIGN", attempted: 0, verified: 0 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeFutureUnmanaged);

    const stale = { ...currentQualification, idempotencyKey: "director-current-stale-config", expectedConfigRevision: 2 };
    expect(applyWithFixtureReceipt(db, stale, null, currentUnmanagedReader())).toMatchObject({ outcome: "PROJECT_CONFIG_STALE", attempted: 0, verified: 0 });
  });

  it("records immutable qualification and activates one exact first orchestrator generation", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const facts = roleReader((value) => { value.environment.path = "/workspace/managed-worktree"; });
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
        cachedConsumers: { action: "unknown", expected: 4, attempted: 0, verified: 0 },
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

  it("records one exact director standby and refuses wrong-provider, foreign, stale, and replay paths without writes", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: directorSeatConfig() });
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, { roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID, declaredProfile: DIRECTOR_PROFILE }), null, directorRoleReader()).outcome).toBe("OK");
    const request = successionRequest(fenceToken, { idempotencyKey: "standby-generation", roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID, profileDigest: DIRECTOR_PROFILE_DIGEST, standbyProfile: DIRECTOR_STANDBY_PROFILE });
    const committed = applyWithFixtureReceipt(db, request, null, directorRoleReader());
    expect(committed).toMatchObject({ outcome: "OK", currentResourceRevision: 1, evidence: { standbyProfile: DIRECTOR_STANDBY_PROFILE } });
    expect(db.prepare(
      "SELECT project_id, role_id, generation, standby_profile_json FROM role_generations",
    ).get()).toEqual({
      project_id: PROJECT_ID,
      role_id: "director",
      generation: 1,
      standby_profile_json: canonicalJson(DIRECTOR_STANDBY_PROFILE),
    });
    expect(applyWithFixtureReceipt(db, request, null, null)).toEqual(committed);
    expect(db.prepare("SELECT COUNT(*) AS count FROM role_generations").get()).toEqual({ count: 1 });

    const beforeWrongProvider = exportFoundation(db, PROJECT_ID);
    const wrongProvider = applyWithFixtureReceipt(db, successionRequest(fenceToken, {
      idempotencyKey: "standby-wrong-provider",
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      profileDigest: DIRECTOR_PROFILE_DIGEST,
      standbyProfile: { ...DIRECTOR_STANDBY_PROFILE, providerId: DIRECTOR_PROFILE.providerId },
    }), null, directorRoleReader());
    expect(wrongProvider).toMatchObject({ outcome: "ROLE_STANDBY_INVALID", attempted: 0, verified: 0 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeWrongProvider);

    const missingStandby = applyWithFixtureReceipt(db, {
      ...request,
      idempotencyKey: "standby-missing",
      standbyProfile: undefined,
    }, null, directorRoleReader());
    expect(missingStandby).toMatchObject({ outcome: "ROLE_STANDBY_INVALID", attempted: 0, verified: 0 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeWrongProvider);

    const foreign = applyWithFixtureReceipt(
      db,
      { ...request, projectId: FOREIGN_PROJECT_ID, idempotencyKey: "standby-foreign" },
      null,
      directorRoleReader((facts) => { facts.project.id = FOREIGN_PROJECT_ID; }),
    );
    expect(foreign).toMatchObject({ outcome: "ROLE_CONTEXT_FOREIGN", attempted: 0, verified: 0 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeWrongProvider);

    const stale = applyWithFixtureReceipt(db, successionRequest(fenceToken, {
      idempotencyKey: "standby-stale",
      expectedGeneration: 1,
      predecessorGeneration: 1,
      expectedConfigRevision: 2,
      roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
      profileDigest: DIRECTOR_PROFILE_DIGEST,
    }), null, directorRoleReader());
    expect(stale).toMatchObject({ outcome: "PROJECT_CONFIG_STALE", attempted: 0, verified: 0 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeWrongProvider);
  });

  it("routes live RPC and CLI role facts into the existing qualification and succession resolvers", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const authorize = (request: ApplyRequest): ApplyRequest => {
      const unsigned = { ...request, candidateHead: CANDIDATE_SHA, operatorReceiptId: null };
      const receipt = persistInterimOperatorReceipt(db, {
        projectId: PROJECT_ID,
        mutationClass: unsigned.operationClass,
        candidateHead: CANDIDATE_SHA,
        idempotencyKey: unsigned.idempotencyKey,
        requestDigest: operatorRequestDigest(unsigned),
        callerThreadId: "live-role-thread",
        requestedFromBackground: false,
        callerPluginId: PLUGIN_ID,
        issuanceProvenance: "console",
      });
      return { ...unsigned, operatorReceiptId: receipt.receiptId };
    };
    const qualification = authorize(qualificationRequest(fenceToken, { idempotencyKey: "live-qualification" }));
    expect(await host.harness.callRpc("apply", qualification)).toMatchObject({ outcome: "OK" });

    const succession = authorize(successionRequest(fenceToken, { idempotencyKey: "live-succession" }));
    const cli = await host.harness.runCli(["apply", "--project", PROJECT_ID, "--request", JSON.stringify(succession)]);
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ outcome: "OK" });
    expect(host.harness.inspection.sdk.callsTo("threads.get").length).toBeGreaterThanOrEqual(2);
    expect(host.harness.inspection.sdk.callsTo("threads.events.list").length).toBeGreaterThanOrEqual(2);
    expect(host.harness.inspection.sdk.callsTo("environments.get").length).toBeGreaterThanOrEqual(2);
  });

  it("refuses title-only and fallback-only witness markers through the live SDK reader without writes", async () => {
    for (const [field, marker] of [["title", "handoff witness"], ["titleFallback", "witness only"]] as const) {
      const host = await loadedHost(PROJECT_ID, (facts) => {
        facts.thread.title = null;
        facts.thread.titleFallback = null;
        facts.thread[field] = marker;
      });
      const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
      const unsigned = { ...qualificationRequest(fenceToken, { idempotencyKey: `live-${field}-witness` }), candidateHead: CANDIDATE_SHA, operatorReceiptId: null };
      const receipt = persistInterimOperatorReceipt(db, {
        projectId: PROJECT_ID,
        mutationClass: unsigned.operationClass,
        candidateHead: CANDIDATE_SHA,
        idempotencyKey: unsigned.idempotencyKey,
        requestDigest: operatorRequestDigest(unsigned),
        callerThreadId: "live-role-thread",
        requestedFromBackground: false,
        callerPluginId: PLUGIN_ID,
        issuanceProvenance: "console",
      });
      const before = exportFoundation(db, PROJECT_ID);
      expect(await host.harness.callRpc("apply", { ...unsigned, operatorReceiptId: receipt.receiptId })).toMatchObject({
        outcome: "ROLE_CONTEXT_WITNESS",
        attempted: 0,
        verified: 0,
      });
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
      expect(host.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1);
    }
  });

  it("issues and consumes derived actor receipts for both live role mutation classes", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: "operator-authorizer", actorKind: "operator", subjectId: "operator-1" });
    const authorizingCreate = decisionCreateRequest(fenceToken, "live-role-approver", {
      actorReceiptId: "operator-authorizer",
      repoTargetId: null,
      decision: {
        decisionId: "live-role-approver",
        repoTargetId: null,
        scope: { projectId: PROJECT_ID, purpose: "operator-approver" },
        decisionClass: "operator_only",
        options: { approverId: AUTHORIZED_APPROVER_ID },
        resourceRevision: 1,
      },
    });
    expect(applyWithFixtureReceipt(db, authorizingCreate)).toMatchObject({ outcome: "OK" });
    expect(applyWithFixtureReceipt(db, decisionDispositionRequest(fenceToken, "live-role-approver", 1, {
      actorReceiptId: "operator-authorizer",
      repoTargetId: null,
      idempotencyKey: "adopt-live-role-approver",
    })).outcome).toBe("OK");

    const attest = async (request: ApplyRequest) => {
      const issued = await host.harness.callRpc("approverAttestation", {
        projectId: PROJECT_ID,
        mutationClass: request.operationClass,
        candidateHead: request.candidateHead,
        idempotencyKey: request.idempotencyKey,
        requestDigest: operatorRequestDigest(request),
        callerThreadId: "live-role-attestor",
        requestedFromBackground: false,
        approverId: AUTHORIZED_APPROVER_ID,
        authorizingDecisionId: "live-role-approver",
        authorizingDispositionSequence: 1,
      }) as FoundationResult;
      expect(issued).toMatchObject({ outcome: "OK", actorReceiptId: expect.any(String), operatorReceipt: {
        mutationClass: request.operationClass,
      } });
      return issued;
    };

    const qualification = qualificationRequest(fenceToken, {
      idempotencyKey: "attested-live-qualification",
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
    });
    const qualificationIssued = await attest(qualification);
    expect(await host.harness.callRpc("apply", {
      ...qualification,
      actorReceiptId: qualificationIssued.actorReceiptId,
      operatorReceiptId: qualificationIssued.operatorReceipt!.receiptId,
    })).toMatchObject({ outcome: "OK" });

    const succession = successionRequest(fenceToken, {
      idempotencyKey: "attested-live-succession",
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
    });
    const successionIssued = await attest(succession);
    expect(await host.harness.callRpc("apply", {
      ...succession,
      actorReceiptId: successionIssued.actorReceiptId,
      operatorReceiptId: successionIssued.operatorReceipt!.receiptId,
    })).toMatchObject({ outcome: "OK" });

    const negative = qualificationRequest(fenceToken, {
      idempotencyKey: "attested-live-negative",
      qualificationId: "attested-live-negative",
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
    });
    const negativeIssued = await attest(negative);
    const negativeApply = {
      actorReceiptId: negativeIssued.actorReceiptId,
      operatorReceiptId: negativeIssued.operatorReceipt!.receiptId,
    };
    const beforeNegative = db.prepare(
      "SELECT (SELECT COUNT(*) FROM state_events) AS events, (SELECT COUNT(*) FROM mutation_receipts) AS mutations, (SELECT COUNT(*) FROM qualification_observations) AS observations",
    ).get();
    expect((await host.harness.callRpc("apply", { ...negative, ...negativeApply, projectId: FOREIGN_PROJECT_ID }) as FoundationResult).outcome).toBe("OPERATOR_RECEIPT_FOREIGN");
    expect((await host.harness.callRpc("apply", { ...negative, ...negativeApply, operationClass: "role_generation_succession", idempotencyKey: "cross-role-class" }) as FoundationResult).outcome).toBe("OPERATOR_RECEIPT_STALE");
    expect((await host.harness.callRpc("apply", { ...negative, ...negativeApply, candidateHead: H1_CANDIDATE_SHA }) as FoundationResult).outcome).toBe("OPERATOR_RECEIPT_STALE");
    expect(db.prepare(
      "SELECT (SELECT COUNT(*) FROM state_events) AS events, (SELECT COUNT(*) FROM mutation_receipts) AS mutations, (SELECT COUNT(*) FROM qualification_observations) AS observations",
    ).get()).toEqual(beforeNegative);

    const noFacts = qualificationRequest(fenceToken, {
      idempotencyKey: "attested-live-no-facts",
      qualificationId: "attested-live-no-facts",
      actorReceiptId: null,
      operatorReceiptId: null,
      candidateHead: CANDIDATE_SHA,
      roleContext: undefined,
    });
    const noFactsIssued = await attest(noFacts);
    expect((await host.harness.callRpc("apply", {
      ...noFacts,
      actorReceiptId: noFactsIssued.actorReceiptId,
      operatorReceiptId: noFactsIssued.operatorReceipt!.receiptId,
    }) as FoundationResult).outcome).toBe("ROLE_CONTEXT_REQUIRED");
    expect(db.prepare("SELECT consumed_at_ms FROM operator_receipts WHERE receipt_id = ?").get(noFactsIssued.operatorReceipt!.receiptId)).toEqual({ consumed_at_ms: null });
    expect(db.prepare(
      "SELECT (SELECT COUNT(*) FROM state_events) AS events, (SELECT COUNT(*) FROM mutation_receipts) AS mutations, (SELECT COUNT(*) FROM qualification_observations) AS observations",
    ).get()).toEqual(beforeNegative);

    expect(await host.harness.callRpc("apply", { ...negative, ...negativeApply })).toMatchObject({ outcome: "OK" });
    expect(await host.harness.callRpc("apply", { ...negative, ...negativeApply, idempotencyKey: "attested-live-reuse" })).toMatchObject({ outcome: "OPERATOR_RECEIPT_REUSED" });
  });

  it("requires exact target binding for target-scoped roles", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const facts = roleReader((value) => { value.environment.path = "/workspace/managed-worktree"; });
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

    const workerFacts = roleReader((value) => {
      value.thread.id = "worker-thread-holder";
      value.thread.environmentId = "worker-environment-holder";
      value.environment.id = "worker-environment-holder";
      value.environment.branchName = "bb/worker-role-holder";
      value.events[0]!.id = "worker-event-request";
      value.events[3]!.id = "worker-event-completion";
    });
    const workerRoleContext = {
      threadId: "worker-thread-holder",
      requestEventId: "worker-event-request",
      requestEventSeq: 1,
      completionEventId: "worker-event-completion",
      completionEventSeq: 4,
    };
    const workerQualification = qualificationRequest(fenceToken, {
      idempotencyKey: "worker-qualification",
      repoTargetId: TARGET_ID,
      roleId: "worker",
      roleRequirementId: "worker-v1",
      qualificationId: "worker-qualification",
      roleContext: workerRoleContext,
    });
    const workerBefore = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, { ...workerQualification, idempotencyKey: "worker-missing-target", repoTargetId: null }, null, workerFacts).outcome).toBe("REPO_TARGET_REQUIRED");
    expect(applyWithFixtureReceipt(db, { ...workerQualification, idempotencyKey: "worker-foreign-target", repoTargetId: SECOND_TARGET_ID }, null, workerFacts).outcome).toBe("REPO_TARGET_FOREIGN");
    const workerWrongTargetContext = roleReader((value) => {
      value.thread.id = workerRoleContext.threadId;
      value.thread.environmentId = "worker-environment-holder";
      value.environment.id = "worker-environment-holder";
      value.environment.branchName = "bb/worker-role-holder";
      value.environment.path = "/workspace/other";
      value.project.sources[0]!.path = "/workspace/other";
      value.events[0]!.id = workerRoleContext.requestEventId;
      value.events[3]!.id = workerRoleContext.completionEventId;
    });
    expect(applyWithFixtureReceipt(db, { ...workerQualification, idempotencyKey: "worker-wrong-context", qualificationId: "worker-wrong-context" }, null, workerWrongTargetContext).outcome).toBe("ROLE_CONTEXT_FOREIGN");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(workerBefore);
    expect(applyWithFixtureReceipt(db, workerQualification, null, workerFacts).outcome).toBe("OK");
    const workerSuccession = successionRequest(fenceToken, {
      idempotencyKey: "worker-succession",
      repoTargetId: TARGET_ID,
      roleId: "worker",
      roleRequirementId: "worker-v1",
      qualificationId: "worker-qualification",
      roleContext: workerRoleContext,
      standbyProfile: STANDBY_PROFILE,
    });
    const beforeWorkerStandbyRefusal = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, workerSuccession, null, workerFacts)).toMatchObject({
      outcome: "ROLE_STANDBY_INVALID",
      attempted: 0,
      verified: 0,
    });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeWorkerStandbyRefusal);
    expect(applyWithFixtureReceipt(db, { ...workerSuccession, idempotencyKey: "worker-succession-valid", standbyProfile: undefined }, null, workerFacts).outcome).toBe("OK");
    expect(db.prepare("SELECT repo_target_id, status FROM role_generations WHERE role_id = 'worker'").get()).toEqual({
      repo_target_id: TARGET_ID,
      status: "active",
    });
  });

  it("resolves a canonical source behind a distinct ready managed-worktree path", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const facts = roleReader((value) => { value.environment.path = "/workspace/managed-worktree"; });
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
      idempotencyKey: "managed-worktree-source-resolution",
      qualificationId: "managed-worktree-source-resolution",
    }), null, facts)).toMatchObject({ outcome: "OK", expected: 1, attempted: 1, verified: 1 });
    expect(db.prepare("SELECT source_id, host_id FROM qualification_observations WHERE qualification_id = ?").get("managed-worktree-source-resolution")).toEqual({
      source_id: "source-main",
      host_id: "host-main",
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

  it("refuses hidden, foreign, ephemeral, ambiguous, and incomplete BB holder contexts without mutation", async () => {
    const cases: Array<[string, (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => void, string, Partial<ApplyRequest>?]> = [
      ["hidden", (facts) => { facts.thread.visibility = "hidden"; }, "ROLE_CONTEXT_HIDDEN"],
      ["foreign-thread", (facts) => { facts.thread.projectId = FOREIGN_PROJECT_ID; }, "ROLE_CONTEXT_FOREIGN"],
      ["missing-environment", (facts) => { facts.thread.environmentId = null; }, "ROLE_CONTEXT_REQUIRED"],
      ["foreign-environment", (facts) => { facts.environment.projectId = FOREIGN_PROJECT_ID; }, "ROLE_CONTEXT_FOREIGN"],
      ["foreign-source-host", (facts) => { facts.project.sources[0]!.hostId = "host-foreign"; }, "ROLE_CONTEXT_FOREIGN"],
      ["ambiguous-source", (facts) => { facts.project.sources.push({ ...facts.project.sources[0]!, id: "source-duplicate" }); }, "ROLE_CONTEXT_FOREIGN"],
      ["unmanaged-environment", (facts) => {
        facts.environment.managed = false;
        facts.environment.isWorktree = false;
        facts.environment.workspaceProvisionType = "unmanaged";
      }, "ROLE_CONTEXT_FOREIGN"],
      ["ephemeral-environment", (facts) => {
        facts.environment.path = null;
        facts.environment.status = "provisioning";
      }, "ROLE_CONTEXT_FOREIGN"],
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
    db.exec(MIGRATIONS.at(-9)!);
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
    expect(cachedConsumerRolloutEvidence(cachedConsumerObservations(11, 19))).toMatchObject({ oldSchemaVersion: 11, newSchemaVersion: 12, oldContractVersion: 19, newContractVersion: 20, action: "refused", expected: 4, attempted: 4, verified: 0 });
    expect(cachedConsumerRolloutEvidence(cachedConsumerObservations(12, 19))).toMatchObject({ oldSchemaVersion: 11, newSchemaVersion: 12, oldContractVersion: 19, newContractVersion: 20, action: "refused", expected: 4, attempted: 4, verified: 0 });
    expect(cachedConsumerRolloutEvidence(cachedConsumerObservations(12, 20))).toMatchObject({ oldSchemaVersion: 11, newSchemaVersion: 12, oldContractVersion: 19, newContractVersion: 20, action: "reread", expected: 4, attempted: 4, verified: 4 });
  });

  it("reserves before native dispatch and accepts one exact terminal report", async () => {
    const { db, fenceToken } = await assignmentFixture();
    const adapter = new DeterministicNativeAssignmentAdapter();
    const prepare = assignmentPrepareRequest(fenceToken);
    const prepared = applyWithFixtureReceipt(db, prepare, null, null, adapter);
    expect(prepared).toMatchObject({ outcome: "OK", evidence: { assignmentId: "assignment-1", writingLaneCeiling: 3, activeWriterCount: 1 } });
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

  it("refuses director write admission while preserving read-only assignment admission", async () => {
    const { db, fenceToken } = await assignmentFixture({ directorSeat: true });
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "in_progress", 2)).outcome).toBe("OK");
    const adapter = new DeterministicNativeAssignmentAdapter();
    const write = assignmentPrepareRequest(fenceToken, "director-write", {
      expectedResourceRevision: 3,
      assignment: {
        ...assignmentPrepareRequest(fenceToken).assignment!,
        assignmentId: "director-write",
        roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
        roleId: "director",
        roleGeneration: 1,
        requestedProfile: DIRECTOR_PROFILE,
        branchName: "bb/director-write",
        environment: { ...assignmentPrepareRequest(fenceToken).assignment!.environment, environmentId: "environment-director-write" },
      },
    });
    const before = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, write, null, null, adapter)).toMatchObject({ outcome: "LANE_WRITER_EXISTS", attempted: 0, verified: 0 });
    expect(adapter.inspectCalls).toHaveLength(0);
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM assignments").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM execution_attempts WHERE origin = 'assignment'").get()).toEqual({ count: 0 });

    const readOnly = assignmentPrepareRequest(fenceToken, "director-review", {
      expectedResourceRevision: 3,
      assignment: {
        ...write.assignment!,
        assignmentId: "director-review",
        assignmentKind: "review",
        laneId: "director-review-lane",
        branchName: "bb/director-review",
        candidateSemantics: "frozen",
        candidateSha: CANDIDATE_SHA,
        environment: { ...write.assignment!.environment, environmentId: "environment-director-review" },
      },
    });
    expect(applyWithFixtureReceipt(db, readOnly, null, null, adapter)).toMatchObject({ outcome: "OK", evidence: { activeWriterCount: 0 } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM assignments").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM execution_attempts WHERE origin = 'assignment'").get()).toEqual({ count: 1 });
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
          expect(applyWithFixtureReceipt(firstDb, third, null, null, firstAdapter).outcome).toBe("OK");
          expect(firstDb.prepare("SELECT COUNT(*) AS count FROM execution_attempts WHERE origin = 'assignment' AND assignment_kind = 'write'").get()).toEqual({ count: 3 });
          const fourth = assignmentPrepareRequest(fenceToken, "ceiling-3-fourth", {
            assignment: { ...assignmentPrepareRequest(fenceToken).assignment!, assignmentId: "ceiling-3-fourth", laneId: "lane-fourth", branchName: "bb/ceiling-3-fourth", environment: { ...assignmentPrepareRequest(fenceToken).assignment!.environment, environmentId: "environment-ceiling-3-fourth" } },
          });
          expect(applyWithFixtureReceipt(firstDb, fourth, null, null, firstAdapter).outcome).toBe("LANE_WRITER_EXISTS");
          expect(firstDb.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE idempotency_key = ?").get(fourth.idempotencyKey)).toEqual({ count: 0 });
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
    expect(registrations.cli?.commands.map((command) => command.name)).toEqual(["doctor", "export", "apply", "cached-consumer-rollout", "wait-register", "wait-list", "wait-validator", "archive-sweep"]);
    expect(registrations.httpRoutes.map((route) => route.path)).toEqual(["/lanes", "/operator-receipt-waits"]);
    expect(seedFixtureDecision).toBeTypeOf("function");
  });
});
