import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";

export const PLUGIN_ID = "bb-collab";
export const BB_VERSION_RANGE = ">=0.37.0";
export const PLUGIN_SDK_VERSION = "0.4.1";
export const SCHEMA_VERSION = 3;
// ponytail: keep exports bounded at 256 rows; add paged/file export before migration or cutover.
export const MAX_EXPORT_ROWS = 256;
export const MAX_EXPORT_BYTES = 512 * 1024;
/** Deferred until a later cutover operation; issue #3 has no sanctioned freeze transition. */
export const DEFERRED_ISSUE_3_OUTCOMES = ["PROJECT_FROZEN"] as const;

export const TABLES = [
  "project_config_revisions",
  "project_config_heads",
  "repository_targets",
  "project_governorships",
  "project_governorship_heads",
  "actor_receipts",
  "decisions",
  "decision_dispositions",
  "mutation_receipts",
  "state_events",
  "work_items",
  "external_work_refs",
  "qualification_observations",
  "eligibility_projections",
  "role_generations",
  "role_generation_heads",
] as const;

export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS project_config_revisions (
    project_id TEXT NOT NULL,
    config_revision INTEGER NOT NULL CHECK (config_revision > 0),
    canonical_config_json TEXT NOT NULL CHECK (json_valid(canonical_config_json)),
    config_digest TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (project_id, config_revision)
  )`,
  `CREATE TABLE IF NOT EXISTS project_config_heads (
    project_id TEXT PRIMARY KEY,
    config_revision INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY (project_id, config_revision)
      REFERENCES project_config_revisions(project_id, config_revision)
  )`,
  `CREATE TABLE IF NOT EXISTS repository_targets (
    project_id TEXT NOT NULL,
    repo_target_id TEXT NOT NULL,
    config_revision INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    path TEXT NOT NULL,
    remote_url TEXT,
    default_branch TEXT NOT NULL,
    target_digest TEXT NOT NULL,
    PRIMARY KEY (project_id, repo_target_id, config_revision),
    FOREIGN KEY (project_id, config_revision)
      REFERENCES project_config_revisions(project_id, config_revision)
  )`,
  `CREATE TABLE IF NOT EXISTS actor_receipts (
    project_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL UNIQUE,
    actor_kind TEXT NOT NULL CHECK (length(actor_kind) > 0),
    subject_id TEXT NOT NULL,
    role_id TEXT,
    role_generation INTEGER,
    verification_state TEXT NOT NULL
      CHECK (verification_state IN ('verified', 'unverified', 'revoked')),
    receipt_digest TEXT NOT NULL,
    issued_at_ms INTEGER NOT NULL,
    PRIMARY KEY (project_id, receipt_id)
  )`,
  `CREATE TABLE IF NOT EXISTS project_governorships (
    project_id TEXT NOT NULL,
    governance_epoch INTEGER NOT NULL CHECK (governance_epoch > 0),
    runtime_id TEXT NOT NULL,
    state TEXT NOT NULL
      CHECK (state IN ('target_active', 'frozen', 'retired', 'source_active')),
    fence_token TEXT NOT NULL,
    actor_receipt_id TEXT NOT NULL,
    predecessor_epoch INTEGER,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (project_id, governance_epoch),
    UNIQUE (project_id, fence_token),
    FOREIGN KEY (project_id, actor_receipt_id)
      REFERENCES actor_receipts(project_id, receipt_id),
    FOREIGN KEY (project_id, predecessor_epoch)
      REFERENCES project_governorships(project_id, governance_epoch)
  )`,
  `CREATE TABLE IF NOT EXISTS project_governorship_heads (
    project_id TEXT PRIMARY KEY,
    governance_epoch INTEGER NOT NULL,
    fence_token TEXT NOT NULL,
    state TEXT NOT NULL
      CHECK (state IN ('target_active', 'frozen', 'retired', 'source_active')),
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY (project_id, governance_epoch)
      REFERENCES project_governorships(project_id, governance_epoch)
  )`,
  `CREATE TABLE IF NOT EXISTS decisions (
    decision_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    config_revision INTEGER NOT NULL,
    repo_target_id TEXT,
    scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
    scope_digest TEXT NOT NULL,
    current_resource_revision INTEGER NOT NULL CHECK (current_resource_revision > 0),
    FOREIGN KEY (project_id, config_revision)
      REFERENCES project_config_revisions(project_id, config_revision),
    FOREIGN KEY (project_id, repo_target_id, config_revision)
      REFERENCES repository_targets(project_id, repo_target_id, config_revision)
  )`,
  `CREATE TABLE IF NOT EXISTS decision_dispositions (
    decision_id TEXT NOT NULL,
    disposition_sequence INTEGER NOT NULL CHECK (disposition_sequence > 0),
    disposition TEXT NOT NULL
      CHECK (disposition IN ('proposed', 'adopted', 'rejected', 'superseded', 'revoked')),
    actor_receipt_id TEXT NOT NULL,
    reason_json TEXT NOT NULL CHECK (json_valid(reason_json)),
    created_at_ms INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    PRIMARY KEY (decision_id, disposition_sequence),
    FOREIGN KEY (decision_id) REFERENCES decisions(decision_id)
  )`,
  `CREATE TABLE IF NOT EXISTS state_events (
    project_id TEXT NOT NULL,
    event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    aggregate_revision INTEGER NOT NULL CHECK (aggregate_revision > 0),
    event_type TEXT NOT NULL,
    actor_receipt_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (project_id, event_sequence),
    FOREIGN KEY (project_id, actor_receipt_id)
      REFERENCES actor_receipts(project_id, receipt_id)
  )`,
  `CREATE TABLE IF NOT EXISTS mutation_receipts (
    project_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    operation_class TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json)),
    committed_event_sequence INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (project_id, idempotency_key),
    FOREIGN KEY (project_id, committed_event_sequence)
      REFERENCES state_events(project_id, event_sequence)
  )`,
  `CREATE TABLE IF NOT EXISTS work_items (
    project_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    config_revision INTEGER NOT NULL,
    repo_target_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL
      CHECK (lifecycle_state IN ('proposed', 'ready', 'in_progress', 'succeeded', 'failed', 'cancelled')),
    resource_revision INTEGER NOT NULL CHECK (resource_revision > 0),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (project_id, work_item_id),
    FOREIGN KEY (project_id, config_revision)
      REFERENCES project_config_revisions(project_id, config_revision),
    FOREIGN KEY (project_id, repo_target_id, config_revision)
      REFERENCES repository_targets(project_id, repo_target_id, config_revision)
  )`,
  `CREATE TABLE IF NOT EXISTS external_work_refs (
    project_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider = 'github'),
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    issue_number INTEGER CHECK (issue_number IS NULL OR issue_number > 0),
    projection_state TEXT NOT NULL
      CHECK (projection_state IN ('pending', 'current', 'drifted', 'delivery_ambiguous')),
    attempted_resource_revision INTEGER NOT NULL CHECK (attempted_resource_revision > 0),
    projected_resource_revision INTEGER CHECK (projected_resource_revision IS NULL OR projected_resource_revision > 0),
    desired_digest TEXT NOT NULL,
    observed_external_revision TEXT,
    observed_external_digest TEXT,
    last_idempotency_key TEXT NOT NULL,
    last_request_digest TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (project_id, work_item_id, provider),
    FOREIGN KEY (project_id, work_item_id)
      REFERENCES work_items(project_id, work_item_id),
    CHECK (issue_number IS NOT NULL OR projection_state IN ('pending', 'delivery_ambiguous'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS external_work_refs_issue_identity
    ON external_work_refs(provider, owner, repo, issue_number)
    WHERE issue_number IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS qualification_observations (
    project_id TEXT NOT NULL,
    qualification_id TEXT NOT NULL,
    role_requirement_id TEXT NOT NULL,
    config_revision INTEGER NOT NULL,
    repo_target_id TEXT,
    role_requirement_digest TEXT NOT NULL,
    executed_profile_digest TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning_level TEXT NOT NULL,
    permission_mode TEXT NOT NULL,
    service_tier TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('visible', 'hidden')),
    thread_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    provider_thread_id TEXT NOT NULL,
    request_event_id TEXT NOT NULL,
    request_event_seq INTEGER NOT NULL CHECK (request_event_seq > 0),
    completion_event_id TEXT NOT NULL,
    completion_event_seq INTEGER NOT NULL CHECK (completion_event_seq > 0),
    bb_version TEXT NOT NULL,
    plugin_sdk_version TEXT NOT NULL,
    qualification_context_digest TEXT NOT NULL,
    fixture_context_digest TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('qualified', 'unqualified', 'unknown')),
    observed_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER,
    evidence_digest TEXT NOT NULL,
    observation_digest TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    PRIMARY KEY (project_id, qualification_id),
    FOREIGN KEY (project_id, config_revision)
      REFERENCES project_config_revisions(project_id, config_revision),
    FOREIGN KEY (project_id, repo_target_id, config_revision)
      REFERENCES repository_targets(project_id, repo_target_id, config_revision)
  )`,
  `CREATE TABLE IF NOT EXISTS eligibility_projections (
    project_id TEXT NOT NULL,
    role_requirement_id TEXT NOT NULL,
    profile_digest TEXT NOT NULL,
    current_qualification_id TEXT NOT NULL,
    effective_status TEXT NOT NULL
      CHECK (effective_status IN ('eligible', 'ineligible', 'unknown')),
    qualification_context_digest TEXT NOT NULL,
    config_revision INTEGER NOT NULL,
    role_requirement_digest TEXT NOT NULL,
    derived_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER,
    derivation_digest TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    PRIMARY KEY (project_id, role_requirement_id, profile_digest),
    FOREIGN KEY (project_id, current_qualification_id)
      REFERENCES qualification_observations(project_id, qualification_id),
    FOREIGN KEY (project_id, config_revision)
      REFERENCES project_config_revisions(project_id, config_revision)
  )`,
  `CREATE TABLE IF NOT EXISTS role_generations (
    project_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    role_requirement_id TEXT NOT NULL,
    config_revision INTEGER NOT NULL,
    repo_target_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'draining', 'retired', 'invalidated')),
    predecessor_generation INTEGER,
    holder_execution_attempt_id TEXT NOT NULL,
    holder_context_digest TEXT NOT NULL,
    holder_executed_profile_digest TEXT NOT NULL,
    qualification_id TEXT NOT NULL,
    eligibility_derivation_digest TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    activated_at_ms INTEGER NOT NULL,
    retired_at_ms INTEGER,
    PRIMARY KEY (project_id, role_id, generation),
    FOREIGN KEY (project_id, config_revision)
      REFERENCES project_config_revisions(project_id, config_revision),
    FOREIGN KEY (project_id, repo_target_id, config_revision)
      REFERENCES repository_targets(project_id, repo_target_id, config_revision),
    FOREIGN KEY (project_id, qualification_id)
      REFERENCES qualification_observations(project_id, qualification_id),
    FOREIGN KEY (project_id, role_id, predecessor_generation)
      REFERENCES role_generations(project_id, role_id, generation),
    CHECK ((generation = 1 AND predecessor_generation IS NULL) OR
           (generation > 1 AND predecessor_generation = generation - 1))
  )`,
  `CREATE TABLE IF NOT EXISTS role_generation_heads (
    project_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    current_generation INTEGER NOT NULL CHECK (current_generation > 0),
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (project_id, role_id),
    FOREIGN KEY (project_id, role_id, current_generation)
      REFERENCES role_generations(project_id, role_id, generation)
  )`,
];

export const schemaDigest = sha256(MIGRATIONS.join("\n"));

const id = z.string().trim().min(1).max(256);
const targetSchema = z
  .object({
    repoTargetId: id,
    sourceId: id,
    hostId: id,
    path: id,
    remoteUrl: z.string().nullable(),
    defaultBranch: id,
  })
  .strict();
const targetCollectionSchema = z.array(targetSchema).superRefine((targets, ctx) => {
  const seen = new Set<string>();
  for (const [index, target] of targets.entries()) {
    if (seen.has(target.repoTargetId)) {
      ctx.addIssue({
        code: "custom",
        path: [index, "repoTargetId"],
        message: `duplicate repoTargetId ${target.repoTargetId}`,
      });
    }
    seen.add(target.repoTargetId);
  }
});
const decisionSchema = z
  .object({
    decisionId: id,
    repoTargetId: id.nullable(),
    scope: z.unknown(),
    resourceRevision: z.number().int().positive().default(1),
  })
  .strict();

export const WORK_ITEM_STATES = ["proposed", "ready", "in_progress", "succeeded", "failed", "cancelled"] as const;
const workItemStateSchema = z.enum(WORK_ITEM_STATES);
const workItemInputSchema = z
  .object({
    workItemId: id,
    title: z.string().max(4096),
    body: z.string().max(64 * 1024),
  })
  .strict();

const githubMappingSchema = z
  .object({
    repoTargetId: id,
    owner: id,
    repo: id,
    connectorHost: id,
  })
  .strict();
const githubIssueConventionSchema = z
  .object({
    titlePrefix: z.string().max(256).optional(),
    bodyPrefix: z.string().max(4096).optional(),
    managedLabels: z
      .object({
        names: z.array(id).max(128),
        byLifecycle: z.partialRecord(workItemStateSchema, z.array(id).max(128)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const githubIssuesConfigSchema = z
  .object({
    repositoryMappings: z.array(githubMappingSchema).max(128),
    issue: githubIssueConventionSchema.optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const targetIds = new Set<string>();
    for (const [index, mapping] of config.repositoryMappings.entries()) {
      if (targetIds.has(mapping.repoTargetId)) {
        ctx.addIssue({ code: "custom", path: ["repositoryMappings", index, "repoTargetId"], message: "duplicate GitHub repository mapping" });
      }
      targetIds.add(mapping.repoTargetId);
    }
    const managed = config.issue?.managedLabels;
    if (!managed) return;
    const names = new Set(managed.names);
    if (names.size !== managed.names.length) {
      ctx.addIssue({ code: "custom", path: ["issue", "managedLabels", "names"], message: "managed label names must be unique" });
    }
    for (const [state, labels] of Object.entries(managed.byLifecycle ?? {})) {
      if (new Set(labels).size !== labels.length || labels.some((label) => !names.has(label))) {
        ctx.addIssue({ code: "custom", path: ["issue", "managedLabels", "byLifecycle", state], message: "lifecycle labels must be unique declared managed names" });
      }
    }
  });

export const ROLE_IDS = ["project-orchestrator", "independent-reviewer"] as const;
const roleIdSchema = z.enum(ROLE_IDS);
const executionProfileSchema = z
  .object({
    providerId: id,
    model: id,
    reasoningLevel: id,
    permissionMode: id,
    serviceTier: id,
    visibility: z.enum(["visible", "hidden"]),
  })
  .strict();
const roleRequirementSchema = z
  .object({
    roleRequirementId: id,
    roleId: roleIdSchema,
    repoTargetId: id.nullable(),
    executedProfile: executionProfileSchema,
  })
  .strict()
  .superRefine((requirement, ctx) => {
    if (requirement.roleId === "project-orchestrator" && requirement.repoTargetId !== null) {
      ctx.addIssue({ code: "custom", path: ["repoTargetId"], message: "project-orchestrator must be project-scoped" });
    }
    if (requirement.roleId === "independent-reviewer" && requirement.repoTargetId === null) {
      ctx.addIssue({ code: "custom", path: ["repoTargetId"], message: "independent-reviewer requires an exact repository target" });
    }
    if (requirement.executedProfile.visibility !== "visible") {
      ctx.addIssue({ code: "custom", path: ["executedProfile", "visibility"], message: "active role holders must be visible" });
    }
  });
const roleRequirementsSchema = z.array(roleRequirementSchema).max(2).superRefine((requirements, ctx) => {
  const requirementIds = new Set<string>();
  const roleIds = new Set<string>();
  requirements.forEach((requirement, index) => {
    if (requirementIds.has(requirement.roleRequirementId)) {
      ctx.addIssue({ code: "custom", path: [index, "roleRequirementId"], message: "duplicate role requirement" });
    }
    if (roleIds.has(requirement.roleId)) {
      ctx.addIssue({ code: "custom", path: [index, "roleId"], message: "duplicate logical role" });
    }
    requirementIds.add(requirement.roleRequirementId);
    roleIds.add(requirement.roleId);
  });
});
const roleContextRefSchema = z
  .object({
    threadId: id,
    requestEventId: id,
    requestEventSeq: z.number().int().positive(),
    completionEventId: id,
    completionEventSeq: z.number().int().positive(),
  })
  .strict();

export const applyRequestSchema = z
  .object({
    projectId: id,
    operationClass: z.enum([
      "bootstrap",
      "config_revision",
      "governor_claim",
      "decision_disposition",
      "work_item_create",
      "work_item_transition",
      "github_issue_projection",
      "qualification_observation_record",
      "role_generation_succession",
    ]),
    idempotencyKey: id,
    actorReceiptId: id.nullable().optional(),
    expectedConfigRevision: z.number().int().nonnegative().nullable().optional(),
    configRevision: z.number().int().positive().nullable().optional(),
    expectedGovernanceEpoch: z.number().int().nonnegative().nullable().optional(),
    expectedFenceToken: id.nullable().optional(),
    repoTargetId: id.nullable().optional(),
    expectedResourceRevision: z.number().int().positive().nullable().optional(),
    runtimeId: id.optional(),
    config: z.unknown().optional(),
    targets: targetCollectionSchema.optional(),
    decision: decisionSchema.optional(),
    decisionId: id.optional(),
    disposition: z
      .enum(["proposed", "adopted", "rejected", "superseded", "revoked"])
      .optional(),
    reason: z.unknown().optional(),
    workItem: workItemInputSchema.optional(),
    workItemId: id.optional(),
    lifecycleState: workItemStateSchema.optional(),
    projectionKind: z.literal("github_issue").optional(),
    roleId: roleIdSchema.optional(),
    roleRequirementId: id.optional(),
    qualificationId: id.optional(),
    expectedGeneration: z.number().int().positive().nullable().optional(),
    predecessorGeneration: z.number().int().positive().nullable().optional(),
    profileDigest: id.optional(),
    roleContext: roleContextRefSchema.optional(),
    qualificationOutcome: z.enum(["qualified", "unqualified", "unknown"]).optional(),
    observedAtMs: z.number().int().nonnegative().optional(),
    expiresAtMs: z.number().int().nonnegative().nullable().optional(),
    reasonCode: id.optional(),
    fixtureContextDigest: id.optional(),
    declaredProfile: executionProfileSchema.optional(),
  })
  .strict();

export type ApplyRequest = z.infer<typeof applyRequestSchema>;
export type SqliteDatabase = Database.Database;

export interface GitHubIssueSnapshot {
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  externalRevision: string;
}

export interface GitHubIssueMutation {
  kind: "create" | "update";
  owner: string;
  repo: string;
  issueNumber?: number;
  title: string;
  body: string;
  state: "open" | "closed";
  addLabels: string[];
  removeLabels: string[];
}

export interface GitHubIssueAdapter {
  connectorHost: string;
  available: boolean;
  read(owner: string, repo: string, issueNumber: number): GitHubIssueSnapshot | null;
  mutate(input: GitHubIssueMutation): GitHubIssueSnapshot;
}

export interface RoleThreadFact {
  id: string;
  projectId: string;
  environmentId: string | null;
  providerId: string;
  status: string;
  visibility: "visible" | "hidden";
}

export interface RoleEnvironmentFact {
  id: string;
  projectId: string;
  hostId: string;
  path: string | null;
  managed: boolean;
  isGitRepo: boolean;
  isWorktree: boolean;
  workspaceProvisionType: string;
  branchName: string | null;
  baseBranch: string | null;
  defaultBranch: string | null;
  mergeBaseBranch: string | null;
  status: string;
}

export interface RoleProjectFact {
  id: string;
  kind: string;
  name: string;
  gitRemoteUrl: string | null;
  sources: Array<{ id: string; projectId: string; hostId: string; path: string }>;
}

export interface RoleHostFact {
  id: string;
  status: string;
  maxPermissionMode: string;
}

export interface RoleEventFact {
  id: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

export interface RoleFactReader {
  thread(threadId: string): RoleThreadFact;
  events(threadId: string): RoleEventFact[];
  environment(environmentId: string): RoleEnvironmentFact;
  project(projectId: string): RoleProjectFact;
  host(hostId: string): RoleHostFact;
  version(): string;
}

interface ResolvedRoleContext {
  profile: ExecutionProfile;
  profileDigest: string;
  baseContext: Record<string, unknown>;
  holderExecutionAttemptId: string;
  threadId: string;
  environmentId: string;
  sourceId: string;
  hostId: string;
  providerThreadId: string;
  requestEventId: string;
  requestEventSeq: number;
  completionEventId: string;
  completionEventSeq: number;
  bbVersion: string;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function resolveRoleContext(reader: RoleFactReader | null, request: ApplyRequest): ResolvedRoleContext {
  if (!reader || !request.roleContext) throw refusal("ROLE_CONTEXT_REQUIRED", "exact BB role context facts are required");
  let thread: RoleThreadFact;
  let events: RoleEventFact[];
  let environment: RoleEnvironmentFact;
  let project: RoleProjectFact;
  let host: RoleHostFact;
  let bbVersion: string;
  try {
    thread = reader.thread(request.roleContext.threadId);
    events = reader.events(request.roleContext.threadId);
    if (!thread.environmentId) throw refusal("ROLE_CONTEXT_REQUIRED", "holder thread has no environment");
    environment = reader.environment(thread.environmentId);
    project = reader.project(request.projectId);
    host = reader.host(environment.hostId);
    bbVersion = reader.version();
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw refusal("ROLE_CONTEXT_UNKNOWN", "one or more exact BB context facts are unavailable");
  }
  if (thread.id !== request.roleContext.threadId || thread.projectId !== request.projectId || project.id !== request.projectId) {
    throw refusal("ROLE_CONTEXT_FOREIGN", "thread or project context belongs to another project");
  }
  if (thread.visibility !== "visible") throw refusal("ROLE_CONTEXT_HIDDEN", "hidden threads cannot hold active roles");
  if (!new Set(["active", "idle"]).has(thread.status)) throw refusal("ROLE_CONTEXT_UNKNOWN", "holder thread is not in a usable execution state");
  if (!thread.environmentId || environment.id !== thread.environmentId || environment.projectId !== request.projectId) {
    throw refusal("ROLE_CONTEXT_FOREIGN", "environment context does not match the holder thread and project");
  }
  if (
    environment.status !== "ready" ||
    !environment.path ||
    !environment.managed ||
    !environment.isGitRepo ||
    !environment.isWorktree ||
    environment.workspaceProvisionType !== "managed-worktree"
  ) {
    throw refusal("ROLE_CONTEXT_FOREIGN", "holder environment is not an exact ready managed worktree");
  }
  const sources = project.sources.filter(
    (source) => source.projectId === request.projectId && source.hostId === environment.hostId && source.path === environment.path,
  );
  if (sources.length !== 1) throw refusal("ROLE_CONTEXT_FOREIGN", "project source does not resolve uniquely by exact host and path");
  if (host.id !== environment.hostId || host.status !== "connected") throw refusal("ROLE_CONTEXT_UNKNOWN", "holder host is unavailable");
  if (!stringField(bbVersion) || events.length === 0 || events.length > 256) {
    throw refusal("ROLE_CONTEXT_UNKNOWN", "bounded BB version or event facts are unavailable");
  }
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.seq <= events[index - 1]!.seq) throw refusal("EXECUTION_COMPLETION_AMBIGUOUS", "BB event ordering is ambiguous");
  }
  const requestEvents = events.filter(
    (event) => event.id === request.roleContext!.requestEventId && event.seq === request.roleContext!.requestEventSeq && event.type === "client/turn/requested",
  );
  if (requestEvents.length !== 1) throw refusal("EXECUTION_PROFILE_UNKNOWN", "the exact execution-bearing request event is unavailable");
  const requestEvent = requestEvents[0]!;
  const execution = requestEvent.data.execution as Record<string, unknown> | undefined;
  const requestId = stringField(requestEvent.data.requestId);
  if (!execution || !requestId) throw refusal("EXECUTION_PROFILE_UNKNOWN", "execution request correlation is incomplete");
  const model = stringField(execution.model);
  const reasoningLevel = stringField(execution.reasoningLevel);
  const permissionMode = stringField(execution.permissionMode);
  const serviceTier = stringField(execution.serviceTier);
  const executionSource = stringField(execution.source);
  if (!model || !reasoningLevel || !permissionMode || !serviceTier || !executionSource) {
    throw refusal("EXECUTION_PROFILE_UNKNOWN", "execution profile fields are incomplete");
  }
  const accepted = events.filter(
    (event) => event.type === "turn/input/accepted" && event.data.clientRequestId === requestId,
  );
  if (accepted.length !== 1) throw refusal("EXECUTION_COMPLETION_AMBIGUOUS", "execution input correlation is missing or ambiguous");
  const providerThreadId = stringField(accepted[0]!.data.providerThreadId);
  if (!providerThreadId) throw refusal("EXECUTION_PROFILE_UNKNOWN", "provider thread correlation is unavailable");
  const starts = events.filter((event) => event.type === "turn/started" && event.data.providerThreadId === providerThreadId);
  if (starts.length !== 1) throw refusal("EXECUTION_PROFILE_UNKNOWN", "correlated execution start is missing or ambiguous");
  const completions = events.filter((event) => event.type === "turn/completed" && event.data.providerThreadId === providerThreadId);
  if (completions.length !== 1) throw refusal("EXECUTION_COMPLETION_AMBIGUOUS", "correlated execution completion is missing or ambiguous");
  const completion = completions[0]!;
  if (completion.id !== request.roleContext.completionEventId || completion.seq !== request.roleContext.completionEventSeq) {
    throw refusal("EXECUTION_COMPLETION_AMBIGUOUS", "completion does not match the exact requested correlation");
  }
  if (completion.data.status !== "completed") throw refusal("EXECUTION_PROFILE_UNKNOWN", "execution did not complete successfully");
  if (events.some((event) => event.type === "provider/modelFallback" && event.data.providerThreadId === providerThreadId)) {
    throw refusal("EXECUTION_PROFILE_UNKNOWN", "model fallback has no final unambiguous executed profile");
  }
  const profile: ExecutionProfile = {
    providerId: thread.providerId,
    model,
    reasoningLevel,
    permissionMode,
    serviceTier,
    visibility: thread.visibility,
  };
  const permissionRank: Record<string, number> = { "accept-edits": 0, auto: 1, full: 2 };
  if ((permissionRank[profile.permissionMode] ?? 99) > (permissionRank[host.maxPermissionMode] ?? -1)) {
    throw refusal("EXECUTION_PROFILE_MISMATCH", "executed permission exceeds the host permission ceiling");
  }
  const source = sources[0]!;
  const baseContext = {
    project: { id: project.id, kind: project.kind, gitRemoteUrl: project.gitRemoteUrl },
    thread: { id: thread.id, projectId: thread.projectId, providerId: thread.providerId, status: thread.status, visibility: thread.visibility },
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
    source: { id: source.id, projectId: source.projectId, hostId: source.hostId, path: source.path },
    host: { id: host.id, status: host.status, maxPermissionMode: host.maxPermissionMode },
    execution: {
      providerThreadId,
      requestId,
      requestEventId: requestEvent.id,
      requestEventSeq: requestEvent.seq,
      completionEventId: completion.id,
      completionEventSeq: completion.seq,
      source: executionSource,
    },
    bbVersion,
    pluginSdkVersion: PLUGIN_SDK_VERSION,
  };
  const holderExecutionAttemptId = sha256(canonicalJson({
    projectId: request.projectId,
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId,
    requestId,
    requestEventId: requestEvent.id,
    requestEventSeq: requestEvent.seq,
    completionEventId: completion.id,
    completionEventSeq: completion.seq,
  }));
  return {
    profile,
    profileDigest: sha256(canonicalJson(profile)),
    baseContext,
    holderExecutionAttemptId,
    threadId: thread.id,
    environmentId: environment.id,
    sourceId: source.id,
    hostId: host.id,
    providerThreadId,
    requestEventId: requestEvent.id,
    requestEventSeq: requestEvent.seq,
    completionEventId: completion.id,
    completionEventSeq: completion.seq,
    bbVersion,
  };
}

export class GitHubIssueAdapterError extends Error {
  constructor(readonly kind: "unavailable" | "ambiguous") {
    super(kind);
    this.name = "GitHubIssueAdapterError";
  }
}

export type FoundationCode =
  | "OK"
  | "PROJECT_UNKNOWN"
  | "PROJECT_REQUIRED"
  | "PROJECT_CONFIG_REQUIRED"
  | "PROJECT_CONFIG_STALE"
  | "REPO_TARGET_REQUIRED"
  | "REPO_TARGET_AMBIGUOUS"
  | "REPO_TARGET_FOREIGN"
  | "REPO_TARGET_STALE"
  | "GOVERNOR_UNAVAILABLE"
  | "GOVERNOR_CAS_FAILED"
  | "GOVERNOR_EPOCH_STALE"
  | "PROJECT_FROZEN"
  | "ACTOR_RECEIPT_REQUIRED"
  | "ACTOR_RECEIPT_FOREIGN"
  | "ACTOR_RECEIPT_UNKNOWN"
  | "ACTOR_RECEIPT_UNVERIFIED"
  | "RESOURCE_UNKNOWN"
  | "RESOURCE_REVISION_STALE"
  | "WORK_ITEM_UNKNOWN"
  | "WORK_ITEM_FOREIGN"
  | "WORK_ITEM_STATE_INVALID"
  | "WORK_ITEM_REVISION_STALE"
  | "EXTERNAL_REF_REQUIRED"
  | "EXTERNAL_REF_FOREIGN"
  | "EXTERNAL_REF_CONFLICT"
  | "EXTERNAL_TARGET_REQUIRED"
  | "EXTERNAL_TARGET_MISMATCH"
  | "EXTERNAL_NOT_FOUND"
  | "EXTERNAL_DIVERGED"
  | "EXTERNAL_UNAVAILABLE"
  | "EXTERNAL_CAPABILITY_REQUIRED"
  | "EXTERNAL_RESPONSE_INVALID"
  | "EXTERNAL_DELIVERY_AMBIGUOUS"
  | "ROLE_REQUIREMENT_UNKNOWN"
  | "ROLE_HEAD_UNAVAILABLE"
  | "ROLE_GENERATION_STALE"
  | "ROLE_PREDECESSOR_MISMATCH"
  | "ROLE_NOT_ACTIVE"
  | "ROLE_CONTEXT_REQUIRED"
  | "ROLE_CONTEXT_UNKNOWN"
  | "ROLE_CONTEXT_FOREIGN"
  | "ROLE_CONTEXT_HIDDEN"
  | "ROLE_HOLDER_MISMATCH"
  | "EXECUTION_PROFILE_UNKNOWN"
  | "EXECUTION_PROFILE_MISMATCH"
  | "EXECUTION_COMPLETION_AMBIGUOUS"
  | "ROLE_UNQUALIFIED"
  | "CAPABILITY_UNKNOWN"
  | "QUALIFICATION_CONTEXT_FOREIGN"
  | "ELIGIBILITY_EXPIRED"
  | "ELIGIBILITY_STALE"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "CANONICAL_STORE_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "OPERATOR_AUTH_REQUIRED"
  | "CONFIG_SECRET_FORBIDDEN"
  | "MALFORMED_JSON"
  | "INVALID_INPUT"
  | "BB_VERSION_INCOMPATIBLE"
  | "BB_FACTS_UNAVAILABLE"
  | "HOST_UNAVAILABLE"
  | "EXPORT_BOUNDED";

export interface MutationReceipt {
  projectId: string;
  idempotencyKey: string;
  operationClass: string;
  requestDigest: string;
  committedEventSequence: number;
  createdAtMs: number;
}

export interface FoundationResult {
  outcome: FoundationCode;
  subject: string;
  expected: number;
  attempted: number;
  verified: number;
  message?: string;
  currentConfigRevision?: number;
  expectedConfigRevision?: number;
  currentGovernanceEpoch?: number;
  expectedGovernanceEpoch?: number;
  currentResourceRevision?: number;
  expectedResourceRevision?: number;
  mutationReceipt?: MutationReceipt;
  eventSequence?: number;
  evidence?: unknown;
  export?: ExportPayload;
}

export interface ExportPayload {
  manifest: {
    schemaVersion: number;
    pluginId: string;
    projectId: string;
    migrationStatementIds: number[];
    schemaDigest: string;
    rowCount: number;
    tableCounts: Record<string, number>;
    recordsDigest: string;
  };
  recordsNdjson: string;
  checksums: Record<string, string>;
}

interface RefusalData {
  code: FoundationCode;
  message: string;
  currentConfigRevision?: number;
  expectedConfigRevision?: number;
  currentGovernanceEpoch?: number;
  expectedGovernanceEpoch?: number;
  currentResourceRevision?: number;
  expectedResourceRevision?: number;
  expected?: number;
  attempted?: number;
  verified?: number;
}

class Refusal extends Error {
  readonly data: RefusalData;

  constructor(data: RefusalData) {
    super(data.message);
    this.name = "Refusal";
    this.data = data;
  }
}

function refusal(code: FoundationCode, message: string, extra: Omit<RefusalData, "code" | "message"> = {}): Refusal {
  return new Refusal({ code, message, ...extra });
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableValue(value: unknown, path = "$", seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw refusal("MALFORMED_JSON", `non-finite number at ${path}`);
    return value;
  }
  if (typeof value !== "object") throw refusal("MALFORMED_JSON", `unsupported value at ${path}`);
  if (seen.has(value)) throw refusal("MALFORMED_JSON", `cyclic value at ${path}`);
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item, index) => stableValue(item, `${path}[${index}]`, seen));
  } else {
    const record = value as Record<string, unknown>;
    result = Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableValue(record[key], `${path}.${key}`, seen)]),
    );
  }
  seen.delete(value);
  return result;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function validateConfig(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw refusal("MALFORMED_JSON", "config must be a JSON object");
  }
  const config = value as Record<string, unknown>;
  assertNoSecretValues(value);
  if (typeof config.permissionMode !== "string" || typeof config.visibility !== "string") {
    throw refusal("INVALID_INPUT", "config must declare permissionMode and visibility explicitly");
  }
  if (!["full", "auto", "accept-edits"].includes(config.permissionMode)) {
    throw refusal("INVALID_INPUT", "config permissionMode is not a BB permission mode");
  }
  if (!["visible", "hidden"].includes(config.visibility)) {
    throw refusal("INVALID_INPUT", "config visibility is not a BB visibility value");
  }
  const extensions = config.extensions;
  if (extensions !== undefined) {
    if (extensions === null || typeof extensions !== "object" || Array.isArray(extensions)) {
      throw refusal("INVALID_INPUT", "config extensions must be an object");
    }
    const bbCollab = (extensions as Record<string, unknown>).bbCollab;
    if (bbCollab !== undefined) {
      if (bbCollab === null || typeof bbCollab !== "object" || Array.isArray(bbCollab)) {
        throw refusal("INVALID_INPUT", "config extensions.bbCollab must be an object");
      }
      const githubIssues = (bbCollab as Record<string, unknown>).githubIssues;
      if (githubIssues !== undefined) {
        const parsed = githubIssuesConfigSchema.safeParse(githubIssues);
        if (!parsed.success) throw refusal("INVALID_INPUT", parsed.error.message);
      }
      const roleRequirements = (bbCollab as Record<string, unknown>).roleRequirements;
      if (roleRequirements !== undefined) {
        const parsed = roleRequirementsSchema.safeParse(roleRequirements);
        if (!parsed.success) throw refusal("INVALID_INPUT", parsed.error.message);
      }
    }
  }
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, "utf8") > 64 * 1024) {
    throw refusal("MALFORMED_JSON", "config exceeds 64 KiB");
  }
  return json;
}

type GithubIssuesConfig = z.infer<typeof githubIssuesConfigSchema>;
type WorkItemState = (typeof WORK_ITEM_STATES)[number];
type ExecutionProfile = z.infer<typeof executionProfileSchema>;
type RoleRequirement = z.infer<typeof roleRequirementSchema>;

function githubConfigFromJson(configJson: string): GithubIssuesConfig | null {
  const config = JSON.parse(configJson) as {
    extensions?: { bbCollab?: { githubIssues?: unknown } };
  };
  const value = config.extensions?.bbCollab?.githubIssues;
  if (value === undefined) return null;
  const parsed = githubIssuesConfigSchema.safeParse(value);
  if (!parsed.success) throw refusal("INVALID_INPUT", "stored GitHub Issues config is invalid");
  return parsed.data;
}

function roleRequirementsFromJson(configJson: string): RoleRequirement[] {
  const config = JSON.parse(configJson) as {
    extensions?: { bbCollab?: { roleRequirements?: unknown } };
  };
  const value = config.extensions?.bbCollab?.roleRequirements;
  if (value === undefined) return [];
  const parsed = roleRequirementsSchema.safeParse(value);
  if (!parsed.success) throw refusal("INVALID_INPUT", "stored role requirements are invalid");
  return parsed.data;
}

function requireMappedTargets(configJson: string, targets: NonNullable<ApplyRequest["targets"]>): void {
  const github = githubConfigFromJson(configJson);
  const targetIds = new Set(targets.map((target) => target.repoTargetId));
  if (github?.repositoryMappings.some((mapping) => !targetIds.has(mapping.repoTargetId))) {
    throw refusal("REPO_TARGET_FOREIGN", "GitHub repository mapping names a target outside the config revision");
  }
  if (roleRequirementsFromJson(configJson).some((requirement) => requirement.repoTargetId && !targetIds.has(requirement.repoTargetId))) {
    throw refusal("REPO_TARGET_FOREIGN", "role requirement names a target outside the config revision");
  }
}

function assertNoSecretValues(value: unknown, path = "config"): void {
  // Structural key rejection cannot classify arbitrary string values reliably; callers and project schemas must pass references only.
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretValues(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:secret|password|token|api[-_]?key|private[-_]?key)/iu.test(key) && !/ref$/iu.test(key)) {
      throw refusal("CONFIG_SECRET_FORBIDDEN", `config secret material is not allowed at ${path}.${key}`);
    }
    assertNoSecretValues(child, `${path}.${key}`);
  }
}

function normalizeRequest(request: ApplyRequest): ApplyRequest {
  return {
    ...request,
    actorReceiptId: request.actorReceiptId ?? null,
    expectedConfigRevision: request.expectedConfigRevision ?? null,
    configRevision: request.configRevision ?? null,
    expectedGovernanceEpoch: request.expectedGovernanceEpoch ?? null,
    expectedFenceToken: request.expectedFenceToken ?? null,
    repoTargetId: request.repoTargetId ?? null,
    expectedResourceRevision: request.expectedResourceRevision ?? null,
    runtimeId: request.runtimeId ?? undefined,
    config: request.config ?? undefined,
    targets: request.targets ?? undefined,
    decision: request.decision ?? undefined,
    decisionId: request.decisionId ?? undefined,
    disposition: request.disposition ?? undefined,
    reason: request.reason ?? undefined,
    workItem: request.workItem ?? undefined,
    workItemId: request.workItemId ?? undefined,
    lifecycleState: request.lifecycleState ?? undefined,
    projectionKind: request.projectionKind ?? undefined,
    roleId: request.roleId ?? undefined,
    roleRequirementId: request.roleRequirementId ?? undefined,
    qualificationId: request.qualificationId ?? undefined,
    expectedGeneration: request.expectedGeneration ?? null,
    predecessorGeneration: request.predecessorGeneration ?? null,
    profileDigest: request.profileDigest ?? undefined,
    roleContext: request.roleContext ?? undefined,
    qualificationOutcome: request.qualificationOutcome ?? undefined,
    observedAtMs: request.observedAtMs ?? undefined,
    expiresAtMs: request.expiresAtMs ?? null,
    reasonCode: request.reasonCode ?? undefined,
    fixtureContextDigest: request.fixtureContextDigest ?? undefined,
    declaredProfile: request.declaredProfile ?? undefined,
  };
}

export function parseApplyRequest(input: unknown): ApplyRequest {
  const parsed = applyRequestSchema.safeParse(input);
  if (!parsed.success) throw refusal("INVALID_INPUT", parsed.error.message);
  return normalizeRequest(parsed.data);
}

function result(
  outcome: FoundationCode,
  subject: string,
  expected: number,
  attempted: number,
  verified: number,
  extra: Omit<FoundationResult, "outcome" | "subject" | "expected" | "attempted" | "verified"> = {},
): FoundationResult {
  return Object.fromEntries(
    Object.entries({ outcome, subject, expected, attempted, verified, ...extra }).filter(([, value]) => value !== undefined),
  ) as unknown as FoundationResult;
}

function refusalResult(subject: string, data: RefusalData, expected = 1, attempted = 0, verified = 0): FoundationResult {
  return result(data.code, subject, data.expected ?? expected, data.attempted ?? attempted, data.verified ?? verified, {
    message: data.message,
    ...(data.currentConfigRevision === undefined ? {} : { currentConfigRevision: data.currentConfigRevision }),
    ...(data.expectedConfigRevision === undefined ? {} : { expectedConfigRevision: data.expectedConfigRevision }),
    ...(data.currentGovernanceEpoch === undefined ? {} : { currentGovernanceEpoch: data.currentGovernanceEpoch }),
    ...(data.expectedGovernanceEpoch === undefined ? {} : { expectedGovernanceEpoch: data.expectedGovernanceEpoch }),
    ...(data.currentResourceRevision === undefined ? {} : { currentResourceRevision: data.currentResourceRevision }),
    ...(data.expectedResourceRevision === undefined ? {} : { expectedResourceRevision: data.expectedResourceRevision }),
  });
}

function requestDigest(request: ApplyRequest): string {
  const digestable = Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined));
  return sha256(canonicalJson(digestable));
}

function now(): number {
  return Date.now();
}

function newFenceToken(): string {
  return randomBytes(24).toString("hex");
}

function asRow<T>(row: unknown): T | undefined {
  return row as T | undefined;
}

function transaction<T>(db: SqliteDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original database/refusal error.
    }
    throw error;
  }
}

function currentConfig(db: SqliteDatabase, projectId: string): { config_revision: number } | undefined {
  return asRow(db.prepare("SELECT config_revision FROM project_config_heads WHERE project_id = ?").get(projectId));
}

function requireConfig(db: SqliteDatabase, request: ApplyRequest): number {
  const head = currentConfig(db, request.projectId);
  if (!head) throw refusal("PROJECT_CONFIG_REQUIRED", "project has no stored config revision");
  if (request.expectedConfigRevision !== head.config_revision) {
    throw refusal("PROJECT_CONFIG_STALE", "expected config revision does not match the current head", {
      currentConfigRevision: head.config_revision,
      expectedConfigRevision: request.expectedConfigRevision ?? undefined,
    });
  }
  return head.config_revision;
}

function requireActor(db: SqliteDatabase, request: ApplyRequest): string {
  if (!request.actorReceiptId) throw refusal("ACTOR_RECEIPT_REQUIRED", "a typed actor receipt is required");
  const row = asRow<{
    project_id: string;
    actor_kind: string;
    subject_id: string;
    role_id: string | null;
    role_generation: number | null;
    verification_state: string;
    receipt_digest: string;
  }>(
    db.prepare("SELECT project_id, actor_kind, subject_id, role_id, role_generation, verification_state, receipt_digest FROM actor_receipts WHERE receipt_id = ?").get(request.actorReceiptId),
  );
  if (!row) throw refusal("ACTOR_RECEIPT_UNKNOWN", "actor receipt is not known");
  if (row.project_id !== request.projectId) throw refusal("ACTOR_RECEIPT_FOREIGN", "actor receipt belongs to another project");
  if (row.verification_state !== "verified") throw refusal("ACTOR_RECEIPT_UNVERIFIED", "actor receipt is not verified");
  const expectedDigest = sha256(
    canonicalJson({
      projectId: row.project_id,
      receiptId: request.actorReceiptId,
      actorKind: row.actor_kind,
      subjectId: row.subject_id,
      roleId: row.role_id,
      roleGeneration: row.role_generation,
      verificationState: row.verification_state,
    }),
  );
  if (row.receipt_digest !== expectedDigest) throw refusal("ACTOR_RECEIPT_UNVERIFIED", "actor receipt digest is invalid");
  return request.actorReceiptId;
}

function requireGovernor(db: SqliteDatabase, request: ApplyRequest): { governance_epoch: number; fence_token: string; state: string } {
  const head = asRow<{ governance_epoch: number; fence_token: string; state: string }>(
    db.prepare("SELECT governance_epoch, fence_token, state FROM project_governorship_heads WHERE project_id = ?").get(request.projectId),
  );
  // Issue #3 only reports this on an incomplete/corrupt state; no sanctioned path creates it.
  if (!head) throw refusal("GOVERNOR_UNAVAILABLE", "project has no current governorship head");
  if (
    request.expectedGovernanceEpoch !== head.governance_epoch ||
    request.expectedFenceToken !== head.fence_token
  ) {
    throw refusal("GOVERNOR_EPOCH_STALE", "expected governorship epoch or fence token is stale", {
      currentGovernanceEpoch: head.governance_epoch,
      expectedGovernanceEpoch: request.expectedGovernanceEpoch ?? undefined,
    });
  }
  // Deferred ceiling: issue #3 has no sanctioned freeze/cutover operation; PROJECT_FROZEN is reserved for that later slice.
  if (head.state !== "target_active") throw refusal("PROJECT_FROZEN", "project governorship is not writable");
  return head;
}

function targetDigest(target: NonNullable<ApplyRequest["targets"]>[number]): string {
  return sha256(
    canonicalJson({
      repoTargetId: target.repoTargetId,
      sourceId: target.sourceId,
      hostId: target.hostId,
      path: target.path,
      remoteUrl: target.remoteUrl,
      defaultBranch: target.defaultBranch,
    }),
  );
}

function requireTargetCollection(request: ApplyRequest, operation: string): NonNullable<ApplyRequest["targets"]> {
  const targets = request.targets;
  if (!targets || targets.length === 0) {
    throw refusal("REPO_TARGET_REQUIRED", `${operation} requires one or more exact repository targets`);
  }
  if (request.repoTargetId && !targets.some((target) => target.repoTargetId === request.repoTargetId)) {
    throw refusal("REPO_TARGET_FOREIGN", "repository target selector is not present in the target collection");
  }
  return targets;
}

function requireTarget(
  db: SqliteDatabase,
  projectId: string,
  configRevision: number,
  targetId: string | null | undefined,
): Record<string, unknown> {
  const current = db
    .prepare("SELECT * FROM repository_targets WHERE project_id = ? AND config_revision = ? ORDER BY repo_target_id")
    .all(projectId, configRevision) as Record<string, unknown>[];
  if (!targetId) {
    if (current.length > 1) throw refusal("REPO_TARGET_AMBIGUOUS", "an exact repository target is required");
    throw refusal("REPO_TARGET_REQUIRED", "an exact repository target is required");
  }
  const found = asRow<Record<string, unknown>>(
    db
      .prepare(
        "SELECT * FROM repository_targets WHERE project_id = ? AND repo_target_id = ? AND config_revision = ?",
      )
      .get(projectId, targetId, configRevision),
  );
  if (found) return found;
  const sameProject = asRow<{ config_revision: number }>(
    db.prepare("SELECT config_revision FROM repository_targets WHERE project_id = ? AND repo_target_id = ? ORDER BY config_revision DESC LIMIT 1").get(projectId, targetId),
  );
  if (sameProject) throw refusal("REPO_TARGET_STALE", "repository target is not registered in the expected config revision");
  throw refusal("REPO_TARGET_FOREIGN", "repository target is not registered for this project");
}

function checkIdempotency(db: SqliteDatabase, request: ApplyRequest, digest: string): FoundationResult | null {
  const row = asRow<{ request_digest: string; outcome_json: string }>(
    db.prepare("SELECT request_digest, outcome_json FROM mutation_receipts WHERE project_id = ? AND idempotency_key = ?").get(
      request.projectId,
      request.idempotencyKey,
    ),
  );
  if (!row) return null;
  if (row.request_digest !== digest) {
    throw refusal("IDEMPOTENCY_KEY_CONFLICT", "idempotency key was already used for another request");
  }
  return JSON.parse(row.outcome_json) as FoundationResult;
}

function nextEventSequence(db: SqliteDatabase, projectId: string): number {
  const row = asRow<{ next_sequence: number }>(
    db.prepare("SELECT COALESCE(MAX(event_sequence), 0) + 1 AS next_sequence FROM state_events WHERE project_id = ?").get(projectId),
  );
  return row?.next_sequence ?? 1;
}

interface StateEventInput {
  aggregateType: string;
  aggregateId: string;
  aggregateRevision: number;
  eventType: string;
  event: unknown;
}

function appendStateEvent(
  db: SqliteDatabase,
  request: ApplyRequest,
  actorReceiptId: string,
  event: StateEventInput,
): { eventSequence: number; createdAtMs: number } {
  const eventSequence = nextEventSequence(db, request.projectId);
  const createdAtMs = now();
  db.prepare(
    `INSERT INTO state_events (
      project_id, event_sequence, aggregate_type, aggregate_id, aggregate_revision,
      event_type, actor_receipt_id, idempotency_key, event_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    request.projectId,
    eventSequence,
    event.aggregateType,
    event.aggregateId,
    event.aggregateRevision,
    event.eventType,
    actorReceiptId,
    request.idempotencyKey,
    canonicalJson(event.event),
    createdAtMs,
  );
  return { eventSequence, createdAtMs };
}

function commitMutation(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  actorReceiptId: string,
  event: StateEventInput,
  counts: { expected: number; attempted: number; verified: number },
  extra: Omit<FoundationResult, "outcome" | "subject" | "expected" | "attempted" | "verified" | "eventSequence" | "mutationReceipt"> = {},
  outcome: FoundationCode = "OK",
): FoundationResult {
  const { eventSequence, createdAtMs } = appendStateEvent(db, request, actorReceiptId, event);
  const mutationReceipt: MutationReceipt = {
    projectId: request.projectId,
    idempotencyKey: request.idempotencyKey,
    operationClass: request.operationClass,
    requestDigest: digest,
    committedEventSequence: eventSequence,
    createdAtMs,
  };
  const output = result(outcome, request.projectId, counts.expected, counts.attempted, counts.verified, {
    ...extra,
    mutationReceipt,
    eventSequence,
  });
  db.prepare(
    `INSERT INTO mutation_receipts (
      project_id, idempotency_key, operation_class, request_digest,
      outcome_json, committed_event_sequence, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    request.projectId,
    request.idempotencyKey,
    request.operationClass,
    digest,
    canonicalJson(output),
    eventSequence,
    createdAtMs,
  );
  return output;
}

function applyBootstrap(db: SqliteDatabase, request: ApplyRequest, digest: string): FoundationResult {
  if (request.expectedConfigRevision !== null) {
    throw refusal("PROJECT_CONFIG_STALE", "bootstrap requires an empty config head");
  }
  if (request.configRevision !== null && request.configRevision !== 1) {
    throw refusal("PROJECT_CONFIG_STALE", "bootstrap config revision must be 1", {
      expectedConfigRevision: 1,
    });
  }
  if (request.expectedGovernanceEpoch !== null || request.expectedFenceToken !== null) {
    throw refusal("GOVERNOR_CAS_FAILED", "bootstrap requires an empty governorship head");
  }
  const actorReceiptId = requireActor(db, request);
  const config = request.config === undefined ? undefined : validateConfig(request.config);
  if (!config) throw refusal("INVALID_INPUT", "bootstrap requires a config object");
  const targets = requireTargetCollection(request, "bootstrap");
  requireMappedTargets(config, targets);
  const existingConfig = currentConfig(db, request.projectId);
  const existingGovernor = db
    .prepare("SELECT 1 FROM project_governorship_heads WHERE project_id = ?")
    .get(request.projectId);
  if (existingConfig || existingGovernor) throw refusal("GOVERNOR_CAS_FAILED", "bootstrap head already exists");
  const createdAtMs = now();
  db.prepare(
    `INSERT INTO project_config_revisions
      (project_id, config_revision, canonical_config_json, config_digest, created_at_ms)
     VALUES (?, 1, ?, ?, ?)`,
  ).run(request.projectId, config, sha256(config), createdAtMs);
  db.prepare("INSERT INTO project_config_heads (project_id, config_revision, updated_at_ms) VALUES (?, 1, ?)").run(
    request.projectId,
    createdAtMs,
  );
  const insertTarget = db.prepare(
    `INSERT INTO repository_targets
      (project_id, repo_target_id, config_revision, source_id, host_id, path, remote_url, default_branch, target_digest)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  );
  for (const target of targets) {
    insertTarget.run(
      request.projectId,
      target.repoTargetId,
      target.sourceId,
      target.hostId,
      target.path,
      target.remoteUrl,
      target.defaultBranch,
      targetDigest(target),
    );
  }
  const fenceToken = newFenceToken();
  db.prepare(
    `INSERT INTO project_governorships
      (project_id, governance_epoch, runtime_id, state, fence_token, actor_receipt_id, predecessor_epoch, created_at_ms)
     VALUES (?, 1, ?, 'target_active', ?, ?, NULL, ?)`,
  ).run(request.projectId, request.runtimeId ?? PLUGIN_ID, fenceToken, actorReceiptId, createdAtMs);
  db.prepare(
    `INSERT INTO project_governorship_heads
      (project_id, governance_epoch, fence_token, state, updated_at_ms)
     VALUES (?, 1, ?, 'target_active', ?)`,
  ).run(request.projectId, fenceToken, createdAtMs);
  if (request.decision) {
    const decision = request.decision;
    if (decision.repoTargetId !== null && !targets.some((target) => target.repoTargetId === decision.repoTargetId)) {
      throw refusal("REPO_TARGET_FOREIGN", "decision target does not match bootstrap target");
    }
    const scopeJson = canonicalJson(decision.scope);
    db.prepare(
      `INSERT INTO decisions
        (decision_id, project_id, config_revision, repo_target_id, scope_json, scope_digest, current_resource_revision)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
    ).run(
      decision.decisionId,
      request.projectId,
      decision.repoTargetId,
      scopeJson,
      sha256(scopeJson),
      decision.resourceRevision,
    );
  }
  return commitMutation(
    db,
    request,
    digest,
    actorReceiptId,
    {
      aggregateType: "project",
      aggregateId: request.projectId,
      aggregateRevision: 1,
      eventType: "foundation_bootstrapped",
      event: { configRevision: 1, repoTargetIds: targets.map((target) => target.repoTargetId), governanceEpoch: 1 },
    },
    { expected: targets.length + 2, attempted: targets.length + 2, verified: targets.length + 2 },
    {
      currentConfigRevision: 1,
      currentGovernanceEpoch: 1,
      evidence: {
        configDigest: sha256(config),
        targetDigests: targets.map((target) => ({ repoTargetId: target.repoTargetId, digest: targetDigest(target) })),
        fenceToken,
      },
    },
  );
}

function applyConfigRevision(db: SqliteDatabase, request: ApplyRequest, digest: string): FoundationResult {
  const currentRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  if (!request.config || !request.targets) {
    requireTarget(db, request.projectId, currentRevision, request.repoTargetId);
    throw refusal("INVALID_INPUT", "config revision requires config and target collection");
  }
  const configJson = validateConfig(request.config);
  const targets = requireTargetCollection(request, "config revision");
  requireMappedTargets(configJson, targets);
  const nextRevision = currentRevision + 1;
  if (request.configRevision !== null && request.configRevision !== nextRevision) {
    throw refusal("PROJECT_CONFIG_STALE", "new config revision is not the next immutable revision", {
      currentConfigRevision: currentRevision,
      expectedConfigRevision: nextRevision,
    });
  }
  const createdAtMs = now();
  db.prepare(
    `INSERT INTO project_config_revisions
      (project_id, config_revision, canonical_config_json, config_digest, created_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(request.projectId, nextRevision, configJson, sha256(configJson), createdAtMs);
  const insertTarget = db.prepare(
    `INSERT INTO repository_targets
      (project_id, repo_target_id, config_revision, source_id, host_id, path, remote_url, default_branch, target_digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const target of targets) {
    insertTarget.run(
      request.projectId,
      target.repoTargetId,
      nextRevision,
      target.sourceId,
      target.hostId,
      target.path,
      target.remoteUrl,
      target.defaultBranch,
      targetDigest(target),
    );
  }
  const headUpdate = db
    .prepare(
      "UPDATE project_config_heads SET config_revision = ?, updated_at_ms = ? WHERE project_id = ? AND config_revision = ?",
    )
    .run(nextRevision, createdAtMs, request.projectId, currentRevision);
  if (headUpdate.changes !== 1) {
    throw refusal("PROJECT_CONFIG_STALE", "config head compare-and-swap failed", {
      currentConfigRevision: currentRevision,
      expectedConfigRevision: currentRevision,
    });
  }
  return commitMutation(
    db,
    request,
    digest,
    actorReceiptId,
    {
      aggregateType: "project_config",
      aggregateId: request.projectId,
      aggregateRevision: nextRevision,
      eventType: "config_revision_appended",
      event: { configRevision: nextRevision, repoTargetIds: targets.map((target) => target.repoTargetId), previousGovernorEpoch: governor.governance_epoch },
    },
    { expected: targets.length + 1, attempted: targets.length + 1, verified: targets.length + 1 },
    { currentConfigRevision: nextRevision, currentGovernanceEpoch: governor.governance_epoch },
  );
}

function applyGovernorClaim(db: SqliteDatabase, request: ApplyRequest, digest: string): FoundationResult {
  const currentRevision = requireConfig(db, request);
  const currentHead = asRow<{ governance_epoch: number; fence_token: string; state: string }>(
    db.prepare("SELECT governance_epoch, fence_token, state FROM project_governorship_heads WHERE project_id = ?").get(request.projectId),
  );
  if (!currentHead) throw refusal("GOVERNOR_UNAVAILABLE", "project has no current governorship head");
  // Deferred ceiling: issue #3 cannot transition a governorship to frozen; later cutover owns PROJECT_FROZEN.
  if (currentHead.state !== "target_active") throw refusal("PROJECT_FROZEN", "project governorship is not writable");
  const expectedEpoch = request.expectedGovernanceEpoch;
  const expectedToken = request.expectedFenceToken;
  if (expectedEpoch === null || expectedEpoch === undefined || expectedToken === null || expectedToken === undefined) {
    throw refusal("GOVERNOR_EPOCH_STALE", "governor claim requires an expected epoch and fence token", {
      currentGovernanceEpoch: currentHead.governance_epoch,
      expectedGovernanceEpoch: request.expectedGovernanceEpoch ?? undefined,
    });
  }
  const actorReceiptId = requireActor(db, request);
  const nextEpoch = expectedEpoch + 1;
  const nextToken = newFenceToken();
  try {
    db.prepare(
      `INSERT INTO project_governorships
        (project_id, governance_epoch, runtime_id, state, fence_token, actor_receipt_id, predecessor_epoch, created_at_ms)
       VALUES (?, ?, ?, 'target_active', ?, ?, ?, ?)`,
    ).run(
      request.projectId,
      nextEpoch,
      request.runtimeId ?? PLUGIN_ID,
      nextToken,
      actorReceiptId,
      expectedEpoch,
      now(),
    );
  } catch (error) {
    if (isConstraintError(error)) throw refusal("GOVERNOR_CAS_FAILED", "governorship claim lost its compare-and-swap race");
    throw error;
  }
  const headUpdate = db
    .prepare(
      `UPDATE project_governorship_heads
       SET governance_epoch = ?, fence_token = ?, state = 'target_active', updated_at_ms = ?
       WHERE project_id = ? AND governance_epoch = ? AND fence_token = ?`,
    )
    .run(nextEpoch, nextToken, now(), request.projectId, expectedEpoch, expectedToken);
  if (headUpdate.changes !== 1) throw refusal("GOVERNOR_CAS_FAILED", "governorship head compare-and-swap failed");
  return commitMutation(
    db,
    request,
    digest,
    actorReceiptId,
    {
      aggregateType: "project_governorship",
      aggregateId: request.projectId,
      aggregateRevision: nextEpoch,
      eventType: "governorship_claimed",
      event: { governanceEpoch: nextEpoch, predecessorEpoch: expectedEpoch },
    },
    { expected: 1, attempted: 1, verified: 1 },
    { currentConfigRevision: currentRevision, currentGovernanceEpoch: nextEpoch, evidence: { fenceToken: nextToken } },
  );
}

function applyDecisionDisposition(db: SqliteDatabase, request: ApplyRequest, digest: string): FoundationResult {
  const currentRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  const decisionId = request.decisionId;
  if (!decisionId || !request.disposition) throw refusal("INVALID_INPUT", "decision disposition requires decisionId and disposition");
  const decision = asRow<{
    decision_id: string;
    project_id: string;
    config_revision: number;
    repo_target_id: string | null;
    current_resource_revision: number;
  }>(db.prepare("SELECT * FROM decisions WHERE decision_id = ?").get(decisionId));
  if (!decision) throw refusal("RESOURCE_UNKNOWN", "decision is not known");
  if (decision.project_id !== request.projectId) throw refusal("RESOURCE_UNKNOWN", "decision belongs to another project");
  if (decision.config_revision !== currentRevision) {
    throw refusal("PROJECT_CONFIG_STALE", "decision is bound to a stale config revision", {
      currentConfigRevision: currentRevision,
      expectedConfigRevision: request.expectedConfigRevision ?? undefined,
    });
  }
  if (decision.repo_target_id) {
    if (!request.repoTargetId) throw refusal("REPO_TARGET_REQUIRED", "decision requires its exact repository target");
    if (request.repoTargetId !== decision.repo_target_id) throw refusal("REPO_TARGET_FOREIGN", "decision target does not match the exact repository target");
    requireTarget(db, request.projectId, currentRevision, request.repoTargetId);
  } else if (request.repoTargetId) {
    throw refusal("REPO_TARGET_FOREIGN", "project-scoped decision cannot accept a repository target");
  }
  const expectedResourceRevision = request.expectedResourceRevision;
  if (expectedResourceRevision !== decision.current_resource_revision) {
    throw refusal("RESOURCE_REVISION_STALE", "decision resource revision is stale", {
      currentResourceRevision: decision.current_resource_revision,
      expectedResourceRevision: expectedResourceRevision ?? undefined,
    });
  }
  const nextRevision = decision.current_resource_revision + 1;
  const update = db
    .prepare(
      `UPDATE decisions SET current_resource_revision = ?
       WHERE decision_id = ? AND project_id = ? AND current_resource_revision = ?`,
    )
    .run(nextRevision, decisionId, request.projectId, expectedResourceRevision);
  if (update.changes !== 1) {
    throw refusal("RESOURCE_REVISION_STALE", "decision compare-and-swap failed", {
      currentResourceRevision: decision.current_resource_revision,
      expectedResourceRevision,
    });
  }
  const sequenceRow = asRow<{ next_sequence: number }>(
    db.prepare("SELECT COALESCE(MAX(disposition_sequence), 0) + 1 AS next_sequence FROM decision_dispositions WHERE decision_id = ?").get(decisionId),
  );
  const sequence = sequenceRow?.next_sequence ?? 1;
  const reasonJson = canonicalJson(request.reason ?? {});
  db.prepare(
    `INSERT INTO decision_dispositions
      (decision_id, disposition_sequence, disposition, actor_receipt_id, reason_json, created_at_ms, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(decisionId, sequence, request.disposition, actorReceiptId, reasonJson, now(), request.idempotencyKey);
  return commitMutation(
    db,
    request,
    digest,
    actorReceiptId,
    {
      aggregateType: "decision",
      aggregateId: decisionId,
      aggregateRevision: nextRevision,
      eventType: "decision_disposition_appended",
      event: { decisionId, dispositionSequence: sequence, disposition: request.disposition },
    },
    { expected: 1, attempted: 1, verified: 1 },
    {
      currentConfigRevision: currentRevision,
      currentGovernanceEpoch: governor.governance_epoch,
      currentResourceRevision: nextRevision,
      expectedResourceRevision,
      evidence: { dispositionSequence: sequence },
    },
  );
}

interface ResolvedRoleRequirement {
  requirement: RoleRequirement;
  digest: string;
  configRevision: number;
}

function requireRoleRequirement(db: SqliteDatabase, request: ApplyRequest, configRevision: number): ResolvedRoleRequirement {
  if (!request.roleRequirementId) throw refusal("ROLE_REQUIREMENT_UNKNOWN", "role requirement identity is required");
  const requirements = roleRequirementsFromJson(storedConfigJson(db, request.projectId, configRevision));
  const matches = requirements.filter((candidate) => candidate.roleRequirementId === request.roleRequirementId);
  if (matches.length !== 1) throw refusal("ROLE_REQUIREMENT_UNKNOWN", "role requirement is not uniquely configured");
  const requirement = matches[0]!;
  if (request.roleId && request.roleId !== requirement.roleId) throw refusal("ROLE_REQUIREMENT_UNKNOWN", "logical role does not match its requirement");
  if (requirement.repoTargetId === null) {
    if (request.repoTargetId) throw refusal("REPO_TARGET_FOREIGN", "project-scoped role cannot accept a repository target");
  } else {
    if (!request.repoTargetId) throw refusal("REPO_TARGET_REQUIRED", "target-scoped role requires its exact repository target");
    if (request.repoTargetId !== requirement.repoTargetId) throw refusal("REPO_TARGET_FOREIGN", "role requirement target does not match the exact repository target");
    requireTarget(db, request.projectId, configRevision, request.repoTargetId);
  }
  return { requirement, digest: sha256(canonicalJson(requirement)), configRevision };
}

function requireRoleTargetContext(
  db: SqliteDatabase,
  request: ApplyRequest,
  resolved: ResolvedRoleRequirement,
  context: ResolvedRoleContext,
): void {
  if (resolved.requirement.repoTargetId === null) return;
  const target = requireTarget(db, request.projectId, resolved.configRevision, resolved.requirement.repoTargetId) as {
    source_id: string;
    host_id: string;
    path: string;
  };
  const environment = context.baseContext.environment as { path?: unknown };
  if (target.source_id !== context.sourceId || target.host_id !== context.hostId || target.path !== environment.path) {
    throw refusal("ROLE_CONTEXT_FOREIGN", "holder context does not match the exact repository target source, host, and path");
  }
}

function requireRoleActorBinding(db: SqliteDatabase, request: ApplyRequest): void {
  if (!request.actorReceiptId) return;
  const actor = asRow<{ actor_kind: string; subject_id: string; role_id: string | null; role_generation: number | null }>(
    db.prepare("SELECT actor_kind, subject_id, role_id, role_generation FROM actor_receipts WHERE project_id = ? AND receipt_id = ?").get(
      request.projectId,
      request.actorReceiptId,
    ),
  );
  if (!actor || actor.actor_kind !== "role") return;
  if (!actor.role_id || actor.role_generation === null) throw refusal("ROLE_HOLDER_MISMATCH", "role actor receipt has no exact generation");
  const head = asRow<{ current_generation: number }>(
    db.prepare("SELECT current_generation FROM role_generation_heads WHERE project_id = ? AND role_id = ?").get(request.projectId, actor.role_id),
  );
  const generation = asRow<{ status: string; holder_execution_attempt_id: string }>(
    db.prepare("SELECT status, holder_execution_attempt_id FROM role_generations WHERE project_id = ? AND role_id = ? AND generation = ?").get(
      request.projectId,
      actor.role_id,
      actor.role_generation,
    ),
  );
  if (!head || head.current_generation !== actor.role_generation) throw refusal("ROLE_GENERATION_STALE", "role actor is not the current generation");
  if (!generation || generation.status !== "active") throw refusal("ROLE_NOT_ACTIVE", "role actor is not active");
  if (generation.holder_execution_attempt_id !== actor.subject_id) throw refusal("ROLE_HOLDER_MISMATCH", "role actor does not bind the current holder context");
}

function profileEquals(left: ExecutionProfile, right: ExecutionProfile): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function qualificationContextDigest(
  context: ResolvedRoleContext,
  resolved: ResolvedRoleRequirement,
  request: ApplyRequest,
): string {
  return sha256(canonicalJson({
    ...context.baseContext,
    configRevision: resolved.configRevision,
    roleId: resolved.requirement.roleId,
    roleRequirementId: resolved.requirement.roleRequirementId,
    roleRequirementDigest: resolved.digest,
    repoTargetId: resolved.requirement.repoTargetId,
    fixtureContextDigest: request.fixtureContextDigest,
  }));
}

function applyQualificationObservation(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  context: ResolvedRoleContext,
): FoundationResult {
  const configRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  requireRoleActorBinding(db, request);
  const resolved = requireRoleRequirement(db, request, configRevision);
  requireRoleTargetContext(db, request, resolved, context);
  const qualificationId = request.qualificationId;
  const requestedOutcome = request.qualificationOutcome;
  const observedAtMs = request.observedAtMs;
  const fixtureContextDigest = request.fixtureContextDigest;
  const expiresAtMs = request.expiresAtMs ?? null;
  if (!qualificationId || !requestedOutcome || observedAtMs === undefined || !fixtureContextDigest || !request.reasonCode) {
    throw refusal("INVALID_INPUT", "qualification recording requires exact observation, outcome, time, fixture, and reason fields");
  }
  if (expiresAtMs !== null && expiresAtMs <= observedAtMs) {
    throw refusal("INVALID_INPUT", "qualification expiry must be later than observation time");
  }
  if (db.prepare("SELECT 1 FROM qualification_observations WHERE project_id = ? AND qualification_id = ?").get(request.projectId, qualificationId)) {
    throw refusal("IDEMPOTENCY_KEY_CONFLICT", "qualification identity is immutable and already exists");
  }
  const contextDigest = qualificationContextDigest(context, resolved, request);
  const requiredMatch = profileEquals(context.profile, resolved.requirement.executedProfile);
  const declaredMatch = request.declaredProfile === undefined || profileEquals(context.profile, request.declaredProfile);
  const mismatch = !requiredMatch || !declaredMatch;
  const observationOutcome = mismatch ? "unqualified" : requestedOutcome;
  const effectiveStatus = observationOutcome === "qualified" ? "eligible" : observationOutcome === "unqualified" ? "ineligible" : "unknown";
  const reasonCode = mismatch ? "execution_profile_mismatch" : request.reasonCode;
  const evidenceDigest = sha256(canonicalJson({
    executedProfileDigest: context.profileDigest,
    qualificationContextDigest: contextDigest,
    fixtureContextDigest,
    outcome: observationOutcome,
    reasonCode,
  }));
  const observation = {
    projectId: request.projectId,
    qualificationId,
    roleRequirementId: resolved.requirement.roleRequirementId,
    configRevision,
    repoTargetId: resolved.requirement.repoTargetId,
    roleRequirementDigest: resolved.digest,
    executedProfileDigest: context.profileDigest,
    qualificationContextDigest: contextDigest,
    fixtureContextDigest,
    outcome: observationOutcome,
    observedAtMs,
    expiresAtMs,
    evidenceDigest,
    reasonCode,
  };
  const observationDigest = sha256(canonicalJson(observation));
  db.prepare(
    `INSERT INTO qualification_observations (
      project_id, qualification_id, role_requirement_id, config_revision, repo_target_id,
      role_requirement_digest, executed_profile_digest, provider_id, model, reasoning_level,
      permission_mode, service_tier, visibility, thread_id, environment_id, source_id, host_id,
      provider_thread_id, request_event_id, request_event_seq, completion_event_id, completion_event_seq,
      bb_version, plugin_sdk_version, qualification_context_digest, fixture_context_digest, outcome,
      observed_at_ms, expires_at_ms, evidence_digest, observation_digest, reason_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    request.projectId,
    qualificationId,
    resolved.requirement.roleRequirementId,
    configRevision,
    resolved.requirement.repoTargetId,
    resolved.digest,
    context.profileDigest,
    context.profile.providerId,
    context.profile.model,
    context.profile.reasoningLevel,
    context.profile.permissionMode,
    context.profile.serviceTier,
    context.profile.visibility,
    context.threadId,
    context.environmentId,
    context.sourceId,
    context.hostId,
    context.providerThreadId,
    context.requestEventId,
    context.requestEventSeq,
    context.completionEventId,
    context.completionEventSeq,
    context.bbVersion,
    PLUGIN_SDK_VERSION,
    contextDigest,
    fixtureContextDigest,
    observationOutcome,
    observedAtMs,
    expiresAtMs,
    evidenceDigest,
    observationDigest,
    reasonCode,
  );
  const derivedAtMs = now();
  const derivationDigest = sha256(canonicalJson({
    qualificationId,
    profileDigest: context.profileDigest,
    effectiveStatus,
    contextDigest,
    configRevision,
    roleRequirementDigest: resolved.digest,
    derivedAtMs,
    expiresAtMs,
    reasonCode,
  }));
  db.prepare(
    `INSERT INTO eligibility_projections (
      project_id, role_requirement_id, profile_digest, current_qualification_id,
      effective_status, qualification_context_digest, config_revision, role_requirement_digest,
      derived_at_ms, expires_at_ms, derivation_digest, reason_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, role_requirement_id, profile_digest) DO UPDATE SET
      current_qualification_id = excluded.current_qualification_id,
      effective_status = excluded.effective_status,
      qualification_context_digest = excluded.qualification_context_digest,
      config_revision = excluded.config_revision,
      role_requirement_digest = excluded.role_requirement_digest,
      derived_at_ms = excluded.derived_at_ms,
      expires_at_ms = excluded.expires_at_ms,
      derivation_digest = excluded.derivation_digest,
      reason_code = excluded.reason_code`,
  ).run(
    request.projectId,
    resolved.requirement.roleRequirementId,
    context.profileDigest,
    qualificationId,
    effectiveStatus,
    contextDigest,
    configRevision,
    resolved.digest,
    derivedAtMs,
    expiresAtMs,
    derivationDigest,
    reasonCode,
  );
  return commitMutation(
    db,
    request,
    digest,
    actorReceiptId,
    {
      aggregateType: "qualification_observation",
      aggregateId: qualificationId,
      aggregateRevision: 1,
      eventType: "qualification_observation_recorded",
      event: { qualificationId, roleRequirementId: resolved.requirement.roleRequirementId, profileDigest: context.profileDigest, outcome: observationOutcome },
    },
    { expected: 1, attempted: 1, verified: 1 },
    {
      currentConfigRevision: configRevision,
      currentGovernanceEpoch: governor.governance_epoch,
      evidence: { qualificationId, roleRequirementId: resolved.requirement.roleRequirementId, profileDigest: context.profileDigest, effectiveStatus, observationDigest, derivationDigest, reasonCode },
    },
    mismatch ? "EXECUTION_PROFILE_MISMATCH" : "OK",
  );
}

interface QualificationObservationRow {
  qualification_id: string;
  role_requirement_id: string;
  config_revision: number;
  repo_target_id: string | null;
  role_requirement_digest: string;
  executed_profile_digest: string;
  qualification_context_digest: string;
  fixture_context_digest: string;
  outcome: "qualified" | "unqualified" | "unknown";
  expires_at_ms: number | null;
  bb_version: string;
  plugin_sdk_version: string;
}

interface EligibilityProjectionRow {
  current_qualification_id: string;
  effective_status: "eligible" | "ineligible" | "unknown";
  qualification_context_digest: string;
  config_revision: number;
  role_requirement_digest: string;
  expires_at_ms: number | null;
  derivation_digest: string;
}

function applyRoleGenerationSuccession(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  context: ResolvedRoleContext,
): FoundationResult {
  const configRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  requireRoleActorBinding(db, request);
  if (!request.roleId || !request.qualificationId || !request.profileDigest || !request.fixtureContextDigest) {
    throw refusal("INVALID_INPUT", "role succession requires role, qualification, profile, and fixture context identities");
  }
  const resolved = requireRoleRequirement(db, request, configRevision);
  requireRoleTargetContext(db, request, resolved, context);
  if (!profileEquals(context.profile, resolved.requirement.executedProfile) || request.profileDigest !== context.profileDigest) {
    throw refusal("EXECUTION_PROFILE_MISMATCH", "holder executed profile does not match the role requirement");
  }
  const expectedContextDigest = qualificationContextDigest(context, resolved, request);
  const observation = asRow<QualificationObservationRow>(
    db.prepare("SELECT * FROM qualification_observations WHERE project_id = ? AND qualification_id = ?").get(request.projectId, request.qualificationId),
  );
  if (!observation) throw refusal("ROLE_UNQUALIFIED", "qualification observation is not known");
  const projection = asRow<EligibilityProjectionRow>(
    db.prepare("SELECT * FROM eligibility_projections WHERE project_id = ? AND role_requirement_id = ? AND profile_digest = ?").get(
      request.projectId,
      resolved.requirement.roleRequirementId,
      request.profileDigest,
    ),
  );
  if (!projection) throw refusal("CAPABILITY_UNKNOWN", "current eligibility projection is unavailable");
  if (
    observation.config_revision !== configRevision ||
    projection.config_revision !== configRevision ||
    observation.role_requirement_digest !== resolved.digest ||
    projection.role_requirement_digest !== resolved.digest ||
    observation.bb_version !== context.bbVersion ||
    observation.plugin_sdk_version !== PLUGIN_SDK_VERSION
  ) {
    throw refusal("ELIGIBILITY_STALE", "qualification or runtime evidence is stale");
  }
  if (
    observation.role_requirement_id !== resolved.requirement.roleRequirementId ||
    observation.repo_target_id !== resolved.requirement.repoTargetId ||
    observation.executed_profile_digest !== request.profileDigest ||
    observation.qualification_context_digest !== expectedContextDigest ||
    observation.fixture_context_digest !== request.fixtureContextDigest ||
    projection.current_qualification_id !== observation.qualification_id ||
    projection.qualification_context_digest !== expectedContextDigest
  ) {
    throw refusal("QUALIFICATION_CONTEXT_FOREIGN", "qualification does not match the exact holder context");
  }
  const effectiveAtMs = now();
  if ((observation.expires_at_ms !== null && observation.expires_at_ms <= effectiveAtMs) || (projection.expires_at_ms !== null && projection.expires_at_ms <= effectiveAtMs)) {
    throw refusal("ELIGIBILITY_EXPIRED", "qualification eligibility has expired");
  }
  if (observation.outcome === "unknown" || projection.effective_status === "unknown") throw refusal("CAPABILITY_UNKNOWN", "qualification outcome is unknown");
  if (observation.outcome !== "qualified" || projection.effective_status !== "eligible") throw refusal("ROLE_UNQUALIFIED", "qualification is not eligible");
  const head = asRow<{ current_generation: number }>(
    db.prepare("SELECT current_generation FROM role_generation_heads WHERE project_id = ? AND role_id = ?").get(request.projectId, request.roleId),
  );
  const first = request.expectedGeneration === null && request.predecessorGeneration === null;
  let nextGeneration: number;
  if (first) {
    if (head) throw refusal("ROLE_GENERATION_STALE", "first generation requires no current role head", { currentResourceRevision: head.current_generation });
    nextGeneration = 1;
  } else {
    if (request.expectedGeneration === null || request.predecessorGeneration === null) {
      throw refusal("ROLE_PREDECESSOR_MISMATCH", "successor requires matching expected and predecessor generations");
    }
    if (!head) throw refusal("ROLE_HEAD_UNAVAILABLE", "successor requires a current role head");
    if (head.current_generation !== request.expectedGeneration) {
      throw refusal("ROLE_GENERATION_STALE", "role head generation is stale", {
        currentResourceRevision: head.current_generation,
        expectedResourceRevision: request.expectedGeneration,
      });
    }
    if (request.predecessorGeneration !== request.expectedGeneration) throw refusal("ROLE_PREDECESSOR_MISMATCH", "predecessor does not match the expected current generation");
    const predecessor = asRow<{ status: string }>(
      db.prepare("SELECT status FROM role_generations WHERE project_id = ? AND role_id = ? AND generation = ?").get(
        request.projectId,
        request.roleId,
        request.predecessorGeneration,
      ),
    );
    if (!predecessor || !["active", "draining"].includes(predecessor.status)) throw refusal("ROLE_NOT_ACTIVE", "predecessor is not current and active or draining");
    nextGeneration = request.expectedGeneration + 1;
  }
  const createdAtMs = now();
  db.prepare(
    `INSERT INTO role_generations (
      project_id, role_id, generation, role_requirement_id, config_revision, repo_target_id,
      status, predecessor_generation, holder_execution_attempt_id, holder_context_digest,
      holder_executed_profile_digest, qualification_id, eligibility_derivation_digest,
      created_at_ms, activated_at_ms, retired_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    request.projectId,
    request.roleId,
    nextGeneration,
    resolved.requirement.roleRequirementId,
    configRevision,
    resolved.requirement.repoTargetId,
    request.predecessorGeneration,
    context.holderExecutionAttemptId,
    expectedContextDigest,
    context.profileDigest,
    request.qualificationId,
    projection.derivation_digest,
    createdAtMs,
    createdAtMs,
  );
  if (first) {
    db.prepare("INSERT INTO role_generation_heads (project_id, role_id, current_generation, updated_at_ms) VALUES (?, ?, 1, ?)").run(
      request.projectId,
      request.roleId,
      createdAtMs,
    );
  } else {
    const retired = db.prepare(
      `UPDATE role_generations SET status = 'retired', retired_at_ms = ?
       WHERE project_id = ? AND role_id = ? AND generation = ? AND status IN ('active', 'draining')`,
    ).run(createdAtMs, request.projectId, request.roleId, request.predecessorGeneration);
    if (retired.changes !== 1) throw refusal("ROLE_NOT_ACTIVE", "predecessor retirement compare-and-swap failed");
    const advanced = db.prepare(
      `UPDATE role_generation_heads SET current_generation = ?, updated_at_ms = ?
       WHERE project_id = ? AND role_id = ? AND current_generation = ?`,
    ).run(nextGeneration, createdAtMs, request.projectId, request.roleId, request.expectedGeneration);
    if (advanced.changes !== 1) throw refusal("ROLE_GENERATION_STALE", "role head compare-and-swap failed");
  }
  return commitMutation(
    db,
    request,
    digest,
    actorReceiptId,
    {
      aggregateType: "role_generation",
      aggregateId: request.roleId,
      aggregateRevision: nextGeneration,
      eventType: "role_generation_succeeded",
      event: { roleId: request.roleId, generation: nextGeneration, predecessorGeneration: request.predecessorGeneration, qualificationId: request.qualificationId },
    },
    { expected: 1, attempted: 1, verified: 1 },
    {
      currentConfigRevision: configRevision,
      currentGovernanceEpoch: governor.governance_epoch,
      currentResourceRevision: nextGeneration,
      expectedResourceRevision: request.expectedGeneration ?? undefined,
      evidence: {
        roleId: request.roleId,
        generation: nextGeneration,
        predecessorGeneration: request.predecessorGeneration,
        holderExecutionAttemptId: context.holderExecutionAttemptId,
        holderContextDigest: expectedContextDigest,
        executedProfileDigest: context.profileDigest,
        qualificationId: request.qualificationId,
        eligibilityDerivationDigest: projection.derivation_digest,
      },
    },
  );
}

function applyRoleMutation(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  reader: RoleFactReader | null,
): FoundationResult {
  try {
    const replay = checkIdempotency(db, request, digest);
    if (replay) return replay;
    const context = resolveRoleContext(reader, request);
    return transaction(db, () => {
      const replayInTransaction = checkIdempotency(db, request, digest);
      if (replayInTransaction) return replayInTransaction;
      return request.operationClass === "qualification_observation_record"
        ? applyQualificationObservation(db, request, digest, context)
        : applyRoleGenerationSuccession(db, request, digest, context);
    });
  } catch (error) {
    if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
    if (isConstraintError(error)) return unavailableResult(request.projectId, "canonical role mutation could not be committed unambiguously");
    return result("INTERNAL_ERROR", request.projectId, 1, 0, 0, { message: "internal mutation error" });
  }
}

interface WorkItemRow {
  project_id: string;
  work_item_id: string;
  config_revision: number;
  repo_target_id: string;
  title: string;
  body: string;
  lifecycle_state: WorkItemState;
  resource_revision: number;
  created_at_ms: number;
  updated_at_ms: number;
}

interface ExternalWorkRefRow {
  project_id: string;
  work_item_id: string;
  provider: "github";
  owner: string;
  repo: string;
  issue_number: number | null;
  projection_state: "pending" | "current" | "drifted" | "delivery_ambiguous";
  attempted_resource_revision: number;
  projected_resource_revision: number | null;
  desired_digest: string;
  observed_external_revision: string | null;
  observed_external_digest: string | null;
  last_idempotency_key: string;
  last_request_digest: string;
  created_at_ms: number;
  updated_at_ms: number;
}

const githubSnapshotSchema = z
  .object({
    owner: id,
    repo: id,
    issueNumber: z.number().int().positive(),
    title: z.string().max(4096),
    body: z.string().max(64 * 1024),
    state: z.enum(["open", "closed"]),
    labels: z.array(id).max(256),
    externalRevision: id,
  })
  .strict();

function storedConfigJson(db: SqliteDatabase, projectId: string, configRevision: number): string {
  const row = asRow<{ canonical_config_json: string }>(
    db.prepare("SELECT canonical_config_json FROM project_config_revisions WHERE project_id = ? AND config_revision = ?").get(projectId, configRevision),
  );
  if (!row) throw refusal("PROJECT_CONFIG_REQUIRED", "project config revision is unavailable");
  return row.canonical_config_json;
}

function requireGithubMapping(db: SqliteDatabase, projectId: string, configRevision: number, repoTargetId: string) {
  const github = githubConfigFromJson(storedConfigJson(db, projectId, configRevision));
  if (!github) throw refusal("EXTERNAL_TARGET_REQUIRED", "the config has no GitHub Issues mapping");
  const mappings = github.repositoryMappings.filter((mapping) => mapping.repoTargetId === repoTargetId);
  if (mappings.length !== 1) throw refusal("EXTERNAL_TARGET_REQUIRED", "the exact repository target has no unique GitHub Issues mapping");
  return { github, mapping: mappings[0]! };
}

function requireWorkItem(
  db: SqliteDatabase,
  request: ApplyRequest,
  configRevision: number,
  expectedRevision = request.expectedResourceRevision,
): WorkItemRow {
  const workItemId = request.workItemId;
  if (!workItemId) throw refusal("WORK_ITEM_UNKNOWN", "work item identity is required");
  const row = asRow<WorkItemRow>(
    db.prepare("SELECT * FROM work_items WHERE project_id = ? AND work_item_id = ?").get(request.projectId, workItemId),
  );
  if (!row) {
    const foreign = db.prepare("SELECT 1 FROM work_items WHERE work_item_id = ? LIMIT 1").get(workItemId);
    throw refusal(foreign ? "WORK_ITEM_FOREIGN" : "WORK_ITEM_UNKNOWN", foreign ? "work item belongs to another project" : "work item is not known");
  }
  if (row.config_revision !== configRevision) {
    throw refusal("PROJECT_CONFIG_STALE", "work item is bound to a stale config revision", {
      currentConfigRevision: configRevision,
      expectedConfigRevision: row.config_revision,
    });
  }
  if (!request.repoTargetId) throw refusal("REPO_TARGET_REQUIRED", "work item mutation requires its exact repository target");
  if (request.repoTargetId !== row.repo_target_id) throw refusal("REPO_TARGET_FOREIGN", "work item target does not match the exact repository target");
  requireTarget(db, request.projectId, configRevision, request.repoTargetId);
  if (expectedRevision !== row.resource_revision) {
    throw refusal("WORK_ITEM_REVISION_STALE", "work item resource revision is stale", {
      currentResourceRevision: row.resource_revision,
      expectedResourceRevision: expectedRevision ?? undefined,
    });
  }
  return row;
}

function applyWorkItemCreate(db: SqliteDatabase, request: ApplyRequest, digest: string): FoundationResult {
  const configRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  if (!request.workItem) throw refusal("INVALID_INPUT", "work item create requires workItem");
  if (!request.repoTargetId) throw refusal("REPO_TARGET_REQUIRED", "work item create requires an exact repository target");
  requireTarget(db, request.projectId, configRevision, request.repoTargetId);
  if (request.workItemId && request.workItemId !== request.workItem.workItemId) {
    throw refusal("WORK_ITEM_STATE_INVALID", "work item identities conflict");
  }
  if (request.expectedResourceRevision !== null) throw refusal("WORK_ITEM_REVISION_STALE", "work item create requires no existing resource revision");
  if (db.prepare("SELECT 1 FROM work_items WHERE project_id = ? AND work_item_id = ?").get(request.projectId, request.workItem.workItemId)) {
    throw refusal("WORK_ITEM_STATE_INVALID", "work item already exists");
  }
  const createdAtMs = now();
  db.prepare(
    `INSERT INTO work_items
      (project_id, work_item_id, config_revision, repo_target_id, title, body,
       lifecycle_state, resource_revision, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, 'proposed', 1, ?, ?)`,
  ).run(
    request.projectId,
    request.workItem.workItemId,
    configRevision,
    request.repoTargetId,
    request.workItem.title,
    request.workItem.body,
    createdAtMs,
    createdAtMs,
  );
  return commitMutation(
    db,
    request,
    digest,
    actorReceiptId,
    {
      aggregateType: "work_item",
      aggregateId: request.workItem.workItemId,
      aggregateRevision: 1,
      eventType: "work_item_created",
      event: { workItemId: request.workItem.workItemId, repoTargetId: request.repoTargetId, lifecycleState: "proposed" },
    },
    { expected: 1, attempted: 1, verified: 1 },
    {
      currentConfigRevision: configRevision,
      currentGovernanceEpoch: governor.governance_epoch,
      currentResourceRevision: 1,
      evidence: { workItemId: request.workItem.workItemId, repoTargetId: request.repoTargetId, lifecycleState: "proposed" },
    },
  );
}

const WORK_ITEM_TRANSITIONS: Readonly<Record<WorkItemState, readonly WorkItemState[]>> = {
  proposed: ["ready", "cancelled"],
  ready: ["in_progress", "cancelled"],
  in_progress: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

function applyWorkItemTransition(db: SqliteDatabase, request: ApplyRequest, digest: string): FoundationResult {
  const configRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  const workItem = requireWorkItem(db, request, configRevision);
  const nextState = request.lifecycleState;
  if (!nextState || !WORK_ITEM_TRANSITIONS[workItem.lifecycle_state].includes(nextState)) {
    throw refusal("WORK_ITEM_STATE_INVALID", "work item lifecycle transition is not allowed");
  }
  const nextRevision = workItem.resource_revision + 1;
  const updated = db.prepare(
    `UPDATE work_items SET lifecycle_state = ?, resource_revision = ?, updated_at_ms = ?
     WHERE project_id = ? AND work_item_id = ? AND resource_revision = ? AND lifecycle_state = ?`,
  ).run(nextState, nextRevision, now(), request.projectId, workItem.work_item_id, workItem.resource_revision, workItem.lifecycle_state);
  if (updated.changes !== 1) {
    throw refusal("WORK_ITEM_REVISION_STALE", "work item compare-and-swap failed", {
      currentResourceRevision: workItem.resource_revision,
      expectedResourceRevision: request.expectedResourceRevision ?? undefined,
    });
  }
  return commitMutation(
    db,
    request,
    digest,
    actorReceiptId,
    {
      aggregateType: "work_item",
      aggregateId: workItem.work_item_id,
      aggregateRevision: nextRevision,
      eventType: "work_item_transitioned",
      event: { workItemId: workItem.work_item_id, from: workItem.lifecycle_state, to: nextState },
    },
    { expected: 1, attempted: 1, verified: 1 },
    {
      currentConfigRevision: configRevision,
      currentGovernanceEpoch: governor.governance_epoch,
      currentResourceRevision: nextRevision,
      expectedResourceRevision: request.expectedResourceRevision ?? undefined,
      evidence: { workItemId: workItem.work_item_id, lifecycleState: nextState },
    },
  );
}

interface DesiredProjection {
  title: string;
  body: string;
  state: "open" | "closed";
  managedLabels: string[];
  managedNames: Set<string>;
  digest: string;
}

function desiredProjection(workItem: WorkItemRow, github: GithubIssuesConfig): DesiredProjection {
  const convention = github.issue;
  const names = new Set(convention?.managedLabels?.names ?? []);
  const managedLabels = [...new Set(convention?.managedLabels?.byLifecycle?.[workItem.lifecycle_state] ?? [])].sort();
  const title = `${convention?.titlePrefix ?? ""}${workItem.title}`;
  const body = `${convention?.bodyPrefix ?? ""}${workItem.body}`;
  const state = (["succeeded", "failed", "cancelled"] as WorkItemState[]).includes(workItem.lifecycle_state) ? "closed" : "open";
  return {
    title,
    body,
    state,
    managedLabels,
    managedNames: names,
    digest: sha256(canonicalJson({ title, body, state, managedLabels })),
  };
}

function parseSnapshot(value: unknown): GitHubIssueSnapshot {
  const parsed = githubSnapshotSchema.safeParse(value);
  if (!parsed.success || new Set(parsed.data.labels).size !== parsed.data.labels.length) {
    throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub issue response is invalid", { expected: 1, attempted: 1, verified: 0 });
  }
  return parsed.data;
}

function observedDigest(snapshot: GitHubIssueSnapshot, desired: DesiredProjection): string {
  return sha256(canonicalJson({
    title: snapshot.title,
    body: snapshot.body,
    state: snapshot.state,
    managedLabels: snapshot.labels.filter((label) => desired.managedNames.has(label)).sort(),
  }));
}

function externalRef(db: SqliteDatabase, projectId: string, workItemId: string): ExternalWorkRefRow | undefined {
  return asRow<ExternalWorkRefRow>(
    db.prepare("SELECT * FROM external_work_refs WHERE project_id = ? AND work_item_id = ? AND provider = 'github'").get(projectId, workItemId),
  );
}

const EXTERNAL_REF_CAS_WHERE = `project_id = ? AND work_item_id = ? AND provider = 'github'
  AND owner = ? AND repo = ? AND issue_number IS ? AND projection_state = ?
  AND attempted_resource_revision = ? AND projected_resource_revision IS ?
  AND desired_digest = ? AND observed_external_revision IS ? AND observed_external_digest IS ?
  AND last_idempotency_key = ? AND last_request_digest = ?`;

function externalRefCasArgs(ref: ExternalWorkRefRow): unknown[] {
  return [
    ref.project_id,
    ref.work_item_id,
    ref.owner,
    ref.repo,
    ref.issue_number,
    ref.projection_state,
    ref.attempted_resource_revision,
    ref.projected_resource_revision,
    ref.desired_digest,
    ref.observed_external_revision,
    ref.observed_external_digest,
    ref.last_idempotency_key,
    ref.last_request_digest,
  ];
}

interface ProjectionContext {
  actorReceiptId: string;
  configRevision: number;
  governanceEpoch: number;
  workItem: WorkItemRow;
  github: GithubIssuesConfig;
  mapping: z.infer<typeof githubMappingSchema>;
  desired: DesiredProjection;
  ref: ExternalWorkRefRow;
}

function revalidateProjectionContext(db: SqliteDatabase, request: ApplyRequest, context: ProjectionContext) {
  const configRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  const workItem = requireWorkItem(db, request, configRevision);
  const { mapping } = requireGithubMapping(db, request.projectId, configRevision, workItem.repo_target_id);
  if (
    configRevision !== context.configRevision ||
    governor.governance_epoch !== context.governanceEpoch ||
    actorReceiptId !== context.actorReceiptId ||
    workItem.work_item_id !== context.workItem.work_item_id ||
    mapping.repoTargetId !== context.mapping.repoTargetId ||
    mapping.owner !== context.mapping.owner ||
    mapping.repo !== context.mapping.repo ||
    mapping.connectorHost !== context.mapping.connectorHost
  ) {
    throw refusal("EXTERNAL_TARGET_MISMATCH", "projection authority context changed before local mutation");
  }
  return { configRevision, governor, actorReceiptId, workItem, mapping };
}

function prepareProjection(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  adapter: GitHubIssueAdapter,
): FoundationResult | ProjectionContext {
  return transaction(db, () => {
    const replay = checkIdempotency(db, request, digest);
    if (replay) return replay;
    if (request.projectionKind !== "github_issue") throw refusal("INVALID_INPUT", "GitHub projection requires projectionKind github_issue");
    const configRevision = requireConfig(db, request);
    const governor = requireGovernor(db, request);
    const actorReceiptId = requireActor(db, request);
    const workItem = requireWorkItem(db, request, configRevision);
    const { github, mapping } = requireGithubMapping(db, request.projectId, configRevision, workItem.repo_target_id);
    if (adapter.connectorHost !== mapping.connectorHost) throw refusal("EXTERNAL_TARGET_MISMATCH", "GitHub connector host does not match the exact mapping");
    const desired = desiredProjection(workItem, github);
    let ref = externalRef(db, request.projectId, workItem.work_item_id);
    if (ref) {
      if (ref.project_id !== request.projectId || ref.work_item_id !== workItem.work_item_id || ref.provider !== "github") {
        throw refusal("EXTERNAL_REF_FOREIGN", "external ref belongs to another canonical resource");
      }
      if (ref.owner !== mapping.owner || ref.repo !== mapping.repo) {
        throw refusal("EXTERNAL_REF_CONFLICT", "external ref conflicts with the exact repository mapping");
      }
      if (ref.projection_state === "pending" || ref.projection_state === "delivery_ambiguous") {
        throw refusal("EXTERNAL_DELIVERY_AMBIGUOUS", "external delivery is durably fenced", { expected: 1, attempted: 0, verified: 0 });
      }
      if (ref.projection_state === "drifted") {
        throw refusal("EXTERNAL_DIVERGED", "external issue is marked drifted", { expected: 1, attempted: 0, verified: 0 });
      }
      if (ref.issue_number === null) throw refusal("EXTERNAL_REF_CONFLICT", "current external ref has no issue number");
    } else {
      const createdAtMs = now();
      db.prepare(
        `INSERT INTO external_work_refs
          (project_id, work_item_id, provider, owner, repo, issue_number, projection_state,
           attempted_resource_revision, projected_resource_revision, desired_digest,
           observed_external_revision, observed_external_digest, last_idempotency_key,
           last_request_digest, created_at_ms, updated_at_ms)
         VALUES (?, ?, 'github', ?, ?, NULL, 'pending', ?, NULL, ?, NULL, NULL, ?, ?, ?, ?)`,
      ).run(
        request.projectId,
        workItem.work_item_id,
        mapping.owner,
        mapping.repo,
        workItem.resource_revision,
        desired.digest,
        request.idempotencyKey,
        digest,
        createdAtMs,
        createdAtMs,
      );
      appendStateEvent(db, request, actorReceiptId, {
        aggregateType: "external_work_ref",
        aggregateId: workItem.work_item_id,
        aggregateRevision: workItem.resource_revision,
        eventType: "github_issue_projection_reserved",
        event: {
          workItemId: workItem.work_item_id,
          provider: "github",
          from: null,
          to: "pending",
          desiredDigest: desired.digest,
        },
      });
      ref = externalRef(db, request.projectId, workItem.work_item_id)!;
    }
    return {
      actorReceiptId,
      configRevision,
      governanceEpoch: governor.governance_epoch,
      workItem,
      github,
      mapping,
      desired,
      ref,
    };
  });
}

function reserveExistingProjection(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  context: ProjectionContext,
): ProjectionContext {
  return transaction(db, () => {
    const replay = checkIdempotency(db, request, digest);
    if (replay) throw refusal("IDEMPOTENCY_KEY_CONFLICT", "projection was concurrently finalized");
    revalidateProjectionContext(db, request, context);
    const updated = db.prepare(
      `UPDATE external_work_refs SET projection_state = 'pending', attempted_resource_revision = ?,
       desired_digest = ?, last_idempotency_key = ?, last_request_digest = ?, updated_at_ms = ?
       WHERE ${EXTERNAL_REF_CAS_WHERE}`,
    ).run(
      context.workItem.resource_revision,
      context.desired.digest,
      request.idempotencyKey,
      digest,
      now(),
      ...externalRefCasArgs(context.ref),
    );
    if (updated.changes !== 1) throw refusal("EXTERNAL_REF_CONFLICT", "external ref reservation lost its compare-and-swap race");
    appendStateEvent(db, request, context.actorReceiptId, {
      aggregateType: "external_work_ref",
      aggregateId: context.workItem.work_item_id,
      aggregateRevision: context.workItem.resource_revision,
      eventType: "github_issue_projection_reserved",
      event: {
        workItemId: context.workItem.work_item_id,
        provider: "github",
        from: context.ref.projection_state,
        to: "pending",
        desiredDigest: context.desired.digest,
      },
    });
    return { ...context, ref: externalRef(db, request.projectId, context.workItem.work_item_id)! };
  });
}

function recordProjectionState(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  context: ProjectionContext,
  state: "drifted" | "delivery_ambiguous",
  outcome: "EXTERNAL_DIVERGED" | "EXTERNAL_DELIVERY_AMBIGUOUS",
  counts: { expected: number; attempted: number; verified: number },
  message: string,
): FoundationResult {
  return transaction(db, () => {
    const replay = checkIdempotency(db, request, digest);
    if (replay) return replay;
    const authority = revalidateProjectionContext(db, request, context);
    const updated = db.prepare(
      `UPDATE external_work_refs SET projection_state = ?, attempted_resource_revision = ?, desired_digest = ?,
       last_idempotency_key = ?, last_request_digest = ?, updated_at_ms = ?
       WHERE ${EXTERNAL_REF_CAS_WHERE}`,
    ).run(
      state,
      context.workItem.resource_revision,
      context.desired.digest,
      request.idempotencyKey,
      digest,
      now(),
      ...externalRefCasArgs(context.ref),
    );
    if (updated.changes !== 1) throw refusal("EXTERNAL_REF_CONFLICT", "external ref state changed before projection outcome was recorded");
    return commitMutation(
      db,
      request,
      digest,
      authority.actorReceiptId,
      {
        aggregateType: "external_work_ref",
        aggregateId: context.workItem.work_item_id,
        aggregateRevision: context.workItem.resource_revision,
        eventType: state === "drifted" ? "github_issue_drifted" : "github_issue_delivery_ambiguous",
        event: { workItemId: context.workItem.work_item_id, provider: "github", projectionState: state },
      },
      counts,
      {
        message,
        currentConfigRevision: authority.configRevision,
        currentGovernanceEpoch: authority.governor.governance_epoch,
        currentResourceRevision: authority.workItem.resource_revision,
        expectedResourceRevision: request.expectedResourceRevision ?? undefined,
        evidence: { projectionState: state, desiredDigest: context.desired.digest },
      },
      outcome,
    );
  });
}

function finalizeProjection(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  context: ProjectionContext,
  adapter: GitHubIssueAdapter,
  snapshot: GitHubIssueSnapshot,
  mutationKind: "create" | "update" | "verify",
): FoundationResult {
  return transaction(db, () => {
    const replay = checkIdempotency(db, request, digest);
    if (replay) return replay;
    const authority = revalidateProjectionContext(db, request, context);
    if (authority.mapping.connectorHost !== adapter.connectorHost) {
      throw refusal("EXTERNAL_TARGET_MISMATCH", "GitHub mapping changed before projection finalization");
    }
    if (
      context.ref.owner !== snapshot.owner ||
      context.ref.repo !== snapshot.repo ||
      (context.ref.issue_number !== null && context.ref.issue_number !== snapshot.issueNumber)
    ) {
      throw refusal("EXTERNAL_REF_CONFLICT", "external identity changed before projection finalization");
    }
    if (
      (mutationKind === "verify" && context.ref.projection_state !== "current") ||
      (mutationKind !== "verify" &&
        (context.ref.projection_state !== "pending" ||
          context.ref.last_idempotency_key !== request.idempotencyKey ||
          context.ref.last_request_digest !== digest))
    ) {
      throw refusal("EXTERNAL_REF_CONFLICT", "external reservation changed before projection finalization");
    }
    const observed = observedDigest(snapshot, context.desired);
    if (observed !== context.desired.digest) throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub read-back does not match the desired projection");
    const updated = db.prepare(
      `UPDATE external_work_refs SET issue_number = ?, projection_state = 'current', attempted_resource_revision = ?,
       projected_resource_revision = ?, desired_digest = ?, observed_external_revision = ?,
       observed_external_digest = ?, last_idempotency_key = ?, last_request_digest = ?, updated_at_ms = ?
       WHERE ${EXTERNAL_REF_CAS_WHERE}`,
    ).run(
      snapshot.issueNumber,
      authority.workItem.resource_revision,
      authority.workItem.resource_revision,
      context.desired.digest,
      snapshot.externalRevision,
      observed,
      request.idempotencyKey,
      digest,
      now(),
      ...externalRefCasArgs(context.ref),
    );
    if (updated.changes !== 1) throw refusal("EXTERNAL_REF_CONFLICT", "external ref finalization lost its compare-and-swap race");
    return commitMutation(
      db,
      request,
      digest,
      authority.actorReceiptId,
      {
        aggregateType: "external_work_ref",
        aggregateId: authority.workItem.work_item_id,
        aggregateRevision: authority.workItem.resource_revision,
        eventType: "github_issue_projected",
        event: { workItemId: authority.workItem.work_item_id, owner: snapshot.owner, repo: snapshot.repo, issueNumber: snapshot.issueNumber, mutationKind },
      },
      { expected: 1, attempted: 1, verified: 1 },
      {
        currentConfigRevision: authority.configRevision,
        currentGovernanceEpoch: authority.governor.governance_epoch,
        currentResourceRevision: authority.workItem.resource_revision,
        expectedResourceRevision: request.expectedResourceRevision ?? undefined,
        evidence: {
          provider: "github",
          owner: snapshot.owner,
          repo: snapshot.repo,
          issueNumber: snapshot.issueNumber,
          desiredDigest: context.desired.digest,
          observedDigest: observed,
          observedExternalRevision: snapshot.externalRevision,
          mutationKind,
        },
      },
    );
  });
}

function applyGithubIssueProjection(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  adapter: GitHubIssueAdapter | null,
): FoundationResult {
  try {
    const replay = checkIdempotency(db, request, digest);
    if (replay) return replay;
  } catch (error) {
    if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
    return result("INTERNAL_ERROR", request.projectId, 1, 0, 0, { message: "internal mutation error" });
  }
  if (!adapter) return result("EXTERNAL_CAPABILITY_REQUIRED", request.projectId, 1, 0, 0, { message: "a GitHub Issues adapter capability is required" });
  if (!adapter.available) return result("EXTERNAL_UNAVAILABLE", request.projectId, 1, 0, 0, { message: "the GitHub Issues adapter is unavailable" });
  let context: ProjectionContext;
  try {
    const prepared = prepareProjection(db, request, digest, adapter);
    if ("outcome" in prepared) return prepared;
    context = prepared;
  } catch (error) {
    if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
    return result("INTERNAL_ERROR", request.projectId, 1, 0, 0, { message: "internal mutation error" });
  }

  let mutation: GitHubIssueMutation;
  if (context.ref.issue_number === null) {
    mutation = {
      kind: "create",
      owner: context.mapping.owner,
      repo: context.mapping.repo,
      title: context.desired.title,
      body: context.desired.body,
      state: context.desired.state,
      addLabels: context.desired.managedLabels,
      removeLabels: [],
    };
  } else {
    let current: GitHubIssueSnapshot;
    try {
      const value = adapter.read(context.mapping.owner, context.mapping.repo, context.ref.issue_number);
      if (value === null) return result("EXTERNAL_NOT_FOUND", request.projectId, 1, 1, 0, { message: "the bound GitHub issue was not found" });
      current = parseSnapshot(value);
    } catch (error) {
      if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
      return result("EXTERNAL_UNAVAILABLE", request.projectId, 1, 1, 0, { message: "the bound GitHub issue could not be read" });
    }
    if (current.owner !== context.mapping.owner || current.repo !== context.mapping.repo || current.issueNumber !== context.ref.issue_number) {
      return result("EXTERNAL_TARGET_MISMATCH", request.projectId, 1, 1, 0, { message: "the GitHub issue response has the wrong exact identity" });
    }
    if (!context.ref.observed_external_digest || observedDigest(current, context.desired) !== context.ref.observed_external_digest) {
      try {
        return recordProjectionState(db, request, digest, context, "drifted", "EXTERNAL_DIVERGED", { expected: 1, attempted: 1, verified: 0 }, "the GitHub issue diverged from its last verified projection");
      } catch {
        return result("EXTERNAL_DIVERGED", request.projectId, 1, 1, 0, { message: "the GitHub issue diverged from its last verified projection" });
      }
    }
    if (observedDigest(current, context.desired) === context.desired.digest) {
      try {
        return finalizeProjection(db, request, digest, context, adapter, current, "verify");
      } catch (error) {
        if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
        return result("INTERNAL_ERROR", request.projectId, 1, 0, 0, { message: "internal mutation error" });
      }
    }
    try {
      context = reserveExistingProjection(db, request, digest, context);
    } catch (error) {
      if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
      return result("INTERNAL_ERROR", request.projectId, 1, 0, 0, { message: "internal mutation error" });
    }
    const currentLabels = new Set(current.labels);
    mutation = {
      kind: "update",
      owner: context.mapping.owner,
      repo: context.mapping.repo,
      issueNumber: context.ref.issue_number!,
      title: context.desired.title,
      body: context.desired.body,
      state: context.desired.state,
      addLabels: context.desired.managedLabels.filter((label) => !currentLabels.has(label)),
      removeLabels: current.labels.filter((label) => context.desired.managedNames.has(label) && !context.desired.managedLabels.includes(label)),
    };
  }

  try {
    const mutationResponse = parseSnapshot(adapter.mutate(mutation));
    if (
      mutationResponse.owner !== mutation.owner ||
      mutationResponse.repo !== mutation.repo ||
      (mutation.issueNumber !== undefined && mutationResponse.issueNumber !== mutation.issueNumber)
    ) {
      throw new GitHubIssueAdapterError("ambiguous");
    }
    const readBackValue = adapter.read(mutation.owner, mutation.repo, mutationResponse.issueNumber);
    if (readBackValue === null) throw new GitHubIssueAdapterError("ambiguous");
    const readBack = parseSnapshot(readBackValue);
    if (readBack.owner !== mutation.owner || readBack.repo !== mutation.repo || readBack.issueNumber !== mutationResponse.issueNumber) {
      throw new GitHubIssueAdapterError("ambiguous");
    }
    return finalizeProjection(db, request, digest, context, adapter, readBack, mutation.kind);
  } catch {
    try {
      return recordProjectionState(
        db,
        request,
        digest,
        context,
        "delivery_ambiguous",
        "EXTERNAL_DELIVERY_AMBIGUOUS",
        { expected: 1, attempted: 1, verified: 0 },
        "GitHub delivery or exact read-back could not be proven",
      );
    } catch {
      return result("EXTERNAL_DELIVERY_AMBIGUOUS", request.projectId, 1, 1, 0, { message: "GitHub delivery or local finalization could not be proven" });
    }
  }
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique|busy|locked/iu.test(error.message);
}

function unavailableResult(subject: string, message: string): FoundationResult {
  return result("CANONICAL_STORE_UNAVAILABLE", subject, 1, 0, 0, { message });
}

export function applyFixtureMutation(
  db: SqliteDatabase | null,
  input: unknown,
  githubAdapter: GitHubIssueAdapter | null = null,
  roleFactReader: RoleFactReader | null = null,
): FoundationResult {
  let request: ApplyRequest;
  try {
    request = parseApplyRequest(input);
  } catch (error) {
    if (error instanceof Refusal) return refusalResult("apply", error.data);
    return result("INVALID_INPUT", "apply", 1, 0, 0, { message: String(error) });
  }
  if (!db) return unavailableResult(request.projectId, "canonical SQLite store is unavailable");
  try {
    const digest = requestDigest(request);
    if (request.operationClass === "github_issue_projection") {
      return applyGithubIssueProjection(db, request, digest, githubAdapter);
    }
    if (request.operationClass === "qualification_observation_record" || request.operationClass === "role_generation_succession") {
      return applyRoleMutation(db, request, digest, roleFactReader);
    }
    return transaction(db, () => {
      const replay = checkIdempotency(db, request, digest);
      if (replay) return replay;
      switch (request.operationClass) {
        case "bootstrap":
          return applyBootstrap(db, request, digest);
        case "config_revision":
          return applyConfigRevision(db, request, digest);
        case "governor_claim":
          return applyGovernorClaim(db, request, digest);
        case "decision_disposition":
          return applyDecisionDisposition(db, request, digest);
        case "work_item_create":
          return applyWorkItemCreate(db, request, digest);
        case "work_item_transition":
          return applyWorkItemTransition(db, request, digest);
        case "github_issue_projection":
          throw refusal("INTERNAL_ERROR", "projection must not run inside the canonical transaction");
        case "qualification_observation_record":
        case "role_generation_succession":
          throw refusal("INTERNAL_ERROR", "role fact operations must not run inside the canonical transaction");
      }
    });
  } catch (error) {
    if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
    if (isConstraintError(error)) return result("CANONICAL_STORE_UNAVAILABLE", request.projectId, 1, 0, 0, { message: String(error) });
    return result("INTERNAL_ERROR", request.projectId, 1, 0, 0, { message: "internal mutation error" });
  }
}

export function operatorAuthRequired(projectId: string): FoundationResult {
  return result("OPERATOR_AUTH_REQUIRED", projectId, 1, 0, 0, {
    message: "BB has not supplied a trustworthy native operator actor receipt; no write was attempted",
  });
}

function tableRows(db: SqliteDatabase, table: (typeof TABLES)[number], projectId: string): Record<string, unknown>[] {
  const orderBy: Record<(typeof TABLES)[number], string> = {
    project_config_revisions: "config_revision",
    project_config_heads: "project_id",
    repository_targets: "repo_target_id, config_revision",
    project_governorships: "governance_epoch",
    project_governorship_heads: "project_id",
    actor_receipts: "receipt_id",
    decisions: "decision_id",
    decision_dispositions: "decision_id, disposition_sequence",
    mutation_receipts: "idempotency_key",
    state_events: "event_sequence",
    work_items: "work_item_id",
    external_work_refs: "work_item_id, provider",
    qualification_observations: "qualification_id",
    eligibility_projections: "role_requirement_id, profile_digest",
    role_generations: "role_id, generation",
    role_generation_heads: "role_id",
  };
  const query =
    table === "decision_dispositions"
      ? `SELECT decision_dispositions.* FROM decision_dispositions
         JOIN decisions ON decisions.decision_id = decision_dispositions.decision_id
         WHERE decisions.project_id = ? ORDER BY ${orderBy[table]}`
      : `SELECT * FROM ${table} WHERE project_id = ? ORDER BY ${orderBy[table]}`;
  return db.prepare(query).all(projectId) as Record<string, unknown>[];
}

export function exportFoundation(db: SqliteDatabase | null, projectId: string): FoundationResult {
  if (!db) return unavailableResult(projectId, "canonical SQLite store is unavailable");
  try {
    const rowsByTable = Object.fromEntries(TABLES.map((table) => [table, tableRows(db, table, projectId)])) as Record<
      (typeof TABLES)[number],
      Record<string, unknown>[]
    >;
    const tableCounts = Object.fromEntries(TABLES.map((table) => [table, rowsByTable[table].length]));
    const rowCount = Object.values(tableCounts).reduce((sum, count) => sum + count, 0);
    if (rowCount === 0) return result("PROJECT_CONFIG_REQUIRED", projectId, 1, 1, 0, { message: "project has no stored foundation" });
    if (rowCount > MAX_EXPORT_ROWS) return result("EXPORT_BOUNDED", projectId, rowCount, rowCount, 0, { message: "export exceeds the bounded row limit" });
    const recordsNdjson = TABLES.flatMap((table) =>
      rowsByTable[table].map((row) => canonicalJson({ table, row })),
    ).join("\n");
    if (Buffer.byteLength(recordsNdjson, "utf8") > MAX_EXPORT_BYTES) {
      return result("EXPORT_BOUNDED", projectId, rowCount, rowCount, 0, { message: "export exceeds the bounded byte limit" });
    }
    const recordsDigest = sha256(recordsNdjson);
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      pluginId: PLUGIN_ID,
      projectId,
      migrationStatementIds: MIGRATIONS.map((_, index) => index),
      schemaDigest,
      rowCount,
      tableCounts,
      recordsDigest,
    };
    const manifestJson = canonicalJson(manifest);
    const exportPayload: ExportPayload = {
      manifest,
      recordsNdjson,
      checksums: {
        "manifest.json": sha256(manifestJson),
        "records.ndjson": recordsDigest,
      },
    };
    return result("OK", projectId, rowCount, rowCount, rowCount, { export: exportPayload });
  } catch (error) {
    return result("CANONICAL_STORE_UNAVAILABLE", projectId, 1, 0, 0, { message: String(error) });
  }
}

export interface DoctorSdk {
  system: { version(args?: { force?: boolean; signal?: AbortSignal }): Promise<{
    currentVersion: string;
    latestVersion: string | null;
    source: "npm";
    updateAvailable: boolean;
    isDevelopment: boolean;
    upgradeCommand: string;
  }> };
  projects: { get(args: { projectId: string; signal?: AbortSignal }): Promise<{
    id: string;
    kind: string;
    name: string;
    gitRemoteUrl: string | null;
    sources: Array<{ id: string; projectId: string; isDefault: boolean; hostId: string; path: string }>;
  }> };
  hosts: { get(args: { hostId: string; signal?: AbortSignal }): Promise<{
    id: string;
    name: string;
    status: string;
    maxPermissionMode: string;
  }> };
}

function versionAtLeast037(version: string): boolean {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/u.exec(version);
  if (!match) return false;
  const tuple = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  return tuple[0] > 0 || (tuple[0] === 0 && tuple[1] >= 37);
}

export async function doctor(
  db: SqliteDatabase | null,
  sdk: DoctorSdk | null,
  projectId: string,
): Promise<FoundationResult> {
  if (!db) return unavailableResult(projectId, "canonical SQLite store is unavailable");
  if (!sdk) return result("BB_FACTS_UNAVAILABLE", projectId, 1, 0, 0, { message: "BB fact SDK is unavailable" });
  try {
    const version = await sdk.system.version();
    if (!versionAtLeast037(version.currentVersion)) {
      return result("BB_VERSION_INCOMPATIBLE", projectId, 1, 1, 0, {
        message: `BB ${version.currentVersion} does not satisfy ${BB_VERSION_RANGE}`,
        evidence: { currentVersion: version.currentVersion, required: BB_VERSION_RANGE, pluginSdkVersion: PLUGIN_SDK_VERSION },
      });
    }
    let project: Awaited<ReturnType<DoctorSdk["projects"]["get"]>>;
    try {
      project = await sdk.projects.get({ projectId });
    } catch {
      return result("PROJECT_UNKNOWN", projectId, 1, 1, 0, { message: "BB project was not found" });
    }
    if (project.id !== projectId) return result("PROJECT_UNKNOWN", projectId, 1, 1, 0, { message: "BB returned a different project" });
    const configHead = currentConfig(db, projectId);
    if (!configHead) {
      return result("PROJECT_CONFIG_REQUIRED", projectId, 1, 1, 0, {
        message: "BB project exists but has no stored config revision",
        evidence: { bbVersion: version.currentVersion, project: { id: project.id, name: project.name } },
      });
    }
    const targets = db
      .prepare("SELECT * FROM repository_targets WHERE project_id = ? AND config_revision = ? ORDER BY repo_target_id")
      .all(projectId, configHead.config_revision) as Array<Record<string, string | number | null>>;
    if (targets.length === 0) {
      return result("REPO_TARGET_REQUIRED", projectId, 2, 2, 1, {
        currentConfigRevision: configHead.config_revision,
        message: "stored config has no exact repository target",
      });
    }
    const targetEvidence: Array<Record<string, unknown>> = [];
    for (const target of targets) {
      const source = project.sources.find((candidate) => candidate.id === target.source_id);
      if (!source || source.projectId !== projectId || source.hostId !== target.host_id || source.path !== target.path) {
        return result("REPO_TARGET_FOREIGN", projectId, targets.length + 1, targetEvidence.length + 1, targetEvidence.length, {
          message: `stored target ${target.repo_target_id} does not match BB project/source facts`,
        });
      }
      if (project.gitRemoteUrl !== target.remote_url && target.remote_url !== null) {
        return result("REPO_TARGET_FOREIGN", projectId, targets.length + 1, targetEvidence.length + 1, targetEvidence.length, {
          message: `stored target ${target.repo_target_id} does not match the BB project remote`,
        });
      }
      let host: Awaited<ReturnType<DoctorSdk["hosts"]["get"]>>;
      try {
        host = await sdk.hosts.get({ hostId: String(target.host_id) });
      } catch {
        return result("HOST_UNAVAILABLE", projectId, targets.length + 1, targetEvidence.length + 1, targetEvidence.length, {
          message: `BB host ${target.host_id} was unavailable`,
        });
      }
      if (host.id !== target.host_id) return result("HOST_UNAVAILABLE", projectId, targets.length + 1, targetEvidence.length + 1, targetEvidence.length, { message: "BB returned a different host" });
      targetEvidence.push({
        repoTargetId: target.repo_target_id,
        source: { id: source.id, projectId: source.projectId, hostId: source.hostId, path: source.path },
        host: { id: host.id, name: host.name, status: host.status, maxPermissionMode: host.maxPermissionMode },
        remoteUrl: target.remote_url,
        defaultBranch: target.default_branch,
      });
    }
    const governor = asRow<Record<string, unknown>>(
      db.prepare("SELECT * FROM project_governorship_heads WHERE project_id = ?").get(projectId),
    );
    const roleGenerationHeads = db.prepare(
      `SELECT role_generation_heads.role_id, role_generation_heads.current_generation,
              role_generations.status, role_generations.qualification_id,
              role_generations.holder_execution_attempt_id
       FROM role_generation_heads
       JOIN role_generations ON role_generations.project_id = role_generation_heads.project_id
         AND role_generations.role_id = role_generation_heads.role_id
         AND role_generations.generation = role_generation_heads.current_generation
       WHERE role_generation_heads.project_id = ? ORDER BY role_generation_heads.role_id`,
    ).all(projectId) as Array<Record<string, unknown>>;
    const observationCount = asRow<{ count: number }>(
      db.prepare("SELECT COUNT(*) AS count FROM qualification_observations WHERE project_id = ?").get(projectId),
    )?.count ?? 0;
    const configuredRequirements = roleRequirementsFromJson(storedConfigJson(db, projectId, configHead.config_revision));
    const eligibility = (db.prepare(
      `SELECT role_requirement_id, profile_digest, current_qualification_id, effective_status,
              config_revision, role_requirement_digest, expires_at_ms, reason_code
       FROM eligibility_projections WHERE project_id = ? ORDER BY role_requirement_id, profile_digest`,
    ).all(projectId) as Array<Record<string, unknown>>).map((row) => {
      const requirement = configuredRequirements.find((candidate) => candidate.roleRequirementId === row.role_requirement_id);
      const stale = row.config_revision !== configHead.config_revision || !requirement || sha256(canonicalJson(requirement)) !== row.role_requirement_digest;
      const expired = typeof row.expires_at_ms === "number" && row.expires_at_ms <= now();
      return {
        roleRequirementId: row.role_requirement_id,
        profileDigest: row.profile_digest,
        currentQualificationId: row.current_qualification_id,
        effectiveStatus: stale ? "stale" : expired ? "expired" : row.effective_status,
        reasonCode: stale ? "requirement_or_config_stale" : expired ? "eligibility_expired" : row.reason_code,
      };
    });
    const schemaState = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (" + TABLES.map(() => "?").join(",") + ") ORDER BY name")
      .all(...TABLES) as Array<{ name: string }>;
    const expected = targets.length + 1;
    return result("OK", projectId, expected, expected, expected, {
      currentConfigRevision: configHead.config_revision,
      currentGovernanceEpoch: governor ? Number(governor.governance_epoch) : undefined,
      evidence: {
        bbVersion: version.currentVersion,
        pluginSdkVersion: PLUGIN_SDK_VERSION,
        compatibility: { bb: BB_VERSION_RANGE, bbPluginSdk: `^${PLUGIN_SDK_VERSION}` },
        project: { id: project.id, kind: project.kind, name: project.name, gitRemoteUrl: project.gitRemoteUrl },
        targets: targetEvidence,
        governorshipHead: governor ?? null,
        roleGenerationHeads,
        qualificationObservationCount: observationCount,
        eligibility,
        cachedConsumers: {
          names: ["server.rpcContract", "server.collabCli", "src/test-support", "tests/server.test"],
          expected: 0,
          attempted: 0,
          verified: 0,
        },
        schema: { version: SCHEMA_VERSION, migrationStatementIds: MIGRATIONS.map((_, index) => index), digest: schemaDigest, tables: schemaState.map((row) => row.name) },
      },
    });
  } catch (error) {
    return result("BB_FACTS_UNAVAILABLE", projectId, 1, 0, 0, { message: String(error) });
  }
}

export function databaseIsReady(db: SqliteDatabase): void {
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}
