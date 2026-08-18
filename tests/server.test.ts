import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract } from "@bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import plugin, { rpcContract } from "../server.js";
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
  MAX_ROLE_CONTEXT_EVENTS,
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
  schemaDigest,
  sha256,
  type ApplyRequest,
  type ExportPayload,
  type FoundationResult,
} from "../src/foundation.js";
import {
  applyWithFixtureReceipt,
  DeterministicGitHubIssueAdapter,
  DeterministicRoleFactReader,
  seedFixtureDecision,
  seedVerifiedFixtureReceipt,
} from "../src/test-support.js";
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
        list: async () => ({ plugins: [{ id: PLUGIN_ID, status: "running", schedules: [{ name: "wait-validator-liveness" }, { name: "thread-archive-sweep" }] }] }) as never,
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

function seedMigrationAuthority(db: Database.Database) {
  seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
  const bootstrap = applyWithFixtureReceipt(db, bootstrapRequest(PROJECT_ID, { config: roleConfig() }));
  expect(bootstrap.outcome).toBe("OK");
  const actorReceiptId = seedCurrentOrchestratorActor(db, (bootstrap.evidence as { fenceToken: string }).fenceToken, MIGRATION_ACTOR_RECEIPT_ID);
  seedFixtureDecision(db, {
    projectId: PROJECT_ID,
    decisionId: MIGRATION_DECISION_ID,
    scope: { operation: "migration", projectId: PROJECT_ID },
    decisionClass: "role_succession",
    options: { sourceSystem: "llm-collab", targetRuntimeId: PLUGIN_ID },
  });
  db.prepare(
    `INSERT INTO decision_dispositions
      (decision_id, disposition_sequence, disposition, actor_receipt_id, reason_json, created_at_ms, idempotency_key)
     VALUES (?, 1, 'adopted', ?, ?, 1, 'migration-decision-adopted')`,
  ).run(MIGRATION_DECISION_ID, actorReceiptId, canonicalJson({ reason: "fixture cutover authorized" }));
  return currentGovernor(db);
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
