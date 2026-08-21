import { randomBytes } from "node:crypto";
import { defineRpcContract, type BbPluginApi, type PluginCliContext } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  createLaneWatcher,
  createIdleFleetDetector,
  createRoleIdleLedger,
  createWaitRegistry,
  IDLE_FLEET_DEBOUNCE_MS,
  readCurrentRoleBindings,
  readRoleHolderStates,
  roleIdleKey,
  subscribeToThreadChanges,
  threadEventStatus,
  type RoleHolderState,
  type IdleFleetDecision,
  type IdleFleetProbe,
  type IdleFleetReady,
  type RoleIdleRecord,
} from "./src/awareness.js";
import {
  BB_VERSION_RANGE,
  backfillWorkItemGithubIssues,
  backfillWorkItemAttempts,
  MIGRATIONS,
  ROLE_CONTEXT_EVENT_PAGE_SIZE,
  PLUGIN_ID,
  PLUGIN_SDK_VERSION,
  assembleV22CachedConsumerRolloutEvidence,
  applyAuthorizedMutation,
  applyRequestSchema,
  databaseIsReady,
  doctor,
  exportFoundation,
  canonicalJson,
  mutationRequestDigest,
  isRefusal,
  probeV21NewLegacyApplyProvenanceRefusal,
  probeV21ConsumedLegacyReplay,
  parseApplyRequest,
  refusal,
  roleContextPreflightRefusal,
  writingLaneCeilingFromJson,
  WORK_ITEM_NON_TERMINAL_STATES,
  WORK_ITEM_CAPACITY_ATTEMPT_STATES,
  WORK_ITEM_CAPACITY_LIFECYCLE_STATES,
  workItemCapacityLaneEvidence,
  reconcilePreparedWorkItemDispatches,
  type ApplyRequest,
  type FoundationCode,
  type FoundationResult,
  type GitHubIssueSnapshot,
  type RoleFactReader,
  type SqliteDatabase,
} from "./src/foundation.js";
import {
  createStallGuardCycle,
  STALL_GUARD_KV_KEY,
  STALL_GUARD_LIVENESS_ALERT_FLAG_FILENAME,
  STALL_GUARD_LIVENESS_MARKER_FILENAME,
  stallGuardStateDir,
} from "./src/stall-guard.js";
import {
  LIVENESS_ALERT_FLAG_FILENAME,
  LIVENESS_MARKER_FILENAME,
  WAIT_ESCALATION_KV_KEY,
  createWaitEscalationCycle,
  LIVENESS_STALE_MS,
  livenessDecision,
  livenessState,
  registerBoundedWait,
  waitValidatorStateDir,
  type SourceObservation,
} from "./src/registered-waits.js";
import { ARCHIVE_SWEEP_GUARD, createArchiveSweepRefusalCounter, runArchiveSweep, type ArchiveSweepRefusalAggregate } from "./src/archive-sweep.js";
import { canonicalWorktreePath, cleanupGitWorktrees, listAllProjectThreads } from "./src/worktree-cleanup.js";
import { findCheckoutRoot, readCheckoutDivergence, type CheckoutDivergence } from "./src/checkout-divergence.js";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFile, spawnSync, type ExecFileException, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

type PluginOptions = {
  checkoutRoot?: string | null;
  checkDeployedDist?: () => void;
  notifyUrgent?: (message: string, senderThreadId: string) => Promise<void>;
  runBbCommand?: (args: string[]) => Promise<void>;
};
type WorkItemWait = NonNullable<ApplyRequest["workItemWait"]>;
const ERROR_RECOVERY_IO_TIMEOUT_MS = 10_000;

type LaneRecoveryTarget = { project_id: string; thread_id: string; execution_attempt_id: string };

export const fleetWatchdogCompositeKey = (...parts: string[]) => JSON.stringify(parts);
export const fleetWatchdogIssueReopenedKey = (workItemId: string, externalRevision: string) =>
  `fleet-watchdog:issue-reopened:${fleetWatchdogCompositeKey(workItemId, externalRevision)}`;
const fleetWatchdogLegacyIssueReopenedKey = (workItemId: string, externalRevision: string) =>
  `fleet-watchdog:issue-reopened:${workItemId}:${externalRevision}`;
export const fleetWatchdogMergeCloseKey = (workItemId: string, state: string, externalRevision: string) =>
  `fleet-watchdog:merge-close:${fleetWatchdogCompositeKey(workItemId, state, externalRevision)}`;
const fleetWatchdogLegacyMergeCloseKey = (workItemId: string, state: string, externalRevision: string) =>
  `fleet-watchdog:merge-close:${workItemId}:${state}:${externalRevision}`;
export const fleetWatchdogBlockerFiredKey = (workItemId: string, subject: string) =>
  `fleet-watchdog:blocker-fired:${fleetWatchdogCompositeKey(workItemId, subject)}`;
const fleetWatchdogLegacyBlockerFiredKey = (workItemId: string, subject: string) =>
  `fleet-watchdog:blocker-fired:${workItemId}:${subject}`;
export const fleetWatchdogRoleLivenessKey = (holder: RoleHolderState) => fleetWatchdogCompositeKey(
  holder.project_id, holder.role_id, String(holder.role_generation), holder.execution_attempt_id, holder.thread_id,
);
export const fleetWatchdogEpisodeKey = (holder: RoleHolderState, queueHead: string) => fleetWatchdogCompositeKey(
  holder.project_id, holder.role_id, String(holder.role_generation), holder.execution_attempt_id, holder.thread_id, "activeLanes=0", queueHead,
);
const fleetWatchdogLegacyEpisodeKey = (holder: RoleHolderState, queueHead: string) => [
  holder.project_id, holder.role_id, holder.role_generation, holder.execution_attempt_id, holder.thread_id, "activeLanes=0", queueHead,
].join(":");
export const fleetWatchdogScope = (prefix: string, ...parts: string[]) => `${prefix}:${fleetWatchdogCompositeKey(...parts)}`;
const fleetWatchdogScopeMessage = (scope: string) => {
  const separator = scope.indexOf(":");
  if (separator < 0) return scope;
  try {
    const parts = JSON.parse(scope.slice(separator + 1)) as unknown;
    return `${scope.slice(0, separator)}:${Array.isArray(parts) ? parts.join(":") : scope.slice(separator + 1)}`;
  } catch {
    return scope;
  }
};

export const fleetWatchdogReopenKey = (projectId: string, workItemId: string, externalRevision?: string) =>
  fleetWatchdogCompositeKey(...[projectId, workItemId, externalRevision].filter((value): value is string => value !== undefined));

function githubRepository(remoteUrl: string | null): string | null {
  const match = remoteUrl?.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?$/u);
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : null;
}

type StartableQueueState = { count: number; head: string | null; unlabelledCount: number; blockedCount: number; waitingExternalCount: number };

function githubJson(args: string[]): unknown | null {
  try {
    const options: SpawnSyncOptionsWithStringEncoding & { detached: true } = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, killSignal: "SIGKILL", detached: true };
    const result = spawnSync("gh", args, options);
    if (typeof result.pid === "number" && result.pid > 0) {
      try {
        process.kill(-result.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return null;
      }
    }
    if (result.error || result.status !== 0) return null;
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return null;
  }
}

function githubJsonAsync(args: string[]): Promise<unknown | null> {
  return new Promise((resolve) => {
    execFile("gh", args, { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

async function startableQueueStateAsync(repositories: string[]): Promise<StartableQueueState | null> {
  let count = 0;
  let unlabelledCount = 0;
  let blockedCount = 0;
  let waitingExternalCount = 0;
  const heads: string[] = [];
  const isIssue = (issue: unknown): issue is { number: number; labels: Array<{ name: string }> } => Boolean(issue && typeof issue === "object" && !Array.isArray(issue)
    && typeof (issue as { number?: unknown }).number === "number"
    && Array.isArray((issue as { labels?: unknown }).labels)
    && (issue as { labels: unknown[] }).labels.every((label) => label && typeof label === "object" && !Array.isArray(label) && typeof (label as { name?: unknown }).name === "string"));
  for (const repository of repositories) {
    const startable = await githubJsonAsync(["issue", "list", "--repo", repository, "--label", "queue:startable", "--state", "open", "--json", "number,labels", "--limit", "1000"]);
    const pages = await githubJsonAsync(["api", `repos/${repository}/issues`, "--paginate", "--slurp", "--method", "GET", "-f", "state=open", "-f", "per_page=100"]);
    if (!Array.isArray(startable) || !startable.every(isIssue)
      || !Array.isArray(pages) || !pages.every((page) => Array.isArray(page) && page.every(isIssue))) return null;
    count += startable.length;
    const issues = pages.flat().filter((issue) => !("pull_request" in issue));
    unlabelledCount += issues.filter((issue) => !issue.labels.some((label) => label.name.startsWith("queue:"))).length;
    blockedCount += issues.filter((issue) => issue.labels.some((label) => label.name === "queue:blocked")).length;
    waitingExternalCount += issues.filter((issue) => issue.labels.some((label) => label.name === "queue:waiting-external")).length;
    const numbers = startable.map((issue) => issue.number);
    if (numbers.length > 0) heads.push(`${repository}#${Math.min(...numbers)}`);
  }
  return { count, head: heads.sort()[0] ?? null, unlabelledCount, blockedCount, waitingExternalCount };
}

function startableQueueState(repositories: string[]): StartableQueueState | null {
  let count = 0;
  let unlabelledCount = 0;
  let blockedCount = 0;
  let waitingExternalCount = 0;
  const heads: string[] = [];
  const isIssue = (issue: unknown): issue is { number: number; labels: Array<{ name: string }> } => Boolean(issue && typeof issue === "object" && !Array.isArray(issue)
    && typeof (issue as { number?: unknown }).number === "number"
    && Array.isArray((issue as { labels?: unknown }).labels)
    && (issue as { labels: unknown[] }).labels.every((label) => label && typeof label === "object" && !Array.isArray(label) && typeof (label as { name?: unknown }).name === "string"));
  for (const repository of repositories) {
    const startable = githubJson(["issue", "list", "--repo", repository, "--label", "queue:startable", "--state", "open", "--json", "number,labels", "--limit", "1000"]);
    const pages = githubJson(["api", `repos/${repository}/issues`, "--paginate", "--slurp", "--method", "GET", "-f", "state=open", "-f", "per_page=100"]);
    if (!Array.isArray(startable) || !startable.every(isIssue)
      || !Array.isArray(pages) || !pages.every((page) => Array.isArray(page) && page.every(isIssue))) return null;
    count += startable.length;
    const issues = pages.flat().filter((issue) => !("pull_request" in issue));
    unlabelledCount += issues.filter((issue) => !issue.labels.some((label) => label.name.startsWith("queue:"))).length;
    blockedCount += issues.filter((issue) => issue.labels.some((label) => label.name === "queue:blocked")).length;
    waitingExternalCount += issues.filter((issue) => issue.labels.some((label) => label.name === "queue:waiting-external")).length;
    const numbers = startable.map((issue) => issue.number);
    if (numbers.length > 0) heads.push(`${repository}#${Math.min(...numbers)}`);
  }
  return { count, head: heads.sort()[0] ?? null, unlabelledCount, blockedCount, waitingExternalCount };
}

type LinkedGithubStatus = "open" | "closed" | "merged";

type GithubStateReason = "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED";

function validGithubStateReason(state: unknown, reason: unknown): boolean {
  return state === "OPEN"
    ? reason === undefined || reason === null || reason === "" || reason === "REOPENED"
    : state === "CLOSED"
      && (reason === "COMPLETED" || reason === "NOT_PLANNED" || reason === "DUPLICATE");
}

type LinkedGithubObservation = {
  status: LinkedGithubStatus;
  pullRequestMerged: boolean;
  issueClosed: boolean;
  issueOpen: boolean;
  stateReason?: GithubStateReason;
  externalRevision: string;
  updatedAtMs: number | null;
};

async function linkedGithubObservationAsync(owner: string, repo: string, issueNumber: number): Promise<LinkedGithubObservation | null> {
  const issue = await githubJsonAsync(["issue", "view", String(issueNumber), "--repo", `${owner}/${repo}`, "--json", "state,stateReason,updatedAt,closedByPullRequestsReferences"]);
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) return null;
  const issueState = (issue as { state?: unknown }).state;
  const stateReason = (issue as { stateReason?: unknown }).stateReason;
  const externalRevision = (issue as { updatedAt?: unknown }).updatedAt;
  const closingPullRequests = (issue as { closedByPullRequestsReferences?: unknown }).closedByPullRequestsReferences;
  if ((issueState !== "OPEN" && issueState !== "CLOSED") || !validGithubStateReason(issueState, stateReason) || typeof externalRevision !== "string" || !Array.isArray(closingPullRequests)) return null;
  const closingPullRequest = closingPullRequests[0];
  if (closingPullRequest !== undefined && (!closingPullRequest || typeof closingPullRequest !== "object" || Array.isArray(closingPullRequest)
    || typeof (closingPullRequest as { number?: unknown }).number !== "number"
    || !Number.isSafeInteger((closingPullRequest as { number: number }).number))) return null;
  const pullRequest = closingPullRequest === undefined
    ? null
    : await githubJsonAsync(["pr", "view", String((closingPullRequest as { number: number }).number), "--repo", `${owner}/${repo}`, "--json", "state,mergedAt"]);
  let pullRequestMerged = false;
  let pullRequestClosed = false;
  if (pullRequest && typeof pullRequest === "object" && !Array.isArray(pullRequest)) {
    const state = (pullRequest as { state?: unknown }).state;
    const mergedAt = (pullRequest as { mergedAt?: unknown }).mergedAt;
    pullRequestMerged = (mergedAt !== null && mergedAt !== undefined) || state === "MERGED";
    pullRequestClosed = state === "CLOSED";
  }
  const issueClosed = issueState === "CLOSED";
  const issueOpen = issueState === "OPEN";
  const status = pullRequestMerged || pullRequestClosed || issueClosed ? pullRequestMerged ? "merged" : "closed" : issueOpen ? "open" : null;
  const updatedAtMs = Date.parse(externalRevision);
  return status === null ? null : { status, pullRequestMerged, issueClosed, issueOpen, stateReason: stateReason === "" || stateReason === null ? undefined : stateReason as GithubStateReason, externalRevision, updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : null };
}

async function readGithubIssueForBackfillAsync(owner: string, repo: string, issueNumber: number): Promise<GitHubIssueSnapshot> {
  const value = await githubJsonAsync(["issue", "view", String(issueNumber), "--repo", `${owner}/${repo}`, "--json", "number,title,body,state,stateReason,labels,updatedAt"]);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub issue lookup unavailable");
  const record = value as { number?: unknown; title?: unknown; body?: unknown; state?: unknown; stateReason?: unknown; labels?: unknown; updatedAt?: unknown };
  if (typeof record.number !== "number" || !Number.isSafeInteger(record.number) || typeof record.title !== "string"
    || (record.body !== null && typeof record.body !== "string") || (record.state !== "OPEN" && record.state !== "CLOSED")
    || !validGithubStateReason(record.state, record.stateReason)
    || !Array.isArray(record.labels) || !record.labels.every((label) => label && typeof label === "object" && !Array.isArray(label) && typeof (label as { name?: unknown }).name === "string")
    || typeof record.updatedAt !== "string") throw new Error("GitHub issue response is invalid");
  return { owner, repo, issueNumber: record.number, title: record.title, body: record.body ?? "", state: record.state === "OPEN" ? "open" : "closed", stateReason: record.stateReason === "" || record.stateReason === null ? undefined : record.stateReason as GithubStateReason, labels: (record.labels as Array<{ name: string }>).map((label) => label.name), externalRevision: record.updatedAt };
}

function linkedGithubObservation(owner: string, repo: string, issueNumber: number): LinkedGithubObservation | null {
  const issue = githubJson(["issue", "view", String(issueNumber), "--repo", `${owner}/${repo}`, "--json", "state,stateReason,updatedAt,closedByPullRequestsReferences"]);
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) return null;
  const issueState = (issue as { state?: unknown }).state;
  const stateReason = (issue as { stateReason?: unknown }).stateReason;
  const externalRevision = (issue as { updatedAt?: unknown }).updatedAt;
  const closingPullRequests = (issue as { closedByPullRequestsReferences?: unknown }).closedByPullRequestsReferences;
  if ((issueState !== "OPEN" && issueState !== "CLOSED") || !validGithubStateReason(issueState, stateReason) || typeof externalRevision !== "string" || !Array.isArray(closingPullRequests)) return null;
  const closingPullRequest = closingPullRequests[0];
  if (closingPullRequest !== undefined && (!closingPullRequest || typeof closingPullRequest !== "object" || Array.isArray(closingPullRequest)
    || typeof (closingPullRequest as { number?: unknown }).number !== "number"
    || !Number.isSafeInteger((closingPullRequest as { number: number }).number))) return null;
  const pullRequest = closingPullRequest === undefined
    ? null
    : githubJson(["pr", "view", String((closingPullRequest as { number: number }).number), "--repo", `${owner}/${repo}`, "--json", "state,mergedAt"]);
  let pullRequestMerged = false;
  let pullRequestClosed = false;
  if (pullRequest && typeof pullRequest === "object" && !Array.isArray(pullRequest)) {
    const state = (pullRequest as { state?: unknown }).state;
    const mergedAt = (pullRequest as { mergedAt?: unknown }).mergedAt;
    pullRequestMerged = (mergedAt !== null && mergedAt !== undefined) || state === "MERGED";
    pullRequestClosed = state === "CLOSED";
  }
  const issueClosed = issueState === "CLOSED";
  const issueOpen = issueState === "OPEN";
  const status = pullRequestMerged || pullRequestClosed || issueClosed
    ? pullRequestMerged ? "merged" : "closed"
    : issueOpen ? "open" : null;
  const updatedAtMs = Date.parse(externalRevision);
  return status === null ? null : { status, pullRequestMerged, issueClosed, issueOpen, stateReason: stateReason === "" || stateReason === null ? undefined : stateReason as GithubStateReason, externalRevision, updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : null };
}

function readGithubIssueForBackfill(owner: string, repo: string, issueNumber: number): GitHubIssueSnapshot {
  const value = githubJson(["issue", "view", String(issueNumber), "--repo", `${owner}/${repo}`, "--json", "number,title,body,state,stateReason,labels,updatedAt"]);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub issue lookup unavailable");
  const record = value as { number?: unknown; title?: unknown; body?: unknown; state?: unknown; stateReason?: unknown; labels?: unknown; updatedAt?: unknown };
  if (
    typeof record.number !== "number" ||
    !Number.isSafeInteger(record.number) ||
    typeof record.title !== "string" ||
    (record.body !== null && typeof record.body !== "string") ||
    (record.state !== "OPEN" && record.state !== "CLOSED") ||
    !validGithubStateReason(record.state, record.stateReason) ||
    !Array.isArray(record.labels) ||
    !record.labels.every((label) => label && typeof label === "object" && !Array.isArray(label) && typeof (label as { name?: unknown }).name === "string") ||
    typeof record.updatedAt !== "string"
  ) throw new Error("GitHub issue response is invalid");
  return {
    owner,
    repo,
    issueNumber: record.number,
    title: record.title,
    body: record.body ?? "",
    state: record.state === "OPEN" ? "open" : "closed",
    stateReason: record.stateReason === "" || record.stateReason === null ? undefined : record.stateReason as GithubStateReason,
    labels: record.labels.map((label) => (label as { name: string }).name),
    externalRevision: record.updatedAt,
  };
}

export const FLEET_WATCHDOG_FLOOR_MS = 5 * 60_000;
export const FLEET_WATCHDOG_NOTIFICATION_FLOOR_MS = 60 * 60_000;
export const IDLE_FLEET_ATTEMPT_STALE_MS = 10 * 60_000;
const FLEET_WATCHDOG_LEGACY_FLOOR_MS = 60 * 60_000;
const FLEET_WATCHDOG_FLOOR_MIGRATION_KEY = "fleet-watchdog.floor-default-v2-migrated";
export const FLEET_WATCHDOG_STALE_WAIT_MS = 24 * 60 * 60_000;
const FLEET_WATCHDOG_STOPPING_WAIT_MS = 30_000;
const AUTOMATED_TELL_IDLE_WAIT_MS = 30_000;
const automatedTellQueues = new Map<string, Promise<void>>();
const operatorRepliesInFlight = new Set<string>();
const projectIdSchema = z.string().trim().min(1).max(256);
const mutationReceiptSchema = z
  .object({
    projectId: projectIdSchema,
    idempotencyKey: z.string(),
    operationClass: z.string(),
    requestDigest: z.string(),
    committedEventSequence: z.number().int().positive(),
    createdAtMs: z.number().int().nonnegative(),
  })
  .strict();
const exportSchema = z
  .object({
    manifest: z
      .object({
        schemaVersion: z.number().int().positive(),
        contractVersion: z.number().int().positive(),
        pluginId: z.string(),
        projectId: projectIdSchema,
        migrationStatementIds: z.array(z.number().int().nonnegative()),
        schemaDigest: z.string(),
        contractDigest: z.string(),
        rowCount: z.number().int().nonnegative(),
        tableCounts: z.record(z.string(), z.number().int().nonnegative()),
        recordsDigest: z.string(),
        artifactIndexDigest: z.string(),
        exportRootDigest: z.string(),
      })
      .strict(),
    recordsNdjson: z.string(),
    artifactIndex: z.array(
      z
        .object({
          evidenceId: z.string(),
          evidenceKind: z.string(),
          sourceKind: z.string(),
          sourceRef: z.string(),
          executionAttemptId: z.string().nullable(),
          contentDigest: z.string(),
          redactedJson: z.string(),
          redactedDigest: z.string(),
          durableRefJson: z.string(),
          artifactIdentityDigest: z.string(),
        })
        .strict(),
    ),
    checksums: z.record(z.string(), z.string()),
  })
  .strict();
export const foundationResultSchema = z
  .object({
    outcome: z.string(),
    subject: z.string(),
    expected: z.number().int().nonnegative(),
    attempted: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    message: z.string().optional(),
    currentConfigRevision: z.number().int().positive().optional(),
    expectedConfigRevision: z.number().int().nonnegative().optional(),
    currentGovernanceEpoch: z.number().int().positive().optional(),
    expectedGovernanceEpoch: z.number().int().nonnegative().optional(),
    currentResourceRevision: z.number().int().positive().optional(),
    expectedResourceRevision: z.number().int().positive().optional(),
    structurallyImpossibleAtRevision: z.boolean().optional(),
    mutationReceipt: mutationReceiptSchema.optional(),
    actorReceiptId: z.string().optional(),
    eventSequence: z.number().int().positive().optional(),
    evidence: z.unknown().optional(),
    export: exportSchema.optional(),
  })
  .strict();

const laneViewSchema = z
  .object({
    projectId: projectIdSchema,
    laneId: projectIdSchema,
    assignmentId: projectIdSchema,
    assignmentKind: z.enum(["write", "review", "probe"]),
    workItemId: projectIdSchema,
    threadId: projectIdSchema.nullable(),
    executionAttemptId: projectIdSchema,
    attemptState: z.string(),
    workerStatus: z.enum(["active", "idle", "error", "starting", "stopping"]).nullable(),
    waitingOn: z.string().nullable(),
    ageMs: z.number().int().nonnegative(),
    tone: z.enum(["default", "running", "success", "error"]),
    queueState: z.enum(["ready", "running", "deferred"]),
    queueBlocked: z.boolean(),
    nextStartable: z.boolean(),
    deferredReason: z.literal("awaiting_operator").nullable(),
    deferredAtMs: z.number().int().nonnegative().nullable(),
    deferredAgeMs: z.number().int().nonnegative().nullable(),
  })
  .strict();

const laneListSchema = z.array(laneViewSchema);
const sidebarThreadIdSchema = z.string().trim().min(1).max(256);
const registeredWaitInputSchema = z.object({
  waitId: sidebarThreadIdSchema,
  waiterThreadId: sidebarThreadIdSchema,
  sourceThreadId: sidebarThreadIdSchema,
  sourceEvent: z.enum(["terminal", "failure"]),
  deadlineAtMs: z.number().int().nonnegative(),
  wakerSchedule: sidebarThreadIdSchema,
}).strict();
const registeredWaitSchema = registeredWaitInputSchema.extend({
  declaredAtMs: z.number().int().nonnegative(),
}).strict();
const sidebarThreadStateSchema = z.string().trim().min(1).max(64);
const sidebarThreadStateKey = (threadId: string) => `sidebar.thread-state:${threadId}`;
const sidebarReasoningLevelSchema = z.enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]);
const sidebarThreadExecutionSchema = z
  .object({ model: z.string(), reasoning: sidebarReasoningLevelSchema })
  .strict();
const sidebarCollapseKindSchema = z.enum(["project", "thread"]);
const sidebarCollapseKey = (kind: "project" | "thread", id: string) => `sidebar.collapse:${JSON.stringify([kind, id])}`;
const legacySidebarCollapseKey = (kind: "project" | "thread", id: string) => `sidebar.collapse:${kind}:${id}`;
const roleBriefRoleSchema = z.enum(["director", "orchestrator", "worker"]);
const roleBriefBundleSchema = z.object({
  ponytail: z.string().min(1),
  rules: z.string().min(1),
  roles: z.object({ director: z.string().min(1), orchestrator: z.string().min(1), worker: z.string().min(1) }).strict(),
}).strict();
const roleBriefSchema = z.object({
  role: roleBriefRoleSchema,
  roleContent: z.string().min(1),
  ponytail: z.string().min(1),
  rules: z.string().min(1),
  project: z.object({ id: projectIdSchema, name: z.string(), sourceIds: z.array(z.string()) }).strict(),
  pointers: z.object({ canonicalStoreQuery: z.string(), handoffFile: z.string(), currentSeats: z.array(z.object({ roleId: z.string(), generation: z.number().int().positive(), threadId: z.string() }).strict()) }).strict(),
  prompt: z.string().min(1),
}).strict();
const operatorRecipientSchema = z.enum(["operator", "supervisor"]);
const operatorSeveritySchema = z.enum(["routine", "needs-decision", "urgent"]);
const operatorMessageTextSchema = z.string().trim().min(1).max(16_000);
const operatorMessageSchema = z.object({
  messageId: z.number().int().positive(),
  projectId: projectIdSchema,
  recipient: operatorRecipientSchema,
  senderThreadId: sidebarThreadIdSchema,
  senderLaneId: sidebarThreadIdSchema.nullable(),
  severity: operatorSeveritySchema,
  text: operatorMessageTextSchema,
  createdAtMs: z.number().int().nonnegative(),
  readAtMs: z.number().int().nonnegative().nullable(),
  senderTitle: z.string().nullable(),
  repliedAtMs: z.number().int().nonnegative().nullable(),
  replyText: operatorMessageTextSchema.nullable(),
  replyDeliveryError: z.string().nullable(),
  replyInProgress: z.boolean(),
  notificationStatus: z.enum(["not-requested", "deduplicated", "sent", "failed"]),
  notificationError: z.string().nullable(),
}).strict();
// #280: the inbox reader's outcome is a foundation code, not a sentence. The
// codes are the repo's existing vocabulary — `satisfies` is the standing proof
// that this is not a parallel error scheme invented at the app boundary.
const OPERATOR_MESSAGES_OUTCOMES = ["OK", "PROJECT_CONFIG_REQUIRED"] as const satisfies readonly FoundationCode[];
const operatorMessagesResultSchema = z.object({
  outcome: z.enum(OPERATOR_MESSAGES_OUTCOMES),
  message: z.string().optional(),
  messages: z.array(operatorMessageSchema),
}).strict();
const sendOperatorMessageInputSchema = z.object({
  project_id: projectIdSchema,
  recipient: operatorRecipientSchema,
  severity: operatorSeveritySchema,
  text: operatorMessageTextSchema,
}).strict();
const dispatchLaneInputSchema = z.object({
  request: applyRequestSchema,
  spawn: z.record(z.string(), z.unknown()),
}).strict();

export const rpcContract = defineRpcContract({
  lanes: {
    input: z.object({}).strict(),
    output: laneListSchema,
  },
  registerWait: {
    input: registeredWaitInputSchema,
    output: registeredWaitSchema,
  },
  threadStates: {
    input: z.object({ threadIds: z.array(sidebarThreadIdSchema).max(256) }).strict(),
    output: z.record(z.string(), sidebarThreadStateSchema),
  },
  threadModels: {
    input: z.object({ threadIds: z.array(sidebarThreadIdSchema).max(256) }).strict(),
    output: z.record(z.string(), sidebarThreadExecutionSchema.nullable()),
  },
  setThreadState: {
    input: z.object({ threadId: sidebarThreadIdSchema, state: sidebarThreadStateSchema.nullable() }).strict(),
    output: z.object({ state: sidebarThreadStateSchema.nullable() }).strict(),
  },
  sidebarCollapseState: {
    input: z.object({
      projectIds: z.array(sidebarThreadIdSchema).max(256),
      threadIds: z.array(sidebarThreadIdSchema).max(256),
    }).strict(),
    output: z.object({
      projects: z.record(z.string(), z.boolean()),
      threads: z.record(z.string(), z.boolean()),
    }).strict(),
  },
  setSidebarCollapse: {
    input: z.object({ kind: sidebarCollapseKindSchema, id: sidebarThreadIdSchema, collapsed: z.boolean() }).strict(),
    output: z.object({ kind: sidebarCollapseKindSchema, id: sidebarThreadIdSchema, collapsed: z.boolean() }).strict(),
  },
  reorderPinned: {
    input: z.object({
      threadId: sidebarThreadIdSchema,
      previousThreadId: sidebarThreadIdSchema.nullable(),
      nextThreadId: sidebarThreadIdSchema.nullable(),
    }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  doctor: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: foundationResultSchema,
  },
  export: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: foundationResultSchema,
  },
  apply: {
    input: applyRequestSchema,
    output: foundationResultSchema,
  },
  dispatchLane: {
    input: dispatchLaneInputSchema,
    output: foundationResultSchema,
  },
  cachedConsumerRollout: {
    input: applyRequestSchema,
    output: foundationResultSchema,
  },
  roleBrief: {
    input: z.object({ projectId: projectIdSchema, role: roleBriefRoleSchema }).strict(),
    output: roleBriefSchema,
  },
  operatorMessages: {
    input: z.object({
      projectId: projectIdSchema,
      recipient: operatorRecipientSchema.optional(),
      withSenderTitles: z.boolean().optional(),
    }).strict(),
    output: operatorMessagesResultSchema,
  },
  markOperatorMessageRead: {
    input: z.object({ projectId: projectIdSchema, messageId: z.number().int().positive() }).strict(),
    output: operatorMessageSchema,
  },
  replyToOperatorMessage: {
    input: z.object({ projectId: projectIdSchema, messageId: z.number().int().positive(), text: operatorMessageTextSchema }).strict(),
    output: operatorMessageSchema,
  },
});

function jsonResult(result: FoundationResult): string {
  return JSON.stringify(result);
}

function cliResult(result: FoundationResult) {
  return {
    exitCode: result.outcome === "OK" ? 0 : 2,
    stdout: jsonResult(result),
  };
}

function invalidCli(message: string, outcome: FoundationCode = "INVALID_INPUT") {
  return cliResult({
    outcome,
    subject: "cli",
    expected: 1,
    attempted: 0,
    verified: 0,
    message,
  });
}

export function cliSchemaError(error: z.ZodError, flags: Readonly<Record<string, string>>): string {
  return JSON.stringify(error.issues.map((issue) => {
    const [field, ...rest] = issue.path;
    return typeof field === "string" && Object.hasOwn(flags, field)
      ? { ...issue, path: [flags[field], ...rest] }
      : issue;
  }), (_, value) => typeof value === "bigint" ? value.toString() : value, 2);
}

function workItemRegistrationDoctorResult(db: SqliteDatabase, projectId: string, doctorResult: FoundationResult): FoundationResult {
  const actor = db.prepare(
    `SELECT receipt_id FROM actor_receipts
     WHERE project_id = ? AND actor_kind = 'plugin' AND subject_id = ?
       AND role_id IS NULL AND verification_state = 'verified'
     ORDER BY issued_at_ms DESC LIMIT 1`,
  ).get(projectId, PLUGIN_ID) as { receipt_id: string } | undefined;
  if (!actor) return { outcome: "ACTOR_RECEIPT_UNKNOWN", subject: projectId, expected: 1, attempted: 1, verified: 0, message: "no current verified plugin actor receipt is available" };

  const config = db.prepare("SELECT config_revision FROM project_config_heads WHERE project_id = ?").get(projectId) as { config_revision: number } | undefined;
  const governor = db.prepare("SELECT governance_epoch, fence_token FROM project_governorship_heads WHERE project_id = ?").get(projectId) as { governance_epoch: number; fence_token: string } | undefined;
  const targets = config ? db.prepare(
    "SELECT repo_target_id FROM repository_targets WHERE project_id = ? AND config_revision = ? ORDER BY repo_target_id",
  ).all(projectId, config.config_revision) as Array<{ repo_target_id: string }> : [];
  if (!config) return { outcome: "PROJECT_CONFIG_REQUIRED", subject: projectId, expected: 1, attempted: 1, verified: 0, message: "project has no stored config revision" };
  if (!governor) return { outcome: "GOVERNOR_UNAVAILABLE", subject: projectId, expected: 1, attempted: 1, verified: 0, message: "project governorship head is unavailable" };
  if (targets.length === 0) return { outcome: "REPO_TARGET_REQUIRED", subject: projectId, expected: 1, attempted: 1, verified: 0, message: "stored config has no exact repository target" };

  return {
    ...doctorResult,
    evidence: {
      workItemRegistrations: targets.map((target) => ({
        projectId,
        operationClass: "work_item_create",
        actorReceiptId: actor.receipt_id,
        expectedConfigRevision: config.config_revision,
        expectedGovernanceEpoch: governor.governance_epoch,
        expectedFenceToken: governor.fence_token,
        repoTargetId: target.repo_target_id,
        expectedResourceRevision: null,
      })),
    },
  };
}

function parseFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (args.indexOf(name, index + 1) >= 0 || !args[index + 1] || args[index + 1].startsWith("--")) return "";
  return args[index + 1];
}

function unexpectedFlags(args: string[], allowed: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) return arg;
    if (!allowed.includes(arg)) return arg;
    index += 1;
    if (!args[index] || args[index].startsWith("--")) return arg;
  }
  return null;
}

function isRoleMutation(request: ApplyRequest): boolean {
  return request.operationClass === "qualification_observation_record" || request.operationClass === "role_generation_succession";
}

function unavailableRoleFactReader(serverId: string): RoleFactReader {
  const unavailable = () => { throw new Error("live role facts are unavailable"); };
  return {
    serverId: () => serverId,
    thread: unavailable,
    event: unavailable,
    eventsAfter: unavailable,
    environment: unavailable,
    project: unavailable,
    host: unavailable,
    version: unavailable,
  };
}

export async function readLiveRoleFactReader(
  sdk: BbPluginApi["sdk"],
  serverId: string,
  request: ApplyRequest,
): Promise<RoleFactReader | null> {
  if (!isRoleMutation(request) || !request.roleContext) return null;
  try {
    const exactEvent = async (eventId: string, eventSeq: number) => {
      const events = await sdk.threads.events.list({ threadId: request.roleContext!.threadId, afterSeq: String(eventSeq - 1), limit: "1" });
      if (events.length !== 1) throw new Error("exact role event is unavailable");
      const event = events[0]!;
      if (event.id !== eventId || event.seq !== eventSeq) throw new Error("exact role event identity does not match");
      return { id: event.id, seq: event.seq, type: event.type, data: event.data as Record<string, unknown> };
    };
    const [thread, requestEvent, completionEvent] = await Promise.all([
      sdk.threads.get({ threadId: request.roleContext.threadId }),
      exactEvent(request.roleContext.requestEventId, request.roleContext.requestEventSeq),
      exactEvent(request.roleContext.completionEventId, request.roleContext.completionEventSeq),
    ]);
    const environment = thread.environmentId ? await sdk.environments.get({ environmentId: thread.environmentId }) : null;
    const [project, version, host] = await Promise.all([
      sdk.projects.get({ projectId: request.projectId }),
      sdk.system.version(),
      environment ? sdk.hosts.get({ hostId: environment.hostId }) : Promise.resolve(null),
    ]);
    if (!environment || !host) return unavailableRoleFactReader(serverId);
    const facts = {
      thread: {
        id: thread.id,
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: thread.providerId,
        title: thread.title,
        titleFallback: thread.titleFallback,
        status: thread.status,
        visibility: thread.visibility,
      },
      requestEvent,
      completionEvent,
      environment: {
        id: environment.id,
        projectId: environment.projectId,
        hostId: environment.hostId,
        path: environment.path,
        managed: environment.managed,
        isGitRepo: environment.isGitRepo,
        isWorktree: environment.isWorktree,
        workspaceProvisionType: environment.workspaceProvisionType,
        branchName: environment.branchName,
        baseBranch: environment.baseBranch,
        defaultBranch: environment.defaultBranch,
        mergeBaseBranch: environment.mergeBaseBranch,
        status: environment.status,
      },
      project: {
        id: project.id,
        kind: project.kind,
        name: project.name,
        gitRemoteUrl: project.gitRemoteUrl,
        sources: project.sources.map((source) => ({ id: source.id, projectId: source.projectId, hostId: source.hostId, path: source.path })),
      },
      host: { id: host.id, status: host.status, maxPermissionMode: host.maxPermissionMode },
      version: version.currentVersion,
    };
    const correlationPages = new Map<number, Array<{ id: string; seq: number; type: string; data: Record<string, unknown> }>>();
    if (!roleContextPreflightRefusal({
      thread: facts.thread,
      requestEvent: facts.requestEvent,
      completion: facts.completionEvent,
      environment: facts.environment,
      project: facts.project,
      host: facts.host,
      bbVersion: facts.version,
      bbServerId: serverId,
    }, request)) {
      let afterSeq = request.roleContext.requestEventSeq;
      while (true) {
        const page = (await sdk.threads.events.list({
          threadId: request.roleContext.threadId,
          afterSeq: String(afterSeq),
          limit: String(ROLE_CONTEXT_EVENT_PAGE_SIZE),
        })).map((event) => ({ id: event.id, seq: event.seq, type: event.type, data: event.data as Record<string, unknown> }));
        correlationPages.set(afterSeq, page);
        if (
          page.some((event) => event.id === request.roleContext!.completionEventId && event.seq === request.roleContext!.completionEventSeq) ||
          page.some((event) => event.seq >= request.roleContext!.completionEventSeq) ||
          page.length < ROLE_CONTEXT_EVENT_PAGE_SIZE
        ) break;
        const nextAfterSeq = page.at(-1)!.seq;
        if (nextAfterSeq <= afterSeq) break;
        afterSeq = nextAfterSeq;
      }
    }
    return {
      serverId: () => serverId,
      thread: (threadId) => threadId === facts.thread.id ? structuredClone(facts.thread) : unavailableRoleFactReader(serverId).thread(threadId),
      event: (threadId, eventId, eventSeq) => {
        if (threadId !== facts.thread.id) return unavailableRoleFactReader(serverId).event(threadId, eventId, eventSeq);
        if (eventId === request.roleContext!.requestEventId && eventSeq === request.roleContext!.requestEventSeq) return structuredClone(facts.requestEvent);
        if (eventId === request.roleContext!.completionEventId && eventSeq === request.roleContext!.completionEventSeq) return structuredClone(facts.completionEvent);
        return unavailableRoleFactReader(serverId).event(threadId, eventId, eventSeq);
      },
      eventsAfter: (threadId, afterSeq, limit) => threadId === facts.thread.id && limit === ROLE_CONTEXT_EVENT_PAGE_SIZE && correlationPages.has(afterSeq)
        ? structuredClone(correlationPages.get(afterSeq)!)
        : unavailableRoleFactReader(serverId).eventsAfter(threadId, afterSeq, limit),
      environment: (environmentId) => environmentId === facts.environment.id ? structuredClone(facts.environment) : unavailableRoleFactReader(serverId).environment(environmentId),
      project: (projectId) => projectId === facts.project.id ? structuredClone(facts.project) : unavailableRoleFactReader(serverId).project(projectId),
      host: (hostId) => hostId === facts.host.id ? structuredClone(facts.host) : unavailableRoleFactReader(serverId).host(hostId),
      version: () => facts.version,
    };
  } catch {
    return unavailableRoleFactReader(serverId);
  }
}

async function dispatchLane(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  input: unknown,
): Promise<FoundationResult> {
  const parsed = dispatchLaneInputSchema.safeParse(input);
  if (!parsed.success) return { outcome: "INVALID_INPUT", subject: "dispatch", expected: 1, attempted: 0, verified: 0, message: parsed.error.message };
  const { request, spawn } = parsed.data;
  if (!request.workAttempt || (request.lifecycleState !== "in_progress" && request.lifecycleState !== undefined)) {
    return { outcome: "INVALID_INPUT", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "lane dispatch requires a writing work attempt and an in-progress transition" };
  }
  if (spawn.projectId !== request.projectId) {
    return { outcome: "INVALID_INPUT", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "spawn projectId must match request projectId" };
  }
  const dispatchParentThreadId = typeof spawn.parentThreadId === "string" ? spawn.parentThreadId : null;
  if (!dispatchParentThreadId) {
    return { outcome: "INVALID_INPUT", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "lane dispatch requires the dispatcher parent thread" };
  }
  const { threadId: _threadId, ...intentAttempt } = request.workAttempt;
  const intent = await applyLiveAuthorizedMutation(bb, db, {
    ...request,
    reasonCode: `dispatch_parent:${dispatchParentThreadId}`,
    workAttempt: intentAttempt,
  });
  if (intent.outcome !== "OK" || intent.replay) return intent;

  let thread: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["spawn"]>>;
  try {
    thread = await bb.sdk.threads.spawn({
      ...spawn,
      title: `${String(spawn.title ?? "lane")} [dispatch:${request.idempotencyKey}]`,
    } as unknown as Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]);
  } catch (error) {
    return { outcome: "EXTERNAL_UNAVAILABLE", subject: request.projectId, expected: 1, attempted: 1, verified: 0, message: `lane spawn failed after durable dispatch intent: ${String(error)}`, evidence: { intent } };
  }

  const intentEvidence = intent as { currentResourceRevision?: number };
  return applyLiveAuthorizedMutation(bb, db, {
    ...request,
    lifecycleState: undefined,
    expectedResourceRevision: intentEvidence?.currentResourceRevision,
    idempotencyKey: `${request.idempotencyKey}-finalize`,
    workAttempt: { ...request.workAttempt, threadId: thread.id },
  });
}

async function requireStoppedWorkItemLane(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  request: z.infer<typeof applyRequestSchema>,
): Promise<FoundationResult | null> {
  if (request.operationClass !== "work_item_transition" || request.lifecycleState !== "review_pending" || request.workAttempt !== undefined || !db) return null;
  const attempt = db.prepare(
    `SELECT thread_id FROM execution_attempts
     WHERE project_id = ? AND work_item_id = ? AND origin = 'work_item'
       AND assignment_kind = 'write' AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown')
     ORDER BY attempt_ordinal DESC LIMIT 1`,
  ).get(request.projectId, request.workItemId) as { thread_id: string | null } | undefined;
  if (!attempt?.thread_id) {
    return { outcome: "WORK_ITEM_STATE_INVALID", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "review-pending requires a bound lane with native stop evidence" };
  }
  let lane: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
  try {
    lane = await bb.sdk.threads.get({ threadId: attempt.thread_id });
  } catch (error) {
    return { outcome: "EXTERNAL_UNAVAILABLE", subject: request.projectId, expected: 1, attempted: 1, verified: 0, message: `lane stop evidence unavailable: ${String(error)}` };
  }
  if (lane.status !== "idle") {
    return { outcome: "WORK_ITEM_STATE_INVALID", subject: request.projectId, expected: 1, attempted: 1, verified: 0, message: `lane has no native stopped evidence: status=${lane.status}` };
  }
  return null;
}

async function applyLiveAuthorizedMutation(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  input: unknown,
  allowCachedConsumerRollout = false,
): Promise<FoundationResult> {
  const parsed = applyRequestSchema.safeParse(input);
  if (parsed.success) {
    const laneGuard = await requireStoppedWorkItemLane(bb, db, parsed.data);
    if (laneGuard) return laneGuard;
  }
  if (!allowCachedConsumerRollout && parsed.success && parsed.data.decisionEvidence?.some((evidence) => evidence.evidenceId === "cached-consumer-v22-rollout-receipt")) {
    return cachedConsumerRolloutRefusal(parsed.data.projectId, "cached-consumer rollout evidence is accepted only through the live rollout caller");
  }
  if (parsed.success && parsed.data.workItemWait !== undefined && parsed.data.workItemWait !== null
    && (parsed.data.workItemWait.kind === "schedule" || parsed.data.workItemWait.kind === "seat")) {
    try {
      if (!await liveWorkItemWaker(bb, db, parsed.data.projectId, parsed.data.workItemWait)) {
        const waker = parsed.data.workItemWait.kind === "schedule" ? `schedule ${parsed.data.workItemWait.schedule}` : `seat ${parsed.data.workItemWait.seat}`;
        return { outcome: "INVALID_INPUT", subject: parsed.data.projectId, expected: 1, attempted: 0, verified: 0, message: `waker ${waker} is not live: declaration refused` };
      }
    } catch {
      return { outcome: "INVALID_INPUT", subject: parsed.data.projectId, expected: 1, attempted: 0, verified: 0, message: `waker ${parsed.data.workItemWait.kind} registry is unreadable: declaration refused` };
    }
  }
  const reader = parsed.success ? await readLiveRoleFactReader(bb.sdk, bb.server.loopbackBaseUrl, parsed.data) : null;
  const result = applyAuthorizedMutation(db, input, null, reader, null, null, readGithubIssueForBackfill);
  await deliverSucceededSeatBrief(bb, db, input, result);
  return result;
}

async function liveWorkItemWaker(bb: BbPluginApi, db: SqliteDatabase | null, projectId: string, waker: WorkItemWait): Promise<boolean> {
  if (waker.kind === "seat") {
    return db !== null && readRoleHolderStates(db).filter((holder) => holder.project_id === projectId && holder.role_id === waker.seat).length === 1;
  }
  if (waker.kind !== "schedule") return false;
  return liveWaker(bb, waker.schedule);
}

async function liveWaker(bb: BbPluginApi, schedule: string): Promise<boolean> {
  const plugins = await bb.sdk.plugins.list();
  return plugins.plugins.some((plugin) => plugin.id === bb.pluginId && plugin.status === "running" && plugin.schedules.some((candidate) => candidate.name === schedule));
}

function cachedConsumerRolloutRefusal(projectId: string, message: string): FoundationResult {
  return { outcome: "INVALID_INPUT", subject: projectId, expected: 1, attempted: 0, verified: 0, message };
}

type PluginSource = Awaited<ReturnType<BbPluginApi["sdk"]["plugins"]["getSource"]>>;

function resolvedPluginRoot(source: PluginSource): string | null {
  if (!source.resolved.startsWith("path:")) return null;
  const root = source.resolved.slice("path:".length);
  return root.length > 0 ? root : null;
}

export async function isLiveCachedConsumerRolloutArtifact(moduleUrl: string, bb: BbPluginApi): Promise<boolean> {
  try {
    const artifactPath = fileURLToPath(new URL(moduleUrl));
    const pluginRoot = resolvedPluginRoot(await bb.sdk.plugins.getSource({ pluginId: bb.pluginId }));
    if (!pluginRoot || !isAbsolute(pluginRoot)) return false;
    const relativeArtifactPath = relative(pluginRoot, artifactPath);
    if (
      relativeArtifactPath.length === 0
      || relativeArtifactPath === ".."
      || relativeArtifactPath.startsWith(`..${sep}`)
      || isAbsolute(relativeArtifactPath)
    ) return false;
    return basename(artifactPath) === "server.js" && basename(dirname(artifactPath)) === "dist";
  } catch {
    return false;
  }
}

function roleBriefBundlePath(): string {
  const bundled = fileURLToPath(new URL("./role-briefs.json", import.meta.url));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL("./dist/role-briefs.json", import.meta.url));
}

function roleForThread(db: SqliteDatabase | null, projectId: string, threadId: string): z.infer<typeof roleBriefRoleSchema> {
  const roleId = db ? readRoleHolderStates(db).find((holder) => holder.project_id === projectId && holder.thread_id === threadId)?.role_id : null;
  return roleId === "director" ? "director" : roleId === "project-orchestrator" ? "orchestrator" : "worker";
}

function roleBriefRole(roleId: string): z.infer<typeof roleBriefRoleSchema> {
  return roleId === "director" ? "director" : roleId === "project-orchestrator" ? "orchestrator" : "worker";
}

async function composeRoleBrief(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  input: z.infer<typeof rpcContract["roleBrief"]["input"]>,
): Promise<z.infer<typeof roleBriefSchema>> {
  const bundle = roleBriefBundleSchema.parse(JSON.parse(readFileSync(roleBriefBundlePath(), "utf8")));
  const project = await bb.sdk.projects.get({ projectId: input.projectId });
  const currentSeats = (db ? readRoleHolderStates(db) : [])
    .filter((holder) => holder.project_id === input.projectId)
    .map((holder) => ({ roleId: holder.role_id, generation: holder.role_generation, threadId: holder.thread_id }));
  const pointers = {
    canonicalStoreQuery: "role_generation_heads joined to role_generations",
    handoffFile: "handoff.md in the predecessor seat’s thread storage: resolve the predecessor thread id from role_generation_heads joined to role_generations, then read handoff.md under that thread’s storage directory (~/.bb/thread-storage/<threadId>/)",
    currentSeats,
  };
  const prompt = [
    `# bb-collab ${input.role} brief`,
    "",
    "## Ponytail preamble",
    bundle.ponytail,
    "",
    "## Role brief",
    bundle.roles[input.role],
    "",
    "## Working rules",
    bundle.rules,
    "",
    "## Live pointers",
    `Project: ${project.name} (${project.id})`,
    `Sources: ${project.sources.map((source) => source.id).join(", ") || "none"}`,
    `Canonical store query: ${pointers.canonicalStoreQuery}`,
    `Handoff file: ${pointers.handoffFile}`,
    `Current seats: ${currentSeats.map((seat) => `${seat.roleId}@${seat.generation}:${seat.threadId}`).join(", ") || "none"}`,
  ].join("\n");
  return { role: input.role, roleContent: bundle.roles[input.role], ponytail: bundle.ponytail, rules: bundle.rules, project: { id: project.id, name: project.name, sourceIds: project.sources.map((source) => source.id) }, pointers, prompt };
}

async function sendRoleBrief(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  projectId: string,
  threadId: string,
  role: z.infer<typeof roleBriefRoleSchema>,
): Promise<void> {
  const brief = await composeRoleBrief(bb, db, { projectId, role });
  // created is observe-only and can race the first turn; queue instead of waiting for idle.
  await sendWhenThreadReady(bb, {
    threadId,
    mode: "queue-if-active",
    input: [{ type: "text", visibility: "agent-only", text: brief.prompt, mentions: [] }],
  });
}

async function enqueueAutomatedTell(
  bb: BbPluginApi,
  request: Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0],
  waitForIdle: boolean,
): Promise<void> {
  // ponytail: this process-local queue covers this plugin’s senders; a host atomic send-if-idle API is the cross-process upgrade.
  const previous = automatedTellQueues.get(request.threadId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    if (waitForIdle) await bb.sdk.threads.wait({ threadId: request.threadId, status: "idle", timeoutMs: AUTOMATED_TELL_IDLE_WAIT_MS });
    await bb.sdk.threads.send(request);
  });
  automatedTellQueues.set(request.threadId, current);
  try {
    await current;
  } finally {
    if (automatedTellQueues.get(request.threadId) === current) automatedTellQueues.delete(request.threadId);
  }
}

async function sendWhenThreadReady(bb: BbPluginApi, request: Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0]): Promise<void> {
  await enqueueAutomatedTell(bb, request, false);
}

async function sendWhenThreadIdle(bb: BbPluginApi, request: Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0]): Promise<void> {
  await enqueueAutomatedTell(bb, request, true);
}

async function deliverSucceededSeatBrief(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  input: unknown,
  result: FoundationResult,
): Promise<void> {
  const request = applyRequestSchema.safeParse(input);
  if (!request.success || result.outcome !== "OK" || request.data.operationClass !== "role_generation_succession" || !request.data.roleContext || !request.data.roleId) return;
  try {
    await sendRoleBrief(bb, db, request.data.projectId, request.data.roleContext.threadId, roleBriefRole(request.data.roleId));
  } catch (error) {
    bb.log.error(`role brief seating failed for thread=${request.data.roleContext.threadId}: ${String(error)}`);
  }
}

function liveCachedConsumerReread(name: string, result: FoundationResult) {
  const cachedConsumers = (result.evidence as { cachedConsumers?: { newSchemaVersion?: unknown; newContractVersion?: unknown } } | undefined)?.cachedConsumers;
  if (result.outcome !== "OK" || typeof cachedConsumers?.newSchemaVersion !== "number" || typeof cachedConsumers.newContractVersion !== "number") {
    throw new Error(`${name} did not return cached-consumer evidence from the live project`);
  }
  return { observedSchemaVersion: cachedConsumers.newSchemaVersion, observedContractVersion: cachedConsumers.newContractVersion };
}

async function applyLiveCachedConsumerRollout(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  input: unknown,
  cliDeps: WaitValidatorCliDeps,
  cliContext?: PluginCliContext,
): Promise<FoundationResult> {
  const parsed = applyRequestSchema.safeParse(input);
  if (!parsed.success) return cachedConsumerRolloutRefusal("cached-consumer-rollout", parsed.error.message);
  const request = parseApplyRequest(parsed.data);
  if (request.operationClass !== "decision_disposition") {
    return cachedConsumerRolloutRefusal(request.projectId, "cached-consumer rollout requires a governed decision_disposition request");
  }
  if (!(await isLiveCachedConsumerRolloutArtifact(import.meta.url, bb))) {
    return cachedConsumerRolloutRefusal(request.projectId, "cached-consumer rollout requires the running dist/server.js plugin artifact");
  }
  if (!db) return { outcome: "CANONICAL_STORE_UNAVAILABLE", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "canonical SQLite store is unavailable" };
  try {
    const project = await bb.sdk.projects.get({ projectId: request.projectId });
    if (project.id !== request.projectId) return { outcome: "PROJECT_UNKNOWN", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "live project identity does not match the rollout request" };
    const evidence = await assembleV22CachedConsumerRolloutEvidence({
      rpcContract: async () => liveCachedConsumerReread("server.rpcContract", await bb.sdk.plugins.callRpc({
        pluginId: bb.pluginId,
        method: "doctor",
        input: { projectId: request.projectId },
        outputSchema: rpcContract.doctor.output,
      }) as FoundationResult),
      collabCli: async () => liveCachedConsumerReread("server.collabCli", foundationResultSchema.parse(JSON.parse(
        (await runCli(db, bb, ["doctor", "--project", request.projectId], cliContext, cliDeps)).stdout,
      )) as FoundationResult),
      consumedLegacyReplay: async () => probeV21ConsumedLegacyReplay(db, request.projectId),
      newLegacyApplyProvenance: async () => probeV21NewLegacyApplyProvenanceRefusal(),
    });
    const supplied = (request.decisionEvidence ?? []).filter((item) => item.evidenceId === evidence.evidenceId);
    if (supplied.length !== 1 || canonicalJson(supplied[0]) !== canonicalJson(evidence)) {
      return cachedConsumerRolloutRefusal(request.projectId, "cached-consumer rollout request must carry the exact live production evidence");
    }
    return applyLiveAuthorizedMutation(bb, db, request, true);
  } catch (error) {
    return cachedConsumerRolloutRefusal(request.projectId, error instanceof Error ? error.message : String(error));
  }
}

interface WaitValidatorCliDeps {
  watcher: import("./src/awareness.js").LaneWatcher;
  registerBoundedWaitForCli: (input: unknown, ctxThreadId?: string) => Promise<import("./src/registered-waits.js").RegisterWaitResult>;
  listWaitsForCli: () => Promise<Array<Record<string, unknown>>>;
  escalationCycle: import("./src/registered-waits.js").WaitEscalationCycle;
  stallGuardCycle: (projectId?: string) => Promise<import("./src/stall-guard.js").StallGuardCycleSummary>;
  fleetWatchdogCycle: (projectId?: string) => Promise<void>;
  resetFleetWatchdog: (projectId: string, invokedBy: string) => Promise<void>;
  archiveSweep: (projectId: string, apply: boolean) => Promise<import("./src/archive-sweep.js").ArchiveSweepResult>;
  readCheckoutDivergence: () => CheckoutDivergence;
  notifyUrgent: (message: string, senderThreadId: string) => Promise<void>;
}

export const URGENT_NOTIFICATION_DEDUP_MS = 60 * 60_000;
const OPERATOR_MESSAGE_LIMIT = 256;
const REPLY_DELIVERY_TIMEOUT_MS = 10_000;

type OperatorMessageRow = {
  message_id: number;
  project_id: string;
  recipient: z.infer<typeof operatorRecipientSchema>;
  sender_thread_id: string;
  sender_lane_id: string | null;
  severity: z.infer<typeof operatorSeveritySchema>;
  message_text: string;
  created_at_ms: number;
  read_at_ms: number | null;
  replied_at_ms: number | null;
  reply_text: string | null;
  reply_delivery_error: string | null;
  notification_attempted_at_ms: number | null;
  notification_error: string | null;
};

function operatorMessage(row: OperatorMessageRow) {
  return {
    messageId: row.message_id,
    projectId: row.project_id,
    recipient: row.recipient,
    senderThreadId: row.sender_thread_id,
    senderLaneId: row.sender_lane_id,
    severity: row.severity,
    text: row.message_text,
    createdAtMs: row.created_at_ms,
    readAtMs: row.read_at_ms,
    senderTitle: null,
    repliedAtMs: row.replied_at_ms,
    replyText: row.reply_text,
    replyDeliveryError: row.reply_delivery_error,
    replyInProgress: false,
    notificationStatus: row.severity !== "urgent"
      ? "not-requested" as const
      : row.notification_attempted_at_ms === null
        ? "deduplicated" as const
        : row.notification_error === null ? "sent" as const : "failed" as const,
    notificationError: row.notification_error,
  };
}

function operatorMessagesCliResult(
  projectId: string,
  messages: z.infer<typeof operatorMessageSchema>[],
  message: string,
) {
  const count = messages.length;
  return cliResult({
    outcome: "OK",
    subject: projectId,
    expected: count,
    attempted: count,
    verified: count,
    message,
    evidence: { messages },
  });
}

const operatorMessageSelect = `SELECT message.*,
  (SELECT attempt.lane_id FROM execution_attempts AS attempt
   WHERE attempt.project_id = message.project_id
     AND attempt.thread_id = message.sender_thread_id
     AND attempt.lane_id IS NOT NULL
   ORDER BY attempt.created_at_ms DESC LIMIT 1) AS sender_lane_id
  FROM operator_messages AS message`;

const UNREGISTERED_INBOX_MESSAGE = "operator inbox project is not registered";

function inboxProjectIsRegistered(db: SqliteDatabase, projectId: string): boolean {
  return db.prepare("SELECT 1 FROM project_config_heads WHERE project_id = ?").get(projectId) !== undefined;
}

function requireInboxStore(db: SqliteDatabase | null): SqliteDatabase {
  if (!db) throw refusal("CANONICAL_STORE_UNAVAILABLE", "operator inbox store is unavailable");
  return db;
}

function requireRegisteredInboxProject(db: SqliteDatabase | null, projectId: string) {
  const store = requireInboxStore(db);
  if (!inboxProjectIsRegistered(store, projectId)) throw refusal("PROJECT_CONFIG_REQUIRED", UNREGISTERED_INBOX_MESSAGE);
  return store;
}

function readOperatorMessage(db: SqliteDatabase | null, projectId: string, messageId: number) {
  const store = requireRegisteredInboxProject(db, projectId);
  const row = store.prepare(`${operatorMessageSelect} WHERE message.project_id = ? AND message.message_id = ?`)
    .get(projectId, messageId) as OperatorMessageRow | undefined;
  if (!row) throw refusal("RESOURCE_UNKNOWN", "operator message does not exist in the requested project");
  return operatorMessage(row);
}

async function resolveSenderTitles(bb: BbPluginApi, messages: ReturnType<typeof operatorMessage>[]) {
  const senderProjects = new Map(messages.map((message) => [message.senderThreadId, message.projectId]));
  const titles = new Map(await Promise.all([...senderProjects].map(async ([senderThreadId, projectId]) => {
    try {
      const thread = await bb.sdk.threads.get({ threadId: senderThreadId });
      const title = thread.id === senderThreadId && thread.projectId === projectId ? thread.title?.trim() : null;
      return [senderThreadId, title || null] as const;
    } catch {
      return [senderThreadId, null] as const;
    }
  })));
  return messages.map((message) => ({ ...message, senderTitle: titles.get(message.senderThreadId) ?? null }));
}

async function listOperatorMessages(
  db: SqliteDatabase | null,
  bb: BbPluginApi,
  projectId: string,
  recipient?: z.infer<typeof operatorRecipientSchema>,
  withSenderTitles = false,
): Promise<z.infer<typeof operatorMessagesResultSchema>> {
  const store = requireInboxStore(db);
  // The unregistered-inbox condition is an answer, not a rejection: the app's
  // aggregate fan-out reads every BB project while inbox registration lives in
  // `project_config_heads`, so it must tell that benign condition from a failed
  // read. It travels as a code in the result because the SDK reduces every
  // thrown handler error to `{ code: "handler_error", message }` — a code on
  // the error would not survive the boundary, and the message is prose (#280).
  if (!inboxProjectIsRegistered(store, projectId)) {
    return { outcome: "PROJECT_CONFIG_REQUIRED", message: UNREGISTERED_INBOX_MESSAGE, messages: [] };
  }
  const recipientClause = recipient === undefined ? "" : " AND message.recipient = ?";
  const rows = store.prepare(`${operatorMessageSelect}
    WHERE message.project_id = ?${recipientClause}
    ORDER BY (message.read_at_ms IS NULL) DESC, message.created_at_ms DESC, message.message_id DESC
    LIMIT ${OPERATOR_MESSAGE_LIMIT}`).all(...(recipient === undefined ? [projectId] : [projectId, recipient])) as OperatorMessageRow[];
  const messages = rows.map(operatorMessage);
  return { outcome: "OK", messages: withSenderTitles ? await resolveSenderTitles(bb, messages) : messages };
}

async function markOperatorMessageRead(db: SqliteDatabase | null, bb: BbPluginApi, projectId: string, messageId: number) {
  const store = requireRegisteredInboxProject(db, projectId);
  const result = store.prepare(`UPDATE operator_messages SET read_at_ms = COALESCE(read_at_ms, ?)
    WHERE project_id = ? AND message_id = ?`).run(Date.now(), projectId, messageId);
  if (result.changes !== 1) throw refusal("RESOURCE_UNKNOWN", "operator message does not exist in the requested project");
  return (await resolveSenderTitles(bb, [readOperatorMessage(store, projectId, messageId)]))[0]!;
}

async function assertSenderProject(bb: BbPluginApi, projectId: string, senderThreadId: string) {
  const thread = await bb.sdk.threads.get({ threadId: senderThreadId });
  if (thread.id !== senderThreadId || thread.projectId !== projectId) {
    throw refusal("EXECUTION_CONTEXT_FOREIGN", "project_id must exactly match the sender thread project");
  }
}

export function deployedDistFailureDetail(error: ExecFileException, stdout: string, stderr: string): string {
  const status = `code=${String(error.code ?? "null")} killed=${String(error.killed ?? false)} signal=${String(error.signal ?? "null")}`;
  return [error.message, status, stderr.trim(), stdout.trim()].filter(Boolean).join(" ");
}

function runBbCommand(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(process.env.BB_CLI?.trim() || "bb", args, { timeout: 10_000 }, (error) => error ? reject(error) : resolve());
  });
}

async function defaultNotifyUrgent(message: string, senderThreadId: string, run: (args: string[]) => Promise<void>): Promise<void> {
  const attempts = await Promise.allSettled([
    run(["notify", "send", message, "--title", "Urgent bb-collab inbox message", "--thread", senderThreadId]),
    run(["push", "test", message]),
  ]);
  const failures = attempts.flatMap((attempt, index) => attempt.status === "rejected"
    ? [`${index === 0 ? "desktop" : "phone"}: ${String(attempt.reason)}`]
    : []);
  if (failures.length > 0) throw new Error(failures.join("; "));
}

async function sendOperatorMessage(
  db: SqliteDatabase | null,
  bb: BbPluginApi,
  input: z.infer<typeof sendOperatorMessageInputSchema>,
  senderThreadId: string,
  notifyUrgent: (message: string, senderThreadId: string) => Promise<void>,
) {
  const store = requireRegisteredInboxProject(db, input.project_id);
  await assertSenderProject(bb, input.project_id, senderThreadId);
  const now = Date.now();
  const inserted = store.prepare(`INSERT INTO operator_messages (
      project_id, recipient, sender_thread_id, severity, message_text, created_at_ms, notification_attempted_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, CASE
      WHEN ? = 'urgent' AND NOT EXISTS (
        SELECT 1 FROM operator_messages
        WHERE recipient = ? AND sender_thread_id = ? AND severity = ? AND message_text = ?
          AND notification_attempted_at_ms IS NOT NULL
          AND notification_attempted_at_ms >= ?
      ) THEN ? ELSE NULL END
    ) RETURNING message_id, notification_attempted_at_ms`).get(
      input.project_id, input.recipient, senderThreadId, input.severity, input.text, now,
      input.severity, input.recipient, senderThreadId, input.severity, input.text,
      now - URGENT_NOTIFICATION_DEDUP_MS, now,
    ) as { message_id: number; notification_attempted_at_ms: number | null };
  if (inserted.notification_attempted_at_ms !== null) {
    const notification = `[${input.project_id}] ${input.recipient} message from ${senderThreadId}: ${input.text}`;
    try {
      await notifyUrgent(notification, senderThreadId);
    } catch (error) {
      store.prepare("UPDATE operator_messages SET notification_error = ? WHERE project_id = ? AND message_id = ?")
        .run(String(error).slice(0, 1_000), input.project_id, inserted.message_id);
    }
  }
  return readOperatorMessage(store, input.project_id, inserted.message_id);
}

async function latestThreadEventSeq(bb: BbPluginApi, threadId: string): Promise<number> {
  if ((await bb.sdk.threads.events.list({ threadId, afterSeq: "0", limit: "1" })).length === 0) return 0;
  let low = 0;
  let high = 1;
  while ((await bb.sdk.threads.events.list({ threadId, afterSeq: String(high), limit: "1" })).length > 0) {
    low = high;
    high *= 2;
    if (!Number.isSafeInteger(high)) throw new Error("sender event sequence exceeds the safe delivery-check bound");
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if ((await bb.sdk.threads.events.list({ threadId, afterSeq: String(middle), limit: "1" })).length > 0) low = middle;
    else high = middle;
  }
  return high;
}

async function confirmReplyDelivery(bb: BbPluginApi, threadId: string, afterSeq: number, prefix: string): Promise<void> {
  const deadline = Date.now() + REPLY_DELIVERY_TIMEOUT_MS;
  let cursor = afterSeq;
  while (Date.now() < deadline) {
    const event = await bb.sdk.threads.events.wait({
      threadId,
      afterSeq: String(cursor),
      type: "client/turn/requested",
      waitMs: String(Math.max(1, deadline - Date.now())),
    });
    if (!event) break;
    if (event.type === "client/turn/requested" && event.data.source === "tell" &&
      event.data.input.some((item) => item.type === "text" && item.text.startsWith(prefix))) return;
    cursor = event.seq;
  }
  throw new Error("platform tell was accepted but no matching sender-thread input event was observed");
}

async function replyToOperatorMessage(db: SqliteDatabase | null, bb: BbPluginApi, projectId: string, messageId: number, replyText: string) {
  const store = requireRegisteredInboxProject(db, projectId);
  const message = readOperatorMessage(store, projectId, messageId);
  if (message.repliedAtMs !== null) throw new Error("operator message already has a delivered reply");
  // ponytail: this process-local guard covers every current RPC caller; a host atomic primitive is the cross-process upgrade.
  const claimKey = JSON.stringify([projectId, messageId]);
  if (operatorRepliesInFlight.has(claimKey)) {
    return { ...(await resolveSenderTitles(bb, [message]))[0]!, replyInProgress: true };
  }
  operatorRepliesInFlight.add(claimKey);
  try {
    const thread = await bb.sdk.threads.get({ threadId: message.senderThreadId });
    if (thread.projectId !== projectId || !thread.environmentId) throw new Error("sender thread no longer has a project-exact environment");
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (environment.projectId !== projectId || environment.status !== "ready") throw new Error("sender thread environment is not ready");
    const afterSeq = await latestThreadEventSeq(bb, message.senderThreadId);
    const replyPrefix = `[bb-collab inbox reply ${message.messageId} to ${message.recipient}]\n`;
    const deliveredText = `${replyPrefix}${replyText}`;
    await sendWhenThreadIdle(bb, {
      threadId: message.senderThreadId,
      mode: "steer",
      input: [{ type: "text", text: deliveredText, mentions: [] }],
    });
    await confirmReplyDelivery(bb, message.senderThreadId, afterSeq, replyPrefix);
    const repliedAtMs = Date.now();
    store.prepare(`UPDATE operator_messages
      SET reply_text = ?, replied_at_ms = ?, read_at_ms = COALESCE(read_at_ms, ?), reply_delivery_error = NULL
      WHERE project_id = ? AND message_id = ?`).run(replyText, repliedAtMs, repliedAtMs, projectId, messageId);
  } catch (error) {
    store.prepare(`UPDATE operator_messages
      SET reply_text = ?, replied_at_ms = NULL, read_at_ms = COALESCE(read_at_ms, ?), reply_delivery_error = ?
      WHERE project_id = ? AND message_id = ?`).run(replyText, Date.now(), String(error).slice(0, 1_000), projectId, messageId);
  } finally {
    operatorRepliesInFlight.delete(claimKey);
  }
  return (await resolveSenderTitles(bb, [readOperatorMessage(store, projectId, messageId)]))[0]!;
}

async function reportProjectWorktreeCleanup(bb: BbPluginApi, projectId: string) {
  const project = await bb.sdk.projects.get({ projectId });
  const source = project.sources.find((item) => item.isDefault) ?? project.sources[0];
  if (!source) throw new Error("project has no source checkout");
  const threads = await listAllProjectThreads((request) => bb.sdk.threads.list(request), projectId);
  const protectedEnvironmentPaths = new Set<string>();
  let environmentInventoryComplete = true;
  let pluginSourceResolved = true;
  try {
    const pluginRoot = resolvedPluginRoot(await bb.sdk.plugins.getSource({ pluginId: bb.pluginId }));
    if (pluginRoot) protectedEnvironmentPaths.add(canonicalWorktreePath(pluginRoot));
  } catch {
    // A missing source is handled by doctor; cleanup must refuse rather than guess.
    pluginSourceResolved = false;
    environmentInventoryComplete = false;
  }
  const liveWorktreeThreadIds = new Map<string, Set<string>>();
  // Detached ownership is resolved from the absence of a claim, so an environment we
  // failed to read is not a missing claim -- it is an unknown one, and the whole
  // inventory stops being usable as evidence.
  for (const thread of threads) {
    if (thread.environmentId === null) continue;
    try {
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      if (!environment.path) {
        environmentInventoryComplete = false;
        continue;
      }
      const path = canonicalWorktreePath(environment.path);
      const owners = liveWorktreeThreadIds.get(path) ?? new Set<string>();
      owners.add(thread.id);
      liveWorktreeThreadIds.set(path, owners);
    } catch {
      environmentInventoryComplete = false;
    }
  }
  return cleanupGitWorktrees(source.path, new Set(threads.map((thread) => thread.id)), liveWorktreeThreadIds, environmentInventoryComplete, protectedEnvironmentPaths, pluginSourceResolved);
}

async function runCli(
  db: SqliteDatabase | null,
  bb: BbPluginApi,
  argv: string[],
  ctx: PluginCliContext | undefined,
  deps: WaitValidatorCliDeps,
) {
  const command = argv[0];
  const args = argv.slice(1);
  if (!command || !["doctor", "export", "apply", "dispatch-lane", "github-issue-backfill", "archive-sweep", "worktree-cleanup", "cached-consumer-rollout", "role-list", "wait-register", "wait-list", "wait-validator", "stall-guard", "fleet-watchdog", "send-to-operator", "inbox"].includes(command)) {
    return invalidCli("expected doctor, export, apply, dispatch-lane, github-issue-backfill, archive-sweep, worktree-cleanup, cached-consumer-rollout, role-list, wait-register, wait-list, wait-validator, stall-guard, fleet-watchdog, send-to-operator, or inbox");
  }
  if (command === "wait-validator") {
    const unknown = args.find((arg) => arg !== "--cycle");
    if (unknown) return invalidCli(`unexpected argument ${unknown}`);
    if (!args.includes("--cycle")) return invalidCli("--cycle is required: the validator runs exactly one durable cycle per invocation");
    try {
      // One cycle = the watcher's own wait firing/validation pass plus the
      // bounded escalation pass over fired waits. Both are read-only on
      // canonical state and act only through sanctioned seams.
      await deps.watcher.poll();
      const summary = await deps.escalationCycle.cycle();
      return cliResult({
        outcome: "OK",
        subject: "wait-validator",
        expected: 1,
        attempted: summary.fired + summary.steered,
        verified: summary.fired,
        message: "durable wait validation cycle complete",
        evidence: summary,
      });
    } catch (error) {
      return cliResult({
        outcome: "INTERNAL_ERROR",
        subject: "wait-validator",
        expected: 1,
        attempted: 0,
        verified: 0,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (command === "stall-guard") {
    const projectFlag = args.indexOf("--project");
    const projectId = parseFlag(args, "--project");
    const expectedLength = projectFlag < 0 ? 1 : 3;
    const unknown = args.find((arg) => arg !== "--cycle" && arg !== "--project" && arg !== projectId);
    if (unknown || args.filter((arg) => arg === "--cycle").length !== 1 || args.filter((arg) => arg === "--project").length > 1 || args.length !== expectedLength) {
      return invalidCli(`unexpected argument ${unknown ?? "duplicate or malformed flag"}`);
    }
    if (!args.includes("--cycle")) return invalidCli("--cycle is required: the stall guard runs exactly one durable cycle per invocation");
    if (projectId === "") return invalidCli("--project PROJECT_ID must be supplied once with a value");
    try {
      await deps.watcher.poll();
      const summary = await deps.stallGuardCycle(projectId ?? undefined);
      return cliResult({
        outcome: "OK",
        subject: "stall-guard",
        expected: summary.observed,
        attempted: summary.attempted,
        verified: summary.verified,
        message: "stall-guard cycle complete",
        evidence: summary,
      });
    } catch (error) {
      return cliResult({ outcome: "INTERNAL_ERROR", subject: "stall-guard", expected: 1, attempted: 0, verified: 0, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (command === "fleet-watchdog") {
    const projectFlag = args.indexOf("--project");
    const projectId = parseFlag(args, "--project");
    const expectedLength = projectFlag < 0 ? 1 : 3;
    const reset = args.includes("--reset");
    const unknown = args.find((arg) => arg !== "--cycle" && arg !== "--reset" && arg !== "--project" && arg !== projectId);
    if (unknown || args.filter((arg) => arg === "--cycle").length + args.filter((arg) => arg === "--reset").length !== 1 || args.filter((arg) => arg === "--project").length > 1 || args.length !== expectedLength) {
      return invalidCli(`unexpected argument ${unknown ?? "duplicate or malformed flag"}`);
    }
    if (!projectId) return invalidCli("--project PROJECT_ID must be supplied once with a value");
    try {
      if (reset) {
        await deps.resetFleetWatchdog(projectId, ctx?.threadId ?? "unknown");
        return cliResult({ outcome: "OK", subject: projectId, expected: 1, attempted: 1, verified: 1, message: "fleet-watchdog history reset" });
      }
      await deps.fleetWatchdogCycle(projectId);
      return cliResult({ outcome: "OK", subject: projectId, expected: 1, attempted: 1, verified: 1, message: "fleet-watchdog cycle complete" });
    } catch (error) {
      return cliResult({ outcome: "INTERNAL_ERROR", subject: projectId, expected: 1, attempted: 0, verified: 0, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const projectId = parseFlag(args, "--project");
  if (!projectId) return invalidCli("--project PROJECT_ID is required; CLI context is never used as a fallback");
  if (command === "dispatch-lane") {
    const unknown = unexpectedFlags(args, ["--project", "--request", "--spawn"]);
    if (unknown) return invalidCli(`unexpected flag ${unknown}`);
    const requestJson = parseFlag(args, "--request");
    const spawnJson = parseFlag(args, "--spawn");
    if (!requestJson || !spawnJson) return invalidCli("--request JSON and --spawn JSON are required");
    try {
      const request = JSON.parse(requestJson);
      const spawn = JSON.parse(spawnJson);
      const parsed = dispatchLaneInputSchema.safeParse({ request, spawn });
      if (!parsed.success) return invalidCli(parsed.error.message);
      if (parsed.data.request.projectId !== projectId) return invalidCli("request projectId must match --project");
      return cliResult(await dispatchLane(bb, db, parsed.data));
    } catch (error) {
      return invalidCli(error instanceof Error ? error.message : String(error));
    }
  }
  if (command === "send-to-operator") {
    const unknown = unexpectedFlags(args, ["--project", "--recipient", "--severity", "--message"]);
    if (unknown) return invalidCli(`unexpected flag ${unknown}`);
    if (!ctx?.threadId) return invalidCli("send-to-operator must run from a sender thread");
    const parsed = sendOperatorMessageInputSchema.safeParse({
      project_id: projectId,
      recipient: parseFlag(args, "--recipient"),
      severity: parseFlag(args, "--severity"),
      text: parseFlag(args, "--message"),
    });
    if (!parsed.success) return invalidCli(cliSchemaError(parsed.error, {
      project_id: "project",
      recipient: "recipient",
      severity: "severity",
      text: "message",
    }));
    try {
      const sent = await sendOperatorMessage(db, bb, parsed.data, ctx.threadId, deps.notifyUrgent);
      return operatorMessagesCliResult(projectId, [sent], "operator message persisted");
    } catch (error) {
      return invalidCli(error instanceof Error ? error.message : String(error), isRefusal(error) ? error.data.code : "INVALID_INPUT");
    }
  }
  if (command === "inbox") {
    const unknown = unexpectedFlags(args, ["--project", "--recipient", "--mark-read"]);
    if (unknown) return invalidCli(`unexpected flag ${unknown}`);
    const recipient = parseFlag(args, "--recipient");
    const markRead = parseFlag(args, "--mark-read");
    if (markRead !== null) {
      if (recipient !== null) return invalidCli("--recipient cannot be used with --mark-read");
      const messageId = z.coerce.number().int().positive().safeParse(markRead);
      if (!messageId.success) return invalidCli(messageId.error.message);
      try {
        const marked = await markOperatorMessageRead(db, bb, projectId, messageId.data);
        return operatorMessagesCliResult(projectId, [marked], "operator message marked read");
      } catch (error) {
        return invalidCli(error instanceof Error ? error.message : String(error), isRefusal(error) ? error.data.code : "INVALID_INPUT");
      }
    }
    const parsedRecipient = recipient === null ? undefined : operatorRecipientSchema.safeParse(recipient);
    if (parsedRecipient && !parsedRecipient.success) return invalidCli(parsedRecipient.error.message);
    try {
      const listed = await listOperatorMessages(db, bb, projectId, parsedRecipient?.data);
      // The reader answers a refusal instead of throwing it (#280), so the CLI has
      // to refuse on its own account. The code is the fallback because `message` is
      // optional on the result and a future outcome could arrive without one.
      if (listed.outcome !== "OK") return invalidCli(listed.message ?? listed.outcome, listed.outcome);
      return operatorMessagesCliResult(projectId, listed.messages, `${listed.messages.length} operator inbox messages`);
    } catch (error) {
      return invalidCli(error instanceof Error ? error.message : String(error), isRefusal(error) ? error.data.code : "INVALID_INPUT");
    }
  }
  if (command === "archive-sweep") {
    if (args.filter((arg) => !["--project", projectId, "--apply"].includes(arg)).length > 0 || args.filter((arg) => arg === "--apply").length > 1) return invalidCli("unexpected archive-sweep argument");
    const result = await deps.archiveSweep(projectId, args.includes("--apply"));
    return cliResult({
      outcome: result.outcome === "refused" ? "INTERNAL_ERROR" : "OK",
      subject: projectId,
      expected: result.archivableThreadIds.length,
      attempted: result.archivedThreadIds.length,
      verified: result.outcome === "refused" ? 0 : result.archivableThreadIds.length,
      message: result.message,
      evidence: result,
    });
  }
  if (command === "worktree-cleanup") {
    if (unexpectedFlags(args, ["--project"])) return invalidCli("unexpected worktree-cleanup argument; report-only command has no apply mode");
    try {
      const result = await reportProjectWorktreeCleanup(bb, projectId);
      return { exitCode: result.refused.length === 0 ? 0 : 2, stdout: JSON.stringify(result) };
    } catch (error) {
      return { exitCode: 2, stdout: JSON.stringify({ outcome: "refused", wouldRemove: [], refused: [{ path: "<inventory>", population: "unknown", action: "refuse", reason: error instanceof Error ? error.message : String(error) }], environmentRecordsReleased: false }) };
    }
  }
  if (command === "role-list") {
    const unknown = unexpectedFlags(args, ["--project"]);
    if (unknown) return invalidCli(`unexpected flag ${unknown}`);
    const current = readCurrentRoleBindings(db, projectId);
    if (current.status === "unknown") {
      return cliResult({
        outcome: current.reason === "project-unknown" ? "PROJECT_UNKNOWN" : "CANONICAL_STORE_UNAVAILABLE",
        subject: projectId,
        expected: 1,
        attempted: 0,
        verified: 0,
        message: `current role standing is unknown: ${current.reason}`,
      });
    }
    return cliResult({
      outcome: "OK",
      subject: projectId,
      expected: current.bindings.length,
      attempted: current.bindings.length,
      verified: current.bindings.length,
      message: `${current.bindings.length} current role bindings`,
      evidence: current.bindings,
    });
  }
  if (command === "wait-register") {
    const unknown = unexpectedFlags(args, ["--project", "--request"]);
    if (unknown) return invalidCli(`unexpected flag ${unknown}`);
    const requestJson = parseFlag(args, "--request");
    if (!requestJson) return invalidCli("--request JSON is required");
    let request: unknown;
    try {
      request = JSON.parse(requestJson);
    } catch (error) {
      return invalidCli(error instanceof Error ? error.message : String(error));
    }
    let result: import("./src/registered-waits.js").RegisterWaitResult;
    try {
      result = await deps.registerBoundedWaitForCli(request, ctx?.threadId);
    } catch {
      return cliResult({ outcome: "INTERNAL_ERROR", subject: projectId, expected: 1, attempted: 0, verified: 0, message: "wait registry state is unreadable; refusing fail closed" });
    }
    if (result.outcome === "refused") {
      return cliResult({ outcome: "INVALID_INPUT", subject: projectId, expected: 1, attempted: 0, verified: 0, message: result.message });
    }
    return cliResult({
      outcome: "OK",
      subject: projectId,
      expected: 1,
      attempted: 1,
      verified: 1,
      message: result.replay ? "registered wait replayed idempotently" : "registered wait persisted",
      evidence: { wait: result.wait },
    });
  }
  if (command === "wait-list") {
    const unknown = unexpectedFlags(args, ["--project"]);
    if (unknown) return invalidCli(`unexpected flag ${unknown}`);
    let waits: Array<Record<string, unknown>>;
    try {
      waits = await deps.listWaitsForCli();
    } catch {
      return cliResult({ outcome: "INTERNAL_ERROR", subject: projectId, expected: 0, attempted: 0, verified: 0, message: "wait registry state is unreadable; refusing fail closed" });
    }
    return cliResult({
      outcome: "OK",
      subject: projectId,
      expected: waits.length,
      attempted: waits.length,
      verified: waits.length,
      message: `${waits.length} registered waits`,
      evidence: waits,
    });
  }
  if (command === "apply") {
    const unknown = unexpectedFlags(args, ["--project", "--request"]);
    if (unknown) return invalidCli(`unexpected flag ${unknown}`);
    const requestJson = parseFlag(args, "--request");
    if (!requestJson) return invalidCli("--request JSON is required");
    try {
      const rawRequest = JSON.parse(requestJson);
      const request = parseApplyRequest(rawRequest);
      if (request.projectId !== projectId) return invalidCli("--project does not match request.projectId");
      return cliResult(await applyLiveAuthorizedMutation(bb, db, rawRequest));
    } catch (error) {
      return invalidCli(error instanceof Error ? error.message : String(error));
    }
  }
  if (command === "github-issue-backfill") {
    const unknown = unexpectedFlags(args, ["--project"]);
    const projectId = parseFlag(args, "--project");
    if (unknown || args.filter((arg) => arg === "--project").length !== 1 || projectId === null || projectId === "") {
      return invalidCli(`unexpected argument ${unknown ?? "--project PROJECT_ID is required"}`);
    }
    if (!db) return cliResult({ outcome: "CANONICAL_STORE_UNAVAILABLE", subject: projectId, expected: 1, attempted: 0, verified: 0, message: "canonical SQLite store is unavailable" });
    try {
      const backfill = backfillWorkItemGithubIssues(db, projectId, readGithubIssueForBackfill);
      const complete = backfill.state === "completed";
      return cliResult({
        outcome: complete ? "OK" : "EXTERNAL_UNAVAILABLE",
        subject: projectId,
        expected: backfill.candidates,
        attempted: backfill.candidates,
        verified: backfill.bound + backfill.alreadyBound,
        message: complete ? "GitHub WorkItem backfill complete" : `GitHub WorkItem backfill ${backfill.state}; canonical store remains available`,
        evidence: backfill,
      });
    } catch (error) {
      return cliResult({ outcome: "INTERNAL_ERROR", subject: projectId, expected: 1, attempted: 0, verified: 0, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (command === "cached-consumer-rollout") {
    const unknown = unexpectedFlags(args, ["--project", "--request"]);
    if (unknown) return invalidCli(`unexpected flag ${unknown}`);
    const requestJson = parseFlag(args, "--request");
    if (!requestJson) return invalidCli("--request JSON is required");
    try {
      const request = JSON.parse(requestJson);
      if (parseApplyRequest(request).projectId !== projectId) return invalidCli("--project does not match request.projectId");
      return cliResult(await applyLiveCachedConsumerRollout(bb, db, request, deps, ctx));
    } catch (error) {
      return invalidCli(error instanceof Error ? error.message : String(error));
    }
  }
  const json = command === "doctor" && args.includes("--json");
  const unknown = unexpectedFlags(json ? args.filter((arg) => arg !== "--json") : args, ["--project"]);
  if (unknown) return invalidCli(`unexpected flag ${unknown}`);
  if (command === "doctor") {
    if (args.filter((arg) => arg === "--json").length > 1) return invalidCli("--json must be supplied at most once");
    const result = await doctor(db, bb.sdk, projectId, deps.readCheckoutDivergence());
    if (!json || result.outcome !== "OK" || !db) return cliResult(result);
    try {
      return cliResult(workItemRegistrationDoctorResult(db, projectId, result));
    } catch (error) {
      return cliResult({ outcome: "INTERNAL_ERROR", subject: projectId, expected: 1, attempted: 0, verified: 0, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return cliResult(exportFoundation(db, projectId));
}

export default async function plugin(bb: BbPluginApi, options: PluginOptions = {}) {
  const notifyUrgent = options.notifyUrgent ?? ((message, senderThreadId) => defaultNotifyUrgent(message, senderThreadId, options.runBbCommand ?? runBbCommand));
  const fleetWatchdogSettings = bb.settings.define({
    fleetWatchdogFloorMs: {
      type: "string",
      label: "Fleet watchdog floor (ms)",
      description: "Idle time before quiet open work wakes the orchestrator.",
      default: String(FLEET_WATCHDOG_FLOOR_MS),
    },
    fleetWatchdogStaleWaitMs: {
      type: "string",
      label: "Fleet watchdog stale wait (ms)",
      description: "Declared wait age before it wakes the orchestrator.",
      default: String(FLEET_WATCHDOG_STALE_WAIT_MS),
    },
  });
  let fleetWatchdogFloorMigration: Promise<void> | null = null;
  const ensureFleetWatchdogFloorMigrated = () => {
    if (fleetWatchdogFloorMigration) return fleetWatchdogFloorMigration;
    fleetWatchdogFloorMigration = (async () => {
      const marker = await bb.storage.kv.get<unknown>(FLEET_WATCHDOG_FLOOR_MIGRATION_KEY);
      if (marker === true) {
        bb.log.info("fleet-watchdog floor setting preserved: already migrated");
        return;
      }
      if (marker !== undefined) throw new Error("fleet watchdog floor migration marker is malformed");
      const current = await fleetWatchdogSettings.get();
      if (current.fleetWatchdogFloorMs === String(FLEET_WATCHDOG_LEGACY_FLOOR_MS)) {
        const updated = await bb.sdk.plugins.updateSettings({
          pluginId: PLUGIN_ID,
          values: { fleetWatchdogFloorMs: String(FLEET_WATCHDOG_FLOOR_MS) },
        });
        if (updated.values.fleetWatchdogFloorMs !== String(FLEET_WATCHDOG_FLOOR_MS)) {
          throw new Error("fleet watchdog floor migration did not persist the five-minute value");
        }
        bb.log.warn(`fleet-watchdog floor setting migrated: ${FLEET_WATCHDOG_LEGACY_FLOOR_MS} -> ${FLEET_WATCHDOG_FLOOR_MS}`);
      } else {
        bb.log.info(`fleet-watchdog floor setting preserved: explicit value ${String(current.fleetWatchdogFloorMs)}`);
      }
      await bb.storage.kv.set(FLEET_WATCHDOG_FLOOR_MIGRATION_KEY, true);
    })().catch((error) => {
      fleetWatchdogFloorMigration = null;
      throw error;
    });
    return fleetWatchdogFloorMigration;
  };
  const readDiagnosticDivergence = () => readCheckoutDivergence(
    options.checkoutRoot === undefined ? findCheckoutRoot(dirname(fileURLToPath(import.meta.url))) : options.checkoutRoot,
  );
  let db: SqliteDatabase | null = null;
  try {
    db = bb.storage.database();
    databaseIsReady(db);
    bb.storage.migrate(db, MIGRATIONS);
    try {
      backfillWorkItemAttempts(db);
    } catch (error) {
      bb.log.error(`GH300 backfill degraded; canonical store remains available: ${String(error)}`);
    }
  } catch (error) {
    bb.log.error(`canonical store unavailable: ${String(error)}`);
    db = null;
  }

  const recoveryInFlight = new Set<string>();
  const RECOVERY_UNRECOVERABLE = "unrecoverable" as const;
  const withRecoveryTimeout = async <T>(label: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`error-recovery ${label} timed out after ${ERROR_RECOVERY_IO_TIMEOUT_MS}ms`));
          }, ERROR_RECOVERY_IO_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const isCurrentRoleHolder = (holder: RoleHolderState) => db !== null && readRoleHolderStates(db).some((candidate) =>
    candidate.project_id === holder.project_id &&
    candidate.role_id === holder.role_id &&
    candidate.role_generation === holder.role_generation &&
    candidate.execution_attempt_id === holder.execution_attempt_id &&
    candidate.thread_id === holder.thread_id,
  );
  const isCurrentLane = (lane: LaneRecoveryTarget) => db !== null && Boolean(db.prepare(
    `SELECT 1 FROM execution_attempts AS attempts
     JOIN work_items AS items ON items.project_id = attempts.project_id AND items.work_item_id = attempts.work_item_id
     WHERE attempts.project_id = ? AND attempts.execution_attempt_id = ? AND attempts.thread_id = ?
       AND attempts.origin = 'work_item' AND attempts.assignment_kind = 'write'
       AND attempts.state IN (${WORK_ITEM_CAPACITY_ATTEMPT_STATES.map(() => "?").join(", ")})
       AND items.lifecycle_state IN (${WORK_ITEM_CAPACITY_LIFECYCLE_STATES.map(() => "?").join(", ")})`,
  ).get(lane.project_id, lane.execution_attempt_id, lane.thread_id, ...WORK_ITEM_CAPACITY_ATTEMPT_STATES, ...WORK_ITEM_CAPACITY_LIFECYCLE_STATES));
  const resolveRecoveryIdentity = (projectId: string, threadId: string): { holder?: RoleHolderState; lane?: LaneRecoveryTarget } | null => {
    if (db === null) return {};
    try {
      const holder = db.prepare(
        `SELECT project_id, role_id, role_generation, execution_attempt_id, thread_id
         FROM execution_attempts
         WHERE project_id = ? AND thread_id = ? AND origin = 'role_holder'
         ORDER BY rowid DESC LIMIT 1`,
      ).get(projectId, threadId) as RoleHolderState | undefined;
      const lane = db.prepare(
        `SELECT project_id, thread_id, execution_attempt_id
         FROM execution_attempts
         WHERE project_id = ? AND thread_id = ? AND origin = 'work_item' AND assignment_kind = 'write'
         ORDER BY rowid DESC LIMIT 1`,
      ).get(projectId, threadId) as LaneRecoveryTarget | undefined;
      return { holder, lane };
    } catch (error) {
      bb.log.warn(`error-recovery identity resolution failed: project=${projectId} thread=${threadId} ${String(error)}`);
      return null;
    }
  };
  const withRecoverySendTimeout = async <T>(threadId: string, operation: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`error-recovery threads.send timed out after ${ERROR_RECOVERY_IO_TIMEOUT_MS}ms`));
          }, ERROR_RECOVERY_IO_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      if (timedOut) bb.log.error(`error-recovery send anomaly: thread=${threadId} reason=uncancellable-send-timeout ${String(error)}`);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const recoverErroredThread = async (threadId: string, projectId: string, holder?: RoleHolderState, lane?: LaneRecoveryTarget) => {
    if (recoveryInFlight.has(threadId)) {
      bb.log.warn(`error-recovery wake suppressed: project=${projectId} thread=${threadId} reason=recovery-in-flight`);
      return null;
    }
    if (db === null) return null;
    recoveryInFlight.add(threadId);
    try {
      if (!db.prepare("SELECT 1 FROM project_config_heads WHERE project_id = ?").get(projectId)) return false;
      const thread = await withRecoveryTimeout("threads.get", (signal) => bb.sdk.threads.get({ threadId, signal }));
      if (thread.id !== threadId || thread.projectId !== projectId || thread.archivedAt !== null || thread.deletedAt !== null) {
        bb.log.error(`error-recovery target unrecoverable: project=${projectId} thread=${threadId} reason=canonical-target-invalid`);
        return RECOVERY_UNRECOVERABLE;
      }
      if (thread.status !== "error" || (holder !== undefined && !isCurrentRoleHolder(holder)) || (lane !== undefined && !isCurrentLane(lane))) return false;

      let head = "unavailable (re-fetch before continuing)";
      if (thread.environmentId !== null) {
        const environmentId = thread.environmentId;
        try {
          const status = await withRecoveryTimeout("environments.status", (signal) => bb.sdk.environments.status({ environmentId, signal }));
          if (status.outcome === "available") {
            const checkout = status.workspace.checkout;
            if (checkout.kind === "branch" || checkout.kind === "detached") head = checkout.headSha ?? `${checkout.kind} checkout with no HEAD`;
            else head = checkout.kind === "unborn" ? "unborn checkout" : `unknown (${checkout.reason})`;
          }
        } catch (error) {
          bb.log.warn(`error-recovery head unavailable: thread=${threadId} ${String(error)}`);
        }
      }
      if (holder !== undefined && !isCurrentRoleHolder(holder)) {
        bb.log.warn(`error-recovery wake suppressed: project=${projectId} thread=${threadId} reason=role-holder-no-longer-current`);
        return false;
      }
      if (lane !== undefined && !isCurrentLane(lane)) {
        bb.log.warn(`error-recovery wake suppressed: project=${projectId} thread=${threadId} reason=lane-no-longer-current`);
        return false;
      }
      // The SDK cannot cancel threads.send. Bound only the duplicate-suppression guard;
      // an expired send remains outstanding and is reported as an anomaly.
      await withRecoverySendTimeout(threadId, () => bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{
          type: "text",
          visibility: "agent-only",
          text: `RECOVERY WAKE — reconcile state before resuming. The workspace and recorded conversation survived the daemon interruption, but the interrupted turn may have half-applied intent and a composed instruction may not have been delivered. Observed checkout head: ${head}. Re-fetch and confirm the current head, reconcile the frozen work order and canonical state against the conversation, identify any half-applied mutation or lost delivery, and re-run every pre-crash measurement whose command and output are not visible before continuing.`,
          mentions: [],
        }],
      }));
      bb.log.warn(`error-recovery wake sent: project=${projectId} thread=${threadId} mode=auto head=${head}`);
      return true;
    } catch (error) {
      bb.log.warn(`error-recovery wake failed: project=${projectId} thread=${threadId} ${String(error)}`);
      return null;
    } finally {
      recoveryInFlight.delete(threadId);
    }
  };
  const reconcileErrorRecovery = async () => {
    if (db === null) {
      const coverage = "blind";
      const roleRestart = "blind";
      const laneRestart = "blind";
      bb.log.error(`error-recovery coverage=${coverage} event=blind roleRestart=${roleRestart} roles=unknown laneRestart=${laneRestart} lanes=unknown openWorkItems=unknown reason=canonical-store-unreadable`);
      return;
    }
    let holders: RoleHolderState[];
    let lanes: LaneRecoveryTarget[];
    let openWorkItems: number;
    try {
      holders = readRoleHolderStates(db);
      lanes = db.prepare(
        `SELECT attempts.project_id, attempts.thread_id, attempts.execution_attempt_id FROM execution_attempts AS attempts
         JOIN work_items AS items ON items.project_id = attempts.project_id AND items.work_item_id = attempts.work_item_id
         WHERE attempts.origin = 'work_item' AND attempts.assignment_kind = 'write' AND attempts.thread_id IS NOT NULL
           AND attempts.state IN (${WORK_ITEM_CAPACITY_ATTEMPT_STATES.map(() => "?").join(", ")})
           AND items.lifecycle_state IN (${WORK_ITEM_CAPACITY_LIFECYCLE_STATES.map(() => "?").join(", ")})
         ORDER BY attempts.project_id, attempts.thread_id`,
      ).all(...WORK_ITEM_CAPACITY_ATTEMPT_STATES, ...WORK_ITEM_CAPACITY_LIFECYCLE_STATES) as LaneRecoveryTarget[];
      openWorkItems = (db.prepare(
        "SELECT COUNT(*) AS count FROM work_items WHERE lifecycle_state NOT IN ('succeeded', 'failed', 'cancelled')",
      ).get() as { count: number }).count;
    } catch (error) {
      const coverage = "blind";
      const roleRestart = "blind";
      const laneRestart = "blind";
      bb.log.error(`error-recovery coverage=${coverage} event=blind roleRestart=${roleRestart} roles=unknown laneRestart=${laneRestart} lanes=unknown openWorkItems=unknown reason=canonical-inventory-unreadable:${String(error)}`);
      return;
    }
    let failedRoles = 0;
    for (const holder of holders) {
      const outcome = await recoverErroredThread(holder.thread_id, holder.project_id, holder);
      if (outcome === null || outcome === RECOVERY_UNRECOVERABLE) failedRoles += 1;
    }
    let failedLanes = 0;
    for (const lane of lanes) {
      const outcome = await recoverErroredThread(lane.thread_id, lane.project_id, undefined, lane);
      if (outcome === null || outcome === RECOVERY_UNRECOVERABLE) failedLanes += 1;
    }
    const roleRestart = failedRoles === 0 ? "armed" : "degraded";
    const laneRestart = failedLanes === 0 ? "armed" : "degraded";
    const coverage = failedRoles === 0 && failedLanes === 0 ? "armed" : "degraded";
    const reason = coverage === "armed" ? "none" : `recovery-failed:roles=${failedRoles},lanes=${failedLanes}`;
    bb.log.error(`error-recovery coverage=${coverage} event=armed roleRestart=${roleRestart} roles=${holders.length} failedRoles=${failedRoles} laneRestart=${laneRestart} lanes=${lanes.length} failedLanes=${failedLanes} openWorkItems=${openWorkItems} reason=${reason}`);
  };

  const readPendingExternalWait = async (threadId: string, signal?: AbortSignal) => {
    try {
      return (await bb.sdk.threads.interactions.list({ threadId, ...(signal ? { signal } : {}) })).some((interaction) => interaction.status === "pending");
    } catch {
      return true;
    }
  };

  const waitRegistry = createWaitRegistry({
    read: () => bb.storage.kv.get<unknown>("lane-watcher.registered-waits"),
    write: (state) => bb.storage.kv.set("lane-watcher.registered-waits", state),
  });

  // #93 durable wait-validator layer over the one wait registry: the
  // bounded escalation ladder for fired waits and the host-supervised
  // liveness rule. Escalation state lives in the plugin KV seam; canonical
  // SQLite, the resolver, and receipts are never touched.
  const readThreadObservation = async (threadId: string): Promise<SourceObservation> => {
    const thread = await bb.sdk.threads.get({ threadId });
    return thread.archivedAt !== null || thread.deletedAt !== null
      ? { status: thread.status, archived: true }
      : { status: thread.status, archived: false };
  };

  const boundedRegistry = {
    register: (wait: Parameters<typeof waitRegistry.register>[0]) => waitRegistry.register(wait),
    // The store loads lazily; every read recovers first so a cold host never
    // answers an empty list from a populated registry (round-2 finding #4).
    list: async () => { await waitRegistry.recover(); return waitRegistry.list(); },
    firedWaitIds: async () => { await waitRegistry.recover(); return waitRegistry.firedList() as Array<{ waitId: string; reason: string; waiterThreadId: string }>; },
  };
  const escalationCycle = createWaitEscalationCycle({
    registry: boundedRegistry,
    escalationPersistence: {
      read: () => bb.storage.kv.get<unknown>(WAIT_ESCALATION_KV_KEY),
      write: (state) => bb.storage.kv.set(WAIT_ESCALATION_KV_KEY, state),
    },
    readWaiter: readThreadObservation,
    steerWaiter: async (target) => {
      await bb.sdk.threads.send({
        threadId: target.waiterThreadId,
        mode: "steer",
        input: [
          {
            type: "text",
            visibility: "agent-only",
            text: `Registered wait ${target.waitId} fired (${target.reason}). Wake: inspect what you were waiting on, act on it, and record the next step or blocker.`,
            mentions: [],
          },
        ],
      });
    },
    onFire: (record) => {
      bb.log.warn(`registered wait fired: ${record.waitId} (${record.reason})`);
      bb.realtime.publish("wait-validator", { fired: record.waitId, reason: record.reason });
    },
    onEscalate: (record) => {
      bb.log.error(`registered wait escalation: waiter ${record.waiterThreadId} ignored ${record.steers} steers for ${record.waitId}; succession trigger`);
      bb.realtime.publish("wait-validator", { escalated: record.waitId, waiterThreadId: record.waiterThreadId, successionTrigger: true });
    },
  });
  await escalationCycle.recover().catch((error) => bb.log.error(`wait escalation state is unreadable: ${String(error)}`));

  const roleIdlePersistence = {
    read: () => bb.storage.kv.get<unknown>("lane-watcher.role-idle"),
    write: (state: Record<string, RoleIdleRecord>) => bb.storage.kv.set("lane-watcher.role-idle", state),
  };

  const roleLivenessWarnings = new Map<string, string>();
  const roleLivenessKey = fleetWatchdogRoleLivenessKey;
  const warnRoleLiveness = (holder: RoleHolderState, evidence: string) => {
    const key = roleLivenessKey(holder);
    if (roleLivenessWarnings.get(key) === evidence) return;
    roleLivenessWarnings.set(key, evidence);
    bb.log.warn(`role steer refused: project=${holder.project_id} role=${holder.role_id}@${holder.role_generation} holder=${holder.execution_attempt_id} thread=${holder.thread_id} ${evidence}`);
  };
  const roleThreadRefusal = (
    holder: RoleHolderState,
    thread: Awaited<ReturnType<typeof bb.sdk.threads.get>>,
    requireIdle: boolean,
    recover = false,
  ) => {
    const witness = /\bwitness\b/iu.test(`${thread.title ?? ""}\n${thread.titleFallback ?? ""}`);
    const usableStatus = recover ? thread.status === "idle" || thread.status === "error" || thread.status === "stopping" : requireIdle ? thread.status === "idle" : thread.status === "idle" || thread.status === "active";
    return thread.projectId === holder.project_id && thread.archivedAt === null && thread.deletedAt === null && !witness && usableStatus
      ? null
      : `observedProject=${thread.projectId} archivedAt=${thread.archivedAt ?? "null"} deletedAt=${thread.deletedAt ?? "null"} status=${thread.status} witness=${witness}`;
  };

  const readRoleScopes = async () => [];

  const sendRoleWake = async (role: import("./src/awareness.js").RoleIdleView, text: string) => {
    if (!db) return "error" as const;
    const expectedHolder: RoleHolderState = {
      project_id: role.projectId,
      role_id: role.roleId,
      role_generation: role.roleGeneration,
      execution_attempt_id: role.executionAttemptId,
      thread_id: role.threadId,
    };
    let holders: RoleHolderState[];
    try {
      holders = readRoleHolderStates(db).filter((holder) =>
        holder.project_id === role.projectId &&
        holder.role_id === role.roleId &&
        holder.role_generation === role.roleGeneration &&
        holder.execution_attempt_id === role.executionAttemptId,
      );
    } catch (error) {
      warnRoleLiveness(expectedHolder, `holder=unknown error=${String(error)}`);
      return "error" as const;
    }
    if (holders.length !== 1 || holders[0]?.thread_id !== role.threadId) {
      warnRoleLiveness(expectedHolder, `holderMatches=${holders.length} observedThread=${holders[0]?.thread_id ?? "null"}`);
      return false;
    }
    let thread;
    try {
      thread = await bb.sdk.threads.get({ threadId: holders[0].thread_id });
    } catch (error) {
      warnRoleLiveness(holders[0], `liveness=unknown error=${String(error)}`);
      return "error" as const;
    }
    const refusal = roleThreadRefusal(holders[0], thread, true);
    if (refusal) {
      warnRoleLiveness(holders[0], refusal);
      return false;
    }
    roleLivenessWarnings.delete(roleLivenessKey(holders[0]));
    try {
      await sendWhenThreadIdle(bb, {
        threadId: holders[0].thread_id,
        mode: "steer",
        input: [{ type: "text", visibility: "agent-only", text, mentions: [] }],
      });
    } catch (error) {
      warnRoleLiveness(holders[0], `idle-wait=failed error=${String(error)}`);
      return "error" as const;
    }
    return true;
  };

  const steerRole = async (role: import("./src/awareness.js").RoleIdleView) => {
    if (!db) return "error" as const;
    let startable: { work_item_id: string } | undefined;
    try {
      startable = db.prepare(
        `SELECT work_item_id FROM work_items
         WHERE project_id = ? AND lifecycle_state IN ('proposed', 'ready')
         ORDER BY created_at_ms, work_item_id LIMIT 1`,
      ).get(role.projectId) as { work_item_id: string } | undefined;
    } catch {
      return "error" as const;
    }
    if (!startable) return false;
    return sendRoleWake(role, `Wrongful idle: queue head ${startable.work_item_id} is startable. Inspect the queue and act or record the blocker.`);
  };

  const watcher = createLaneWatcher({
    readRoleHolders: () => (db ? readRoleHolderStates(db) : []),
    readRoleScopes,
    roleIdlePersistence,
    waitRegistry,
    onAlert: (alert) => bb.log.warn(`role awareness ${alert.kind}: ${alert.role.roleId}@${alert.role.roleGeneration} queue ${alert.role.queueHeadId}`),
    onRoleSuccessionRequired: (role) => bb.log.warn(`role succession required: ${role.roleId}@${role.roleGeneration}`),
    readWorker: async (threadId, signal) => {
      const roleHolders = db ? readRoleHolderStates(db).filter((holder) => holder.thread_id === threadId) : [];
      let thread;
      try {
        thread = await bb.sdk.threads.get({ threadId, ...(signal ? { signal } : {}) });
      } catch (error) {
        for (const holder of roleHolders) warnRoleLiveness(holder, `liveness=unknown error=${String(error)}`);
        throw error;
      }
      let roleThreadRefused = false;
      for (const holder of roleHolders) {
        const refusal = roleThreadRefusal(holder, thread, false);
        if (refusal) {
          roleThreadRefused = true;
          warnRoleLiveness(holder, refusal);
        } else {
          roleLivenessWarnings.delete(roleLivenessKey(holder));
        }
      }
      const archived = thread.archivedAt !== null || thread.deletedAt !== null || roleThreadRefused;
      return {
        projectId: thread.projectId,
        status: thread.status,
        pendingExternalWait: archived ? true : await readPendingExternalWait(threadId, signal),
        archived,
        operatorWait: null,
        operatorWaitKnown: true,
        // Native ThreadResponse has no idle-since field; the role ledger anchors this proxy on first observation.
        idleSinceMs: thread.status === "idle" ? thread.updatedAt : null,
      };
    },
    steerRole,
  });
  await watcher.recover().catch((error) => bb.log.error(`lane watcher recovery failed: ${String(error)}`));
  const fleetWatchdogIdle = createRoleIdleLedger({
    read: () => bb.storage.kv.get<unknown>("fleet-watchdog.role-idle"),
    write: (state) => bb.storage.kv.set("fleet-watchdog.role-idle", state),
  });

  type IdleFleetFact<T> = { known: true; value: T } | { known: false; reason: string };
  type LaneCapacityObservation = {
    projectId: string;
    orchestratorThreadId: string;
    orchestratorRoleGeneration: number;
    coverageState: "known" | "blind";
    activeLaneCount: number | null;
    writingLaneCeiling: number | null;
    startableWork: boolean | null;
    reason: string | null;
    laneCapacityObservationId: string;
    observedAtMs: number;
    executionAttemptIds: string[];
  };
  if (db) {
    db.prepare(
      "UPDATE lane_capacity_intervals SET ended_at_ms = last_confirmed_at_ms WHERE ended_at_ms IS NULL",
    ).run();
  }
  const recordLaneCapacityInterval = (observation: LaneCapacityObservation) => {
    if (!db) throw new Error("canonical-store-unavailable");
    // Keep this transaction to roll back partial evidence when a later attempt row fails.
    // Orphan absence is separately guaranteed by interval-before-evidence ordering; the fixture covers rollback when the second attempt row fails.
    db.transaction(() => {
      const startableWork = observation.startableWork === null ? null : observation.startableWork ? 1 : 0;
      const extended = db!.prepare(
        `UPDATE lane_capacity_intervals SET last_confirmed_at_ms = ?,
           lane_capacity_observation_id = COALESCE(lane_capacity_observation_id, ?)
         WHERE project_id = ? AND ended_at_ms IS NULL
           AND coverage_state = ? AND active_lane_count IS ?
           AND writing_lane_ceiling IS ? AND startable_work IS ?`,
      ).run(
        observation.observedAtMs,
        observation.laneCapacityObservationId,
        observation.projectId,
        observation.coverageState,
        observation.activeLaneCount,
        observation.writingLaneCeiling,
        startableWork,
      );
      if (extended.changes !== 1) {
        db!.prepare(
        "UPDATE lane_capacity_intervals SET ended_at_ms = last_confirmed_at_ms WHERE project_id = ? AND ended_at_ms IS NULL",
      ).run(observation.projectId);
      db!.prepare(
        `INSERT INTO lane_capacity_intervals (
           project_id, orchestrator_thread_id, orchestrator_role_generation,
           coverage_state, active_lane_count, writing_lane_ceiling, startable_work,
           reason, lane_capacity_observation_id, started_at_ms, last_confirmed_at_ms, ended_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).run(
          observation.projectId,
          observation.orchestratorThreadId,
        observation.orchestratorRoleGeneration,
        observation.coverageState,
        observation.activeLaneCount,
        observation.writingLaneCeiling,
        startableWork,
        observation.reason,
        observation.laneCapacityObservationId,
          observation.observedAtMs,
          observation.observedAtMs,
        );
      }
      for (const executionAttemptId of observation.executionAttemptIds) {
        db!.prepare(
          `INSERT OR IGNORE INTO lane_capacity_refresh_evidence (
             project_id, lane_capacity_observation_id, execution_attempt_id, observed_at_ms
           ) VALUES (?, ?, ?, ?)`,
        ).run(observation.projectId, observation.laneCapacityObservationId, executionAttemptId, observation.observedAtMs);
      }
    })();
  };
  const closeLaneCapacityCoverage = () => {
    if (!db) return;
    db.pragma("busy_timeout = 0");
    try {
      db.prepare("UPDATE lane_capacity_intervals SET ended_at_ms = last_confirmed_at_ms WHERE ended_at_ms IS NULL").run();
    } finally {
      db.pragma("busy_timeout = 5000");
    }
  };
  const idleFleetBlind = (
    orchestrator: "known" | "blind",
    activeLanes: "known" | "blind",
    startable: "known" | "blind",
    reason: string,
  ): IdleFleetDecision => ({
    kind: "blind",
    message: `idle-fleet coverage=blind orchestrator=${orchestrator} activeLanes=${activeLanes} startable=${startable} reason=${reason}`,
  });
  const readIdleFleetActiveLanes = async (projectId: string): Promise<IdleFleetFact<number>> => {
    if (!db) return { known: false, reason: "canonical-store-unavailable" };
    try {
      const capacityEvidence = workItemCapacityLaneEvidence(db, projectId);
      if (capacityEvidence.unboundWorkItemIds.length > 0) return { known: false, reason: "work-items-have-no-thread-binding:GH-300" };
      const laneIds = new Set<string>();
      const now = Date.now();
      for (const row of capacityEvidence.lanes) {
        if (row.idle_kind === "blind") return { known: false, reason: "dispatch-unknown-attempt" };
        if (row.lane_id.length === 0 || typeof row.thread_id !== "string" || row.thread_id.length === 0) {
          return { known: false, reason: "work-item-attempt-has-no-thread-binding:GH-300" };
        }
        if (typeof row.observed_at_ms !== "number" || !Number.isSafeInteger(row.observed_at_ms) || row.observed_at_ms < 0 || now - row.observed_at_ms > IDLE_FLEET_ATTEMPT_STALE_MS) {
          return { known: false, reason: "stale-active-attempt" };
        }
        laneIds.add(row.lane_id);
      }
      return { known: true, value: laneIds.size };
    } catch (error) {
      return { known: false, reason: `active-lanes-unreadable:${String(error)}` };
    }
  };
  const readIdleFleetNativeLanes = async (projectId: string): Promise<IdleFleetFact<{ count: number; executionAttemptIds: string[] }>> => {
    if (!db) return { known: false, reason: "canonical-store-unavailable" };
    try {
      const dispatcherThreadIds = new Set(
        (db.prepare(
          "SELECT thread_id FROM execution_attempts WHERE project_id = ? AND origin = 'role_holder' AND thread_id IS NOT NULL",
        ).all(projectId) as Array<{ thread_id: string }>).map((row) => row.thread_id),
      );
      if (dispatcherThreadIds.size === 0) return { known: false, reason: "native-lane-parents-unreadable" };
      const threads: Awaited<ReturnType<typeof bb.sdk.threads.list>> = [];
      for (let offset = 0; ; offset += 100) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const page = await Promise.race([
          bb.sdk.threads.list({ projectId, hasParent: true, includeHidden: true, archived: false, limit: 100, offset }),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("native-lane-observation-timeout")), 10_000); }),
        ]).finally(() => { if (timeout) clearTimeout(timeout); });
        threads.push(...page);
        if (page.length < 100) break;
      }
      const isWorkingLane = (lane: (typeof threads)[number]) => lane.status === "active" || lane.status === "starting";
      const liveLanes = threads.filter((thread) =>
        !dispatcherThreadIds.has(thread.id) &&
        thread.parentThreadId !== null &&
        dispatcherThreadIds.has(thread.parentThreadId) &&
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        isWorkingLane(thread),
      );
      const executionAttemptIds: string[] = [];
      for (const lane of liveLanes) {
        const matches = db.prepare(
          `SELECT execution_attempt_id, assignment_kind
           FROM execution_attempts
           WHERE project_id = ? AND origin = 'work_item'
             AND state = 'running' AND thread_id = ?`,
        ).all(projectId, lane.id) as Array<{ execution_attempt_id: string; assignment_kind: string | null }>;
        if (matches.length !== 1 || matches[0]!.assignment_kind !== "write") continue;
        const observedAtMs = Date.now();
        db.prepare(
          `UPDATE execution_attempts SET observed_at_ms = ?
           WHERE project_id = ? AND execution_attempt_id = ? AND state = 'running'`,
        ).run(observedAtMs, projectId, matches[0]!.execution_attempt_id);
        executionAttemptIds.push(matches[0]!.execution_attempt_id);
      }
      return { known: true, value: { count: liveLanes.length, executionAttemptIds } };
    } catch (error) {
      return { known: false, reason: `native-lanes-unreadable:${String(error)}` };
    }
  };
  const readIdleFleetStartable = async (projectId: string): Promise<IdleFleetFact<StartableQueueState>> => {
    if (!db) return { known: false, reason: "canonical-store-unavailable" };
    try {
      const repositories = (db.prepare(
        `SELECT targets.remote_url FROM project_config_heads AS heads
         JOIN repository_targets AS targets
           ON targets.project_id = heads.project_id AND targets.config_revision = heads.config_revision
         WHERE heads.project_id = ? ORDER BY targets.repo_target_id`,
      ).all(projectId) as Array<{ remote_url: string | null }>).map((target) => githubRepository(target.remote_url));
      if (repositories.length === 0 || repositories.some((repository) => repository === null)) {
        return { known: false, reason: "configured-repositories-unreadable" };
      }
      const queue = await startableQueueStateAsync(repositories as string[]);
      return queue === null ? { known: false, reason: "startable-queue-unreadable" } : { known: true, value: queue };
    } catch (error) {
      return { known: false, reason: `startable-queue-unreadable:${String(error)}` };
    }
  };
  const readIdleFleetCeiling = (projectId: string): IdleFleetFact<number> => {
    if (!db) return { known: false, reason: "canonical-store-unavailable" };
    try {
      const row = db.prepare(
        `SELECT revisions.canonical_config_json
         FROM project_config_heads AS heads
         JOIN project_config_revisions AS revisions
           ON revisions.project_id = heads.project_id AND revisions.config_revision = heads.config_revision
         WHERE heads.project_id = ?`,
      ).get(projectId) as { canonical_config_json: string } | undefined;
      return row
        ? { known: true, value: writingLaneCeilingFromJson(row.canonical_config_json) }
        : { known: false, reason: "writing-lane-ceiling-unreadable" };
    } catch (error) {
      return { known: false, reason: `writing-lane-ceiling-unreadable:${String(error)}` };
    }
  };
  const readLaneCapacityObservation = async (projectId: string): Promise<LaneCapacityObservation> => {
    if (!db) throw new Error("canonical-store-unavailable");
    const orchestrators = readRoleHolderStates(db).filter((candidate) =>
      candidate.project_id === projectId && candidate.role_id === "project-orchestrator",
    );
    if (orchestrators.length !== 1) throw new Error(`canonical-orchestrator-count:${orchestrators.length}`);
    const holder = orchestrators[0]!;
    const nativeLanes = await readIdleFleetNativeLanes(projectId);
    const [activeLanes, startable, ceiling] = await Promise.all([
      readIdleFleetActiveLanes(projectId),
      readIdleFleetStartable(projectId),
      readIdleFleetCeiling(projectId),
    ]);
    const observedAtMs = Date.now();
    const reasons = [
      !activeLanes.known ? activeLanes.reason : null,
      !nativeLanes.known ? nativeLanes.reason : null,
      !startable.known ? startable.reason : null,
      !ceiling.known ? ceiling.reason : null,
      activeLanes.known && nativeLanes.known && activeLanes.value !== nativeLanes.value.count
        ? `active-lanes-disagreement:canonical=${activeLanes.value}:native=${nativeLanes.value.count}`
        : null,
    ].filter((reason): reason is string => reason !== null);
    const coverageState = reasons.length === 0 ? "known" : "blind";
    const startableWork = startable.known ? startable.value.count > 0 : null;
    const open = db.prepare(
      `SELECT coverage_state, active_lane_count, writing_lane_ceiling, startable_work, reason, lane_capacity_observation_id
       FROM lane_capacity_intervals WHERE project_id = ? AND ended_at_ms IS NULL`,
    ).get(projectId) as {
      coverage_state: string; active_lane_count: number | null; writing_lane_ceiling: number | null;
      startable_work: number | null; reason: string | null; lane_capacity_observation_id: string | null;
    } | undefined;
    const sameFacts = open !== undefined && open.coverage_state === coverageState &&
      open.active_lane_count === (activeLanes.known ? activeLanes.value : null) &&
      open.writing_lane_ceiling === (ceiling.known ? ceiling.value : null) &&
      open.startable_work === (startableWork === null ? null : startableWork ? 1 : 0) &&
      open.reason === (reasons.length === 0 ? null : reasons.join(";"));
    const laneCapacityObservationId = sameFacts && open?.lane_capacity_observation_id
      ? open.lane_capacity_observation_id
      : randomBytes(16).toString("hex");
    return {
      projectId,
      orchestratorThreadId: holder.thread_id,
      orchestratorRoleGeneration: holder.role_generation,
      coverageState,
      activeLaneCount: activeLanes.known ? activeLanes.value : null,
      writingLaneCeiling: ceiling.known ? ceiling.value : null,
      startableWork,
      reason: reasons.length === 0 ? null : reasons.join(";"),
      laneCapacityObservationId,
      observedAtMs,
      executionAttemptIds: nativeLanes.known ? nativeLanes.value.executionAttemptIds : [],
    };
  };
  const readIdleFleetProbes = async (): Promise<IdleFleetProbe[]> => {
    if (!db) throw new Error("canonical-store-unavailable");
    const holders = readRoleHolderStates(db).filter((holder) => holder.role_id === "project-orchestrator");
    const probes: IdleFleetProbe[] = [];
    for (const holder of holders) {
      const thread = await bb.sdk.threads.get({ threadId: holder.thread_id });
      if (thread.projectId !== holder.project_id || thread.archivedAt !== null || thread.deletedAt !== null) {
        throw new Error("orchestrator-unreadable");
      }
      if (thread.status === "idle" && !Number.isFinite(thread.updatedAt)) {
        throw new Error("orchestrator-unreadable");
      }
      if (
        thread.status === "idle"
      ) {
        probes.push({ projectId: holder.project_id, threadId: holder.thread_id, idleEpisode: String(thread.updatedAt) });
      }
    }
    return probes;
  };
  const readIdleFleet = async (probe: IdleFleetProbe): Promise<IdleFleetDecision> => {
    if (!db) return idleFleetBlind("blind", "blind", "blind", "canonical-store-unavailable");
    let holder: RoleHolderState | undefined;
    try {
      if (!db.prepare("SELECT 1 FROM project_config_heads WHERE project_id = ?").get(probe.projectId)) return { kind: "silent" };
      const orchestrators = readRoleHolderStates(db).filter((candidate) => candidate.project_id === probe.projectId && candidate.role_id === "project-orchestrator");
      if (orchestrators.length === 0) return { kind: "silent" };
      if (orchestrators.length !== 1) {
        return idleFleetBlind("blind", "blind", "blind", "canonical-orchestrator-ambiguous");
      }
      holder = orchestrators[0];
      if (holder.thread_id !== probe.threadId) return { kind: "silent" };
    } catch (error) {
      return idleFleetBlind("blind", "blind", "blind", `canonical-role-holders-unreadable:${String(error)}`);
    }

    let thread: Awaited<ReturnType<typeof bb.sdk.threads.get>>;
    try {
      thread = await bb.sdk.threads.get({ threadId: holder.thread_id });
    } catch (error) {
      return idleFleetBlind("blind", "blind", "blind", `orchestrator-unreadable:${String(error)}`);
    }
    if (thread.projectId !== probe.projectId || thread.archivedAt !== null || thread.deletedAt !== null) {
      return idleFleetBlind("blind", "blind", "blind", "orchestrator-unreadable");
    }
    if (thread.status !== "idle") return { kind: "silent" };
    if (!Number.isFinite(thread.updatedAt)) return idleFleetBlind("blind", "blind", "blind", "orchestrator-unreadable");
    if (String(thread.updatedAt) !== probe.idleEpisode) return { kind: "silent" };

    const [activeLanes, nativeLanes, startable] = await Promise.all([
      readIdleFleetActiveLanes(probe.projectId),
      readIdleFleetNativeLanes(probe.projectId),
      readIdleFleetStartable(probe.projectId),
    ]);
    const laneDisagreement = activeLanes.known && nativeLanes.known && activeLanes.value !== nativeLanes.value.count;
    if (!activeLanes.known || !nativeLanes.known || !startable.known) {
      const blindReasons = [
        !activeLanes.known ? activeLanes.reason : null,
        !nativeLanes.known ? nativeLanes.reason : null,
        !startable.known ? startable.reason : null,
      ].filter((reason): reason is string => reason !== null);
      return idleFleetBlind(
        "known",
        !activeLanes.known || !nativeLanes.known ? "blind" : "known",
        startable.known ? "known" : "blind",
        blindReasons.join(";"),
      );
    }
    if (laneDisagreement) {
      return idleFleetBlind("known", "blind", "known", `active-lanes-disagreement:canonical=${activeLanes.value}:native=${nativeLanes.value.count}`);
    }
    if (activeLanes.value > 0 || startable.value.count === 0) return { kind: "silent" };
    const queueHead = startable.value.head;
    if (!queueHead) return { kind: "silent" };
    const role = {
      projectId: holder.project_id,
      roleId: holder.role_id,
      roleGeneration: holder.role_generation,
      executionAttemptId: holder.execution_attempt_id,
      threadId: holder.thread_id,
      queueHeadId: queueHead,
      idleAgeMs: 0,
    };
    return {
      kind: "ready",
      episodeKey: fleetWatchdogEpisodeKey(holder, queueHead),
      legacyEpisodeKey: fleetWatchdogLegacyEpisodeKey(holder, queueHead),
      role,
      message: `Idle fleet: queue head ${queueHead} is startable with zero active writing lanes. Dispatch it or record the blocker.`,
    };
  };
  const capacityObservationLocks = new Map<string, Promise<void>>();
  const idleFleetDetector = createIdleFleetDetector({
    read: readIdleFleet,
    readRearmProbes: readIdleFleetProbes,
    persistence: {
      read: () => bb.storage.kv.get<unknown>("idle-fleet.wake"),
      write: (state) => bb.storage.kv.set("idle-fleet.wake", state),
    },
    capacity: {
      readProjectIds: async () => [...new Set((db ? readRoleHolderStates(db) : []).filter((holder) =>
        holder.role_id === "project-orchestrator",
      ).map((holder) => holder.project_id))],
      observe: async (projectId) => {
        const previous = capacityObservationLocks.get(projectId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => { release = resolve; });
        const queued = previous.then(() => current);
        capacityObservationLocks.set(projectId, queued);
        await previous;
        try {
          recordLaneCapacityInterval(await readLaneCapacityObservation(projectId));
        } finally {
          release();
          if (capacityObservationLocks.get(projectId) === queued) capacityObservationLocks.delete(projectId);
        }
      },
      close: closeLaneCapacityCoverage,
    },
    debounceMs: IDLE_FLEET_DEBOUNCE_MS,
    onBlind: (message) => bb.log.warn(message),
    wake: async (ready: IdleFleetReady) => {
      const confirmed = await readIdleFleet(ready.probe);
      if (confirmed.kind !== "ready" || confirmed.episodeKey !== ready.episodeKey) return false;
      return (await sendRoleWake(confirmed.role, confirmed.message)) === true;
    },
  });
  bb.onDispose(idleFleetDetector.stop);
  bb.background.service("idle-fleet-detector", {
    async start(signal) {
      try {
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }
      } finally {
        idleFleetDetector.stop();
      }
    },
  });

  const stallGuardCycle = createStallGuardCycle({
    onAmbiguous: (message) => bb.log.warn(message),
    readRoleHolders: () => (db ? readRoleHolderStates(db) : []),
    readArtifact: async (projectId) => {
      if (!db) return null;
      const artifacts = [];
      for (const holder of readRoleHolderStates(db).filter((candidate) => candidate.project_id === projectId)) {
        try {
          const thread = await bb.sdk.threads.get({ threadId: holder.thread_id });
          if (thread.projectId !== projectId || !thread.environmentId) {
            artifacts.push({ id: holder.execution_attempt_id, unavailable: false, value: { environmentId: null, result: { outcome: "absent" } } });
            continue;
          }
          const result = await bb.sdk.environments.pullRequest({ environmentId: thread.environmentId });
          artifacts.push(result.outcome === "unavailable"
            ? { id: holder.execution_attempt_id, unavailable: true, value: null }
            : { id: holder.execution_attempt_id, unavailable: false, value: { environmentId: thread.environmentId, result } });
        } catch {
          artifacts.push({ id: holder.execution_attempt_id, unavailable: true, value: null });
        }
      }
      return artifacts;
    },
    readQueueHead: (projectId) => {
      if (!db) return null;
      const row = db.prepare(
        `SELECT work_item_id, resource_revision FROM work_items
         WHERE project_id = ? AND lifecycle_state IN ('proposed', 'ready')
         ORDER BY created_at_ms, work_item_id LIMIT 1`,
      ).get(projectId) as { work_item_id: string; resource_revision: number } | undefined;
      return row ? { workItemId: row.work_item_id, resourceRevision: row.resource_revision } : null;
    },
    wakeRole: async (role) => {
      const result = await steerRole(role);
      return result === true
        ? { attempted: true, delivered: true }
        : { attempted: false, delivered: false, refusal: result === "error" ? "error" : "policy" };
    },
    persistence: {
      read: () => bb.storage.kv.get<unknown>(STALL_GUARD_KV_KEY),
      write: (state) => bb.storage.kv.set(STALL_GUARD_KV_KEY, state),
    },
  });

  const observe = (payload: Parameters<typeof threadEventStatus>[0]) => {
    const { id, status } = threadEventStatus(payload);
    return watcher.observe(id, status);
  };
  const observeCapacityAfter = async (payload: Parameters<typeof threadEventStatus>[0]) => {
    await observe(payload);
    if (payload.thread.parentThreadId != null) await idleFleetDetector.observeCapacity(payload.thread.projectId);
  };
  bb.events.on("thread.active", async (payload) => {
    await observeCapacityAfter(payload).catch((error) => bb.log.warn(`lane observation failed: ${String(error)}`));
  });
  bb.events.on("thread.idle", async (payload) => {
    idleFleetDetector.arm({ projectId: payload.thread.projectId, threadId: payload.thread.id, idleEpisode: String(payload.thread.updatedAt) });
    await observeCapacityAfter(payload).catch((error) => bb.log.warn(`lane observation failed: ${String(error)}`));
  });
  bb.events.on("thread.failed", async (payload) => {
    await observeCapacityAfter(payload).catch((error) => bb.log.warn(`lane observation failed: ${String(error)}`));
    const { id, status } = threadEventStatus(payload);
    if (status === "error") {
      const identity = resolveRecoveryIdentity(payload.thread.projectId, id);
      if (identity === null) return;
      if (identity.holder === undefined && identity.lane === undefined) {
        bb.log.warn(`error-recovery wake refused: project=${payload.thread.projectId} thread=${id} reason=identity-unresolved`);
        return;
      }
      await recoverErroredThread(id, payload.thread.projectId, identity.holder, identity.lane);
    }
  });
  bb.events.on("thread.archived", async (payload) => {
    await (async () => {
      await watcher.observe(payload.thread.id, payload.thread.status, false, true);
      if (payload.thread.parentThreadId != null) await idleFleetDetector.observeCapacity(payload.thread.projectId);
    })().catch((error) => bb.log.warn(`lane observation failed: ${String(error)}`));
  });
  bb.events.on("thread.deleted", async (payload) => {
    await (async () => {
      await watcher.observe(payload.thread.id, payload.thread.status, false, true);
      if (payload.thread.parentThreadId != null) await idleFleetDetector.observeCapacity(payload.thread.projectId);
    })().catch((error) => bb.log.warn(`lane observation failed: ${String(error)}`));
  });
  const unsubscribe = subscribeToThreadChanges(bb.sdk, async (threadId, status, archived = false, projectId, parentThreadId) => {
    await watcher.observe(threadId, status, undefined, archived);
    if (projectId && parentThreadId != null) await idleFleetDetector.observeCapacity(projectId);
  });
  bb.onDispose(unsubscribe);
  bb.background.service("lane-watcher", {
    async start(signal) {
      void idleFleetDetector.rearm();
      void reconcileErrorRecovery().catch((error) => bb.log.warn(`error-recovery reconcile failed: ${String(error)}`));
      while (!signal.aborted) {
        await watcher.poll(signal).catch((error) => bb.log.warn(`lane poll failed: ${String(error)}`));
        if (signal.aborted) break;
        await escalationCycle.cycle().catch((error) => bb.log.warn(`wait escalation failed: ${String(error)}`));
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          timer = setTimeout(done, 1_000);
          signal.addEventListener("abort", done, { once: true });
        });
      }
    },
  });

  // The self-watch, once: launchd KeepAlive restarts the host-supervised
  // validator loop on death; this schedule is the trivial second check. It
  // alerts the operator exactly once when the liveness marker that loop
  // refreshes every cycle goes stale — meaning launchd itself failed, which
  // is operator territory. A missing marker is never launchd-failure
  // evidence (the agent may not be deployed), so it stays silent.
  bb.background.schedule("wait-validator-liveness", "1-59/5 * * * *", async () => {
    try {
      const stateDir = waitValidatorStateDir();
      const markerPath = join(stateDir, LIVENESS_MARKER_FILENAME);
      const flagPath = join(stateDir, LIVENESS_ALERT_FLAG_FILENAME);
      let markerAtMs: number | null = null;
      try {
        const parsed = Number(readFileSync(markerPath, "utf8").trim());
        markerAtMs = Number.isFinite(parsed) && parsed > 0 ? parsed : statSync(markerPath).mtimeMs;
      } catch {
        markerAtMs = null;
      }
      const configuredStaleMs = Number(process.env.BB_COLLAB_LIVENESS_STALE_MS);
      const staleMs = Number.isFinite(configuredStaleMs) && configuredStaleMs > 0 ? configuredStaleMs : LIVENESS_STALE_MS;
      const decision = livenessDecision(livenessState(markerAtMs, Date.now(), staleMs), existsSync(flagPath));
      if (decision === "clear-alert-flag") rmSync(flagPath, { force: true });
      if (decision === "alert-once") {
        mkdirSync(stateDir, { recursive: true });
        // O_EXCL claim: concurrent checkers cannot both win the one alert.
        try {
          writeFileSync(flagPath, String(Date.now()), { flag: "wx" });
        } catch {
          bb.log.info("wait-validator-liveness healthy cycle");
          return; // another checker already claimed this episode's single alert
        }
        bb.log.error("wait-validator liveness marker is stale: host launchd supervision failed; operator attention required");
        bb.realtime.publish("wait-validator", { liveness: "stale", alert: "operator-once" });
      }
      bb.log.info("wait-validator-liveness healthy cycle");
    } catch (error) {
      bb.log.warn(`wait-validator liveness check failed: ${String(error)}`);
    }
  });

  bb.background.schedule("stall-guard-liveness", "2-59/5 * * * *", async () => {
    try {
      const stateDir = stallGuardStateDir();
      const markerPath = join(stateDir, STALL_GUARD_LIVENESS_MARKER_FILENAME);
      const flagPath = join(stateDir, STALL_GUARD_LIVENESS_ALERT_FLAG_FILENAME);
      let markerAtMs: number | null = null;
      try {
        const parsed = Number(readFileSync(markerPath, "utf8").trim());
        markerAtMs = Number.isFinite(parsed) && parsed > 0 ? parsed : statSync(markerPath).mtimeMs;
      } catch {
        markerAtMs = null;
      }
      const configuredStaleMs = Number(process.env.BB_COLLAB_STALL_GUARD_LIVENESS_STALE_MS);
      const staleMs = Number.isFinite(configuredStaleMs) && configuredStaleMs > 0 ? configuredStaleMs : LIVENESS_STALE_MS;
      const decision = livenessDecision(livenessState(markerAtMs, Date.now(), staleMs), existsSync(flagPath));
      if (decision === "clear-alert-flag") rmSync(flagPath, { force: true });
      if (decision === "alert-once") {
        mkdirSync(stateDir, { recursive: true });
        try {
          writeFileSync(flagPath, String(Date.now()), { flag: "wx" });
        } catch {
          bb.log.info("stall-guard-liveness healthy cycle");
          return;
        }
        bb.log.error("stall-guard liveness marker is stale: host launchd supervision failed; operator attention required");
        bb.realtime.publish("stall-guard", { liveness: "stale", alert: "operator-once" });
      }
      bb.log.info("stall-guard-liveness healthy cycle");
    } catch (error) {
      bb.log.warn(`stall-guard liveness check failed: ${String(error)}`);
    }
  });

  const wakeInFlight = new Set<string>();
  const permanentlyRefusedReopens = new Map<string, string>();
  const pendingRefusedReopens = new Map<string, string>();
  // This model-free detector covers threads with obligations in canonical and platform state.
  // Acts named only in prose are outside mechanical coverage because identifying whether they
  // have an executing surface would require interpreting prose.
  const fleetWatchdogCycle = async (onlyProjectId?: string) => {
    let coverage: "visible" | "degraded" | "blind" = "blind";
    let visibleSeatCount = 0;
    let visibleLaneCount = 0;
    const cannotSee = new Set<string>();
    const degrade = (scope: string) => {
      cannotSee.add(scope);
      if (coverage === "visible") coverage = "degraded";
    };
    try {
      if (!db) {
        cannotSee.add("canonical-store:unavailable");
        return;
      }
      await ensureFleetWatchdogFloorMigrated();
      const now = Date.now();
      const { fleetWatchdogFloorMs, fleetWatchdogStaleWaitMs } = await fleetWatchdogSettings.get();
      const floorMs = Number(fleetWatchdogFloorMs);
      const staleWaitMs = Number(fleetWatchdogStaleWaitMs);
      if (!Number.isSafeInteger(floorMs) || floorMs <= 0 || !Number.isSafeInteger(staleWaitMs) || staleWaitMs <= 0) {
        throw new Error("watchdog thresholds must be positive integer milliseconds");
      }
      let roleHolders: RoleHolderState[];
      try {
        roleHolders = readRoleHolderStates(db);
        coverage = "visible";
        visibleSeatCount = roleHolders.length;
      } catch (error) {
        cannotSee.add(`canonical-role-holders:${String(error)}`);
        return;
      }
      const holdersByProject = new Map<string, RoleHolderState[]>();
      for (const holder of roleHolders) {
        const holders = holdersByProject.get(holder.project_id) ?? [];
        holders.push(holder);
        holdersByProject.set(holder.project_id, holders);
      }
      const dispatcherThreadIdsByProject = new Map<string, Set<string>>();
      for (const row of db.prepare(
        "SELECT project_id, thread_id FROM execution_attempts WHERE origin = 'role_holder' AND thread_id IS NOT NULL",
      ).all() as Array<{ project_id: string; thread_id: string }>) {
        const threadIds = dispatcherThreadIdsByProject.get(row.project_id) ?? new Set<string>();
        threadIds.add(row.thread_id);
        dispatcherThreadIdsByProject.set(row.project_id, threadIds);
      }
      const projectIds = new Set([...holdersByProject.keys(), ...dispatcherThreadIdsByProject.keys()]);
      for (const row of db.prepare(
        `SELECT DISTINCT work_items.project_id FROM work_items JOIN external_work_refs
           ON external_work_refs.project_id = work_items.project_id
          AND external_work_refs.work_item_id = work_items.work_item_id
          AND external_work_refs.provider = 'github'
         WHERE work_items.lifecycle_state IN (${[...WORK_ITEM_NON_TERMINAL_STATES, "succeeded"].map(() => "?").join(", ")})
           AND external_work_refs.issue_number IS NOT NULL`,
      ).all(...WORK_ITEM_NON_TERMINAL_STATES, "succeeded") as Array<{ project_id: string }>) projectIds.add(row.project_id);
      const lanesByProject = new Map<string, Awaited<ReturnType<typeof bb.sdk.threads.list>>>();
      const dispatchWedgesByProject = new Map<string, Array<{ executionAttemptId: string; workItemId: string }>>();
      for (const projectId of projectIds) {
        if (onlyProjectId !== undefined && projectId !== onlyProjectId) continue;
        const dispatcherThreadIds = dispatcherThreadIdsByProject.get(projectId) ?? new Set<string>();
        const threads: Awaited<ReturnType<typeof bb.sdk.threads.list>> = [];
        let threadInventoryReadable = true;
        try {
          for (let offset = 0; ; offset += 100) {
            const page = await bb.sdk.threads.list({ projectId, hasParent: true, includeHidden: true, archived: false, limit: 100, offset });
            threads.push(...page);
            if (page.length < 100) break;
          }
        } catch (error) {
          threadInventoryReadable = false;
          degrade(fleetWatchdogScope("platform-parentage", projectId, String(error)));
        }
        if (threadInventoryReadable) {
          const wedges = reconcilePreparedWorkItemDispatches(db, projectId, threads);
          if (wedges.length > 0) {
            dispatchWedgesByProject.set(projectId, wedges);
            bb.log.warn(`fleet-watchdog dispatch wedge: project=${projectId} workItems=${wedges.map(({ workItemId }) => workItemId).join(",")}`);
          }
        }
        const lanes = threads.filter((thread) =>
          thread.parentThreadId !== null &&
          dispatcherThreadIds.has(thread.parentThreadId) &&
          thread.archivedAt === null &&
          thread.deletedAt === null,
        );
        visibleLaneCount += lanes.length;
        lanesByProject.set(projectId, lanes);
      }
      const openWorkItemsByProject = new Map<string, Array<{ workItemId: string; lifecycleState: string; waker: string | null; wakerKind: "schedule" | "seat" | "work_item_succeeded" | "github_issue_closed" | null; declaredAtMs: number | null }>>();
      const externalRevisions = new Map<string, LinkedGithubObservation>();
      const waitExternalRevisions = new Map<string, LinkedGithubObservation>();
      const waitExternalKey = (owner: string, repo: string, issueNumber: number) => `${owner}\u0000${repo}\u0000${issueNumber}`;
      for (const workItem of db.prepare(
        `SELECT work_items.project_id, work_items.work_item_id, work_items.lifecycle_state, work_item_waits.waker, work_item_waits.waker_kind, work_item_waits.declared_at_ms
         FROM work_items LEFT JOIN work_item_waits
           ON work_item_waits.project_id = work_items.project_id AND work_item_waits.work_item_id = work_items.work_item_id
         WHERE work_items.lifecycle_state IN (${WORK_ITEM_NON_TERMINAL_STATES.map(() => "?").join(", ")})
         ORDER BY work_items.created_at_ms, work_items.work_item_id`,
      ).all(...WORK_ITEM_NON_TERMINAL_STATES) as Array<{ project_id: string; work_item_id: string; lifecycle_state: string; waker: string | null; waker_kind: "schedule" | "seat" | "work_item_succeeded" | "github_issue_closed" | null; declared_at_ms: number | null }>) {
        const workItems = openWorkItemsByProject.get(workItem.project_id) ?? [];
        workItems.push({ workItemId: workItem.work_item_id, lifecycleState: workItem.lifecycle_state, waker: workItem.waker, wakerKind: workItem.waker_kind, declaredAtMs: workItem.declared_at_ms });
        openWorkItemsByProject.set(workItem.project_id, workItems);
      }
      const isCurrent = (candidate: RoleHolderState, holder: RoleHolderState) => candidate.role_generation === holder.role_generation && candidate.execution_attempt_id === holder.execution_attempt_id && candidate.thread_id === holder.thread_id;
      // 0.39.0 removed the rateLimitRecovery point query; provider/rateLimits/updated events
      // replace it. Those events are persisted in the durable thread event log, so the newest
      // one IS the cache -- there is no listener to attach or detach, and nothing to re-arm
      // after a daemon restart, because the log outlives the daemon that wrote it.
      const isUsageCapped = async (threadId: string): Promise<"capped" | "not-capped" | "unobserved" | "unreadable"> => {
        let latest;
        try {
          [latest] = await bb.sdk.threads.events.list({ threadId, types: ["provider/rateLimits/updated"], order: "desc", limit: "1" });
        } catch (error) {
          degrade(fleetWatchdogScope("platform-rate-limit", threadId, String(error)));
          return "unreadable";
        }
        const rateLimits = latest?.type === "provider/rateLimits/updated" ? latest.data.rateLimits : undefined;
        // The schema's status is a four-value enum, and the provider's own "unknown" is an
        // absent cap signal exactly like a missing event -- not a negative. Both answer
        // "unobserved" so neither can reach a caller without also reaching the record.
        if (rateLimits === undefined || rateLimits.status === "unknown") {
          degrade(fleetWatchdogScope("platform-rate-limit", threadId, rateLimits === undefined ? "no-rate-limit-event-observed" : "provider-reports-unknown-rate-limit-state"));
          return "unobserved";
        }
        if (rateLimits.status !== "blocked" || rateLimits.kind !== "subscription-window") return "not-capped";
        // The provider emits nothing until the thread runs again, so a block we keep honouring
        // past its reset would idle the thread forever waiting for an event that our own
        // refusal to wake it prevents. Lift only on positive evidence that every blocked
        // window has already reset.
        const blocked = rateLimits.windows.filter((window) => window.status === "blocked");
        const resetsAtMs = blocked.flatMap((window) => window.resetsAtMs ?? []);
        // A block with no dated window can never lift on its own: the reset that would clear
        // it arrives on an event only the thread's next turn produces, and this hold is why
        // there is no next turn. Keep honouring it -- lifting would wake a genuinely blocked
        // seat every tick against a provider already refusing us -- but record the unbounded
        // hold so it is distinguishable from a seat correctly waiting out a dated cap.
        if (blocked.length === 0 || resetsAtMs.length !== blocked.length) {
          degrade(fleetWatchdogScope("platform-rate-limit", threadId, "blocked-without-a-reset-time"));
          return "capped";
        }
        return resetsAtMs.every((resets) => resets <= now) ? "not-capped" : "capped";
      };
      const lastEvent = async (threadId: string) => {
        let latest: Awaited<ReturnType<typeof bb.sdk.threads.events.list>>[number] | undefined;
        try {
          for (let afterSeq: string | undefined; ;) {
            const page = await bb.sdk.threads.events.list({ threadId, ...(afterSeq ? { afterSeq } : {}), limit: "1000" });
            if (page.length === 0) break;
            latest = page.at(-1);
            if (page.length < 1000) break;
            afterSeq = String(latest!.seq);
          }
        } catch (error) {
          degrade(fleetWatchdogScope("platform-events", threadId, String(error)));
        }
        return latest ? `${latest.type}@${latest.seq}` : "unknown";
      };
      const wake = async (projectId: string, holder: RoleHolderState, key: string, text: string, requireIdle: boolean, kind: "fleet" | "recovery" | "startable-queue" | "stale-wait" | "owed-act" | "escalation", beforeSend?: () => Promise<boolean>, staleWaitExternalRevision: string | null = null, staleWaitWaker: string | null = null, bypassNotificationFloor = false) => {
        const previous = await fleetWatchdogIdle.get(key);
        const lastNotifiedAtMs = kind === "fleet" ? previous?.lastFleetWakeAtMs
          : kind === "recovery" ? previous?.lastRecoveryWakeAtMs
            : kind === "startable-queue" ? previous?.lastStartableQueueWakeAtMs
              : kind === "stale-wait" ? previous?.lastStaleWaitWakeAtMs
                : kind === "owed-act" ? previous?.lastOwedActWakeAtMs
                  : previous?.lastEscalationAtMs;
        if (!bypassNotificationFloor && lastNotifiedAtMs !== null && lastNotifiedAtMs !== undefined && now - lastNotifiedAtMs < FLEET_WATCHDOG_NOTIFICATION_FLOOR_MS) return false;
        if (wakeInFlight.has(key)) return false;
        wakeInFlight.add(key);
        try {
          const current = readRoleHolderStates(db).filter((candidate) => candidate.project_id === projectId && candidate.role_id === holder.role_id);
          if (current.length !== 1 || !isCurrent(current[0]!, holder)) {
            if (current.length > 1) bb.log.warn(`fleet-watchdog refused: project=${projectId} active ${holder.role_id} holders=${current.length}`);
            return false;
          }
          if (kind !== "recovery" && await readPendingExternalWait(holder.thread_id)) return false;
          const thread = await bb.sdk.threads.get({ threadId: holder.thread_id });
          if (roleThreadRefusal(holder, thread, requireIdle, kind === "recovery")) return false;
          if (beforeSend && !await beforeSend()) return false;
          await bb.sdk.threads.send({
            threadId: holder.thread_id,
            mode: kind === "recovery" ? "start" : "queue-if-active",
            input: [{ type: "text", visibility: "agent-only", text, mentions: [] }],
          });
          if (kind === "fleet") await fleetWatchdogIdle.recordFleetWake(key, Date.now());
          else if (kind === "recovery") await fleetWatchdogIdle.recordRecoveryWake(key, now);
          else if (kind === "startable-queue") await fleetWatchdogIdle.recordStartableQueueWake(key, Date.now());
          else if (kind === "stale-wait") await fleetWatchdogIdle.recordStaleWaitWake(key, Date.now(), staleWaitExternalRevision, staleWaitWaker);
          else if (kind === "owed-act") await fleetWatchdogIdle.recordOwedActWake(key, Date.now());
          else await fleetWatchdogIdle.recordEscalation(key, Date.now());
          return true;
        } finally {
          wakeInFlight.delete(key);
        }
      };
      const transitionWorkItem = (
        projectId: string,
        workItemId: string,
        state: "ready" | "review_pending" | "succeeded" | "cancelled",
        idempotencyKey: string,
        extra: Pick<ApplyRequest, "workItemUnblock" | "workItemExternalEvent"> = {},
        githubSnapshot?: GitHubIssueSnapshot,
        legacyIdempotencyKey?: string,
      ): FoundationResult => {
        const actor = db.prepare(
          `SELECT receipt_id FROM actor_receipts
           WHERE project_id = ? AND actor_kind = 'plugin' AND subject_id = ? AND role_id IS NULL
             AND verification_state = 'verified'
           ORDER BY issued_at_ms DESC LIMIT 1`,
        ).get(projectId, PLUGIN_ID) as { receipt_id: string } | undefined;
        const governor = db.prepare(
          "SELECT governance_epoch, fence_token FROM project_governorship_heads WHERE project_id = ?",
        ).get(projectId) as { governance_epoch: number; fence_token: string } | undefined;
        const config = db.prepare(
          "SELECT config_revision FROM project_config_heads WHERE project_id = ?",
        ).get(projectId) as { config_revision: number } | undefined;
        const workItem = db.prepare(
          `SELECT repo_target_id, resource_revision
           FROM work_items WHERE project_id = ? AND work_item_id = ?`,
        ).get(projectId, workItemId) as { repo_target_id: string; resource_revision: number } | undefined;
        if (!actor || !governor || !config || !workItem) {
          return { outcome: "WORK_ITEM_STATE_INVALID", subject: workItemId, expected: 1, attempted: 0, verified: 0, message: "authority or work item unavailable" };
        }
        const request: ApplyRequest = {
          projectId,
          operationClass: "work_item_transition",
          idempotencyKey,
          actorReceiptId: actor.receipt_id,
          expectedConfigRevision: config.config_revision,
          expectedGovernanceEpoch: governor.governance_epoch,
          expectedFenceToken: governor.fence_token,
          repoTargetId: workItem.repo_target_id,
          expectedResourceRevision: workItem.resource_revision,
          workItemId,
          lifecycleState: state,
          ...extra,
        };
        const compatibleKey = legacyIdempotencyKey !== undefined && db.prepare(
          "SELECT 1 FROM mutation_receipts WHERE project_id = ? AND idempotency_key = ? AND request_digest = ?",
        ).get(projectId, legacyIdempotencyKey, mutationRequestDigest({ ...request, idempotencyKey: legacyIdempotencyKey })) !== undefined
          ? legacyIdempotencyKey
          : idempotencyKey;
        return applyAuthorizedMutation(db, { ...request, idempotencyKey: compatibleKey }, null, null, null, null, githubSnapshot ? () => githubSnapshot : readGithubIssueForBackfill);
      };
      const inspectWaitTargets = async (projectId: string) => {
        for (const workItem of openWorkItemsByProject.get(projectId) ?? []) {
          if (workItem.wakerKind !== "github_issue_closed" || workItem.waker === null) continue;
          const match = workItem.waker.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/u);
          const issueNumber = match?.[3] === undefined ? NaN : Number(match[3]);
          if (!match?.[1] || !match[2] || !Number.isSafeInteger(issueNumber)) {
            degrade(`github-wait-target:${projectId}:${workItem.workItemId}`);
            continue;
          }
          const key = waitExternalKey(match[1], match[2], issueNumber);
          if (waitExternalRevisions.has(key)) continue;
          const observation = await linkedGithubObservationAsync(match[1], match[2], issueNumber);
          if (observation === null) degrade(`github-wait-target:${projectId}:${workItem.workItemId}`);
          else waitExternalRevisions.set(key, observation);
        }
      };
      const inspectLinkedWorkItems = async (projectId: string) => {
        // The handoff gate owns canonical ledger/attempt drift; this existing watchdog owns
        // external terminal drift. The active writer indexes remain the duplicate-claim detector.
        const linkedWorkItems = db.prepare(
          `SELECT work_items.work_item_id, work_items.lifecycle_state, external_work_refs.owner, external_work_refs.repo, external_work_refs.issue_number
           FROM work_items JOIN external_work_refs
             ON external_work_refs.project_id = work_items.project_id
            AND external_work_refs.work_item_id = work_items.work_item_id
            AND external_work_refs.provider = 'github'
           WHERE work_items.project_id = ?
             AND work_items.lifecycle_state IN (${[...WORK_ITEM_NON_TERMINAL_STATES, "succeeded"].map(() => "?").join(", ")})
             AND external_work_refs.issue_number IS NOT NULL
           ORDER BY work_items.work_item_id`,
        ).all(projectId, ...WORK_ITEM_NON_TERMINAL_STATES, "succeeded") as Array<{ work_item_id: string; lifecycle_state: string; owner: string; repo: string; issue_number: number }>;
        for (const linked of linkedWorkItems) {
          const observation = await linkedGithubObservationAsync(linked.owner, linked.repo, linked.issue_number);
          if (observation === null) {
            degrade(fleetWatchdogScope("github-work-item-status", projectId, linked.work_item_id));
            continue;
          }
          externalRevisions.set(`${projectId}\u0000${linked.work_item_id}`, observation);
          if (linked.lifecycle_state === "succeeded") {
            if (!observation.issueOpen) continue;
            const permanentReopenKey = fleetWatchdogReopenKey(projectId, linked.work_item_id);
            const pendingReopenKey = fleetWatchdogReopenKey(projectId, linked.work_item_id, observation.externalRevision);
            const permanentRefusalReason = permanentlyRefusedReopens.get(permanentReopenKey);
            const pendingRefusalReason = pendingRefusedReopens.get(pendingReopenKey);
            const refusalReason = permanentRefusalReason ?? pendingRefusalReason;
            if (refusalReason !== undefined) {
              bb.log.info(`fleet-watchdog skipped ${permanentRefusalReason === undefined ? "pending" : "permanently-refused"} issue-reopen transition: project=${projectId} workItem=${linked.work_item_id} reason=${refusalReason}`);
              continue;
            }
            let githubSnapshot: GitHubIssueSnapshot;
            try {
              githubSnapshot = await readGithubIssueForBackfillAsync(linked.owner, linked.repo, linked.issue_number);
            } catch {
              degrade(fleetWatchdogScope("github-work-item-reopen", projectId, linked.work_item_id));
              continue;
            }
            const result = transitionWorkItem(
              projectId,
              linked.work_item_id,
              "ready",
              fleetWatchdogIssueReopenedKey(linked.work_item_id, observation.externalRevision),
              { workItemExternalEvent: { kind: "github_issue_reopened", owner: linked.owner, repo: linked.repo, issueNumber: linked.issue_number } },
              githubSnapshot,
              fleetWatchdogLegacyIssueReopenedKey(linked.work_item_id, observation.externalRevision),
            );
            if (result.outcome === "OK") {
              bb.log.info(`fleet-watchdog returned succeeded work item to ready: project=${projectId} workItem=${linked.work_item_id} externalRevision=${observation.externalRevision}`);
            } else if (result.outcome === "WORK_ITEM_STATE_INVALID" && (result.structurallyImpossibleAtRevision === true || result.message?.includes("GitHub reopen does not follow the exact recorded close observation"))) {
              const refusalReason = result.message ?? "unknown";
              if (result.structurallyImpossibleAtRevision === true) {
                permanentlyRefusedReopens.set(permanentReopenKey, refusalReason);
                bb.log.warn(`fleet-watchdog learned permanently-refused issue-reopen transition: project=${projectId} workItem=${linked.work_item_id} reason=${refusalReason}`);
              } else if (observation.externalRevision === githubSnapshot.externalRevision) {
                pendingRefusedReopens.set(pendingReopenKey, refusalReason);
                bb.log.warn(`fleet-watchdog learned pending issue-reopen refusal: project=${projectId} workItem=${linked.work_item_id} reason=${refusalReason}`);
              } else {
                bb.log.warn(`fleet-watchdog did not learn issue-reopen refusal because GitHub revisions disagreed: project=${projectId} workItem=${linked.work_item_id} observationRevision=${observation.externalRevision} snapshotRevision=${githubSnapshot.externalRevision} reason=${refusalReason}`);
              }
            } else {
              degrade(fleetWatchdogScope("github-work-item-reopen", projectId, linked.work_item_id));
              bb.log.warn(`fleet-watchdog issue-reopen transition refused: project=${projectId} workItem=${linked.work_item_id} outcome=${result.outcome} message=${result.message ?? "unknown"}`);
            }
            continue;
          }
          if (linked.lifecycle_state === "blocked") continue;
          if (observation.status !== "open") {
            bb.log.warn(`fleet-watchdog stale-terminal work item: project=${projectId} workItem=${linked.work_item_id} linked=${linked.owner}/${linked.repo}#${linked.issue_number} status=${observation.status}`);
          }
          if (!observation.pullRequestMerged || !observation.issueClosed) continue;
          const workItem = db.prepare(
            `SELECT resource_revision, lifecycle_state
             FROM work_items WHERE project_id = ? AND work_item_id = ?`,
          ).get(projectId, linked.work_item_id) as { resource_revision: number; lifecycle_state: string } | undefined;
          if (!workItem) {
            degrade(fleetWatchdogScope("github-work-item-terminalize", projectId, linked.work_item_id));
            bb.log.warn(`fleet-watchdog merge-close transition refused: project=${projectId} workItem=${linked.work_item_id} reason=authority-or-work-item-unavailable`);
            continue;
          }
          let githubSnapshot: GitHubIssueSnapshot;
          try {
            githubSnapshot = await readGithubIssueForBackfillAsync(linked.owner, linked.repo, linked.issue_number);
          } catch {
            degrade(fleetWatchdogScope("github-work-item-terminalize", projectId, linked.work_item_id));
            continue;
          }
          const transition = (state: "review_pending" | "succeeded" | "cancelled") => transitionWorkItem(
            projectId,
            linked.work_item_id,
            state,
            fleetWatchdogMergeCloseKey(linked.work_item_id, state, githubSnapshot.externalRevision),
            state === "succeeded" || (state === "cancelled" && workItem.lifecycle_state === "proposed")
              ? { workItemExternalEvent: { kind: "github_issue_closed", owner: linked.owner, repo: linked.repo, issueNumber: linked.issue_number } }
              : {},
            githubSnapshot,
            fleetWatchdogLegacyMergeCloseKey(linked.work_item_id, state, githubSnapshot.externalRevision),
          );
          let result: FoundationResult;
          if (workItem.lifecycle_state === "in_progress") {
            result = transition("review_pending");
            if (result.outcome === "OK") {
              const current = db.prepare(
                "SELECT resource_revision, lifecycle_state FROM work_items WHERE project_id = ? AND work_item_id = ?",
              ).get(projectId, linked.work_item_id) as { resource_revision: number; lifecycle_state: string } | undefined;
              result = current?.lifecycle_state === "review_pending"
                ? transition("succeeded")
                : {
                  outcome: "WORK_ITEM_REVISION_STALE",
                  subject: linked.work_item_id,
                  expected: 1,
                  attempted: 1,
                  verified: 0,
                  message: "work item changed before merge-close terminalization",
                };
            }
          } else if (workItem.lifecycle_state === "review_pending") {
            result = transition("succeeded");
          } else if (workItem.lifecycle_state === "proposed") {
            // A closed issue absorbs work that never started; it did not succeed.
            result = transition("cancelled");
          } else {
            result = { outcome: "WORK_ITEM_STATE_INVALID", subject: linked.work_item_id, expected: 1, attempted: 0, verified: 0, message: `merge-close automation requires in_progress, review_pending, or proposed, found ${workItem.lifecycle_state}` };
          }
          if (result.outcome === "OK") {
            bb.log.info(`fleet-watchdog auto-terminalized merged and closed work item: project=${projectId} workItem=${linked.work_item_id} via=${workItem.lifecycle_state === "proposed" ? "proposed-cancel" : "review_pending"}`);
          } else {
            degrade(fleetWatchdogScope("github-work-item-terminalize", projectId, linked.work_item_id));
            bb.log.warn(`fleet-watchdog merge-close transition refused: project=${projectId} workItem=${linked.work_item_id} outcome=${result.outcome} message=${result.message}`);
          }
        }
      };
      let brokenWakePath = false;
      for (const projectId of projectIds) {
        const holders = holdersByProject.get(projectId) ?? [];
        try {
          if (onlyProjectId !== undefined && projectId !== onlyProjectId) continue;
          await inspectLinkedWorkItems(projectId);
          await inspectWaitTargets(projectId);
          const directors = holders.filter((holder) => holder.role_id === "director");
          const orchestrators = holders.filter((holder) => holder.role_id === "project-orchestrator");
          if (directors.length !== 1 || orchestrators.length !== 1) {
            if (directors.length > 1) bb.log.warn(`fleet-watchdog refused: project=${projectId} active director holders=${directors.length}`);
            if (orchestrators.length > 1) bb.log.warn(`fleet-watchdog refused: project=${projectId} active project-orchestrator holders=${orchestrators.length}`);
            degrade(fleetWatchdogScope("routing", projectId, `directors=${directors.length},orchestrators=${orchestrators.length}`));
            continue;
          }
          const director = directors[0]!;
          const orchestrator = orchestrators[0]!;
          for (const holder of holders) {
            let thread = await bb.sdk.threads.get({ threadId: holder.thread_id });
            if (thread.status !== "error" && thread.status !== "stopping") continue;
            const observedStatus = thread.status;
            if (observedStatus === "error") {
              // "unobserved" is already on the degrade record and deliberately falls through to
              // recovery: never-idle outranks an absent cap signal, and skipping on it would
              // strand the thread on the one failure mode the watchdog exists to repair.
              const usageCap = await isUsageCapped(holder.thread_id);
              if (usageCap === "unreadable") continue;
              if (usageCap === "capped") {
                bb.log.info(`fleet-watchdog scheduled return: project=${projectId} role=${holder.role_id}@${holder.role_generation} status=usage-capped`);
                continue;
              }
            }
            if (observedStatus === "stopping") {
              await bb.sdk.threads.wait({ threadId: holder.thread_id, status: "idle", timeoutMs: FLEET_WATCHDOG_STOPPING_WAIT_MS }).catch(() => undefined);
              thread = await bb.sdk.threads.get({ threadId: holder.thread_id });
            }
            if (thread.status === "active" || thread.status === "starting") continue;
            brokenWakePath = true;
            const recoverySent = await wake(projectId, holder, roleIdleKey(holder, "wake-path"), `role wake path broken at cycle ${new Date(now).toISOString()}: ${holder.role_id}@${holder.role_generation} holder status=${observedStatus}; opening a fresh turn`, false, "recovery");
            bb.log.warn(`fleet-watchdog role wake path broken: project=${projectId} role=${holder.role_id}@${holder.role_generation} status=${observedStatus} recovery=${recoverySent ? "sent" : "refused"}`);
          }
          for (const lane of lanesByProject.get(projectId) ?? []) {
            if (lane.status !== "error" && lane.status !== "stopping") continue;
            const observedStatus = lane.status;
            if (observedStatus === "error") {
              const usageCap = await isUsageCapped(lane.id);
              if (usageCap === "unreadable") continue;
              if (usageCap === "capped") {
                bb.log.info(`fleet-watchdog scheduled return: project=${projectId} lane=${lane.id} status=usage-capped`);
                continue;
              }
            }
            let currentLane;
            try {
              currentLane = await bb.sdk.threads.get({ threadId: lane.id });
              if (observedStatus === "stopping") {
                await bb.sdk.threads.wait({ threadId: lane.id, status: "idle", timeoutMs: FLEET_WATCHDOG_STOPPING_WAIT_MS }).catch(() => undefined);
                currentLane = await bb.sdk.threads.get({ threadId: lane.id });
              }
            } catch (error) {
              degrade(fleetWatchdogScope("platform-lane", lane.id, String(error)));
              continue;
            }
            if (currentLane.archivedAt !== null || currentLane.deletedAt !== null) continue;
            if (currentLane.status === "active" || currentLane.status === "starting") continue;
            const dispatcher = holders.find((holder) => holder.thread_id === lane.parentThreadId);
            let recipient = dispatcher ?? director;
            if (dispatcher) {
              try {
                const dispatcherThread = await bb.sdk.threads.get({ threadId: dispatcher.thread_id });
                if (dispatcherThread.archivedAt !== null || dispatcherThread.deletedAt !== null || dispatcherThread.status === "error" || dispatcherThread.status === "stopping") recipient = director;
              } catch (error) {
                degrade(fleetWatchdogScope("platform-dispatcher", dispatcher.thread_id, String(error)));
                recipient = director;
              }
            }
            try {
              const currentRecipients = readRoleHolderStates(db).filter((candidate) =>
                candidate.project_id === projectId && candidate.role_id === recipient.role_id && isCurrent(candidate, recipient),
              );
              if (currentRecipients.length !== 1) {
                degrade(fleetWatchdogScope("dispatcher", lane.id, "stale-recipient"));
                continue;
              }
              const recipientThread = await bb.sdk.threads.get({ threadId: recipient.thread_id });
              if (recipientThread.archivedAt !== null || recipientThread.deletedAt !== null || recipientThread.status === "error" || recipientThread.status === "stopping") {
                degrade(fleetWatchdogScope("dispatcher", lane.id, "unreachable"));
                continue;
              }
              const event = await lastEvent(lane.id);
              const strandedKey = JSON.stringify(["stranded", projectId, lane.id, recipient.execution_attempt_id]);
              const previous = await fleetWatchdogIdle.get(strandedKey);
              if (previous?.lastRecoveryWakeAtMs !== null && previous?.lastRecoveryWakeAtMs !== undefined && now - previous.lastRecoveryWakeAtMs < FLEET_WATCHDOG_NOTIFICATION_FLOOR_MS) continue;
              await bb.sdk.threads.send({
                threadId: recipient.thread_id,
                mode: "queue-if-active",
                input: [{
                  type: "text",
                  visibility: "agent-only",
                  text: `stranded lane detected at cycle ${new Date(now).toISOString()}: lane=${lane.id} branch=${lane.environmentBranchName ?? "unknown"} lastEvent=${event} status=${observedStatus}. The lane was not recovered; inspect its frozen work order and decide respawn or closure.`,
                  mentions: [],
                }],
              });
              await fleetWatchdogIdle.recordRecoveryWake(strandedKey, now);
              brokenWakePath = true;
              bb.log.warn(`fleet-watchdog stranded lane surfaced: project=${projectId} lane=${lane.id} dispatcher=${recipient.role_id}@${recipient.role_generation} status=${observedStatus}`);
            } catch (error) {
              degrade(fleetWatchdogScope("dispatcher", lane.id, String(error)));
            }
          }
          const workItems = openWorkItemsByProject.get(projectId) ?? [];
          const resetIdle = () => Promise.all(holders.flatMap((holder) => workItems.map((workItem) => fleetWatchdogIdle.resetIdle(roleIdleKey(holder, workItem.workItemId)))));
          const config = db.prepare(
            `SELECT revisions.canonical_config_json
             FROM project_config_heads AS heads
             JOIN project_config_revisions AS revisions
               ON revisions.project_id = heads.project_id AND revisions.config_revision = heads.config_revision
             WHERE heads.project_id = ?`,
          ).get(projectId) as { canonical_config_json: string } | undefined;
          let writingLaneCeiling: number | null = null;
          try {
            writingLaneCeiling = config ? writingLaneCeilingFromJson(config.canonical_config_json) : null;
          } catch {
            writingLaneCeiling = null;
          }
          const capacityEvidence = workItemCapacityLaneEvidence(db, projectId);
          const activeLaneCount = capacityEvidence.lanes.length;
          const idleActiveLaneCount = capacityEvidence.lanes.filter((lane) => lane.idle_kind === "active").length;
          const blindLaneCount = capacityEvidence.lanes.filter((lane) => lane.idle_kind === "blind").length;
          if (blindLaneCount > 0) {
            bb.log.warn(`fleet-watchdog idle enforcer activeLanes=blind project=${projectId} visible=${idleActiveLaneCount} dispatchUnknown=${blindLaneCount}`);
          }
          const repositories = (db.prepare(
            `SELECT targets.remote_url FROM project_config_heads AS heads
             JOIN repository_targets AS targets
               ON targets.project_id = heads.project_id AND targets.config_revision = heads.config_revision
             WHERE heads.project_id = ? ORDER BY targets.repo_target_id`,
          ).all(projectId) as Array<{ remote_url: string | null }>).map((target) => githubRepository(target.remote_url));
          for (const wedge of dispatchWedgesByProject.get(projectId) ?? []) {
            await wake(
              projectId,
              orchestrator,
              roleIdleKey(orchestrator, `dispatch-wedge:${wedge.executionAttemptId}`),
              `dispatch identity unresolved for WorkItem ${wedge.workItemId}; its writing slot remains held. Inspect the native thread and decide recovery or closure before dispatching another lane.`,
              false,
              "owed-act",
            );
          }
          const queue = repositories.length === 0 || repositories.some((repository) => repository === null)
            ? null
            : await startableQueueStateAsync(repositories as string[]);
          if (queue !== null) {
            const intake = `startable=${queue.count} unlabelled=${queue.unlabelledCount} blocked=${queue.blockedCount} waiting-external=${queue.waitingExternalCount}`;
            bb.log.info(`fleet-watchdog intake counts: project=${projectId} ${intake}`);
            if ((queue.count > 0 || queue.unlabelledCount > 0) && writingLaneCeiling !== null && activeLaneCount < writingLaneCeiling) {
              await wake(projectId, orchestrator, roleIdleKey(orchestrator, "queue:startable"), `startable queue has ${queue.count} issue${queue.count === 1 ? "" : "s"}; ${queue.unlabelledCount} open issue${queue.unlabelledCount === 1 ? " has" : "s have"} no queue label; ${queue.blockedCount} blocked; ${queue.waitingExternalCount} waiting-external; ${activeLaneCount}/${writingLaneCeiling} writing lanes active`, false, "startable-queue");
            }
          } else {
            bb.log.warn(`fleet-watchdog intake coverage=blind project=${projectId} reason=startable-queue-unreadable`);
          }
          if (workItems.length === 0) continue;
          const unblocked = new Set<string>();
          for (const blocked of workItems.filter((workItem) => workItem.lifecycleState === "blocked")) {
            let condition: ApplyRequest["workItemUnblock"];
            let idempotencyKey: string;
            let snapshot: GitHubIssueSnapshot | undefined;
            if (blocked.wakerKind === "work_item_succeeded" && blocked.waker !== null) {
              const dependency = db.prepare(
                "SELECT lifecycle_state FROM work_items WHERE project_id = ? AND work_item_id = ?",
              ).get(projectId, blocked.waker) as { lifecycle_state: string } | undefined;
              if (dependency?.lifecycle_state !== "succeeded") continue;
              condition = { kind: "work_item_succeeded", workItemId: blocked.waker };
              idempotencyKey = fleetWatchdogBlockerFiredKey(blocked.workItemId, blocked.waker);
            } else if (blocked.wakerKind === "github_issue_closed" && blocked.waker !== null) {
              const match = blocked.waker.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/u);
              const issueNumber = match?.[3] === undefined ? NaN : Number(match[3]);
              if (!match?.[1] || !match[2] || !Number.isSafeInteger(issueNumber)) {
                degrade(fleetWatchdogScope("work-item-blocker", projectId, blocked.workItemId));
                continue;
              }
              try {
                snapshot = await readGithubIssueForBackfillAsync(match[1], match[2], issueNumber);
              } catch {
                degrade(fleetWatchdogScope("work-item-blocker", projectId, blocked.workItemId));
                continue;
              }
              if (snapshot.state !== "closed") continue;
              condition = { kind: "github_issue_closed", owner: match[1], repo: match[2], issueNumber };
              idempotencyKey = fleetWatchdogBlockerFiredKey(blocked.workItemId, snapshot.externalRevision);
            } else {
              degrade(fleetWatchdogScope("work-item-blocker", projectId, blocked.workItemId));
              continue;
            }
            const result = transitionWorkItem(projectId, blocked.workItemId, "ready", idempotencyKey, { workItemUnblock: condition }, snapshot, fleetWatchdogLegacyBlockerFiredKey(blocked.workItemId, snapshot?.externalRevision ?? blocked.waker ?? ""));
            if (result.outcome === "OK") {
              unblocked.add(blocked.workItemId);
              bb.log.info(`fleet-watchdog returned blocked work item to ready: project=${projectId} workItem=${blocked.workItemId} blocker=${blocked.wakerKind}`);
            } else {
              degrade(fleetWatchdogScope("work-item-unblock", projectId, blocked.workItemId));
              bb.log.warn(`fleet-watchdog unblock transition refused: project=${projectId} workItem=${blocked.workItemId} outcome=${result.outcome}`);
            }
          }
          const remainingWorkItems = workItems.filter((workItem) => !unblocked.has(workItem.workItemId));
          let staleWait: (typeof remainingWorkItems)[number] | undefined;
          let staleObservation: LinkedGithubObservation | undefined;
          let staleExternalMoved = false;
          for (const candidate of remainingWorkItems) {
            if (candidate.declaredAtMs === null || now - candidate.declaredAtMs < staleWaitMs) continue;
            const targetMatch = candidate.wakerKind === "github_issue_closed" ? candidate.waker?.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/u) ?? null : null;
            const targetIssueNumber = targetMatch?.[3] === undefined ? NaN : Number(targetMatch[3]);
            const observation = targetMatch?.[1] && targetMatch[2] && Number.isSafeInteger(targetIssueNumber)
              ? waitExternalRevisions.get(waitExternalKey(targetMatch[1], targetMatch[2], targetIssueNumber))
              : undefined;
            if (!observation) {
              const record = await fleetWatchdogIdle.get(roleIdleKey(orchestrator, candidate.workItemId));
              staleExternalMoved = record?.lastStaleWaitWaker !== candidate.waker;
              staleWait = candidate;
              break;
            }
            const record = await fleetWatchdogIdle.get(roleIdleKey(orchestrator, candidate.workItemId));
            const chased = record?.lastStaleWaitWakeAtMs !== null && record?.lastStaleWaitWakeAtMs !== undefined && record.lastStaleWaitWaker === candidate.waker && record.lastStaleWaitExternalRevision === observation.externalRevision;
            // now - chaseAt >= max(floor, chaseAt - externalUpdatedAt); the interval is fixed at chase time.
            const recheckMs = observation.updatedAtMs === null || !chased ? FLEET_WATCHDOG_NOTIFICATION_FLOOR_MS : Math.max(FLEET_WATCHDOG_NOTIFICATION_FLOOR_MS, record!.lastStaleWaitWakeAtMs! - observation.updatedAtMs);
            if (!chased || now - record!.lastStaleWaitWakeAtMs! >= recheckMs) {
              staleWait = candidate;
              staleObservation = observation;
              staleExternalMoved = record?.lastStaleWaitWaker !== candidate.waker || record?.lastStaleWaitExternalRevision !== observation.externalRevision;
              break;
            }
          }
          if (staleWait) {
            await wake(projectId, orchestrator, roleIdleKey(orchestrator, staleWait.workItemId), staleWait.wakerKind === "seat" ? "owed act went stale" : "wait went stale: chase the external or re-plan", false, "stale-wait", undefined, staleObservation?.externalRevision ?? null, staleWait.waker, staleExternalMoved);
            continue;
          }
          const seatWait = remainingWorkItems.find((workItem) => workItem.wakerKind === "seat" && workItem.waker !== null);
          if (seatWait) {
            const owing = holders.find((holder) => holder.role_id === seatWait.waker);
            if (!owing) continue;
            const owingKey = roleIdleKey(owing, seatWait.workItemId);
            const owingThread = await bb.sdk.threads.get({ threadId: owing.thread_id });
            if (roleThreadRefusal(owing, owingThread, true) || await readPendingExternalWait(owing.thread_id)) {
              await fleetWatchdogIdle.resetIdle(owingKey);
              continue;
            }
            const owingRecord = await fleetWatchdogIdle.observeIdle(owingKey, now);
            if (owingRecord.idleSinceMs === null || now - owingRecord.idleSinceMs < floorMs) continue;
            if (owingRecord.lastOwedActWakeAtMs === null || owingRecord.lastOwedActWakeAtMs < owingRecord.idleSinceMs) {
              await wake(projectId, owing, owingKey, `owed act quiet at cycle ${new Date(now).toISOString()} with open work since ${new Date(owingRecord.idleSinceMs).toISOString()}`, true, "owed-act");
              continue;
            }
            if (owing.role_id !== "director" && now - owingRecord.lastOwedActWakeAtMs >= FLEET_WATCHDOG_NOTIFICATION_FLOOR_MS) {
              await wake(projectId, director, roleIdleKey(director, seatWait.workItemId), `owed act still quiet at cycle ${new Date(now).toISOString()} with open work since ${new Date(owingRecord.idleSinceMs).toISOString()}`, true, "owed-act");
            }
            continue;
          }
          const openWorkItem = remainingWorkItems.find((workItem) => workItem.declaredAtMs === null);
          if (!openWorkItem) {
            await resetIdle();
            continue;
          }
          const workKey = openWorkItem.workItemId;
          const orchestratorKey = roleIdleKey(orchestrator, workKey);
          const priorOrchestratorRecord = await fleetWatchdogIdle.get(orchestratorKey);
          if (priorOrchestratorRecord?.lastFleetWakeAtMs !== null && priorOrchestratorRecord?.lastFleetWakeAtMs !== undefined && now - priorOrchestratorRecord.lastFleetWakeAtMs >= FLEET_WATCHDOG_NOTIFICATION_FLOOR_MS) {
            await wake(projectId, director, roleIdleKey(director, workKey), `fleet still quiet at cycle ${new Date(now).toISOString()} with open work since ${new Date(priorOrchestratorRecord.idleSinceMs ?? now).toISOString()}`, false, "escalation", async () => (await Promise.all(holders.map(async (holder) => {
              const thread = await bb.sdk.threads.get({ threadId: holder.thread_id });
              return !roleThreadRefusal(holder, thread, true) && !await readPendingExternalWait(holder.thread_id);
            }))).every(Boolean));
            continue;
          }
          const idle = await Promise.all(holders.map(async (holder) => {
            const thread = await bb.sdk.threads.get({ threadId: holder.thread_id });
            if (roleThreadRefusal(holder, thread, true) || await readPendingExternalWait(holder.thread_id)) {
              await fleetWatchdogIdle.resetIdle(roleIdleKey(holder, workKey));
              return false;
            }
            const record = await fleetWatchdogIdle.observeIdle(roleIdleKey(holder, workKey), now);
            return record.idleSinceMs !== null && now - record.idleSinceMs >= floorMs;
          }));
          if (!idle.every(Boolean)) continue;
          const orchestratorRecord = await fleetWatchdogIdle.get(orchestratorKey);
          if (orchestratorRecord?.lastFleetWakeAtMs === null || orchestratorRecord?.lastFleetWakeAtMs === undefined || orchestratorRecord.lastFleetWakeAtMs < (orchestratorRecord.idleSinceMs ?? now)) {
            await wake(projectId, orchestrator, orchestratorKey, `fleet quiet at cycle ${new Date(now).toISOString()} with open work since ${new Date(orchestratorRecord?.idleSinceMs ?? now).toISOString()}`, true, "fleet");
            continue;
          }
        } catch (error) {
          degrade(fleetWatchdogScope("project", projectId, String(error)));
          bb.log.warn(`fleet-watchdog failed: ${String(error)}`);
        }
      }
      if (!brokenWakePath && coverage === "visible") bb.log.info("fleet-watchdog healthy cycle");
    } catch (error) {
      degrade(fleetWatchdogScope("cycle", String(error)));
      bb.log.warn(`fleet-watchdog failed: ${String(error)}`);
    } finally {
      const message = `fleet-watchdog coverage=${coverage} seats=${visibleSeatCount} lanes=${visibleLaneCount} cannotSee=${cannotSee.size === 0 ? "none" : [...cannotSee].map(fleetWatchdogScopeMessage).join("|").replace(/\u0000/gu, ":")}`;
      if (coverage === "visible") bb.log.info(message);
      else bb.log.warn(message);
    }
  };
  const resetFleetWatchdog = async (projectId: string, invokedBy: string) => {
    await fleetWatchdogIdle.clearWakeHistory(`${projectId}:`);
    bb.log.warn(`fleet-watchdog history reset: project=${projectId} invokedBy=${invokedBy} at=${Date.now()}`);
  };
  let deployedDistCheckRunning = false;
  const checkDeployedDist = options.checkDeployedDist ?? (() => {
    if (deployedDistCheckRunning) {
      bb.log.warn("deployed-dist automatic check skipped: previous check still running");
      return;
    }
    const root = findCheckoutRoot(dirname(fileURLToPath(import.meta.url)));
    if (!root) {
      bb.log.error("deployed-dist automatic check failed: cannot find plugin checkout root");
      return;
    }
    deployedDistCheckRunning = true;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "BB_CLI"));
    execFile(process.execPath, [join(root, "scripts", "check-dist.mjs"), "--deployed"], {
      cwd: root,
      encoding: "utf8",
      env,
      timeout: 10_000,
    }, (error, stdout, stderr) => {
      deployedDistCheckRunning = false;
      if (!error) return;
      const detail = deployedDistFailureDetail(error, stdout, stderr);
      bb.log.error(`deployed-dist automatic check failed: ${detail || "child process failed"}`);
    });
  });
  // Report-only: this never rebuilds, writes, or repairs the deployed checkout.
  bb.background.schedule("fleet-watchdog", "3-59/5 * * * *", () => {
    checkDeployedDist();
    return fleetWatchdogCycle();
  });

  bb.background.schedule("worktree-cleanup", "4 * * * *", async () => {
    let projects: Awaited<ReturnType<typeof bb.sdk.projects.list>>;
    try {
      projects = await bb.sdk.projects.list({ includePersonal: true });
    } catch (error) {
      const report = { outcome: "refused", wouldRemove: [], refused: [{ path: "<inventory>", population: "unknown", action: "refuse", reason: `project inventory unavailable: ${String(error)}` }], environmentRecordsReleased: false };
      bb.log.warn(`worktree-cleanup report: ${JSON.stringify(report)}`);
      bb.realtime.publish("worktree-cleanup", report);
      return;
    }
    for (const project of projects) {
      try {
        const report = await reportProjectWorktreeCleanup(bb, project.id);
        if (report.wouldRemove.length > 0) bb.log.warn(`worktree-cleanup report: project=${project.id} ${JSON.stringify(report)}`);
        else bb.log.info(`worktree-cleanup healthy cycle: project=${project.id} refused=${report.refused.length}`);
        bb.realtime.publish("worktree-cleanup", { projectId: project.id, ...report });
      } catch (error) {
        const report = { projectId: project.id, outcome: "refused", wouldRemove: [], refused: [{ path: "<inventory>", population: "unknown", action: "refuse", reason: error instanceof Error ? error.message : String(error) }], environmentRecordsReleased: false };
        bb.log.warn(`worktree-cleanup report: project=${project.id} ${JSON.stringify(report)}`);
        bb.realtime.publish("worktree-cleanup", report);
      }
    }
  });

  // This is deliberately a report-only schedule. Archive is available only
  // through the explicit collab archive-sweep --apply command below.
  const archiveSweepRefusalCounter = createArchiveSweepRefusalCounter();
  bb.background.schedule("thread-archive-sweep", "5 * * * *", async () => {
    archiveSweepRefusalCounter.beginCycle();
    const refusalsThisCycle = new Map<string, { aggregate: ArchiveSweepRefusalAggregate; firstSighting: boolean }>();
    const refusalMessage = (aggregate: ArchiveSweepRefusalAggregate) => `${ARCHIVE_SWEEP_GUARD} coverage=degraded guard=${aggregate.guard} reason=${aggregate.reason} occurrencesSinceReload=${aggregate.occurrencesSinceReload} cyclesSinceReload=${aggregate.cyclesSinceReload} projectsSinceReload=${aggregate.projectsSinceReload} sinceReloadAt=${new Date(aggregate.sinceReloadAtMs).toISOString()}`;
    const recordRefusal = (reason: string, projectId: string | null) => {
      const aggregate = archiveSweepRefusalCounter.observe(reason, projectId);
      const firstSighting = aggregate.occurrencesSinceReload === 1;
      if (firstSighting) bb.log.warn(refusalMessage(aggregate));
      refusalsThisCycle.set(aggregate.reason, { aggregate, firstSighting });
    };
    const reportRefusals = () => {
      if (refusalsThisCycle.size === 0) {
        bb.log.info("thread-archive-sweep healthy cycle");
        return;
      }
      for (const { aggregate, firstSighting } of refusalsThisCycle.values()) {
        if (firstSighting && aggregate.occurrencesSinceReload === 1) continue;
        bb.log.warn(refusalMessage(aggregate));
      }
    };
    let projects: Awaited<ReturnType<typeof bb.sdk.projects.list>>;
    try {
      projects = await bb.sdk.projects.list({ includePersonal: true });
    } catch (error) {
      const result = { outcome: "refused" as const, message: `project inventory unavailable: ${String(error)}` };
      recordRefusal(result.message, null);
      bb.realtime.publish("thread-archive-sweep", result);
      reportRefusals();
      return;
    }
    for (const project of projects) {
      const result = await runArchiveSweep(bb, db, project.id);
      if (result.outcome === "refused") recordRefusal(result.message ?? "unknown read failure", project.id);
      else bb.log.info(`thread archive sweep reported ${result.archivableThreadIds.length} archivable threads for project=${project.id}`);
      bb.realtime.publish("thread-archive-sweep", { projectId: project.id, ...result });
    }
    reportRefusals();
  });

  const readOpenLaneViews = async () => [];

  // Lifecycle callbacks observe a completed creation; they cannot intercept a
  // spawn. An unseated thread receives its worker brief here at seating;
  // successful canonical succession separately delivers the exact seat brief.
  bb.events.on("thread.created", async ({ thread }) => {
    try {
      await sendRoleBrief(bb, db, thread.projectId, thread.id, roleForThread(db, thread.projectId, thread.id));
    } catch (error) {
      bb.log.error(`role brief seating failed for thread=${thread.id}: ${String(error)}`);
    }
  });

  bb.http.route("GET", "/lanes", async () =>
    new Response(JSON.stringify(await readOpenLaneViews()), {
      headers: { "content-type": "application/json" },
    }),
  );

  // Counts only. A sidebar glyph needs how many are waiting and on which
  // thread; it has no use for the project, candidate head, digest or
  // idempotency key those requests carry, so this surface never carries them.
  const cliDeps: WaitValidatorCliDeps = {
    watcher,
    registerBoundedWaitForCli: (input, ctxThreadId) => registerBoundedWait({
      registry: boundedRegistry,
      readSource: readThreadObservation,
      readWaker: (schedule) => liveWaker(bb, schedule),
      input,
      ctxThreadId,
    }),
    listWaitsForCli: async () => { await waitRegistry.recover(); return waitRegistry.list().map((wait) => ({ ...wait, state: waitRegistry.state(wait.waitId) })); },
    escalationCycle,
    stallGuardCycle: (projectId) => stallGuardCycle.cycle(projectId),
    fleetWatchdogCycle,
    resetFleetWatchdog,
    archiveSweep: (projectId, apply) => runArchiveSweep(bb, db, projectId, apply),
    readCheckoutDivergence: readDiagnosticDivergence,
    notifyUrgent,
  };

  bb.rpc.register(rpcContract, {
    lanes() {
      return readOpenLaneViews();
    },
    async registerWait(input) {
      if (!await liveWaker(bb, input.wakerSchedule)) throw new Error(`waker schedule ${input.wakerSchedule} is not live: declaration refused`);
      await waitRegistry.recover();
      const existing = waitRegistry.list().find((wait) => wait.waitId === input.waitId);
      if (existing) {
        if (existing.wakerSchedule === null || existing.declaredAtMs === null) throw new Error("legacy wait has no verified waker: declare a new wait");
        if (existing.waiterThreadId !== input.waiterThreadId || existing.sourceThreadId !== input.sourceThreadId || existing.sourceEvent !== input.sourceEvent || existing.deadlineAtMs !== input.deadlineAtMs || existing.wakerSchedule !== input.wakerSchedule) {
          throw new Error("waitId is already bound to a different wait");
        }
        return { ...existing, wakerSchedule: existing.wakerSchedule, declaredAtMs: existing.declaredAtMs };
      }
      const wait = { ...input, declaredAtMs: Date.now() };
      await watcher.registerWait(wait);
      return wait;
    },
    async threadStates(input) {
      const entries = await Promise.all(input.threadIds.map(async (threadId) => {
        const value = await bb.storage.kv.get<unknown>(sidebarThreadStateKey(threadId));
        const parsed = sidebarThreadStateSchema.safeParse(value);
        return parsed.success ? ([threadId, parsed.data] as const) : null;
      }));
      return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== null));
    },
    async threadModels(input) {
      const entries = await Promise.all(input.threadIds.map(async (threadId) => {
        try {
          const options = await bb.sdk.threads.defaultExecutionOptions({ threadId });
          // Model and reasoning are only ever the host's resolved facts; an
          // absent option set stays absent rather than becoming a default.
          return [threadId, options ? { model: options.model, reasoning: options.reasoningLevel } : null] as const;
        } catch {
          return [threadId, null] as const;
        }
      }));
      return Object.fromEntries(entries);
    },
    async setThreadState(input) {
      if (input.state === null) await bb.storage.kv.delete(sidebarThreadStateKey(input.threadId));
      else await bb.storage.kv.set(sidebarThreadStateKey(input.threadId), input.state);
      return { state: input.state };
    },
    async sidebarCollapseState(input) {
      const read = async (kind: "project" | "thread", ids: readonly string[]) => {
        const entries = await Promise.all(ids.map(async (id) => {
          const canonical = await bb.storage.kv.get<unknown>(sidebarCollapseKey(kind, id));
          const value = canonical === undefined ? await bb.storage.kv.get<unknown>(legacySidebarCollapseKey(kind, id)) : canonical;
          return value === true ? [id, true] as const : null;
        }));
        return Object.fromEntries(entries.filter((entry): entry is readonly [string, true] => entry !== null));
      };
      return {
        projects: await read("project", input.projectIds),
        threads: await read("thread", input.threadIds),
      };
    },
    async setSidebarCollapse(input) {
      const key = sidebarCollapseKey(input.kind, input.id);
      if (input.collapsed) await bb.storage.kv.set(key, true);
      else {
        await bb.storage.kv.set(key, false);
        await bb.storage.kv.delete(legacySidebarCollapseKey(input.kind, input.id));
      }
      return input;
    },
    async reorderPinned(input) {
      await bb.sdk.threads.reorderPinned(input);
      return { ok: true as const };
    },
    async doctor(input) {
      return doctor(db, bb.sdk, input.projectId, readDiagnosticDivergence());
    },
    async export(input) {
      return exportFoundation(db, input.projectId);
    },
    async apply(input) {
      return applyLiveAuthorizedMutation(bb, db, input);
    },
    async dispatchLane(input) {
      return dispatchLane(bb, db, input);
    },
    async cachedConsumerRollout(input) {
      return applyLiveCachedConsumerRollout(bb, db, input, cliDeps);
    },
    async roleBrief(input) {
      return composeRoleBrief(bb, db, input);
    },
    operatorMessages(input) {
      return listOperatorMessages(db, bb, input.projectId, input.recipient, input.withSenderTitles);
    },
    markOperatorMessageRead(input) {
      return markOperatorMessageRead(db, bb, input.projectId, input.messageId);
    },
    replyToOperatorMessage(input) {
      return replyToOperatorMessage(db, bb, input.projectId, input.messageId, input.text);
    },
  });

  bb.agents.registerTool({
    name: "dispatch_lane",
    description: "Dispatch one writing lane through the canonical registration seam.",
    instructions: "Use this instead of spawning a lane directly. The request projectId must match the current thread project.",
    parameters: dispatchLaneInputSchema,
    async execute(input, context) {
      if (input.request.projectId !== context.projectId) throw new Error("request projectId must exactly match the current thread project");
      return JSON.stringify(await dispatchLane(bb, db, input));
    },
  });
  bb.agents.registerTool({
    name: "send_to_operator",
    description: "Send a durable project-scoped message to the operator or supervisor without a model relay.",
    instructions: "Use this for actionable content directed to an external non-bb party. project_id must be the current thread's exact registered project.",
    parameters: sendOperatorMessageInputSchema,
    async execute(input, context) {
      if (input.project_id !== context.projectId) throw new Error("project_id must exactly match the current thread project");
      return JSON.stringify(await sendOperatorMessage(db, bb, input, context.threadId, notifyUrgent));
    },
  });
  bb.agents.configure(() => ({ tools: ["dispatch_lane", "send_to_operator"], skills: [] }));

  bb.cli.register({
    name: "collab",
    summary: "Inspect the bb-collab foundation and guarded conformance boundary",
    commands: [
      { name: "doctor", summary: "Read-only project/store conformance check", usage: "bb collab doctor --project PROJECT_ID [--json]" },
      { name: "export", summary: "Deterministic bounded foundation export", usage: "bb collab export --project PROJECT_ID" },
      {
        name: "apply",
        summary: "Explicit foundation apply",
        usage: "bb collab apply --project PROJECT_ID --request JSON",
      },
      {
        name: "dispatch-lane",
        summary: "Spawn and register one writing lane atomically through the canonical seam",
        usage: "bb collab dispatch-lane --project PROJECT_ID --request JSON --spawn JSON",
      },
      {
        name: "github-issue-backfill",
        summary: "One-shot, epoch-bounded existing GitHub issue binding",
        usage: "bb collab github-issue-backfill --project PROJECT_ID",
      },
      {
        name: "cached-consumer-rollout",
        summary: "Persist the live v22 cached-consumer rollout evidence (exact live production evidence required)",
        usage: "bb collab cached-consumer-rollout --project PROJECT_ID --request JSON",
      },
      { name: "role-list", summary: "List exact current active role bindings (read-only)", usage: "bb collab role-list --project PROJECT_ID" },
      {
        name: "wait-register",
        summary: "Register one bounded durable wait (deadline mandatory, fail closed)",
        usage: "bb collab wait-register --project PROJECT_ID --request JSON",
      },
      { name: "wait-list", summary: "List registered waits (read-only)", usage: "bb collab wait-list --project PROJECT_ID" },
      {
        name: "wait-validator",
        summary: "Run one durable wait-validator cycle (host-supervised seam)",
        usage: "bb collab wait-validator --cycle",
      },
      {
        name: "stall-guard",
        summary: "Run one succession-safe stall-guard cycle (host-supervised seam)",
        usage: "bb collab stall-guard --cycle --project PROJECT_ID",
      },
      {
        name: "fleet-watchdog",
        summary: "Run one wait-aware fleet-watchdog cycle",
        usage: "bb collab fleet-watchdog --cycle --project PROJECT_ID",
      },
      {
        name: "archive-sweep",
        summary: "Report archivable threads; --apply is explicit and opt-in",
        usage: "bb collab archive-sweep --project PROJECT_ID [--apply]",
      },
      {
        name: "worktree-cleanup",
        summary: "Report clean, origin/main-reachable scratch worktrees and refusals",
        usage: "bb collab worktree-cleanup --project PROJECT_ID",
      },
      {
        name: "send-to-operator",
        summary: "Send a durable message to an external non-bb recipient",
        usage: "bb collab send-to-operator --project PROJECT_ID --recipient operator|supervisor --severity routine|needs-decision|urgent --message TEXT",
      },
      {
        name: "inbox",
        summary: "Read or mark read in one exact registered project's operator inbox",
        usage: "bb collab inbox --project PROJECT_ID [--recipient operator|supervisor | --mark-read MESSAGE_ID]",
      },
    ],
    run(argv, context) {
      return runCli(db, bb, argv, context, cliDeps);
    },
  });

  bb.log.info(`${PLUGIN_ID} loaded for BB ${BB_VERSION_RANGE}; plugin SDK ${PLUGIN_SDK_VERSION}; canonicalStore=${db === null ? "unavailable" : "available"}`);
}
