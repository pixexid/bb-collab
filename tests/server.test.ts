import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract } from "@bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import plugin, { rpcContract, URGENT_NOTIFICATION_DEDUP_MS } from "../server.js";
import {
  DEFERRED_ISSUE_3_OUTCOMES,
  CACHED_CONSUMERS,
  CONTRACT_VERSION,
  DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
  EVIDENCE_ONLY_EQUIVALENCE_DISPOSITION,
  LLM_COLLAB_EVIDENCE_RESOURCE_REVISION,
  LLM_COLLAB_MERGED_MAIN_SHA,
  LLM_COLLAB_SOURCE_FENCE,
  MAX_EXPORT_ROWS,
  MAX_EXPORT_BYTES,
  MAX_SOURCE_EVIDENCE_MANIFEST_BYTES,
  MIGRATIONS,
  ROLE_CONTEXT_EVENT_PAGE_SIZE,
  MIGRATION_STATES,
  MIGRATION_STEPS,
  PLUGIN_ID,
  SCHEMA_VERSION,
  TABLES,
  assembleV21CachedConsumerRolloutEvidence,
  applyFixtureMutation,
  applyAuthorizedMutation,
  cachedConsumerRolloutEvidence,
  canonicalJson,
  contractDigest,
  databaseIsReady,
  doctor,
  exportFoundation,
  probeV21NewLegacyApplyProvenanceRefusal,
  probeV21ConsumedLegacyReplay,
  parseApplyRequest,
  schemaDigest,
  sha256,
  type ApplyRequest,
  type ExportFilePayload,
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
import { createLaneWatcher, createRoleIdleLedger, readRoleHolderStates, roleIdleKey, type RoleIdleRecord } from "../src/awareness.js";
import { findCheckoutRoot, readCheckoutDivergence } from "../src/checkout-divergence.js";

const PROJECT_ID = "proj_test";
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
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

function checkoutFixture(diverged: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "bb-collab-checkout-divergence-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "fixture@example.test"]);
  git(["config", "user.name", "Fixture"]);
  writeFileSync(join(directory, "README.md"), "base\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]);
  if (diverged) {
    writeFileSync(join(directory, "README.md"), "origin\n");
    git(["commit", "-qam", "origin"]);
    git(["update-ref", "refs/remotes/origin/main", git(["rev-parse", "HEAD"])]);
    git(["reset", "-q", "--hard", base]);
  } else {
    git(["update-ref", "refs/remotes/origin/main", base]);
  }
  return { directory, base, origin: git(["show-ref", "--hash", "refs/remotes/origin/main"]) };
}

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
  };
  return config;
}

function directorAndOrchestratorConfig() {
  const config = roleConfig();
  (config.extensions.bbCollab.roleRequirements as Array<Record<string, unknown>>).unshift({
    roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
    roleId: "director",
    repoTargetId: null,
    executedProfile: DIRECTOR_PROFILE,
    standbyProfile: DIRECTOR_STANDBY_PROFILE,
    writingLaneCapacity: 0,
  });
  return config;
}

function cachedConsumerObservations(observedSchemaVersion: number, observedContractVersion: number) {
  return CACHED_CONSUMERS.map((name) => ({ name, observedSchemaVersion, observedContractVersion }));
}

function policyProbeReread(name: (typeof CACHED_CONSUMERS)[number], result: Pick<FoundationResult, "outcome">, expectedOutcome: FoundationResult["outcome"]) {
  if (result.outcome !== expectedOutcome) throw new Error(`${name} policy probe did not return ${expectedOutcome}`);
  const reread = cachedConsumerRolloutEvidence(cachedConsumerObservations(SCHEMA_VERSION, CONTRACT_VERSION));
  if (reread.action !== "reread") throw new Error(`${name} did not reread v21`);
  const observation = reread.observations.find((candidate) => candidate.name === name);
  if (!observation) throw new Error(`${name} reread observation is unavailable`);
  return { observedSchemaVersion: observation.observedSchemaVersion, observedContractVersion: observation.observedContractVersion };
}

function doctorV21Reread(name: "server.rpcContract" | "server.collabCli", result: FoundationResult) {
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
  // Fixture-shape assumption: facts.events is the ordered reader-return surface.
  // Sequence gaps are normal; array position models returned linkage, not dense sequence coverage.
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
      plugins: {
        getSource: async () => ({
          requested: `path:${PLUGIN_ROOT}`,
          resolved: `path:${PLUGIN_ROOT}`,
          engines: {},
          history: [],
        }),
        list: async () => ({ plugins: [{ id: PLUGIN_ID, status: "running", schedules: [{ name: "fleet-watchdog" }, { name: "stall-guard-liveness" }] }] }) as never,
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
          list: async ({ afterSeq, limit }) => roleFacts.facts.events
            .filter((event) => afterSeq === undefined || event.seq > Number(afterSeq))
            .slice(0, limit === undefined ? undefined : Number(limit))
            .map((event) => ({
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

function workItemWaitRequest(
  fenceToken: string,
  expectedResourceRevision: number,
  wait: ApplyRequest["workItemWait"],
  overrides: Partial<ApplyRequest> = {},
): ApplyRequest {
  return {
    projectId: PROJECT_ID,
    operationClass: "work_item_transition",
    idempotencyKey: `work-item-wait-${wait === null ? "clear" : "declare"}-${expectedResourceRevision}`,
    actorReceiptId: RECEIPT_ID,
    expectedConfigRevision: 1,
    expectedGovernanceEpoch: 1,
    expectedFenceToken: fenceToken,
    repoTargetId: TARGET_ID,
    expectedResourceRevision,
    workItemId: WORK_ITEM_ID,
    workItemWait: wait,
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
  const { default: distPlugin } = await import("../dist/server.js?bbPluginLoad=7.9");
  await distPlugin(host.bb);
  return host;
}

async function fleetWatchdogFixture(updatedAt = 1, includeGithubRemote = false, writingLaneCeiling?: number) {
  const fixture = await assignmentFixture({ directorSeat: true, orchestratorSeat: true, withoutGithubIssues: true, targetRemoteUrl: includeGithubRemote ? "https://github.com/example/project.git" : undefined, writingLaneCeiling });
  const director = fixture.db.prepare(
    "SELECT thread_id FROM execution_attempts WHERE origin = 'role_holder' AND role_id = 'director'",
  ).get() as { thread_id: string };
  const orchestrator = fixture.db.prepare(
    "SELECT thread_id FROM execution_attempts WHERE origin = 'role_holder' AND role_id = 'project-orchestrator'",
  ).get() as { thread_id: string };
  let threadStatus: "idle" | "active" = "idle";
  let directorPendingInteraction = false;
  fixture.host.harness.sdk.stub("threads.interactions.list", (async ({ threadId }: { threadId: string }) =>
    threadId === director.thread_id && directorPendingInteraction ? [{ status: "pending" }] : []) as never);
  let nativeUpdatedAt = updatedAt;
  const threadProjects = new Map([[director.thread_id, PROJECT_ID], [orchestrator.thread_id, PROJECT_ID]]);
  const lanes = new Map<string, ReturnType<typeof makeThreadResponse> & { environmentBranchName: string | null }>();
  const laneEvents = new Map<string, Array<{ id: string; threadId: string; seq: number; type: "turn/started"; scope: { kind: "thread" }; data: { providerThreadId: string }; createdAt: number }>>();
  const usageCapped = new Set<string>();
  fixture.host.harness.sdk.stub("threads.get", (async ({ threadId }: { threadId: string }) => makeThreadResponse({
    ...(lanes.get(threadId) ?? {}),
    id: threadId,
    projectId: lanes.get(threadId)?.projectId ?? threadProjects.get(threadId) ?? (threadId.includes("two") ? "project-two" : PROJECT_ID),
    status: lanes.get(threadId)?.status ?? threadStatus,
    parentThreadId: lanes.get(threadId)?.parentThreadId ?? null,
    updatedAt: lanes.get(threadId)?.updatedAt ?? nativeUpdatedAt,
  })) as never);
  fixture.host.harness.sdk.stub("threads.list", (async ({ projectId }: { projectId?: string }) =>
    [...lanes.values()].filter((lane) => projectId === undefined || lane.projectId === projectId)) as never);
  fixture.host.harness.sdk.stub("threads.spawn", (async ({ projectId, parentThreadId, title }: { projectId: string; parentThreadId?: string; title?: string }) => {
    const id = `lane-${lanes.size + 1}`;
    const lane = Object.assign(makeThreadResponse({ id, projectId, parentThreadId: parentThreadId ?? null, title: title ?? null, status: "error", updatedAt: nativeUpdatedAt }), {
      environmentBranchName: `bb/lane-${lanes.size + 1}`,
    });
    lanes.set(id, lane);
    laneEvents.set(id, [{ id: `event-${id}`, threadId: id, seq: 7, type: "turn/started", scope: { kind: "thread" }, data: { providerThreadId: "provider-thread" }, createdAt: 7 }]);
    return lane;
  }) as never);
  fixture.host.harness.sdk.stub("threads.events.list", (async ({ threadId }: { threadId: string }) => laneEvents.get(threadId) ?? []) as never);
  fixture.host.harness.sdk.stub("threads.rateLimitRecovery", (async ({ threadId }: { threadId: string }) => usageCapped.has(threadId) ? {
    reason: "eligible",
    scopeKey: "test",
    hostId: "host-main",
    rateLimits: null,
    candidate: {
      failedRequestId: "failed-request",
      turnId: "failed-turn",
      automatic: true,
      resetsAtMs: 9_999_999,
      rateLimits: { providerId: "codex", status: "blocked", kind: "subscription-window", windows: [], reachedReason: "usage cap", overageStatus: null, overageReason: null },
    },
  } : { reason: "no-rate-limit-state", scopeKey: "test", hostId: "host-main", rateLimits: null, candidate: null }) as never);
  fixture.host.harness.sdk.stub("threads.send", (async () => ({ ok: true })) as never);
  return {
    ...fixture,
    directorThreadId: director.thread_id,
    orchestratorThreadId: orchestrator.thread_id,
    setThreadUpdatedAt(value: number) { nativeUpdatedAt = value; },
    setThreadStatus(value: "idle" | "active") { threadStatus = value; },
    getThreadStatus() { return threadStatus; },
    setDirectorPendingInteraction(value: boolean) { directorPendingInteraction = value; },
    setThreadProject(threadId: string, projectId: string) { threadProjects.set(threadId, projectId); },
    setUsageCapped(threadId: string) { usageCapped.add(threadId); },
  };
}

function insertFixtureAssignment(db: Database.Database, fenceToken: string, options: {
  assignmentId: string;
  assignmentKind: "write" | "review" | "probe";
  laneId: string;
  roleId: string;
  roleGeneration: number;
  roleRequirementId: string;
  candidateSha: string | null;
  workItemRevision: number;
  executionAttemptId: string;
}) {
  const template = assignmentPrepareRequest(fenceToken, options.assignmentId);
  const assignment = {
    ...template.assignment!,
    ...options,
    candidateSemantics: options.candidateSha === null ? "base" as const : "frozen" as const,
  };
  // PR-201: keep this direct fixture independent of the production writer while
  // reproducing its canonical identity derivation exactly.
  const {
    assignmentId: _assignmentId,
    workItemRevision: _workItemRevision,
    executionAttemptId: _executionAttemptId,
    ...intent
  } = assignment;
  const assignmentDigest = sha256(canonicalJson({
    projectId: PROJECT_ID,
    configRevision: 1,
    governanceEpoch: 1,
    workItemRevision: options.workItemRevision,
    repoTargetId: TARGET_ID,
    intent,
  }));
  const executionAttemptId = sha256(canonicalJson({ projectId: PROJECT_ID, assignmentDigest, attemptOrdinal: 1 }));
  const creationEventSequence = ((db.prepare(
    "SELECT COALESCE(MAX(event_sequence), 0) AS ceiling FROM state_events WHERE project_id = ?",
  ).get(PROJECT_ID) as { ceiling: number }).ceiling) + 1;
  const now = Date.now();
  db.prepare(`
    INSERT INTO assignments (
      project_id, assignment_id, work_item_id, assignment_kind, lane_id, role_requirement_id,
      role_id, role_generation, config_revision, governance_epoch, work_item_revision,
      repo_target_id, branch_name, base_sha, candidate_semantics, candidate_sha, bb_server_id,
      environment_id, source_id, host_id, environment_path, environment_mode,
      frozen_brief_version, frozen_brief_digest, requested_provider_id, requested_model,
      requested_reasoning_level, requested_permission_mode, requested_service_tier,
      requested_visibility, requested_profile_digest, dispatch_kind, attach_thread_id,
      parent_assignment_id, depth, deadline_at_ms, assignment_digest, idempotency_key,
      creation_event_sequence, created_at_ms
    ) VALUES (${Array.from({ length: 40 }, () => "?").join(", ")})
  `).run(
    PROJECT_ID, assignment.assignmentId, assignment.workItemId, assignment.assignmentKind, assignment.laneId,
    assignment.roleRequirementId, assignment.roleId, assignment.roleGeneration, 1, 1, options.workItemRevision, TARGET_ID, assignment.branchName,
    assignment.baseSha, assignment.candidateSemantics, assignment.candidateSha, assignment.environment.bbServerId,
    assignment.environment.environmentId, assignment.environment.sourceId, assignment.environment.hostId,
    assignment.environment.path, "managed-worktree", assignment.frozenBriefVersion, assignment.frozenBriefDigest,
    assignment.requestedProfile.providerId, assignment.requestedProfile.model, assignment.requestedProfile.reasoningLevel,
    assignment.requestedProfile.permissionMode, assignment.requestedProfile.serviceTier, "visible", ROLE_PROFILE_DIGEST,
    assignment.dispatchKind, null, null, 0, assignment.deadlineAtMs, assignmentDigest, template.idempotencyKey, creationEventSequence, now,
  );
  db.prepare(`
    INSERT INTO execution_attempts (
      project_id, execution_attempt_id, assignment_id, origin, assignment_digest, lane_id,
      assignment_kind, attempt_ordinal, dispatch_kind, config_revision, governance_epoch,
      work_item_id, repo_target_id, role_id, role_generation, state, bb_server_id,
      environment_id, source_id, host_id, environment_path, frozen_brief_digest,
      branch_name, base_sha, candidate_sha, environment_digest, created_at_ms, attempt_digest
    ) VALUES (?, ?, ?, 'assignment', ?, ?, ?, 1, ?, 1, 1, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    PROJECT_ID, executionAttemptId, assignment.assignmentId, assignmentDigest, assignment.laneId, assignment.assignmentKind,
    assignment.dispatchKind, assignment.workItemId, TARGET_ID, assignment.roleId, assignment.roleGeneration,
    assignment.environment.bbServerId, assignment.environment.environmentId, assignment.environment.sourceId,
    assignment.environment.hostId, assignment.environment.path, assignment.frozenBriefDigest, assignment.branchName,
    assignment.baseSha, assignment.candidateSha, sha256(canonicalJson(assignment.environment)), now,
    sha256(canonicalJson({ projectId: PROJECT_ID, executionAttemptId, assignmentDigest, state: "prepared" })),
  );
  return executionAttemptId;
}

async function addPendingReview(fixture: Awaited<ReturnType<typeof fleetWatchdogFixture>>) {
  activateReviewer(fixture.db, fixture.fenceToken);
  expect(applyWithFixtureReceipt(fixture.db, transitionRequest(fixture.fenceToken, "in_progress", 2)).outcome).toBe("OK");
  return insertFixtureAssignment(fixture.db, fixture.fenceToken, {
    assignmentId: "pending-review",
    assignmentKind: "review",
    laneId: "pending-review",
    roleRequirementId: "reviewer-v1",
    roleId: "independent-reviewer",
    roleGeneration: 2,
    candidateSha: CANDIDATE_SHA,
    workItemRevision: 3,
    executionAttemptId: "pending-review-attempt",
  });
}

// Parses a watchdog quiet line the way a recipient would: every timestamp must
// name the evidence class that backs it. Quiet is only ever proven at a cycle
// receipt; only the open-work clause may carry a `since` anchor.
function parseEmittedQuietClaim(text: string): { subject: string; still: boolean; quietAtMs: number; openSinceMs: number } | null {
  const match = /^(?<subject>fleet|owed act)(?<still> still)? quiet at cycle (?<cycle>\S+) with open work since (?<anchor>\S+)$/.exec(text);
  if (!match?.groups) return null;
  const quietAtMs = Date.parse(match.groups.cycle!);
  const openSinceMs = Date.parse(match.groups.anchor!);
  if (Number.isNaN(quietAtMs) || Number.isNaN(openSinceMs)) return null;
  return { subject: match.groups.subject!, still: match.groups.still !== undefined, quietAtMs, openSinceMs };
}

function cloneProject(db: Database.Database, sourceProjectId: string, targetProjectId: string) {
  const clone = (table: string, where = "", mutate?: (row: Record<string, unknown>) => void) => {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
    const rows = db.prepare(`SELECT * FROM ${table} WHERE project_id = ?${where}`).all(sourceProjectId) as Record<string, unknown>[];
    const insert = db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
    for (const row of rows) {
      row.project_id = targetProjectId;
      mutate?.(row);
      insert.run(...columns.map((column) => row[column]));
    }
  };
  clone("project_config_revisions");
  clone("project_config_heads");
  clone("repository_targets");
  clone("work_items");
  clone("qualification_observations");
  clone("execution_attempts", " AND origin = 'role_holder'", (row) => {
    row.thread_id = row.role_id === "director" ? "director-two" : row.role_id === "project-orchestrator" ? "orchestrator-two" : `reviewer-two-${row.role_generation}`;
  });
  clone("role_generations");
  clone("role_generation_heads");
  clone("assignments");
  clone("execution_attempts", " AND origin = 'assignment'");
}

function advanceDirector(db: Database.Database, fenceToken: string) {
  const roleContext = {
    threadId: "director-successor",
    requestEventId: "director-successor-request",
    requestEventSeq: 1,
    completionEventId: "director-successor-completion",
    completionEventSeq: 4,
  };
  const facts = directorRoleReader((input) => {
    input.thread.id = roleContext.threadId;
    input.thread.environmentId = "director-successor-environment";
    input.environment.id = "director-successor-environment";
    input.events[0]!.id = roleContext.requestEventId;
    input.events[3]!.id = roleContext.completionEventId;
  });
  expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
    idempotencyKey: "qualification-director-successor",
    roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
    qualificationId: "qualification-director-successor",
    declaredProfile: DIRECTOR_PROFILE,
    roleContext,
  }), null, facts).outcome).toBe("OK");
  expect(applyWithFixtureReceipt(db, successionRequest(fenceToken, {
    idempotencyKey: "succession-director-successor",
    roleId: "director",
    roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
    qualificationId: "qualification-director-successor",
    profileDigest: DIRECTOR_PROFILE_DIGEST,
    expectedGeneration: 1,
    predecessorGeneration: 1,
    roleContext,
  }), null, facts).outcome).toBe("OK");
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

function seedCurrentOrchestratorActor(db: Database.Database, fenceToken: string, receiptId = "cached-consumer-current-role"): string {
  expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken), null, roleReader()).outcome).toBe("OK");
  const succession = applyWithFixtureReceipt(db, successionRequest(fenceToken), null, roleReader());
  expect(succession.outcome).toBe("OK");
  seedVerifiedFixtureReceipt(db, {
    projectId: PROJECT_ID,
    receiptId,
    actorKind: "role",
    subjectId: (succession.evidence as { holderExecutionAttemptId: string }).holderExecutionAttemptId,
    roleId: "project-orchestrator",
    roleGeneration: 1,
  });
  return receiptId;
}

describe("checkout divergence detection", () => {
  it("plugin-load invariant is true by construction under checkout adversaries", async () => {
    const fifoCheckout = mkdtempSync(join(tmpdir(), "bb-collab-fifo-checkout-"));
    mkdirSync(join(fifoCheckout, ".git"));
    execFileSync("mkfifo", [join(fifoCheckout, ".git", "HEAD")]);
    const missingGitCheckout = mkdtempSync(join(tmpdir(), "bb-collab-no-git-"));
    const bin = mkdtempSync(join(tmpdir(), "bb-collab-hostile-git-"));
    const wrapper = join(bin, "git");
    writeFileSync(wrapper, "#!/bin/sh\n( trap \"\" TERM; while :; do :; done ) &\nchild=$!\nprintf '%s\\n' \"$child\" > \"${HOSTILE_GIT_PID_FILE}\"\ntrap \"\" TERM\nwhile :; do :; done\n");
    chmodSync(wrapper, 0o755);
    const originalPath = process.env.PATH;
    const originalPidFile = process.env.HOSTILE_GIT_PID_FILE;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env.HOSTILE_GIT_PID_FILE = join(bin, "grandchild.pid");
    const started = Date.now();
    try {
      await expect(Promise.all([
        plugin(hostFor().bb, { checkoutRoot: fifoCheckout }),
        plugin(hostFor().bb, { checkoutRoot: missingGitCheckout }),
      ])).resolves.toEqual([undefined, undefined]);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalPidFile === undefined) delete process.env.HOSTILE_GIT_PID_FILE;
      else process.env.HOSTILE_GIT_PID_FILE = originalPidFile;
      rmSync(fifoCheckout, { recursive: true, force: true });
      rmSync(missingGitCheckout, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 5_000);

  it("reports an unavailable checkout through doctor RPC and CLI", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-collab-no-git-"));
    try {
      const host = hostFor();
      await plugin(host.bb, { checkoutRoot: directory });
      seedAndBootstrap(host);
      const expected = { checkoutHead: null, originMainRef: null, behindCount: null, verdict: "unavailable" };
      const rpc = await host.harness.callRpc("doctor", { projectId: PROJECT_ID }) as FoundationResult;
      expect(rpc.evidence).toMatchObject({ checkoutDivergence: expected });
      const cli = await host.harness.runCli(["doctor", "--project", PROJECT_ID]);
      expect(JSON.parse(cli.stdout).evidence).toMatchObject({ checkoutDivergence: expected });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds the doctor probe against a hostile git on the real checkout geometry", () => {
    const bin = mkdtempSync(join(tmpdir(), "bb-collab-hostile-git-"));
    const wrapper = join(bin, "git");
    writeFileSync(wrapper, "#!/bin/sh\ntrap \"\" TERM\nwhile :; do :; done\n");
    chmodSync(wrapper, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    const started = Date.now();
    try {
      readCheckoutDivergence(findCheckoutRoot(process.cwd()));
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("kills the complete doctor probe process group", async () => {
    const fixture = checkoutFixture(true);
    const bin = mkdtempSync(join(tmpdir(), "bb-collab-forking-git-"));
    const pidFile = join(bin, "grandchild.pid");
    const wrapper = join(bin, "git");
    writeFileSync(wrapper, `#!/bin/sh
( trap "" TERM; while :; do :; done ) &
child=$!
printf '%s\\n' "$child" > "${pidFile}"
trap "" TERM
while :; do :; done
`);
    chmodSync(wrapper, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    let childPid: number | null = null;
    try {
      const result = readCheckoutDivergence(fixture.directory);
      expect(result).toMatchObject({ checkoutHead: fixture.base, originMainRef: fixture.origin, behindCount: null, verdict: "diverged" });
      childPid = Number(readFileSync(pidFile, "utf8").trim());
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          process.kill(childPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch {
          break;
        }
      }
      expect(() => process.kill(childPid!, 0)).toThrow();
    } finally {
      if (childPid !== null) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The process-group assertion may already have reaped it.
        }
      }
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(fixture.directory, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("reaps a clean-exit doctor probe process group", async () => {
    const fixture = checkoutFixture(true);
    const bin = mkdtempSync(join(tmpdir(), "bb-collab-clean-exit-git-"));
    const pidFile = join(bin, "grandchild.pid");
    const wrapper = join(bin, "git");
    writeFileSync(wrapper, `#!/bin/sh
( exec sleep 300 ) </dev/null >/dev/null 2>&1 &
child=$!
printf '%s\\n' "$child" > "${pidFile}"
printf '1\\n'
exit 0
`);
    chmodSync(wrapper, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    let childPid: number | null = null;
    try {
      const result = readCheckoutDivergence(fixture.directory);
      expect(result).toMatchObject({ checkoutHead: fixture.base, originMainRef: fixture.origin, behindCount: 1, verdict: "diverged", processGroupReap: "reaped" });
      childPid = Number(readFileSync(pidFile, "utf8").trim());
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          process.kill(childPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch {
          break;
        }
      }
      expect(() => process.kill(childPid!, 0)).toThrow();
    } finally {
      if (childPid !== null) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The process-group assertion may already have reaped it.
        }
      }
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(fixture.directory, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("records a setsid escapee without changing the divergence result", async () => {
    const fixture = checkoutFixture(true);
    const bin = mkdtempSync(join(tmpdir(), "bb-collab-setsid-git-"));
    const pidFile = join(bin, "escapee.pid");
    const wrapper = join(bin, "git");
    writeFileSync(wrapper, `#!/bin/sh
perl -MPOSIX -e 'defined(my $pid = fork()) or die; exit if $pid; POSIX::setsid() or die; open my $file, ">", $ARGV[0] or die; print $file "$$\\n"; close $file or die; $SIG{HUP} = $SIG{TERM} = $SIG{INT} = "IGNORE"; sleep 300' "${pidFile}" </dev/null >/dev/null 2>&1 &
trap "" TERM
while :; do :; done
`);
    chmodSync(wrapper, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    let childPid: number | null = null;
    try {
      const result = readCheckoutDivergence(fixture.directory);
      expect(result).toMatchObject({ checkoutHead: fixture.base, originMainRef: fixture.origin, behindCount: null, verdict: "diverged", processGroupReap: "absent" });
      childPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(Number.isInteger(childPid)).toBe(true);
      expect(childPid).toBeGreaterThan(0);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          process.kill(childPid, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(() => process.kill(childPid!, 0)).not.toThrow();
    } finally {
      if (childPid !== null) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The escapee may already have exited.
        }
      }
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(fixture.directory, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("surfaces non-ESRCH doctor probe process-group reap failures", () => {
    const fixture = checkoutFixture(true);
    const bin = mkdtempSync(join(tmpdir(), "bb-collab-failed-reap-git-"));
    const pidFile = join(bin, "grandchild.pid");
    const wrapper = join(bin, "git");
    writeFileSync(wrapper, `#!/bin/sh
( exec sleep 300 ) </dev/null >/dev/null 2>&1 &
child=$!
printf '%s\\n' "$child" > "${pidFile}"
printf '1\\n'
exit 0
`);
    chmodSync(wrapper, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    const realKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      return realKill(pid, signal);
    });
    let childPid: number | null = null;
    try {
      const result = readCheckoutDivergence(fixture.directory);
      expect(result).toMatchObject({ checkoutHead: fixture.base, originMainRef: fixture.origin, behindCount: null, verdict: "unavailable", processGroupReap: "failed" });
      childPid = Number(readFileSync(pidFile, "utf8").trim());
    } finally {
      killSpy.mockRestore();
      if (childPid === null) {
        try {
          childPid = Number(readFileSync(pidFile, "utf8").trim());
        } catch {
          // The wrapper may have failed before recording its child.
        }
      }
      if (childPid !== null) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The child may already have exited.
        }
      }
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(fixture.directory, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("does not lazy-fetch while counting divergence", () => {
    const fixture = checkoutFixture(true);
    const bin = mkdtempSync(join(tmpdir(), "bb-collab-git-probe-"));
    const argsLog = join(bin, "args");
    const envLog = join(bin, "env");
    const wrapper = join(bin, "git");
    const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsLog}"\nprintf '%s\\n' "$GIT_NO_LAZY_FETCH" > "${envLog}"\nexec "${gitPath}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      readCheckoutDivergence(fixture.directory);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(fixture.directory, { recursive: true, force: true });
    }
    const args = readFileSync(argsLog, "utf8").split("\n");
    expect(args).toEqual(["rev-list", "--count", expect.stringContaining(".."), ""]);
    expect(readFileSync(envLog, "utf8")).toBe("1\n");
    rmSync(bin, { recursive: true, force: true });
  });

  it("reports a diverged fixture through doctor", async () => {
    const fixture = checkoutFixture(true);
    try {
      const divergence = readCheckoutDivergence(fixture.directory);
      expect(divergence).toMatchObject({ checkoutHead: fixture.base, originMainRef: fixture.origin, behindCount: 1, verdict: "diverged" });
      const host = await loadedHost();
      seedAndBootstrap(host);
      const result = await doctor(host.bb.storage.database(), host.bb.sdk, PROJECT_ID, divergence);
      expect(result.evidence).toMatchObject({ checkoutDivergence: { checkoutHead: fixture.base, originMainRef: fixture.origin, behindCount: 1, verdict: "diverged" } });
      const cli = await host.harness.runCli(["doctor", "--project", PROJECT_ID]);
      const currentCheckout = readCheckoutDivergence(findCheckoutRoot(process.cwd()));
      expect(JSON.parse(cli.stdout).evidence).toMatchObject({ checkoutDivergence: currentCheckout });
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("stays silent for a clean fixture and reports a clean doctor verdict", async () => {
    const fixture = checkoutFixture(false);
    try {
      const divergence = readCheckoutDivergence(fixture.directory);
      expect(divergence).toMatchObject({ checkoutHead: fixture.base, originMainRef: fixture.origin, behindCount: 0, verdict: "clean" });
      const host = await loadedHost();
      seedAndBootstrap(host);
      const result = await doctor(host.bb.storage.database(), host.bb.sdk, PROJECT_ID, divergence);
      expect(result.evidence).toMatchObject({ checkoutDivergence: { checkoutHead: fixture.base, originMainRef: fixture.origin, behindCount: 0, verdict: "clean" } });
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});

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
const MIGRATION_ACTOR_RECEIPT_ID = "migration-current-role";
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
  seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
  const bootstrap = applyWithFixtureReceipt(db, bootstrapRequest(PROJECT_ID, { config: roleConfig() }));
  expect(bootstrap.outcome).toBe("OK");
  const actorReceiptId = seedCurrentOrchestratorActor(db, (bootstrap.evidence as { fenceToken: string }).fenceToken, MIGRATION_ACTOR_RECEIPT_ID);
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
  ).run(MIGRATION_DECISION_ID, actorReceiptId, canonicalJson({ reason: "fixture cutover authorized" }));
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
    actorReceiptId: MIGRATION_ACTOR_RECEIPT_ID,
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
    actorReceiptId: MIGRATION_ACTOR_RECEIPT_ID,
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
  targetRemoteUrl?: string;
  withoutGithubIssues?: boolean;
  directorSeat?: boolean;
  orchestratorSeat?: boolean;
} = {}) {
  const host = await loadedHost();
  const directorSeat = options.directorSeat === true;
  const orchestratorSeat = options.orchestratorSeat === true;
  const config = directorSeat ? (orchestratorSeat ? directorAndOrchestratorConfig() : directorSeatConfig()) : roleConfig(options.connectorPolicy);
  if (options.withoutGithubIssues) delete (config.extensions.bbCollab as Record<string, unknown>).githubIssues;
  if (options.writingLaneCeiling !== undefined) {
    (config.extensions.bbCollab as Record<string, unknown>).writingLaneCeiling = options.writingLaneCeiling;
  }
  const targets = options.targetDefaultBranch || options.targetRemoteUrl
    ? bootstrapRequest().targets!.map((target) => ({ ...target, ...(options.targetDefaultBranch ? { defaultBranch: options.targetDefaultBranch } : {}), ...(options.targetRemoteUrl ? { remoteUrl: options.targetRemoteUrl } : {}) }))
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
  if (orchestratorSeat) {
    const roleContext = {
      threadId: "thread-fleet-orchestrator",
      requestEventId: "event-fleet-orchestrator-request",
      requestEventSeq: 1,
      completionEventId: "event-fleet-orchestrator-completion",
      completionEventSeq: 4,
    };
    const facts = () => roleReader((input) => {
      input.thread.id = roleContext.threadId;
      input.thread.environmentId = "environment-fleet-orchestrator";
      input.environment.id = "environment-fleet-orchestrator";
      input.events[0]!.id = roleContext.requestEventId;
      input.events[3]!.id = roleContext.completionEventId;
    });
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
      idempotencyKey: "qualification-fleet-orchestrator",
      qualificationId: "qualification-fleet-orchestrator",
      roleContext,
    }), null, facts()).outcome).toBe("OK");
    const orchestrator = applyWithFixtureReceipt(db, successionRequest(fenceToken, {
      idempotencyKey: "succession-fleet-orchestrator",
      qualificationId: "qualification-fleet-orchestrator",
      roleContext,
    }), null, facts());
    expect(orchestrator.outcome).toBe("OK");
  }
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
): any {
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
    expect(rpc).toMatchObject({ outcome: "ACTOR_RECEIPT_UNKNOWN", expected: 1, attempted: 0, verified: 0 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    const cli = await host.harness.runCli([
      "apply",
      "--project",
      PROJECT_ID,
      "--request",
      JSON.stringify(request),
    ]);
    expect(cli.exitCode).toBe(2);
    expect(JSON.parse(cli.stdout)).toMatchObject({ outcome: "ACTOR_RECEIPT_UNKNOWN" });
    expect(host.harness.inspection.registrations.services.map((service) => service.name)).toEqual(["lane-watcher"]);
    expect(host.harness.inspection.registrations.schedules.map((schedule) => schedule.name)).toEqual(["wait-validator-liveness", "stall-guard-liveness", "fleet-watchdog", "thread-archive-sweep"]);
    expect(host.harness.inspection.registrations.rpcMethods.sort()).toEqual(["apply", "cachedConsumerRollout", "doctor", "export", "lanes", "markOperatorMessageRead", "operatorMessages", "registerWait", "reorderPinned", "replyToOperatorMessage", "roleBrief", "setSidebarCollapse", "setThreadState", "sidebarCollapseState", "threadModels", "threadStates"]);
    expect(host.harness.inspection.registrations.agentTools.map((tool) => tool.name)).toEqual(["send_to_operator"]);
  });

  it("stores messages only under the sender's registered project and deduplicates exact urgent content for one hour", async () => {
    const runBbCommand = vi.fn(async (_args: string[]) => undefined);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const host = hostFor();
      await plugin(host.bb, { runBbCommand });
      seedAndBootstrap(host);
      const context = { threadId: ROLE_THREAD_ID, projectId: PROJECT_ID };
      const send = (recipient: "operator" | "supervisor", text: string) => host.harness.callAgentTool("send_to_operator", {
        project_id: PROJECT_ID,
        recipient,
        severity: "urgent",
        text,
      }, context);

      const first = JSON.parse(await send("operator", "same urgent") as string);
      const duplicate = JSON.parse(await send("operator", "same urgent") as string);
      const differentText = JSON.parse(await send("operator", "different urgent") as string);
      const differentRecipient = JSON.parse(await send("supervisor", "same urgent") as string);
      clock.mockReturnValue(1_000_000 + URGENT_NOTIFICATION_DEDUP_MS + 1);
      const afterWindow = JSON.parse(await send("operator", "same urgent") as string);

      expect(first).toMatchObject({ projectId: PROJECT_ID, recipient: "operator", senderThreadId: ROLE_THREAD_ID, notificationStatus: "sent" });
      expect(duplicate).toMatchObject({ notificationStatus: "deduplicated" });
      expect(differentText).toMatchObject({ notificationStatus: "sent" });
      expect(differentRecipient).toMatchObject({ notificationStatus: "sent" });
      expect(afterWindow).toMatchObject({ notificationStatus: "sent" });
      expect(runBbCommand).toHaveBeenCalledTimes(8);
      expect(runBbCommand.mock.calls.filter(([args]) => args[0] === "notify")).toHaveLength(4);
      expect(runBbCommand.mock.calls.filter(([args]) => args[0] === "push")).toHaveLength(4);

      const cli = await host.harness.runCli([
        "send-to-operator", "--project", PROJECT_ID, "--recipient", "supervisor", "--severity", "routine", "--message", "supervisor pickup",
      ], context);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout)).toMatchObject({ projectId: PROJECT_ID, recipient: "supervisor", notificationStatus: "not-requested" });
      const titleReadsBeforeList = host.harness.inspection.sdk.callsTo("threads.get").length;
      expect(await host.harness.callRpc("operatorMessages", { projectId: PROJECT_ID })).toHaveLength(6);
      expect(host.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(titleReadsBeforeList);
      expect(await host.harness.callRpc("operatorMessages", { projectId: PROJECT_ID, withSenderTitles: true })).toEqual(
        expect.arrayContaining([expect.objectContaining({ senderThreadId: ROLE_THREAD_ID, senderTitle: "Managed role holder" })]),
      );
      expect(host.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(titleReadsBeforeList + 1);
      expect(await host.harness.callRpc("operatorMessages", { projectId: PROJECT_ID, recipient: "supervisor" })).toHaveLength(2);
      await expect(host.harness.callRpc("operatorMessages", { projectId: FOREIGN_PROJECT_ID })).rejects.toThrow("not registered");
      await expect(host.harness.callAgentTool("send_to_operator", {
        project_id: FOREIGN_PROJECT_ID,
        recipient: "operator",
        severity: "routine",
        text: "wrong project",
      }, context)).rejects.toThrow("project_id must exactly match");
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps inbox messages readable when a sender title cannot be resolved", async () => {
    const host = hostFor();
    await plugin(host.bb, { notifyUrgent: async () => undefined });
    seedAndBootstrap(host);
    await host.harness.callAgentTool("send_to_operator", {
      project_id: PROJECT_ID,
      recipient: "operator",
      severity: "routine",
      text: "sender may disappear",
    }, { threadId: ROLE_THREAD_ID, projectId: PROJECT_ID });
    host.harness.sdk.stub("threads.get", async () => { throw new Error("thread no longer exists"); });

    await expect(host.harness.callRpc("operatorMessages", { projectId: PROJECT_ID, withSenderTitles: true })).resolves.toEqual([
      expect.objectContaining({ senderThreadId: ROLE_THREAD_ID, senderTitle: null }),
    ]);
  });

  it("attempts both notification channels and leaves a visible failure", async () => {
    const runBbCommand = vi.fn(async (args: string[]) => {
      if (args[0] === "notify") throw new Error("desktop unavailable");
    });
    const host = hostFor();
    await plugin(host.bb, { runBbCommand });
    seedAndBootstrap(host);

    const message = JSON.parse(await host.harness.callAgentTool("send_to_operator", {
      project_id: PROJECT_ID,
      recipient: "operator",
      severity: "urgent",
      text: "urgent with one broken channel",
    }, { threadId: ROLE_THREAD_ID, projectId: PROJECT_ID }) as string);
    expect(runBbCommand.mock.calls.map(([args]) => args[0]).sort()).toEqual(["notify", "push"]);
    expect(message).toMatchObject({ notificationStatus: "failed", notificationError: expect.stringContaining("desktop unavailable") });
  });

  it("marks an inbox message read through the project-exact CLI without moving its timestamp", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const host = hostFor();
      await plugin(host.bb, { notifyUrgent: async () => undefined });
      const { db } = seedAndBootstrap(host);
      const message = JSON.parse(await host.harness.callAgentTool("send_to_operator", {
        project_id: PROJECT_ID,
        recipient: "supervisor",
        severity: "routine",
        text: "supervisor pickup",
      }, { threadId: ROLE_THREAD_ID, projectId: PROJECT_ID }) as string);

      clock.mockReturnValue(1_100_000);
      const first = await host.harness.runCli(["inbox", "--project", PROJECT_ID, "--mark-read", String(message.messageId)]);
      expect(first.exitCode).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({ projectId: PROJECT_ID, messageId: message.messageId, readAtMs: 1_100_000 });

      clock.mockReturnValue(1_200_000);
      const second = await host.harness.runCli(["inbox", "--project", PROJECT_ID, "--mark-read", String(message.messageId)]);
      expect(second.exitCode).toBe(0);
      expect(JSON.parse(second.stdout)).toMatchObject({ projectId: PROJECT_ID, messageId: message.messageId, readAtMs: 1_100_000 });

      const wrongProject = await host.harness.runCli(["inbox", "--project", FOREIGN_PROJECT_ID, "--mark-read", String(message.messageId)]);
      expect(wrongProject.exitCode).toBe(2);
      expect(db.prepare("SELECT read_at_ms FROM operator_messages WHERE project_id = ? AND message_id = ?").get(PROJECT_ID, message.messageId))
        .toEqual({ read_at_ms: 1_100_000 });
    } finally {
      clock.mockRestore();
    }
  });

  it("delivers replies through platform steer only after the matching sender event lands", async () => {
    const host = hostFor();
    await plugin(host.bb, { notifyUrgent: async () => undefined });
    seedAndBootstrap(host);
    const sent: Array<{ mode: string; text: string }> = [];
    host.harness.sdk.stub("threads.wait", (async () => ({ matched: true })) as never);
    host.harness.sdk.stub("threads.send", (async (input: { mode: string; input: Array<{ text: string }> }) => {
      sent.push({ mode: input.mode, text: input.input[0]!.text });
      return { ok: true };
    }) as never);
    host.harness.sdk.stub("threads.events.wait", (async ({ threadId }: { threadId: string }) => ({
      id: "event-delivered",
      threadId,
      seq: 99,
      type: "client/turn/requested",
      scope: { kind: "thread" },
      data: { source: "tell", input: [{ type: "text", text: `${sent.at(-1)!.text}\n`, mentions: [] }] },
      createdAt: 99,
    })) as never);
    const message = JSON.parse(await host.harness.callAgentTool("send_to_operator", {
      project_id: PROJECT_ID,
      recipient: "operator",
      severity: "routine",
      text: "needs an answer",
    }, { threadId: ROLE_THREAD_ID, projectId: PROJECT_ID }) as string);

    const replied = await host.harness.callRpc("replyToOperatorMessage", { projectId: PROJECT_ID, messageId: message.messageId, text: "answer" });
    expect(sent).toEqual([{ mode: "steer", text: `[bb-collab inbox reply ${message.messageId} to operator]\nanswer` }]);
    expect(replied).toMatchObject({ repliedAtMs: expect.any(Number), replyText: "answer", replyDeliveryError: null, readAtMs: expect.any(Number) });
    await expect(host.harness.callRpc("replyToOperatorMessage", { projectId: PROJECT_ID, messageId: message.messageId, text: "duplicate" }))
      .rejects.toThrow("already has a delivered reply");
  });

  it("atomically claims one delivery when two callers reply to the same operator message", async () => {
    const host = hostFor();
    await plugin(host.bb, { notifyUrgent: async () => undefined });
    seedAndBootstrap(host);
    const sent: string[] = [];
    host.harness.sdk.stub("threads.wait", (async () => ({ matched: true })) as never);
    host.harness.sdk.stub("threads.send", (async (input: { input: Array<{ text: string }> }) => {
      sent.push(input.input[0]!.text);
      return { ok: true };
    }) as never);
    host.harness.sdk.stub("threads.events.wait", (async ({ threadId }: { threadId: string }) => ({
      id: "event-delivered",
      threadId,
      seq: 99,
      type: "client/turn/requested",
      scope: { kind: "thread" },
      data: { source: "tell", input: [{ type: "text", text: sent.at(-1)!, mentions: [] }] },
      createdAt: 99,
    })) as never);
    const message = JSON.parse(await host.harness.callAgentTool("send_to_operator", {
      project_id: PROJECT_ID,
      recipient: "operator",
      severity: "routine",
      text: "one reply only",
    }, { threadId: ROLE_THREAD_ID, projectId: PROJECT_ID }) as string);

    const replies = await Promise.all([
      host.harness.callRpc("replyToOperatorMessage", { projectId: PROJECT_ID, messageId: message.messageId, text: "first" }),
      host.harness.callRpc("replyToOperatorMessage", { projectId: PROJECT_ID, messageId: message.messageId, text: "second" }),
    ]);
    expect(sent).toHaveLength(1);
    expect(replies).toEqual(expect.arrayContaining([
      expect.objectContaining({ repliedAtMs: expect.any(Number), replyInProgress: false }),
      expect.objectContaining({ repliedAtMs: null, replyInProgress: true }),
    ]));
  });

  it("waits for the inbox sender thread to become idle before delivering its reply", async () => {
    const host = hostFor();
    await plugin(host.bb, { notifyUrgent: async () => undefined });
    seedAndBootstrap(host);
    let releaseIdle!: () => void;
    const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
    host.harness.sdk.stub("threads.wait", (async () => { await idle; return { matched: true }; }) as never);
    host.harness.sdk.stub("threads.send", (async () => ({ ok: true })) as never);
    host.harness.sdk.stub("threads.events.wait", (async ({ threadId }: { threadId: string }) => ({
      id: "event-delivered",
      threadId,
      seq: 99,
      type: "client/turn/requested",
      scope: { kind: "thread" },
      data: { source: "tell", input: [{ type: "text", text: "[bb-collab inbox reply 1 to operator]\nanswer", mentions: [] }] },
      createdAt: 99,
    })) as never);
    const message = JSON.parse(await host.harness.callAgentTool("send_to_operator", {
      project_id: PROJECT_ID,
      recipient: "operator",
      severity: "routine",
      text: "reply while active",
    }, { threadId: ROLE_THREAD_ID, projectId: PROJECT_ID }) as string);

    const delivery = host.harness.callRpc("replyToOperatorMessage", { projectId: PROJECT_ID, messageId: message.messageId, text: "answer" });
    await vi.waitFor(() => expect(
      host.harness.inspection.sdk.callsTo("threads.wait").length + host.harness.inspection.sdk.callsTo("threads.send").length,
    ).toBeGreaterThan(0));
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    releaseIdle();
    await expect(delivery).resolves.toMatchObject({ repliedAtMs: expect.any(Number), replyDeliveryError: null });
    expect(host.harness.inspection.sdk.callsTo("threads.wait")).toEqual([[
      { threadId: ROLE_THREAD_ID, status: "idle", timeoutMs: 30_000 },
    ]]);
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("persists an inbox reply failure and releases its in-process guard for retry", async () => {
    const host = hostFor();
    await plugin(host.bb, { notifyUrgent: async () => undefined });
    seedAndBootstrap(host);
    let timeout = true;
    host.harness.sdk.stub("threads.wait", (async () => {
      if (timeout) throw new Error("idle wait timed out");
      return { matched: true };
    }) as never);
    host.harness.sdk.stub("threads.send", (async () => ({ ok: true })) as never);
    host.harness.sdk.stub("threads.events.wait", (async ({ threadId }: { threadId: string }) => ({
      id: "event-delivered",
      threadId,
      seq: 99,
      type: "client/turn/requested",
      scope: { kind: "thread" },
      data: { source: "tell", input: [{ type: "text", text: "[bb-collab inbox reply 1 to operator]\nretry", mentions: [] }] },
      createdAt: 99,
    })) as never);
    const message = JSON.parse(await host.harness.callAgentTool("send_to_operator", {
      project_id: PROJECT_ID,
      recipient: "operator",
      severity: "routine",
      text: "reply while never idle",
    }, { threadId: ROLE_THREAD_ID, projectId: PROJECT_ID }) as string);

    const replied = await host.harness.callRpc("replyToOperatorMessage", { projectId: PROJECT_ID, messageId: message.messageId, text: "answer" });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(replied).toMatchObject({
      readAtMs: expect.any(Number),
      repliedAtMs: null,
      replyText: "answer",
      replyDeliveryError: "Error: idle wait timed out",
      replyInProgress: false,
    });

    timeout = false;
    await expect(host.harness.callRpc("replyToOperatorMessage", {
      projectId: PROJECT_ID,
      messageId: message.messageId,
      text: "retry",
    })).resolves.toMatchObject({ repliedAtMs: expect.any(Number), replyText: "retry", replyInProgress: false });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("records an accepted reply tell as failed when no matching sender event lands", async () => {
    const host = hostFor();
    await plugin(host.bb, { notifyUrgent: async () => undefined });
    seedAndBootstrap(host);
    host.harness.sdk.stub("threads.wait", (async () => ({ matched: true })) as never);
    host.harness.sdk.stub("threads.send", (async () => ({ ok: true })) as never);
    host.harness.sdk.stub("threads.events.wait", (async () => null) as never);
    const message = JSON.parse(await host.harness.callAgentTool("send_to_operator", {
      project_id: PROJECT_ID,
      recipient: "operator",
      severity: "routine",
      text: "needs delivery proof",
    }, { threadId: ROLE_THREAD_ID, projectId: PROJECT_ID }) as string);

    const replied = await host.harness.callRpc("replyToOperatorMessage", { projectId: PROJECT_ID, messageId: message.messageId, text: "unconfirmed" });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(replied).toMatchObject({ repliedAtMs: null, replyText: "unconfirmed", replyDeliveryError: expect.stringContaining("no matching sender-thread input event") });
  });

  it("persists a visible reply failure when the sender environment is gone", async () => {
    const host = hostFor();
    await plugin(host.bb, { notifyUrgent: async () => undefined });
    seedAndBootstrap(host);
    const message = JSON.parse(await host.harness.callAgentTool("send_to_operator", {
      project_id: PROJECT_ID,
      recipient: "operator",
      severity: "routine",
      text: "reply to a dead sender",
    }, { threadId: ROLE_THREAD_ID, projectId: PROJECT_ID }) as string);
    host.harness.sdk.stub("environments.get", (async () => { throw new Error("environment deleted"); }) as never);

    const replied = await host.harness.callRpc("replyToOperatorMessage", { projectId: PROJECT_ID, messageId: message.messageId, text: "cannot vanish" });
    expect(replied).toMatchObject({ repliedAtMs: null, replyText: "cannot vanish", replyDeliveryError: expect.stringContaining("environment deleted") });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("does not wake a quiet director seat", async () => {
    const fixture = await fleetWatchdogFixture();
    const cron = fixture.host.harness.inspection.registrations.schedules.find((schedule) => schedule.name === "fleet-watchdog")?.cron;
    if (cron !== "0 * * * *") {
      throw new Error(`expected registered fleet-watchdog cron "0 * * * *", got "${cron}"\nDRILL BUILD ACTIVE - restore the production cron before merge (teardown item 3)`);
    }
    await fixture.host.harness.runSchedule("fleet-watchdog");
    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(fixture.host.harness.inspection.logEntries).toContainEqual(expect.objectContaining({
      level: "info",
      message: "fleet-watchdog coverage=visible seats=2 lanes=0 cannotSee=none",
    }));
  });

  it("waits for a wrongful-idle target to become idle and names its canonical startable WorkItem", async () => {
    const fixture = await fleetWatchdogFixture(0);
    let artifact = "before";
    fixture.host.harness.sdk.stub("environments.pullRequest", (async () => artifact === "before"
      ? { outcome: "absent" }
      : { outcome: "available", pullRequest: { updatedAt: artifact } }) as never);
    fixture.host.harness.sdk.stub("threads.get", (async ({ threadId }: { threadId: string }) => makeThreadResponse({
      id: threadId,
      projectId: PROJECT_ID,
      status: "idle",
      environmentId: `environment-${threadId}`,
      updatedAt: 0,
    })) as never);
    let releaseIdle!: () => void;
    const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
    fixture.host.harness.sdk.stub("threads.wait", (async () => { await idle; return { matched: true }; }) as never);

    expect((await fixture.host.harness.runCli(["stall-guard", "--cycle", "--project", PROJECT_ID])).exitCode).toBe(0);
    artifact = "after";
    const cycle = fixture.host.harness.runCli(["stall-guard", "--cycle", "--project", PROJECT_ID]);
    await vi.waitFor(() => expect(
      fixture.host.harness.inspection.sdk.callsTo("threads.wait").length + fixture.host.harness.inspection.sdk.callsTo("threads.send").length,
    ).toBeGreaterThan(0));
    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    releaseIdle();
    await expect(cycle).resolves.toMatchObject({ exitCode: 0 });
    expect(fixture.host.harness.inspection.sdk.callsTo("threads.wait").length).toBeGreaterThan(0);
    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toEqual(expect.arrayContaining([[
      expect.objectContaining({
        input: [expect.objectContaining({
          text: `Wrongful idle: queue head ${WORK_ITEM_ID} is startable. Inspect the queue and act or record the blocker.`,
        })],
      }),
    ]]));
  });

  it("does not fire wrongful-idle when canonical WorkItems are only in progress", async () => {
    const fixture = await fleetWatchdogFixture(0);
    expect(applyWithFixtureReceipt(fixture.db, transitionRequest(fixture.fenceToken, "in_progress", 2))).toMatchObject({ outcome: "OK" });
    let artifact = "before";
    fixture.host.harness.sdk.stub("environments.pullRequest", (async () => artifact === "before"
      ? { outcome: "absent" }
      : { outcome: "available", pullRequest: { updatedAt: artifact } }) as never);
    fixture.host.harness.sdk.stub("threads.get", (async ({ threadId }: { threadId: string }) => makeThreadResponse({
      id: threadId,
      projectId: PROJECT_ID,
      status: "idle",
      environmentId: `environment-${threadId}`,
      updatedAt: 0,
    })) as never);
    fixture.host.harness.sdk.stub("threads.wait", (async () => ({ matched: true })) as never);

    expect((await fixture.host.harness.runCli(["stall-guard", "--cycle", "--project", PROJECT_ID])).exitCode).toBe(0);
    artifact = "after";
    const cycle = await fixture.host.harness.runCli(["stall-guard", "--cycle", "--project", PROJECT_ID]);

    expect(JSON.parse(cycle.stdout)).toMatchObject({ attempted: 0, verified: 0 });
    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("records a wrongful-idle timeout and retries its unchanged artifact later", async () => {
    const fixture = await fleetWatchdogFixture(0);
    let artifact = "before";
    fixture.host.harness.sdk.stub("environments.pullRequest", (async () => artifact === "before"
      ? { outcome: "absent" }
      : { outcome: "available", pullRequest: { updatedAt: artifact } }) as never);
    fixture.host.harness.sdk.stub("threads.get", (async ({ threadId }: { threadId: string }) => makeThreadResponse({
      id: threadId,
      projectId: PROJECT_ID,
      status: "idle",
      environmentId: `environment-${threadId}`,
      updatedAt: 0,
    })) as never);
    let timeout = true;
    fixture.host.harness.sdk.stub("threads.wait", (async () => {
      if (timeout) throw new Error("idle wait timed out");
      return { matched: true };
    }) as never);

    expect((await fixture.host.harness.runCli(["stall-guard", "--cycle", "--project", PROJECT_ID])).exitCode).toBe(0);
    const baseline = await fixture.host.bb.storage.kv.get("stall-guard.artifacts");
    artifact = "after";
    expect((await fixture.host.harness.runCli(["stall-guard", "--cycle", "--project", PROJECT_ID])).exitCode).toBe(0);
    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(await fixture.host.bb.storage.kv.get("stall-guard.artifacts")).toEqual(baseline);
    expect(fixture.host.harness.inspection.logEntries).toContainEqual(expect.objectContaining({
      level: "warn",
      message: expect.stringContaining("idle-wait=failed error=Error: idle wait timed out"),
    }));

    timeout = false;
    expect((await fixture.host.harness.runCli(["stall-guard", "--cycle", "--project", PROJECT_ID])).exitCode).toBe(0);
    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send").length).toBeGreaterThan(0);
    expect(await fixture.host.bb.storage.kv.get("stall-guard.artifacts")).not.toEqual(baseline);
  });

  it("surfaces a platform-parented stranded lane to its dispatcher without recovering it", async () => {
    const fixture = await fleetWatchdogFixture(7);
    const lane = await fixture.host.bb.sdk.threads.spawn({
      projectId: PROJECT_ID,
      parentThreadId: fixture.orchestratorThreadId,
      environment: { type: "project-default" },
      prompt: "frozen work order",
      title: "issue lane",
    });
    expect(lane).toMatchObject({ projectId: PROJECT_ID, parentThreadId: fixture.orchestratorThreadId, status: "error" });

    await fixture.host.harness.runSchedule("fleet-watchdog");

    const sends = fixture.host.harness.inspection.sdk.callsTo("threads.send");
    expect(sends).toEqual([[
      {
        threadId: fixture.orchestratorThreadId,
        mode: "queue-if-active",
        input: [{
          type: "text",
          visibility: "agent-only",
          text: expect.stringMatching(new RegExp(`^stranded lane detected at cycle .*: lane=${lane.id} branch=bb/lane-1 lastEvent=turn/started@7 status=error\\. The lane was not recovered; inspect its frozen work order and decide respawn or closure\\.$`)),
          mentions: [],
        }],
      },
    ]]);
    expect(sends.some(([request]) => (request as { threadId?: string }).threadId === lane.id)).toBe(false);
    expect(fixture.host.harness.inspection.logEntries).toContainEqual(expect.objectContaining({
      level: "info",
      message: "fleet-watchdog coverage=visible seats=2 lanes=1 cannotSee=none",
    }));
  });

  it("surfaces a stranded lane to the director when its dispatcher is usage-capped", async () => {
    const fixture = await fleetWatchdogFixture(7);
    const lane = await fixture.host.bb.sdk.threads.spawn({
      projectId: PROJECT_ID,
      parentThreadId: fixture.orchestratorThreadId,
      environment: { type: "project-default" },
      prompt: "frozen work order",
      title: "issue lane",
    });
    fixture.setUsageCapped(fixture.orchestratorThreadId);
    fixture.host.harness.sdk.stub("threads.get", (async ({ threadId }: { threadId: string }) => makeThreadResponse({
      id: threadId,
      projectId: PROJECT_ID,
      parentThreadId: threadId === lane.id ? fixture.orchestratorThreadId : null,
      status: threadId === fixture.orchestratorThreadId || threadId === lane.id ? "error" : "idle",
      updatedAt: 7,
    })) as never);

    await fixture.host.harness.runSchedule("fleet-watchdog");

    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toEqual([[
      expect.objectContaining({ threadId: fixture.directorThreadId, mode: "queue-if-active" }),
    ]]);
  });

  it("still enumerates a lane parented by a retired dispatcher", async () => {
    const fixture = await fleetWatchdogFixture(7);
    fixture.db.prepare(`
      INSERT INTO execution_attempts (
        project_id, execution_attempt_id, origin, attempt_ordinal, config_revision,
        governance_epoch, role_id, role_generation, state, bb_server_id,
        environment_id, source_id, host_id, environment_path, thread_id,
        environment_digest, created_at_ms, attempt_digest
      )
      SELECT project_id, 'retired-dispatcher-attempt', 'role_holder', 1, config_revision,
        governance_epoch, role_id, role_generation, 'done', bb_server_id,
        environment_id, source_id, host_id, environment_path, 'retired-dispatcher',
        environment_digest, created_at_ms, 'retired-dispatcher-digest'
      FROM execution_attempts WHERE role_id = 'project-orchestrator' LIMIT 1
    `).run();
    const lane = await fixture.host.bb.sdk.threads.spawn({
      projectId: PROJECT_ID,
      parentThreadId: "retired-dispatcher",
      environment: { type: "project-default" },
      prompt: "frozen work order",
      title: "issue lane",
    });

    await fixture.host.harness.runSchedule("fleet-watchdog");

    expect(lane).toMatchObject({ parentThreadId: "retired-dispatcher", status: "error" });
    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toEqual([[
      expect.objectContaining({ threadId: fixture.directorThreadId, mode: "queue-if-active" }),
    ]]);
  });

  it("reports degraded coverage instead of treating failed parentage enumeration as no lanes", async () => {
    const fixture = await fleetWatchdogFixture();
    fixture.host.harness.sdk.stub("threads.list", (async () => { throw new Error("thread inventory unavailable"); }) as never);

    await fixture.host.harness.runSchedule("fleet-watchdog");

    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(fixture.host.harness.inspection.logEntries).toContainEqual(expect.objectContaining({
      level: "warn",
      message: expect.stringMatching(/^fleet-watchdog coverage=degraded seats=2 lanes=0 cannotSee=platform-parentage:proj_test:Error: thread inventory unavailable$/),
    }));
  });

  it("reports blind coverage when canonical role enumeration is unreadable", async () => {
    const fixture = await fleetWatchdogFixture();
    fixture.db.close();

    await fixture.host.harness.runSchedule("fleet-watchdog");

    expect(fixture.host.harness.inspection.logEntries).toContainEqual(expect.objectContaining({
      level: "warn",
      message: expect.stringMatching(/^fleet-watchdog coverage=blind seats=0 lanes=0 cannotSee=canonical-role-holders:/),
    }));
  });

  it("treats a subscription-window-capped seat as scheduled return", async () => {
    const fixture = await fleetWatchdogFixture();
    fixture.setUsageCapped(fixture.orchestratorThreadId);
    fixture.host.harness.sdk.stub("threads.get", (async ({ threadId }: { threadId: string }) => makeThreadResponse({
      id: threadId,
      projectId: PROJECT_ID,
      status: threadId === fixture.orchestratorThreadId ? "error" : "idle",
      updatedAt: 1,
    })) as never);

    await fixture.host.harness.runSchedule("fleet-watchdog");

    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(fixture.host.harness.inspection.logEntries).toContainEqual(expect.objectContaining({
      level: "info",
      message: "fleet-watchdog scheduled return: project=proj_test role=project-orchestrator@1 status=usage-capped",
    }));
  });

  it("degrades instead of recovering when provider-cap state is unreadable", async () => {
    const fixture = await fleetWatchdogFixture();
    fixture.host.harness.sdk.stub("threads.get", (async ({ threadId }: { threadId: string }) => makeThreadResponse({
      id: threadId,
      projectId: PROJECT_ID,
      status: threadId === fixture.orchestratorThreadId ? "error" : "idle",
      updatedAt: 1,
    })) as never);
    fixture.host.harness.sdk.stub("threads.rateLimitRecovery", (async () => { throw new Error("rate limit state unavailable"); }) as never);

    await fixture.host.harness.runSchedule("fleet-watchdog");

    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(fixture.host.harness.inspection.logEntries).toContainEqual(expect.objectContaining({
      level: "warn",
      message: expect.stringContaining("coverage=degraded"),
    }));
    expect(fixture.host.harness.inspection.logEntries).toContainEqual(expect.objectContaining({
      level: "warn",
      message: expect.stringContaining(`cannotSee=platform-rate-limit:${fixture.orchestratorThreadId}:Error: rate limit state unavailable`),
    }));
  });

  it("opens a fresh turn when the current role holder enters error", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      const statuses = new Map([[fixture.orchestratorThreadId, "error" as const]]);
      fixture.host.harness.sdk.stub("threads.get", (async ({ threadId }: { threadId: string }) => makeThreadResponse({
        id: threadId,
        projectId: PROJECT_ID,
        status: statuses.get(threadId) ?? "idle",
        updatedAt: 60 * 60_000,
      })) as never);
      await expect(fixture.host.harness.emitThreadEvent("thread.failed", {
        thread: makeThreadResponse({ id: fixture.orchestratorThreadId, projectId: PROJECT_ID, status: "error", updatedAt: 60 * 60_000 }),
        error: "network connection lost",
      })).resolves.toEqual({ errors: [] });
      expect(readRoleHolderStates(fixture.db).find((holder) => holder.role_id === "project-orchestrator")?.thread_id).toBe(fixture.orchestratorThreadId);
      expect((await fixture.host.bb.sdk.threads.get({ threadId: fixture.orchestratorThreadId })).status).toBe("error");

      let recoveryClockReads = 0;
      clock.mockImplementation(() => recoveryClockReads++ === 0 ? 60 * 60_000 : 60 * 60_000 + 30);
      const logCount = fixture.host.harness.inspection.logEntries.length;
      await fixture.host.harness.runSchedule("fleet-watchdog");

      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toEqual([[
        {
          threadId: fixture.orchestratorThreadId,
          mode: "start",
          input: [{ type: "text", visibility: "agent-only", text: "role wake path broken at cycle 1970-01-01T01:00:00.000Z: project-orchestrator@1 holder status=error; opening a fresh turn", mentions: [] }],
        },
      ]]);
      const persisted = await fixture.host.bb.storage.kv.get<Record<string, RoleIdleRecord>>("fleet-watchdog.role-idle");
      expect(Object.values(persisted ?? {})).toContainEqual(expect.objectContaining({ lastFleetWakeAtMs: null, lastRecoveryWakeAtMs: 60 * 60_000 }));
      expect(fixture.host.harness.inspection.logEntries.slice(logCount)).toContainEqual(expect.objectContaining({
        level: "warn",
        message: "fleet-watchdog role wake path broken: project=proj_test role=project-orchestrator@1 status=error recovery=sent",
      }));
      expect(fixture.host.harness.inspection.logEntries.slice(logCount).some((entry) => entry.message === "fleet-watchdog healthy cycle")).toBe(false);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("bounds a stopping holder wait before opening its recovery turn", async () => {
    const fixture = await fleetWatchdogFixture(0);
    const statuses = new Map([[fixture.orchestratorThreadId, "stopping" as "stopping" | "error"]]);
    fixture.host.harness.sdk.stub("threads.get", (async ({ threadId }: { threadId: string }) => makeThreadResponse({
      id: threadId,
      projectId: PROJECT_ID,
      status: statuses.get(threadId) ?? "idle",
      updatedAt: 1,
    })) as never);
    fixture.host.harness.sdk.stub("threads.wait", (async ({ threadId }: { threadId: string }) => {
      statuses.set(threadId, "error");
      throw new Error("bounded wait expired");
    }) as never);
    expect((await fixture.host.bb.sdk.threads.get({ threadId: fixture.orchestratorThreadId })).status).toBe("stopping");

    await fixture.host.harness.runSchedule("fleet-watchdog");

    expect(fixture.host.harness.inspection.sdk.callsTo("threads.wait")).toEqual([[
      { threadId: fixture.orchestratorThreadId, status: "idle", timeoutMs: 30_000 },
    ]]);
    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toEqual([[
      expect.objectContaining({ threadId: fixture.orchestratorThreadId, mode: "start", input: [expect.objectContaining({ text: expect.stringContaining("holder status=stopping") })] }),
    ]]);
  });

  it("does not recover a stopping holder that becomes active during the bounded wait", async () => {
    const fixture = await fleetWatchdogFixture(0);
    const statuses = new Map([[fixture.orchestratorThreadId, "stopping" as "stopping" | "active"]]);
    fixture.host.harness.sdk.stub("threads.get", (async ({ threadId }: { threadId: string }) => makeThreadResponse({
      id: threadId,
      projectId: PROJECT_ID,
      status: statuses.get(threadId) ?? "idle",
      updatedAt: 1,
    })) as never);
    fixture.host.harness.sdk.stub("threads.wait", (async ({ threadId }: { threadId: string }) => {
      statuses.set(threadId, "active");
    }) as never);
    const logCount = fixture.host.harness.inspection.logEntries.length;

    await fixture.host.harness.runSchedule("fleet-watchdog");

    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(fixture.host.harness.inspection.logEntries.slice(logCount).some((entry) => entry.message.includes("role wake path broken"))).toBe(false);
    expect(fixture.host.harness.inspection.logEntries.slice(logCount)).toContainEqual(expect.objectContaining({ level: "info", message: "fleet-watchdog healthy cycle" }));
  });

  it("uses in-progress WorkItems to suppress startable intake at capacity", async () => {
    const bin = mkdtempSync(join(tmpdir(), "bb-collab-startable-queue-"));
    const gh = join(bin, "gh");
    const argsLog = join(bin, "args");
    writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsLog}"\nprintf '%s\\n' '[{"number":205}]'\n`);
    chmodSync(gh, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      const fixture = await fleetWatchdogFixture(0, true, 1);
      expect(applyWithFixtureReceipt(fixture.db, transitionRequest(fixture.fenceToken, "in_progress", 2))).toMatchObject({ outcome: "OK" });
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM work_items WHERE lifecycle_state = 'in_progress'").get()).toEqual({ count: 1 });
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
      expect(applyWithFixtureReceipt(fixture.db, transitionRequest(fixture.fenceToken, "succeeded", 3))).toMatchObject({ outcome: "OK" });
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM work_items WHERE lifecycle_state = 'in_progress'").get()).toEqual({ count: 0 });
      await fixture.host.harness.runSchedule("fleet-watchdog");
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toEqual([[
        expect.objectContaining({
          threadId: fixture.orchestratorThreadId,
          mode: "queue-if-active",
          input: [expect.objectContaining({ text: "startable queue has 1 issue with 0/1 writing lanes active" })],
        }),
      ]]);
      const persisted = await fixture.host.bb.storage.kv.get<Record<string, { lastFleetWakeAtMs: number | null; lastStartableQueueWakeAtMs: number | null }>>("fleet-watchdog.role-idle");
      expect(Object.values(persisted ?? {})).toContainEqual(expect.objectContaining({ lastFleetWakeAtMs: null, lastStartableQueueWakeAtMs: expect.any(Number) }));
      expect(readFileSync(argsLog, "utf8")).toBe("issue\nlist\n--repo\nexample/project\n--label\nqueue:startable\n--state\nopen\n--json\nnumber\n--limit\n1000\n");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("keeps startable intake running when a holder recovery is refused", async () => {
    const bin = mkdtempSync(join(tmpdir(), "bb-collab-startable-after-refused-recovery-"));
    const gh = join(bin, "gh");
    writeFileSync(gh, "#!/bin/sh\nprintf '%s\\n' '[{\"number\":205}]'\n");
    chmodSync(gh, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      const fixture = await fleetWatchdogFixture(0, true);
      expect(applyWithFixtureReceipt(fixture.db, transitionRequest(fixture.fenceToken, "in_progress", 2))).toMatchObject({ outcome: "OK" });
      expect(applyWithFixtureReceipt(fixture.db, transitionRequest(fixture.fenceToken, "succeeded", 3))).toMatchObject({ outcome: "OK" });
      let directorReads = 0;
      fixture.host.harness.sdk.stub("threads.get", (async ({ threadId }: { threadId: string }) => makeThreadResponse({
        id: threadId,
        projectId: PROJECT_ID,
        status: threadId === fixture.directorThreadId && directorReads++ === 0 ? "error" : threadId === fixture.directorThreadId ? "active" : "idle",
        updatedAt: 1,
      })) as never);
      const logCount = fixture.host.harness.inspection.logEntries.length;

      await fixture.host.harness.runSchedule("fleet-watchdog");

      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toEqual([[
        expect.objectContaining({
          threadId: fixture.orchestratorThreadId,
          mode: "queue-if-active",
          input: [expect.objectContaining({ text: "startable queue has 1 issue with 0/3 writing lanes active" })],
        }),
      ]]);
      expect(fixture.host.harness.inspection.logEntries.slice(logCount)).toContainEqual(expect.objectContaining({
        level: "warn",
        message: "fleet-watchdog role wake path broken: project=proj_test role=director@1 status=error recovery=refused",
      }));
      expect(fixture.host.harness.inspection.logEntries.slice(logCount).some((entry) => entry.message === "fleet-watchdog healthy cycle")).toBe(false);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("keeps the watchdog quiet when the startable queue read fails", async () => {
    const bin = mkdtempSync(join(tmpdir(), "bb-collab-startable-queue-failure-"));
    const gh = join(bin, "gh");
    writeFileSync(gh, "#!/bin/sh\nexit 1\n");
    chmodSync(gh, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      const fixture = await fleetWatchdogFixture(0, true);
      await expect(fixture.host.harness.runSchedule("fleet-watchdog")).resolves.toBeUndefined();
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("uses effective live watchdog threshold settings", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      expect(fixture.host.harness.inspection.registrations.settingsDescriptors).toMatchObject({
        fleetWatchdogFloorMs: { default: "3600000" },
        fleetWatchdogStaleWaitMs: { default: "86400000" },
      });
      await fixture.host.harness.runSchedule("fleet-watchdog");
      await fixture.host.harness.setSettings({ fleetWatchdogFloorMs: "1", fleetWatchdogStaleWaitMs: "2" });
      clock.mockReturnValue(1);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps the watchdog idle anchor through lane-watcher cleanup", async () => {
    const holder = { project_id: PROJECT_ID, role_id: "director", role_generation: 1, execution_attempt_id: "director-attempt", thread_id: "director-thread" };
    const key = roleIdleKey(holder, WORK_ITEM_ID);
    let watchdogState: unknown = {};
    const watchdogIdle = createRoleIdleLedger({ read: async () => watchdogState, write: async (state) => { watchdogState = state; } });
    await watchdogIdle.observeIdle(key, 0);
    const anchored = await watchdogIdle.get(key);

    let laneWatcherState: unknown = {};
    const laneIdle = createRoleIdleLedger({ read: async () => laneWatcherState, write: async (state) => { laneWatcherState = state; } });
    await laneIdle.observeIdle(key, 0);
    const laneWatcher = createLaneWatcher({
      readRoleHolders: () => [holder],
      readRoleScopes: () => [],
      readWorker: async () => ({ projectId: PROJECT_ID, status: "idle", pendingExternalWait: false, archived: false, idleSinceMs: 0 }),
      steerRole: async () => undefined,
      roleIdlePersistence: { read: async () => laneWatcherState, write: async (state) => { laneWatcherState = state; } },
    });
    await laneWatcher.poll();

    expect(await laneWatcher.readRoleIdle(key)).toBeNull();
    expect(laneWatcherState).toEqual({});
    expect(await watchdogIdle.get(key)).toEqual(anchored);
  });

  it("clears every watchdog wake timestamp on an explicit history reset", async () => {
    const holder = { project_id: PROJECT_ID, role_id: "director", role_generation: 1, execution_attempt_id: "director-attempt", thread_id: "director-thread" };
    const key = roleIdleKey(holder, WORK_ITEM_ID);
    let state: unknown = {};
    const ledger = createRoleIdleLedger({ read: async () => state, write: async (next) => { state = next; } });
    await ledger.observeIdle(key, 1);
    await ledger.recordFleetWake(key, 2);
    await ledger.recordRecoveryWake(key, 3);
    await ledger.recordStartableQueueWake(key, 4);
    await ledger.recordStaleWaitWake(key, 5);
    await ledger.recordOwedActWake(key, 6);
    await ledger.recordEscalation(key, 7);
    await ledger.resetIdle(key);
    expect(await ledger.get(key)).toMatchObject({ lastRecoveryWakeAtMs: 3 });
    await ledger.clearWakeHistory(`${PROJECT_ID}:`);
    expect(await ledger.get(key)).toMatchObject({
      idleSinceMs: null,
      lastFleetWakeAtMs: null,
      lastRecoveryWakeAtMs: null,
      lastStartableQueueWakeAtMs: null,
      lastStaleWaitWakeAtMs: null,
      lastOwedActWakeAtMs: null,
      lastEscalationAtMs: null,
    });
  });

  it("loads watchdog state persisted before the recovery wake field existed", async () => {
    const holder = { project_id: PROJECT_ID, role_id: "director", role_generation: 1, execution_attempt_id: "director-attempt", thread_id: "director-thread" };
    const key = roleIdleKey(holder, WORK_ITEM_ID);
    let state: unknown = {};
    const persistence = { read: async () => state, write: async (next: Record<string, RoleIdleRecord>) => { state = structuredClone(next); } };
    const oldLedger = createRoleIdleLedger(persistence);
    await oldLedger.observeIdle(key, 1);
    delete (state as Record<string, Record<string, unknown>>)[key]!.lastRecoveryWakeAtMs;

    const reloaded = createRoleIdleLedger(persistence);
    await expect(reloaded.recover()).resolves.toBeUndefined();
    expect(await reloaded.get(key)).toMatchObject({ idleSinceMs: 1, lastRecoveryWakeAtMs: null });
  });

  it("refuses a WorkItem wait declaration whose schedule or seat waker is not live before any write", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    const before = exportFoundation(db, PROJECT_ID);
    const result = await host.harness.callRpc("apply", workItemWaitRequest("fence", 1, { kind: "schedule", schedule: "phantom-waker", declaredBySeat: "worker-seat" }));
    expect(result).toMatchObject({ outcome: "INVALID_INPUT", attempted: 0, verified: 0, message: "waker schedule phantom-waker is not live: declaration refused" });
    const seat = await host.harness.callRpc("apply", workItemWaitRequest("fence", 1, { kind: "seat", seat: "worker", declaredBySeat: "worker-seat" }));
    expect(seat).toMatchObject({ outcome: "INVALID_INPUT", attempted: 0, verified: 0, message: "waker seat worker is not live: declaration refused" });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("wakes a stalled director exactly once for nextStartable work", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture();
      await addPendingReview(fixture);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(2 * 60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send").filter(([input]) => (input as { threadId: string }).threadId === fixture.directorThreadId)).toEqual([[
        {
          threadId: fixture.directorThreadId,
          mode: "queue-if-active",
          input: [{ type: "text", visibility: "agent-only", text: "fleet still quiet at cycle 1970-01-01T02:00:00.000Z with open work since 1970-01-01T00:00:00.000Z", mentions: [] }],
        },
      ]]);
    } finally {
      clock.mockRestore();
    }
  });

  it("wakes the orchestrator first when the fleet is quietly stalled", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toEqual([[
        expect.objectContaining({ threadId: fixture.orchestratorThreadId, input: [expect.objectContaining({ text: "fleet quiet at cycle 1970-01-01T01:00:00.000Z with open work since 1970-01-01T00:00:00.000Z" })] }),
      ]]);
    } finally {
      clock.mockRestore();
    }
  });

  it("escalates unresolved work after the tier-1 receiver becomes active", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      fixture.setThreadStatus("active");
      clock.mockReturnValue(90 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      fixture.setThreadStatus("idle");
      clock.mockReturnValue(2 * 60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send").map(([input]) => (input as { threadId: string }).threadId)).toEqual([
        fixture.orchestratorThreadId,
        fixture.directorThreadId,
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("drives the scheduled watchdog path through one scoped CLI cycle", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      expect(JSON.parse((await fixture.host.harness.runCli(["fleet-watchdog", "--cycle", "--project", PROJECT_ID])).stdout)).toMatchObject({ outcome: "OK", subject: PROJECT_ID, message: "fleet-watchdog cycle complete" });
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runCli(["fleet-watchdog", "--cycle", "--project", PROJECT_ID]);
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
      expect((await fixture.host.harness.runCli(["fleet-watchdog", "--cycle"])).exitCode).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("stays silent for an active declared artifact-lane wait", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      expect(await fixture.host.harness.callRpc("apply", workItemWaitRequest(fixture.fenceToken, 3, { kind: "schedule", schedule: "stall-guard-liveness", declaredBySeat: "worker-seat" }))).toMatchObject({ outcome: "OK" });
      for (const now of [0, 60 * 60_000, 2 * 60 * 60_000]) {
        clock.mockReturnValue(now);
        await fixture.host.harness.runSchedule("fleet-watchdog");
      }
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("surfaces a stale declared wait to the orchestrator", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture();
      await addPendingReview(fixture);
      expect(applyWithFixtureReceipt(fixture.db, workItemWaitRequest(fixture.fenceToken, 3, { kind: "schedule", schedule: "stall-guard-liveness", declaredBySeat: "worker-seat" })).outcome).toBe("OK");
      clock.mockReturnValue(25 * 60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toEqual([[
        expect.objectContaining({ threadId: fixture.orchestratorThreadId, input: [expect.objectContaining({ text: "wait went stale: chase the external or re-plan" })] }),
      ]]);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not escalate a resolved stale wait while the fleet is busy", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      expect(await fixture.host.harness.callRpc("apply", workItemWaitRequest(fixture.fenceToken, 3, { kind: "schedule", schedule: "stall-guard-liveness", declaredBySeat: "worker-seat" }))).toMatchObject({ outcome: "OK" });
      clock.mockReturnValue(25 * 60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(await fixture.host.harness.callRpc("apply", workItemWaitRequest(fixture.fenceToken, 4, null))).toMatchObject({ outcome: "OK" });
      fixture.setThreadStatus("active");
      clock.mockReturnValue(26 * 60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toEqual([[
        expect.objectContaining({ threadId: fixture.orchestratorThreadId, input: [expect.objectContaining({ text: "wait went stale: chase the external or re-plan" })] }),
      ]]);
    } finally {
      clock.mockRestore();
    }
  });

  it("surfaces a stale owed act to the orchestrator", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture();
      await addPendingReview(fixture);
      expect(await fixture.host.harness.callRpc("apply", workItemWaitRequest(fixture.fenceToken, 3, { kind: "seat", seat: "director", declaredBySeat: "worker-seat" }))).toMatchObject({ outcome: "OK" });
      clock.mockReturnValue(25 * 60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toEqual([[
        expect.objectContaining({ threadId: fixture.orchestratorThreadId, input: [expect.objectContaining({ text: "owed act went stale" })] }),
      ]]);
    } finally {
      clock.mockRestore();
    }
  });

  it("escalates an owing non-director seat to the director", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      expect(await fixture.host.harness.callRpc("apply", workItemWaitRequest(fixture.fenceToken, 3, { kind: "seat", seat: "project-orchestrator", declaredBySeat: "worker-seat" }))).toMatchObject({ outcome: "OK" });
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(2 * 60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toEqual([
        [expect.objectContaining({ threadId: fixture.orchestratorThreadId, input: [expect.objectContaining({ text: "owed act quiet at cycle 1970-01-01T01:00:00.000Z with open work since 1970-01-01T00:00:00.000Z" })] })],
        [expect.objectContaining({ threadId: fixture.directorThreadId, input: [expect.objectContaining({ text: "owed act still quiet at cycle 1970-01-01T02:00:00.000Z with open work since 1970-01-01T00:00:00.000Z" })] })],
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("wakes the owing director once and leaves its terminal tier to the dead-man surface", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      expect(await fixture.host.harness.callRpc("apply", workItemWaitRequest(fixture.fenceToken, 3, { kind: "seat", seat: "director", declaredBySeat: "worker-seat" }))).toMatchObject({ outcome: "OK" });
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(2 * 60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toEqual([[
        expect.objectContaining({ threadId: fixture.directorThreadId, input: [expect.objectContaining({ text: "owed act quiet at cycle 1970-01-01T01:00:00.000Z with open work since 1970-01-01T00:00:00.000Z" })] }),
      ]]);
    } finally {
      clock.mockRestore();
    }
  });

  it("stays silent while the fleet is busy", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      fixture.setThreadStatus("active");
      for (const now of [0, 60 * 60_000, 2 * 60 * 60_000]) {
        clock.mockReturnValue(now);
        await fixture.host.harness.runSchedule("fleet-watchdog");
      }
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("preserves the idle anchor across a metadata-only updatedAt bump", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      fixture.setThreadUpdatedAt(60 * 60_000);
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not wake pending work before the director idle floor", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(60 * 60_000);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(90 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not wake a lane blocked by a pending platform interaction", async () => {
    const fixture = await fleetWatchdogFixture();
    const executionAttemptId = await addPendingReview(fixture);
    const waitingThreadId = "platform-waiting-review";
    fixture.db.prepare("UPDATE execution_attempts SET thread_id = ? WHERE execution_attempt_id = ?").run(waitingThreadId, executionAttemptId);
    fixture.host.harness.sdk.stub("threads.interactions.list", (async ({ threadId }: { threadId: string }) =>
      threadId === waitingThreadId ? [{ status: "pending" }] : []) as never);
    await fixture.host.harness.runSchedule("fleet-watchdog");
    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("fails closed when a stale false interaction cache meets a failed fresh read", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      fixture.host.harness.sdk.stub("threads.interactions.list", (async ({ threadId }: { threadId: string }) => {
        if (threadId === fixture.orchestratorThreadId) throw new Error("orchestrator interactions unavailable");
        return [];
      }) as never);
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("fails closed when a watcher interaction read writes after the floor read fails", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(60 * 60_000);
      fixture.host.harness.sdk.stub("threads.interactions.list", (async ({ threadId }: { threadId: string }) => {
        if (threadId === fixture.directorThreadId) throw new Error("director interactions unavailable");
        return [];
      }) as never);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")
        .filter(([input]) => {
          const send = input as { threadId: string; mode: string };
          return send.threadId === fixture.directorThreadId && send.mode === "queue-if-active";
        })).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("wakes independent project-scoped director floors", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture();
      await addPendingReview(fixture);
      cloneProject(fixture.db, PROJECT_ID, "project-two");
      fixture.setThreadProject("director-two", "project-two");
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(2 * 60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send").map(([input]) => (input as { threadId: string }).threadId).filter((threadId) => threadId === "director-two" || threadId === fixture.directorThreadId).sort()).toEqual([
        "director-two",
        fixture.directorThreadId,
      ].sort());
    } finally {
      clock.mockRestore();
    }
  });

  it("fails closed and warns on same-project director ambiguity", async () => {
    const fixture = await fleetWatchdogFixture();
    await addPendingReview(fixture);
    fixture.db.exec("ALTER TABLE role_generation_heads RENAME TO role_generation_heads_table; CREATE VIEW role_generation_heads AS SELECT * FROM role_generation_heads_table UNION ALL SELECT * FROM role_generation_heads_table WHERE role_id = 'director'");
    await fixture.host.harness.runSchedule("fleet-watchdog");
    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(fixture.host.harness.inspection.logEntries).toContainEqual(expect.objectContaining({
      level: "warn",
      message: "fleet-watchdog refused: project=proj_test active director holders=2",
    }));
  });

  it("does not wake a stale director after succession during the gate", async () => {
    const fixture = await fleetWatchdogFixture();
    await addPendingReview(fixture);
    let succeeded = false;
    fixture.host.harness.sdk.stub("threads.interactions.list", (async ({ threadId }: { threadId: string }) => {
      if (threadId === fixture.directorThreadId && !succeeded) {
        advanceDirector(fixture.db, fixture.fenceToken);
        succeeded = true;
      }
      return [];
    }) as never);
    await fixture.host.harness.runSchedule("fleet-watchdog");
    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("coalesces a second consecutive floor fire", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
      const persisted = await fixture.host.bb.storage.kv.get<Record<string, { lastFleetWakeAtMs?: number | null }>>("fleet-watchdog.role-idle");
      expect(Object.values(persisted ?? {}).some((record) => record.lastFleetWakeAtMs === 60 * 60_000)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("retries after a successful send whose wake timestamp was not persisted", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      let failTimestampWrite = true;
      const originalSet = fixture.host.bb.storage.kv.set.bind(fixture.host.bb.storage.kv);
      const setSpy = vi.spyOn(fixture.host.bb.storage.kv, "set").mockImplementation(async (key, value) => {
        if (key === "fleet-watchdog.role-idle" && failTimestampWrite && value && typeof value === "object" && !Array.isArray(value)
          && Object.values(value as Record<string, { lastFleetWakeAtMs?: number | null }>).some((record) => record.lastFleetWakeAtMs === 60 * 60_000)) {
          failTimestampWrite = false;
          throw new Error("wake timestamp unavailable");
        }
        await originalSet(key, value);
      });
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(2);
      setSpy.mockRestore();
    } finally {
      clock.mockRestore();
    }
  });

  it("fires after plugin downtime across an active period and legitimate re-stall", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
      fixture.setThreadStatus("active");
      const reloaded = await fixture.host.harness.lifecycle.reload((bb) => plugin(bb));
      reloaded.harness.sdk.stub("threads.interactions.list", (async () => []) as never);
      reloaded.harness.sdk.stub("threads.get", (async ({ threadId }: { threadId: string }) => makeThreadResponse({
        id: threadId,
        projectId: PROJECT_ID,
        status: fixture.getThreadStatus(),
        updatedAt: 0,
      })) as never);
      reloaded.harness.sdk.stub("threads.send", (async () => ({ ok: true })) as never);
      clock.mockReturnValue(3 * 60 * 60_000);
      fixture.setThreadStatus("idle");
      await reloaded.harness.runSchedule("fleet-watchdog");
      expect(reloaded.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("asserts tier-2 quietness only when it is true at emit time", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      let directorInteractionReads = 0;
      fixture.host.harness.sdk.stub("threads.interactions.list", (async ({ threadId }: { threadId: string }) => {
        if (threadId === fixture.directorThreadId) {
          directorInteractionReads += 1;
          if (directorInteractionReads === 3) fixture.setThreadStatus("active");
        }
        return [];
      }) as never);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(2 * 60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.getThreadStatus()).toBe("active");
      const texts = fixture.host.harness.inspection.sdk.callsTo("threads.send").map(([input]) => (input as { input: Array<{ text: string }> }).input[0]?.text);
      expect(texts.some((text) => text === "fleet still quiet at cycle 1970-01-01T02:00:00.000Z with open work since 1970-01-01T00:00:00.000Z")).toBe(false);
      expect(texts.some((text) => text === "fleet still quiet with open work since 1970-01-01T00:00:00.000Z")).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("emits a tier-1 quiet claim proven at the cycle that sends it", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      // Fleet busy at 30min then idle again, wholly between two cycles: no cycle
      // ever observes it, so the anchor survives but continuous quiet is false.
      const activityAtMs = 30 * 60_000;
      fixture.setThreadStatus("active");
      fixture.setThreadStatus("idle");
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      const sends = fixture.host.harness.inspection.sdk.callsTo("threads.send").filter(([input]) => (input as { threadId: string }).threadId === fixture.orchestratorThreadId);
      expect(sends).toHaveLength(1);
      const claim = parseEmittedQuietClaim((sends[0]![0] as { input: Array<{ text: string }> }).input[0]!.text);
      expect(claim, "tier-1 line must claim quiet only at its cycle receipt").not.toBeNull();
      const cycleAtMs = 60 * 60_000;
      const orchestrator = fixture.db.prepare("SELECT project_id, role_id, role_generation, execution_attempt_id, thread_id FROM execution_attempts WHERE origin = 'role_holder' AND role_id = 'project-orchestrator'").get() as Parameters<typeof roleIdleKey>[0];
      const ledgerKey = roleIdleKey(orchestrator, WORK_ITEM_ID);
      const persisted = await fixture.host.bb.storage.kv.get<Record<string, { idleSinceMs: number | null; lastFleetWakeAtMs: number | null }>>("fleet-watchdog.role-idle");
      expect(claim!.quietAtMs).toBe(cycleAtMs);
      expect(claim!.openSinceMs).toBe(persisted?.[ledgerKey]?.idleSinceMs);
      expect(persisted?.[ledgerKey]?.lastFleetWakeAtMs).toBe(cycleAtMs);
      // Ground truth separates the two timestamps: the unobserved activity sits
      // after the anchor and before the receipt, so only the split claim is true.
      expect(claim!.openSinceMs).toBeLessThan(activityAtMs);
      expect(claim!.quietAtMs).toBeGreaterThan(activityAtMs);
    } finally {
      clock.mockRestore();
    }
  });

  it("emits a tier-2 escalation quiet claim proven at the cycle that sends it", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      // Fleet busy at 90min then idle again, wholly between cycles: beforeSend
      // legitimately passes (every holder idle at emit), the anchor never moved.
      const activityAtMs = 90 * 60_000;
      fixture.setThreadStatus("active");
      fixture.setThreadStatus("idle");
      clock.mockReturnValue(2 * 60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      const sends = fixture.host.harness.inspection.sdk.callsTo("threads.send").filter(([input]) => (input as { threadId: string }).threadId === fixture.directorThreadId);
      expect(sends).toHaveLength(1);
      const claim = parseEmittedQuietClaim((sends[0]![0] as { input: Array<{ text: string }> }).input[0]!.text);
      expect(claim, "tier-2 line must claim quiet only at its cycle receipt").not.toBeNull();
      expect(claim!.still).toBe(true);
      const cycleAtMs = 2 * 60 * 60_000;
      const orchestrator = fixture.db.prepare("SELECT project_id, role_id, role_generation, execution_attempt_id, thread_id FROM execution_attempts WHERE origin = 'role_holder' AND role_id = 'project-orchestrator'").get() as Parameters<typeof roleIdleKey>[0];
      const director = fixture.db.prepare("SELECT project_id, role_id, role_generation, execution_attempt_id, thread_id FROM execution_attempts WHERE origin = 'role_holder' AND role_id = 'director'").get() as Parameters<typeof roleIdleKey>[0];
      const anchorKey = roleIdleKey(orchestrator, WORK_ITEM_ID);
      const wakeKey = roleIdleKey(director, WORK_ITEM_ID);
      const persisted = await fixture.host.bb.storage.kv.get<Record<string, { idleSinceMs: number | null; lastEscalationAtMs: number | null }>>("fleet-watchdog.role-idle");
      expect(claim!.quietAtMs).toBe(cycleAtMs);
      expect(claim!.openSinceMs).toBe(persisted?.[anchorKey]?.idleSinceMs);
      expect(persisted?.[wakeKey]?.lastEscalationAtMs).toBe(cycleAtMs);
      expect(claim!.openSinceMs).toBeLessThan(activityAtMs);
      expect(claim!.quietAtMs).toBeGreaterThan(activityAtMs);
    } finally {
      clock.mockRestore();
    }
  });

  it("emits an owed-act quiet claim proven at the cycle that sends it", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      expect(await fixture.host.harness.callRpc("apply", workItemWaitRequest(fixture.fenceToken, 3, { kind: "seat", seat: "director", declaredBySeat: "worker-seat" }))).toMatchObject({ outcome: "OK" });
      await fixture.host.harness.runSchedule("fleet-watchdog");
      // Owing seat busy at 30min then idle again, wholly between cycles.
      const activityAtMs = 30 * 60_000;
      fixture.setThreadStatus("active");
      fixture.setThreadStatus("idle");
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      const sends = fixture.host.harness.inspection.sdk.callsTo("threads.send").filter(([input]) => (input as { threadId: string }).threadId === fixture.directorThreadId);
      expect(sends).toHaveLength(1);
      const claim = parseEmittedQuietClaim((sends[0]![0] as { input: Array<{ text: string }> }).input[0]!.text);
      expect(claim, "owed-act line must claim quiet only at its cycle receipt").not.toBeNull();
      expect(claim!.subject).toBe("owed act");
      const cycleAtMs = 60 * 60_000;
      const director = fixture.db.prepare("SELECT project_id, role_id, role_generation, execution_attempt_id, thread_id FROM execution_attempts WHERE origin = 'role_holder' AND role_id = 'director'").get() as Parameters<typeof roleIdleKey>[0];
      const ledgerKey = roleIdleKey(director, WORK_ITEM_ID);
      const persisted = await fixture.host.bb.storage.kv.get<Record<string, { idleSinceMs: number | null; lastOwedActWakeAtMs: number | null }>>("fleet-watchdog.role-idle");
      expect(claim!.quietAtMs).toBe(cycleAtMs);
      expect(claim!.openSinceMs).toBe(persisted?.[ledgerKey]?.idleSinceMs);
      expect(persisted?.[ledgerKey]?.lastOwedActWakeAtMs).toBe(cycleAtMs);
      expect(claim!.openSinceMs).toBeLessThan(activityAtMs);
      expect(claim!.quietAtMs).toBeGreaterThan(activityAtMs);
    } finally {
      clock.mockRestore();
    }
  });

  it("continues processing other projects when one project's interactions read rejects", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      cloneProject(fixture.db, PROJECT_ID, "project-two");
      fixture.setThreadProject("director-two", "project-two");
      fixture.setThreadProject("orchestrator-two", "project-two");
      await fixture.host.harness.runSchedule("fleet-watchdog");
      let projectOneInteractionReads = 0;
      fixture.host.harness.sdk.stub("threads.interactions.list", (async ({ threadId }: { threadId: string }) => {
        if (threadId === fixture.directorThreadId) {
          projectOneInteractionReads += 1;
          throw new Error("project A interactions unavailable");
        }
        return [];
      }) as never);
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(2 * 60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(projectOneInteractionReads).toBeGreaterThan(0);
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send").map(([input]) => (input as { threadId: string }).threadId).filter((threadId) => threadId === "director-two")).toEqual(["director-two"]);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not escalate a prior fleet wake while any holder is active", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture(0);
      await addPendingReview(fixture);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      fixture.setThreadStatus("active");
      clock.mockReturnValue(2 * 60 * 60_000);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toEqual([[
        expect.objectContaining({ threadId: fixture.orchestratorThreadId, input: [expect.objectContaining({ text: "fleet quiet at cycle 1970-01-01T01:00:00.000Z with open work since 1970-01-01T00:00:00.000Z" })] }),
      ]]);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not wake when no director generation exists", async () => {
    const fixture = await assignmentFixture();
    fixture.host.harness.sdk.stub("threads.interactions.list", (async () => []) as never);
    fixture.host.harness.sdk.stub("threads.send", (async () => ({ ok: true })) as never);
    await fixture.host.harness.runSchedule("fleet-watchdog");
    expect(fixture.host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("logs fleet-watchdog send failures without throwing", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fixture = await fleetWatchdogFixture();
      await addPendingReview(fixture);
      await fixture.host.harness.runSchedule("fleet-watchdog");
      clock.mockReturnValue(60 * 60_000);
      fixture.setThreadUpdatedAt(60 * 60_000);
      fixture.host.harness.sdk.stub("threads.send", (async () => { throw new Error("send unavailable"); }) as never);
      await expect(fixture.host.harness.runSchedule("fleet-watchdog")).resolves.toBeUndefined();
      expect(fixture.host.harness.inspection.logEntries.filter((entry) => entry.level === "warn" && entry.message === "fleet-watchdog failed: Error: send unavailable")).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
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


  it("exports every canonical row past one database page", () => {
    const { db, directory } = directDatabase();
    try {
      for (let index = 0; index <= MAX_EXPORT_ROWS; index += 1) {
        seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: `export-${index}` });
      }
      const first = exportFoundation(db, PROJECT_ID);
      const second = exportFoundation(db, PROJECT_ID);
      expect(first).toEqual(second);
      expect(first).toMatchObject({
        outcome: "OK",
        expected: MAX_EXPORT_ROWS + 1,
        attempted: MAX_EXPORT_ROWS + 1,
        verified: MAX_EXPORT_ROWS + 1,
      });
      expect(first.export!.manifest.rowCount).toBe(MAX_EXPORT_ROWS + 1);
      expect(first.export!.recordsNdjson.split("\n")).toHaveLength(MAX_EXPORT_ROWS + 1);
      expect(first.export!.checksums["records.ndjson"]).toBe(sha256(first.export!.recordsNdjson));
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("atomically spills a complete canonical export past the inline byte ceiling", () => {
    const { db, directory } = directDatabase();
    try {
      seedMigrationAuthority(db);
      seedEvidenceArtifact(db, "large-artifact", 270 * 1024);
      const result = exportFoundation(db, PROJECT_ID);
      expect(exportFoundation(db, PROJECT_ID)).toEqual(result);
      expect(result).toMatchObject({ outcome: "OK", expected: result.attempted, verified: result.attempted });
      expect(result.export).toBeUndefined();
      const exportFile = (result.evidence as { exportFile: ExportFilePayload }).exportFile;
      expect(exportFile.complete).toBe(true);
      expect(exportFile.directory).toContain("/complete-");
      expect(readdirSync(dirname(exportFile.directory))).not.toContainEqual(expect.stringContaining(".partial-"));
      const recordsNdjson = readFileSync(join(exportFile.directory, "records.ndjson"), "utf8");
      const artifactIndexJson = readFileSync(join(exportFile.directory, "artifact-index.json"), "utf8");
      const manifestJson = readFileSync(join(exportFile.directory, "manifest.json"), "utf8");
      expect(Buffer.byteLength(recordsNdjson, "utf8") + Buffer.byteLength(artifactIndexJson, "utf8")).toBeGreaterThan(MAX_EXPORT_BYTES);
      expect(JSON.parse(manifestJson)).toEqual(exportFile.manifest);
      expect(exportFile.checksums).toEqual({
        "artifact-index.json": sha256(artifactIndexJson),
        "manifest.json": sha256(manifestJson),
        "records.ndjson": sha256(recordsNdjson),
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("sweeps startup debris without touching complete exports or outside paths", () => {
    const { db, directory } = directDatabase();
    const root = join(directory, ".bb-collab-exports");
    const stale = join(root, ".partial-crashed");
    const complete = join(root, "complete-kept");
    const outside = join(directory, ".partial-outside");
    try {
      mkdirSync(stale, { recursive: true });
      mkdirSync(complete, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(root, ".partial-file"), "keep");
      databaseIsReady(db);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(complete)).toBe(true);
      expect(existsSync(outside)).toBe(true);
      expect(existsSync(join(root, ".partial-file"))).toBe(true);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("skips a symlinked export root", () => {
    const { db, directory } = directDatabase();
    const root = join(directory, ".bb-collab-exports");
    const outside = mkdtempSync(join(tmpdir(), "bb-collab-export-root-target-"));
    const victim = join(outside, ".partial-victim");
    try {
      mkdirSync(victim);
      symlinkSync(outside, root, "dir");
      databaseIsReady(db);
      expect(existsSync(victim)).toBe(true);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("spills an over-cap artifact index and imports its complete file reference", () => {
    const { db, directory } = directDatabase();
    try {
      freezeMigration(db);
      for (let index = 0; index <= MAX_EXPORT_ROWS; index += 1) {
        seedEvidenceArtifact(db, `artifact-${String(index).padStart(3, "0")}`);
      }
      const result = exportFoundation(db, PROJECT_ID);
      expect(result).toMatchObject({ outcome: "OK", evidence: { exportFile: { complete: true } } });
      expect(result.export).toBeUndefined();
      const exportFile = (result.evidence as { exportFile: ExportFilePayload }).exportFile;
      const recordsNdjson = readFileSync(join(exportFile.directory, "records.ndjson"), "utf8");
      const artifactIndexJson = readFileSync(join(exportFile.directory, "artifact-index.json"), "utf8");
      expect(Buffer.byteLength(recordsNdjson, "utf8") + Buffer.byteLength(artifactIndexJson, "utf8")).toBeLessThanOrEqual(MAX_EXPORT_BYTES);
      const ceiling = (db.prepare("SELECT MAX(event_sequence) AS ceiling FROM state_events WHERE project_id = ?").get(PROJECT_ID) as { ceiling: number }).ceiling;
      expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "record_export", {
        sourceEventCeiling: ceiling,
        sourceSnapshotDigest: SOURCE_SNAPSHOT_DIGEST,
        export: exportFile,
      }))).toMatchObject({ outcome: "OK", currentResourceRevision: 5, evidence: { state: "exported" } });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses a file spill from a non-file-backed canonical store", () => {
    const db = new Database(":memory:");
    databaseIsReady(db);
    try {
      for (const statement of MIGRATIONS) db.exec(statement);
      seedMigrationAuthority(db);
      seedEvidenceArtifact(db, "large-artifact", 270 * 1024);
      expect(exportFoundation(db, PROJECT_ID)).toMatchObject({
        outcome: "EXPORT_BOUNDED",
        verified: 0,
        message: "export exceeds inline bounds and the canonical store is not file-backed",
      });
    } finally {
      db.close();
    }
  });

  it("appends the operator inbox schema without changing the v21 foundation contract", () => {
    expect(SCHEMA_VERSION).toBe(15);
    expect(CONTRACT_VERSION).toBe(21);
    expect(MIGRATIONS).toHaveLength(28);
    expect(sha256(MIGRATIONS.slice(0, -1).join("\n"))).toBe("19ce4f2a3293379c19fab2280357f2aad408da623d858e34d487332b7a5f31fe");
    expect(MIGRATIONS.at(-1)).toContain("operator_messages");
    expect(MIGRATIONS.at(-1)).toContain("project_id TEXT NOT NULL");
    expect(MIGRATIONS.at(-1)).toContain("recipient IN ('operator', 'supervisor')");
    expect(TABLES).toContain("migration_runs");
    expect(TABLES).toContain("operator_messages");
    expect(MIGRATION_STATES).toEqual([
      "prepared", "frozen", "exported", "imported", "equivalent", "target_active", "exercised", "retired", "rolled_back", "fix_forward_required",
    ]);
    expect(MIGRATION_STEPS).toEqual([
      "record_inventory", "record_quiescence", "freeze", "record_export", "record_import", "record_equivalence", "activate", "record_exercise", "retire", "rollback", "mark_fix_forward_required",
    ]);
    expect(cachedConsumerRolloutEvidence(cachedConsumerObservations(11, 19))).toMatchObject({
      names: [...CACHED_CONSUMERS],
      oldSchemaVersion: 14,
      newSchemaVersion: 15,
      oldContractVersion: 21,
      newContractVersion: 21,
      action: "refused",
      expected: 4,
      attempted: 4,
      verified: 0,
    });
    expect(cachedConsumerRolloutEvidence(cachedConsumerObservations(15, 21))).toMatchObject({
      oldSchemaVersion: 14,
      newSchemaVersion: 15,
      oldContractVersion: 21,
      newContractVersion: 21,
      action: "reread",
      expected: 4,
      attempted: 4,
      verified: 4,
    });
    expect(cachedConsumerRolloutEvidence(cachedConsumerObservations(12, 19))).toMatchObject({
      names: [...CACHED_CONSUMERS],
      oldSchemaVersion: 14,
      newSchemaVersion: 15,
      oldContractVersion: 21,
      newContractVersion: 21,
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
      expect((db.prepare("PRAGMA table_info(work_item_waits)").all() as Array<{ name: string }>).map((row) => row.name)).toEqual([
        "project_id", "work_item_id", "waker", "declared_at_ms", "declared_by_seat", "waker_kind",
      ]);
      expect((db.prepare("PRAGMA index_list(migration_runs)").all() as Array<{ name: string; unique: number; partial: number }>).filter((row) => row.name.startsWith("migration_runs_"))).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "migration_runs_final_export_identity", unique: 1, partial: 1 }),
        expect.objectContaining({ name: "migration_runs_one_open", unique: 1, partial: 1 }),
      ]));
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("assembles the production v21 cached-consumer rollout receipt with stale-v20 refusal semantics", async () => {
    expect(CONTRACT_VERSION).toBe(21);
    expect(SCHEMA_VERSION).toBe(15);
    expect(MIGRATIONS).toHaveLength(28);
    expect(schemaDigest).toBe("3ed6ed11079141d5009cc57129502db80112f6d24a9d687ab545778e0b46c43f");
    expect(contractDigest).toBe("6df90c4315ca78dacb7043a45d28ccfdd259947d835bce3953d7b4f44b928c9f");
    const host = await loadedHost();
    const { db } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const beforeRefusal = exportFoundation(db, PROJECT_ID);
    const evidence = await assembleV21CachedConsumerRolloutEvidence({
      rpcContract: async () => doctorV21Reread("server.rpcContract", rpcContract.doctor.output.parse(
        await host.harness.callRpc("doctor", { projectId: PROJECT_ID }),
      ) as FoundationResult),
      collabCli: async () => doctorV21Reread("server.collabCli", JSON.parse(
        (await host.harness.runCli(["doctor", "--project", PROJECT_ID])).stdout,
      ) as FoundationResult),
      consumedLegacyReplay: async () => ({ ...policyProbeReread("src/foundation.consumedLegacyReplayProbe", { outcome: "OK" }, "OK"), consumedLegacyReplay: { outcome: "OK" } }),
      newLegacyApplyProvenance: async () => ({ ...policyProbeReread("src/foundation.newLegacyApplyProvenanceProbe", probeV21NewLegacyApplyProvenanceRefusal().newApplyRefusal, "OPERATOR_RECEIPT_INVALID"), newApplyRefusal: probeV21NewLegacyApplyProvenanceRefusal().newApplyRefusal }),
    });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeRefusal);
    expect(JSON.parse(evidence.durableRefJson)).toMatchObject({
      reread: { observations: CACHED_CONSUMERS.map((name) => ({ name, observedSchemaVersion: 15, observedContractVersion: 21 })), action: "reread", expected: 4, attempted: 4, verified: 4 },
      consumedLegacyReplay: { outcome: "OK" },
      newApplyGuard: { nullProvenance: { outcome: "OPERATOR_RECEIPT_INVALID" } },
    });
    expect(evidence).toMatchObject({
      evidenceId: "cached-consumer-v21-rollout-receipt",
      evidenceKind: "release",
      sourceKind: "release",
      sourceRef: "live-plugin:dist/server.js",
    });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeRefusal);
  });

  it("refuses v21 rollout evidence when one cached consumer did not execute", async () => {
    const { db, directory } = directDatabase();
    try {
      const rpcContractProbe = vi.fn(async () => ({ observedSchemaVersion: 11, observedContractVersion: 18 }));
      const collabCliProbe = vi.fn(async () => ({ observedSchemaVersion: 11, observedContractVersion: 18 }));
      const serverTestProbe = vi.fn(async () => ({ observedSchemaVersion: 11, observedContractVersion: 18 }));
      await expect(assembleV21CachedConsumerRolloutEvidence({
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

  it("keeps the v21 rollout assembler in production rather than test support", () => {
    expect(typeof assembleV21CachedConsumerRolloutEvidence).toBe("function");
    expect(CACHED_CONSUMERS).toEqual([
      "server.rpcContract",
      "server.collabCli",
      "src/foundation.consumedLegacyReplayProbe",
      "src/foundation.newLegacyApplyProvenanceProbe",
    ]);
    expect(readFileSync(new URL("../src/test-support.ts", import.meta.url), "utf8")).not.toContain("assembleV21CachedConsumerRolloutEvidence");
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
    expect(() => probeV21ConsumedLegacyReplay(db, PROJECT_ID)).toThrow("requires an observed consumed legacy receipt");
    expect(probeV21NewLegacyApplyProvenanceRefusal()).toMatchObject({
      observedSchemaVersion: 15,
      observedContractVersion: 21,
      newApplyRefusal: { outcome: "OPERATOR_RECEIPT_INVALID" },
    });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("refuses test, fixture, and source provenance before a non-live cached-consumer rollout can mutate", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const actorReceiptId = seedCurrentOrchestratorActor(db, fenceToken);
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken, "cached-consumer-v21-rollout-decision", {
      actorReceiptId,
    }))).toMatchObject({ outcome: "OK" });
    const before = exportFoundation(db, PROJECT_ID);
    for (const sourceRef of ["test:cached-consumer-v21-rollout-receipt", "fixture:cached-consumer-v21-rollout-receipt", "source:server.ts"]) {
      expect(await host.harness.callRpc("cachedConsumerRollout", decisionDispositionRequest(fenceToken, "cached-consumer-v21-rollout-decision", 1, {
        actorReceiptId,
        decisionEvidence: [decisionArtifact("cached-consumer-v21-rollout-receipt", {
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
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const actorReceiptId = seedCurrentOrchestratorActor(db, fenceToken);
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken, "cached-consumer-v21-rollout-dist-refusal", {
      actorReceiptId,
    }))).toMatchObject({ outcome: "OK" });
    const before = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("cachedConsumerRollout", decisionDispositionRequest(fenceToken, "cached-consumer-v21-rollout-dist-refusal", 1, {
        actorReceiptId,
      }))).toMatchObject({
        outcome: "INVALID_INPUT",
        attempted: 0,
        verified: 0,
        message: "cached-consumer v21 replay proof requires an observed consumed legacy receipt",
      });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("does not synthesize governed cached-consumer rollout success through the running dist seams", async () => {
    const host = await loadedDistHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const actorReceiptId = seedCurrentOrchestratorActor(db, fenceToken);
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken, "cached-consumer-v21-rollout-dist", {
      actorReceiptId,
    }))).toMatchObject({ outcome: "OK" });
    const request = decisionDispositionRequest(fenceToken, "cached-consumer-v21-rollout-dist", 1, { actorReceiptId });
    const before = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("cachedConsumerRollout", request)).toMatchObject({
      outcome: "INVALID_INPUT",
      attempted: 0,
      verified: 0,
        message: "cached-consumer v21 replay proof requires an observed consumed legacy receipt",
    });
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toContainEqual([
      expect.objectContaining({ pluginId: PLUGIN_ID, method: "doctor", input: { projectId: PROJECT_ID } }),
    ]);
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("treats a persisted v20 rollout receipt as unknown without migrating or requiring it", async () => {
    const host = await loadedHost();
    const { db } = seedAndBootstrap(host, PROJECT_ID, { config: directorSeatConfig() });
    seedEvidenceArtifact(db, "cached-consumer-v20-rollout-receipt");
    expect(await host.harness.callRpc("doctor", { projectId: PROJECT_ID })).toMatchObject({
      outcome: "OK",
      evidence: {
        cachedConsumers: {
          oldContractVersion: 21,
          newContractVersion: 21,
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
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const actorReceiptId = seedCurrentOrchestratorActor(db, fenceToken);
    expect(applyWithFixtureReceipt(db, decisionCreateRequest(fenceToken, "cached-consumer-v21-rollout-generic", {
      actorReceiptId,
    }))).toMatchObject({ outcome: "OK" });
    const before = exportFoundation(db, PROJECT_ID);
    expect(await host.harness.callRpc("apply", decisionDispositionRequest(fenceToken, "cached-consumer-v21-rollout-generic", 1, {
      actorReceiptId,
      decisionEvidence: [decisionArtifact("cached-consumer-v21-rollout-receipt", {
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

  it("refuses verified non-role actors for migration prepare and step", () => {
    const { db, directory } = directDatabase();
    try {
      const governor = seedMigrationAuthority(db);
      seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: "migration-non-role", actorKind: "operator" });
      const beforePrepare = exportFoundation(db, PROJECT_ID);
      expect(applyWithFixtureReceipt(db, migrationPrepareRequest(governor, {
        idempotencyKey: "migration-non-role-prepare",
        actorReceiptId: "migration-non-role",
      })).outcome).toBe("ACTOR_RECEIPT_UNVERIFIED");
      expect(exportFoundation(db, PROJECT_ID)).toEqual(beforePrepare);

      expect(applyWithFixtureReceipt(db, migrationPrepareRequest(governor))).toMatchObject({ outcome: "OK" });
      const beforeStep = exportFoundation(db, PROJECT_ID);
      expect(applyWithFixtureReceipt(db, migrationStepRequest(db, "record_inventory", {}, {
        idempotencyKey: "migration-non-role-step",
        actorReceiptId: "migration-non-role",
      })).outcome).toBe("ACTOR_RECEIPT_UNVERIFIED");
      expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeStep);
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
    expect(firstExport.manifest).toMatchObject({ schemaVersion: 15, schemaDigest, contractVersion: 21, contractDigest });
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

      const authorizedRelease = releaseInput({ idempotencyKey: "evidence-release-authorized" });
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
        mutationReceipt: { operationClass: "migration_step" },
      });
      expect(db.prepare("SELECT project_governorship_heads.state, project_governorships.runtime_id FROM project_governorship_heads JOIN project_governorships USING (project_id, governance_epoch) WHERE project_governorship_heads.project_id = ?").get(PROJECT_ID)).toEqual({ state: "target_active", runtime_id: PLUGIN_ID });
      expect(db.prepare("SELECT operator_receipt_id, idempotency_key, event_json FROM state_events WHERE project_id = ? ORDER BY event_sequence DESC LIMIT 1").get(PROJECT_ID)).toMatchObject({
        operator_receipt_id: null,
        idempotency_key: authorizedRelease.idempotencyKey,
        event_json: expect.stringContaining("evidence_only_equivalent_rollback"),
      });
      expect(db.prepare("SELECT operator_receipt_id, committed_event_sequence FROM mutation_receipts WHERE project_id = ? AND idempotency_key = ?").get(PROJECT_ID, authorizedRelease.idempotencyKey)).toEqual({
        operator_receipt_id: null,
        committed_event_sequence: released.eventSequence,
      });
      expect(db.prepare("SELECT state, recovery_digest FROM migration_runs WHERE project_id = ?").get(PROJECT_ID)).toEqual({ state: "rolled_back", recovery_digest: recoveryDigest });

      const afterRelease = exportFoundation(db, PROJECT_ID);
      expect(applyAuthorizedMutation(db, authorizedRelease)).toEqual(released);
      expect(exportFoundation(db, PROJECT_ID)).toEqual(afterRelease);
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
        actor_receipt_id: MIGRATION_ACTOR_RECEIPT_ID,
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

  it("validates historical linked actor receipts for canonical mutations", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
    const bootstrap = applyWithFixtureReceipt(db, bootstrapRequest());
    expect(bootstrap.outcome).toBe("OK");
    const fenceToken = (bootstrap.evidence as { fenceToken: string }).fenceToken;
    const receiptId = "historical-linked-actor";
    const operatorReceiptId = "historical-operator-receipt";
    const retirementCondition = "host-issued receipt get-bb/bb#1541";
    // Regression gap: every existing test minted fresh receipts with null fields, whose digests validate under either computation; only a historical linked receipt exposes Phase B's omission.
    const receiptDigest = sha256(canonicalJson({
      projectId: PROJECT_ID,
      receiptId,
      actorKind: "fixture",
      subjectId: receiptId,
      roleId: null,
      roleGeneration: null,
      verificationState: "verified",
      operatorReceiptId,
      retirementCondition,
    }));
    db.prepare(
      `INSERT INTO actor_receipts
        (project_id, receipt_id, actor_kind, subject_id, role_id, role_generation,
         verification_state, receipt_digest, issued_at_ms, operator_receipt_id, retirement_condition)
       VALUES (?, ?, 'fixture', ?, NULL, NULL, 'verified', ?, ?, ?, ?)`,
    ).run(PROJECT_ID, receiptId, receiptId, receiptDigest, Date.now(), operatorReceiptId, retirementCondition);

    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken, { actorReceiptId: receiptId }))).toMatchObject({ outcome: "OK" });
    expect(db.prepare("SELECT receipt_digest FROM actor_receipts WHERE receipt_id = ?").get(receiptId)).toEqual({ receipt_digest: receiptDigest });
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
        cachedConsumers: { oldSchemaVersion: 14, newSchemaVersion: 15, action: "unknown", expected: 4, attempted: 0, verified: 0 },
        schema: { version: 15 },
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

  it("retires stale WorkItems but refuses their non-terminal advance", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    const replacementTarget = {
      ...bootstrapRequest().targets![0]!,
      repoTargetId: SECOND_TARGET_ID,
      sourceId: "source-second",
      path: "/workspace/second",
    };
    expect(applyWithFixtureReceipt(db, {
      ...bootstrapRequest(),
      operationClass: "config_revision",
      idempotencyKey: "config-2-after-work-item",
      expectedConfigRevision: 1,
      configRevision: 2,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
      repoTargetId: SECOND_TARGET_ID,
      config: { permissionMode: "auto", visibility: "visible", repositoryTargets: [SECOND_TARGET_ID] },
      targets: [replacementTarget],
    }).outcome).toBe("OK");
    expect(db.prepare("SELECT repo_target_id FROM repository_targets WHERE config_revision = 2").all()).toEqual([
      { repo_target_id: SECOND_TARGET_ID },
    ]);

    // Reproduces the live defect: three config revisions left WorkItems unclosable.
    const beforeRefusal = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "ready", 1, {
      idempotencyKey: "stale-work-item-advance",
      expectedConfigRevision: 2,
    }))).toMatchObject({ outcome: "PROJECT_CONFIG_STALE", attempted: 0, currentConfigRevision: 2, expectedConfigRevision: 1 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeRefusal);

    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "cancelled", 1, {
      idempotencyKey: "stale-work-item-wrong-target",
      expectedConfigRevision: 2,
      repoTargetId: SECOND_TARGET_ID,
    }))).toMatchObject({ outcome: "REPO_TARGET_FOREIGN", attempted: 0 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeRefusal);

    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "cancelled", 1, {
      idempotencyKey: "stale-work-item-cancel",
      expectedConfigRevision: 2,
    }))).toMatchObject({ outcome: "OK", currentResourceRevision: 2 });
    expect(db.prepare("SELECT config_revision, lifecycle_state, resource_revision FROM work_items").get()).toEqual({
      config_revision: 1,
      lifecycle_state: "cancelled",
      resource_revision: 2,
    });
  });

  it("refuses terminalizing a stale WorkItem with an open wait, then clears and retires it", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, workItemWaitRequest(fenceToken, 1, {
      kind: "schedule", schedule: "stall-guard-liveness", declaredBySeat: "worker-seat",
    }))).toMatchObject({ outcome: "OK", currentResourceRevision: 2 });
    expect(applyWithFixtureReceipt(db, {
      ...bootstrapRequest(),
      operationClass: "config_revision",
      idempotencyKey: "config-2-after-wait",
      expectedConfigRevision: 1,
      configRevision: 2,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
      config: { permissionMode: "auto", visibility: "visible", repositoryTargets: [TARGET_ID] },
      targets: [{ ...bootstrapRequest().targets![0]!, defaultBranch: "develop" }],
    }).outcome).toBe("OK");

    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "cancelled", 2, {
      idempotencyKey: "stale-wait-terminal-refused",
      expectedConfigRevision: 2,
    }))).toMatchObject({ outcome: "WORK_ITEM_WAIT_OPEN", attempted: 0 });
    expect(applyWithFixtureReceipt(db, workItemWaitRequest(fenceToken, 2, null, {
      expectedConfigRevision: 2,
    }))).toMatchObject({ outcome: "OK", currentResourceRevision: 3 });
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "cancelled", 3, {
      idempotencyKey: "stale-wait-terminal",
      expectedConfigRevision: 2,
    }))).toMatchObject({ outcome: "OK", currentResourceRevision: 4 });
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
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken, { idempotencyKey: "wait-on-create", workItemWait: { kind: "schedule", schedule: "stall-guard-liveness", declaredBySeat: "worker-seat" } }))).toMatchObject({ outcome: "WORK_ITEM_STATE_INVALID", attempted: 0 });

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

  it("doctor measures in-progress WorkItems as active writing lanes", async () => {
    const host = await loadedHost();
    const config = roleConfig();
    (config.extensions.bbCollab as Record<string, unknown>).writingLaneCeiling = 0;
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config });
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken))).toMatchObject({ outcome: "OK", currentResourceRevision: 1 });
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "ready", 1))).toMatchObject({ outcome: "OK", currentResourceRevision: 2 });
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "in_progress", 2))).toMatchObject({ outcome: "OK", currentResourceRevision: 3 });

    expect(await host.harness.callRpc("doctor", { projectId: PROJECT_ID })).toMatchObject({
      outcome: "OK",
      evidence: {
        capacity: {
          writingLaneCeiling: 0,
          activeWriterCount: 1,
          activeWriterLaneIds: [WORK_ITEM_ID],
          duplicateLaneIds: [],
          ceilingViolated: true,
        },
      },
    });
  });

  it("records one WorkItem wait and refuses terminal transition until it is cleared", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "ready", 1)).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, workItemWaitRequest(fenceToken, 2, { kind: "schedule", schedule: "stall-guard-liveness", declaredBySeat: "worker-seat" }))).toMatchObject({
      outcome: "OK", currentResourceRevision: 3,
    });
    expect(db.prepare("SELECT work_item_id, waker, waker_kind, declared_by_seat FROM work_item_waits").get()).toEqual({
      work_item_id: WORK_ITEM_ID, waker: "stall-guard-liveness", waker_kind: "schedule", declared_by_seat: "worker-seat",
    });
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "cancelled", 3))).toMatchObject({ outcome: "WORK_ITEM_WAIT_OPEN", attempted: 0 });
    expect(applyWithFixtureReceipt(db, workItemWaitRequest(fenceToken, 3, null)).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "cancelled", 4)).outcome).toBe("OK");
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
      outcome: "QUALIFICATION_CONTEXT_FOREIGN",
      expected: 1,
      attempted: 0,
      verified: 0,
    });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeProductionRefusal);
  });

  it("briefs newly created canonical director and orchestrator seats with their own role content", async () => {
    const scenarios = [
      {
        name: "orchestrator",
        config: roleConfig(),
        qualification: {},
        succession: {},
        facts: roleReader(),
        heading: "# Orchestrator",
      },
      {
        name: "director",
        config: directorSeatConfig(),
        qualification: { roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID, qualificationId: "director-brief-qualification", declaredProfile: DIRECTOR_PROFILE },
        succession: { roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID, qualificationId: "director-brief-qualification", profileDigest: DIRECTOR_PROFILE_DIGEST, standbyProfile: DIRECTOR_STANDBY_PROFILE },
        facts: directorRoleReader(),
        heading: "# Director",
      },
    ];
    for (const scenario of scenarios) {
      const host = await loadedHost();
      host.harness.sdk.stub("threads.wait", (async () => ({ matched: true })) as never);
      host.harness.sdk.stub("threads.send", (async () => ({ ok: true })) as never);
      const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: scenario.config });
      expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, scenario.qualification), null, scenario.facts).outcome).toBe("OK");
      expect(applyWithFixtureReceipt(db, successionRequest(fenceToken, scenario.succession), null, scenario.facts).outcome).toBe("OK");

      await expect(host.harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: ROLE_THREAD_ID, projectId: PROJECT_ID }) })).resolves.toEqual({ errors: [] });
      const send = host.harness.inspection.sdk.callsTo("threads.send")[0]?.[0] as { input: Array<{ text: string }> };
      expect(send.input[0]?.text).toContain(scenario.heading);
      expect(send.input[0]?.text).not.toContain("# Worker");
    }
  });

  it("uses the bootstrap exemption without making its non-role actor the holder", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: "bootstrap-actor", actorKind: "plugin", subjectId: "bootstrap-subject" });
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, { actorReceiptId: "bootstrap-actor" }), null, roleReader()).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, successionRequest(fenceToken, { actorReceiptId: "bootstrap-actor" }), null, roleReader()).outcome).toBe("OK");
    const holder = db.prepare("SELECT origin, thread_id FROM execution_attempts WHERE origin = 'role_holder'").get() as { origin: string; thread_id: string };
    expect(holder).toEqual({ origin: "role_holder", thread_id: ROLE_THREAD_ID });
    expect(holder.thread_id).not.toBe("bootstrap-subject");
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
    const qualification = qualificationRequest(fenceToken, { idempotencyKey: "live-qualification" });
    expect(await host.harness.callRpc("apply", qualification)).toMatchObject({ outcome: "OK" });

    const succession = successionRequest(fenceToken, { idempotencyKey: "live-succession" });
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
      const request = qualificationRequest(fenceToken, { idempotencyKey: `live-${field}-witness` });
      const before = exportFoundation(db, PROJECT_ID);
      expect(await host.harness.callRpc("apply", request)).toMatchObject({
        outcome: "ROLE_CONTEXT_WITNESS",
        attempted: 0,
        verified: 0,
      });
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
      expect(host.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1);
      expect(host.harness.inspection.sdk.callsTo("threads.events.list")
        .map(([input]) => input)
        .filter((input) => (input as { limit?: string }).limit === "256")).toHaveLength(0);
    }
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
    const cases: Array<[string, (facts: ConstructorParameters<typeof DeterministicRoleFactReader>[0]) => void, string, Partial<ApplyRequest>?, string?]> = [
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
      ["model-fallback", (facts) => {
        facts.events[3]!.seq = 5;
        facts.events.splice(3, 0, { id: "fallback", seq: 4, type: "provider/modelFallback", data: { providerThreadId: "provider-thread-1" } });
      }, "EXECUTION_PROFILE_UNKNOWN", { roleContext: { threadId: ROLE_THREAD_ID, requestEventId: ROLE_REQUEST_EVENT_ID, requestEventSeq: 1, completionEventId: ROLE_COMPLETION_EVENT_ID, completionEventSeq: 5 } }],
    ];
    for (const [name, mutate, outcome, requestOverride, message] of cases) {
      const host = await loadedHost();
      const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
      const before = exportFoundation(db, PROJECT_ID);
      const result = applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
        idempotencyKey: `context-${name}`,
        qualificationId: `context-${name}`,
        ...requestOverride,
      }), null, roleReader(mutate));
      expect(result.outcome, name).toBe(outcome);
      if (message) expect(result.message, name).toBe(message);
      expect(exportFoundation(db, PROJECT_ID), name).toEqual(before);
    }
  });

  it("binds the cited completion without treating later same-provider turns as the cited turn", async () => {
    const { db, fenceToken } = seedAndBootstrap(await loadedHost(), PROJECT_ID, { config: roleConfig() });
    const facts = roleReader((input) => {
      input.events.push({ id: "later-completion", seq: 5, type: "turn/completed", data: { providerThreadId: "provider-thread-1", status: "completed" } });
    });
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
      idempotencyKey: "cited-completion-only",
      qualificationId: "cited-completion-only",
    }), null, facts)).toMatchObject({ outcome: "OK", attempted: 1, verified: 1 });
  });

  it("resolves a long-lived holder from exact cited events without enumerating its history", async () => {
    const { db, fenceToken } = seedAndBootstrap(await loadedHost(), PROJECT_ID, { config: roleConfig() });
    const roleContext = {
      threadId: ROLE_THREAD_ID,
      requestEventId: ROLE_REQUEST_EVENT_ID,
      requestEventSeq: 150_000,
      completionEventId: ROLE_COMPLETION_EVENT_ID,
      completionEventSeq: 165_000,
    };
    const facts = roleReader((input) => {
      const [request, accepted, started, completion] = input.events;
      input.events = [
        ...Array.from({ length: 18_238 }, (_, index) => ({ id: `history-${index + 1}`, seq: (index + 1) * 7, type: "agent/delta", data: {} })),
        { ...request!, seq: roleContext.requestEventSeq },
        { ...accepted!, seq: roleContext.requestEventSeq + 101 },
        { ...started!, seq: roleContext.requestEventSeq + 7_001 },
        { ...completion!, seq: roleContext.completionEventSeq },
        ...Array.from({ length: 400 }, (_, index) => ({ id: `later-${index + 1}`, seq: roleContext.completionEventSeq + (index + 1) * 11, type: "agent/delta", data: {} })),
      ];
    });
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
      idempotencyKey: "long-lived-exact-events",
      qualificationId: "long-lived-exact-events",
      roleContext,
    }), null, facts)).toMatchObject({ outcome: "OK", attempted: 1, verified: 1 });
    expect(facts.readCalls).toEqual([
      "server.id",
      `thread:${ROLE_THREAD_ID}`,
      `event:${ROLE_THREAD_ID}:${ROLE_REQUEST_EVENT_ID}:150000`,
      `event:${ROLE_THREAD_ID}:${ROLE_COMPLETION_EVENT_ID}:165000`,
      `environment:${ROLE_ENVIRONMENT_ID}`,
      `project:${PROJECT_ID}`,
      "host:host-main",
      "system.version",
      `eventsAfter:${ROLE_THREAD_ID}:150000:${ROLE_CONTEXT_EVENT_PAGE_SIZE}`,
    ]);
  });

  it("accepts 256 sparse reader-returned correlation events without a sequence-width assumption", async () => {
    const { db, fenceToken } = seedAndBootstrap(await loadedHost(), PROJECT_ID, { config: roleConfig() });
    const roleContext = {
      threadId: ROLE_THREAD_ID,
      requestEventId: ROLE_REQUEST_EVENT_ID,
      requestEventSeq: 10,
      completionEventId: ROLE_COMPLETION_EVENT_ID,
      completionEventSeq: 100_000,
    };
    const facts = roleReader((input) => {
      const [request, accepted, started, completion] = input.events;
      input.events = [
        { ...request!, seq: roleContext.requestEventSeq },
        { ...accepted!, seq: 100 },
        { ...started!, seq: 1_000 },
        ...Array.from({ length: ROLE_CONTEXT_EVENT_PAGE_SIZE - 2 }, (_, index) => ({
          id: `busy-delta-${index + 1}`,
          seq: 2_000 + index * 300,
          type: "agent/delta",
          data: {},
        })),
        { ...completion!, seq: roleContext.completionEventSeq },
      ];
    });
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
      idempotencyKey: "sparse-256-returned-events",
      qualificationId: "sparse-256-returned-events",
      roleContext,
    }), null, facts)).toMatchObject({ outcome: "OK", attempted: 1, verified: 1 });
  });

  it("resolves a cited turn whose correlation spans multiple reader pages", async () => {
    const { db, fenceToken } = seedAndBootstrap(await loadedHost(), PROJECT_ID, { config: roleConfig() });
    const facts = roleReader((input) => {
      const [request, accepted, started, completion] = input.events;
      input.events = [
        request!,
        accepted!,
        started!,
        ...Array.from({ length: 298 }, (_, index) => ({ id: `paged-${index + 1}`, seq: index + 4, type: "agent/delta", data: {} })),
        { ...completion!, seq: 302 },
      ];
    });
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
      idempotencyKey: "paged-role-correlation",
      qualificationId: "paged-role-correlation",
      roleContext: { threadId: ROLE_THREAD_ID, requestEventId: ROLE_REQUEST_EVENT_ID, requestEventSeq: 1, completionEventId: ROLE_COMPLETION_EVENT_ID, completionEventSeq: 302 },
    }), null, facts)).toMatchObject({ outcome: "OK", attempted: 1, verified: 1 });
  });

  it("pages the sanctioned SDK correlation read until the exact cited completion", async () => {
    const host = await loadedHost(PROJECT_ID, (input) => {
      const [request, accepted, started, completion] = input.events;
      input.events = [
        request!,
        accepted!,
        started!,
        ...Array.from({ length: 298 }, (_, index) => ({ id: `sdk-page-${index + 1}`, seq: index + 4, type: "agent/delta", data: {} })),
        { ...completion!, seq: 302 },
      ];
    });
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    expect(await host.harness.callRpc("apply", qualificationRequest(fenceToken, {
      idempotencyKey: "paged-sdk-role-correlation",
      qualificationId: "paged-sdk-role-correlation",
      roleContext: { threadId: ROLE_THREAD_ID, requestEventId: ROLE_REQUEST_EVENT_ID, requestEventSeq: 1, completionEventId: ROLE_COMPLETION_EVENT_ID, completionEventSeq: 302 },
    }))).toMatchObject({ outcome: "OK", attempted: 1, verified: 1 });
    expect(host.harness.inspection.sdk.callsTo("threads.events.list")
      .map(([input]) => input)
      .filter((input) => (input as { limit?: string }).limit === "256")).toEqual([
      { threadId: ROLE_THREAD_ID, afterSeq: "1", limit: "256" },
      { threadId: ROLE_THREAD_ID, afterSeq: "257", limit: "256" },
    ]);
  });

  it("refuses an SDK correlation that exhausts the 2,048-event total-work ceiling", async () => {
    const host = await loadedHost(PROJECT_ID, (input) => {
      const [request, accepted, started, completion] = input.events;
      input.events = [
        request!,
        accepted!,
        started!,
        ...Array.from({ length: 2_046 }, (_, index) => ({ id: `ceiling-${index + 1}`, seq: index + 4, type: "agent/delta", data: {} })),
        { ...completion!, seq: 2_050 },
      ];
    });
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const before = exportFoundation(db, PROJECT_ID);
    const result = await host.harness.callRpc("apply", qualificationRequest(fenceToken, {
      idempotencyKey: "role-correlation-work-ceiling",
      qualificationId: "role-correlation-work-ceiling",
      roleContext: { threadId: ROLE_THREAD_ID, requestEventId: ROLE_REQUEST_EVENT_ID, requestEventSeq: 1, completionEventId: ROLE_COMPLETION_EVENT_ID, completionEventSeq: 2_050 },
    }));
    expect(result).toMatchObject({ outcome: "EXECUTION_COMPLETION_AMBIGUOUS", attempted: 0, verified: 0 });
    expect((result as FoundationResult).message).toBe("role context correlation exceeds the 2,048-event total-work ceiling");
    expect(host.harness.inspection.sdk.callsTo("threads.events.list")
      .map(([input]) => input)
      .filter((input) => (input as { limit?: string }).limit === "256")).toHaveLength(8);
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("refuses a foreign SDK role context before reading any correlation page", async () => {
    const host = await loadedHost(PROJECT_ID, (input) => {
      const [request, accepted, started, completion] = input.events;
      input.thread.projectId = FOREIGN_PROJECT_ID;
      input.events = [
        request!,
        accepted!,
        started!,
        ...Array.from({ length: 49_998 }, (_, index) => ({ id: `foreign-${index + 1}`, seq: index + 4, type: "agent/delta", data: {} })),
        { ...completion!, seq: 50_002 },
      ];
    });
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, { config: roleConfig() });
    const before = exportFoundation(db, PROJECT_ID);
    const result = await host.harness.callRpc("apply", qualificationRequest(fenceToken, {
      idempotencyKey: "foreign-role-context-preflight",
      qualificationId: "foreign-role-context-preflight",
      roleContext: { threadId: ROLE_THREAD_ID, requestEventId: ROLE_REQUEST_EVENT_ID, requestEventSeq: 1, completionEventId: ROLE_COMPLETION_EVENT_ID, completionEventSeq: 50_002 },
    }));
    expect(result).toMatchObject({ outcome: "ROLE_CONTEXT_FOREIGN", attempted: 0, verified: 0 });
    expect(host.harness.inspection.sdk.callsTo("threads.events.list")
      .map(([input]) => input)
      .filter((input) => (input as { limit?: string }).limit === "256")).toHaveLength(0);
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("resolves the cited completion immediately after an exact full page", async () => {
    const { db, fenceToken } = seedAndBootstrap(await loadedHost(), PROJECT_ID, { config: roleConfig() });
    const facts = roleReader((input) => {
      const [request, accepted, started, completion] = input.events;
      input.events = [
        request!,
        accepted!,
        started!,
        ...Array.from({ length: 254 }, (_, index) => ({ id: `boundary-${index + 1}`, seq: index + 4, type: "agent/delta", data: {} })),
        { ...completion!, seq: 258 },
      ];
    });
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
      idempotencyKey: "page-boundary-role-correlation",
      qualificationId: "page-boundary-role-correlation",
      roleContext: { threadId: ROLE_THREAD_ID, requestEventId: ROLE_REQUEST_EVENT_ID, requestEventSeq: 1, completionEventId: ROLE_COMPLETION_EVENT_ID, completionEventSeq: 258 },
    }), null, facts)).toMatchObject({ outcome: "OK", attempted: 1, verified: 1 });
    expect(facts.readCalls.filter((call) => call.startsWith("eventsAfter:"))).toEqual([
      `eventsAfter:${ROLE_THREAD_ID}:1:256`,
      `eventsAfter:${ROLE_THREAD_ID}:257:256`,
    ]);
  });

  it("refuses a paged correlation whose exact cited completion never appears", async () => {
    const { db, fenceToken } = seedAndBootstrap(await loadedHost(), PROJECT_ID, { config: roleConfig() });
    const facts = roleReader();
    const eventsAfter = facts.eventsAfter.bind(facts);
    facts.eventsAfter = (threadId, afterSeq, limit) => eventsAfter(threadId, afterSeq, limit)
      .filter((event) => event.id !== ROLE_COMPLETION_EVENT_ID);
    const before = exportFoundation(db, PROJECT_ID);
    const result = applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
      idempotencyKey: "paged-completion-missing",
      qualificationId: "paged-completion-missing",
    }), null, facts);
    expect(result).toMatchObject({ outcome: "EXECUTION_COMPLETION_AMBIGUOUS", attempted: 0, verified: 0 });
    expect(result.message).toBe("reader-returned correlation is not terminated by the exact cited completion");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("refuses an atomic paged read instead of accepting a self-consistent partial window", async () => {
    const { db, fenceToken } = seedAndBootstrap(await loadedHost(), PROJECT_ID, { config: roleConfig() });
    const facts = roleReader((input) => {
      const [request, accepted, started, completion] = input.events;
      input.events = [
        request!,
        accepted!,
        started!,
        { id: "partial-completion", seq: 4, type: "turn/completed", data: { providerThreadId: "provider-thread-1", status: "completed" } },
        ...Array.from({ length: 253 }, (_, index) => ({ id: `partial-${index + 1}`, seq: index + 5, type: "agent/delta", data: {} })),
        { ...completion!, seq: 300 },
      ];
    });
    const eventsAfter = facts.eventsAfter.bind(facts);
    facts.eventsAfter = (threadId, afterSeq, limit) => afterSeq === 1
      ? eventsAfter(threadId, afterSeq, limit).filter((event) => event.id !== ROLE_COMPLETION_EVENT_ID).slice(0, 256)
      : [];
    const before = exportFoundation(db, PROJECT_ID);
    const result = applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
      idempotencyKey: "partial-window-refusal",
      qualificationId: "partial-window-refusal",
      roleContext: { threadId: ROLE_THREAD_ID, requestEventId: ROLE_REQUEST_EVENT_ID, requestEventSeq: 1, completionEventId: ROLE_COMPLETION_EVENT_ID, completionEventSeq: 300 },
    }), null, facts);
    expect(result).toMatchObject({ outcome: "EXECUTION_COMPLETION_AMBIGUOUS", attempted: 0, verified: 0 });
    expect(result.message).toBe("reader-returned correlation is not terminated by the exact cited completion");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("refuses mismatched or unsupported paged role-event ordering evidence without mutation", async () => {
    const { db, fenceToken } = seedAndBootstrap(await loadedHost(), PROJECT_ID, { config: roleConfig() });
    const incomplete = roleReader();
    const completeEventsAfter = incomplete.eventsAfter.bind(incomplete);
    incomplete.eventsAfter = (threadId, afterSeq, limit) => completeEventsAfter(threadId, afterSeq, limit)
      .filter((event) => event.id !== ROLE_COMPLETION_EVENT_ID);
    const cases: Array<[string, ReturnType<typeof roleReader>, Partial<ApplyRequest>, string, string?]> = [
      ["mismatched-sequence", roleReader(), { roleContext: { threadId: ROLE_THREAD_ID, requestEventId: ROLE_REQUEST_EVENT_ID, requestEventSeq: 2, completionEventId: ROLE_COMPLETION_EVENT_ID, completionEventSeq: 4 } }, "ROLE_CONTEXT_UNKNOWN"],
      ["inverted-sequences", roleReader((facts) => { facts.events[3]!.seq = 1; }), { roleContext: { threadId: ROLE_THREAD_ID, requestEventId: ROLE_REQUEST_EVENT_ID, requestEventSeq: 1, completionEventId: ROLE_COMPLETION_EVENT_ID, completionEventSeq: 1 } }, "EXECUTION_COMPLETION_AMBIGUOUS", "completion event sequence does not follow the request event sequence"],
      ["locally-unordered-prefix", roleReader((facts) => { [facts.events[1], facts.events[2]] = [facts.events[2]!, facts.events[1]!]; }), {}, "EXECUTION_COMPLETION_AMBIGUOUS", "reader-returned correlation events are not strictly ordered after the cited request"],
      ["completion-missing-from-returned-prefix", incomplete, {}, "EXECUTION_COMPLETION_AMBIGUOUS", "reader-returned correlation is not terminated by the exact cited completion"],
    ];
    for (const [name, facts, override, outcome, message] of cases) {
      const before = exportFoundation(db, PROJECT_ID);
      const result = applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
        idempotencyKey: `bounded-order-${name}`,
        qualificationId: `bounded-order-${name}`,
        ...override,
      }), null, facts);
      expect(result).toMatchObject({ outcome, attempted: 0, verified: 0 });
      if (message) expect(result.message).toBe(message);
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
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
        `event:${ROLE_THREAD_ID}:${ROLE_REQUEST_EVENT_ID}:1`,
        `event:${ROLE_THREAD_ID}:${ROLE_COMPLETION_EVENT_ID}:4`,
        `environment:${ROLE_ENVIRONMENT_ID}`,
        `project:${PROJECT_ID}`,
        "host:host-main",
        "system.version",
        `eventsAfter:${ROLE_THREAD_ID}:1:${ROLE_CONTEXT_EVENT_PAGE_SIZE}`,
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

  it("accepts a current role actor without ceremony writes", async () => {
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
    const authorityRowsBefore = db.prepare(
      "SELECT (SELECT COUNT(*) FROM operator_receipts) AS receipts, (SELECT COUNT(*) FROM authorized_approvers) AS approvers",
    ).get();
    expect(applyWithFixtureReceipt(db, qualificationRequest(fenceToken, {
      idempotencyKey: "role-actor-qualification",
      actorReceiptId: "role-actor-current",
      qualificationId: "role-actor-qualification",
    }), null, roleReader()).outcome).toBe("OK");
    expect(db.prepare(
      "SELECT (SELECT COUNT(*) FROM operator_receipts) AS receipts, (SELECT COUNT(*) FROM authorized_approvers) AS approvers",
    ).get()).toEqual(authorityRowsBefore);
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

  it("tolerates the retired first-generation exemption in stored role requirements", async () => {
    const host = await loadedHost();
    const { db } = seedAndBootstrap(host, PROJECT_ID, { config: directorSeatConfig() });
    const row = db.prepare(
      "SELECT canonical_config_json FROM project_config_revisions WHERE project_id = ? AND config_revision = 1",
    ).get(PROJECT_ID) as { canonical_config_json: string };
    const stored = JSON.parse(row.canonical_config_json) as { extensions: { bbCollab: { roleRequirements: Array<Record<string, unknown>> } } };
    stored.extensions.bbCollab.roleRequirements[0]!.firstGenerationExemption = {
      generation: 1,
      holderThreadId: "legacy-holder",
      environmentId: "legacy-environment",
      sourceId: "legacy-source",
    };
    const configJson = canonicalJson(stored);
    db.prepare(
      "UPDATE project_config_revisions SET canonical_config_json = ?, config_digest = ? WHERE project_id = ? AND config_revision = 1",
    ).run(configJson, sha256(configJson), PROJECT_ID);

    expect(await host.harness.callRpc("doctor", { projectId: PROJECT_ID })).toMatchObject({ outcome: "OK" });
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
    db.exec(MIGRATIONS.find((statement) => statement.includes("CREATE TABLE IF NOT EXISTS assignments"))!);
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
    expect(cachedConsumerRolloutEvidence(cachedConsumerObservations(11, 19))).toMatchObject({ oldSchemaVersion: 14, newSchemaVersion: 15, oldContractVersion: 21, newContractVersion: 21, action: "refused", expected: 4, attempted: 4, verified: 0 });
    expect(cachedConsumerRolloutEvidence(cachedConsumerObservations(12, 19))).toMatchObject({ oldSchemaVersion: 14, newSchemaVersion: 15, oldContractVersion: 21, newContractVersion: 21, action: "refused", expected: 4, attempted: 4, verified: 0 });
    expect(cachedConsumerRolloutEvidence(cachedConsumerObservations(12, 20))).toMatchObject({ oldSchemaVersion: 14, newSchemaVersion: 15, oldContractVersion: 21, newContractVersion: 21, action: "refused", expected: 4, attempted: 4, verified: 0 });
    expect(cachedConsumerRolloutEvidence(cachedConsumerObservations(15, 21))).toMatchObject({ oldSchemaVersion: 14, newSchemaVersion: 15, oldContractVersion: 21, newContractVersion: 21, action: "reread", expected: 4, attempted: 4, verified: 4 });
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

  it("keeps the documented WorkItem create invocation strict", () => {
    const request = workItemCreateRequest("fence-token");
    expect(parseApplyRequest(request)).toMatchObject({
      projectId: PROJECT_ID,
      operationClass: "work_item_create",
      idempotencyKey: "work-item-create-1",
      actorReceiptId: RECEIPT_ID,
      expectedConfigRevision: 1,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: "fence-token",
      repoTargetId: TARGET_ID,
      expectedResourceRevision: null,
      workItem: { workItemId: WORK_ITEM_ID, title: "Ship projection", body: "Keep canonical state local." },
    });

    const workItem = request.workItem!;
    expect(() => parseApplyRequest({ ...request, workItem: { title: workItem.title, body: workItem.body } })).toThrow(/workItemId/i);
    expect(() => parseApplyRequest({ ...request, actorReceiptId: { receiptId: RECEIPT_ID } })).toThrow(/actorReceiptId|expected string/i);
    expect(() => parseApplyRequest({ ...request, idempotencyKey: undefined })).toThrow(/idempotencyKey/i);
  });

  it("registers a WorkItem through the documented live CLI path and watchdog read path", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    const request = workItemCreateRequest(fenceToken, { idempotencyKey: "live-work-item-create" });
    const cli = await host.harness.runCli(["apply", "--project", PROJECT_ID, "--request", JSON.stringify(request)]);
    const result = JSON.parse(cli.stdout) as FoundationResult;

    expect(cli.exitCode).toBe(0);
    expect(result).toMatchObject({
      outcome: "OK",
      mutationReceipt: {
        projectId: PROJECT_ID,
        idempotencyKey: request.idempotencyKey,
        operationClass: "work_item_create",
      },
    });
    expect(db.prepare(
      "SELECT project_id, work_item_id, config_revision, repo_target_id, title, body, lifecycle_state, resource_revision FROM work_items WHERE project_id = ? AND work_item_id = ?",
    ).get(PROJECT_ID, WORK_ITEM_ID)).toEqual({
      project_id: PROJECT_ID,
      work_item_id: WORK_ITEM_ID,
      config_revision: 1,
      repo_target_id: TARGET_ID,
      title: "Ship projection",
      body: "Keep canonical state local.",
      lifecycle_state: "proposed",
      resource_revision: 1,
    });
    expect(db.prepare(
      "SELECT project_id, idempotency_key, operation_class, request_digest, committed_event_sequence FROM mutation_receipts WHERE project_id = ? AND idempotency_key = ?",
    ).get(PROJECT_ID, request.idempotencyKey)).toMatchObject({
      project_id: PROJECT_ID,
      idempotency_key: request.idempotencyKey,
      operation_class: "work_item_create",
      request_digest: result.mutationReceipt?.requestDigest,
      committed_event_sequence: result.mutationReceipt?.committedEventSequence,
    });

    const watchdogOpenWorkItems = db.prepare(
      `SELECT work_items.project_id, work_items.work_item_id, work_item_waits.waker, work_item_waits.waker_kind, work_item_waits.declared_at_ms
       FROM work_items LEFT JOIN work_item_waits
         ON work_item_waits.project_id = work_items.project_id AND work_item_waits.work_item_id = work_items.work_item_id
       WHERE work_items.lifecycle_state NOT IN ('succeeded', 'failed', 'cancelled')
       ORDER BY work_items.created_at_ms, work_items.work_item_id`,
    ).all() as Array<{ project_id: string; work_item_id: string; waker: string | null; waker_kind: string | null; declared_at_ms: number | null }>;
    expect(watchdogOpenWorkItems).toContainEqual({
      project_id: PROJECT_ID,
      work_item_id: WORK_ITEM_ID,
      waker: null,
      waker_kind: null,
      declared_at_ms: null,
    });
  });

  it("refuses an unknown actor before WorkItem or receipt commit", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    const request = workItemCreateRequest(fenceToken, {
      idempotencyKey: "live-work-item-unknown-actor",
      actorReceiptId: "actor-receipt-not-in-store",
    });
    const cli = await host.harness.runCli(["apply", "--project", PROJECT_ID, "--request", JSON.stringify(request)]);
    const result = JSON.parse(cli.stdout) as FoundationResult;

    expect(cli.exitCode).toBe(2);
    expect(result).toMatchObject({ outcome: "ACTOR_RECEIPT_UNKNOWN", attempted: 0, verified: 0 });
    expect(db.prepare("SELECT 1 FROM work_items WHERE project_id = ? AND work_item_id = ?").get(PROJECT_ID, WORK_ITEM_ID)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM mutation_receipts WHERE project_id = ? AND idempotency_key = ?").get(PROJECT_ID, request.idempotencyKey)).toBeUndefined();
  });

  it("keeps fixture insertion outside the production RPC/CLI surface", async () => {
    const host = await loadedHost();
    const registrations = host.harness.inspection.registrations;
    expect(registrations.rpcMethods).not.toContain("seed-fixture-receipt");
    expect(registrations.cli?.commands.map((command) => command.name)).toEqual(["doctor", "export", "apply", "cached-consumer-rollout", "wait-register", "wait-list", "wait-validator", "stall-guard", "fleet-watchdog", "archive-sweep", "worktree-cleanup", "send-to-operator", "inbox"]);
    expect(registrations.httpRoutes.map((route) => route.path)).toEqual(["/lanes"]);
    expect(seedFixtureDecision).toBeTypeOf("function");
  });

  it("runs worktree cleanup through the registered report-only CLI", async () => {
    const host = await loadedHost();
    host.harness.sdk.stub("threads.list", (async () => []) as never);
    const invalid = await host.harness.runCli(["worktree-cleanup", "--project", PROJECT_ID, "--apply"]);
    expect(invalid.exitCode).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ outcome: "INVALID_INPUT", message: expect.stringContaining("report-only command has no apply mode") });
    const reported = await host.harness.runCli(["worktree-cleanup", "--project", PROJECT_ID]);
    const output = JSON.parse(reported.stdout) as Record<string, unknown>;
    expect(reported.exitCode).toBe(2);
    expect(output).toMatchObject({ outcome: "refused", wouldRemove: [], environmentRecordsReleased: false });
    expect(output).not.toHaveProperty("removed");
  });
});
