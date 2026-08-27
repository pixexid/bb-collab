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
  migrateCanonicalStore,
  ROLE_CONTEXT_EVENT_PAGE_SIZE,
  PLUGIN_ID,
  PLUGIN_SDK_VERSION,
  assembleV22CachedConsumerRolloutEvidence,
  applyAuthorizedMutation,
  applyAuthorizedMutationAsync,
  applyRequestSchema,
  buildTerminalReport,
  checkMutationIdempotency,
  databaseIsReady,
  doctor,
  configuredDomains,
  exportFoundation,
  canonicalJson,
  githubPrSemanticDigest,
  sha256,
  mutationRequestDigest,
  isRefusal,
  probeV21NewLegacyApplyProvenanceRefusal,
  probeV21ConsumedLegacyReplay,
  parseApplyRequest,
  parseRegisterProjectRequest,
  registerProjectRequestSchema,
  refusal,
  roleContextPreflightRefusal,
  writingLaneCeilingFromJson,
  proveWorkItemDispatchConfig,
  WORK_ITEM_NON_TERMINAL_STATES,
  WORK_ITEM_CAPACITY_ATTEMPT_STATES,
  WORK_ITEM_CAPACITY_LIFECYCLE_STATES,
  workItemCapacityLaneEvidence,
  parseWorkItemDispatchIntent,
  threadlessPreparedClosurePopulation,
  threadlessPreparedReplayProbeDigest,
  reconcilePreparedWorkItemDispatches,
  type ApplyRequest,
  type AuthenticatedNativeCaller,
  type FoundationCode,
  type FoundationResult,
  type GitHubIssueAdapter,
  type GitHubIssueMutation,
  type GitHubIssueSnapshot,
  type RoleFactReader,
  type AuthoritativeHistoricalInterruption,
  type AuthoritativeTerminalEvidence,
  type ExecutionAttemptEvidenceReader,
  type SqliteDatabase,
  type WorkItemDispatchConfigProof,
} from "./src/foundation.js";
import {
  GITHUB_ISSUE_COMMENT_TAIL_LIMIT,
  assertGithubIssueBriefAnchor,
  assertGithubIssueBriefBinding,
  composeGithubIssueBrief,
  type GithubIssueBrief,
  type GithubIssueComment,
  type GithubIssueBriefProjection,
  type GithubIssueBriefSource,
} from "./src/github-issue-brief.js";
import {
  GithubPullRequestObservationError,
  observeGithubPullRequest,
  type NormalizedPullRequestObservation,
} from "./src/github-pull-request-observation-provenance.js";
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
import { canonicalWorktreePath, cleanupAttestationFromProfile, cleanupGitWorktrees, listAllProjectThreads, listGitWorktrees, withCleanupAttestationSubjects } from "./src/worktree-cleanup.js";
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
const dispatchRecoveryQueues = new Map<string, Promise<FoundationResult>>();
const GITHUB_PR_WATCH_SCHEDULE = "fleet-watchdog";
const GITHUB_PR_BACKOFF_BASE_MS = 30_000;
const GITHUB_PR_BACKOFF_MAX_MS = 5 * 60_000;

type GithubPrPendingWait = {
  projectId: string;
  workItemId: string;
  repoTargetId: string;
  resourceRevision: number;
  executionAttemptId: string;
  waitingThreadId: string;
  waitingRoleId: string;
  waitingRoleGeneration: number;
  owner: string;
  repo: string;
  prNumber: number;
  conditionKind: "pr_merged" | "pr_checks" | "pr_review_state";
  expectedHeadSha: string | null;
  wakerSchedule: string;
  deadlineAtMs: number;
  lastObservedSemanticDigest: string;
};

type GithubPrWatchGroup = {
  key: string;
  projectId: string;
  repoTargetId: string;
  owner: string;
  repo: string;
  prNumber: number;
  connectorHost: string;
  waits: GithubPrPendingWait[];
};

type GithubPrBackoff = { failures: number; retryAtMs: number };

export const githubPrWakeText = (workItemId: string, eventSequence: number): string =>
  `Canonical external wait ${workItemId} changed.\nRead canonical event ${eventSequence}, re-read the bound GitHub PR, and continue or re-arm.`;

export function normalizedGithubPrObservation(value: NormalizedPullRequestObservation): ApplyRequest["githubPrObservation"] {
  return {
    repositoryIdentity: { owner: value.repositoryIdentity.owner, repo: value.repositoryIdentity.repo },
    pullRequestNumber: value.pullRequestNumber,
    headSha: value.headSha,
    state: value.state === "open" ? "open" : "closed",
    merged: value.merged,
    checksSummary: value.checksSummary,
    reviewDecision: value.reviewDecision,
  };
}

function githubPrBackoffDelayMs(failures: number, random = Math.random): number {
  const exponent = Math.max(0, Math.min(8, failures - 1));
  const ceiling = Math.min(GITHUB_PR_BACKOFF_MAX_MS, GITHUB_PR_BACKOFF_BASE_MS * (2 ** exponent));
  return Math.max(1, Math.floor(ceiling * (0.75 + (random() * 0.5))));
}

function githubPrGroupKey(wait: Pick<GithubPrPendingWait, "projectId" | "repoTargetId" | "owner" | "repo" | "prNumber">): string {
  return JSON.stringify([wait.projectId, wait.repoTargetId, wait.owner, wait.repo, wait.prNumber]);
}

function githubPrGhPath(): string | null {
  const configured = process.env.BB_COLLAB_GH_PATH;
  if (configured !== undefined) return isAbsolute(configured) ? configured : null;
  try {
    const result = spawnSync("which", ["gh"], { encoding: "utf8", timeout: 2_000 });
    const path = result.error || result.status !== 0 ? null : result.stdout.trim();
    return path && isAbsolute(path) ? path : null;
  } catch {
    return null;
  }
}

type LaneRecoveryTarget = { project_id: string; thread_id: string; execution_attempt_id: string };

export const fleetWatchdogCompositeKey = (...parts: string[]) => JSON.stringify(parts);
export const fleetWatchdogIssueReopenedKey = (projectId: string, workItemId: string, externalRevision: string) =>
  `fleet-watchdog:issue-reopened:${fleetWatchdogCompositeKey(projectId, workItemId, externalRevision)}`;
const fleetWatchdogLegacyIssueReopenedKey = (workItemId: string, externalRevision: string) =>
  `fleet-watchdog:issue-reopened:${workItemId}:${externalRevision}`;
export const fleetWatchdogMergeCloseKey = (projectId: string, workItemId: string, state: string, externalRevision: string) =>
  `fleet-watchdog:merge-close:${fleetWatchdogCompositeKey(projectId, workItemId, state, externalRevision)}`;
export const fleetWatchdogMergeCloseMismatchKey = (projectId: string, workItemId: string, externalRevision: string, subject: string) =>
  `fleet-watchdog:merge-close-mismatch:${fleetWatchdogCompositeKey(projectId, workItemId, externalRevision, subject)}`;
const fleetWatchdogLegacyMergeCloseKey = (workItemId: string, state: string, externalRevision: string) =>
  `fleet-watchdog:merge-close:${workItemId}:${state}:${externalRevision}`;
export const fleetWatchdogBlockerFiredKey = (projectId: string, workItemId: string, subject: string) =>
  `fleet-watchdog:blocker-fired:${fleetWatchdogCompositeKey(projectId, workItemId, subject)}`;
const fleetWatchdogLegacyBlockerFiredKey = (workItemId: string, subject: string) =>
  `fleet-watchdog:blocker-fired:${workItemId}:${subject}`;
export const fleetWatchdogRoleLivenessKey = (holder: RoleHolderState) => fleetWatchdogCompositeKey(
  holder.project_id, holder.role_id, holder.domain_id ?? "default", String(holder.role_generation), holder.execution_attempt_id, holder.thread_id,
);
export const fleetWatchdogEpisodeKey = (
  holder: RoleHolderState,
  queueHead: string,
  activeLaneCount = 0,
  writingLaneCeiling = 0,
) => fleetWatchdogCompositeKey(
  holder.project_id, holder.role_id, holder.domain_id ?? "default", String(holder.role_generation), holder.execution_attempt_id, holder.thread_id,
  `activeLanes=${activeLaneCount}`, `writingLaneCeiling=${writingLaneCeiling}`, queueHead,
);
const fleetWatchdogLegacyEpisodeKey = (
  holder: RoleHolderState,
  queueHead: string,
  activeLaneCount: number,
) => activeLaneCount === 0 ? [
  holder.project_id, holder.role_id, holder.role_generation, holder.execution_attempt_id, holder.thread_id, "activeLanes=0", queueHead,
].join(":") : undefined;
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

type GithubQueueIssue = { repository: string; number: number };
type StartableQueueDomainState = { count: number; head: string | null; known: boolean; reason: string | null };
type StartableQueueState = { count: number; head: string | null; domains: Record<string, StartableQueueDomainState>; unlabelledCount: number; blockedCount: number; waitingExternalCount: number; dispatched: GithubQueueIssue[] };
export const ROLE_QUEUE_MAX_REPOSITORIES = 4;
export const ROLE_QUEUE_REFRESH_TIMEOUT_MS = 8_000;
export const ROLE_QUEUE_CACHE_MS = 20_000;
export const ROLE_QUEUE_IDLE_THRESHOLD_MS = 30_000;
export const ROLE_QUEUE_OBSERVATION_MS = 1_000;
export const FLEET_WATCHDOG_LANE_INVENTORY_TIMEOUT_MS = 1_000;

const githubConnectorHostPattern = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?::[1-9][0-9]{0,4})?$/u;
const githubRefPartPattern = /^[A-Za-z0-9_.-]+$/u;

function validGithubConnectorHost(value: unknown): value is string {
  return typeof value === "string" && githubConnectorHostPattern.test(value);
}

type GithubRepositoryMapping = { repoTargetId: string; owner: string; repo: string; connectorHost: string };

function githubRepositoryMappings(db: SqliteDatabase | null, projectId: string): GithubRepositoryMapping[] | null {
  if (!db) return null;
  const row = db.prepare(
    `SELECT revisions.canonical_config_json
     FROM project_config_heads AS heads
     JOIN project_config_revisions AS revisions
       ON revisions.project_id = heads.project_id AND revisions.config_revision = heads.config_revision
     WHERE heads.project_id = ?`,
  ).get(projectId) as { canonical_config_json?: unknown } | undefined;
  if (!row || typeof row.canonical_config_json !== "string") return null;
  try {
    const config = JSON.parse(row.canonical_config_json) as { extensions?: { bbCollab?: { githubIssues?: { repositoryMappings?: unknown } } } };
    const rawMappings = config.extensions?.bbCollab?.githubIssues?.repositoryMappings;
    if (!Array.isArray(rawMappings)) return null;
    const mappings = rawMappings.map((candidate): GithubRepositoryMapping | null => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
      const mapping = candidate as { repoTargetId?: unknown; owner?: unknown; repo?: unknown; connectorHost?: unknown };
      return typeof mapping.repoTargetId === "string" && mapping.repoTargetId.length > 0
        && typeof mapping.owner === "string" && githubRefPartPattern.test(mapping.owner)
        && typeof mapping.repo === "string" && githubRefPartPattern.test(mapping.repo)
        && validGithubConnectorHost(mapping.connectorHost)
        ? { repoTargetId: mapping.repoTargetId, owner: mapping.owner, repo: mapping.repo, connectorHost: mapping.connectorHost }
        : null;
    });
    if (mappings.some((mapping) => mapping === null)) return null;
    const result = mappings as GithubRepositoryMapping[];
    return new Set(result.map((mapping) => mapping.repoTargetId)).size === result.length ? result : null;
  } catch {
    return null;
  }
}

function githubRepositoryMappingForRepository(db: SqliteDatabase | null, projectId: string, owner: string, repo: string): GithubRepositoryMapping | null {
  const matches = githubRepositoryMappings(db, projectId)?.filter((mapping) => mapping.owner === owner && mapping.repo === repo) ?? [];
  return matches.length === 1 ? matches[0]! : null;
}

function githubRepositoryMappingForWorkItem(db: SqliteDatabase | null, projectId: string, workItemId: string, owner?: string, repo?: string): GithubRepositoryMapping | null {
  const row = db?.prepare(
    "SELECT repo_target_id FROM work_items WHERE project_id = ? AND work_item_id = ?",
  ).get(projectId, workItemId) as { repo_target_id?: unknown } | undefined;
  if (!row || typeof row.repo_target_id !== "string") return null;
  const mapping = githubRepositoryMappings(db, projectId)?.filter((candidate) => candidate.repoTargetId === row.repo_target_id) ?? [];
  if (mapping.length !== 1 || (owner !== undefined && mapping[0]!.owner !== owner) || (repo !== undefined && mapping[0]!.repo !== repo)) return null;
  return mapping[0]!;
}

function projectGithubIssueReader(db: SqliteDatabase | null, projectId: string) {
  return (owner: string, repo: string, issueNumber: number): GitHubIssueSnapshot => {
    const mapping = githubRepositoryMappingForRepository(db, projectId, owner, repo);
    if (!mapping) throw new Error("GitHub repository mapping is missing or ambiguous");
    return readGithubIssueForBackfill(owner, repo, issueNumber, mapping.connectorHost);
  };
}

function githubCommandEnvironment(connectorHost: string): NodeJS.ProcessEnv | null {
  return validGithubConnectorHost(connectorHost) ? { ...process.env, GH_HOST: connectorHost } : null;
}

function githubJson(args: string[], connectorHost: string): unknown | null {
  try {
    const env = githubCommandEnvironment(connectorHost);
    const ghPath = githubPrGhPath();
    if (!env || !ghPath) return null;
    const options: SpawnSyncOptionsWithStringEncoding & { detached: true } = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, killSignal: "SIGKILL", detached: true, env };
    const result = spawnSync(ghPath, args, options);
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

function githubJsonAsync(args: string[], connectorHost: string): Promise<unknown | null> {
  const env = githubCommandEnvironment(connectorHost);
  const ghPath = githubPrGhPath();
  if (!env || !ghPath) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(ghPath, args, { encoding: "utf8", timeout: ROLE_QUEUE_REFRESH_TIMEOUT_MS, killSignal: "SIGKILL", env }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      try { resolve(JSON.parse(stdout.trim())); } catch { resolve(null); }
    });
  });
}

export async function startableQueueStateAsync(db: SqliteDatabase | null, projectId: string, repositories: string[]): Promise<StartableQueueState | null> {
  if (repositories.length > ROLE_QUEUE_MAX_REPOSITORIES || new Set(repositories).size !== repositories.length) return null;
  const mappings = repositories.map((repository) => {
    const [owner, repo, extra] = repository.split("/");
    return owner && repo && extra === undefined ? githubRepositoryMappingForRepository(db, projectId, owner, repo) : null;
  });
  if (mappings.some((mapping) => mapping === null)) return null;
  let count = 0;
  let unlabelledCount = 0;
  let blockedCount = 0;
  let waitingExternalCount = 0;
  const heads: string[] = [];
  const domainStates: Record<string, StartableQueueDomainState> = {};
  const markDomainCoverageUnknown = (reason: string) => {
    for (const state of Object.values(domainStates)) {
      state.known = false;
      state.reason = reason;
    }
  };
  try {
    const configHead = db?.prepare("SELECT config_revision FROM project_config_heads WHERE project_id = ?").get(projectId) as { config_revision: number } | undefined;
    if (!db || !configHead) return null;
    for (const domain of configuredDomains(db, projectId, configHead.config_revision)) domainStates[domain.domainId] = { count: 0, head: null, known: true, reason: null };
  } catch {
    return null;
  }
  const dispatched: GithubQueueIssue[] = [];
  type QueueInventoryIssue = { number: number; labels: Array<{ name: string }>; [key: string]: unknown };
  const isIssue = (issue: unknown): issue is QueueInventoryIssue => Boolean(issue && typeof issue === "object" && !Array.isArray(issue)
    && typeof (issue as { number?: unknown }).number === "number" && Number.isSafeInteger((issue as { number: number }).number) && (issue as { number: number }).number > 0
    && Array.isArray((issue as { labels?: unknown }).labels)
    && (issue as { labels: unknown[] }).labels.every((label) => label && typeof label === "object" && !Array.isArray(label) && typeof (label as { name?: unknown }).name === "string"));
  const inventories = await Promise.all(repositories.map(async (repository, index) => ({
    repository,
    pages: await githubJsonAsync(["api", `repos/${repository}/issues`, "--paginate", "--slurp", "--method", "GET", "-f", "state=open", "-f", "per_page=100"], mappings[index]!.connectorHost),
  })));
  for (const { repository, pages } of inventories) {
    if (!Array.isArray(pages) || !pages.every((page, index) => Array.isArray(page) && page.length <= 100
      && (index === pages.length - 1 ? page.length < 100 : page.length === 100) && page.every(isIssue))) return null;
    const inventory = (pages as QueueInventoryIssue[][]).flat();
    if (new Set(inventory.map((issue) => issue.number)).size !== inventory.length) return null;
    const issues = inventory.filter((issue) => !("pull_request" in issue));
    if (issues.some((issue) => issue.labels.filter((label) => label.name.startsWith("queue:")).length > 1)) return null;
    const exactStartable = issues.filter((issue) => issue.labels.some((label) => label.name === "queue:startable"));
    count += exactStartable.length;
    unlabelledCount += issues.filter((issue) => !issue.labels.some((label) => label.name.startsWith("queue:"))).length;
    blockedCount += issues.filter((issue) => issue.labels.some((label) => label.name === "queue:blocked")).length;
    waitingExternalCount += issues.filter((issue) => issue.labels.some((label) => label.name === "queue:waiting-external")).length;
    dispatched.push(...issues.filter((issue) => issue.labels.filter((label) => label.name.startsWith("queue:")).every((label) => label.name === "queue:dispatched")
      && issue.labels.some((label) => label.name === "queue:dispatched")).map((issue) => ({ repository, number: issue.number })));
    const numbers = exactStartable.map((issue) => issue.number);
    if (numbers.length > 0) heads.push(`${repository}#${Math.min(...numbers)}`);
    for (const issue of exactStartable) {
      const [owner, repo] = repository.split("/");
      const matches = db.prepare(
        `SELECT items.domain_id
           FROM work_items AS items JOIN external_work_refs AS refs
             ON refs.project_id = items.project_id AND refs.work_item_id = items.work_item_id
          WHERE items.project_id = ? AND items.lifecycle_state IN ('proposed', 'ready')
            AND refs.provider = 'github' AND refs.owner = ? AND refs.repo = ? AND refs.issue_number = ?`,
      ).all(projectId, owner, repo, issue.number) as Array<{ domain_id: string | null }>;
      if (matches.length !== 1) {
        markDomainCoverageUnknown(`startable-queue-bindings:${matches.length}`);
        continue;
      }
      const domainId = matches[0]!.domain_id ?? "default";
      const state = domainStates[domainId];
      if (!state) {
        markDomainCoverageUnknown(`startable-queue-domain-unknown:${domainId}`);
        continue;
      }
      if (!state.known) continue;
      state.count += 1;
      const issueHead = `${repository}#${issue.number}`;
      if (state.head === null || issueHead < state.head) state.head = issueHead;
    }
  }
  return { count, head: heads.sort()[0] ?? null, domains: domainStates, unlabelledCount, blockedCount, waitingExternalCount, dispatched: dispatched.sort((left, right) => left.repository.localeCompare(right.repository) || left.number - right.number) };
}

function dispatchedWithoutLiveLane(
  db: SqliteDatabase,
  projectId: string,
  issues: GithubQueueIssue[],
  lanes: ReadonlyArray<{ id: string }>,
): GithubQueueIssue[] | null {
  const visibleThreadIds = new Set(lanes.map((lane) => lane.id));
  const unowned: GithubQueueIssue[] = [];
  for (const issue of issues) {
    const [owner, repo, extra] = issue.repository.split("/");
    if (!owner || !repo || extra !== undefined) return null;
    const refs = db.prepare(
      `SELECT work_item_id FROM external_work_refs
       WHERE project_id = ? AND provider = 'github' AND owner = ? AND repo = ? AND issue_number = ?`,
    ).all(projectId, owner, repo, issue.number) as Array<{ work_item_id: string }>;
    if (refs.length > 1) return null;
    if (refs.length === 0) {
      unowned.push(issue);
      continue;
    }
    const attempts = db.prepare(
      `SELECT attempts.state, attempts.thread_id FROM execution_attempts AS attempts
       JOIN work_items ON work_items.project_id = attempts.project_id AND work_items.work_item_id = attempts.work_item_id
       WHERE attempts.project_id = ? AND attempts.work_item_id = ? AND attempts.origin = 'work_item'
         AND attempts.assignment_kind IN ('write', 'review')
         AND attempts.state IN (${WORK_ITEM_CAPACITY_ATTEMPT_STATES.map(() => "?").join(", ")})
         AND work_items.lifecycle_state IN (${WORK_ITEM_NON_TERMINAL_STATES.map(() => "?").join(", ")})`,
    ).all(projectId, refs[0]!.work_item_id, ...WORK_ITEM_CAPACITY_ATTEMPT_STATES, ...WORK_ITEM_NON_TERMINAL_STATES) as Array<{ state: string; thread_id: string | null }>;
    if (attempts.some((attempt) => attempt.thread_id !== null && visibleThreadIds.has(attempt.thread_id))) continue;
    if (attempts.some((attempt) => attempt.state === "dispatch_unknown")) return null;
    unowned.push(issue);
  }
  return unowned;
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

type GithubIssueIdentity = { host: string; owner: string; repo: string; issueNumber: number };

function githubIssueIdentity(value: unknown): GithubIssueIdentity | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)$/u);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !match
      || !validGithubConnectorHost(url.host) || !githubRefPartPattern.test(match[1]!) || !githubRefPartPattern.test(match[2]!)) return null;
    const issueNumber = Number(match[3]);
    return Number.isSafeInteger(issueNumber) ? { host: url.host, owner: match[1]!, repo: match[2]!, issueNumber } : null;
  } catch {
    return null;
  }
}

function githubIssueIdentityMatches(value: unknown, owner: string, repo: string, issueNumber: number, connectorHost: string): GithubIssueIdentity | null {
  const identity = githubIssueIdentity(value);
  return identity && identity.host.toLowerCase() === connectorHost.toLowerCase()
    && identity.owner === owner && identity.repo === repo && identity.issueNumber === issueNumber ? identity : null;
}

async function linkedGithubObservationAsync(owner: string, repo: string, issueNumber: number, connectorHost: string): Promise<LinkedGithubObservation | null> {
  const issue = await githubJsonAsync(["issue", "view", String(issueNumber), "--repo", `${owner}/${repo}`, "--json", "state,stateReason,updatedAt,closedByPullRequestsReferences"], connectorHost);
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
    : await githubJsonAsync(["pr", "view", String((closingPullRequest as { number: number }).number), "--repo", `${owner}/${repo}`, "--json", "state,mergedAt"], connectorHost);
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

async function readGithubIssueForBackfillAsync(owner: string, repo: string, issueNumber: number, connectorHost: string): Promise<GitHubIssueSnapshot> {
  const value = await githubJsonAsync(["issue", "view", String(issueNumber), "--repo", `${owner}/${repo}`, "--json", "number,title,body,state,stateReason,labels,updatedAt,url"], connectorHost);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub issue lookup unavailable");
  const record = value as { number?: unknown; title?: unknown; body?: unknown; state?: unknown; stateReason?: unknown; labels?: unknown; updatedAt?: unknown; url?: unknown };
  if (typeof record.number !== "number" || !Number.isSafeInteger(record.number) || typeof record.title !== "string"
    || (record.body !== null && typeof record.body !== "string") || (record.state !== "OPEN" && record.state !== "CLOSED")
    || !validGithubStateReason(record.state, record.stateReason)
    || !Array.isArray(record.labels) || !record.labels.every((label) => label && typeof label === "object" && !Array.isArray(label) && typeof (label as { name?: unknown }).name === "string")
    || typeof record.updatedAt !== "string" || !githubIssueIdentityMatches(record.url, owner, repo, record.number, connectorHost)) throw new Error("GitHub issue response is invalid");
  const identity = githubIssueIdentity(record.url)!;
  return { owner: identity.owner, repo: identity.repo, issueNumber: identity.issueNumber, title: record.title, body: record.body ?? "", state: record.state === "OPEN" ? "open" : "closed", stateReason: record.stateReason === "" || record.stateReason === null ? undefined : record.stateReason as GithubStateReason, labels: (record.labels as Array<{ name: string }>).map((label) => label.name), externalRevision: record.updatedAt };
}

type GithubIssueBriefTarget = {
  projectId: string;
  workItemId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  stale: boolean;
  projection: GithubIssueBriefProjection;
};

type GithubIssueBriefTargetRead = GithubIssueBriefTarget | null | "invalid";

type GithubIssueBriefFreshnessEvidence = {
  expectedExternalRevision: string;
  attempts: number;
  mismatchedExternalRevisions: string[];
};

type GithubIssueBriefRead = {
  brief: GithubIssueBrief;
  source: GithubIssueBriefSource;
  freshness: GithubIssueBriefFreshnessEvidence;
};

function githubIssueBriefTarget(db: SqliteDatabase | null, projectId: string, workItemId: string): GithubIssueBriefTargetRead {
  if (!db) return null;
  const ref = db.prepare(
    `SELECT work_items.resource_revision, external_work_refs.*
     FROM external_work_refs
     JOIN work_items ON work_items.project_id = external_work_refs.project_id
       AND work_items.work_item_id = external_work_refs.work_item_id
     WHERE external_work_refs.project_id = ? AND external_work_refs.work_item_id = ? AND external_work_refs.provider = 'github'`,
  ).get(projectId, workItemId) as Record<string, unknown> | undefined;
  if (!ref) return null;
  const initialPending = ref.projection_state === "pending" && ref.issue_number !== null;
  if (typeof ref.owner !== "string" || typeof ref.repo !== "string"
    || typeof ref.issue_number !== "number" || !Number.isSafeInteger(ref.issue_number) || ref.issue_number < 1
    || typeof ref.resource_revision !== "number" || !Number.isSafeInteger(ref.resource_revision) || ref.resource_revision < 1
    || typeof ref.attempted_resource_revision !== "number" || !Number.isSafeInteger(ref.attempted_resource_revision) || ref.attempted_resource_revision < 1
    || (ref.projected_resource_revision !== null && (typeof ref.projected_resource_revision !== "number" || !Number.isSafeInteger(ref.projected_resource_revision) || ref.projected_resource_revision < 1))
    || typeof ref.desired_digest !== "string" || ref.desired_digest.length === 0
    || (ref.observed_external_digest !== null && typeof ref.observed_external_digest !== "string")
    || (ref.observed_external_revision !== null && typeof ref.observed_external_revision !== "string")
    || (ref.projection_state !== "pending" && ref.projection_state !== "current" && ref.projection_state !== "drifted" && ref.projection_state !== "delivery_ambiguous")
    || (initialPending && (ref.projected_resource_revision !== null || ref.observed_external_digest !== null || ref.observed_external_revision !== null))
    || (ref.projection_state === "current" && (ref.projected_resource_revision === null || ref.observed_external_digest === null || ref.observed_external_revision === null))
    ) {
    return "invalid";
  }
  return {
    projectId,
    workItemId,
    owner: ref.owner,
    repo: ref.repo,
    issueNumber: ref.issue_number,
    stale: ref.projection_state !== "pending" && ref.attempted_resource_revision !== ref.resource_revision,
    projection: {
      projectionState: ref.projection_state as GithubIssueBriefProjection["projectionState"],
      canonicalResourceRevision: ref.resource_revision,
      attemptedResourceRevision: ref.attempted_resource_revision,
      projectedResourceRevision: ref.projected_resource_revision,
      desiredDigest: ref.desired_digest,
      observedExternalDigest: ref.observed_external_digest,
      observedExternalRevision: ref.observed_external_revision,
    },
  };
}

function projectionIsCurrent(target: GithubIssueBriefTarget): boolean {
  const projection = target.projection;
  return projection.projectionState === "current"
    && projection.attemptedResourceRevision <= projection.canonicalResourceRevision
    && projection.canonicalResourceRevision === projection.projectedResourceRevision
    && projection.desiredDigest.length > 0
    && projection.desiredDigest === projection.observedExternalDigest
    && projection.observedExternalRevision !== null
    && projection.observedExternalRevision.length > 0;
}

function projectionIsInitialPending(target: GithubIssueBriefTarget): boolean {
  const projection = target.projection;
  return projection.projectionState === "pending"
    && projection.attemptedResourceRevision <= projection.canonicalResourceRevision
    && projection.projectedResourceRevision === null
    && projection.observedExternalDigest === null
    && projection.observedExternalRevision === null
    && projection.desiredDigest.length > 0;
}

function parseGithubIssueComments(value: unknown): GithubIssueComment[] {
  if (!Array.isArray(value) || value.length > GITHUB_ISSUE_COMMENT_TAIL_LIMIT) throw new Error("GitHub issue comments response is invalid");
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("GitHub issue comment response is invalid");
    const record = candidate as { id?: unknown; body?: unknown; updated_at?: unknown };
    if (!Number.isSafeInteger(record.id) || typeof record.body !== "string" || typeof record.updated_at !== "string") {
      throw new Error("GitHub issue comment response is invalid");
    }
    return { id: String(record.id), body: record.body, externalRevision: record.updated_at };
  }).reverse();
}

async function readGithubIssueBriefAsync(db: SqliteDatabase | null, projectId: string, workItemId: string): Promise<GithubIssueBriefRead> {
  const freshnessReadAttempts = 3;
  const freshnessReadDelayMs = 25;
  const sanitizeEvidence = (value: string): string => value
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|github_token_[A-Za-z0-9_]+)\b/gu, "[REDACTED_TOKEN]")
    .replace(/\b(bearer|token|password|secret|credential|authorization)\s*[:=]?\s+\S+/giu, "$1=[REDACTED]")
    .slice(0, 2_000) || "(none)";
  const briefFailure = (cause: string, reason: unknown, stderr = ""): Error => new Error(
    `cause=${cause}; reason=${sanitizeEvidence(String(reason))}; stderr=${sanitizeEvidence(stderr)}`,
  );
  let target: GithubIssueBriefTarget | null | "invalid";
  try {
    target = githubIssueBriefTarget(db, projectId, workItemId);
  } catch (error) {
    throw briefFailure("projection-target-read", error);
  }
  if (!target || target === "invalid" || !projectionIsCurrent(target)) {
    throw briefFailure("projection-target-not-current", "target is missing, invalid, or not current for the WorkItem revision");
  }
  const mapping = githubRepositoryMappingForRepository(db, projectId, target.owner, target.repo);
  if (!mapping) throw briefFailure("repository-mapping-unavailable", "repository mapping is missing or ambiguous");
  const readBriefJson = (args: string[], cause: string): Promise<{ value: unknown; stderr: string }> => {
    const env = githubCommandEnvironment(mapping.connectorHost);
    const ghPath = githubPrGhPath();
    if (!env || !ghPath) return Promise.reject(briefFailure(cause, "GitHub CLI path or connector host is unavailable"));
    return new Promise((resolve, reject) => {
      execFile(ghPath, args, { encoding: "utf8", timeout: ROLE_QUEUE_REFRESH_TIMEOUT_MS, killSignal: "SIGKILL", env }, (error, stdout, stderr) => {
        if (error) {
          reject(briefFailure(cause, error, stderr));
          return;
        }
        try {
          resolve({ value: JSON.parse(stdout.trim()) as unknown, stderr });
        } catch (parseError) {
          reject(briefFailure(cause, parseError, stderr));
        }
      });
    });
  };

  const readIssue = async (): Promise<GitHubIssueSnapshot> => {
    const response = await readBriefJson([
      "issue", "view", String(target.issueNumber), "--repo", `${target.owner}/${target.repo}`,
      "--json", "number,title,body,state,stateReason,labels,updatedAt,url",
    ], "issue-body-read");
    const value = response.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw briefFailure("issue-body-read", "GitHub issue response is unavailable", response.stderr);
    const record = value as { number?: unknown; title?: unknown; body?: unknown; state?: unknown; stateReason?: unknown; labels?: unknown; updatedAt?: unknown; url?: unknown };
    if (typeof record.number !== "number" || !Number.isSafeInteger(record.number) || typeof record.title !== "string"
      || (record.body !== null && typeof record.body !== "string") || (record.state !== "OPEN" && record.state !== "CLOSED")
      || !validGithubStateReason(record.state, record.stateReason)
      || !Array.isArray(record.labels) || !record.labels.every((label) => label && typeof label === "object" && !Array.isArray(label) && typeof (label as { name?: unknown }).name === "string")
      || typeof record.updatedAt !== "string" || !githubIssueIdentityMatches(record.url, target.owner, target.repo, record.number, mapping.connectorHost)) {
      throw briefFailure("issue-body-read", "GitHub issue response is invalid", response.stderr);
    }
    const identity = githubIssueIdentity(record.url)!;
    return {
      owner: identity.owner,
      repo: identity.repo,
      issueNumber: identity.issueNumber,
      title: record.title,
      body: record.body ?? "",
      state: record.state === "OPEN" ? "open" : "closed",
      stateReason: record.stateReason === "" || record.stateReason === null ? undefined : record.stateReason as GithubStateReason,
      labels: (record.labels as Array<{ name: string }>).map((label) => label.name),
      externalRevision: record.updatedAt,
    };
  };

  let issue: GitHubIssueSnapshot | null = null;
  let freshnessAttempts = 0;
  const mismatchedExternalRevisions: string[] = [];
  for (let attempt = 1; attempt <= freshnessReadAttempts; attempt += 1) {
    freshnessAttempts = attempt;
    issue = await readIssue();
    if (issue.externalRevision === target.projection.observedExternalRevision) break;
    mismatchedExternalRevisions.push(issue.externalRevision);
    if (attempt < freshnessReadAttempts) await new Promise((resolve) => setTimeout(resolve, freshnessReadDelayMs));
  }
  if (!issue || issue.externalRevision !== target.projection.observedExternalRevision) {
    throw briefFailure(
      "issue-body-freshness-mismatch",
      `expected=${target.projection.observedExternalRevision ?? "null"}; observed=${issue?.externalRevision ?? "null"}; attempts=${freshnessReadAttempts}`,
    );
  }

  let firstPage: unknown;
  let firstPageStderr = "";
  try {
    const response = await readBriefJson([
      "api",
      `repos/${target.owner}/${target.repo}/issues/${target.issueNumber}/comments?per_page=${GITHUB_ISSUE_COMMENT_TAIL_LIMIT}&page=1&sort=created&direction=desc`,
    ], "comment-tail-page-1");
    firstPage = response.value;
    firstPageStderr = response.stderr;
  } catch (error) {
    throw briefFailure("comment-tail-page-1", error);
  }
  let comments: GithubIssueComment[];
  try {
    comments = parseGithubIssueComments(firstPage);
  } catch (error) {
    throw briefFailure("comment-tail-page-1", error, firstPageStderr);
  }
  let commentsCapped = false;
  if (comments.length === GITHUB_ISSUE_COMMENT_TAIL_LIMIT) {
    let secondPage: unknown;
    let secondPageStderr = "";
    try {
      const response = await readBriefJson([
        "api",
        `repos/${target.owner}/${target.repo}/issues/${target.issueNumber}/comments?per_page=${GITHUB_ISSUE_COMMENT_TAIL_LIMIT}&page=2&sort=created&direction=desc`,
      ], "comment-tail-page-2");
      secondPage = response.value;
      secondPageStderr = response.stderr;
    } catch (error) {
      throw briefFailure("comment-tail-page-2", error);
    }
    let olderComments: GithubIssueComment[];
    try {
      olderComments = parseGithubIssueComments(secondPage);
    } catch (error) {
      throw briefFailure("comment-tail-page-2", error, secondPageStderr);
    }
    commentsCapped = olderComments.length > 0;
  }
  let currentTarget: GithubIssueBriefTargetRead;
  try {
    currentTarget = githubIssueBriefTarget(db, projectId, workItemId);
  } catch (error) {
    throw briefFailure("projection-target-reread-after-initial-read", error);
  }
  if (!currentTarget || JSON.stringify(currentTarget) !== JSON.stringify(target)) {
    throw briefFailure("projection-moved-during-composition", "the canonical projection target changed during the bounded brief read");
  }
  const source: GithubIssueBriefSource = {
    ...issue,
    projectId,
    comments,
    commentsReadComplete: true,
    commentsCapped,
    bodyCurrent: true,
    projection: target.projection,
  };
  let brief: GithubIssueBrief;
  try {
    brief = composeGithubIssueBrief(source);
  } catch (error) {
    throw briefFailure("brief-composition", error);
  }
  try {
    assertGithubIssueBriefBinding(brief, { projectId, owner: target.owner, repo: target.repo, issueNumber: target.issueNumber });
  } catch (error) {
    throw briefFailure("brief-binding", error);
  }
  return {
    brief,
    source,
    freshness: {
      expectedExternalRevision: target.projection.observedExternalRevision ?? "null",
      attempts: freshnessAttempts,
      mismatchedExternalRevisions,
    },
  };
}

function appendGithubIssueBrief(spawn: Record<string, unknown>, brief: GithubIssueBrief): Record<string, unknown> {
  if (typeof spawn.prompt === "string") return { ...spawn, prompt: `${spawn.prompt}\n\n${brief.content}` };
  if (!Array.isArray(spawn.input)) throw new Error("dispatch prompt shape is unavailable");
  return {
    ...spawn,
    input: [...spawn.input, { type: "text", visibility: "agent-only", text: brief.content, mentions: [] }],
  };
}

function appendFrozenReviewBrief(spawn: Record<string, unknown>, brief: string): Record<string, unknown> {
  if (typeof spawn.prompt === "string") return { ...spawn, prompt: `${spawn.prompt}\n\n${brief}` };
  if (!Array.isArray(spawn.input)) throw new Error("dispatch prompt shape is unavailable");
  return {
    ...spawn,
    input: [...spawn.input, { type: "text", visibility: "agent-only", text: brief, mentions: [] }],
  };
}

function dispatchInputDigest(spawn: Record<string, unknown>): string {
  return sha256(canonicalJson({ input: spawn.input ?? null, prompt: spawn.prompt ?? null }));
}

function linkedGithubObservation(owner: string, repo: string, issueNumber: number, connectorHost: string): LinkedGithubObservation | null {
  const issue = githubJson(["issue", "view", String(issueNumber), "--repo", `${owner}/${repo}`, "--json", "state,stateReason,updatedAt,closedByPullRequestsReferences"], connectorHost);
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
    : githubJson(["pr", "view", String((closingPullRequest as { number: number }).number), "--repo", `${owner}/${repo}`, "--json", "state,mergedAt"], connectorHost);
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

function readGithubIssueForBackfill(owner: string, repo: string, issueNumber: number, connectorHost?: string): GitHubIssueSnapshot {
  if (connectorHost === undefined) throw new Error("GitHub connector host is unavailable");
  const value = githubJson(["issue", "view", String(issueNumber), "--repo", `${owner}/${repo}`, "--json", "number,title,body,state,stateReason,labels,updatedAt,url"], connectorHost);
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
    || !githubIssueIdentityMatches((record as { url?: unknown }).url, owner, repo, record.number, connectorHost)
  ) throw new Error("GitHub issue response is invalid");
  const identity = githubIssueIdentity((record as { url?: unknown }).url)!;
  return {
    owner: identity.owner,
    repo: identity.repo,
    issueNumber: identity.issueNumber,
    title: record.title,
    body: record.body ?? "",
    state: record.state === "OPEN" ? "open" : "closed",
    stateReason: record.stateReason === "" || record.stateReason === null ? undefined : record.stateReason as GithubStateReason,
    labels: record.labels.map((label) => (label as { name: string }).name),
    externalRevision: record.updatedAt,
  };
}

type GithubCliAdapter = GitHubIssueAdapter & { owner: string; repo: string };

function githubCliAdapterForWorkItem(db: SqliteDatabase | null, projectId: string, workItemId: string): GithubCliAdapter | null {
  if (!db) return null;
  const mapping = githubRepositoryMappingForWorkItem(db, projectId, workItemId);
  if (!mapping) return null;
  return {
    owner: mapping.owner,
    repo: mapping.repo,
    connectorHost: mapping.connectorHost,
    available: true,
    read: (owner, repo, issueNumber) => owner === mapping.owner && repo === mapping.repo
      ? readGithubIssueForBackfill(owner, repo, issueNumber, mapping.connectorHost)
      : (() => { throw new Error("GitHub repository mapping changed"); })(),
    mutate: (input) => input.owner === mapping.owner && input.repo === mapping.repo
      ? githubCliMutation(input, mapping.connectorHost)
      : (() => { throw new Error("GitHub repository mapping changed"); })(),
    readAsync: (owner, repo, issueNumber) => owner === mapping.owner && repo === mapping.repo
      ? readGithubIssueForBackfillAsync(owner, repo, issueNumber, mapping.connectorHost)
      : Promise.reject(new Error("GitHub repository mapping changed")),
    mutateAsync: (input) => input.owner === mapping.owner && input.repo === mapping.repo
      ? githubCliMutationAsync(input, mapping.connectorHost)
      : Promise.reject(new Error("GitHub repository mapping changed")),
  };
}

function githubCliMutation(input: GitHubIssueMutation, connectorHost: string): GitHubIssueSnapshot {
  const current = input.kind === "update"
    ? readGithubIssueForBackfill(input.owner, input.repo, input.issueNumber!, connectorHost)
    : null;
  const labels = [...new Set([
    ...(current?.labels ?? []),
    ...input.addLabels,
  ].filter((label) => !input.removeLabels.includes(label)))].sort();
  const args = [
    "api",
    input.kind === "create" ? `repos/${input.owner}/${input.repo}/issues` : `repos/${input.owner}/${input.repo}/issues/${input.issueNumber}`,
    "--method", input.kind === "create" ? "POST" : "PATCH",
    "-f", `title=${input.title}`,
    "-f", `body=${input.body}`,
    "-f", `state=${input.state}`,
    ...labels.flatMap((label) => ["-f", `labels[]=${label}`]),
  ];
  if (input.state === "closed") args.push("-f", "state_reason=completed");
  const response = githubJson(args, connectorHost);
  const responseRecord = response && typeof response === "object" && !Array.isArray(response) ? response as { number?: unknown; html_url?: unknown; url?: unknown } : null;
  const responseNumber = responseRecord?.number;
  const issueNumber = input.kind === "create" ? responseNumber : input.issueNumber;
  if (typeof issueNumber !== "number" || !Number.isSafeInteger(issueNumber) || issueNumber < 1
    || !githubIssueIdentityMatches(responseRecord?.html_url ?? responseRecord?.url, input.owner, input.repo, issueNumber, connectorHost)) throw new Error("GitHub issue mutation identity was not confirmed");
  const snapshot = readGithubIssueForBackfill(input.owner, input.repo, issueNumber, connectorHost);
  if (snapshot.owner !== input.owner || snapshot.repo !== input.repo || snapshot.issueNumber !== issueNumber) throw new Error("GitHub issue mutation identity changed");
  return snapshot;
}

async function githubCliMutationAsync(input: GitHubIssueMutation, connectorHost: string): Promise<GitHubIssueSnapshot> {
  const current = input.kind === "update"
    ? await readGithubIssueForBackfillAsync(input.owner, input.repo, input.issueNumber!, connectorHost)
    : null;
  const labels = [...new Set([
    ...(current?.labels ?? []),
    ...input.addLabels,
  ].filter((label) => !input.removeLabels.includes(label)))].sort();
  const args = [
    "api",
    input.kind === "create" ? `repos/${input.owner}/${input.repo}/issues` : `repos/${input.owner}/${input.repo}/issues/${input.issueNumber}`,
    "--method", input.kind === "create" ? "POST" : "PATCH",
    "-f", `title=${input.title}`,
    "-f", `body=${input.body}`,
    "-f", `state=${input.state}`,
    ...labels.flatMap((label) => ["-f", `labels[]=${label}`]),
  ];
  if (input.state === "closed") args.push("-f", "state_reason=completed");
  const response = await githubJsonAsync(args, connectorHost);
  const responseRecord = response && typeof response === "object" && !Array.isArray(response) ? response as { number?: unknown; html_url?: unknown; url?: unknown } : null;
  const responseNumber = responseRecord?.number;
  const issueNumber = input.kind === "create" ? responseNumber : input.issueNumber;
  if (typeof issueNumber !== "number" || !Number.isSafeInteger(issueNumber) || issueNumber < 1
    || !githubIssueIdentityMatches(responseRecord?.html_url ?? responseRecord?.url, input.owner, input.repo, issueNumber, connectorHost)) throw new Error("GitHub issue mutation identity was not confirmed");
  const snapshot = await readGithubIssueForBackfillAsync(input.owner, input.repo, issueNumber, connectorHost);
  if (snapshot.owner !== input.owner || snapshot.repo !== input.repo || snapshot.issueNumber !== issueNumber) throw new Error("GitHub issue mutation identity changed");
  return snapshot;
}

export const FLEET_WATCHDOG_FLOOR_MS = 5 * 60_000;
export const FLEET_WATCHDOG_NOTIFICATION_FLOOR_MS = 60 * 60_000;
export const IDLE_FLEET_ATTEMPT_STALE_MS = 10 * 60_000;
const FLEET_WATCHDOG_LEGACY_FLOOR_MS = 60 * 60_000;
const FLEET_WATCHDOG_FLOOR_MIGRATION_KEY = "fleet-watchdog.floor-default-v2-migrated";
export const FLEET_WATCHDOG_STALE_WAIT_MS = 24 * 60 * 60_000;
const FLEET_WATCHDOG_STOPPING_WAIT_MS = 30_000;
const AUTOMATED_TELL_IDLE_WAIT_MS = 30_000;
export const ROLE_QUEUE_DECISION_BOUND_MS = ROLE_QUEUE_CACHE_MS + (2 * ROLE_QUEUE_REFRESH_TIMEOUT_MS)
  + (2 * ROLE_QUEUE_OBSERVATION_MS) + ROLE_QUEUE_IDLE_THRESHOLD_MS + AUTOMATED_TELL_IDLE_WAIT_MS;
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
    eventType: z.string().optional(),
    message: z.string().optional(),
    currentConfigRevision: z.number().int().positive().optional(),
    expectedConfigRevision: z.number().int().nonnegative().optional(),
    currentGovernanceEpoch: z.number().int().positive().optional(),
    expectedGovernanceEpoch: z.number().int().nonnegative().optional(),
    fenceMatched: z.boolean().optional(),
    epochPresent: z.boolean().optional(),
    fencePresent: z.boolean().optional(),
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
    // null means exactly an origin=work_item attempt, which has no Assignment.
    assignmentId: projectIdSchema.nullable(),
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
const registerExternalWaitInputSchema = z.object({
  request: applyRequestSchema,
}).strict();
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
  archivedAtMs: z.number().int().nonnegative().nullable(),
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
const threadlessPreparedClosureInputSchema = z.object({
  request: applyRequestSchema,
  correctionId: z.string().trim().min(1).max(256),
  dispatchIntentIdempotencyKey: z.string().trim().min(1).max(256),
  replayRequestDigest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
}).strict();
const strandedExecutionAttemptClosureRequestSchema = z.object({
  projectId: projectIdSchema,
  operationClass: z.literal("work_item_transition"),
  idempotencyKey: sidebarThreadIdSchema,
  actorReceiptId: sidebarThreadIdSchema.nullable().optional(),
  expectedConfigRevision: z.number().int().nonnegative().nullable().optional(),
  expectedGovernanceEpoch: z.number().int().nonnegative().nullable().optional(),
  expectedFenceToken: sidebarThreadIdSchema.nullable().optional(),
  repoTargetId: sidebarThreadIdSchema.nullable().optional(),
  domainId: sidebarThreadIdSchema.optional(),
  expectedResourceRevision: z.number().int().positive().nullable().optional(),
  workItemId: sidebarThreadIdSchema,
  executionAttemptId: sidebarThreadIdSchema,
}).strict();
const strandedExecutionAttemptClosureInputSchema = z.object({
  request: strandedExecutionAttemptClosureRequestSchema,
  correctionId: z.string().trim().min(1).max(256),
  threadId: sidebarThreadIdSchema,
  nativeEventId: sidebarThreadIdSchema,
  nativeEventSeq: z.number().int().positive(),
  nativeTurnId: sidebarThreadIdSchema,
  incapacity: z.enum(["environment-unavailable", "native-correlation-ambiguous"]),
}).strict();
const terminalReportBuilderInputSchema = z.object({
  projectId: projectIdSchema,
  workItemId: sidebarThreadIdSchema,
  executionAttemptId: sidebarThreadIdSchema,
  outcome: z.enum(["DONE", "BLOCKED"]),
  reasonCode: sidebarThreadIdSchema,
  nativeEventId: sidebarThreadIdSchema,
  nativeEventSeq: z.number().int().positive(),
  nativeTurnId: sidebarThreadIdSchema,
}).strict();
const dispatchEnvironmentSchema = z.union([
  z.object({ type: z.literal("project-default") }).strict(),
  z.object({ type: z.literal("reuse"), environmentId: z.string().trim().min(1) }).strict(),
  z.object({
    type: z.literal("host"),
    hostId: z.string().trim().min(1).optional(),
    workspace: z.union([
      z.object({ type: z.literal("personal") }).strict(),
      z.object({
        type: z.literal("unmanaged"),
        path: z.string().nullable(),
        branch: z.union([
          z.object({ kind: z.literal("existing"), name: z.string().trim().min(1) }).strict(),
          z.object({ kind: z.literal("new"), baseBranch: z.string().trim().min(1) }).strict(),
        ]).optional(),
      }).strict(),
      z.object({
        type: z.literal("managed-worktree"),
        baseBranch: z.union([
          z.object({ kind: z.literal("default") }).strict(),
          z.object({ kind: z.literal("named"), name: z.string().trim().min(1) }).strict(),
        ]),
      }).strict(),
    ]),
  }).strict().superRefine((environment, ctx) => {
    if (environment.workspace.type !== "personal" && environment.hostId === undefined) {
      ctx.addIssue({ code: "custom", path: ["hostId"], message: "host dispatch requires hostId unless workspace.type is personal" });
    }
  }),
]);
const dispatchPromptResourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), label: z.string(), projectId: z.string().optional(), threadId: z.string() }).strict(),
  z.object({ kind: z.literal("project"), label: z.string(), projectId: z.string() }).strict(),
  z.object({ kind: z.literal("section"), label: z.string(), sectionId: z.string() }).strict(),
  z.object({ entryKind: z.enum(["directory", "file"]), kind: z.literal("path"), label: z.string(), path: z.string(), source: z.enum(["thread-storage", "workspace"]) }).strict(),
  z.object({ argumentHint: z.string().nullable(), kind: z.literal("command"), label: z.string(), name: z.string(), origin: z.enum(["builtin", "project", "user"]), source: z.enum(["command", "skill"]), trigger: z.literal("/") }).strict(),
  z.object({ icon: z.string().nullable().optional(), itemId: z.string(), kind: z.literal("plugin"), label: z.string(), pluginId: z.string() }).strict(),
]);
const dispatchPromptInputSchema = z.discriminatedUnion("type", [
  z.object({
    mentions: z.array(z.object({ end: z.number(), resource: dispatchPromptResourceSchema, start: z.number() }).strict()).default([]),
    text: z.string(),
    type: z.literal("text"),
    visibility: z.literal("agent-only").optional(),
  }).strict(),
  z.object({ type: z.literal("image"), url: z.string(), visibility: z.literal("agent-only").optional() }).strict(),
  z.object({ path: z.string(), type: z.literal("localImage"), visibility: z.literal("agent-only").optional() }).strict(),
  z.object({ mimeType: z.string().optional(), name: z.string().optional(), path: z.string(), sizeBytes: z.number().optional(), type: z.literal("localFile"), visibility: z.literal("agent-only").optional() }).strict(),
]);
const dispatchSpawnShapeSchema = z.object({
  projectId: z.string().trim().min(1),
  parentThreadId: z.string().trim().min(1),
  environment: dispatchEnvironmentSchema,
  title: z.string().max(4096).optional(),
  visibility: z.enum(["visible", "hidden"]).optional(),
  providerId: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  serviceTier: z.enum(["default", "fast"]).optional(),
  reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]).optional(),
  permissionMode: z.enum(["auto", "accept-edits", "full"]).optional(),
  executionInputSources: z.object({
    providerId: z.enum(["explicit", "client-preference"]).optional(),
    model: z.enum(["explicit", "client-preference"]).optional(),
    serviceTier: z.enum(["explicit", "client-preference"]).optional(),
    reasoningLevel: z.enum(["explicit", "client-preference"]).optional(),
    permissionMode: z.enum(["explicit", "client-preference"]).optional(),
  }).strict().optional(),
}).passthrough().and(z.union([
  z.object({ input: z.never().optional(), prompt: z.string().min(1) }).passthrough(),
  z.object({ input: z.array(dispatchPromptInputSchema), prompt: z.never().optional() }).passthrough(),
]));

export const rpcContract = defineRpcContract({
  "v1-lanes": {
    input: z.object({}).strict(),
    output: laneListSchema,
  },
  registerWait: {
    input: registeredWaitInputSchema,
    output: registeredWaitSchema,
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
  registerProject: {
    input: registerProjectRequestSchema,
    output: foundationResultSchema,
  },
  dispatchLane: {
    input: dispatchLaneInputSchema,
    output: foundationResultSchema,
  },
  closeThreadlessPreparedAttempt: {
    input: threadlessPreparedClosureInputSchema,
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
  "v1-inbox-read": {
    input: z.object({
      projectId: projectIdSchema,
      recipient: operatorRecipientSchema.optional(),
      includeArchived: z.boolean().optional(),
      withSenderTitles: z.boolean().optional(),
    }).strict(),
    output: operatorMessagesResultSchema,
  },
  "v1-inbox-mark-read": {
    input: z.object({ projectId: projectIdSchema, messageId: z.number().int().positive() }).strict(),
    output: operatorMessageSchema,
  },
  "v1-inbox-archive": {
    input: z.object({ projectId: projectIdSchema, messageId: z.number().int().positive() }).strict(),
    output: operatorMessageSchema,
  },
  "v1-inbox-reply": {
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
  authenticatedNativeCaller: AuthenticatedNativeCaller | null = null,
): Promise<FoundationResult> {
  const parsed = dispatchLaneInputSchema.safeParse(input);
  if (!parsed.success) return { outcome: "INVALID_INPUT", subject: "dispatch", expected: 1, attempted: 0, verified: 0, message: parsed.error.message };
  const { request, spawn } = parsed.data;
  const reviewDispatch = request.workAttempt?.assignmentKind === "review";
  if (!request.workAttempt || (reviewDispatch
    ? request.lifecycleState !== undefined
    : request.lifecycleState !== "in_progress" && request.lifecycleState !== undefined)) {
    return { outcome: "INVALID_INPUT", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: reviewDispatch ? "review dispatch requires a review attempt and review_pending WorkItem" : "lane dispatch requires a writing work attempt and an in-progress transition" };
  }
  if (reviewDispatch && request.workAttempt.candidateKind !== "local") {
    return { outcome: "INVALID_INPUT", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "dispatch_lane only supports explicit local-candidate reviews; pull-request reviews use the governed review handoff" };
  }
  if (spawn.projectId !== request.projectId) {
    return { outcome: "INVALID_INPUT", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "spawn projectId must match request projectId" };
  }
  const spawnShape = dispatchSpawnShapeSchema.safeParse(spawn);
  if (!spawnShape.success) return { outcome: "INVALID_INPUT", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: spawnShape.error.message };
  const requestedProfile = request.workAttempt.requestedProfile;
  if (!requestedProfile) return { outcome: "INVALID_INPUT", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "lane dispatch requires a requested execution profile" };
  const clientPreferenceField = Object.entries(spawnShape.data.executionInputSources ?? {}).find(([, source]) => source === "client-preference")?.[0];
  if (clientPreferenceField) return { outcome: "INVALID_INPUT", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: `native ${clientPreferenceField} routing must be explicit or absent` };
  const nativeProfile = {
    providerId: spawnShape.data.providerId,
    model: spawnShape.data.model,
    reasoningLevel: spawnShape.data.reasoningLevel,
    permissionMode: spawnShape.data.permissionMode,
    serviceTier: spawnShape.data.serviceTier,
    visibility: spawnShape.data.visibility,
  };
  if (Object.values(nativeProfile).some((value) => value === undefined)) {
    return { outcome: "INVALID_INPUT", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "native spawn routing profile must be complete" };
  }
  if (
    nativeProfile.providerId !== requestedProfile.providerId ||
    nativeProfile.model !== requestedProfile.model ||
    nativeProfile.reasoningLevel !== requestedProfile.reasoningLevel ||
    nativeProfile.permissionMode !== requestedProfile.permissionMode ||
    nativeProfile.serviceTier !== requestedProfile.serviceTier ||
    nativeProfile.visibility !== requestedProfile.visibility
  ) {
    return { outcome: "INVALID_INPUT", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "native spawn routing profile does not match the requested execution profile" };
  }
  let configProof: WorkItemDispatchConfigProof;
  try {
    if (!db || !request.workItemId || !request.repoTargetId) throw refusal("CANONICAL_STORE_UNAVAILABLE", "dispatch config proof requires the canonical WorkItem and target");
    configProof = proveWorkItemDispatchConfig(db, {
      projectId: request.projectId,
      workItemId: request.workItemId,
      repoTargetId: request.repoTargetId,
      expectedConfigRevision: request.expectedConfigRevision,
      expectedGovernanceEpoch: request.expectedGovernanceEpoch,
      expectedFenceToken: request.expectedFenceToken,
      requestedProfile,
      assignmentKind: request.workAttempt.assignmentKind,
      candidateKind: request.workAttempt.candidateKind,
    });
  } catch (error) {
    if (isRefusal(error)) return { outcome: error.data.code, subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: error.data.message };
    return { outcome: "INTERNAL_ERROR", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "dispatch config proof failed" };
  }
  const localReview = request.workAttempt.assignmentKind === "review" && request.workAttempt.candidateKind === "local";
  let preparedDispatchSpawn = spawnShape.data;
  if (localReview) {
    if (
      configProof.reviewerRoleRequirementId !== request.workAttempt.reviewRoleRequirementId ||
      configProof.reviewerRoleId !== request.workAttempt.reviewRoleId ||
      configProof.reviewerRoleGeneration !== request.workAttempt.reviewRoleGeneration
    ) return { outcome: "ROLE_GENERATION_STALE", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "local review authority does not match the current independent-reviewer generation" };
    if (request.workAttempt.reviewReturnPath?.threadId !== spawnShape.data.parentThreadId) {
      return { outcome: "INVALID_INPUT", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "local review return path must bind the native parent thread" };
    }
    try {
      preparedDispatchSpawn = appendFrozenReviewBrief(spawnShape.data as Record<string, unknown>, request.workAttempt.reviewFrozenBriefContent!) as typeof spawnShape.data;
    } catch (error) {
      return { outcome: "INVALID_INPUT", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: `local review brief cannot be bound to native input: ${String(error)}` };
    }
    request.workAttempt = { ...request.workAttempt, dispatchInputDigest: dispatchInputDigest(preparedDispatchSpawn as Record<string, unknown>) };
  }
  const environmentRefusal = await dispatchEnvironmentPreflight(bb, request.projectId, preparedDispatchSpawn.environment, configProof, request.workAttempt);
  if (environmentRefusal) return environmentRefusal;
  const briefTarget = localReview ? null : githubIssueBriefTarget(db, request.projectId, request.workItemId ?? "");
  if (briefTarget === "invalid") {
    return { outcome: "EXTERNAL_RESPONSE_INVALID", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "GitHub issue projection identity is malformed or ambiguous" };
  }
  if (briefTarget && !briefTarget.stale && !projectionIsCurrent(briefTarget) && !projectionIsInitialPending(briefTarget)) {
    return { outcome: "EXTERNAL_UNAVAILABLE", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "cause=projection-target-not-current; GitHub issue projection is stale or ambiguous for the canonical WorkItem" };
  }
  const githubAdapter = briefTarget ? githubCliAdapterForWorkItem(db, request.projectId, request.workItemId ?? "") : null;
  if (briefTarget && !githubAdapter) {
    return { outcome: "EXTERNAL_UNAVAILABLE", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "cause=repository-mapping-unavailable; GitHub projection capability is unavailable for the current WorkItem" };
  }
  if (briefTarget && projectionIsInitialPending(briefTarget)
    && (briefTarget.owner !== githubAdapter!.owner || briefTarget.repo !== githubAdapter!.repo)) {
    return { outcome: "EXTERNAL_REF_CONFLICT", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "GitHub pending binding does not match its exact repository-target mapping" };
  }
  let initialBrief: GithubIssueBrief | null = null;
  let briefFreshnessEvidence: GithubIssueBriefFreshnessEvidence[] = [];
  const dispatchParentThreadId = spawnShape.data.parentThreadId;
  const dispatchTitle = String(spawnShape.data.title ?? "lane");
  const { threadId: _threadId, ...intentAttempt } = request.workAttempt;
  const existing = preparedDispatchIntent(db, request);
  const legacyReplay = existing !== null && existing !== "ambiguous" && existing.title === null && existing.parentThreadId === dispatchParentThreadId;
  const intent = await applyLiveAuthorizedMutation(bb, db, {
    ...request,
    ...(configProof.continued ? { configRevision: configProof.currentConfigRevision, fixtureContextDigest: configProof.proofDigest } : {}),
    reasonCode: legacyReplay
      ? `dispatch_parent:${dispatchParentThreadId}`
      : `dispatch_parent:${dispatchParentThreadId}:title=${encodeURIComponent(dispatchTitle)}`,
    workAttempt: intentAttempt,
  }, false, "stop-active", githubAdapter?.read ?? projectGithubIssueReader(db, request.projectId), githubAdapter, undefined, false, false, authenticatedNativeCaller);
  if (intent.outcome !== "OK") return intent;
  return serializeDispatchRecovery(request, async () => {
    let dispatchSpawn = preparedDispatchSpawn;
    const withBriefFreshnessEvidence = (result: FoundationResult): FoundationResult => {
      const recovered = briefFreshnessEvidence.filter((evidence) => evidence.mismatchedExternalRevisions.length > 0);
      if (result.outcome !== "OK" || recovered.length === 0) return result;
      const existingEvidence = result.evidence && typeof result.evidence === "object" && !Array.isArray(result.evidence)
        ? result.evidence as Record<string, unknown>
        : {};
      return {
        ...result,
        message: `${result.message ?? "dispatch complete"}; brief freshness mismatch recovered (attempts=${recovered.map((evidence) => evidence.attempts).join(",")})`,
        evidence: { ...existingEvidence, briefFreshness: recovered },
      };
    };
    if (briefTarget) {
      const currentWorkItem = db?.prepare(
        "SELECT resource_revision FROM work_items WHERE project_id = ? AND work_item_id = ?",
      ).get(request.projectId, request.workItemId ?? "") as { resource_revision?: unknown } | undefined;
      if (!currentWorkItem || !Number.isSafeInteger(currentWorkItem.resource_revision)) {
        return { outcome: "EXTERNAL_UNAVAILABLE", subject: request.projectId, expected: 1, attempted: 1, verified: 0, message: "cause=canonical-work-item-read; GitHub projection capability is unavailable for the current WorkItem" };
      }
      const projection = await applyLiveAuthorizedMutationAsync(bb, db, {
        projectId: request.projectId,
        operationClass: "github_issue_projection",
        idempotencyKey: `${request.idempotencyKey}:maintained-body`,
        actorReceiptId: request.actorReceiptId,
        expectedConfigRevision: request.expectedConfigRevision,
        expectedGovernanceEpoch: request.expectedGovernanceEpoch,
        expectedFenceToken: request.expectedFenceToken,
        repoTargetId: request.repoTargetId,
        domainId: request.domainId,
        taskClass: request.taskClass,
        expectedResourceRevision: currentWorkItem.resource_revision,
        workItemId: request.workItemId,
        projectionKind: "github_issue",
        queueLabel: "queue:dispatched",
        ...(configProof.continued ? {
          configRevision: configProof.currentConfigRevision,
          fixtureContextDigest: configProof.proofDigest,
        } : {}),
      }, false, "refuse-active", projectGithubIssueReader(db, request.projectId), githubAdapter);
      if (projection.outcome !== "OK") return projection;
      try {
        const initialRead = await readGithubIssueBriefAsync(db, request.projectId, request.workItemId ?? "");
        initialBrief = initialRead.brief;
        briefFreshnessEvidence.push(initialRead.freshness);
      } catch (error) {
        return { outcome: "EXTERNAL_UNAVAILABLE", subject: request.projectId, expected: 1, attempted: 1, verified: 0, message: `cause=initial-brief-read; ${String(error)}` };
      }
      let latestRead: GithubIssueBriefRead;
      try {
        latestRead = await readGithubIssueBriefAsync(db, request.projectId, request.workItemId ?? "");
        briefFreshnessEvidence.push(latestRead.freshness);
      } catch (error) {
        return { outcome: "EXTERNAL_UNAVAILABLE", subject: request.projectId, expected: 1, attempted: 1, verified: 0, message: `cause=freshness-reread; ${String(error)}` };
      }
      try {
        assertGithubIssueBriefAnchor(initialBrief, latestRead.source);
      } catch (error) {
        return { outcome: "EXTERNAL_UNAVAILABLE", subject: request.projectId, expected: 1, attempted: 1, verified: 0, message: `cause=brief-anchor-moved; ${String(error)}` };
      }
      dispatchSpawn = appendGithubIssueBrief(dispatchSpawn as Record<string, unknown>, latestRead.brief) as typeof dispatchSpawn;
    }
    if (localReview) {
      const finalEnvironmentRefusal = await dispatchEnvironmentPreflight(bb, request.projectId, dispatchSpawn.environment, configProof, request.workAttempt!);
      if (finalEnvironmentRefusal) return finalEnvironmentRefusal;
    }
    if (!intent.replay) {
      try {
        const spawnedThread = await spawnDispatchThread(bb, dispatchSpawn, request.idempotencyKey);
        const prepared = preparedDispatchIntent(db, request);
        if (prepared === "ambiguous" || !prepared) {
          return dispatchRecoveryRefusal(request.projectId, "native spawn returned without a uniquely recoverable prepared intent");
        }
        if (
          spawnedThread.projectId !== request.projectId ||
          spawnedThread.parentThreadId !== prepared.parentThreadId ||
          spawnedThread.title !== `${dispatchTitle} [dispatch:${request.idempotencyKey}]`
        ) {
          return withBriefFreshnessEvidence(await reconcileDispatchIntent(bb, db, request, dispatchSpawn, intent, false, configProof));
        }
        return withBriefFreshnessEvidence(await finalizeDispatchIntent(bb, db, request, prepared, spawnedThread.id, configProof));
      } catch {
        return withBriefFreshnessEvidence(await reconcileDispatchIntent(bb, db, request, dispatchSpawn, intent, true, configProof));
      }
    }
    return withBriefFreshnessEvidence(await reconcileDispatchIntent(bb, db, request, dispatchSpawn, intent, true, configProof));
  });
}

type DispatchThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
type PreparedDispatchIntent = {
  parentThreadId: string;
  title: string | null;
  resourceRevision: number;
};

function preparedDispatchIntent(db: SqliteDatabase | null, request: ApplyRequest): PreparedDispatchIntent | "ambiguous" | null {
  if (!db || !request.workItemId) return null;
  const rows = db.prepare(
    `SELECT reason_code
     FROM execution_attempts
     WHERE project_id = ? AND work_item_id = ? AND origin = 'work_item'
       AND assignment_kind = ? AND state = 'prepared' AND thread_id IS NULL
     ORDER BY attempt_ordinal DESC`,
  ).all(request.projectId, request.workItemId, request.workAttempt?.assignmentKind ?? "write") as Array<{ reason_code: string | null }>;
  const matches = rows.filter((row) => parseWorkItemDispatchIntent(row.reason_code)?.idempotencyKey === request.idempotencyKey);
  if (matches.length > 1) return "ambiguous";
  const match = matches[0];
  if (!match || !match.reason_code) return null;
  const parsed = parseWorkItemDispatchIntent(match.reason_code);
  if (!parsed) return "ambiguous";
  const workItem = db.prepare(
    "SELECT resource_revision FROM work_items WHERE project_id = ? AND work_item_id = ?",
  ).get(request.projectId, request.workItemId) as { resource_revision: number } | undefined;
  return workItem ? { parentThreadId: parsed.parentThreadId, title: parsed.title, resourceRevision: workItem.resource_revision } : "ambiguous";
}

function dispatchThreadShape(thread: unknown): thread is DispatchThread {
  if (!thread || typeof thread !== "object") return false;
  const value = thread as Record<string, unknown>;
  return typeof value.id === "string" && value.id.length > 0 &&
    typeof value.projectId === "string" && value.projectId.length > 0 &&
    (typeof value.parentThreadId === "string" || value.parentThreadId === null) &&
    (typeof value.title === "string" || value.title === null) &&
    typeof value.status === "string" &&
    (typeof value.archivedAt === "number" || value.archivedAt === null) &&
    (typeof value.deletedAt === "number" || value.deletedAt === null);
}

async function dispatchThreadInventory(bb: BbPluginApi, projectId: string): Promise<DispatchThread[]> {
  // Native threads.list is authoritative over complete active and archived populations; deleted history is not listable evidence.
  const [active, archived] = await Promise.all([
    listAllProjectThreads((args) => bb.sdk.threads.list(args), projectId),
    listAllProjectThreads((args) => bb.sdk.threads.list({ ...args, archived: true }), projectId),
  ]);
  const threads = [...active, ...archived];
  const ids = new Set<string>();
  for (const [thread, expectedArchived] of [...active.map((thread) => [thread, false] as const), ...archived.map((thread) => [thread, true] as const)]) {
    if (!dispatchThreadShape(thread) || thread.projectId !== projectId || ids.has(thread.id) || (expectedArchived ? thread.archivedAt === null : thread.archivedAt !== null)) {
      throw new Error("native dispatch inventory is incomplete or foreign");
    }
    ids.add(thread.id);
  }
  return threads;
}

function hasExactDispatchMarker(title: string | null, marker: string): boolean {
  if (title === null) return false;
  for (let index = title.indexOf(marker); index >= 0; index = title.indexOf(marker, index + 1)) {
    const before = index === 0 ? " " : title[index - 1];
    const afterIndex = index + marker.length;
    const after = afterIndex === title.length ? " " : title[afterIndex];
    if (before === " " && after === " ") return true;
  }
  return false;
}

function dispatchInventoryEvidence(
  threads: DispatchThread[],
  projectId: string,
  executionAttemptId: string,
  dispatchMarker: string,
) {
  const active = threads.filter((thread) => thread.archivedAt === null).map((thread) => ({ id: thread.id, projectId: thread.projectId, parentThreadId: thread.parentThreadId, title: thread.title, status: thread.status, archivedAt: thread.archivedAt, deletedAt: thread.deletedAt }));
  const archived = threads.filter((thread) => thread.archivedAt !== null).map((thread) => ({ id: thread.id, projectId: thread.projectId, parentThreadId: thread.parentThreadId, title: thread.title, status: thread.status, archivedAt: thread.archivedAt, deletedAt: thread.deletedAt }));
  const population = threadlessPreparedClosurePopulation(projectId);
  return {
    active,
    archived,
    matching: threads.filter((thread) => hasExactDispatchMarker(thread.title, dispatchMarker)),
    population,
    digest: sha256(canonicalJson({ projectId, executionAttemptId, dispatchMarker, population, active, archived })),
  };
}

async function closeThreadlessPreparedAttempt(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  input: unknown,
): Promise<FoundationResult> {
  const parsed = threadlessPreparedClosureInputSchema.safeParse(input);
  if (!parsed.success) return { outcome: "INVALID_INPUT", subject: "threadless-prepared-closure", expected: 1, attempted: 0, verified: 0, message: parsed.error.message };
  const { request, correctionId, dispatchIntentIdempotencyKey } = parsed.data;
  if (!db) return { outcome: "CANONICAL_STORE_UNAVAILABLE", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "canonical SQLite store is unavailable" };
  const existing = db.prepare(
    "SELECT request_digest, outcome_json, committed_event_sequence, operation_class FROM mutation_receipts WHERE project_id = ? AND idempotency_key = ?",
  ).get(request.projectId, request.idempotencyKey) as { request_digest: string; outcome_json: string; committed_event_sequence: number; operation_class: string } | undefined;
  if (existing?.operation_class === "work_item_transition") {
    const event = db.prepare(
      "SELECT event_type, event_json FROM state_events WHERE project_id = ? AND event_sequence = ?",
    ).get(request.projectId, existing.committed_event_sequence) as { event_type: string; event_json: string } | undefined;
    try {
      const payload = event ? JSON.parse(event.event_json) as { correction?: unknown } : null;
      const replayRequest = parseApplyRequest({
        ...request,
        lifecycleState: "failed",
        reasonCode: "threadless-prepared-closure",
        threadlessPreparedClosure: payload?.correction,
      });
      if (event?.event_type === "work_item_threadless_prepared_closure" && mutationRequestDigest(replayRequest) === existing.request_digest) {
        const replay = JSON.parse(existing.outcome_json) as FoundationResult;
        Object.defineProperty(replay, "replay", { value: true });
        return replay;
      }
    } catch {
      // Fall through to the normal exact-identity refusal.
    }
  }
  if (
    request.operationClass !== "work_item_transition" ||
    request.lifecycleState !== undefined ||
    request.threadlessPreparedClosure !== undefined ||
    request.workAttempt !== undefined ||
    request.workItemWait !== undefined ||
    request.workItemUnblock !== undefined ||
    request.workItemExternalEvent !== undefined ||
    !request.workItemId ||
    !request.executionAttemptId
  ) {
    return { outcome: "INVALID_INPUT", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "thread-less prepared closure requires one exact work item and execution attempt without ordinary transition fields" };
  }
  const attempt = db.prepare(
    "SELECT reason_code FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ? AND work_item_id = ?",
  ).get(request.projectId, request.executionAttemptId, request.workItemId) as { reason_code: string | null } | undefined;
  const dispatchIntent = parseWorkItemDispatchIntent(attempt?.reason_code ?? null);
  if (!attempt || (dispatchIntent !== null && dispatchIntent.idempotencyKey !== dispatchIntentIdempotencyKey)) {
    return { outcome: "WORK_ITEM_STATE_INVALID", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "thread-less closure marker does not match the exact canonical attempt" };
  }
  const dispatchMarker = `[dispatch:${dispatchIntentIdempotencyKey}]`;
  const preparationRows = db.prepare(
    `SELECT event_sequence, event_json, idempotency_key
     FROM state_events
     WHERE project_id = ? AND aggregate_type = 'work_item' AND aggregate_id = ?
       AND event_type = 'work_item_transitioned'
       AND json_extract(event_json, '$.executionAttemptId') = ?
     ORDER BY event_sequence`,
  ).all(request.projectId, request.workItemId, request.executionAttemptId) as Array<{ event_sequence: number; event_json: string; idempotency_key: string }>;
  if (preparationRows.length !== 1 || preparationRows[0]!.idempotency_key !== dispatchIntentIdempotencyKey) {
    return { outcome: "WORK_ITEM_STATE_INVALID", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "thread-less closure requires one exact durable dispatch preparation and intent receipt" };
  }
  const preparation = preparationRows[0]!;
  const originalReceipt = db.prepare(
    "SELECT request_digest, committed_event_sequence FROM mutation_receipts WHERE project_id = ? AND idempotency_key = ?",
  ).get(request.projectId, dispatchIntentIdempotencyKey) as { request_digest: string; committed_event_sequence: number } | undefined;
  if (!originalReceipt || originalReceipt.committed_event_sequence !== preparation.event_sequence) {
    return { outcome: "WORK_ITEM_STATE_INVALID", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "thread-less closure requires the exact durable dispatch intent receipt" };
  }
  const replayRequestDigest = threadlessPreparedReplayProbeDigest({
    projectId: request.projectId,
    workItemId: request.workItemId,
    executionAttemptId: request.executionAttemptId,
    idempotencyKey: dispatchIntentIdempotencyKey,
  });
  return serializeDispatchRecovery(request, async () => {
    let threads: DispatchThread[];
    try {
      threads = await dispatchThreadInventory(bb, request.projectId);
    } catch (error) {
      return dispatchRecoveryRefusal(request.projectId, `complete active and archived native inventory is unavailable: ${String(error)}`);
    }
    const inventory = dispatchInventoryEvidence(threads, request.projectId, request.executionAttemptId!, dispatchMarker);
    if (inventory.matching.length !== 0) {
      return dispatchRecoveryRefusal(request.projectId, "native inventory contains a possible child for the recorded dispatch marker", {
        matches: inventory.matching.map((thread) => ({ id: thread.id, projectId: thread.projectId, parentThreadId: thread.parentThreadId, title: thread.title, archivedAt: thread.archivedAt, deletedAt: thread.deletedAt })),
      });
    }
    const preMutationGuard: PreMutationGuard = async () => {
      try {
        const reread = dispatchInventoryEvidence(await dispatchThreadInventory(bb, request.projectId), request.projectId, request.executionAttemptId!, dispatchMarker);
        if (reread.digest === inventory.digest && reread.matching.length === 0) return null;
        return dispatchRecoveryRefusal(request.projectId, "native dispatch inventory changed before thread-less closure mutation", {
          initialDigest: inventory.digest,
          rereadDigest: reread.digest,
          matching: reread.matching.map((thread) => ({ id: thread.id, projectId: thread.projectId, parentThreadId: thread.parentThreadId, title: thread.title, archivedAt: thread.archivedAt, deletedAt: thread.deletedAt })),
        });
      } catch (error) {
        return dispatchRecoveryRefusal(request.projectId, `complete active and archived native inventory reread is unavailable: ${String(error)}`);
      }
    };
    const inventoryDigest = inventory.digest;
    const dispatchEvidence = {
      kind: "dispatch_refusal" as const,
      projectId: request.projectId,
      workItemId: request.workItemId,
      executionAttemptId: request.executionAttemptId,
      idempotencyKey: dispatchIntentIdempotencyKey,
      reasonCode: attempt.reason_code,
    };
    const replayEvidence = {
      kind: "replay_conflict" as const,
      projectId: request.projectId,
      workItemId: request.workItemId,
      executionAttemptId: request.executionAttemptId,
      idempotencyKey: dispatchIntentIdempotencyKey,
      requestDigest: replayRequestDigest,
    };
    const terminalizationEvidence = {
      kind: "terminalization_refusal" as const,
      projectId: request.projectId,
      workItemId: request.workItemId,
      executionAttemptId: request.executionAttemptId,
      message: "writing attempt terminalization requires a bound lane with native stop evidence",
    };
    const closureRequest: ApplyRequest = {
      ...request,
      lifecycleState: "failed",
      reasonCode: "threadless-prepared-closure",
      threadlessPreparedClosure: {
        correctionId,
        dispatchMarker,
        evidence: [
          { kind: "preparation", eventSequence: preparation.event_sequence, reference: `state-event:${preparation.event_sequence}`, digest: sha256(preparation.event_json) },
          { kind: "dispatch_refusal", reference: `mutation:${dispatchIntentIdempotencyKey}`, digest: sha256(canonicalJson(dispatchEvidence)) },
          { kind: "replay_conflict", reference: `replay:${dispatchIntentIdempotencyKey}`, requestDigest: replayRequestDigest, digest: sha256(canonicalJson(replayEvidence)) },
          { kind: "terminalization_refusal", reference: "terminalization-refusal", digest: sha256(canonicalJson(terminalizationEvidence)) },
          { kind: "zero_thread", reference: "native-thread-inventory", population: inventory.population, activeCount: inventory.active.length, archivedCount: inventory.archived.length, matchingCount: 0, digest: inventoryDigest },
        ],
      },
    };
    return applyLiveAuthorizedMutation(bb, db, closureRequest, false, "refuse-active", readGithubIssueForBackfill, null, preMutationGuard, true);
  });
}

type StrandedExecutionAttemptClosureInput = z.infer<typeof strandedExecutionAttemptClosureInputSchema>;

function isStructuredDestroyedEnvironmentError(error: unknown): boolean {
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const value = error as Record<string, unknown>;
  return value.code === "ENVIRONMENT_DESTROYED" || value.code === "ENVIRONMENT_NOT_FOUND"
    || value.statusCode === 404 || value.httpStatusCode === 404;
}

type StrandedOwnerAttempt = { thread_id: string; environment_id: string | null };

async function readStrandedOwnerIncapacity(
  bb: BbPluginApi,
  projectId: string,
  attempt: StrandedOwnerAttempt,
  input: StrandedExecutionAttemptClosureInput,
): Promise<FoundationResult | null> {
  let thread: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
  try {
    thread = await bb.sdk.threads.get({ threadId: input.threadId });
    if (thread.id !== input.threadId || thread.projectId !== projectId || thread.deletedAt !== null || thread.environmentId === null) {
      return { outcome: "TERMINAL_REPORT_AMBIGUOUS", subject: projectId, expected: 1, attempted: 1, verified: 0, message: "stranded execution closure owner thread is foreign, deleted, or has no environment" };
    }
    if (attempt.thread_id !== input.threadId || (typeof attempt.environment_id === "string" && attempt.environment_id !== thread.environmentId)) {
      return { outcome: "TERMINAL_REPORT_AMBIGUOUS", subject: projectId, expected: 1, attempted: 1, verified: 0, message: "stranded execution closure environment does not match the canonical attempt" };
    }
    if (input.incapacity === "native-correlation-ambiguous") {
      if (thread.status !== "idle") {
        return { outcome: "WORK_ITEM_STATE_INVALID", subject: projectId, expected: 1, attempted: 1, verified: 0, message: `stranded native-correlation disposal requires an idle owner thread: status=${thread.status}` };
      }
      return null;
    }
    if (["active", "starting"].includes(thread.status)) {
      return { outcome: "WORK_ITEM_STATE_INVALID", subject: projectId, expected: 1, attempted: 1, verified: 0, message: "stranded execution disposal requires a non-executable owner thread" };
    }
    try {
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      if (environment.id !== thread.environmentId || environment.projectId !== projectId) {
        return { outcome: "TERMINAL_REPORT_AMBIGUOUS", subject: projectId, expected: 1, attempted: 1, verified: 0, message: "stranded execution closure owner environment is foreign" };
      }
      if (environment.status === "destroyed") return null;
      return { outcome: "WORK_ITEM_STATE_INVALID", subject: projectId, expected: 1, attempted: 1, verified: 0, message: "stranded execution disposal requires a proven destroyed owner environment" };
    } catch (error) {
      if (isStructuredDestroyedEnvironmentError(error)) return null;
      return { outcome: "EXTERNAL_UNAVAILABLE", subject: projectId, expected: 1, attempted: 1, verified: 0, message: `stranded owner environment availability is unproven: ${String(error)}` };
    }
  } catch (error) {
    return { outcome: "EXTERNAL_UNAVAILABLE", subject: projectId, expected: 1, attempted: 1, verified: 0, message: `stranded owner incapacity evidence unavailable: ${String(error)}` };
  }
}

function recoveryCallerRefusal(
  db: SqliteDatabase,
  projectId: string,
  callerThreadId: string,
): FoundationResult | null {
  const holder = readRoleHolderStates(db).find((candidate) =>
    candidate.project_id === projectId && candidate.thread_id === callerThreadId && ["director", "project-orchestrator"].includes(candidate.role_id),
  );
  if (!holder) return { outcome: "ROLE_HOLDER_MISMATCH", subject: projectId, expected: 1, attempted: 0, verified: 0, message: "recovery caller is not the current director or project-orchestrator holder" };
  return null;
}

async function strandedExecutionEvidence(
  bb: BbPluginApi,
  db: SqliteDatabase,
  input: StrandedExecutionAttemptClosureInput,
): Promise<{ projectId: string; workItemId: string; executionAttemptId: string; threadId: string; nativeEventId: string; nativeEventSeq: number; nativeTurnId: string; incapacity: "environment-unavailable" | "native-correlation-ambiguous"; digest: string } | FoundationResult> {
  const request = input.request;
  const attempt = db.prepare(
    "SELECT * FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ? AND work_item_id = ?",
  ).get(request.projectId, request.executionAttemptId, request.workItemId) as Record<string, unknown> | undefined;
  if (!attempt || typeof attempt.thread_id !== "string") return { outcome: "TERMINAL_REPORT_AMBIGUOUS", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "stranded execution closure requires the exact canonical native thread" };
  if (attempt.thread_id !== input.threadId) return { outcome: "TERMINAL_REPORT_AMBIGUOUS", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "stranded execution closure thread does not match the canonical attempt" };
  const incapacity = await readStrandedOwnerIncapacity(bb, request.projectId, {
    thread_id: attempt.thread_id,
    environment_id: typeof attempt.environment_id === "string" ? attempt.environment_id : null,
  }, input);
  if (incapacity) return incapacity;
  try {
    const events = await completeNativeThreadEvents(bb.sdk, input.threadId);
    const completions = events.filter((event) => event.type === "turn/completed" && nativeTurnId(event) === input.nativeTurnId);
    if (completions.length !== 1) throw new Error("exact native completion is missing or ambiguous");
    const completion = completions[0]!;
    const completionData = nativeEventData(completion);
    if (completion.id !== input.nativeEventId || completion.seq !== input.nativeEventSeq || completionData.status !== "completed") throw new Error("exact native completion is not the cited completed event");
    const providerThreadId = typeof completionData.providerThreadId === "string" && completionData.providerThreadId.length > 0 ? completionData.providerThreadId : null;
    if (!providerThreadId) throw new Error("exact native completion provider thread is unavailable");
    const starts = events.filter((event) => event.type === "turn/started" && nativeTurnId(event) === input.nativeTurnId && nativeEventData(event).providerThreadId === providerThreadId);
    if (starts.length !== 1 || starts[0]!.seq >= completion.seq) throw new Error("exact native completion start correlation is missing or ambiguous");
    if (input.incapacity === "native-correlation-ambiguous") {
      const accepted = events.filter((event) => event.type === "turn/input/accepted" && nativeTurnId(event) === input.nativeTurnId);
      if (accepted.length === 1) throw new Error("native completion input correlation is exact, not missing or ambiguous");
    }
    const evidence = {
      kind: "stranded-execution-attempt" as const,
      projectId: request.projectId,
      workItemId: request.workItemId!,
      executionAttemptId: request.executionAttemptId!,
      threadId: input.threadId,
      nativeEventId: input.nativeEventId,
      nativeEventSeq: input.nativeEventSeq,
      nativeTurnId: input.nativeTurnId,
      incapacity: input.incapacity,
    };
    return { ...evidence, digest: sha256(canonicalJson(evidence)) };
  } catch (error) {
    return { outcome: "TERMINAL_REPORT_AMBIGUOUS", subject: request.projectId, expected: 1, attempted: 1, verified: 0, message: `stranded native completion evidence unavailable or foreign: ${String(error)}` };
  }
}

async function closeStrandedExecutionAttempt(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  input: unknown,
  callerThreadId: string,
): Promise<FoundationResult> {
  const parsed = strandedExecutionAttemptClosureInputSchema.safeParse(input);
  if (!parsed.success) return { outcome: "INVALID_INPUT", subject: "stranded-execution-closure", expected: 1, attempted: 0, verified: 0, message: parsed.error.message };
  const { request } = parsed.data;
  if (!db) return { outcome: "CANONICAL_STORE_UNAVAILABLE", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "canonical SQLite store is unavailable" };
  const callerRefusal = recoveryCallerRefusal(db, request.projectId, callerThreadId);
  if (callerRefusal) return callerRefusal;
  const evidence = await strandedExecutionEvidence(bb, db, parsed.data);
  if ("outcome" in evidence) return evidence;
  const closureRequest: ApplyRequest = {
    ...request,
    lifecycleState: "failed",
    reasonCode: "stranded-execution-closure",
    strandedExecutionAttemptClosure: { correctionId: parsed.data.correctionId, evidence: { kind: "stranded-execution-attempt", ...evidence } },
  };
  const preMutationGuard: PreMutationGuard = async () => {
    const reread = await strandedExecutionEvidence(bb, db, parsed.data);
    if ("outcome" in reread) return reread;
    if (reread.digest !== evidence.digest) {
      return { outcome: "TERMINAL_REPORT_AMBIGUOUS", subject: request.projectId, expected: 1, attempted: 1, verified: 0, message: "stranded owner incapacity or native completion evidence changed before mutation" };
    }
    return null;
  };
  return applyLiveAuthorizedMutation(bb, db, closureRequest, false, "refuse-active", readGithubIssueForBackfill, null, preMutationGuard, false, true);
}

function dispatchRecoveryRefusal(projectId: string, message: string, evidence?: unknown): FoundationResult {
  return {
    outcome: "EXTERNAL_DELIVERY_AMBIGUOUS",
    subject: projectId,
    expected: 1,
    attempted: 1,
    verified: 0,
    message,
    ...(evidence === undefined ? {} : { evidence }),
  };
}

async function spawnDispatchThread(
  bb: BbPluginApi,
  spawn: z.infer<typeof dispatchSpawnShapeSchema>,
  idempotencyKey: string,
): Promise<DispatchThread> {
  const thread = await bb.sdk.threads.spawn({
    ...spawn,
    title: `${String(spawn.title ?? "lane")} [dispatch:${idempotencyKey}]`,
  });
  if (!dispatchThreadShape(thread)) throw new Error("native spawn returned incomplete thread evidence");
  return thread;
}

async function dispatchEnvironmentPreflight(
  bb: BbPluginApi,
  projectId: string,
  environment: z.infer<typeof dispatchEnvironmentSchema>,
  proof: WorkItemDispatchConfigProof,
  workAttempt: NonNullable<ApplyRequest["workAttempt"]>,
): Promise<FoundationResult | null> {
  if (workAttempt.assignmentKind === "review" && workAttempt.candidateKind === "local") {
    const candidateEnvironment = workAttempt.reviewCandidateEnvironment!;
    if (environment.type !== "reuse" || environment.environmentId !== candidateEnvironment.environmentId) {
      return { outcome: "REPO_TARGET_FOREIGN", subject: projectId, expected: 1, attempted: 0, verified: 0, message: "local review must reuse the exact frozen candidate environment" };
    }
    try {
      const [facts, project] = await Promise.all([
        bb.sdk.environments.get({ environmentId: candidateEnvironment.environmentId }),
        bb.sdk.projects.get({ projectId }),
      ]);
      if (
        facts.id !== candidateEnvironment.environmentId || facts.projectId !== projectId || facts.hostId !== candidateEnvironment.hostId ||
        candidateEnvironment.sourceId !== proof.sourceId || candidateEnvironment.hostId !== proof.hostId ||
        candidateEnvironment.bbServerId !== bb.server.loopbackBaseUrl ||
        facts.path !== candidateEnvironment.path || facts.managed !== true || facts.isWorktree !== true || facts.workspaceProvisionType !== "managed-worktree" ||
        project.sources.filter((source) => source.id === proof.sourceId && source.projectId === projectId && source.hostId === proof.hostId && source.path === proof.path).length !== 1
      ) return { outcome: "REPO_TARGET_FOREIGN", subject: projectId, expected: 1, attempted: 0, verified: 0, message: "local candidate environment identity is foreign or incomplete" };
      const base = workAttempt.reviewBaseSha!;
      const [baseCommit, candidateCommit, status] = await Promise.all([
        bb.sdk.environments.diff({ environmentId: candidateEnvironment.environmentId, target: "commit", sha: base }),
        bb.sdk.environments.diff({ environmentId: candidateEnvironment.environmentId, target: "commit", sha: workAttempt.reviewCandidateSha! }),
        bb.sdk.environments.status({ environmentId: candidateEnvironment.environmentId, mergeBaseBranch: base }),
      ]);
      if (baseCommit.outcome !== "available") return { outcome: "EXTERNAL_RESPONSE_INVALID", subject: projectId, expected: 1, attempted: 1, verified: 0, message: "local review base commit is unavailable in the candidate repository" };
      if (candidateCommit.outcome !== "available") return { outcome: "EXTERNAL_RESPONSE_INVALID", subject: projectId, expected: 1, attempted: 1, verified: 0, message: "local review candidate commit is unavailable in the candidate repository" };
      if (status.outcome !== "available") return { outcome: "EXTERNAL_RESPONSE_INVALID", subject: projectId, expected: 1, attempted: 1, verified: 0, message: "local candidate environment is not reachable" };
      const workspace = status.workspace;
      const checkout = workspace?.checkout;
      const workingTree = workspace?.workingTree as { state?: string; hasUncommittedChanges?: boolean; files?: unknown[]; insertions?: number; deletions?: number } | undefined;
      const clean = (workingTree?.state === "clean" || workingTree?.state === "committed_unmerged") &&
        workingTree.hasUncommittedChanges === false && Array.isArray(workingTree.files) &&
        workingTree.files.length === 0 && workingTree.insertions === 0 && workingTree.deletions === 0;
      const mergeBase = workspace.mergeBase;
      if (
        !checkout || checkout.kind !== "branch" || checkout.headSha !== workAttempt.reviewCandidateSha ||
        checkout.branchName !== workAttempt.reviewCandidateCheckout?.branchName || !clean ||
        !mergeBase || mergeBase.baseRef !== base || mergeBase.mergeBaseBranch !== base || mergeBase.behindCount !== 0 || mergeBase.aheadCount <= 0 || mergeBase.lineStatsComplete !== true
      ) return { outcome: "EXTERNAL_RESPONSE_INVALID", subject: projectId, expected: 1, attempted: 1, verified: 0, message: "local candidate is not the exact reachable clean frozen checkout based on the frozen base" };
    } catch (error) {
      return { outcome: "EXTERNAL_UNAVAILABLE", subject: projectId, expected: 1, attempted: 1, verified: 0, message: `local candidate observation is unavailable: ${String(error)}` };
    }
    return null;
  }
  if (environment.type !== "host" || environment.workspace.type !== "managed-worktree" || !environment.hostId) {
    return { outcome: "REPO_TARGET_FOREIGN", subject: projectId, expected: 1, attempted: 0, verified: 0, message: "dispatch requires one exact host managed-worktree environment" };
  }
  const baseBranch = environment.workspace.baseBranch.kind === "default" ? proof.defaultBranch : environment.workspace.baseBranch.name;
  const exactDefaultBase = baseBranch === proof.defaultBranch || baseBranch === `origin/${proof.defaultBranch}`;
  if (environment.hostId !== proof.hostId || !exactDefaultBase) {
    return { outcome: "REPO_TARGET_FOREIGN", subject: projectId, expected: 1, attempted: 0, verified: 0, message: "dispatch environment does not match the exact target host and default branch" };
  }
  try {
    const [project, host] = await Promise.all([
      bb.sdk.projects.get({ projectId }),
      bb.sdk.hosts.get({ hostId: proof.hostId }),
    ]);
    if (project.id !== projectId) {
      return { outcome: "REPO_TARGET_FOREIGN", subject: projectId, expected: 1, attempted: 0, verified: 0, message: "BB returned a foreign project for the dispatch target" };
    }
    const sources = project.sources.filter((source) =>
      source.id === proof.sourceId && source.projectId === projectId && source.hostId === proof.hostId && source.path === proof.path,
    );
    if (sources.length !== 1) {
      return { outcome: "REPO_TARGET_FOREIGN", subject: projectId, expected: 1, attempted: 0, verified: 0, message: "dispatch target source and path are missing, foreign, or ambiguous" };
    }
    if (host.id !== proof.hostId || host.status !== "connected") {
      return { outcome: "HOST_UNAVAILABLE", subject: projectId, expected: 1, attempted: 0, verified: 0, message: "dispatch target host is unavailable or foreign" };
    }
  } catch (error) {
    return { outcome: "EXTERNAL_UNAVAILABLE", subject: projectId, expected: 1, attempted: 0, verified: 0, message: `dispatch project and host facts are unavailable: ${String(error)}` };
  }
  return null;
}

async function finalizeDispatchIntent(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  request: ApplyRequest,
  intent: PreparedDispatchIntent,
  threadId: string,
  configProof: WorkItemDispatchConfigProof,
): Promise<FoundationResult> {
  return applyLiveAuthorizedMutation(bb, db, {
    projectId: request.projectId,
    operationClass: "work_item_transition",
    idempotencyKey: `${request.idempotencyKey}-finalize`,
    actorReceiptId: request.actorReceiptId,
    expectedConfigRevision: request.expectedConfigRevision,
    expectedGovernanceEpoch: request.expectedGovernanceEpoch,
    expectedFenceToken: request.expectedFenceToken,
    repoTargetId: request.repoTargetId,
    domainId: request.domainId,
    taskClass: request.taskClass,
    workItemId: request.workItemId,
    lifecycleState: undefined,
    configRevision: configProof.currentConfigRevision,
    expectedResourceRevision: intent.resourceRevision,
    fixtureContextDigest: configProof.proofDigest,
    reasonCode: "dispatch_intent_finalize",
    workAttempt: { ...request.workAttempt!, threadId },
  }, false, "stop-active");
}

async function reconcileDispatchIntent(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  request: ApplyRequest,
  spawn: z.infer<typeof dispatchSpawnShapeSchema>,
  intentResult: FoundationResult,
  allowRetry: boolean,
  configProof: WorkItemDispatchConfigProof,
): Promise<FoundationResult> {
  const intent = preparedDispatchIntent(db, request);
  if (intent === "ambiguous") return dispatchRecoveryRefusal(request.projectId, "multiple prepared dispatch intents match the recorded idempotency and project", { intent: intentResult });
  if (!intent) return intentResult;

  let threads: DispatchThread[];
  try {
    threads = await dispatchThreadInventory(bb, request.projectId);
  } catch (error) {
    return dispatchRecoveryRefusal(request.projectId, `complete native dispatch inventory is unavailable: ${String(error)}`, { intent: intentResult });
  }
  const marker = `[dispatch:${request.idempotencyKey}]`;
  const replayTitle = String(spawn.title ?? "lane");
  if (intent.title !== null && replayTitle !== intent.title) {
    return dispatchRecoveryRefusal(request.projectId, "replay title does not match the recorded dispatch title", { intent: intentResult });
  }
  const expectedTitle = intent.title ?? replayTitle;
  const marked = threads.filter((thread) => thread.title?.includes(marker) === true);
  const exact = marked.filter((thread) =>
    thread.parentThreadId === intent.parentThreadId &&
    thread.archivedAt === null &&
    thread.title === `${expectedTitle} ${marker}`,
  );
  if (marked.length > 1 || exact.length > 1 || (marked.length === 1 && exact.length !== 1)) {
    return dispatchRecoveryRefusal(request.projectId, "native dispatch evidence is foreign, multiple, or not bound to the recorded parent", { intent: intentResult, matches: marked.map((thread) => ({ id: thread.id, parentThreadId: thread.parentThreadId, title: thread.title })) });
  }
  if (exact.length === 1) return finalizeDispatchIntent(bb, db, request, intent, exact[0]!.id, configProof);
  if (!allowRetry) return dispatchRecoveryRefusal(request.projectId, "native dispatch inventory proves no exact thread, but the prior spawn outcome is not retryable", { intent: intentResult });
  if (request.workAttempt?.assignmentKind === "review" && request.workAttempt.candidateKind === "local") {
    const finalEnvironmentRefusal = await dispatchEnvironmentPreflight(bb, request.projectId, spawn.environment, configProof, request.workAttempt);
    if (finalEnvironmentRefusal) return finalEnvironmentRefusal;
  }
  try {
    const retried = await spawnDispatchThread(bb, spawn, request.idempotencyKey);
    if (
      retried.projectId !== request.projectId ||
      retried.parentThreadId !== intent.parentThreadId ||
      retried.title !== `${expectedTitle} ${marker}`
    ) {
      return dispatchRecoveryRefusal(request.projectId, "native retry returned a foreign or wrong-parent thread", { intent: intentResult, thread: retried });
    }
    return finalizeDispatchIntent(bb, db, request, intent, retried.id, configProof);
  } catch (error) {
    return reconcileDispatchIntent(bb, db, request, spawn, intentResult, false, configProof).then((result) =>
      result.outcome === "EXTERNAL_DELIVERY_AMBIGUOUS"
        ? { ...result, message: `lane spawn failed after a complete no-match recovery retry: ${String(error)}; ${result.message ?? "reconciliation required"}` }
        : result,
    );
  }
}

async function serializeDispatchRecovery(
  request: ApplyRequest,
  recover: () => Promise<FoundationResult>,
): Promise<FoundationResult> {
  const key = request.projectId;
  const previous = dispatchRecoveryQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(recover);
  dispatchRecoveryQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (dispatchRecoveryQueues.get(key) === current) dispatchRecoveryQueues.delete(key);
  }
}

type WorkItemAttemptTerminalizationPolicy = "refuse-active" | "stop-active";
type PreMutationGuard = () => Promise<FoundationResult | null>;
type LiveThreadEvent = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];

function evidenceUnavailable(projectId: string, message: string): FoundationResult {
  return { outcome: "EXTERNAL_UNAVAILABLE", subject: projectId, expected: 1, attempted: 1, verified: 0, message };
}

async function completeNativeThreadEvents(sdk: BbPluginApi["sdk"], threadId: string): Promise<LiveThreadEvent[]> {
  const events: LiveThreadEvent[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await sdk.threads.events.list({ threadId, afterSeq: String(afterSeq), limit: "1000" });
    let pageAfterSeq = afterSeq;
    for (const event of page) {
      if (event.threadId !== threadId || !Number.isSafeInteger(event.seq) || event.seq <= pageAfterSeq) {
        throw new Error("native event inventory is foreign, unordered, or incomplete");
      }
      pageAfterSeq = event.seq;
    }
    events.push(...page);
    if (page.length < 1000) return events;
    const next = pageAfterSeq;
    if (next <= afterSeq) throw new Error("native event inventory did not advance");
    afterSeq = next;
  }
}

function nativeTurnId(event: LiveThreadEvent): string | null {
  return event.scope?.kind === "turn" && typeof event.scope.turnId === "string" && event.scope.turnId.length > 0 ? event.scope.turnId : null;
}

function nativeEventData(event: LiveThreadEvent): Record<string, unknown> {
  if (event.data === null || typeof event.data !== "object" || Array.isArray(event.data)) throw new Error("native event data is malformed");
  return event.data as Record<string, unknown>;
}

type LiveTerminalIdentity = Pick<NonNullable<ApplyRequest["terminalReport"]>, "nativeEventId" | "nativeEventSeq" | "nativeTurnId">;

function liveTerminalReader(
  sdk: BbPluginApi["sdk"],
  db: SqliteDatabase,
  request: ApplyRequest,
): Promise<ExecutionAttemptEvidenceReader | FoundationResult> {
  const report = request.terminalReport;
  if (!report || !request.workItemId || !request.executionAttemptId) return Promise.resolve(evidenceUnavailable(request.projectId, "terminal report identity is unavailable"));
  return liveTerminalEvidenceReader(sdk, db, {
    projectId: request.projectId,
    workItemId: request.workItemId,
    executionAttemptId: request.executionAttemptId,
  }, report);
}

function liveTerminalEvidenceReader(
  sdk: BbPluginApi["sdk"],
  db: SqliteDatabase,
  request: { projectId: string; workItemId: string; executionAttemptId: string },
  report: LiveTerminalIdentity,
): Promise<ExecutionAttemptEvidenceReader | FoundationResult> {
  const workItemId = request.workItemId;
  const executionAttemptId = request.executionAttemptId;
  const attempt = db.prepare("SELECT * FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ?").get(request.projectId, request.executionAttemptId) as Record<string, unknown> | undefined;
  const workItem = db.prepare("SELECT * FROM work_items WHERE project_id = ? AND work_item_id = ?").get(request.projectId, request.workItemId) as Record<string, unknown> | undefined;
  if (!attempt || !workItem) return Promise.resolve(evidenceUnavailable(request.projectId, "canonical terminal attempt or WorkItem is unavailable"));
  const threadId = typeof attempt.thread_id === "string" ? attempt.thread_id : null;
  if (!threadId) return Promise.resolve(evidenceUnavailable(request.projectId, "terminal attempt has no native thread"));
  return (async () => {
    try {
      const thread = await sdk.threads.get({ threadId });
      // #718: work-attempt rows never persisted environment_id, so the native
      // thread's environment is the attempt's environment when unpersisted; a
      // persisted identity (seat attempts) still must match exactly.
      if (thread.projectId !== request.projectId || thread.id !== threadId || thread.environmentId === null || (typeof attempt.environment_id === "string" && attempt.environment_id !== thread.environmentId)) throw new Error("native terminal thread is foreign or has no exact environment");
      const events = await completeNativeThreadEvents(sdk, threadId);
      const turnId = report.nativeTurnId;
      const completions = events.filter((event) => event.type === "turn/completed" && nativeTurnId(event) === turnId);
      if (completions.length !== 1) throw new Error("exact native completion is missing or ambiguous");
      const completion = completions[0]!;
      const completionData = nativeEventData(completion);
      if (completion.id !== report.nativeEventId || completion.seq !== report.nativeEventSeq || completionData.status !== "completed") {
        throw new Error("exact native completion is missing or not completed");
      }
      const providerThreadId = typeof completionData.providerThreadId === "string" && completionData.providerThreadId.length > 0 ? completionData.providerThreadId : null;
      if (!providerThreadId) throw new Error("native completion provider thread is unavailable");
      const starts = events.filter((event) => event.type === "turn/started" && nativeTurnId(event) === turnId);
      if (starts.length !== 1) throw new Error("native completion start correlation is missing or ambiguous");
      const started = starts[0]!;
      const startedData = nativeEventData(started);
      if (started.seq >= completion.seq || startedData.providerThreadId !== providerThreadId) throw new Error("native completion start correlation is foreign or unordered");
      const accepted = events.filter((event) => event.type === "turn/input/accepted" && nativeTurnId(event) === turnId);
      const inputCorrelations = accepted.map((acceptedEvent) => {
        const acceptedData = nativeEventData(acceptedEvent);
        const requestId = typeof acceptedData.clientRequestId === "string" && acceptedData.clientRequestId.length > 0 ? acceptedData.clientRequestId : null;
        if (!requestId) throw new Error("native accepted input request ID is unavailable");
        const requestEvents = events.filter((event) => event.type === "client/turn/requested" && nativeEventData(event).requestId === requestId);
        if (requestEvents.length !== 1) throw new Error("native execution request is missing or ambiguous");
        const requestEvent = requestEvents[0]!;
        if (requestEvent.scope?.kind !== "thread" && requestEvent.scope?.kind !== "turn") throw new Error("native execution request scope is malformed");
        const requestScopeTurnId = nativeTurnId(requestEvent);
        if (requestScopeTurnId !== null && requestScopeTurnId !== turnId || requestEvent.seq >= acceptedEvent.seq || acceptedEvent.seq >= completion.seq) throw new Error("native execution request is foreign to the exact turn");
        if (acceptedData.providerThreadId !== providerThreadId) throw new Error("native accepted input provider thread is foreign");
        return { acceptedEvent, requestEvent };
      });
      const origins = inputCorrelations.filter(({ requestEvent }) => requestEvent.seq < started.seq);
      if (origins.length !== 1) throw new Error("native completion input correlation is missing or ambiguous");
      const { acceptedEvent, requestEvent } = origins[0]!;
      const requestData = nativeEventData(requestEvent);
      if (typeof requestData.execution !== "object" || requestData.execution === null || Array.isArray(requestData.execution)) throw new Error("exact native execution request is missing");
      const execution = requestData.execution as Record<string, unknown>;
      const profileFields = ["model", "reasoningLevel", "permissionMode", "serviceTier"].map((field) => execution[field]);
      if (profileFields.some((field) => typeof field !== "string" || field.length === 0) || execution.source !== "client/turn/requested") throw new Error("native execution profile is incomplete");
      if (
        requestEvent.seq >= acceptedEvent.seq ||
        requestEvent.seq >= started.seq ||
        acceptedEvent.seq >= completion.seq ||
        started.seq >= completion.seq ||
        startedData.providerThreadId !== providerThreadId
      ) throw new Error("native completion start correlation is foreign or unordered");
      if (events.some((event) => event.type === "provider/modelFallback" && (nativeTurnId(event) === turnId || nativeEventData(event).providerThreadId === providerThreadId))) throw new Error("native completion correlation is ambiguous");
      const profile = {
        providerId: thread.providerId,
        model: execution.model as string,
        reasoningLevel: execution.reasoningLevel as string,
        permissionMode: execution.permissionMode as string,
        serviceTier: execution.serviceTier as string,
        visibility: thread.visibility,
      };
      const environment = await sdk.environments.get({ environmentId: thread.environmentId });
      if (environment.id !== thread.environmentId || environment.projectId !== request.projectId || environment.projectId !== thread.projectId) throw new Error("native terminal environment is foreign");
      const status = await sdk.environments.status({ environmentId: thread.environmentId });
      if (status.outcome !== "available") throw new Error("native terminal checkout status is unavailable");
      const checkout = status.workspace.checkout;
      if (typeof attempt.branch_name === "string" && (checkout.kind !== "branch" || checkout.branchName !== attempt.branch_name)) throw new Error("native terminal branch is foreign");
      const checkoutHeadSha = checkout.kind === "branch" || checkout.kind === "detached" ? checkout.headSha : null;
      if (typeof attempt.candidate_sha === "string" && checkoutHeadSha !== attempt.candidate_sha) throw new Error("native terminal candidate is foreign");
      const candidateObservation = {
        projectId: request.projectId,
        workItemId,
        executionAttemptId,
        repoTargetId: workItem.repo_target_id,
        resourceRevision: workItem.resource_revision,
        environmentId: thread.environmentId,
        branchName: attempt.branch_name,
        baseSha: attempt.base_sha,
        candidateSha: attempt.candidate_sha,
        checkout: status.workspace.checkout,
        workingTree: status.workspace.workingTree,
      };
      const nativeReceipt = {
        projectId: request.projectId,
        workItemId,
        executionAttemptId,
        threadId,
        turnId,
        requestEvent: { id: requestEvent.id, seq: requestEvent.seq },
        acceptedEvent: { id: acceptedEvent.id, seq: acceptedEvent.seq },
        startedEvent: { id: started.id, seq: started.seq },
        completionEvent: { id: completion.id, seq: completion.seq, providerThreadId, status: completionData.status },
      };
      const actualProfileDigest = sha256(canonicalJson(profile));
      const nativeReceiptDigest = sha256(canonicalJson(nativeReceipt));
      const candidateObservationDigest = sha256(canonicalJson(candidateObservation));
      const evidence = [
        { kind: "native-completion", digest: sha256(canonicalJson({ id: completion.id, seq: completion.seq, threadId, turnId, status: completionData.status })), ref: completion.id },
        { kind: "native-profile", digest: actualProfileDigest, ref: requestEvent.id },
        { kind: "native-candidate", digest: candidateObservationDigest, ref: thread.environmentId },
      ];
      const authoritative: AuthoritativeTerminalEvidence = {
        projectId: request.projectId,
        workItemId,
        executionAttemptId,
        repoTargetId: String(workItem.repo_target_id),
        resourceRevision: Number(workItem.resource_revision),
        assignmentId: (attempt.assignment_id as string | null) ?? null,
        roleId: (attempt.role_id as AuthoritativeTerminalEvidence["roleId"]) ?? null,
        roleGeneration: (attempt.role_generation as number | null) ?? null,
        environmentId: (attempt.environment_id as string | null) ?? thread.environmentId,
        threadId,
        branchName: (attempt.branch_name as string | null) ?? null,
        baseSha: (attempt.base_sha as string | null) ?? null,
        candidateSha: (attempt.candidate_sha as string | null) ?? null,
        nativeReceiptDigest,
        actualProfileDigest,
        candidateObservationDigest,
        nativeEventId: completion.id,
        nativeEventSeq: completion.seq,
        nativeTurnId: turnId,
        evidence,
      };
      return { terminal: () => authoritative, historical: () => { throw new Error("historical evidence reader is not available for a terminal-only request"); } } satisfies ExecutionAttemptEvidenceReader;
    } catch (error) {
      return evidenceUnavailable(request.projectId, `authoritative terminal evidence unavailable: ${String(error)}`);
    }
  })();
}

async function buildLiveTerminalReport(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  input: z.infer<typeof terminalReportBuilderInputSchema>,
  callerThreadId: string,
): Promise<unknown> {
  if (!db) return { outcome: "CANONICAL_STORE_UNAVAILABLE", subject: input.projectId, expected: 1, attempted: 0, verified: 0, message: "canonical SQLite store is unavailable" } satisfies FoundationResult;
  const attempt = db.prepare(
    "SELECT thread_id FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ? AND work_item_id = ?",
  ).get(input.projectId, input.executionAttemptId, input.workItemId) as { thread_id: string | null } | undefined;
  if (!attempt || attempt.thread_id !== callerThreadId) {
    return { outcome: "TERMINAL_REPORT_AMBIGUOUS", subject: input.projectId, expected: 1, attempted: 0, verified: 0, message: "terminal report builder caller thread does not match the canonical attempt" } satisfies FoundationResult;
  }
  const resolved = await liveTerminalEvidenceReader(bb.sdk, db, input, {
    nativeEventId: input.nativeEventId,
    nativeEventSeq: input.nativeEventSeq,
    nativeTurnId: input.nativeTurnId,
  });
  if ("outcome" in resolved) return resolved;
  return buildTerminalReport({ evidence: resolved.terminal({
    projectId: input.projectId,
    workItemId: input.workItemId,
    executionAttemptId: input.executionAttemptId,
    nativeEventId: input.nativeEventId,
    nativeEventSeq: input.nativeEventSeq,
    nativeTurnId: input.nativeTurnId,
  }), outcome: input.outcome, reasonCode: input.reasonCode });
}

async function liveZeroRealWriterGuard(
  bb: BbPluginApi,
  db: SqliteDatabase,
  projectId: string,
  workItemId: string,
): Promise<boolean> {
  const active = db.prepare(
    `SELECT thread_id FROM execution_attempts
     WHERE project_id = ? AND work_item_id = ? AND origin = 'work_item'
       AND assignment_kind = 'write' AND state IN (${WORK_ITEM_CAPACITY_ATTEMPT_STATES.map(() => "?").join(", ")})`,
  ).all(projectId, workItemId, ...WORK_ITEM_CAPACITY_ATTEMPT_STATES) as Array<{ thread_id: string | null }>;
  if (active.length > 0) return false;
  const threads = await listAllProjectThreads((args) => bb.sdk.threads.list({ ...args, hasParent: true, includeHidden: true, archived: false }), projectId);
  if (threads.some((thread) => ["active", "starting"].includes(thread.status) && thread.projectId === projectId)) return false;
  return true;
}

async function liveHistoricalReader(
  bb: BbPluginApi,
  db: SqliteDatabase,
  request: ApplyRequest,
): Promise<ExecutionAttemptEvidenceReader | FoundationResult> {
  const evidence = request.interruption;
  const correction = request.historicalCorrection;
  if (!evidence || !request.workItemId || !request.executionAttemptId) return evidenceUnavailable(request.projectId, "interruption identity is unavailable");
  const attempt = db.prepare("SELECT * FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ?").get(request.projectId, request.executionAttemptId) as Record<string, unknown> | undefined;
  const workItem = db.prepare("SELECT * FROM work_items WHERE project_id = ? AND work_item_id = ?").get(request.projectId, request.workItemId) as Record<string, unknown> | undefined;
  if (!attempt || !workItem || typeof attempt.thread_id !== "string") return evidenceUnavailable(request.projectId, "historical canonical attempt, WorkItem, or thread is unavailable");
  try {
    const events = await completeNativeThreadEvents(bb.sdk, attempt.thread_id);
    const expectedEvents = correction?.evidence ?? [{ eventId: evidence.nativeEventId, eventSeq: evidence.nativeEventSeq }];
    if (expectedEvents.some((event, index) => index > 0 && expectedEvents[index - 1]!.eventSeq >= event.eventSeq)) throw new Error("historical native evidence is unordered or duplicated");
    if (correction && expectedEvents.length !== 2) throw new Error("historical correction requires exactly one interruption and one interrupted completion");
    const resolvedEvents = expectedEvents.map((expected) => {
      const event = events.find((candidate) => candidate.id === expected.eventId && candidate.seq === expected.eventSeq);
      if (!event || event.threadId !== attempt.thread_id) throw new Error("historical native event is missing or foreign");
      return event;
    });
    const primaryEvent = resolvedEvents[0];
    if (!primaryEvent || primaryEvent.type !== "system/thread/interrupted" || (correction && primaryEvent.data.reason !== "manual-stop")) {
      throw new Error("historical primary interruption is not the exact manual-stop event");
    }
    const primary: AuthoritativeHistoricalInterruption["evidence"][number] = {
      eventId: primaryEvent.id,
      eventSeq: primaryEvent.seq,
      threadId: primaryEvent.threadId,
      eventType: primaryEvent.type,
      turnId: null,
      providerThreadId: null,
      status: null,
      reason: primaryEvent.data.reason,
    } as const;
    const completionEvent = correction ? resolvedEvents[1] : undefined;
    let completion: AuthoritativeHistoricalInterruption["evidence"][number] | null = null;
    if (completionEvent) {
      if (completionEvent.type !== "turn/completed" || completionEvent.data.status !== "interrupted" || typeof completionEvent.data.providerThreadId !== "string") {
        throw new Error("historical completion is not the exact interrupted turn completion");
      }
      const turnId = nativeTurnId(completionEvent);
      if (!turnId) throw new Error("historical interrupted completion has no exact turn identity");
      const started = events.filter((event) => event.type === "turn/started"
        && event.threadId === attempt.thread_id
        && nativeTurnId(event) === turnId
        && event.data.providerThreadId === completionEvent.data.providerThreadId);
      if (started.length !== 1) throw new Error("historical interrupted completion has no unique provider-correlated turn start");
      completion = {
        eventId: completionEvent.id,
        eventSeq: completionEvent.seq,
        threadId: completionEvent.threadId,
        eventType: completionEvent.type,
        turnId,
        providerThreadId: completionEvent.data.providerThreadId,
        status: completionEvent.data.status,
        reason: null,
      };
    }
    const eventRows = completion ? [primary, completion] : [primary];
    if (primary.eventId !== evidence.nativeEventId || primary.eventSeq !== evidence.nativeEventSeq || primary.threadId !== evidence.threadId || primary.reason !== evidence.reason) {
      throw new Error("historical primary interruption evidence is not exact");
    }
    const zeroRealWriter = await liveZeroRealWriterGuard(bb, db, request.projectId, request.workItemId);
    const authoritative: AuthoritativeHistoricalInterruption = {
      projectId: request.projectId,
      workItemId: request.workItemId,
      executionAttemptId: request.executionAttemptId,
      repoTargetId: String(workItem.repo_target_id),
      resourceRevision: Number(workItem.resource_revision),
      threadId: attempt.thread_id,
      reason: primary.reason,
      nativeEventId: primary.eventId,
      nativeEventSeq: primary.eventSeq,
      nativeTurnId: null,
      evidenceDigest: sha256(canonicalJson({ projectId: request.projectId, workItemId: request.workItemId, executionAttemptId: request.executionAttemptId, threadId: attempt.thread_id, reason: primary.reason, nativeEventId: primary.eventId, nativeEventSeq: primary.eventSeq, nativeTurnId: null })),
      correctionEvidenceDigest: sha256(canonicalJson({ projectId: request.projectId, workItemId: request.workItemId, executionAttemptId: request.executionAttemptId, threadId: attempt.thread_id, reason: primary.reason, evidence: eventRows })),
      evidence: eventRows,
      zeroRealWriter: correction ? zeroRealWriter : true,
    };
    return { terminal: () => { throw new Error("terminal evidence reader is not available for a historical request"); }, historical: () => authoritative } satisfies ExecutionAttemptEvidenceReader;
  } catch (error) {
    return evidenceUnavailable(request.projectId, `authoritative historical evidence unavailable: ${String(error)}`);
  }
}

async function prepareWorkItemAttemptTerminalization(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  request: z.infer<typeof applyRequestSchema>,
  policy: WorkItemAttemptTerminalizationPolicy,
): Promise<FoundationResult | null> {
  if (request.operationClass !== "work_item_transition" || !db) return null;
  const terminalizesWriter = request.lifecycleState === "review_pending" ||
    ["blocked", "failed", "cancelled"].includes(request.lifecycleState ?? "") ||
    (request.lifecycleState === undefined && request.workAttempt?.assignmentKind === "write");
  if (!terminalizesWriter) return null;
  const attempts = db.prepare(
    `SELECT thread_id FROM execution_attempts
     WHERE project_id = ? AND work_item_id = ? AND origin = 'work_item'
       AND assignment_kind = 'write' AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown')
     ORDER BY attempt_ordinal DESC`,
  ).all(request.projectId, request.workItemId) as Array<{ thread_id: string | null }>;
  const attempt = attempts.find((candidate) => candidate.thread_id !== null);
  if (!attempt) {
    // A dispatch finalization is itself the terminalization point for the old writer;
    // its newly prepared replacement has no native thread yet and is not the old lane.
    if (request.lifecycleState === undefined && request.workAttempt?.threadId && attempts.length > 0) return null;
    if (attempts.length === 0) return null;
    return { outcome: "WORK_ITEM_STATE_INVALID", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "writing attempt terminalization requires a bound lane with native stop evidence" };
  }
  const threadId = attempt.thread_id;
  if (!threadId) return null;
  let lane: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
  try {
    lane = await bb.sdk.threads.get({ threadId });
    if (policy === "stop-active" && lane.status !== "idle") {
      await bb.sdk.threads.stop({ threadId });
      await bb.sdk.threads.wait({ threadId, status: "idle", timeoutMs: FLEET_WATCHDOG_STOPPING_WAIT_MS });
      lane = await bb.sdk.threads.get({ threadId });
    }
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
  terminalizationPolicy: WorkItemAttemptTerminalizationPolicy = "refuse-active",
  githubIssueReader: ((owner: string, repo: string, issueNumber: number) => GitHubIssueSnapshot | null) | null = null,
  githubAdapter: GitHubIssueAdapter | null = null,
  preMutationGuard?: PreMutationGuard,
  allowThreadlessPreparedClosure = false,
  allowStrandedExecutionAttemptClosure = false,
  authenticatedNativeCaller: AuthenticatedNativeCaller | null = null,
): Promise<FoundationResult> {
  const parsed = applyRequestSchema.safeParse(input);
  if (parsed.success && parsed.data.threadlessPreparedClosure !== undefined && !allowThreadlessPreparedClosure) {
    return { outcome: "INVALID_INPUT", subject: parsed.data.projectId, expected: 1, attempted: 0, verified: 0, message: "thread-less prepared closure is accepted only through the governed live inventory seam" };
  }
  if (parsed.success && parsed.data.strandedExecutionAttemptClosure !== undefined && !allowStrandedExecutionAttemptClosure) {
    return { outcome: "INVALID_INPUT", subject: parsed.data.projectId, expected: 1, attempted: 0, verified: 0, message: "stranded execution closure is accepted only through the governed native evidence seam" };
  }
  if (parsed.success && db) {
    let request: ApplyRequest | null = null;
    try {
      request = parseApplyRequest(input);
    } catch {
      // Preserve the existing INVALID_INPUT result for requests rejected by the strict projection parser.
    }
    if (request) {
      const replay = checkMutationIdempotency(db, request);
      if (replay) return replay;
    }
  }
  if (parsed.success && terminalizationPolicy === "stop-active") {
    const authorized = applyAuthorizedMutation(db, input, githubAdapter, await readLiveRoleFactReader(bb.sdk, bb.server.loopbackBaseUrl, parsed.data), null, null, githubIssueReader, null, true, authenticatedNativeCaller);
    if (authorized.outcome !== "OK" || authorized.replay) return authorized;
  }
  if (parsed.success && parsed.data.threadlessPreparedClosure === undefined && parsed.data.strandedExecutionAttemptClosure === undefined) {
    const laneGuard = await prepareWorkItemAttemptTerminalization(bb, db, parsed.data, terminalizationPolicy);
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
  const preMutationRefusal = preMutationGuard === undefined ? null : await preMutationGuard();
  if (preMutationRefusal) return preMutationRefusal;
  let evidenceReader: ExecutionAttemptEvidenceReader | null = null;
  if (parsed.success && db && parsed.data.operationClass === "execution_attempt_terminal_report") {
    const resolved = await liveTerminalReader(bb.sdk, db, parsed.data);
    if ("outcome" in resolved) return resolved;
    evidenceReader = resolved;
  } else if (parsed.success && db && parsed.data.operationClass === "execution_attempt_interruption") {
    const resolved = await liveHistoricalReader(bb, db, parsed.data);
    if ("outcome" in resolved) return resolved;
    evidenceReader = resolved;
  }
  const result = applyAuthorizedMutation(db, input, githubAdapter, reader, null, null, githubIssueReader ?? (parsed.success ? projectGithubIssueReader(db, parsed.data.projectId) : readGithubIssueForBackfill), evidenceReader, false, authenticatedNativeCaller);
  await deliverSucceededRoleGenerationBrief(bb, db, input, result);
  return result;
}

async function applyLiveAuthorizedMutationAsync(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  input: unknown,
  allowCachedConsumerRollout = false,
  terminalizationPolicy: WorkItemAttemptTerminalizationPolicy = "refuse-active",
  githubIssueReader: ((owner: string, repo: string, issueNumber: number) => GitHubIssueSnapshot | null) | null = null,
  githubAdapter: GitHubIssueAdapter | null = null,
): Promise<FoundationResult> {
  const parsed = applyRequestSchema.safeParse(input);
  if (parsed.success && (parsed.data.threadlessPreparedClosure !== undefined || parsed.data.strandedExecutionAttemptClosure !== undefined)) {
    return { outcome: "INVALID_INPUT", subject: parsed.data.projectId, expected: 1, attempted: 0, verified: 0, message: "specialized execution closure is accepted only through its governed live evidence seam" };
  }
  if (parsed.success && parsed.data.threadlessPreparedClosure === undefined) {
    const laneGuard = await prepareWorkItemAttemptTerminalization(bb, db, parsed.data, terminalizationPolicy);
    if (laneGuard) return laneGuard;
  }
  if (!allowCachedConsumerRollout && parsed.success && parsed.data.decisionEvidence?.some((evidence) => evidence.evidenceId === "cached-consumer-v22-rollout-receipt")) {
    return cachedConsumerRolloutRefusal(parsed.data.projectId, "cached-consumer rollout evidence is accepted only through the live rollout caller");
  }
  const reader = parsed.success ? await readLiveRoleFactReader(bb.sdk, bb.server.loopbackBaseUrl, parsed.data) : null;
  let evidenceReader: ExecutionAttemptEvidenceReader | null = null;
  if (parsed.success && db && parsed.data.operationClass === "execution_attempt_terminal_report") {
    const resolved = await liveTerminalReader(bb.sdk, db, parsed.data);
    if ("outcome" in resolved) return resolved;
    evidenceReader = resolved;
  } else if (parsed.success && db && parsed.data.operationClass === "execution_attempt_interruption") {
    const resolved = await liveHistoricalReader(bb, db, parsed.data);
    if ("outcome" in resolved) return resolved;
    evidenceReader = resolved;
  }
  const result = await applyAuthorizedMutationAsync(db, input, githubAdapter, reader, null, null, githubIssueReader ?? (parsed.success ? projectGithubIssueReader(db, parsed.data.projectId) : readGithubIssueForBackfill), evidenceReader);
  await deliverSucceededRoleGenerationBrief(bb, db, input, result);
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

function canonicalSeatBriefInjection(rules: string): string {
  const marker = "Seat brief injection: ";
  const start = rules.indexOf(marker);
  const end = start < 0 ? -1 : rules.indexOf("\n", start + marker.length);
  if (start < 0 || end < 0) throw new Error("role brief bundle is missing the canonical messaging doctrine");
  return rules.slice(start, end);
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
    bundle.ponytail.trimEnd(),
    "",
    bundle.roles[input.role].trimEnd(),
    "",
    canonicalSeatBriefInjection(bundle.rules),
    "",
    "## Read in order",
    `docs/roles/${input.role}.md, docs/operations-model.md, docs/ponytail.md, docs/rules.md, docs/threat-model.md.`,
    "",
    "## Live pointers",
    `project=${project.name} (${project.id}); sources=${project.sources.map((source) => source.id).join(", ") || "none"}; canonical=${pointers.canonicalStoreQuery}; handoff=~/.bb/thread-storage/<threadId>/handoff.md; seats=${currentSeats.map((seat) => `${seat.roleId}@${seat.generation}:${seat.threadId}`).join(", ") || "none"}`,
  ].join("\n");
  return { role: input.role, roleContent: bundle.roles[input.role], ponytail: bundle.ponytail, rules: bundle.rules, project: { id: project.id, name: project.name, sourceIds: project.sources.map((source) => source.id) }, pointers, prompt };
}

async function sendRoleBrief(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  projectId: string,
  threadId: string,
  role: z.infer<typeof roleBriefRoleSchema>,
  generationEventType?: string,
): Promise<void> {
  const brief = await composeRoleBrief(bb, db, { projectId, role });
  const ceremony = generationEventType === "role_generation_created"
    ? "first-generation creation"
    : generationEventType === "role_generation_succeeded"
      ? "succession"
      : null;
  // created is observe-only and can race the first turn; queue instead of waiting for idle.
  await sendWhenThreadReady(bb, {
    threadId,
    mode: "queue-if-active",
    input: [{ type: "text", visibility: "agent-only", text: ceremony ? `Canonical role-generation event: ${ceremony}.\n\n${brief.prompt}` : brief.prompt, mentions: [] }],
  }, projectId);
}

async function enqueueAutomatedTell(
  bb: BbPluginApi,
  request: Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0],
  waitForIdle: boolean,
  projectId: string,
): Promise<void> {
  // ponytail: this process-local queue covers this plugin’s senders; a host atomic send-if-idle API is the cross-process upgrade.
  const queueKey = JSON.stringify([projectId, request.threadId]);
  const previous = automatedTellQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    if (waitForIdle) await bb.sdk.threads.wait({ threadId: request.threadId, status: "idle", timeoutMs: AUTOMATED_TELL_IDLE_WAIT_MS });
    await bb.sdk.threads.send(request);
  });
  automatedTellQueues.set(queueKey, current);
  try {
    await current;
  } finally {
    if (automatedTellQueues.get(queueKey) === current) automatedTellQueues.delete(queueKey);
  }
}

async function sendWhenThreadReady(bb: BbPluginApi, request: Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0], projectId: string): Promise<void> {
  await enqueueAutomatedTell(bb, request, false, projectId);
}

async function sendWhenThreadIdle(bb: BbPluginApi, request: Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0], projectId: string): Promise<void> {
  await enqueueAutomatedTell(bb, request, true, projectId);
}

async function deliverSucceededRoleGenerationBrief(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  input: unknown,
  result: FoundationResult,
): Promise<void> {
  const request = applyRequestSchema.safeParse(input);
  if (!request.success || result.outcome !== "OK" || request.data.operationClass !== "role_generation_succession" || !request.data.roleContext || !request.data.roleId) return;
  try {
    await sendRoleBrief(bb, db, request.data.projectId, request.data.roleContext.threadId, roleBriefRole(request.data.roleId), result.eventType);
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
  archived_at_ms: number | null;
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
    archivedAtMs: row.archived_at_ms,
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
  includeArchived = false,
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
  const archivedClause = includeArchived ? "" : " AND message.archived_at_ms IS NULL";
  const rows = store.prepare(`${operatorMessageSelect}
    WHERE message.project_id = ?${recipientClause}${archivedClause}
    ORDER BY (message.read_at_ms IS NULL) DESC, message.created_at_ms DESC, message.message_id DESC
    LIMIT ${OPERATOR_MESSAGE_LIMIT}`).all(...(recipient === undefined ? [projectId] : [projectId, recipient])) as OperatorMessageRow[];
  const messages = rows.map(operatorMessage);
  return { outcome: "OK", messages: withSenderTitles ? await resolveSenderTitles(bb, messages) : messages };
}

async function archiveOperatorMessage(db: SqliteDatabase | null, bb: BbPluginApi, projectId: string, messageId: number) {
  const store = requireRegisteredInboxProject(db, projectId);
  const now = Date.now();
  // ponytail: archive implies read only for this explicit per-message CLI seam; do not reuse from automation or bulk callers.
  const result = store.prepare(`UPDATE operator_messages
    SET read_at_ms = COALESCE(read_at_ms, ?), archived_at_ms = COALESCE(archived_at_ms, ?)
    WHERE project_id = ? AND message_id = ?`).run(now, now, projectId, messageId);
  if (result.changes !== 1) throw refusal("RESOURCE_UNKNOWN", "operator message does not exist in the requested project");
  return (await resolveSenderTitles(bb, [readOperatorMessage(store, projectId, messageId)]))[0]!;
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
    await bb.sdk.threads.send({
      threadId: message.senderThreadId,
      mode: "steer-if-active",
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

async function readCleanupAttestation(projectId: string, candidates: ReadonlyArray<{ path: string; threadId?: string | null }>) {
  const subjects = candidates.filter((candidate): candidate is { path: string; threadId: string } => typeof candidate.threadId === "string");
  const threadIds = new Set(subjects.map((candidate) => candidate.threadId));
  if (threadIds.size === 0) return { coverage: "known" as const };
  const root = findCheckoutRoot(dirname(fileURLToPath(import.meta.url)));
  if (!root) return { coverage: "blind" as const, reason: "reader-unavailable:checkout-root-unresolved" };
  let atRisk: Awaited<ReturnType<typeof cleanupAttestationFromProfile>> | null = null;
  const affected = new Map<string, { path: string; threadId: string }>();
  for (const threadId of threadIds) {
    const result = await new Promise<{ output: string }>((resolve) => {
      execFile(process.execPath, [join(root, "scripts", "read-executed-profile.mjs"), "--project", projectId, "--thread", threadId], {
        cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
      }, (_error, stdout) => resolve({ output: stdout }));
    });
    try {
      const profile = JSON.parse(result.output) as { environmentDependent?: boolean; outcome?: string; turns?: ReadonlyArray<{ environmentDependent?: boolean }> };
      const attestation = cleanupAttestationFromProfile(profile);
      if (attestation.coverage === "blind") return attestation;
      if (attestation.coverage === "at-risk") {
        atRisk = attestation;
        for (const subject of subjects.filter((candidate) => candidate.threadId === threadId)) affected.set(`${subject.path}\u0000${threadId}`, subject);
      }
    } catch {
      return { coverage: "blind" as const, reason: `reader-unreadable:${threadId}` };
    }
  }
  return atRisk?.coverage === "at-risk" ? withCleanupAttestationSubjects(atRisk, [...affected.values()]) : atRisk ?? { coverage: "known" as const };
}

export async function reportProjectWorktreeCleanup(bb: BbPluginApi, projectId: string, cleanup = cleanupGitWorktrees) {
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
  const entries = listGitWorktrees(source.path);
  const cleanupArgs = [source.path, new Set(threads.map((thread) => thread.id)), liveWorktreeThreadIds, environmentInventoryComplete, protectedEnvironmentPaths, pluginSourceResolved] as const;
  const preliminary = cleanup(...cleanupArgs, { coverage: "known" }, entries);
  const attestation = await readCleanupAttestation(projectId, preliminary.wouldRemove);
  return { ...preliminary, attestation };
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
  if (!command || !["doctor", "export", "apply", "register-project", "dispatch-lane", "github-issue-backfill", "archive-sweep", "worktree-cleanup", "cached-consumer-rollout", "role-list", "wait-register", "wait-list", "wait-validator", "stall-guard", "fleet-watchdog", "send-to-operator", "inbox"].includes(command)) {
    return invalidCli("expected doctor, export, apply, register-project, dispatch-lane, github-issue-backfill, archive-sweep, worktree-cleanup, cached-consumer-rollout, role-list, wait-register, wait-list, wait-validator, stall-guard, fleet-watchdog, send-to-operator, or inbox");
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
    const unknown = unexpectedFlags(args, ["--project", "--recipient", "--mark-read", "--archive"]);
    if (unknown) return invalidCli(`unexpected flag ${unknown}`);
    const recipient = parseFlag(args, "--recipient");
    const markRead = parseFlag(args, "--mark-read");
    const archive = parseFlag(args, "--archive");
    if (markRead !== null || archive !== null) {
      if (markRead !== null && archive !== null) return invalidCli("--mark-read and --archive cannot be used together");
      if (recipient !== null) return invalidCli(`--recipient cannot be used with ${archive !== null ? "--archive" : "--mark-read"}`);
      const messageId = z.coerce.number().int().positive().safeParse(archive ?? markRead);
      if (!messageId.success) return invalidCli(messageId.error.message);
      try {
        const marked = archive !== null
          ? await archiveOperatorMessage(db, bb, projectId, messageId.data)
          : await markOperatorMessageRead(db, bb, projectId, messageId.data);
        return operatorMessagesCliResult(projectId, [marked], archive !== null ? "operator message archived" : "operator message marked read");
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
      return { exitCode: 2, stdout: JSON.stringify({ outcome: "refused", wouldRemove: [], removableCandidateCount: 0, refused: [{ path: "<inventory>", population: "unknown", action: "refuse", reason: error instanceof Error ? error.message : String(error) }], environmentRecordsReleased: false, attestation: { coverage: "blind", reason: "cleanup-inventory-unreadable" } }) };
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
      const githubAdapter = request.operationClass === "github_issue_projection" && request.projectionRecoveryEvidence !== undefined
        ? githubCliAdapterForWorkItem(db, request.projectId, request.workItemId ?? "")
        : null;
      return cliResult(await applyLiveAuthorizedMutation(bb, db, rawRequest, false, "refuse-active", null, githubAdapter));
    } catch (error) {
      return invalidCli(error instanceof Error ? error.message : String(error));
    }
  }
  if (command === "register-project") {
    const unknown = unexpectedFlags(args, ["--project", "--request"]);
    if (unknown) return invalidCli(`unexpected flag ${unknown}`);
    const requestJson = parseFlag(args, "--request");
    if (!requestJson) return invalidCli("--request JSON is required");
    try {
      const request = parseRegisterProjectRequest(JSON.parse(requestJson));
      if (request.projectId !== projectId) return invalidCli("--project does not match request.projectId");
      return cliResult(await applyLiveAuthorizedMutation(bb, db, request));
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
      const backfill = backfillWorkItemGithubIssues(db, projectId, projectGithubIssueReader(db, projectId));
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
  if (ROLE_QUEUE_DECISION_BOUND_MS >= 120_000) throw new Error("project queue decision bound must remain below two minutes");
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
    migrateCanonicalStore(db, (database, statements) => bb.storage.migrate(database, statements));
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
  type RecoveryEpisodeLedger = Record<string, string>;
  const recoveryEpisodeState = (input: unknown): RecoveryEpisodeLedger => {
    if (input === undefined || input === null) return {};
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid error-recovery episode state");
    const state: RecoveryEpisodeLedger = {};
    for (const [key, target] of Object.entries(input)) {
      if (typeof target !== "string" || target.length === 0) throw new Error("invalid error-recovery episode target");
      state[key] = target;
    }
    return state;
  };
  let recoveryEpisodes: RecoveryEpisodeLedger = {};
  let recoveryEpisodesLoaded = false;
  let recoveryEpisodeQueue = Promise.resolve();
  const enqueueRecoveryEpisode = <T>(work: () => Promise<T>): Promise<T> => {
    const result = recoveryEpisodeQueue.then(work);
    recoveryEpisodeQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const loadRecoveryEpisodes = async () => {
    if (recoveryEpisodesLoaded) return;
    recoveryEpisodes = recoveryEpisodeState(await bb.storage.kv.get<unknown>("error-recovery.episodes"));
    recoveryEpisodesLoaded = true;
  };
  const recoverySendTimeouts = new WeakSet<object>();
  const reserveRecoveryEpisode = (key: string) => enqueueRecoveryEpisode(async () => {
    await loadRecoveryEpisodes();
    if (key in recoveryEpisodes) return false;
    const next = { ...recoveryEpisodes, [key]: "native-error-episode" };
    await bb.storage.kv.set("error-recovery.episodes", next);
    recoveryEpisodes = next;
    return true;
  });
  const releaseRecoveryEpisode = (key: string) => enqueueRecoveryEpisode(async () => {
    await loadRecoveryEpisodes();
    if (!(key in recoveryEpisodes)) return;
    const next = { ...recoveryEpisodes };
    delete next[key];
    await bb.storage.kv.set("error-recovery.episodes", next);
    recoveryEpisodes = next;
  });
  const clearRecoveryEpisode = (projectId: string, threadId: string) => enqueueRecoveryEpisode(async () => {
    await loadRecoveryEpisodes();
    const key = JSON.stringify([projectId, threadId]);
    if (!(key in recoveryEpisodes)) return;
    const next = { ...recoveryEpisodes };
    delete next[key];
    await bb.storage.kv.set("error-recovery.episodes", next);
    recoveryEpisodes = next;
  });
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
        `SELECT project_id, role_id, domain_id, role_generation, execution_attempt_id, thread_id
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
            const error = new Error(`error-recovery threads.send timed out after ${ERROR_RECOVERY_IO_TIMEOUT_MS}ms`);
            recoverySendTimeouts.add(error);
            reject(error);
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
  const githubPrBackoff = new Map<string, GithubPrBackoff>();
  const githubPrDeliveryInFlight = new Set<string>();
  let githubPrObservationCycleInFlight: Promise<void> | null = null;
  const readGithubPrPendingWaits = (): GithubPrPendingWait[] => {
    if (!db) return [];
    const rows = db.prepare(
      `SELECT waits.project_id, waits.work_item_id, items.repo_target_id, items.resource_revision,
              waits.pr_execution_attempt_id, waits.pr_waiting_thread_id, waits.pr_waiting_role_id,
              waits.pr_waiting_role_generation, waits.pr_owner, waits.pr_repo, waits.pr_number,
              waits.pr_condition_kind, waits.pr_expected_head_sha, waits.pr_waker_schedule,
              waits.pr_deadline_at_ms, waits.pr_last_observed_semantic_digest
       FROM work_item_waits AS waits
       JOIN work_items AS items
         ON items.project_id = waits.project_id AND items.work_item_id = waits.work_item_id
       WHERE items.lifecycle_state = 'blocked'
         AND waits.waker_kind = 'github_pr'
         AND waits.pr_delivery_state = 'pending'
       ORDER BY waits.project_id, items.repo_target_id, waits.pr_owner, waits.pr_repo, waits.pr_number, waits.work_item_id`,
    ).all() as Array<Record<string, unknown>>;
    return rows.flatMap((row): GithubPrPendingWait[] => {
      const conditionKinds = new Set(["pr_merged", "pr_checks", "pr_review_state"]);
      if (typeof row.project_id !== "string" || typeof row.work_item_id !== "string" || typeof row.repo_target_id !== "string"
        || !Number.isSafeInteger(row.resource_revision) || typeof row.pr_execution_attempt_id !== "string"
        || typeof row.pr_waiting_thread_id !== "string" || typeof row.pr_waiting_role_id !== "string"
        || !Number.isSafeInteger(row.pr_waiting_role_generation) || typeof row.pr_owner !== "string" || typeof row.pr_repo !== "string"
        || !Number.isSafeInteger(row.pr_number) || !conditionKinds.has(String(row.pr_condition_kind))
        || (row.pr_expected_head_sha !== null && typeof row.pr_expected_head_sha !== "string")
        || typeof row.pr_waker_schedule !== "string" || !Number.isSafeInteger(row.pr_deadline_at_ms)
        || typeof row.pr_last_observed_semantic_digest !== "string") return [];
      return [{
        projectId: row.project_id,
        workItemId: row.work_item_id,
        repoTargetId: row.repo_target_id,
        resourceRevision: row.resource_revision as number,
        executionAttemptId: row.pr_execution_attempt_id,
        waitingThreadId: row.pr_waiting_thread_id,
        waitingRoleId: row.pr_waiting_role_id,
        waitingRoleGeneration: row.pr_waiting_role_generation as number,
        owner: row.pr_owner,
        repo: row.pr_repo,
        prNumber: row.pr_number as number,
        conditionKind: row.pr_condition_kind as GithubPrPendingWait["conditionKind"],
        expectedHeadSha: row.pr_expected_head_sha as string | null,
        wakerSchedule: row.pr_waker_schedule,
        deadlineAtMs: row.pr_deadline_at_ms as number,
        lastObservedSemanticDigest: row.pr_last_observed_semantic_digest,
      }];
    });
  };
  const githubPrWake = async (wait: GithubPrPendingWait, eventSequence: number, reservationKey: string): Promise<void> => {
    if (!db) return;
    const deliveryKey = `${reservationKey}:${eventSequence}`;
    if (githubPrDeliveryInFlight.has(deliveryKey)) return;
    githubPrDeliveryInFlight.add(deliveryKey);
    try {
      const bound = db.prepare(
        `SELECT attempts.execution_attempt_id
         FROM execution_attempts AS attempts
         JOIN work_items AS items
           ON items.project_id = attempts.project_id AND items.work_item_id = attempts.work_item_id
         JOIN work_item_waits AS waits
           ON waits.project_id = items.project_id AND waits.work_item_id = items.work_item_id
         WHERE attempts.project_id = ? AND attempts.execution_attempt_id = ? AND attempts.work_item_id = ?
           AND attempts.thread_id = ? AND attempts.role_id = ? AND attempts.role_generation = ?
           AND attempts.state = 'blocked'
           AND items.lifecycle_state = 'blocked' AND waits.waker_kind = 'github_pr'
           AND waits.pr_delivery_state = 'fired'`,
      ).get(
        wait.projectId, wait.executionAttemptId, wait.workItemId, wait.waitingThreadId,
        wait.waitingRoleId, wait.waitingRoleGeneration,
      ) as { execution_attempt_id: string } | undefined;
      if (!bound) {
        bb.log.warn(`github-pr observer wake refused: project=${wait.projectId} workItem=${wait.workItemId} reason=waiting-seat-not-current`);
        return;
      }
      const thread = await bb.sdk.threads.get({ threadId: wait.waitingThreadId });
      if (thread.id !== wait.waitingThreadId || thread.projectId !== wait.projectId || thread.archivedAt !== null || thread.deletedAt !== null) {
        bb.log.warn(`github-pr observer wake refused: project=${wait.projectId} workItem=${wait.workItemId} reason=waiting-thread-archived-or-foreign`);
        return;
      }
      if (thread.status !== "idle" && thread.status !== "active") {
        bb.log.warn(`github-pr observer wake refused: project=${wait.projectId} workItem=${wait.workItemId} reason=waiting-thread-status-${thread.status}`);
        return;
      }
      await withRecoverySendTimeout(wait.waitingThreadId, () => sendWhenThreadReady(bb, {
        threadId: wait.waitingThreadId,
        mode: "queue-if-active",
        input: [{ type: "text", visibility: "agent-only", text: githubPrWakeText(wait.workItemId, eventSequence), mentions: [] }],
      }, wait.projectId));
      bb.log.info(`github-pr observer wake sent: project=${wait.projectId} workItem=${wait.workItemId} event=${eventSequence}`);
    } catch (error) {
      const actor = db.prepare(
        `SELECT receipt_id FROM actor_receipts
         WHERE project_id = ? AND actor_kind = 'plugin' AND subject_id = ? AND role_id IS NULL
           AND verification_state = 'verified' ORDER BY issued_at_ms DESC LIMIT 1`,
      ).get(wait.projectId, PLUGIN_ID) as { receipt_id: string } | undefined;
      const governor = db.prepare(
        "SELECT governance_epoch, fence_token FROM project_governorship_heads WHERE project_id = ?",
      ).get(wait.projectId) as { governance_epoch: number; fence_token: string } | undefined;
      const config = db.prepare(
        "SELECT config_revision FROM project_config_heads WHERE project_id = ?",
      ).get(wait.projectId) as { config_revision: number } | undefined;
      if (actor && governor && config) {
        const ambiguousRequest: ApplyRequest = {
          projectId: wait.projectId,
          operationClass: "github_pr_observation_record",
          idempotencyKey: `${reservationKey}:delivery-ambiguous`,
          actorReceiptId: actor.receipt_id,
          expectedConfigRevision: config.config_revision,
          expectedGovernanceEpoch: governor.governance_epoch,
          expectedFenceToken: governor.fence_token,
          repoTargetId: wait.repoTargetId,
          expectedResourceRevision: wait.resourceRevision,
          workItemId: wait.workItemId,
          executionAttemptId: wait.executionAttemptId,
          githubPrDeliveryDisposition: "delivery_ambiguous",
        };
        const disposition = await applyLiveAuthorizedMutation(bb, db, ambiguousRequest);
        if (disposition.outcome !== "OK") bb.log.warn(`github-pr observer ambiguous delivery retention refused: project=${wait.projectId} workItem=${wait.workItemId} outcome=${disposition.outcome}`);
      }
      bb.log.warn(`github-pr observer wake ambiguous: project=${wait.projectId} workItem=${wait.workItemId} reason=${String(error)}`);
    } finally {
      githubPrDeliveryInFlight.delete(deliveryKey);
    }
  };
  const runGithubPrObservationCycle = async (): Promise<void> => {
    if (githubPrObservationCycleInFlight) return githubPrObservationCycleInFlight;
    const cycle = (async () => {
      if (!db) {
        bb.log.warn("github-pr observer coverage=blind reason=canonical-store-unavailable");
        return;
      }
      let waits: GithubPrPendingWait[];
      try {
        waits = readGithubPrPendingWaits();
      } catch (error) {
        bb.log.warn(`github-pr observer coverage=degraded reason=wait-inventory-unreadable:${String(error)}`);
        return;
      }
      const groups = new Map<string, GithubPrWatchGroup>();
      for (const wait of waits) {
        if (wait.wakerSchedule !== GITHUB_PR_WATCH_SCHEDULE) continue;
        const mapping = githubRepositoryMappings(db, wait.projectId)?.find((candidate) =>
          candidate.repoTargetId === wait.repoTargetId && candidate.owner === wait.owner && candidate.repo === wait.repo,
        );
        if (!mapping) {
          bb.log.warn(`github-pr observer coverage=degraded project=${wait.projectId} workItem=${wait.workItemId} reason=repository-target-unavailable`);
          continue;
        }
        const key = githubPrGroupKey(wait);
        const group = groups.get(key) ?? {
          key,
          projectId: wait.projectId,
          repoTargetId: wait.repoTargetId,
          owner: wait.owner,
          repo: wait.repo,
          prNumber: wait.prNumber,
          connectorHost: mapping.connectorHost,
          waits: [],
        };
        group.waits.push(wait);
        groups.set(key, group);
      }
      const ghPath = githubPrGhPath();
      const now = Date.now();
      for (const group of groups.values()) {
        const prior = githubPrBackoff.get(group.key);
        if (prior && prior.retryAtMs > now) continue;
        let observation: ApplyRequest["githubPrObservation"];
        try {
          const normalized = await observeGithubPullRequest({
            repositoryIdentity: { host: group.connectorHost, owner: group.owner, repo: group.repo },
            pullRequestNumber: group.prNumber,
          }, ghPath === null ? {} : { ghPath });
          observation = normalizedGithubPrObservation(normalized);
          githubPrBackoff.delete(group.key);
        } catch (error) {
          const failures = (prior?.failures ?? 0) + 1;
          githubPrBackoff.set(group.key, { failures, retryAtMs: now + githubPrBackoffDelayMs(failures) });
          const reason = error instanceof GithubPullRequestObservationError ? `${error.reason}:${error.message}` : String(error);
          bb.log.warn(`github-pr observer coverage=degraded project=${group.projectId} repository=${group.owner}/${group.repo} pr=${group.prNumber} reason=${reason}`);
          continue;
        }
        if (!observation) continue;
        const semanticDigest = githubPrSemanticDigest(observation);
        for (const wait of group.waits) {
          if (semanticDigest === wait.lastObservedSemanticDigest && now < wait.deadlineAtMs) continue;
          const actor = db.prepare(
            `SELECT receipt_id FROM actor_receipts
             WHERE project_id = ? AND actor_kind = 'plugin' AND subject_id = ? AND role_id IS NULL
               AND verification_state = 'verified' ORDER BY issued_at_ms DESC LIMIT 1`,
          ).get(wait.projectId, PLUGIN_ID) as { receipt_id: string } | undefined;
          const governor = db.prepare(
            "SELECT governance_epoch, fence_token FROM project_governorship_heads WHERE project_id = ?",
          ).get(wait.projectId) as { governance_epoch: number; fence_token: string } | undefined;
          const config = db.prepare(
            "SELECT config_revision FROM project_config_heads WHERE project_id = ?",
          ).get(wait.projectId) as { config_revision: number } | undefined;
          if (!actor || !governor || !config) {
            bb.log.warn(`github-pr observer coverage=degraded project=${wait.projectId} workItem=${wait.workItemId} reason=authority-unavailable`);
            continue;
          }
          const reservationKey = `github-pr-observation:${githubPrGroupKey(wait)}:${semanticDigest}`;
          const request: ApplyRequest = {
            projectId: wait.projectId,
            operationClass: "github_pr_observation_record",
            idempotencyKey: reservationKey,
            actorReceiptId: actor.receipt_id,
            expectedConfigRevision: config.config_revision,
            expectedGovernanceEpoch: governor.governance_epoch,
            expectedFenceToken: governor.fence_token,
            repoTargetId: wait.repoTargetId,
            expectedResourceRevision: wait.resourceRevision,
            workItemId: wait.workItemId,
            executionAttemptId: wait.executionAttemptId,
            githubPrObservation: observation,
          };
          const result = await applyLiveAuthorizedMutation(bb, db, request);
          const evidence = result.evidence && typeof result.evidence === "object" && !Array.isArray(result.evidence)
            ? result.evidence as { wake?: unknown }
            : {};
          if (result.outcome !== "OK") {
            bb.log.warn(`github-pr observer canonical reservation refused: project=${wait.projectId} workItem=${wait.workItemId} outcome=${result.outcome}`);
            continue;
          }
          if (evidence.wake === true && result.replay !== true && typeof result.eventSequence === "number") await githubPrWake(wait, result.eventSequence, reservationKey);
        }
      }
    })();
    githubPrObservationCycleInFlight = cycle;
    try {
      await cycle;
    } finally {
      if (githubPrObservationCycleInFlight === cycle) githubPrObservationCycleInFlight = null;
    }
  };
  const recoverErroredThread = async (threadId: string, projectId: string, holder?: RoleHolderState, lane?: LaneRecoveryTarget) => {
    const recoveryKey = JSON.stringify([projectId, threadId]);
    if (recoveryInFlight.has(recoveryKey)) {
      bb.log.warn(`error-recovery wake suppressed: project=${projectId} thread=${threadId} reason=recovery-in-flight`);
      return null;
    }
    if (db === null) return null;
    recoveryInFlight.add(recoveryKey);
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
      const latestThread = await withRecoveryTimeout("threads.get", (signal) => bb.sdk.threads.get({ threadId, signal }));
      if (latestThread.id !== threadId || latestThread.projectId !== projectId || latestThread.archivedAt !== null || latestThread.deletedAt !== null) {
        bb.log.error(`error-recovery target unrecoverable: project=${projectId} thread=${threadId} reason=canonical-target-invalid`);
        return RECOVERY_UNRECOVERABLE;
      }
      if (latestThread.status === "idle") {
        await clearRecoveryEpisode(projectId, threadId);
        return false;
      }
      if (latestThread.status !== "error") return false;
      if (!await reserveRecoveryEpisode(recoveryKey)) {
        bb.log.warn(`error-recovery wake suppressed: project=${projectId} thread=${threadId} reason=error-episode-already-recovered`);
        return false;
      }
      // The SDK cannot cancel threads.send. Bound only the duplicate-suppression guard;
      // an expired send remains outstanding and is reported as an anomaly.
      try {
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
      } catch (error) {
        if (!(typeof error === "object" && error !== null && recoverySendTimeouts.has(error))) {
          await releaseRecoveryEpisode(recoveryKey);
        }
        throw error;
      }
      bb.log.warn(`error-recovery wake sent: project=${projectId} thread=${threadId} mode=auto head=${head}`);
      return true;
    } catch (error) {
      bb.log.warn(`error-recovery wake failed: project=${projectId} thread=${threadId} ${String(error)}`);
      return null;
    } finally {
      recoveryInFlight.delete(recoveryKey);
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

  type RoleQueueRead = {
    observedAtMs: number;
    configIdentity: string;
    known: boolean;
    reason: string | null;
    head: { workItemId: string; resourceRevision: number } | null;
    domains: Record<string, { known: boolean; reason: string | null; head: { workItemId: string; resourceRevision: number } | null }>;
  };
  type RoleQueueConfig = { identity: string; repositories: string[]; reason: string | null };
  const roleQueueCache = new Map<string, RoleQueueRead>();
  const roleQueueRefreshes = new Map<string, { configIdentity: string; promise: Promise<RoleQueueRead> }>();
  const readProjectQueueRoleHolders = () => db
    ? readRoleHolderStates(db).filter((holder) => holder.role_id === "project-orchestrator")
    : [];
  const readRoleQueueConfig = (projectId: string): RoleQueueConfig => {
    if (!db) return { identity: "canonical-store-unavailable", repositories: [], reason: "canonical-store-unavailable" };
    try {
      const head = db.prepare("SELECT config_revision FROM project_config_heads WHERE project_id = ?").get(projectId) as { config_revision: number } | undefined;
      if (!head) return { identity: "project-config-missing", repositories: [], reason: "configured-repositories-unreadable" };
      const targets = db.prepare(
        `SELECT repo_target_id, remote_url FROM repository_targets
         WHERE project_id = ? AND config_revision = ? ORDER BY repo_target_id`,
      ).all(projectId, head.config_revision) as Array<{ repo_target_id: string; remote_url: string | null }>;
      const identity = canonicalJson({ configRevision: head.config_revision, targets });
      const repositories = targets.map((target) => githubRepository(target.remote_url));
      if (repositories.length === 0 || repositories.some((repository) => repository === null)) {
        return { identity, repositories: [], reason: "configured-repositories-unreadable" };
      }
      if (repositories.length > ROLE_QUEUE_MAX_REPOSITORIES) {
        return { identity, repositories: [], reason: `configured-repository-ceiling:${repositories.length}>${ROLE_QUEUE_MAX_REPOSITORIES}` };
      }
      if (new Set(repositories).size !== repositories.length) {
        return { identity, repositories: [], reason: "configured-repositories-duplicate" };
      }
      return { identity, repositories: repositories as string[], reason: null };
    } catch (error) {
      return { identity: `config-unreadable:${String(error)}`, repositories: [], reason: `role-queue-unreadable:${String(error)}` };
    }
  };
  const bindRoleQueueHead = (projectId: string, configIdentity: string, queue: StartableQueueState, observedAtMs: number): RoleQueueRead => {
    const bind = (queueHead: string | null, domainId?: string): { head: RoleQueueRead["head"]; reason: string | null } => {
      let head: RoleQueueRead["head"] = null;
      let reason: string | null = null;
      if (queueHead !== null) {
        const match = queueHead.match(/^([^/]+)\/([^/#]+)#([1-9][0-9]*)$/u);
        const issueNumber = match?.[3] === undefined ? Number.NaN : Number(match[3]);
        if (!match?.[1] || !match[2] || !Number.isSafeInteger(issueNumber)) {
          reason = "startable-queue-head-malformed";
        } else {
          const matches = db?.prepare(
            `SELECT items.work_item_id, items.resource_revision
             FROM work_items AS items JOIN external_work_refs AS refs
               ON refs.project_id = items.project_id AND refs.work_item_id = items.work_item_id
             WHERE items.project_id = ? AND items.lifecycle_state IN ('proposed', 'ready')
               AND refs.provider = 'github' AND refs.owner = ? AND refs.repo = ? AND refs.issue_number = ?`,
          ).all(projectId, match[1], match[2], issueNumber) as Array<{ work_item_id: string; resource_revision: number }> | undefined;
          if (!matches || matches.length !== 1) reason = `startable-queue-head-bindings:${matches?.length ?? 0}`;
          else if (domainId !== undefined) {
            const item = db?.prepare("SELECT domain_id FROM work_items WHERE project_id = ? AND work_item_id = ?").get(projectId, matches[0]!.work_item_id) as { domain_id?: string } | undefined;
            if ((item?.domain_id ?? "default") !== domainId) reason = `startable-queue-head-out-of-domain:${domainId}`;
            else head = { workItemId: matches[0]!.work_item_id, resourceRevision: matches[0]!.resource_revision };
          } else {
            head = { workItemId: matches[0]!.work_item_id, resourceRevision: matches[0]!.resource_revision };
          }
        }
      }
      return { head, reason };
    };
    const domains = Object.fromEntries(Object.entries(queue.domains).map(([domainId, state]) => {
      if (!state.known) return [domainId, { known: false, reason: state.reason, head: null }];
      const bound = bind(state.head, domainId);
      return [domainId, { known: bound.reason === null, reason: bound.reason, head: bound.head }];
    }));
    const global = bind(queue.head);
    const domainReason = Object.values(domains).find((state) => state.reason !== null)?.reason ?? null;
    const reason = global.reason ?? domainReason;
    return { observedAtMs, configIdentity, known: reason === null, reason, head: global.head, domains };
  };
  const scopeRoleQueueRead = (projectId: string, domainId: string, queue: RoleQueueRead): RoleQueueRead => {
    const scoped = queue.domains[domainId];
    if (!scoped) return { ...queue, known: false, reason: `role-queue-domain-unknown:${domainId}`, head: null };
    return { ...queue, known: scoped.known, reason: scoped.reason, head: scoped.head };
  };
  const readProjectRoleQueue = async (projectId: string, refresh = false): Promise<RoleQueueRead> => {
    const now = Date.now();
    const config = readRoleQueueConfig(projectId);
    const cached = roleQueueCache.get(projectId);
    const cacheAgeMs = cached ? now - cached.observedAtMs : Number.POSITIVE_INFINITY;
    if (!refresh && cached && cached.configIdentity === config.identity && cacheAgeMs >= 0 && cacheAgeMs < ROLE_QUEUE_CACHE_MS) return cached;
    const refreshing = roleQueueRefreshes.get(projectId);
    if (refreshing) {
      if (refreshing.configIdentity === config.identity) return refreshing.promise;
      const reason = "project-config-superseded-in-flight";
      bb.log.warn(`role queue coverage=degraded project=${projectId} reason=${reason}`);
      return { observedAtMs: now, configIdentity: config.identity, known: false, reason, head: null, domains: {} };
    }
    const next = (async (): Promise<RoleQueueRead> => {
      let reason = config.reason;
      let head: RoleQueueRead["head"] = null;
      let domains: RoleQueueRead["domains"] = {};
      try {
        if (reason === null) {
          if (!db) throw new Error("canonical-store-unavailable");
          const queue = await startableQueueStateAsync(db, projectId, config.repositories);
          if (queue === null) {
            reason = "startable-queue-unreadable";
          } else if (queue.head !== null) {
            const bound = bindRoleQueueHead(projectId, config.identity, queue, Date.now());
            head = bound.head;
            domains = bound.domains;
            reason = bound.reason;
          } else if (queue !== null) {
            domains = Object.fromEntries(Object.entries(queue.domains).map(([domainId, state]) => [domainId, { known: state.known, reason: state.reason, head: null }]));
          }
        }
      } catch (error) {
        reason = `role-queue-unreadable:${String(error)}`;
      }
      const currentConfig = readRoleQueueConfig(projectId);
      if (currentConfig.identity !== config.identity) {
        reason = "project-config-moved-during-refresh";
        head = null;
        domains = {};
      }
      const result = { observedAtMs: Date.now(), configIdentity: config.identity, known: reason === null, reason, head, domains };
      if (currentConfig.identity === config.identity) roleQueueCache.set(projectId, result);
      if (reason !== null) bb.log.warn(`role queue coverage=degraded project=${projectId} reason=${reason}`);
      return result;
    })();
    roleQueueRefreshes.set(projectId, { configIdentity: config.identity, promise: next });
    try {
      return await next;
    } finally {
      if (roleQueueRefreshes.get(projectId)?.promise === next) roleQueueRefreshes.delete(projectId);
    }
  };

  const readRoleScopes = async () => {
    if (!db) throw new Error("canonical role scope unavailable");
    const holders = readProjectQueueRoleHolders();
    const holderKeys = [...new Set(holders.map((holder) => `${holder.project_id}\u0000${holder.domain_id ?? "default"}`))];
    return Promise.all(holderKeys.map(async (key) => {
      const separator = key.indexOf("\u0000");
      const projectId = key.slice(0, separator);
      const domainId = key.slice(separator + 1);
      const queue = await readProjectRoleQueue(projectId);
      const scopedQueue = scopeRoleQueueRead(projectId, domainId, queue);
      return {
        projectId,
        domainId,
        nextStartable: scopedQueue.known && scopedQueue.head !== null,
        queueHeadId: scopedQueue.known ? scopedQueue.head?.workItemId ?? null : null,
        deferredReason: null,
      };
    }));
  };

  const sendRoleWake = async (role: import("./src/awareness.js").RoleIdleView, text: string) => {
    if (!db) return "error" as const;
    const expectedHolder: RoleHolderState = {
      project_id: role.projectId,
      role_id: role.roleId,
      domain_id: role.domainId,
      role_generation: role.roleGeneration,
      execution_attempt_id: role.executionAttemptId,
      thread_id: role.threadId,
    };
    let holders: RoleHolderState[];
    try {
      holders = readProjectQueueRoleHolders().filter((holder) =>
        holder.project_id === role.projectId &&
        holder.role_id === role.roleId &&
        holder.domain_id === role.domainId &&
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
      }, role.projectId);
    } catch (error) {
      warnRoleLiveness(holders[0], `idle-wait=failed error=${String(error)}`);
      return "error" as const;
    }
    return true;
  };

  const steerRole = async (role: import("./src/awareness.js").RoleIdleView) => {
    if (role.roleId !== "project-orchestrator") return false;
    const capacity = await readLaneCapacityObservation(role.projectId);
    if (capacity.coverageState !== "known" || !capacity.queue || capacity.activeLaneCount === null || capacity.writingLaneCeiling === null) return "error" as const;
    const currentConfig = readRoleQueueConfig(role.projectId);
    if (currentConfig.identity !== capacity.configIdentity) return "error" as const;
    const current = bindRoleQueueHead(role.projectId, capacity.configIdentity, capacity.queue, capacity.observedAtMs);
    if (!current.known) return "error" as const;
    if (!current.head || current.head.workItemId !== role.queueHeadId) return false;
    const scoped = scopeRoleQueueRead(role.projectId, role.domainId ?? "default", current);
    if (!scoped.known || !scoped.head || scoped.head.workItemId !== role.queueHeadId) return false;
    if (capacity.activeLaneCount >= capacity.writingLaneCeiling) return false;
    return sendRoleWake(role, `Wrongful idle: queue head ${current.head.workItemId} is startable. Inspect the queue and act or record the blocker.`);
  };

  const watcher = createLaneWatcher({
    readRoleHolders: readProjectQueueRoleHolders,
    readRoleScopes,
    roleIdlePersistence,
    roleIdleThresholdMs: ROLE_QUEUE_IDLE_THRESHOLD_MS,
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
    domainId: string;
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
    configIdentity: string;
    queue: StartableQueueState | null;
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
           WHERE project_id = ? AND domain_id = ? AND ended_at_ms IS NULL
           AND coverage_state = ? AND active_lane_count IS ?
           AND writing_lane_ceiling IS ? AND startable_work IS ?`,
      ).run(
        observation.observedAtMs,
        observation.laneCapacityObservationId,
        observation.projectId,
        observation.domainId,
        observation.coverageState,
        observation.activeLaneCount,
        observation.writingLaneCeiling,
        startableWork,
      );
      if (extended.changes !== 1) {
        db!.prepare(
        "UPDATE lane_capacity_intervals SET ended_at_ms = last_confirmed_at_ms WHERE project_id = ? AND domain_id = ? AND ended_at_ms IS NULL",
      ).run(observation.projectId, observation.domainId);
      db!.prepare(
        `INSERT INTO lane_capacity_intervals (
           project_id, domain_id, orchestrator_thread_id, orchestrator_role_generation,
           coverage_state, active_lane_count, writing_lane_ceiling, startable_work,
           reason, lane_capacity_observation_id, started_at_ms, last_confirmed_at_ms, ended_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).run(
          observation.projectId,
          observation.domainId,
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
             project_id, domain_id, lane_capacity_observation_id, execution_attempt_id, observed_at_ms
           ) VALUES (?, ?, ?, ?, ?)`,
        ).run(observation.projectId, observation.domainId, observation.laneCapacityObservationId, executionAttemptId, observation.observedAtMs);
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
  type LaneIdentity = { executionAttemptId: string; laneId: string; threadId: string };
  const sameLaneIdentitySet = (left: LaneIdentity[], right: LaneIdentity[]) => {
    if (left.length !== right.length) return false;
    const keys = (lanes: LaneIdentity[]) => lanes.map((lane) => JSON.stringify(lane)).sort();
    const rightKeys = keys(right);
    return keys(left).every((lane, index) => lane === rightKeys[index]);
  };
  const readIdleFleetActiveLanes = async (projectId: string): Promise<IdleFleetFact<LaneIdentity[]>> => {
    if (!db) return { known: false, reason: "canonical-store-unavailable" };
    try {
      const capacityEvidence = workItemCapacityLaneEvidence(db, projectId);
      if (capacityEvidence.unboundWorkItemIds.length > 0) return { known: false, reason: "work-items-have-no-thread-binding:GH-300" };
      const identities: LaneIdentity[] = [];
      const now = Date.now();
      for (const row of capacityEvidence.lanes) {
        if (row.idle_kind === "blind") return { known: false, reason: "dispatch-unknown-attempt" };
        if (row.execution_attempt_id.length === 0 || row.lane_id.length === 0 || typeof row.thread_id !== "string" || row.thread_id.length === 0) {
          return { known: false, reason: "work-item-attempt-has-no-thread-binding:GH-300" };
        }
        if (typeof row.observed_at_ms !== "number" || !Number.isSafeInteger(row.observed_at_ms) || row.observed_at_ms < 0 || now - row.observed_at_ms > IDLE_FLEET_ATTEMPT_STALE_MS) {
          return { known: false, reason: "stale-active-attempt" };
        }
        const identity = { executionAttemptId: row.execution_attempt_id, laneId: row.lane_id, threadId: row.thread_id };
        if (identities.some((candidate) => candidate.executionAttemptId === identity.executionAttemptId || candidate.laneId === identity.laneId || candidate.threadId === identity.threadId)) {
          return { known: false, reason: "duplicate-active-lane" };
        }
        identities.push(identity);
      }
      return { known: true, value: identities };
    } catch (error) {
      return { known: false, reason: `active-lanes-unreadable:${String(error)}` };
    }
  };
  const readIdleFleetNativeLanes = async (projectId: string): Promise<IdleFleetFact<LaneIdentity[]>> => {
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
      const identities: LaneIdentity[] = [];
      const seenThreadIds = new Set<string>();
      for (const lane of liveLanes) {
        if (lane.projectId !== projectId) return { known: false, reason: "foreign-native-lane" };
        if (seenThreadIds.has(lane.id)) return { known: false, reason: "duplicate-native-lane" };
        seenThreadIds.add(lane.id);
        const matches = db.prepare(
          `SELECT project_id, execution_attempt_id, assignment_kind, lane_id, thread_id
           FROM execution_attempts
           WHERE origin = 'work_item' AND state = 'running' AND thread_id = ?`,
        ).all(lane.id) as Array<{ project_id: string; execution_attempt_id: string; assignment_kind: string | null; lane_id: string; thread_id: string | null }>;
        if (matches.some((match) => match.project_id !== projectId)) return { known: false, reason: "foreign-native-attempt" };
        if (matches.length === 0) return { known: false, reason: "unbound-native-lane" };
        if (matches.length > 1) return { known: false, reason: "ambiguous-native-attempt" };
        const match = matches[0]!;
        if (match.assignment_kind !== "write") continue;
        if (match.execution_attempt_id.length === 0 || match.lane_id.length === 0 || match.thread_id !== lane.id) return { known: false, reason: "native-lane-binding-invalid" };
        const identity = { executionAttemptId: match.execution_attempt_id, laneId: match.lane_id, threadId: match.thread_id };
        if (identities.some((candidate) => candidate.executionAttemptId === identity.executionAttemptId || candidate.laneId === identity.laneId || candidate.threadId === identity.threadId)) {
          return { known: false, reason: "duplicate-native-lane" };
        }
        const observedAtMs = Date.now();
        db.prepare(
          `UPDATE execution_attempts SET observed_at_ms = ?
           WHERE project_id = ? AND execution_attempt_id = ? AND state = 'running'`,
        ).run(observedAtMs, projectId, match.execution_attempt_id);
        identities.push(identity);
      }
      return { known: true, value: identities };
    } catch (error) {
      return { known: false, reason: `native-lanes-unreadable:${String(error)}` };
    }
  };
  const readIdleFleetStartable = async (projectId: string, configured = readRoleQueueConfig(projectId)): Promise<IdleFleetFact<StartableQueueState>> => {
    if (!db) return { known: false, reason: "canonical-store-unavailable" };
    try {
      if (configured.reason !== null) return { known: false, reason: configured.reason };
      const queue = await startableQueueStateAsync(db, projectId, configured.repositories);
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
    const configured = readRoleQueueConfig(projectId);
    const nativeLanes = await readIdleFleetNativeLanes(projectId);
    const [activeLanes, startable, ceiling] = await Promise.all([
      readIdleFleetActiveLanes(projectId),
      readIdleFleetStartable(projectId, configured),
      readIdleFleetCeiling(projectId),
    ]);
    const observedAtMs = Date.now();
    const currentConfig = readRoleQueueConfig(projectId);
    const reasons = [
      currentConfig.identity !== configured.identity ? "project-config-moved-during-refresh" : null,
      !activeLanes.known ? activeLanes.reason : null,
      !nativeLanes.known ? nativeLanes.reason : null,
      !startable.known ? startable.reason : null,
      !ceiling.known ? ceiling.reason : null,
      activeLanes.known && nativeLanes.known && !sameLaneIdentitySet(activeLanes.value, nativeLanes.value)
        ? `active-lanes-disagreement:canonical=${activeLanes.value.length}:native=${nativeLanes.value.length}`
        : null,
    ].filter((reason): reason is string => reason !== null);
    const coverageState = reasons.length === 0 ? "known" : "blind";
    const startableWork = startable.known ? startable.value.count > 0 : null;
    const open = db.prepare(
      `SELECT coverage_state, active_lane_count, writing_lane_ceiling, startable_work, reason, lane_capacity_observation_id
       FROM lane_capacity_intervals WHERE project_id = ? AND domain_id = ? AND ended_at_ms IS NULL`,
    ).get(projectId, holder.domain_id ?? "default") as {
      coverage_state: string; active_lane_count: number | null; writing_lane_ceiling: number | null;
      startable_work: number | null; reason: string | null; lane_capacity_observation_id: string | null;
    } | undefined;
    const sameFacts = open !== undefined && open.coverage_state === coverageState &&
      open.active_lane_count === (activeLanes.known ? activeLanes.value.length : null) &&
      open.writing_lane_ceiling === (ceiling.known ? ceiling.value : null) &&
      open.startable_work === (startableWork === null ? null : startableWork ? 1 : 0) &&
      open.reason === (reasons.length === 0 ? null : reasons.join(";"));
    const laneCapacityObservationId = sameFacts && open?.lane_capacity_observation_id
      ? open.lane_capacity_observation_id
      : randomBytes(16).toString("hex");
    return {
      projectId,
      domainId: holder.domain_id ?? "default",
      orchestratorThreadId: holder.thread_id,
      orchestratorRoleGeneration: holder.role_generation,
      coverageState,
      activeLaneCount: activeLanes.known ? activeLanes.value.length : null,
      writingLaneCeiling: ceiling.known ? ceiling.value : null,
      startableWork,
      reason: reasons.length === 0 ? null : reasons.join(";"),
      laneCapacityObservationId,
      observedAtMs,
      executionAttemptIds: nativeLanes.known ? nativeLanes.value.map((lane) => lane.executionAttemptId) : [],
      configIdentity: configured.identity,
      queue: reasons.length === 0 && startable.known ? startable.value : null,
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

    const configured = readRoleQueueConfig(probe.projectId);
    const [activeLanes, nativeLanes, startable, ceiling] = await Promise.all([
      readIdleFleetActiveLanes(probe.projectId),
      readIdleFleetNativeLanes(probe.projectId),
      readIdleFleetStartable(probe.projectId, configured),
      readIdleFleetCeiling(probe.projectId),
    ]);
    const currentConfig = readRoleQueueConfig(probe.projectId);
    if (currentConfig.identity !== configured.identity) {
      return idleFleetBlind("known", "blind", "blind", "project-config-moved-during-refresh");
    }
    const laneDisagreement = activeLanes.known && nativeLanes.known && !sameLaneIdentitySet(activeLanes.value, nativeLanes.value);
    if (!activeLanes.known || !nativeLanes.known || !startable.known || !ceiling.known) {
      const blindReasons = [
        !activeLanes.known ? activeLanes.reason : null,
        !nativeLanes.known ? nativeLanes.reason : null,
        !startable.known ? startable.reason : null,
        !ceiling.known ? ceiling.reason : null,
      ].filter((reason): reason is string => reason !== null);
      return idleFleetBlind(
        "known",
        !activeLanes.known || !nativeLanes.known ? "blind" : "known",
        startable.known ? "known" : "blind",
        blindReasons.join(";"),
      );
    }
    if (laneDisagreement) {
      return idleFleetBlind("known", "blind", "known", `active-lanes-disagreement:canonical=${activeLanes.value.length}:native=${nativeLanes.value.length}`);
    }
    if (activeLanes.value.length >= ceiling.value || startable.value.count === 0) return { kind: "silent" };
    const queueHead = startable.value.head;
    if (!queueHead) return { kind: "silent" };
    const role = {
      projectId: holder.project_id,
      roleId: holder.role_id,
      domainId: holder.domain_id ?? "default",
      roleGeneration: holder.role_generation,
      executionAttemptId: holder.execution_attempt_id,
      threadId: holder.thread_id,
      queueHeadId: queueHead,
      idleAgeMs: 0,
    };
    return {
      kind: "ready",
      episodeKey: fleetWatchdogEpisodeKey(holder, queueHead, activeLanes.value.length, ceiling.value),
      legacyEpisodeKey: fleetWatchdogLegacyEpisodeKey(holder, queueHead, activeLanes.value.length),
      role,
      message: `Idle fleet: queue head ${queueHead} is startable with ${activeLanes.value.length} active writing lane${activeLanes.value.length === 1 ? "" : "s"} below writing capacity ${ceiling.value}. Dispatch it or record the blocker.`,
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
      readProjectIds: async () => db
        ? (db.prepare("SELECT project_id FROM project_config_heads ORDER BY project_id").all() as Array<{ project_id: string }>).map((row) => row.project_id)
        : [],
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
    readProjectIds: () => db
      ? (db.prepare("SELECT project_id FROM project_config_heads ORDER BY project_id").all() as Array<{ project_id: string }>).map((row) => row.project_id)
      : [],
    readRoleHolders: readProjectQueueRoleHolders,
    readArtifact: async (projectId) => {
      if (!db) return null;
      let interrupted: Array<{ execution_attempt_id: string; work_item_id: string; thread_id: string | null; interruption_reason: string | null }>;
      try {
        interrupted = db.prepare(
          `SELECT attempts.execution_attempt_id, attempts.work_item_id, attempts.thread_id, attempts.interruption_reason
           FROM execution_attempts AS attempts
           JOIN work_items AS items ON items.project_id = attempts.project_id AND items.work_item_id = attempts.work_item_id
           WHERE attempts.project_id = ? AND attempts.origin = 'work_item' AND attempts.state = 'interrupted'
             AND items.lifecycle_state IN (${WORK_ITEM_NON_TERMINAL_STATES.map(() => "?").join(", ")})
           ORDER BY attempts.attempt_ordinal, attempts.execution_attempt_id`,
        ).all(projectId, ...WORK_ITEM_NON_TERMINAL_STATES) as typeof interrupted;
      } catch (error) {
        bb.log.warn(`stall-guard coverage=blind project=${projectId} reason=interrupted-attempt-inventory-unreadable:${String(error)}`);
        return null;
      }
      const artifacts = [];
      for (const holder of readRoleHolderStates(db).filter((candidate) => candidate.project_id === projectId)) {
        const appendDebt = () => {
          if (holder.role_id !== "project-orchestrator") return;
          for (const debt of interrupted) artifacts.push({ id: `interrupted:${debt.execution_attempt_id}`, unavailable: false, value: { workItemId: debt.work_item_id, threadId: debt.thread_id, reason: debt.interruption_reason, state: "interrupted" } });
        };
        try {
          const thread = await bb.sdk.threads.get({ threadId: holder.thread_id });
          if (thread.projectId !== projectId || !thread.environmentId) {
            artifacts.push({ id: holder.execution_attempt_id, unavailable: false, value: { environmentId: null, result: { outcome: "absent" } } });
            appendDebt();
            continue;
          }
          const result = await bb.sdk.environments.pullRequest({ environmentId: thread.environmentId });
          artifacts.push(result.outcome === "unavailable"
            ? { id: holder.execution_attempt_id, unavailable: true, value: null }
            : { id: holder.execution_attempt_id, unavailable: false, value: { environmentId: thread.environmentId, result } });
          appendDebt();
        } catch {
          artifacts.push({ id: holder.execution_attempt_id, unavailable: true, value: null });
          appendDebt();
        }
      }
      return artifacts;
    },
    readQueueHead: (projectId) => {
      const queue = roleQueueCache.get(projectId);
      const ageMs = queue ? Date.now() - queue.observedAtMs : Number.POSITIVE_INFINITY;
      return queue?.known === true && queue.configIdentity === readRoleQueueConfig(projectId).identity
        && ageMs >= 0 && ageMs < ROLE_QUEUE_CACHE_MS ? queue.head : null;
    },
    wakeRole: async (role) => {
      const queue = scopeRoleQueueRead(role.projectId, role.domainId ?? "default", await readProjectRoleQueue(role.projectId, true));
      const result = queue.head ? await steerRole({ ...role, queueHeadId: queue.head.workItemId }) : queue.known ? false : "error";
      return result === true
        ? { attempted: true, delivered: true }
        : { attempted: false, delivered: false, refusal: result === "error" ? "error" : "policy" };
    },
    persistence: {
      read: () => bb.storage.kv.get<unknown>(STALL_GUARD_KV_KEY),
      write: (state) => bb.storage.kv.set(STALL_GUARD_KV_KEY, state),
    },
  });

  const observe = async (payload: Parameters<typeof threadEventStatus>[0]) => {
    const { id, status } = threadEventStatus(payload);
    if (status === "idle") await clearRecoveryEpisode(payload.thread.projectId, id);
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
      await clearRecoveryEpisode(payload.thread.projectId, payload.thread.id);
      await watcher.observe(payload.thread.id, payload.thread.status, false, true);
      if (payload.thread.parentThreadId != null) await idleFleetDetector.observeCapacity(payload.thread.projectId);
    })().catch((error) => bb.log.warn(`lane observation failed: ${String(error)}`));
  });
  bb.events.on("thread.deleted", async (payload) => {
    await (async () => {
      await clearRecoveryEpisode(payload.thread.projectId, payload.thread.id);
      await watcher.observe(payload.thread.id, payload.thread.status, false, true);
      if (payload.thread.parentThreadId != null) await idleFleetDetector.observeCapacity(payload.thread.projectId);
    })().catch((error) => bb.log.warn(`lane observation failed: ${String(error)}`));
  });
  const unsubscribe = subscribeToThreadChanges(bb.sdk, async (threadId, status, archived = false, projectId, parentThreadId) => {
    if (status === "idle" && projectId) await clearRecoveryEpisode(projectId, threadId);
    await watcher.observe(threadId, status, undefined, archived);
    if (projectId && parentThreadId != null) await idleFleetDetector.observeCapacity(projectId);
  });
  bb.onDispose(unsubscribe);
  bb.background.service("lane-watcher", {
    async start(signal) {
      await loadRecoveryEpisodes().catch((error) => bb.log.warn(`error-recovery episode state unreadable: ${String(error)}`));
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
          timer = setTimeout(done, ROLE_QUEUE_OBSERVATION_MS);
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
  type FleetWatchdogLaneInventory = Awaited<ReturnType<typeof bb.sdk.threads.list>>;
  const laneInventoryReads = new Map<string, { promise: Promise<FleetWatchdogLaneInventory>; abort: () => void }>();
  const readFleetWatchdogLaneInventory = (projectId: string): Promise<FleetWatchdogLaneInventory | null> => {
    let entry = laneInventoryReads.get(projectId);
    if (!entry) {
      const controller = new AbortController();
      const promise = (async () => {
        const threads: FleetWatchdogLaneInventory = [];
        for (let offset = 0; ; offset += 100) {
          const page = await bb.sdk.threads.list({ projectId, hasParent: true, includeHidden: true, archived: false, limit: 100, offset, signal: controller.signal });
          const ids = new Set(threads.map((thread) => thread.id));
          const pageIds = new Set<string>();
          if (page.some((thread) => thread.projectId !== projectId || ids.has(thread.id) || pageIds.has(thread.id) || !pageIds.add(thread.id))) {
            throw new Error("native-lane-inventory-is-foreign-or-ambiguous");
          }
          threads.push(...page);
          if (page.length < 100) return threads;
        }
      })();
      entry = { promise, abort: () => controller.abort() };
      laneInventoryReads.set(projectId, entry);
      void promise.then(() => {
        if (laneInventoryReads.get(projectId) === entry) laneInventoryReads.delete(projectId);
      }, () => {
        if (laneInventoryReads.get(projectId) === entry) laneInventoryReads.delete(projectId);
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        entry!.abort();
        resolve(null);
      }, FLEET_WATCHDOG_LANE_INVENTORY_TIMEOUT_MS);
    });
    return Promise.race([entry.promise, timeout]).catch(() => null).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };
  type MergeCloseAttempt = {
    executionAttemptId: string;
    assignmentId: string | null;
    state: string;
    laneId: string | null;
    threadId: string | null;
  };
  type MergeCloseSafety =
    | { safe: true }
    | { safe: false; reason: string; attempts: MergeCloseAttempt[]; lanes: Array<{ threadId: string; status: string; laneId: string | null }> };
  const readMergeCloseSafety = async (
    projectId: string,
    workItemId: string,
    dispatcherThreadIds: Set<string>,
  ): Promise<MergeCloseSafety> => {
    let attempts: MergeCloseAttempt[];
    try {
      attempts = (db!.prepare(
        `SELECT execution_attempt_id, assignment_id, state, lane_id, thread_id
         FROM execution_attempts
         WHERE project_id = ? AND work_item_id = ? AND origin = 'work_item'
         ORDER BY attempt_ordinal DESC`,
      ).all(projectId, workItemId) as Array<{
        execution_attempt_id: string;
        assignment_id: string | null;
        state: string;
        lane_id: string | null;
        thread_id: string | null;
      }>).map((attempt) => ({
        executionAttemptId: attempt.execution_attempt_id,
        assignmentId: attempt.assignment_id,
        state: attempt.state,
        laneId: attempt.lane_id,
        threadId: attempt.thread_id,
      }));
    } catch (error) {
      return { safe: false, reason: `canonical-attempt-inventory-uncertain:${String(error)}`, attempts: [], lanes: [] };
    }
    const nonterminal = new Set(WORK_ITEM_CAPACITY_ATTEMPT_STATES);
    const liveAttempts = attempts.filter((attempt) => nonterminal.has(attempt.state as typeof WORK_ITEM_CAPACITY_ATTEMPT_STATES[number]));
    let inventory: FleetWatchdogLaneInventory | null;
    try {
      inventory = await readFleetWatchdogLaneInventory(projectId);
    } catch {
      inventory = null;
    }
    if (inventory === null) {
      return { safe: false, reason: "native-lane-inventory-incomplete-or-uncertain", attempts: liveAttempts, lanes: [] };
    }
    const lanes = inventory.filter((thread) =>
      thread.parentThreadId !== null &&
      dispatcherThreadIds.has(thread.parentThreadId) &&
      thread.archivedAt === null &&
      thread.deletedAt === null,
    );
    const associatedLanes = lanes.flatMap((lane) => {
      const attempt = attempts.find((candidate) => candidate.threadId === lane.id);
      return attempt ? [{ threadId: lane.id, status: lane.status, laneId: attempt.laneId }] : [];
    });
    const unknownLanes = associatedLanes.filter((lane) => !["idle", "active", "starting", "stopping", "error"].includes(lane.status));
    const activeLanes = associatedLanes.filter((lane) => lane.status === "active" || lane.status === "starting");
    if (liveAttempts.length > 0 || activeLanes.length > 0 || unknownLanes.length > 0) {
      return {
        safe: false,
        reason: liveAttempts.length > 0 ? "nonterminal-canonical-attempt" : unknownLanes.length > 0 ? "native-lane-status-uncertain" : "active-associated-native-lane",
        attempts: liveAttempts,
        lanes: [...activeLanes, ...unknownLanes],
      };
    }
    return { safe: true };
  };
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
      // Canonical config heads are the only tenant population. Role holders,
      // attempts, and WorkItems are project-scoped evidence, not discovery.
      const projectIds = new Set((db.prepare(
        "SELECT project_id FROM project_config_heads ORDER BY project_id",
      ).all() as Array<{ project_id: string }>).map((row) => row.project_id));
      const lanesByProject = new Map<string, Awaited<ReturnType<typeof bb.sdk.threads.list>>>();
      const readableLaneProjects = new Set<string>();
      const dispatchWedgesByProject = new Map<string, Array<{ executionAttemptId: string; workItemId: string }>>();
      // Start every project read before awaiting any one of them. Each project enters its
      // evaluation as soon as its own bounded inventory settles; a slow project is not a
      // fleet-wide barrier.
      const laneInventoryByProject = new Map([...projectIds]
        .filter((projectId) => onlyProjectId === undefined || projectId === onlyProjectId)
        .map((projectId) => [projectId, readFleetWatchdogLaneInventory(projectId)] as const));
      const openWorkItemsByProject = new Map<string, Array<{ workItemId: string; lifecycleState: string; waker: string | null; wakerKind: "schedule" | "seat" | "work_item_succeeded" | "github_issue_closed" | null; declaredAtMs: number | null }>>();
      const externalRevisions = new Map<string, LinkedGithubObservation>();
      const waitExternalRevisions = new Map<string, LinkedGithubObservation>();
      const waitExternalKey = (projectId: string, owner: string, repo: string, issueNumber: number) => `${projectId}\u0000${owner}\u0000${repo}\u0000${issueNumber}`;
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
      const wake = async (projectId: string, holder: RoleHolderState, key: string, text: string, requireIdle: boolean, kind: "fleet" | "recovery" | "startable-queue" | "stale-wait" | "owed-act" | "escalation", beforeSend?: () => Promise<boolean>, staleWaitExternalRevision: string | null = null, staleWaitWaker: string | null = null, bypassNotificationFloor = false, deduplicateSuccessfulDelivery = false) => {
        const previous = await fleetWatchdogIdle.get(key);
        if (deduplicateSuccessfulDelivery && kind === "owed-act" && previous?.lastOwedActWakeAtMs !== null && previous?.lastOwedActWakeAtMs !== undefined) return false;
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
      const superviseNativeInterruption = async (projectId?: string, threadId?: string) => {
        if (!db) {
          bb.log.warn(`interrupted-attempt supervision coverage=blind reason=canonical-store-unreadable`);
          return;
        }
        let attempts: Array<{ project_id: string; work_item_id: string; execution_attempt_id: string; repo_target_id: string; resource_revision: number; thread_id: string; created_at_ms: number; state: string }>;
        try {
          attempts = db.prepare(
            `SELECT attempts.project_id, attempts.work_item_id, attempts.execution_attempt_id,
                    attempts.repo_target_id, items.resource_revision, attempts.thread_id, attempts.created_at_ms, attempts.state
             FROM execution_attempts AS attempts
             JOIN work_items AS items ON items.project_id = attempts.project_id AND items.work_item_id = attempts.work_item_id
             WHERE attempts.origin = 'work_item' AND attempts.thread_id IS NOT NULL
               AND attempts.state IN (${[...WORK_ITEM_CAPACITY_ATTEMPT_STATES, "interrupted"].map(() => "?").join(", ")})
               AND items.lifecycle_state IN (${WORK_ITEM_NON_TERMINAL_STATES.map(() => "?").join(", ")})
               ${projectId === undefined ? "" : "AND attempts.project_id = ?"}
               ${threadId === undefined ? "" : "AND attempts.thread_id = ?"}
             ORDER BY attempts.project_id, attempts.execution_attempt_id`,
          ).all(
            ...WORK_ITEM_CAPACITY_ATTEMPT_STATES, "interrupted",
            ...WORK_ITEM_NON_TERMINAL_STATES,
            ...(projectId === undefined ? [] : [projectId]),
            ...(threadId === undefined ? [] : [threadId]),
          ) as typeof attempts;
        } catch (error) {
          bb.log.warn(`interrupted-attempt supervision coverage=blind reason=canonical-inventory-unreadable:${String(error)}`);
          return;
        }
        for (const attempt of attempts) {
          let events: Awaited<ReturnType<typeof bb.sdk.threads.events.list>>;
          try {
            events = await bb.sdk.threads.events.list({ threadId: attempt.thread_id, types: ["system/thread/interrupted"], order: "desc", limit: "1000" });
          } catch (error) {
            bb.log.warn(`interrupted-attempt supervision coverage=blind project=${attempt.project_id} attempt=${attempt.execution_attempt_id} reason=native-event-inventory-unreadable:${String(error)}`);
            continue;
          }
          const interruption = events.find((event) => event.type === "system/thread/interrupted"
            && event.threadId === attempt.thread_id
            && event.createdAt >= attempt.created_at_ms);
          if (!interruption || interruption.type !== "system/thread/interrupted") continue;
          const actor = db.prepare(
            `SELECT receipt_id FROM actor_receipts
             WHERE project_id = ? AND actor_kind = 'plugin' AND subject_id = ? AND role_id IS NULL
               AND verification_state = 'verified' ORDER BY issued_at_ms DESC LIMIT 1`,
          ).get(attempt.project_id, PLUGIN_ID) as { receipt_id: string } | undefined;
          const governor = db.prepare("SELECT governance_epoch, fence_token FROM project_governorship_heads WHERE project_id = ?").get(attempt.project_id) as { governance_epoch: number; fence_token: string } | undefined;
          const config = db.prepare("SELECT config_revision FROM project_config_heads WHERE project_id = ?").get(attempt.project_id) as { config_revision: number } | undefined;
          if (attempt.state !== "interrupted" && (!actor || !governor || !config)) {
            bb.log.warn(`interrupted-attempt supervision coverage=blind project=${attempt.project_id} attempt=${attempt.execution_attempt_id} reason=authority-unavailable`);
            continue;
          }
          const evidence = {
            projectId: attempt.project_id,
            workItemId: attempt.work_item_id,
            executionAttemptId: attempt.execution_attempt_id,
            threadId: attempt.thread_id,
            reason: interruption.data.reason,
            nativeEventType: interruption.type,
            nativeEventId: interruption.id,
            nativeEventSeq: interruption.seq,
            nativeTurnId: null,
            evidenceDigest: sha256(canonicalJson({
              projectId: attempt.project_id,
              workItemId: attempt.work_item_id,
              executionAttemptId: attempt.execution_attempt_id,
              threadId: interruption.threadId,
              reason: interruption.data.reason,
              nativeEventId: interruption.id,
              nativeEventSeq: interruption.seq,
              nativeTurnId: null,
            })),
          } satisfies NonNullable<ApplyRequest["interruption"]>;
          if (attempt.state !== "interrupted") {
            const request: ApplyRequest = {
              projectId: attempt.project_id,
              operationClass: "execution_attempt_interruption",
              idempotencyKey: `native-interruption:${fleetWatchdogCompositeKey(attempt.project_id, attempt.execution_attempt_id, interruption.id, String(interruption.seq))}`,
              actorReceiptId: actor!.receipt_id,
              expectedConfigRevision: config!.config_revision,
              expectedGovernanceEpoch: governor!.governance_epoch,
              expectedFenceToken: governor!.fence_token,
              repoTargetId: attempt.repo_target_id,
              expectedResourceRevision: attempt.resource_revision,
              workItemId: attempt.work_item_id,
              executionAttemptId: attempt.execution_attempt_id,
              interruption: evidence,
              reasonCode: `native-interruption:${interruption.data.reason}`,
            };
            const result = await applyLiveAuthorizedMutation(bb, db, request, false, "refuse-active");
            if (result.outcome !== "OK" && !result.replay) {
              bb.log.warn(`interrupted-attempt supervision refused: project=${attempt.project_id} attempt=${attempt.execution_attempt_id} outcome=${result.outcome}`);
              continue;
            }
          }
          const orchestrators = readRoleHolderStates(db).filter((holder) => holder.project_id === attempt.project_id && holder.role_id === "project-orchestrator");
          if (orchestrators.length !== 1) {
            bb.log.warn(`interrupted-attempt supervision coverage=blind project=${attempt.project_id} attempt=${attempt.execution_attempt_id} reason=exact-orchestrator-unresolved holders=${orchestrators.length}`);
            continue;
          }
          await wake(
            attempt.project_id,
            orchestrators[0]!,
            `interrupted-attempt:${fleetWatchdogCompositeKey(attempt.project_id, attempt.execution_attempt_id, interruption.id, String(interruption.seq))}`,
            `interrupted attempt requires explicit resume or disposition: project=${attempt.project_id} workItem=${attempt.work_item_id} executionAttempt=${attempt.execution_attempt_id} nativeEvent=${interruption.id}@${interruption.seq} reason=${interruption.data.reason}`,
            false,
            "owed-act",
            undefined,
            null,
            null,
            false,
            true,
          );
        }
      };
      const transitionWorkItem = async (
        projectId: string,
        workItemId: string,
        state: "ready" | "review_pending" | "succeeded" | "cancelled",
        idempotencyKey: string,
        extra: Pick<ApplyRequest, "workItemUnblock" | "workItemExternalEvent"> = {},
        githubSnapshot?: GitHubIssueSnapshot,
        legacyIdempotencyKey?: string,
        terminalizationPolicy: WorkItemAttemptTerminalizationPolicy = "refuse-active",
        reasonCode?: string,
        preMutationGuard?: PreMutationGuard,
      ): Promise<FoundationResult> => {
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
          ...(reasonCode === undefined ? {} : { reasonCode }),
          ...extra,
        };
        const compatibleKey = legacyIdempotencyKey !== undefined && db.prepare(
          "SELECT 1 FROM mutation_receipts WHERE project_id = ? AND idempotency_key = ? AND request_digest = ?",
        ).get(projectId, legacyIdempotencyKey, mutationRequestDigest({ ...request, idempotencyKey: legacyIdempotencyKey })) !== undefined
          ? legacyIdempotencyKey
          : idempotencyKey;
        return applyLiveAuthorizedMutation(bb, db, { ...request, idempotencyKey: compatibleKey }, false, terminalizationPolicy, githubSnapshot ? () => githubSnapshot : projectGithubIssueReader(db, projectId), null, preMutationGuard);
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
          const mapping = githubRepositoryMappingForWorkItem(db, projectId, workItem.workItemId, match[1], match[2]);
          if (!mapping) {
            degrade(`github-wait-target:${projectId}:${workItem.workItemId}`);
            continue;
          }
          const key = waitExternalKey(projectId, match[1], match[2], issueNumber);
          if (waitExternalRevisions.has(key)) continue;
          const observation = await linkedGithubObservationAsync(match[1], match[2], issueNumber, mapping.connectorHost);
          if (observation === null) degrade(`github-wait-target:${projectId}:${workItem.workItemId}`);
          else waitExternalRevisions.set(key, observation);
        }
      };
      const inspectLinkedWorkItems = async (projectId: string, orchestrator: RoleHolderState, dispatcherThreadIds: Set<string>) => {
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
        const reportMismatch = async (
          linked: (typeof linkedWorkItems)[number],
          snapshot: GitHubIssueSnapshot,
          safety: Extract<MergeCloseSafety, { safe: false }>,
        ) => {
          const attempts = safety.attempts.length === 0 ? "none" : safety.attempts.map((attempt) =>
            `executionAttemptId=${attempt.executionAttemptId}[assignmentId=${attempt.assignmentId ?? "null"},laneId=${attempt.laneId ?? "null"},threadId=${attempt.threadId ?? "null"},state=${attempt.state}]`).join(",");
          const lanes = safety.lanes.length === 0 ? "none" : safety.lanes.map((lane) =>
            `${lane.threadId}[laneId=${lane.laneId ?? "null"},status=${lane.status}]`).join(",");
          const subject = `${safety.reason}|attempts=${attempts}|lanes=${lanes}`;
          const sent = await wake(
            projectId,
            orchestrator,
            fleetWatchdogMergeCloseMismatchKey(projectId, linked.work_item_id, snapshot.externalRevision, subject),
            `fleet-watchdog merge-close mismatch: project=${projectId} workItem=${linked.work_item_id} issue=${linked.owner}/${linked.repo}#${linked.issue_number} externalRevision=${snapshot.externalRevision} reason=${safety.reason} attempts=${attempts} lanes=${lanes}; no stop or lifecycle transition is authorized.`,
            false,
            "owed-act",
          );
          if (sent) bb.log.warn(`fleet-watchdog merge-close mismatch reported: project=${projectId} workItem=${linked.work_item_id} reason=${safety.reason}`);
        };
        for (const linked of linkedWorkItems) {
          const mapping = githubRepositoryMappingForWorkItem(db, projectId, linked.work_item_id, linked.owner, linked.repo);
          if (!mapping) {
            degrade(fleetWatchdogScope("github-work-item-status", projectId, linked.work_item_id));
            continue;
          }
          const observation = await linkedGithubObservationAsync(linked.owner, linked.repo, linked.issue_number, mapping.connectorHost);
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
              githubSnapshot = await readGithubIssueForBackfillAsync(linked.owner, linked.repo, linked.issue_number, mapping.connectorHost);
            } catch {
              degrade(fleetWatchdogScope("github-work-item-reopen", projectId, linked.work_item_id));
              continue;
            }
            const result = await transitionWorkItem(
              projectId,
              linked.work_item_id,
              "ready",
              fleetWatchdogIssueReopenedKey(projectId, linked.work_item_id, observation.externalRevision),
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
            githubSnapshot = await readGithubIssueForBackfillAsync(linked.owner, linked.repo, linked.issue_number, mapping.connectorHost);
          } catch {
            degrade(fleetWatchdogScope("github-work-item-terminalize", projectId, linked.work_item_id));
            continue;
          }
          const safety = await readMergeCloseSafety(projectId, linked.work_item_id, dispatcherThreadIds);
          if (!safety.safe) {
            degrade(fleetWatchdogScope("github-work-item-terminalize", projectId, linked.work_item_id));
            await reportMismatch(linked, githubSnapshot, safety);
            continue;
          }
          const finalNativeLaneGuard: PreMutationGuard = async () => {
            const finalSafety = await readMergeCloseSafety(projectId, linked.work_item_id, dispatcherThreadIds);
            if (finalSafety.safe) return null;
            degrade(fleetWatchdogScope("github-work-item-terminalize", projectId, linked.work_item_id));
            await reportMismatch(linked, githubSnapshot, finalSafety);
            return { outcome: "WORK_ITEM_STATE_INVALID", subject: linked.work_item_id, expected: 1, attempted: 0, verified: 0, message: `merge-close safety refused: ${finalSafety.reason}` } satisfies FoundationResult;
          };
          const transition = async (state: "review_pending" | "succeeded" | "cancelled") => {
            const latestSafety = await readMergeCloseSafety(projectId, linked.work_item_id, dispatcherThreadIds);
            if (!latestSafety.safe) {
              degrade(fleetWatchdogScope("github-work-item-terminalize", projectId, linked.work_item_id));
              await reportMismatch(linked, githubSnapshot, latestSafety);
              return { outcome: "WORK_ITEM_STATE_INVALID", subject: linked.work_item_id, expected: 1, attempted: 0, verified: 0, message: `merge-close safety refused: ${latestSafety.reason}` } satisfies FoundationResult;
            }
            return transitionWorkItem(
              projectId,
              linked.work_item_id,
              state,
              fleetWatchdogMergeCloseKey(projectId, linked.work_item_id, state, githubSnapshot.externalRevision),
              state === "succeeded" || (state === "cancelled" && workItem.lifecycle_state === "proposed")
                ? { workItemExternalEvent: { kind: "github_issue_closed", owner: linked.owner, repo: linked.repo, issueNumber: linked.issue_number } }
                : {},
              githubSnapshot,
              fleetWatchdogLegacyMergeCloseKey(linked.work_item_id, state, githubSnapshot.externalRevision),
              "refuse-active",
              "fleet-watchdog-merge-close",
              finalNativeLaneGuard,
            );
          };
          let result: FoundationResult;
          if (workItem.lifecycle_state === "in_progress") {
            result = await transition("succeeded");
          } else if (workItem.lifecycle_state === "review_pending") {
            result = await transition("succeeded");
          } else if (workItem.lifecycle_state === "proposed") {
            // A closed issue absorbs work that never started; it did not succeed.
            result = await transition("cancelled");
          } else {
            result = { outcome: "WORK_ITEM_STATE_INVALID", subject: linked.work_item_id, expected: 1, attempted: 0, verified: 0, message: `merge-close automation requires in_progress, review_pending, or proposed, found ${workItem.lifecycle_state}` };
          }
          if (result.outcome === "OK") {
            const via = workItem.lifecycle_state === "proposed" ? "proposed-cancel" : workItem.lifecycle_state === "in_progress" ? "direct-success" : "review_pending";
            bb.log.info(`fleet-watchdog auto-terminalized merged and closed work item: project=${projectId} workItem=${linked.work_item_id} via=${via}`);
          } else {
            degrade(fleetWatchdogScope("github-work-item-terminalize", projectId, linked.work_item_id));
            bb.log.warn(`fleet-watchdog merge-close transition refused: project=${projectId} workItem=${linked.work_item_id} outcome=${result.outcome} message=${result.message}`);
          }
        }
      };
      let brokenWakePath = false;
      await Promise.all([...projectIds]
        .filter((projectId) => onlyProjectId === undefined || projectId === onlyProjectId)
        .map(async (projectId) => {
        const dispatcherThreadIds = dispatcherThreadIdsByProject.get(projectId) ?? new Set<string>();
        let threads: Awaited<ReturnType<typeof bb.sdk.threads.list>> = [];
        let threadInventoryReadable = true;
        try {
          const inventory = await laneInventoryByProject.get(projectId)!;
          if (inventory === null) throw new Error("native-lane-inventory-timeout");
          threads = inventory;
        } catch (error) {
          threadInventoryReadable = false;
          degrade(fleetWatchdogScope("platform-parentage", projectId, String(error)));
        }
        if (threadInventoryReadable) {
          readableLaneProjects.add(projectId);
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
        const holders = holdersByProject.get(projectId) ?? [];
        try {
          await inspectWaitTargets(projectId);
          const directors = holders.filter((holder) => holder.role_id === "director");
          const orchestrators = holders.filter((holder) => holder.role_id === "project-orchestrator");
          if (directors.length !== 1 || orchestrators.length !== 1) {
            if (directors.length > 1) bb.log.warn(`fleet-watchdog refused: project=${projectId} active director holders=${directors.length}`);
            if (orchestrators.length > 1) bb.log.warn(`fleet-watchdog refused: project=${projectId} active project-orchestrator holders=${orchestrators.length}`);
            degrade(fleetWatchdogScope("routing", projectId, `directors=${directors.length},orchestrators=${orchestrators.length}`));
            return;
          }
          const director = directors[0]!;
          const orchestrator = orchestrators[0]!;
          await superviseNativeInterruption(projectId);
          await inspectLinkedWorkItems(projectId, orchestrator, dispatcherThreadIds);
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
          const configured = readRoleQueueConfig(projectId);
          const repositories = configured.repositories;
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
          const observedQueue = configured.reason === null
            ? await startableQueueStateAsync(db, projectId, repositories)
            : null;
          const currentConfig = readRoleQueueConfig(projectId);
          const queue = currentConfig.identity === configured.identity ? observedQueue : null;
          if (currentConfig.identity !== configured.identity) {
            degrade(fleetWatchdogScope("project-config", projectId, "replaced-during-refresh"));
          }
          const fleetQueueHead = queue?.head === null || queue?.head === undefined ? null : `fleet:queue:${queue.head}`;
          await Promise.all(holders.map((holder) => fleetWatchdogIdle.clearPrefixExcept(
            roleIdleKey(holder, "fleet:queue:").slice(0, -2),
            fleetQueueHead === null ? undefined : roleIdleKey(holder, fleetQueueHead),
          )));
          if (queue !== null) {
            const intake = `startable=${queue.count} unlabelled=${queue.unlabelledCount} blocked=${queue.blockedCount} waiting-external=${queue.waitingExternalCount}`;
            bb.log.info(`fleet-watchdog intake counts: project=${projectId} ${intake}`);
            if ((queue.count > 0 || queue.unlabelledCount > 0) && writingLaneCeiling !== null && activeLaneCount < writingLaneCeiling) {
              await wake(projectId, orchestrator, roleIdleKey(orchestrator, "queue:startable"), `startable queue has ${queue.count} issue${queue.count === 1 ? "" : "s"}; ${queue.unlabelledCount} open issue${queue.unlabelledCount === 1 ? " has" : "s have"} no queue label; ${queue.blockedCount} blocked; ${queue.waitingExternalCount} waiting-external; ${activeLaneCount}/${writingLaneCeiling} writing lanes active`, false, "startable-queue");
            }
            const episodePrefix = fleetWatchdogScope("dispatched-without-live-lane", projectId);
            if (!readableLaneProjects.has(projectId)) {
              bb.log.warn(`fleet-watchdog dispatched-lane coverage=blind project=${projectId} reason=native-lane-inventory-unreadable`);
            } else {
              const unowned = dispatchedWithoutLiveLane(db, projectId, queue.dispatched, lanesByProject.get(projectId) ?? []);
              if (unowned === null) {
                degrade(fleetWatchdogScope("dispatched-lane", projectId, "canonical-ownership-unreadable"));
                bb.log.warn(`fleet-watchdog dispatched-lane coverage=blind project=${projectId} reason=canonical-ownership-unreadable`);
              } else {
                const issueIdentities = unowned.map((issue) => `${issue.repository}#${issue.number}`);
                const episodeKey = `${episodePrefix}:${fleetWatchdogCompositeKey(...issueIdentities)}`;
                await fleetWatchdogIdle.clearPrefixExcept(episodePrefix, unowned.length > 0 ? episodeKey : undefined);
                if (unowned.length > 0) {
                  await wake(
                    projectId,
                    orchestrator,
                    episodeKey,
                    `queue:dispatched has no live current lane for ${issueIdentities.join(", ")}; inspect exact canonical attempt/native thread identity and recover or close the work.`,
                    false,
                    "owed-act",
                    async () => {
                      try {
                        const freshQueue = await startableQueueStateAsync(db, projectId, repositories as string[]);
                        if (freshQueue === null) {
                          degrade(fleetWatchdogScope("dispatched-lane-revalidation", projectId, "queue-unreadable"));
                          return false;
                        }
                        const dispatcherThreadIds = dispatcherThreadIdsByProject.get(projectId) ?? new Set<string>();
                        const freshInventory = await readFleetWatchdogLaneInventory(projectId);
                        if (freshInventory === null) throw new Error("native-lane-inventory-timeout");
                        const freshLanes = freshInventory.filter((thread) =>
                          thread.parentThreadId !== null && dispatcherThreadIds.has(thread.parentThreadId) &&
                          thread.archivedAt === null && thread.deletedAt === null,
                        );
                        const freshUnowned = dispatchedWithoutLiveLane(db, projectId, freshQueue.dispatched, freshLanes);
                        return freshUnowned !== null && JSON.stringify(freshUnowned) === JSON.stringify(unowned);
                      } catch (error) {
                        degrade(fleetWatchdogScope("dispatched-lane-revalidation", projectId, String(error)));
                        return false;
                      }
                    },
                  );
                }
              }
            }
          } else {
            bb.log.warn(`fleet-watchdog intake coverage=blind project=${projectId} reason=startable-queue-unreadable`);
          }
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
              idempotencyKey = fleetWatchdogBlockerFiredKey(projectId, blocked.workItemId, blocked.waker);
            } else if (blocked.wakerKind === "github_issue_closed" && blocked.waker !== null) {
              const match = blocked.waker.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/u);
              const issueNumber = match?.[3] === undefined ? NaN : Number(match[3]);
              if (!match?.[1] || !match[2] || !Number.isSafeInteger(issueNumber)) {
                degrade(fleetWatchdogScope("work-item-blocker", projectId, blocked.workItemId));
                continue;
              }
              const mapping = githubRepositoryMappingForWorkItem(db, projectId, blocked.workItemId, match[1], match[2]);
              if (!mapping) {
                degrade(fleetWatchdogScope("work-item-blocker", projectId, blocked.workItemId));
                continue;
              }
              try {
                snapshot = await readGithubIssueForBackfillAsync(match[1], match[2], issueNumber, mapping.connectorHost);
              } catch {
                degrade(fleetWatchdogScope("work-item-blocker", projectId, blocked.workItemId));
                continue;
              }
              if (snapshot.state !== "closed") continue;
              condition = { kind: "github_issue_closed", owner: match[1], repo: match[2], issueNumber };
              idempotencyKey = fleetWatchdogBlockerFiredKey(projectId, blocked.workItemId, snapshot.externalRevision);
            } else {
              degrade(fleetWatchdogScope("work-item-blocker", projectId, blocked.workItemId));
              continue;
            }
            const result = await transitionWorkItem(projectId, blocked.workItemId, "ready", idempotencyKey, { workItemUnblock: condition }, snapshot, fleetWatchdogLegacyBlockerFiredKey(blocked.workItemId, snapshot?.externalRevision ?? blocked.waker ?? ""));
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
              ? waitExternalRevisions.get(waitExternalKey(projectId, targetMatch[1], targetMatch[2], targetIssueNumber))
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
            return;
          }
          const seatWait = remainingWorkItems.find((workItem) => workItem.wakerKind === "seat" && workItem.waker !== null);
          if (seatWait) {
            const owing = holders.find((holder) => holder.role_id === seatWait.waker);
            if (!owing) return;
            const owingKey = roleIdleKey(owing, seatWait.workItemId);
            const owingThread = await bb.sdk.threads.get({ threadId: owing.thread_id });
            if (roleThreadRefusal(owing, owingThread, true) || await readPendingExternalWait(owing.thread_id)) {
              await fleetWatchdogIdle.resetIdle(owingKey);
              return;
            }
            const owingRecord = await fleetWatchdogIdle.observeIdle(owingKey, now);
            if (owingRecord.idleSinceMs === null || now - owingRecord.idleSinceMs < floorMs) return;
            if (owingRecord.lastOwedActWakeAtMs === null || owingRecord.lastOwedActWakeAtMs < owingRecord.idleSinceMs) {
              await wake(projectId, owing, owingKey, `owed act quiet at cycle ${new Date(now).toISOString()} with open work since ${new Date(owingRecord.idleSinceMs).toISOString()}`, true, "owed-act");
              return;
            }
            if (owing.role_id !== "director" && now - owingRecord.lastOwedActWakeAtMs >= FLEET_WATCHDOG_NOTIFICATION_FLOOR_MS) {
              await wake(projectId, director, roleIdleKey(director, seatWait.workItemId), `owed act still quiet at cycle ${new Date(now).toISOString()} with open work since ${new Date(owingRecord.idleSinceMs).toISOString()}`, true, "owed-act");
            }
            return;
          }
          if (queue === null || queue.count === 0 || queue.head === null) {
            await resetIdle();
            return;
          }
          const workKey = `fleet:queue:${queue.head}`;
          const orchestratorKey = roleIdleKey(orchestrator, workKey);
          const priorOrchestratorRecord = await fleetWatchdogIdle.get(orchestratorKey);
          if (priorOrchestratorRecord?.lastFleetWakeAtMs !== null && priorOrchestratorRecord?.lastFleetWakeAtMs !== undefined && now - priorOrchestratorRecord.lastFleetWakeAtMs >= FLEET_WATCHDOG_NOTIFICATION_FLOOR_MS) {
            await wake(projectId, director, roleIdleKey(director, workKey), `fleet still quiet at cycle ${new Date(now).toISOString()} with open work since ${new Date(priorOrchestratorRecord.idleSinceMs ?? now).toISOString()}`, false, "escalation", async () => (await Promise.all(holders.map(async (holder) => {
              const thread = await bb.sdk.threads.get({ threadId: holder.thread_id });
              return !roleThreadRefusal(holder, thread, true) && !await readPendingExternalWait(holder.thread_id);
            }))).every(Boolean));
            return;
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
          if (!idle.every(Boolean)) return;
          const orchestratorRecord = await fleetWatchdogIdle.get(orchestratorKey);
          if (orchestratorRecord?.lastFleetWakeAtMs === null || orchestratorRecord?.lastFleetWakeAtMs === undefined || orchestratorRecord.lastFleetWakeAtMs < (orchestratorRecord.idleSinceMs ?? now)) {
            await wake(projectId, orchestrator, orchestratorKey, `fleet quiet at cycle ${new Date(now).toISOString()} with open work since ${new Date(orchestratorRecord?.idleSinceMs ?? now).toISOString()}`, true, "fleet");
            return;
          }
        } catch (error) {
          degrade(fleetWatchdogScope("project", projectId, String(error)));
          bb.log.warn(`fleet-watchdog failed: ${String(error)}`);
        }
        }));
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
  bb.background.schedule("fleet-watchdog", "3-59/5 * * * *", async () => {
    checkDeployedDist();
    await runGithubPrObservationCycle();
    await fleetWatchdogCycle();
  });

  bb.background.schedule("worktree-cleanup", "4 * * * *", async () => {
    let projects: Awaited<ReturnType<typeof bb.sdk.projects.list>>;
    try {
      projects = await bb.sdk.projects.list({ includePersonal: true });
    } catch (error) {
      const report = { outcome: "refused", wouldRemove: [], removableCandidateCount: 0, refused: [{ path: "<inventory>", population: "unknown", action: "refuse", reason: `project inventory unavailable: ${String(error)}` }], environmentRecordsReleased: false, attestation: { coverage: "blind" as const, reason: "cleanup-inventory-unreadable" } };
      bb.log.warn(`worktree-cleanup report: ${JSON.stringify(report)}`);
      bb.realtime.publish("worktree-cleanup", report);
      return;
    }
    for (const project of projects) {
      try {
        const report = await reportProjectWorktreeCleanup(bb, project.id);
        if (report.wouldRemove.length > 0) bb.log.warn(`worktree-cleanup report: project=${project.id} ${JSON.stringify(report)}`);
        else if (report.attestation.coverage === "blind") bb.log.warn(`worktree-cleanup coverage=blind project=${project.id} reason=${report.attestation.reason}`);
        else bb.log.info(`worktree-cleanup healthy cycle: project=${project.id} candidates=${report.removableCandidateCount} refused=${report.refused.length}`);
        bb.realtime.publish("worktree-cleanup", { projectId: project.id, ...report });
      } catch (error) {
        const report = { projectId: project.id, outcome: "refused", wouldRemove: [], removableCandidateCount: 0, refused: [{ path: "<inventory>", population: "unknown", action: "refuse", reason: error instanceof Error ? error.message : String(error) }], environmentRecordsReleased: false, attestation: { coverage: "blind" as const, reason: "cleanup-inventory-unreadable" } };
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

  const readOpenLaneViews = async () => {
    if (!db) throw new Error("canonical lane population unavailable");
    const attempts = db.prepare(
      `SELECT attempts.project_id, attempts.assignment_id, attempts.lane_id,
              attempts.assignment_kind, attempts.work_item_id, attempts.thread_id,
              attempts.execution_attempt_id, attempts.state, attempts.created_at_ms
       FROM execution_attempts AS attempts
       JOIN work_items AS items
         ON items.project_id = attempts.project_id
        AND items.work_item_id = attempts.work_item_id
       WHERE attempts.origin = 'work_item'
         AND attempts.state IN (${WORK_ITEM_CAPACITY_ATTEMPT_STATES.map(() => "?").join(", ")})
         AND items.lifecycle_state IN (${WORK_ITEM_NON_TERMINAL_STATES.map(() => "?").join(", ")})
       ORDER BY attempts.project_id, attempts.created_at_ms, attempts.execution_attempt_id`,
    ).all(...WORK_ITEM_CAPACITY_ATTEMPT_STATES, ...WORK_ITEM_NON_TERMINAL_STATES) as Array<{
      project_id: string;
      assignment_id: null;
      lane_id: string;
      assignment_kind: "write" | "review" | "probe";
      work_item_id: string;
      thread_id: string | null;
      execution_attempt_id: string;
      state: (typeof WORK_ITEM_CAPACITY_ATTEMPT_STATES)[number];
      created_at_ms: number;
    }>;
    const currentHolders = readRoleHolderStates(db);
    const holderThreadIdsByProject = new Map<string, Set<string>>();
    for (const holder of currentHolders) {
      const threadIds = holderThreadIdsByProject.get(holder.project_id) ?? new Set<string>();
      threadIds.add(holder.thread_id);
      holderThreadIdsByProject.set(holder.project_id, threadIds);
    }
    const attemptsByProject = new Map<string, typeof attempts>();
    for (const attempt of attempts) {
      if (attempt.assignment_id !== null) throw new Error(`work-item lane ${attempt.execution_attempt_id} has an Assignment`);
      const projectAttempts = attemptsByProject.get(attempt.project_id) ?? [];
      projectAttempts.push(attempt);
      attemptsByProject.set(attempt.project_id, projectAttempts);
    }

    const views: Array<z.infer<typeof laneViewSchema>> = [];
    for (const [projectId, projectAttempts] of attemptsByProject) {
      const holderThreadIds = holderThreadIdsByProject.get(projectId);
      if (!holderThreadIds || holderThreadIds.size === 0) {
        bb.log.warn(`lane population refused: project=${projectId} reason=current-role-holder-unavailable`);
        continue;
      }
      const workItemIds = new Set<string>();
      for (const attempt of projectAttempts) {
        if (workItemIds.has(attempt.work_item_id)) {
          bb.log.warn(`lane population refused: project=${projectId} workItem=${attempt.work_item_id} reason=current-attempt-ambiguous`);
          throw new Error(`current work-item lane identity is ambiguous: ${attempt.work_item_id}`);
        }
        workItemIds.add(attempt.work_item_id);
      }
      let threads: Awaited<ReturnType<typeof bb.sdk.threads.list>>;
      try {
        threads = await listAllProjectThreads((request) => bb.sdk.threads.list(request), projectId);
      } catch (error) {
        bb.log.warn(`lane population refused: project=${projectId} reason=native-lane-inventory-unreadable:${String(error)}`);
        throw error;
      }
      const threadsById = new Map<string, typeof threads>();
      for (const thread of threads) {
        const matches = threadsById.get(thread.id) ?? [];
        matches.push(thread);
        threadsById.set(thread.id, matches);
      }
      for (const attempt of projectAttempts) {
        let workerStatus: z.infer<typeof laneViewSchema>["workerStatus"] = null;
        if (attempt.thread_id !== null) {
          const matches = threadsById.get(attempt.thread_id) ?? [];
          if (matches.length > 1) {
            bb.log.warn(`lane population refused: project=${projectId} attempt=${attempt.execution_attempt_id} thread=${attempt.thread_id} reason=native-lane-ambiguous`);
            throw new Error(`native lane identity is ambiguous: ${attempt.thread_id}`);
          }
          const thread = matches[0];
          if (!thread || thread.projectId !== projectId || thread.archivedAt !== null || thread.deletedAt !== null ||
              thread.parentThreadId === null || !holderThreadIds.has(thread.parentThreadId)) {
            bb.log.warn(`lane population refused: project=${projectId} attempt=${attempt.execution_attempt_id} thread=${attempt.thread_id} reason=native-lane-not-current`);
            continue;
          }
          const holderMatches = threadsById.get(thread.parentThreadId) ?? [];
          const holder = holderMatches[0];
          if (holderMatches.length !== 1 || !holder || holder.projectId !== projectId || holder.archivedAt !== null || holder.deletedAt !== null ||
              holder.status !== "idle" && holder.status !== "active") {
            bb.log.warn(`lane population refused: project=${projectId} attempt=${attempt.execution_attempt_id} thread=${attempt.thread_id} reason=current-role-holder-unusable`);
            continue;
          }
          workerStatus = thread.status;
        }
        const running = workerStatus === "active" || workerStatus === "starting" || attempt.state === "running";
        const errored = workerStatus === "error" || workerStatus === "stopping" || attempt.state === "dispatch_unknown" ||
          attempt.thread_id === null && attempt.state !== "prepared";
        views.push({
          projectId,
          laneId: attempt.lane_id,
          assignmentId: attempt.assignment_id,
          assignmentKind: attempt.assignment_kind,
          workItemId: attempt.work_item_id,
          threadId: attempt.thread_id,
          executionAttemptId: attempt.execution_attempt_id,
          attemptState: attempt.state,
          workerStatus,
          waitingOn: null,
          ageMs: Math.max(0, Date.now() - attempt.created_at_ms),
          tone: errored ? "error" : running ? "running" : "default",
          queueState: running ? "running" : "ready",
          queueBlocked: false,
          nextStartable: false,
          deferredReason: null,
          deferredAtMs: null,
          deferredAgeMs: null,
        });
      }
    }
    return views;
  };

  // Lifecycle callbacks observe a completed creation; they cannot intercept a
  // spawn. An unseated thread receives its worker brief here at seating;
  // Every successful canonical role-generation event separately delivers the exact seat brief.
  bb.events.on("thread.created", async ({ thread }) => {
    try {
      await sendRoleBrief(bb, db, thread.projectId, thread.id, roleForThread(db, thread.projectId, thread.id));
    } catch (error) {
      bb.log.error(`role brief seating failed for thread=${thread.id}: ${String(error)}`);
    }
  });

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
    "v1-lanes"() {
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
    async doctor(input) {
      return doctor(db, bb.sdk, input.projectId, readDiagnosticDivergence());
    },
    async export(input) {
      return exportFoundation(db, input.projectId);
    },
    async apply(input) {
      return applyLiveAuthorizedMutation(bb, db, input);
    },
    async registerProject(input) {
      return applyLiveAuthorizedMutation(bb, db, {
        ...parseRegisterProjectRequest(input),
      });
    },
    async dispatchLane(input) {
      return dispatchLane(bb, db, input);
    },
    async closeThreadlessPreparedAttempt(input) {
      return closeThreadlessPreparedAttempt(bb, db, input);
    },
    async cachedConsumerRollout(input) {
      return applyLiveCachedConsumerRollout(bb, db, input, cliDeps);
    },
    async roleBrief(input) {
      return composeRoleBrief(bb, db, input);
    },
    "v1-inbox-read"(input) {
      return listOperatorMessages(db, bb, input.projectId, input.recipient, input.withSenderTitles, input.includeArchived);
    },
    "v1-inbox-mark-read"(input) {
      return markOperatorMessageRead(db, bb, input.projectId, input.messageId);
    },
    "v1-inbox-archive"(input) {
      return archiveOperatorMessage(db, bb, input.projectId, input.messageId);
    },
    "v1-inbox-reply"(input) {
      return replyToOperatorMessage(db, bb, input.projectId, input.messageId, input.text);
    },
  });

  bb.agents.registerTool({
    name: "build_terminal_report",
    description: "Build a terminal report from the exact native completion and canonical attempt.",
    instructions: "Use the returned JSON as terminalReport in the execution_attempt_terminal_report request. The builder supplies the native environment, authoritative digests, and evidence; submission owns receipt timing and identity. Canonical digests are defined by canonical JSON \u2014 sorted keys, JSON.stringify, no trailing newline. Hand-computed digests (e.g. jq | shasum) silently diverge and will be refused; if you must compute one, strip the trailing newline (jq -j, or printf %s).",
    parameters: terminalReportBuilderInputSchema,
    async execute(input, context) {
      if (input.projectId !== context.projectId) throw new Error("projectId must exactly match the current thread project");
      return JSON.stringify(await buildLiveTerminalReport(bb, db, input, context.threadId));
    },
  });
  bb.agents.registerTool({
    name: "dispatch_lane",
    description: "Dispatch one writing lane through the canonical registration seam.",
    instructions: "Use this instead of spawning a lane directly. The request projectId must match the current thread project.",
    parameters: dispatchLaneInputSchema,
    async execute(input, context) {
      if (input.request.projectId !== context.projectId) throw new Error("request projectId must exactly match the current thread project");
      return JSON.stringify(await dispatchLane(bb, db, input, { projectId: context.projectId, threadId: context.threadId }));
    },
  });
  bb.agents.registerTool({
    name: "close_threadless_prepared_attempt",
    description: "Close one exact prepared writing attempt only after complete zero-thread evidence.",
    instructions: "Use only for a prepared work-item writing attempt with no native thread or native evidence. This path never spawns or retries.",
    parameters: threadlessPreparedClosureInputSchema,
    async execute(input, context) {
      if (input.request.projectId !== context.projectId) throw new Error("request projectId must exactly match the current thread project");
      return JSON.stringify(await closeThreadlessPreparedAttempt(bb, db, input));
    },
  });
  bb.agents.registerTool({
    name: "close_stranded_execution_attempt",
    description: "Dispose one exact active writing attempt only after independent native completion and owner-incapacity evidence.",
    instructions: "Use only from the current director or project-orchestrator seat. This path records a conservative BLOCKED/failed terminalization and never fabricates a terminal report.",
    parameters: strandedExecutionAttemptClosureInputSchema,
    async execute(input, context) {
      if (input.request.projectId !== context.projectId) throw new Error("request projectId must exactly match the current thread project");
      return JSON.stringify(await closeStrandedExecutionAttempt(bb, db, input, context.threadId));
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
  bb.agents.registerTool({
    name: "register_external_wait",
    description: "Register one exact GitHub pull-request wait through the canonical WorkItem seam.",
    instructions: "Pass the complete canonical work_item_transition request, including its normalized initial GitHub PR observation. The result is exactly registered, already_satisfied, or refused.",
    parameters: registerExternalWaitInputSchema,
    async execute(input, context) {
      if (input.request.projectId !== context.projectId) throw new Error("request projectId must exactly match the current thread project");
      if (input.request.operationClass !== "work_item_transition" || input.request.lifecycleState !== "blocked"
        || input.request.workItemWait?.kind === undefined
        || !["pr_merged", "pr_checks", "pr_review_state"].includes(input.request.workItemWait.kind)) return "refused";
      const result = await applyLiveAuthorizedMutation(bb, db, input.request);
      if (result.outcome !== "OK") return "refused";
      const registration = (result as FoundationResult & { registration?: unknown }).registration;
      return registration === "already_satisfied" ? "already_satisfied" : registration === "registered" ? "registered" : "refused";
    },
  });
  bb.agents.configure(() => ({ tools: ["build_terminal_report", "dispatch_lane", "close_threadless_prepared_attempt", "close_stranded_execution_attempt", "send_to_operator", "register_external_wait"], skills: [] }));

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
        name: "register-project",
        summary: "Bootstrap one project and its first config revision through the canonical resolver",
        usage: "bb collab register-project --project PROJECT_ID --request JSON",
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
        summary: "Run one role-generation-safe stall-guard cycle (host-supervised seam)",
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
        summary: "Read, mark read, or archive in one exact registered project's operator inbox",
        usage: "bb collab inbox --project PROJECT_ID [--recipient operator|supervisor | --mark-read MESSAGE_ID | --archive MESSAGE_ID]",
      },
    ],
    run(argv, context) {
      return runCli(db, bb, argv, context, cliDeps);
    },
  });

  bb.log.info(`${PLUGIN_ID} loaded for BB ${BB_VERSION_RANGE}; plugin SDK ${PLUGIN_SDK_VERSION}; canonicalStore=${db === null ? "unavailable" : "available"}`);
}
