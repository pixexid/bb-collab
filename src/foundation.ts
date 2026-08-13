import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";

export const PLUGIN_ID = "bb-collab";
export const BB_VERSION_RANGE = ">=0.37.0";
export const PLUGIN_SDK_VERSION = "0.4.1";
export const SCHEMA_VERSION = 5;
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
  "evidence_artifacts",
  "decision_evidence",
  "mutation_receipts",
  "state_events",
  "work_items",
  "external_work_refs",
  "qualification_observations",
  "eligibility_projections",
  "assignments",
  "execution_attempts",
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
  `CREATE TABLE IF NOT EXISTS assignments (
    project_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    assignment_kind TEXT NOT NULL CHECK (assignment_kind IN ('write', 'review', 'probe')),
    lane_id TEXT NOT NULL,
    role_requirement_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    role_generation INTEGER NOT NULL CHECK (role_generation > 0),
    config_revision INTEGER NOT NULL,
    governance_epoch INTEGER NOT NULL CHECK (governance_epoch > 0),
    work_item_revision INTEGER NOT NULL CHECK (work_item_revision > 0),
    repo_target_id TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    candidate_semantics TEXT NOT NULL CHECK (candidate_semantics IN ('base', 'frozen')),
    candidate_sha TEXT,
    bb_server_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    environment_path TEXT NOT NULL,
    environment_mode TEXT NOT NULL CHECK (environment_mode = 'managed-worktree'),
    frozen_brief_version INTEGER NOT NULL CHECK (frozen_brief_version = 1),
    frozen_brief_digest TEXT NOT NULL,
    requested_provider_id TEXT NOT NULL,
    requested_model TEXT NOT NULL,
    requested_reasoning_level TEXT NOT NULL,
    requested_permission_mode TEXT NOT NULL CHECK (requested_permission_mode = 'full'),
    requested_service_tier TEXT NOT NULL,
    requested_visibility TEXT NOT NULL CHECK (requested_visibility = 'visible'),
    requested_profile_digest TEXT NOT NULL,
    dispatch_kind TEXT NOT NULL CHECK (dispatch_kind IN ('spawn', 'attach')),
    attach_thread_id TEXT,
    parent_assignment_id TEXT,
    depth INTEGER NOT NULL CHECK (depth = 0),
    deadline_at_ms INTEGER NOT NULL CHECK (deadline_at_ms >= 0),
    assignment_digest TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    creation_event_sequence INTEGER NOT NULL CHECK (creation_event_sequence > 0),
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (project_id, assignment_id),
    FOREIGN KEY (project_id, work_item_id)
      REFERENCES work_items(project_id, work_item_id),
    FOREIGN KEY (project_id, repo_target_id, config_revision)
      REFERENCES repository_targets(project_id, repo_target_id, config_revision),
    FOREIGN KEY (project_id, role_id, role_generation)
      REFERENCES role_generations(project_id, role_id, generation),
    FOREIGN KEY (project_id, parent_assignment_id)
      REFERENCES assignments(project_id, assignment_id),
    CHECK ((candidate_semantics = 'base' AND candidate_sha IS NULL) OR
           (candidate_semantics = 'frozen' AND candidate_sha IS NOT NULL)),
    CHECK ((dispatch_kind = 'spawn' AND attach_thread_id IS NULL) OR
           (dispatch_kind = 'attach' AND attach_thread_id IS NOT NULL))
  );
  CREATE TABLE IF NOT EXISTS execution_attempts (
    project_id TEXT NOT NULL,
    execution_attempt_id TEXT NOT NULL,
    assignment_id TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('assignment', 'role_holder', 'legacy_unresolved')),
    assignment_digest TEXT,
    lane_id TEXT,
    assignment_kind TEXT CHECK (assignment_kind IS NULL OR assignment_kind IN ('write', 'review', 'probe')),
    attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal > 0),
    dispatch_kind TEXT CHECK (dispatch_kind IS NULL OR dispatch_kind IN ('spawn', 'attach')),
    config_revision INTEGER NOT NULL,
    governance_epoch INTEGER NOT NULL CHECK (governance_epoch > 0),
    work_item_id TEXT,
    repo_target_id TEXT,
    role_id TEXT NOT NULL,
    role_generation INTEGER NOT NULL CHECK (role_generation > 0),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'armed', 'content_delivered', 'running', 'done', 'blocked', 'failed', 'dispatch_unknown')),
    bb_server_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    environment_path TEXT NOT NULL,
    thread_id TEXT,
    provider_thread_id TEXT,
    native_request_id TEXT,
    request_event_id TEXT,
    request_event_seq INTEGER,
    accepted_event_id TEXT,
    accepted_event_seq INTEGER,
    first_action_event_id TEXT,
    first_action_event_seq INTEGER,
    content_event_id TEXT,
    content_event_seq INTEGER,
    completion_event_id TEXT,
    completion_event_seq INTEGER,
    terminal_event_id TEXT,
    terminal_event_seq INTEGER,
    frozen_brief_digest TEXT,
    content_receipt_digest TEXT,
    actual_provider_id TEXT,
    actual_model TEXT,
    actual_reasoning_level TEXT,
    actual_permission_mode TEXT,
    actual_service_tier TEXT,
    actual_visibility TEXT CHECK (actual_visibility IS NULL OR actual_visibility IN ('visible', 'hidden')),
    actual_profile_digest TEXT,
    branch_name TEXT,
    base_sha TEXT,
    candidate_sha TEXT,
    environment_digest TEXT NOT NULL,
    native_receipt_digest TEXT,
    terminal_result TEXT CHECK (terminal_result IS NULL OR terminal_result IN ('DONE', 'BLOCKED')),
    reported_outcome TEXT CHECK (reported_outcome IS NULL OR reported_outcome IN ('DONE', 'BLOCKED')),
    terminal_report_digest TEXT,
    conflicting_terminal_digest TEXT,
    reason_code TEXT,
    last_event_seq INTEGER,
    created_at_ms INTEGER NOT NULL,
    observed_at_ms INTEGER,
    completed_at_ms INTEGER,
    attempt_digest TEXT NOT NULL,
    PRIMARY KEY (project_id, execution_attempt_id),
    FOREIGN KEY (project_id, assignment_id)
      REFERENCES assignments(project_id, assignment_id),
    FOREIGN KEY (project_id, repo_target_id, config_revision)
      REFERENCES repository_targets(project_id, repo_target_id, config_revision),
    CHECK ((origin = 'assignment' AND assignment_id IS NOT NULL AND assignment_digest IS NOT NULL AND lane_id IS NOT NULL AND assignment_kind IS NOT NULL) OR
           (origin != 'assignment' AND assignment_id IS NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_active_assignment
    ON execution_attempts(project_id, assignment_digest)
    WHERE origin = 'assignment' AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown');
  CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_active_writer_lane
    ON execution_attempts(project_id, lane_id)
    WHERE origin = 'assignment' AND assignment_kind = 'write'
      AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown');
  CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_native_request
    ON execution_attempts(bb_server_id, thread_id, native_request_id)
    WHERE thread_id IS NOT NULL AND native_request_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS execution_attempts_project_state
    ON execution_attempts(project_id, state, assignment_kind, lane_id)`,
  `ALTER TABLE decisions ADD COLUMN decision_class TEXT;
  ALTER TABLE decisions ADD COLUMN options_json TEXT;
  ALTER TABLE decisions ADD COLUMN decision_identity_digest TEXT;
  ALTER TABLE decision_dispositions ADD COLUMN conditions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conditions_json));
  ALTER TABLE decision_dispositions ADD COLUMN hold_action TEXT NOT NULL DEFAULT 'none' CHECK (hold_action IN ('none', 'set', 'clear'));
  ALTER TABLE decision_dispositions ADD COLUMN hold_code TEXT;
  ALTER TABLE decision_dispositions ADD COLUMN hold_reference_sequence INTEGER;
  ALTER TABLE decision_dispositions ADD COLUMN supersedes_disposition_sequence INTEGER;
  ALTER TABLE decision_dispositions ADD COLUMN reverts_disposition_sequence INTEGER;
  CREATE TABLE IF NOT EXISTS evidence_artifacts (
    project_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    evidence_kind TEXT NOT NULL CHECK (evidence_kind IN
      ('advisory_read', 'delegated_action_receipt', 'legacy_claim', 'connector', 'test', 'export', 'release', 'review_ready')),
    source_kind TEXT NOT NULL CHECK (source_kind IN
      ('helper', 'pro', 'legacy_claim', 'delegated_action', 'connector', 'test', 'export', 'release', 'review_ready')),
    source_ref TEXT NOT NULL,
    execution_attempt_id TEXT,
    content_digest TEXT NOT NULL,
    redacted_json TEXT NOT NULL CHECK (json_valid(redacted_json)),
    redacted_digest TEXT NOT NULL,
    durable_ref_json TEXT NOT NULL CHECK (json_valid(durable_ref_json)),
    artifact_identity_digest TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (project_id, evidence_id),
    FOREIGN KEY (project_id, execution_attempt_id)
      REFERENCES execution_attempts(project_id, execution_attempt_id),
    CHECK ((evidence_kind = 'delegated_action_receipt' AND source_kind = 'delegated_action' AND execution_attempt_id IS NOT NULL) OR
           (evidence_kind != 'delegated_action_receipt' AND source_kind != 'delegated_action' AND execution_attempt_id IS NULL))
  );
  CREATE TABLE IF NOT EXISTS decision_evidence (
    project_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    evidence_sequence INTEGER NOT NULL CHECK (evidence_sequence > 0),
    evidence_id TEXT NOT NULL,
    disposition_sequence INTEGER NOT NULL CHECK (disposition_sequence > 0),
    relation_kind TEXT NOT NULL CHECK (relation_kind IN
      ('advisory_read', 'delegated_action_receipt', 'legacy_claim', 'supporting')),
    relation_json TEXT NOT NULL CHECK (json_valid(relation_json)),
    created_at_ms INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    PRIMARY KEY (project_id, decision_id, evidence_sequence),
    FOREIGN KEY (decision_id, disposition_sequence)
      REFERENCES decision_dispositions(decision_id, disposition_sequence),
    FOREIGN KEY (project_id, evidence_id)
      REFERENCES evidence_artifacts(project_id, evidence_id)
  )`,
];

export const schemaDigest = sha256(MIGRATIONS.join("\n"));
export const CACHED_CONSUMERS = ["server.rpcContract", "server.collabCli", "src/test-support", "tests/server.test"] as const;

export function cachedConsumerRolloutEvidence(observedSchemaVersion: number) {
  const reread = observedSchemaVersion === SCHEMA_VERSION;
  const evidence = {
    names: [...CACHED_CONSUMERS],
    oldSchemaVersion: 4,
    newSchemaVersion: SCHEMA_VERSION,
    observedSchemaVersion,
    action: reread ? "reread" : "refused",
    expected: CACHED_CONSUMERS.length,
    attempted: CACHED_CONSUMERS.length,
    verified: reread ? CACHED_CONSUMERS.length : 0,
    schemaDigest,
  };
  return { ...evidence, rolloutReceiptDigest: sha256(canonicalJson(evidence)) };
}

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
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const sortedIdSetSchema = z
  .array(id)
  .min(1)
  .max(64)
  .refine((values) => new Set(values).size === values.length && canonicalJson(values) === canonicalJson([...values].sort()), {
    message: "values must be sorted and duplicate-free",
  });
const reviewTargetSchema = z
  .object({
    workItemId: id,
    repoTargetId: id,
    configRevision: z.number().int().positive(),
    baseSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
    h0CandidateSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
    h0TreeDigest: digestSchema,
    tierAEntries: sortedIdSetSchema,
  })
  .strict();
const reviewScopeSchema = z
  .object({ targets: z.array(reviewTargetSchema).min(1).max(32) })
  .strict()
  .superRefine((scope, ctx) => {
    const keys = scope.targets.map((target) => `${target.workItemId}\u0000${target.repoTargetId}`);
    if (new Set(scope.targets.map((target) => target.workItemId)).size !== scope.targets.length) {
      ctx.addIssue({ code: "custom", path: ["targets"], message: "one WorkItem cannot span multiple review targets" });
    }
    if (canonicalJson(keys) !== canonicalJson([...keys].sort())) {
      ctx.addIssue({ code: "custom", path: ["targets"], message: "review targets must be canonically sorted" });
    }
  });
const connectorPolicySchema = z.enum(["required", "optional", "prohibited"]);
const reviewConnectorSchema = z
  .object({ repoTargetId: id, connectorId: id, policy: connectorPolicySchema })
  .strict();
const reviewConnectorsSchema = z
  .array(reviewConnectorSchema)
  .min(1)
  .max(128)
  .superRefine((connectors, ctx) => {
    const keys = connectors.map((connector) => `${connector.repoTargetId}\u0000${connector.connectorId}`);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", message: "review connector mappings must be duplicate-free" });
    }
    if (canonicalJson(keys) !== canonicalJson([...keys].sort())) {
      ctx.addIssue({ code: "custom", message: "review connector mappings must be canonically sorted" });
    }
  });
const reviewOptionsSchema = z
  .object({ connectors: reviewConnectorsSchema })
  .strict();
const gitIdentitySchema = z.object({ name: id, email: id }).strict();
const connectorReviewRelationSchema = z
  .object({
    relationRole: z.literal("connector_h0"),
    workItemId: id,
    repoTargetId: id,
    h0CandidateSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
    h0TreeDigest: digestSchema,
    connectorId: id,
    state: z.enum(["available", "absent", "degraded", "unknown"]),
    terminal: z.boolean(),
  })
  .strict();
const finalReviewRelationSchema = z
  .object({
    relationRole: z.literal("final_review"),
    workItemId: id,
    repoTargetId: id,
    configRevision: z.number().int().positive(),
    baseSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
    candidateSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
    treeDigest: digestSchema,
    changedFiles: sortedIdSetSchema,
    tierAEntries: sortedIdSetSchema,
    writeAssignmentId: id,
    writeExecutionAttemptId: id,
    authors: z.array(gitIdentitySchema).min(1).max(64),
    committers: z.array(gitIdentitySchema).min(1).max(64),
  })
  .strict();
const amendmentReviewRelationSchema = z
  .object({
    relationRole: z.literal("amendment_scope"),
    workItemId: id,
    repoTargetId: id,
    baseSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
    h0AssignmentId: id,
    h0CandidateSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
    h0TreeDigest: digestSchema,
    h1AssignmentId: id,
    h1CandidateSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
    h1TreeDigest: digestSchema,
    allowedChangedFiles: sortedIdSetSchema,
    actualChangedFiles: sortedIdSetSchema,
  })
  .strict();
const decisionSchema = z
  .object({
    decisionId: id,
    repoTargetId: id.nullable(),
    scope: z.unknown(),
    decisionClass: id.optional(),
    options: z.unknown().optional(),
    resourceRevision: z.number().int().positive().default(1),
  })
  .strict();

export const DECISION_CLASSES = [
  "assignment_admission",
  "role_succession",
  "review_adjudication",
  "legacy_adoption",
  "operator_only",
] as const;
const decisionConditionSchema = z
  .object({
    kind: z.literal("evidence_required"),
    evidenceIds: z.array(id).min(1).max(32),
  })
  .strict();
const decisionEvidenceSchema = z
  .object({
    evidenceId: id,
    evidenceKind: z.enum([
      "advisory_read",
      "delegated_action_receipt",
      "legacy_claim",
      "connector",
      "test",
      "export",
      "release",
      "review_ready",
    ]),
    sourceKind: z.enum([
      "helper",
      "pro",
      "legacy_claim",
      "delegated_action",
      "connector",
      "test",
      "export",
      "release",
      "review_ready",
    ]),
    sourceRef: id,
    assignmentId: id.optional(),
    executionAttemptId: id.nullable().default(null),
    contentDigest: digestSchema,
    redactedJson: z.string(),
    durableRefJson: z.string(),
    relationKind: z.enum(["advisory_read", "delegated_action_receipt", "legacy_claim", "supporting"]),
    relation: z.unknown().optional(),
    terminalReportDigest: digestSchema.optional(),
    actualProfileDigest: digestSchema.optional(),
    nativeReceiptDigest: digestSchema.optional(),
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
const reviewPolicySchema = z.object({ connectors: reviewConnectorsSchema }).strict();

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
const gitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/u);
const assignmentEnvironmentSchema = z
  .object({
    bbServerId: id,
    environmentId: id,
    sourceId: id,
    hostId: id,
    path: id,
    mode: z.literal("managed-worktree"),
  })
  .strict();
const assignmentIntentSchema = z
  .object({
    assignmentId: id,
    workItemId: id,
    assignmentKind: z.enum(["write", "review", "probe"]),
    laneId: id,
    roleRequirementId: id,
    roleId: roleIdSchema,
    roleGeneration: z.number().int().positive(),
    branchName: id,
    baseSha: gitShaSchema,
    candidateSemantics: z.enum(["base", "frozen"]),
    candidateSha: gitShaSchema.nullable(),
    environment: assignmentEnvironmentSchema,
    frozenBriefVersion: z.literal(1),
    frozenBriefDigest: digestSchema,
    requestedProfile: executionProfileSchema,
    dispatchKind: z.enum(["spawn", "attach"]),
    attachThreadId: id.nullable(),
    parentAssignmentId: id.nullable().default(null),
    depth: z.literal(0),
    deadlineAtMs: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((assignment, ctx) => {
    if ((assignment.candidateSemantics === "base") !== (assignment.candidateSha === null)) {
      ctx.addIssue({ code: "custom", path: ["candidateSha"], message: "base intent has no candidate; frozen intent requires one" });
    }
    if ((assignment.dispatchKind === "attach") !== (assignment.attachThreadId !== null)) {
      ctx.addIssue({ code: "custom", path: ["attachThreadId"], message: "attach requires one exact thread; spawn forbids one" });
    }
  });
const terminalEvidenceSchema = z
  .object({ kind: id, digest: digestSchema, ref: id })
  .strict();
const terminalReportSchema = z
  .object({
    receiptVersion: z.literal(1),
    outcome: z.enum(["DONE", "BLOCKED"]),
    projectId: id,
    assignmentId: id,
    executionAttemptId: id,
    workItemId: id,
    roleId: roleIdSchema,
    roleGeneration: z.number().int().positive(),
    repoTargetId: id,
    environmentId: id,
    threadId: id,
    branchName: id,
    baseSha: gitShaSchema,
    candidateSha: gitShaSchema,
    nativeReceiptDigest: digestSchema,
    actualProfileDigest: digestSchema,
    candidateObservationDigest: digestSchema,
    reasonCode: id,
    evidence: z.array(terminalEvidenceSchema).min(1).max(64),
    reportedAtMs: z.number().int().nonnegative(),
    receiptEventId: id,
    receiptEventSeq: z.number().int().positive(),
    receivedAtMs: z.number().int().nonnegative(),
  })
  .strict();

export const applyRequestSchema = z
  .object({
    projectId: id,
    operationClass: z.enum([
      "bootstrap",
      "config_revision",
      "governor_claim",
      "decision_create",
      "decision_disposition",
      "work_item_create",
      "work_item_transition",
      "github_issue_projection",
      "qualification_observation_record",
      "role_generation_succession",
      "assignment_prepare",
      "assignment_dispatch",
      "assignment_reconcile",
      "assignment_terminal",
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
    conditions: z.array(decisionConditionSchema).max(32).optional(),
    holdAction: z.enum(["none", "set", "clear"]).optional(),
    holdCode: id.nullable().optional(),
    holdReferenceSequence: z.number().int().positive().nullable().optional(),
    supersedesDispositionSequence: z.number().int().positive().nullable().optional(),
    revertsDispositionSequence: z.number().int().positive().nullable().optional(),
    decisionEvidence: z.array(decisionEvidenceSchema).max(64).optional(),
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
    assignment: assignmentIntentSchema.optional(),
    assignmentId: id.optional(),
    executionAttemptId: id.optional(),
    frozenBriefContent: z.string().max(256 * 1024).optional(),
    terminalReport: terminalReportSchema.optional(),
  })
  .strict();

export type ApplyRequest = z.infer<typeof applyRequestSchema>;
type DecisionEvidenceInput = z.infer<typeof decisionEvidenceSchema>;
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
  serverId(): string;
  thread(threadId: string): RoleThreadFact;
  events(threadId: string): RoleEventFact[];
  environment(environmentId: string): RoleEnvironmentFact;
  project(projectId: string): RoleProjectFact;
  host(hostId: string): RoleHostFact;
  version(): string;
}

export interface NativeAssignmentInput {
  projectId: string;
  assignmentId: string;
  executionAttemptId: string;
  assignmentKind: "write" | "review" | "probe";
  dispatchKind: "spawn" | "attach";
  attachThreadId: string | null;
  repoTargetId: string;
  branchName: string;
  baseSha: string;
  candidateSha: string | null;
  candidateScope:
    | { mode: "write"; candidateSemantics: "base"; candidateSha: null }
    | { mode: "read-only"; candidateSemantics: "frozen"; candidateSha: string; mutations: "forbidden" };
  environment: z.infer<typeof assignmentEnvironmentSchema>;
  requestedProfile: ExecutionProfile;
  executionInputSources: {
    providerId: "explicit";
    model: "explicit";
    serviceTier?: "explicit";
    reasoningLevel: "explicit";
    permissionMode: "explicit";
  };
  frozenBriefContent: string;
  frozenBriefDigest: string;
}

export interface NativeAssignmentEvidence {
  disposition: "confirmed" | "refused" | "ambiguous";
  reasonCode: string;
  assignmentId?: string;
  executionAttemptId?: string;
  bbServerId?: string;
  projectId?: string;
  environmentId?: string;
  sourceId?: string;
  hostId?: string;
  environmentPath?: string;
  threadId?: string;
  providerThreadId?: string;
  nativeRequestId?: string;
  requestEventId?: string;
  requestEventSeq?: number;
  acceptedEventId?: string;
  acceptedEventSeq?: number;
  firstActionEventId?: string;
  firstActionEventSeq?: number;
  contentEventId?: string;
  contentEventSeq?: number;
  contentDigest?: string;
  actualProfile?: ExecutionProfile;
  branchName?: string;
  baseSha?: string;
  candidateSha?: string | null;
  lastEventSeq?: number;
  observedAtMs?: number;
}

export interface NativeAssignmentInspection {
  bbServerId: string | null;
  projectId: string | null;
  environmentId: string | null;
  sourceId: string | null;
  hostId: string | null;
  environmentPath: string | null;
  environmentMode: string | null;
  environmentStatus: string | null;
  workingTreeState: "clean" | "dirty" | "unknown";
  branchName: string | null;
  headSha: string | null;
  baseSha: string | null;
  candidateSha: string | null;
  defaultBranchName: string | null;
  defaultBranchHeadSha: string | null;
  mergeBaseSha: string | null;
  threadId: string | null;
  threadProviderId: string | null;
  threadVisibility: "visible" | "hidden" | null;
}

export interface ReviewFacts {
  projectId: string;
  workItemId: string;
  repoTargetId: string;
  writeAssignmentId: string;
  writeExecutionAttemptId: string;
  branchName: string;
  baseSha: string;
  candidateSha: string;
  treeDigest: string;
  changedFiles: string[];
  authors: Array<{ name: string; email: string }>;
  committers: Array<{ name: string; email: string }>;
}

const reviewFactsSchema = z.object({
  projectId: id,
  workItemId: id,
  repoTargetId: id,
  writeAssignmentId: id,
  writeExecutionAttemptId: id,
  branchName: id,
  baseSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
  candidateSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
  treeDigest: digestSchema,
  changedFiles: sortedIdSetSchema,
  authors: z.array(gitIdentitySchema).min(1).max(64),
  committers: z.array(gitIdentitySchema).min(1).max(64),
}).strict();

export interface ReviewFactReader {
  read(input: {
    projectId: string;
    workItemId: string;
    repoTargetId: string;
    writeAssignmentId: string;
    writeExecutionAttemptId: string;
    branchName: string;
    baseSha: string;
    candidateSha: string;
  }): ReviewFacts;
}

export interface NativeAssignmentAdapter {
  inspect(input: { projectId: string; repoTargetId: string; assignment: z.infer<typeof assignmentIntentSchema> }): NativeAssignmentInspection;
  dispatch(input: NativeAssignmentInput): NativeAssignmentEvidence;
  reconcile(input: NativeAssignmentInput & { threadId: string | null; nativeRequestId: string | null }): NativeAssignmentEvidence;
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
  bbServerId: string;
  nativeRequestId: string;
  acceptedEventId: string;
  acceptedEventSeq: number;
  startEventId: string;
  startEventSeq: number;
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
  let bbServerId: string;
  try {
    bbServerId = reader.serverId();
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
  if (!stringField(bbVersion) || !stringField(bbServerId) || events.length === 0 || events.length > 256) {
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
  const acceptedEvent = accepted[0]!;
  const providerThreadId = stringField(acceptedEvent.data.providerThreadId);
  if (!providerThreadId) throw refusal("EXECUTION_PROFILE_UNKNOWN", "provider thread correlation is unavailable");
  const starts = events.filter((event) => event.type === "turn/started" && event.data.providerThreadId === providerThreadId);
  if (starts.length !== 1) throw refusal("EXECUTION_PROFILE_UNKNOWN", "correlated execution start is missing or ambiguous");
  const startEvent = starts[0]!;
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
      acceptedEventId: acceptedEvent.id,
      acceptedEventSeq: acceptedEvent.seq,
      startEventId: startEvent.id,
      startEventSeq: startEvent.seq,
      completionEventId: completion.id,
      completionEventSeq: completion.seq,
      source: executionSource,
    },
    bbVersion,
    bbServerId,
    pluginSdkVersion: PLUGIN_SDK_VERSION,
  };
  const holderExecutionAttemptId = sha256(canonicalJson({
    projectId: request.projectId,
    bbServerId,
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
    bbServerId,
    nativeRequestId: requestId,
    acceptedEventId: acceptedEvent.id,
    acceptedEventSeq: acceptedEvent.seq,
    startEventId: startEvent.id,
    startEventSeq: startEvent.seq,
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
  | "DECISION_IDENTITY_CONFLICT"
  | "DECISION_CLASS_UNKNOWN"
  | "DECISION_DISPOSITION_INVALID"
  | "DECISION_REFERENCE_INVALID"
  | "EVIDENCE_REQUIRED"
  | "EVIDENCE_REDACTION_INVALID"
  | "EVIDENCE_IDENTITY_CONFLICT"
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
  | "LANE_WRITER_EXISTS"
  | "DISPATCH_UNKNOWN"
  | "TERMINAL_REPORT_REQUIRED"
  | "TERMINAL_REPORT_AMBIGUOUS"
  | "ASSIGNMENT_HEAD_STALE"
  | "REVIEW_AMENDMENT_CAP"
  | "REVIEW_SCOPE_MISMATCH"
  | "EXECUTION_CONTEXT_FOREIGN"
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
      const writingLaneCeiling = (bbCollab as Record<string, unknown>).writingLaneCeiling;
      if (writingLaneCeiling !== undefined && (!Number.isInteger(writingLaneCeiling) || Number(writingLaneCeiling) < 0 || Number(writingLaneCeiling) > 2)) {
        throw refusal("INVALID_INPUT", "writingLaneCeiling must be an integer from 0 through 2");
      }
      const reviewPolicy = (bbCollab as Record<string, unknown>).reviewPolicy;
      if (reviewPolicy !== undefined) {
        const parsed = reviewPolicySchema.safeParse(reviewPolicy);
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
export type ExecutionProfile = z.infer<typeof executionProfileSchema>;
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

function writingLaneCeilingFromJson(configJson: string): number {
  const config = JSON.parse(configJson) as { extensions?: { bbCollab?: { writingLaneCeiling?: unknown } } };
  const value = config.extensions?.bbCollab?.writingLaneCeiling;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2 ? value : 2;
}

function reviewPolicyFromJson(configJson: string): z.infer<typeof reviewPolicySchema> | null {
  const config = JSON.parse(configJson) as { extensions?: { bbCollab?: { reviewPolicy?: unknown } } };
  const value = config.extensions?.bbCollab?.reviewPolicy;
  if (value === undefined) return null;
  const parsed = reviewPolicySchema.safeParse(value);
  if (!parsed.success) throw refusal("INVALID_INPUT", "stored review policy is invalid");
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
  if (reviewPolicyFromJson(configJson)?.connectors.some((connector) => !targetIds.has(connector.repoTargetId))) {
    throw refusal("REPO_TARGET_FOREIGN", "review connector mapping names a target outside the config revision");
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

function boundedCanonicalObject(value: unknown, label: string, maxBytes = 16 * 1024): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw refusal("MALFORMED_JSON", `${label} must be a JSON object`);
  }
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, "utf8") > maxBytes) throw refusal("MALFORMED_JSON", `${label} exceeds ${maxBytes} bytes`);
  return json;
}

function assertRedactedEvidence(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertRedactedEvidence(child, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:secret|password|token|api[-_]?key|private[-_]?key|raw|payload|transcript|(?:^|_)output|(?:^|_)body|bytes?)/iu.test(key)) {
      throw refusal("EVIDENCE_REDACTION_INVALID", `evidence contains forbidden raw or secret-like field ${path}.${key}`);
    }
    assertRedactedEvidence(child, `${path}.${key}`);
  }
}

function parseCanonicalEvidenceJson(text: string, label: string): { value: Record<string, unknown>; json: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw refusal("MALFORMED_JSON", `${label} is not valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw refusal("MALFORMED_JSON", `${label} must be a JSON object`);
  }
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, "utf8") > 16 * 1024) {
    throw refusal("EVIDENCE_REDACTION_INVALID", `${label} exceeds 16384 bytes`);
  }
  if (json !== text) throw refusal("EVIDENCE_REDACTION_INVALID", `${label} must be canonical JSON`);
  assertRedactedEvidence(value, label);
  return { value: value as Record<string, unknown>, json };
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
    conditions: request.conditions ?? undefined,
    holdAction: request.holdAction ?? undefined,
    holdCode: request.holdCode ?? null,
    holdReferenceSequence: request.holdReferenceSequence ?? null,
    supersedesDispositionSequence: request.supersedesDispositionSequence ?? null,
    revertsDispositionSequence: request.revertsDispositionSequence ?? null,
    decisionEvidence: request.decisionEvidence ?? undefined,
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
    assignment: request.assignment ?? undefined,
    assignmentId: request.assignmentId ?? undefined,
    executionAttemptId: request.executionAttemptId ?? undefined,
    frozenBriefContent: request.frozenBriefContent ?? undefined,
    terminalReport: request.terminalReport ?? undefined,
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

function nextAggregateRevision(db: SqliteDatabase, projectId: string, aggregateType: string, aggregateId: string): number {
  return asRow<{ next_revision: number }>(db.prepare(
    `SELECT COALESCE(MAX(aggregate_revision), 0) + 1 AS next_revision
     FROM state_events WHERE project_id = ? AND aggregate_type = ? AND aggregate_id = ?`,
  ).get(projectId, aggregateType, aggregateId))?.next_revision ?? 1;
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
    if (decision.resourceRevision !== 1) throw refusal("DECISION_IDENTITY_CONFLICT", "new decisions begin at resource revision 1");
    if (decision.repoTargetId !== null && !targets.some((target) => target.repoTargetId === decision.repoTargetId)) {
      throw refusal("REPO_TARGET_FOREIGN", "decision target does not match bootstrap target");
    }
    const identity = decisionIdentity(request.projectId, 1, decision);
    if (identity.decisionClass === "review_adjudication") {
      throw refusal("WORK_ITEM_UNKNOWN", "review Decisions require an existing exact WorkItem and cannot be bootstrapped");
    }
    db.prepare(
      `INSERT INTO decisions
        (decision_id, project_id, config_revision, repo_target_id, scope_json, scope_digest,
         current_resource_revision, decision_class, options_json, decision_identity_digest)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      decision.decisionId,
      request.projectId,
      decision.repoTargetId,
      identity.scopeJson,
      sha256(identity.scopeJson),
      decision.resourceRevision,
      identity.decisionClass,
      identity.optionsJson,
      identity.identityDigest,
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

interface DecisionRow {
  decision_id: string;
  project_id: string;
  config_revision: number;
  repo_target_id: string | null;
  scope_json: string;
  scope_digest: string;
  decision_class: string | null;
  options_json: string | null;
  decision_identity_digest: string | null;
  current_resource_revision: number;
}

type ReviewTarget = z.infer<typeof reviewTargetSchema>;
type ReviewOptions = z.infer<typeof reviewOptionsSchema>;

function parseReviewIdentity(
  scopeJson: string,
  optionsJson: string,
  configRevision: number,
): { scope: z.infer<typeof reviewScopeSchema>; options: ReviewOptions } {
  const scope = reviewScopeSchema.safeParse(JSON.parse(scopeJson));
  const options = reviewOptionsSchema.safeParse(JSON.parse(optionsJson));
  if (!scope.success) throw refusal("DECISION_IDENTITY_CONFLICT", scope.error.message);
  if (!options.success) throw refusal("DECISION_IDENTITY_CONFLICT", options.error.message);
  if (scope.data.targets.some((target) => target.configRevision !== configRevision)) {
    throw refusal("PROJECT_CONFIG_STALE", "review target scope must bind the Decision config revision");
  }
  return { scope: scope.data, options: options.data };
}

function decisionIdentity(
  projectId: string,
  configRevision: number,
  decision: NonNullable<ApplyRequest["decision"]>,
): { scopeJson: string; optionsJson: string; decisionClass: (typeof DECISION_CLASSES)[number]; identityDigest: string } {
  if (!decision.decisionClass || !(DECISION_CLASSES as readonly string[]).includes(decision.decisionClass)) {
    throw refusal("DECISION_CLASS_UNKNOWN", "decision class is not in the bounded v5 class set");
  }
  if (decision.options === undefined) throw refusal("DECISION_IDENTITY_CONFLICT", "typed decision options are required");
  const scopeJson = boundedCanonicalObject(decision.scope, "decision scope");
  const optionsJson = boundedCanonicalObject(decision.options, "decision options");
  if (decision.decisionClass === "review_adjudication") parseReviewIdentity(scopeJson, optionsJson, configRevision);
  const identityDigest = sha256(canonicalJson({
    projectId,
    configRevision,
    repoTargetId: decision.repoTargetId,
    scope: JSON.parse(scopeJson),
    decisionClass: decision.decisionClass,
    options: JSON.parse(optionsJson),
  }));
  return {
    scopeJson,
    optionsJson,
    decisionClass: decision.decisionClass as (typeof DECISION_CLASSES)[number],
    identityDigest,
  };
}

function validateReviewDecisionCreate(
  db: SqliteDatabase,
  request: ApplyRequest,
  decision: NonNullable<ApplyRequest["decision"]>,
  identity: ReturnType<typeof decisionIdentity>,
  configRevision: number,
): void {
  if (identity.decisionClass !== "review_adjudication") return;
  const review = parseReviewIdentity(identity.scopeJson, identity.optionsJson, configRevision);
  const policy = reviewPolicyFromJson(storedConfigJson(db, request.projectId, configRevision));
  const targetIds = [...new Set(review.scope.targets.map((target) => target.repoTargetId))];
  if (!policy || review.options.connectors.length !== targetIds.length) {
    throw refusal("PROJECT_CONFIG_STALE", "review Decision must freeze one connector mapping per exact target");
  }
  for (const targetId of targetIds) {
    const options = review.options.connectors.filter((connector) => connector.repoTargetId === targetId);
    if (options.length !== 1 || !policy.connectors.some((connector) => canonicalJson(connector) === canonicalJson(options[0]))) {
      throw refusal("PROJECT_CONFIG_STALE", "review connector mapping must equal the immutable config revision");
    }
  }
  if (decision.repoTargetId !== null) {
    if (review.scope.targets.length !== 1 || review.scope.targets[0]!.repoTargetId !== decision.repoTargetId) {
      throw refusal("REPO_TARGET_FOREIGN", "target-scoped review Decision must contain only its exact target");
    }
  }
  for (const target of review.scope.targets) {
    requireTarget(db, request.projectId, configRevision, target.repoTargetId);
    const workItem = asRow<WorkItemRow>(
      db.prepare("SELECT * FROM work_items WHERE project_id = ? AND work_item_id = ?").get(request.projectId, target.workItemId),
    );
    if (!workItem) throw refusal("WORK_ITEM_UNKNOWN", "review Decision WorkItem is not known");
    if (workItem.config_revision !== configRevision || workItem.repo_target_id !== target.repoTargetId) {
      throw refusal("WORK_ITEM_FOREIGN", "review Decision WorkItem does not match its exact config and target");
    }
  }
}

function storedDecisionIdentityDigest(decision: DecisionRow): string | null {
  if (!decision.decision_class || !decision.options_json) return null;
  try {
    return sha256(canonicalJson({
      projectId: decision.project_id,
      configRevision: decision.config_revision,
      repoTargetId: decision.repo_target_id,
      scope: JSON.parse(decision.scope_json),
      decisionClass: decision.decision_class,
      options: JSON.parse(decision.options_json),
    }));
  } catch {
    return null;
  }
}

function requireDecisionActor(db: SqliteDatabase, request: ApplyRequest, decisionClass: string): string {
  const actorReceiptId = requireActor(db, request);
  const actor = asRow<{ actor_kind: string; role_id: string | null }>(
    db.prepare("SELECT actor_kind, role_id FROM actor_receipts WHERE project_id = ? AND receipt_id = ?").get(request.projectId, actorReceiptId),
  );
  if (!actor || !["role", "operator"].includes(actor.actor_kind)) {
    throw refusal("ACTOR_RECEIPT_UNVERIFIED", "decision authority requires a role or operator actor receipt");
  }
  if (actor.actor_kind === "operator") return actorReceiptId;
  requireRoleActorBinding(db, request);
  const requiredRole = decisionClass === "operator_only" ? null : "project-orchestrator";
  if (!requiredRole || actor.role_id !== requiredRole) {
    throw refusal("ROLE_HOLDER_MISMATCH", "decision class is not authorized by this current role");
  }
  return actorReceiptId;
}

function applyDecisionCreate(db: SqliteDatabase, request: ApplyRequest, digest: string): FoundationResult {
  const currentRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const decision = request.decision;
  if (!decision) throw refusal("INVALID_INPUT", "decision_create requires immutable decision identity");
  if (decision.resourceRevision !== 1) throw refusal("DECISION_IDENTITY_CONFLICT", "new decisions begin at resource revision 1");
  if (decision.repoTargetId === null) {
    if (request.repoTargetId) throw refusal("REPO_TARGET_FOREIGN", "project-scoped decision cannot accept a repository target");
  } else {
    if (request.repoTargetId !== decision.repoTargetId) throw refusal("REPO_TARGET_FOREIGN", "decision target does not match the exact request target");
    requireTarget(db, request.projectId, currentRevision, decision.repoTargetId);
  }
  const identity = decisionIdentity(request.projectId, currentRevision, decision);
  validateReviewDecisionCreate(db, request, decision, identity, currentRevision);
  const actorReceiptId = requireDecisionActor(db, request, identity.decisionClass);
  const existing = asRow<DecisionRow>(db.prepare("SELECT * FROM decisions WHERE decision_id = ?").get(decision.decisionId));
  if (existing) {
    if (existing.project_id !== request.projectId || existing.decision_identity_digest !== identity.identityDigest) {
      throw refusal("DECISION_IDENTITY_CONFLICT", "decision id is already bound to another immutable identity");
    }
    throw refusal("DECISION_IDENTITY_CONFLICT", "decision identity already exists under another idempotency request");
  }
  db.prepare(
    `INSERT INTO decisions
      (decision_id, project_id, config_revision, repo_target_id, scope_json, scope_digest,
       current_resource_revision, decision_class, options_json, decision_identity_digest)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    decision.decisionId,
    request.projectId,
    currentRevision,
    decision.repoTargetId,
    identity.scopeJson,
    sha256(identity.scopeJson),
    identity.decisionClass,
    identity.optionsJson,
    identity.identityDigest,
  );
  return commitMutation(
    db,
    request,
    digest,
    actorReceiptId,
    {
      aggregateType: "decision",
      aggregateId: decision.decisionId,
      aggregateRevision: 1,
      eventType: "decision_created",
      event: { decisionId: decision.decisionId, decisionClass: identity.decisionClass, decisionIdentityDigest: identity.identityDigest },
    },
    { expected: 1, attempted: 1, verified: 1 },
    {
      currentConfigRevision: currentRevision,
      currentGovernanceEpoch: governor.governance_epoch,
      currentResourceRevision: 1,
      evidence: { decisionId: decision.decisionId, decisionClass: identity.decisionClass, decisionIdentityDigest: identity.identityDigest },
    },
  );
}

interface PreparedDecisionEvidence {
  input: DecisionEvidenceInput;
  redactedJson: string;
  redactedDigest: string;
  durableRefJson: string;
  relationJson: string;
  artifactIdentityDigest: string;
  exists: boolean;
}

function validateDelegatedDecisionEvidence(
  db: SqliteDatabase,
  request: ApplyRequest,
  governorEpoch: number,
  decisionClass: string,
  evidence: DecisionEvidenceInput,
): void {
  if (!evidence.executionAttemptId) throw refusal("EVIDENCE_REQUIRED", "delegated evidence requires an execution attempt");
  const attempt = asRow<Record<string, string | number | null>>(
    db.prepare("SELECT * FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ?").get(request.projectId, evidence.executionAttemptId),
  );
  if (!attempt) throw refusal("RESOURCE_UNKNOWN", "delegated execution attempt is not known in this project");
  if (attempt.state === "dispatch_unknown") throw refusal("DISPATCH_UNKNOWN", "delegated execution remains dispatch-ambiguous");
  if (attempt.conflicting_terminal_digest !== null) throw refusal("TERMINAL_REPORT_AMBIGUOUS", "delegated terminal evidence is conflicting");
  if (attempt.origin !== "assignment" || !attempt.assignment_id) {
    throw refusal("EXECUTION_CONTEXT_FOREIGN", "evidence does not name an assignment-origin execution attempt");
  }
  if (evidence.assignmentId && evidence.assignmentId !== attempt.assignment_id) {
    throw refusal("EXECUTION_CONTEXT_FOREIGN", "evidence assignment identity does not match the execution attempt");
  }
  const assignment = asRow<Record<string, string | number | null>>(
    db.prepare("SELECT * FROM assignments WHERE project_id = ? AND assignment_id = ?").get(request.projectId, attempt.assignment_id),
  );
  if (!assignment || attempt.assignment_digest !== assignment.assignment_digest) {
    throw refusal("EXECUTION_CONTEXT_FOREIGN", "delegated attempt does not bind its immutable Assignment");
  }
  if (decisionClass === "review_adjudication" && (assignment.assignment_kind !== "review" || attempt.assignment_kind !== "review")) {
    throw refusal("EXECUTION_CONTEXT_FOREIGN", "review adjudication requires an exact review Assignment attempt");
  }
  const configRevision = currentConfig(db, request.projectId)?.config_revision;
  if (
    configRevision !== assignment.config_revision || assignment.config_revision !== attempt.config_revision ||
    governorEpoch !== assignment.governance_epoch || assignment.governance_epoch !== attempt.governance_epoch
  ) {
    throw refusal("ASSIGNMENT_HEAD_STALE", "delegated assignment config or governorship is stale");
  }
  const workItem = asRow<{ resource_revision: number; repo_target_id: string }>(
    db.prepare("SELECT resource_revision, repo_target_id FROM work_items WHERE project_id = ? AND work_item_id = ?").get(request.projectId, assignment.work_item_id),
  );
  if (!workItem || workItem.resource_revision !== assignment.work_item_revision) {
    throw refusal("ASSIGNMENT_HEAD_STALE", "delegated Assignment WorkItem revision is stale");
  }
  const target = asRow<{ source_id: string; host_id: string; path: string }>(
    db.prepare("SELECT source_id, host_id, path FROM repository_targets WHERE project_id = ? AND repo_target_id = ? AND config_revision = ?").get(
      request.projectId,
      assignment.repo_target_id,
      assignment.config_revision,
    ),
  );
  if (
    !target || workItem.repo_target_id !== assignment.repo_target_id || attempt.repo_target_id !== assignment.repo_target_id ||
    target.source_id !== assignment.source_id || target.host_id !== assignment.host_id || target.path !== assignment.environment_path ||
    attempt.environment_id !== assignment.environment_id || attempt.source_id !== assignment.source_id ||
    attempt.host_id !== assignment.host_id || attempt.environment_path !== assignment.environment_path ||
    attempt.branch_name !== assignment.branch_name || attempt.base_sha !== assignment.base_sha ||
    attempt.frozen_brief_digest !== assignment.frozen_brief_digest || attempt.content_receipt_digest !== assignment.frozen_brief_digest ||
    attempt.role_id !== assignment.role_id || attempt.role_generation !== assignment.role_generation
  ) {
    throw refusal("EXECUTION_CONTEXT_FOREIGN", "delegated attempt no longer matches its exact Assignment context");
  }
  if (assignment.candidate_semantics === "frozen" && attempt.candidate_sha !== assignment.candidate_sha) {
    throw refusal("ASSIGNMENT_HEAD_STALE", "delegated frozen candidate does not match its Assignment");
  }
  if (attempt.state !== "done" || attempt.terminal_result !== "DONE" || attempt.reported_outcome !== "DONE" ||
      !attempt.terminal_report_digest || !attempt.terminal_event_id || !attempt.native_receipt_digest || !attempt.actual_profile_digest) {
    throw refusal("TERMINAL_REPORT_REQUIRED", "delegated evidence is not one exact successful terminal attempt");
  }
  if (evidence.contentDigest !== attempt.terminal_report_digest || evidence.terminalReportDigest !== attempt.terminal_report_digest) {
    throw refusal("EXECUTION_CONTEXT_FOREIGN", "delegated terminal digest does not match canonical evidence");
  }
  if (evidence.actualProfileDigest !== attempt.actual_profile_digest) {
    throw refusal("EXECUTION_PROFILE_MISMATCH", "delegated actual profile digest does not match canonical evidence");
  }
  if (evidence.nativeReceiptDigest !== attempt.native_receipt_digest) {
    throw refusal("EXECUTION_CONTEXT_FOREIGN", "delegated native receipt digest does not match canonical evidence");
  }
}

function prepareDecisionEvidence(
  db: SqliteDatabase,
  request: ApplyRequest,
  governorEpoch: number,
  decisionClass: string,
): PreparedDecisionEvidence[] {
  const inputs = request.decisionEvidence ?? [];
  if (new Set(inputs.map((item) => item.evidenceId)).size !== inputs.length) {
    throw refusal("EVIDENCE_IDENTITY_CONFLICT", "one disposition cannot repeat an evidence identity");
  }
  return inputs.map((input) => {
    const delegated = input.evidenceKind === "delegated_action_receipt";
    const validPair = delegated
      ? input.sourceKind === "delegated_action" && input.relationKind === "delegated_action_receipt" && input.executionAttemptId !== null
      : input.evidenceKind === "advisory_read"
        ? ["helper", "pro"].includes(input.sourceKind) && input.relationKind === "advisory_read" && input.executionAttemptId === null
        : input.evidenceKind === "legacy_claim"
          ? input.sourceKind === "legacy_claim" && input.relationKind === "legacy_claim" && input.executionAttemptId === null
          : input.sourceKind === input.evidenceKind && input.relationKind === "supporting" && input.executionAttemptId === null;
    if (!validPair) throw refusal("EVIDENCE_REDACTION_INVALID", "evidence kind, source, relation, and execution binding are inconsistent");
    const redacted = parseCanonicalEvidenceJson(input.redactedJson, "evidence redacted metadata");
    const durable = parseCanonicalEvidenceJson(input.durableRefJson, "evidence durable reference");
    const relationJson = boundedCanonicalObject(input.relation ?? {}, "evidence relation");
    assertRedactedEvidence(JSON.parse(relationJson), "evidence relation");
    if (delegated) validateDelegatedDecisionEvidence(db, request, governorEpoch, decisionClass, input);
    const redactedDigest = sha256(redacted.json);
    const artifactIdentityDigest = sha256(canonicalJson({
      projectId: request.projectId,
      evidenceId: input.evidenceId,
      evidenceKind: input.evidenceKind,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      executionAttemptId: input.executionAttemptId,
      contentDigest: input.contentDigest,
      redactedDigest,
      durableRef: durable.value,
    }));
    const existing = asRow<{ artifact_identity_digest: string }>(
      db.prepare("SELECT artifact_identity_digest FROM evidence_artifacts WHERE project_id = ? AND evidence_id = ?").get(request.projectId, input.evidenceId),
    );
    if (existing && existing.artifact_identity_digest !== artifactIdentityDigest) {
      throw refusal("EVIDENCE_IDENTITY_CONFLICT", "evidence id is already bound to another immutable digest bundle");
    }
    return {
      input,
      redactedJson: redacted.json,
      redactedDigest,
      durableRefJson: durable.json,
      relationJson,
      artifactIdentityDigest,
      exists: Boolean(existing),
    };
  });
}

function dispositionReference(
  db: SqliteDatabase,
  decisionId: string,
  sequence: number | null | undefined,
): Record<string, unknown> | null {
  if (sequence === null || sequence === undefined) return null;
  return asRow<Record<string, unknown>>(
    db.prepare("SELECT * FROM decision_dispositions WHERE decision_id = ? AND disposition_sequence = ?").get(decisionId, sequence),
  ) ?? null;
}

interface ReviewRelationRecord {
  evidenceId: string;
  evidenceKind: string;
  sourceKind: string;
  relationKind: string;
  assignmentId: string | null;
  executionAttemptId: string | null;
  relation: unknown;
  current: boolean;
}

interface PreparedReviewInspection {
  assignment: AssignmentRow;
  attempt: ExecutionAttemptRow;
  writer: AssignmentRow;
  writerAttempt: ExecutionAttemptRow;
  target: ReviewTarget;
  relation: z.infer<typeof finalReviewRelationSchema>;
  expectedCandidateSha: string;
  expectedTreeDigest: string;
}

function reviewRelationRecords(db: SqliteDatabase, request: ApplyRequest, decisionId: string): ReviewRelationRecord[] {
  const stored = db.prepare(
    `SELECT decision_evidence.evidence_id, decision_evidence.relation_kind,
            decision_evidence.relation_json, evidence_artifacts.evidence_kind,
            evidence_artifacts.source_kind, evidence_artifacts.execution_attempt_id,
            execution_attempts.assignment_id
     FROM decision_evidence JOIN evidence_artifacts
       ON evidence_artifacts.project_id = decision_evidence.project_id
      AND evidence_artifacts.evidence_id = decision_evidence.evidence_id
     LEFT JOIN execution_attempts
       ON execution_attempts.project_id = evidence_artifacts.project_id
      AND execution_attempts.execution_attempt_id = evidence_artifacts.execution_attempt_id
     WHERE decision_evidence.project_id = ? AND decision_evidence.decision_id = ?
     ORDER BY decision_evidence.evidence_sequence`,
  ).all(request.projectId, decisionId) as Array<Record<string, string | null>>;
  const prior = stored.map((row) => ({
    evidenceId: row.evidence_id!,
    evidenceKind: row.evidence_kind!,
    sourceKind: row.source_kind!,
    relationKind: row.relation_kind!,
    assignmentId: row.assignment_id ?? null,
    executionAttemptId: row.execution_attempt_id ?? null,
    relation: JSON.parse(row.relation_json!),
    current: false,
  }));
  const current = (request.decisionEvidence ?? []).map((evidence) => ({
    evidenceId: evidence.evidenceId,
    evidenceKind: evidence.evidenceKind,
    sourceKind: evidence.sourceKind,
    relationKind: evidence.relationKind,
    assignmentId: evidence.assignmentId ?? null,
    executionAttemptId: evidence.executionAttemptId,
    relation: evidence.relation ?? {},
    current: true,
  }));
  return [...prior, ...current];
}

function reviewTargetKey(target: Pick<ReviewTarget, "workItemId" | "repoTargetId">): string {
  return `${target.workItemId}\u0000${target.repoTargetId}`;
}

function requireReviewAssignment(
  db: SqliteDatabase,
  request: ApplyRequest,
  assignmentId: string | null,
  executionAttemptId: string | null,
): { assignment: AssignmentRow; attempt: ExecutionAttemptRow } {
  if (!assignmentId || !executionAttemptId) throw refusal("EVIDENCE_REQUIRED", "final review evidence requires exact Assignment and attempt identities");
  return assignmentRows(db, { ...request, assignmentId, executionAttemptId });
}

function requireSuccessfulWrite(
  db: SqliteDatabase,
  request: ApplyRequest,
  target: ReviewTarget,
  assignmentId: string,
  executionAttemptId: string,
  candidateSha: string,
): { assignment: AssignmentRow; attempt: ExecutionAttemptRow } {
  const rows = assignmentRows(db, { ...request, assignmentId, executionAttemptId });
  if (
    rows.assignment.assignment_kind !== "write" || rows.attempt.assignment_kind !== "write" ||
    rows.assignment.work_item_id !== target.workItemId || rows.assignment.repo_target_id !== target.repoTargetId ||
    rows.assignment.config_revision !== target.configRevision || rows.assignment.base_sha !== target.baseSha ||
    rows.attempt.branch_name !== rows.assignment.branch_name || rows.attempt.base_sha !== target.baseSha ||
    rows.attempt.candidate_sha !== candidateSha || rows.attempt.state !== "done" ||
    rows.attempt.terminal_result !== "DONE" || rows.attempt.reported_outcome !== "DONE"
  ) {
    throw refusal("ASSIGNMENT_HEAD_STALE", "write facts do not bind the exact successful base-to-candidate Assignment range");
  }
  revalidateAssignmentReference(db, request, rows.assignment, rows.attempt);
  return rows;
}

function validateAmendmentRelation(
  db: SqliteDatabase,
  request: ApplyRequest,
  target: ReviewTarget,
  amendment: z.infer<typeof amendmentReviewRelationSchema>,
): void {
  if (
    amendment.workItemId !== target.workItemId || amendment.repoTargetId !== target.repoTargetId ||
    amendment.baseSha !== target.baseSha || amendment.h0CandidateSha !== target.h0CandidateSha ||
    amendment.h0TreeDigest !== target.h0TreeDigest || amendment.h1CandidateSha === target.h0CandidateSha ||
    amendment.h1TreeDigest === target.h0TreeDigest
  ) {
    throw refusal("REVIEW_SCOPE_MISMATCH", "review amendment does not preserve the exact H0 scope and base");
  }
  if (amendment.actualChangedFiles.some((file) => !amendment.allowedChangedFiles.includes(file))) {
    throw refusal("REVIEW_SCOPE_MISMATCH", "review amendment changes files outside the adopted findings scope");
  }
  const exactReview = (assignmentId: string, candidateSha: string): AssignmentRow => {
    const assignment = asRow<AssignmentRow>(db.prepare(
      "SELECT * FROM assignments WHERE project_id = ? AND assignment_id = ?",
    ).get(request.projectId, assignmentId));
    const attempt = asRow<ExecutionAttemptRow>(db.prepare(
      `SELECT * FROM execution_attempts
       WHERE project_id = ? AND assignment_id = ? AND candidate_sha = ?
         AND state = 'done' AND terminal_result = 'DONE' AND reported_outcome = 'DONE'`,
    ).get(request.projectId, assignmentId, candidateSha));
    if (
      !assignment || !attempt || assignment.assignment_kind !== "review" || assignment.candidate_semantics !== "frozen" ||
      assignment.work_item_id !== target.workItemId || assignment.repo_target_id !== target.repoTargetId ||
      assignment.config_revision !== target.configRevision || assignment.base_sha !== target.baseSha ||
      assignment.candidate_sha !== candidateSha || attempt.assignment_id !== assignment.assignment_id
    ) {
      throw refusal("ASSIGNMENT_HEAD_STALE", "review amendment does not bind exact successful H0 and H1 review Assignments");
    }
    revalidateAssignmentReference(db, request, assignment, attempt);
    return assignment;
  };
  const h0 = exactReview(amendment.h0AssignmentId, amendment.h0CandidateSha);
  const h1 = exactReview(amendment.h1AssignmentId, amendment.h1CandidateSha);
  if (h0.governance_epoch !== h1.governance_epoch || h0.work_item_revision !== h1.work_item_revision) {
    throw refusal("ASSIGNMENT_HEAD_STALE", "review amendment changed governorship or WorkItem revision");
  }
}

function preflightReviewDisposition(
  db: SqliteDatabase,
  request: ApplyRequest,
  factsByWriter: ReadonlyMap<string, ReviewFacts> | null,
): PreparedReviewInspection[] {
  const configRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const decisionId = request.decisionId;
  if (!decisionId || !request.disposition) throw refusal("INVALID_INPUT", "decision disposition requires decisionId and disposition");
  const decision = asRow<DecisionRow>(db.prepare("SELECT * FROM decisions WHERE decision_id = ?").get(decisionId));
  if (!decision || decision.project_id !== request.projectId || decision.decision_class !== "review_adjudication" || !decision.options_json) {
    throw refusal("RESOURCE_UNKNOWN", "review Decision is not known in this project");
  }
  requireDecisionActor(db, request, "review_adjudication");
  if (decision.config_revision !== configRevision) throw refusal("PROJECT_CONFIG_STALE", "review Decision config revision is stale");
  if (request.expectedResourceRevision !== decision.current_resource_revision) {
    throw refusal("RESOURCE_REVISION_STALE", "review Decision resource revision is stale", {
      currentResourceRevision: decision.current_resource_revision,
      expectedResourceRevision: request.expectedResourceRevision ?? undefined,
    });
  }
  if (decision.repo_target_id) {
    if (!request.repoTargetId) throw refusal("REPO_TARGET_REQUIRED", "review Decision requires its exact target");
    if (request.repoTargetId !== decision.repo_target_id) throw refusal("REPO_TARGET_FOREIGN", "review Decision target is foreign");
  } else if (request.repoTargetId) {
    throw refusal("REPO_TARGET_FOREIGN", "project-scoped review Decision cannot infer one request target");
  }
  const review = parseReviewIdentity(decision.scope_json, decision.options_json, configRevision);
  const policy = reviewPolicyFromJson(storedConfigJson(db, request.projectId, configRevision));
  if (!policy || review.options.connectors.length !== new Set(review.scope.targets.map((target) => target.repoTargetId)).size || review.options.connectors.some((option) =>
    !policy.connectors.some((connector) => canonicalJson(connector) === canonicalJson(option))
  )) {
    throw refusal("PROJECT_CONFIG_STALE", "review Decision connector mappings no longer match their config revision");
  }
  for (const target of review.scope.targets) {
    requireTarget(db, request.projectId, configRevision, target.repoTargetId);
    const workItem = asRow<WorkItemRow>(db.prepare("SELECT * FROM work_items WHERE project_id = ? AND work_item_id = ?").get(request.projectId, target.workItemId));
    if (!workItem || workItem.config_revision !== configRevision || workItem.repo_target_id !== target.repoTargetId) {
      throw refusal("WORK_ITEM_FOREIGN", "review scope WorkItem does not match the exact current target");
    }
  }
  const relations = reviewRelationRecords(db, request, decisionId);
  const suppliedConnectorRecords = relations.filter((record) => record.current && record.evidenceKind === "connector");
  if (suppliedConnectorRecords.some((record) => {
    const relation = connectorReviewRelationSchema.safeParse(record.relation);
    const option = relation.success
      ? review.options.connectors.find((connector) => connector.repoTargetId === relation.data.repoTargetId && connector.connectorId === relation.data.connectorId)
      : undefined;
    return !option || option.policy === "prohibited";
  })) {
    throw refusal("INVALID_INPUT", "prohibited or unmapped connector material is not accepted");
  }
  if (request.disposition !== "adopted") return [];

  const connectorRecords = relations.filter((record) => record.evidenceKind === "connector");
  const connectors = connectorRecords.map((record) => {
    if (record.evidenceKind !== "connector" || record.sourceKind !== "connector" || record.relationKind !== "supporting") {
      throw refusal("INVALID_INPUT", "connector evidence kind and relation are inconsistent");
    }
    const parsed = connectorReviewRelationSchema.safeParse(record.relation);
    if (!parsed.success) throw refusal("INVALID_INPUT", parsed.error.message);
    const target = review.scope.targets.find((candidate) => reviewTargetKey(candidate) === reviewTargetKey(parsed.data));
    const option = review.options.connectors.find((connector) =>
      connector.repoTargetId === parsed.data.repoTargetId && connector.connectorId === parsed.data.connectorId
    );
    if (
      !target || !option || option.policy === "prohibited" || parsed.data.h0CandidateSha !== target.h0CandidateSha ||
      parsed.data.h0TreeDigest !== target.h0TreeDigest
    ) {
      throw refusal("INVALID_INPUT", "connector evidence is not bound to the exact H0 target and configured identity");
    }
    return { record, relation: parsed.data, target };
  });
  for (const target of review.scope.targets) {
    const matches = connectors.filter((candidate) => reviewTargetKey(candidate.target) === reviewTargetKey(target));
    if (matches.length > 1) throw refusal("INVALID_INPUT", "review generation permits only one connector pass per target");
    const option = review.options.connectors.find((connector) => connector.repoTargetId === target.repoTargetId)!;
    if (option.policy === "required" && (matches.length !== 1 || matches[0]!.relation.state !== "available" || !matches[0]!.relation.terminal)) {
      throw refusal("EXTERNAL_CAPABILITY_REQUIRED", "required connector lacks exact available terminal H0 evidence");
    }
  }

  const amendmentRecords = relations.filter((record) => (record.relation as { relationRole?: unknown }).relationRole === "amendment_scope");
  if (amendmentRecords.length > 1) {
    throw refusal("REVIEW_AMENDMENT_CAP", "review Decision already consumed its one bounded amendment");
  }
  const amendmentByTarget = new Map<string, z.infer<typeof amendmentReviewRelationSchema>>();
  for (const record of amendmentRecords) {
    if (record.evidenceKind !== "review_ready" || record.sourceKind !== "review_ready" || record.relationKind !== "supporting") {
      throw refusal("EVIDENCE_REDACTION_INVALID", "amendment scope requires review_ready supporting evidence");
    }
    const parsed = amendmentReviewRelationSchema.safeParse(record.relation);
    if (!parsed.success) throw refusal("REVIEW_SCOPE_MISMATCH", parsed.error.message);
    const target = review.scope.targets.find((candidate) => reviewTargetKey(candidate) === reviewTargetKey(parsed.data));
    if (!target || amendmentByTarget.has(reviewTargetKey(target))) throw refusal("REVIEW_AMENDMENT_CAP", "review target has more than one amendment relation");
    validateAmendmentRelation(db, request, target, parsed.data);
    amendmentByTarget.set(reviewTargetKey(target), parsed.data);
  }

  const finalRecords = relations.filter((record) => record.current && (record.relation as { relationRole?: unknown }).relationRole === "final_review");
  const requiredEvidence = new Set((request.conditions ?? []).flatMap((condition) => condition.evidenceIds));
  const prepared: PreparedReviewInspection[] = [];
  for (const target of review.scope.targets) {
    const matches = finalRecords.filter((record) => {
      const parsed = finalReviewRelationSchema.safeParse(record.relation);
      return parsed.success && reviewTargetKey(parsed.data) === reviewTargetKey(target);
    });
    if (matches.length !== 1) throw refusal("EVIDENCE_REQUIRED", "adopted review requires one exact final review receipt per target");
    const record = matches[0]!;
    if (
      record.evidenceKind !== "delegated_action_receipt" || record.sourceKind !== "delegated_action" ||
      record.relationKind !== "delegated_action_receipt" || !requiredEvidence.has(record.evidenceId)
    ) {
      throw refusal("EVIDENCE_REQUIRED", "final review receipt must be a typed required delegated condition");
    }
    const relation = finalReviewRelationSchema.parse(record.relation);
    const amendment = amendmentByTarget.get(reviewTargetKey(target)) ?? null;
    const expectedCandidateSha = amendment?.h1CandidateSha ?? target.h0CandidateSha;
    const expectedTreeDigest = amendment?.h1TreeDigest ?? target.h0TreeDigest;
    if (
      relation.configRevision !== target.configRevision || relation.baseSha !== target.baseSha ||
      relation.candidateSha !== expectedCandidateSha || relation.treeDigest !== expectedTreeDigest ||
      canonicalJson(relation.tierAEntries) !== canonicalJson(target.tierAEntries) ||
      (amendment && canonicalJson(relation.changedFiles) !== canonicalJson(amendment.actualChangedFiles))
    ) {
      throw refusal("REVIEW_SCOPE_MISMATCH", "final review relation does not match the exact frozen target and amendment scope");
    }
    const evidenceInput = (request.decisionEvidence ?? []).find((evidence) => evidence.evidenceId === record.evidenceId)!;
    validateDelegatedDecisionEvidence(db, request, governor.governance_epoch, "review_adjudication", evidenceInput);
    const rows = requireReviewAssignment(db, request, record.assignmentId, record.executionAttemptId);
    revalidateAssignmentReference(db, request, rows.assignment, rows.attempt);
    if (
      rows.assignment.assignment_kind !== "review" || rows.assignment.role_id !== "independent-reviewer" ||
      rows.assignment.candidate_semantics !== "frozen" || rows.assignment.work_item_id !== target.workItemId ||
      rows.assignment.repo_target_id !== target.repoTargetId || rows.assignment.config_revision !== target.configRevision ||
      rows.assignment.base_sha !== target.baseSha || rows.assignment.candidate_sha !== expectedCandidateSha ||
      rows.assignment.requested_permission_mode !== "full" || rows.assignment.requested_visibility !== "visible" ||
      rows.attempt.actual_permission_mode !== "full" || rows.attempt.actual_visibility !== "visible"
    ) {
      throw refusal("ASSIGNMENT_HEAD_STALE", "final review Assignment is not the exact visible/full frozen target");
    }
    requireCanonicalRoleGeneration(db, request.projectId, rows.assignment.role_id, rows.assignment.role_generation, rows.assignment.role_requirement_id);
    if (amendment && rows.assignment.assignment_id !== amendment.h1AssignmentId) {
      throw refusal("REVIEW_SCOPE_MISMATCH", "final review does not bind the exact H1 review Assignment");
    }
    const writer = requireSuccessfulWrite(
      db, request, target, relation.writeAssignmentId, relation.writeExecutionAttemptId, expectedCandidateSha,
    );
    const writers = db.prepare(
      `SELECT assignments.assignment_id, assignments.lane_id, assignments.role_id, assignments.role_generation,
              execution_attempts.execution_attempt_id
       FROM assignments JOIN execution_attempts
         ON execution_attempts.project_id = assignments.project_id
        AND execution_attempts.assignment_id = assignments.assignment_id
       WHERE assignments.project_id = ? AND assignments.work_item_id = ?
         AND assignments.repo_target_id = ? AND assignments.assignment_kind = 'write'`,
    ).all(request.projectId, target.workItemId, target.repoTargetId) as Array<{
      assignment_id: string; lane_id: string; role_id: string; role_generation: number; execution_attempt_id: string;
    }>;
    if (writers.length === 0) throw refusal("EVIDENCE_REQUIRED", "review target has no exact recorded write Assignment");
    if (writers.some((candidate) =>
      candidate.assignment_id === rows.assignment.assignment_id || candidate.execution_attempt_id === rows.attempt.execution_attempt_id ||
      candidate.lane_id === rows.assignment.lane_id || candidate.role_id === rows.assignment.role_id ||
      candidate.role_generation === rows.assignment.role_generation
    )) {
      throw refusal("ROLE_HOLDER_MISMATCH", "review Assignment is not structurally independent from every write Assignment");
    }
    prepared.push({ assignment: rows.assignment, attempt: rows.attempt, writer: writer.assignment, writerAttempt: writer.attempt, target, relation, expectedCandidateSha, expectedTreeDigest });
  }
  if (!factsByWriter) return prepared;

  for (const item of prepared) {
    const parsedFacts = reviewFactsSchema.safeParse(factsByWriter.get(item.writer.assignment_id));
    if (!parsedFacts.success) throw refusal("BB_FACTS_UNAVAILABLE", "bounded exact review tree, diff, and authorship facts are unavailable");
    const facts = parsedFacts.data;
    if (
      facts.projectId !== request.projectId ||
      facts.workItemId !== item.target.workItemId || facts.repoTargetId !== item.target.repoTargetId ||
      facts.writeAssignmentId !== item.writer.assignment_id || facts.writeExecutionAttemptId !== item.writerAttempt.execution_attempt_id ||
      facts.branchName !== item.writer.branch_name ||
      facts.baseSha !== item.target.baseSha || facts.candidateSha !== item.expectedCandidateSha ||
      facts.treeDigest !== item.expectedTreeDigest || canonicalJson(facts.changedFiles) !== canonicalJson(item.relation.changedFiles) ||
      canonicalJson(facts.authors) !== canonicalJson(item.relation.authors) ||
      canonicalJson(facts.committers) !== canonicalJson(item.relation.committers) ||
      !sortedIdSetSchema.safeParse(facts.changedFiles).success || facts.authors.length === 0 || facts.committers.length === 0
    ) {
      throw refusal("ASSIGNMENT_HEAD_STALE", "bounded review facts do not match the exact writer range, tree, diff, and Git evidence");
    }
  }
  return prepared;
}

function applyDecisionMutation(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  reader: ReviewFactReader | null,
): FoundationResult {
  try {
    const replay = checkIdempotency(db, request, digest);
    if (replay) return replay;
    const decision = request.decisionId
      ? asRow<DecisionRow>(db.prepare("SELECT * FROM decisions WHERE decision_id = ?").get(request.decisionId))
      : undefined;
    if (decision?.decision_class !== "review_adjudication") {
      return transaction(db, () => {
        const replayInTransaction = checkIdempotency(db, request, digest);
        return replayInTransaction ?? applyDecisionDisposition(db, request, digest);
      });
    }
    const prepared = preflightReviewDisposition(db, request, null);
    if (request.disposition !== "adopted") {
      return transaction(db, () => {
        const replayInTransaction = checkIdempotency(db, request, digest);
        if (replayInTransaction) return replayInTransaction;
        preflightReviewDisposition(db, request, null);
        return applyDecisionDisposition(db, request, digest);
      });
    }
    if (!reader) throw refusal("BB_FACTS_UNAVAILABLE", "review adjudication requires the bounded exact review fact reader");
    const facts = new Map<string, ReviewFacts>();
    for (const item of prepared) {
      let value: ReviewFacts;
      try {
        value = reader.read({
          projectId: request.projectId,
          workItemId: item.target.workItemId,
          repoTargetId: item.target.repoTargetId,
          writeAssignmentId: item.writer.assignment_id,
          writeExecutionAttemptId: item.writerAttempt.execution_attempt_id,
          branchName: item.writer.branch_name,
          baseSha: item.target.baseSha,
          candidateSha: item.expectedCandidateSha,
        });
      } catch {
        throw refusal("BB_FACTS_UNAVAILABLE", "bounded exact review facts are unavailable");
      }
      facts.set(item.writer.assignment_id, value);
    }
    return transaction(db, () => {
      const replayInTransaction = checkIdempotency(db, request, digest);
      if (replayInTransaction) return replayInTransaction;
      preflightReviewDisposition(db, request, facts);
      return applyDecisionDisposition(db, request, digest);
    });
  } catch (error) {
    if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
    if (isConstraintError(error)) return unavailableResult(request.projectId, "canonical review disposition could not be committed unambiguously");
    return result("INTERNAL_ERROR", request.projectId, 1, 0, 0, { message: "internal decision mutation error" });
  }
}

function applyDecisionDisposition(db: SqliteDatabase, request: ApplyRequest, digest: string): FoundationResult {
  const currentRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const decisionId = request.decisionId;
  if (!decisionId || !request.disposition) throw refusal("INVALID_INPUT", "decision disposition requires decisionId and disposition");
  const decision = asRow<DecisionRow>(db.prepare("SELECT * FROM decisions WHERE decision_id = ?").get(decisionId));
  if (!decision || decision.project_id !== request.projectId) throw refusal("RESOURCE_UNKNOWN", "decision is not known in this project");
  if (
    !decision.decision_class || !(DECISION_CLASSES as readonly string[]).includes(decision.decision_class) ||
    !decision.options_json || !decision.decision_identity_digest ||
    storedDecisionIdentityDigest(decision) !== decision.decision_identity_digest
  ) {
    throw refusal("DECISION_IDENTITY_CONFLICT", "decision has no valid immutable typed identity");
  }
  const actorReceiptId = requireDecisionActor(db, request, decision.decision_class);
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
  const sequence = asRow<{ next_sequence: number }>(
    db.prepare("SELECT COALESCE(MAX(disposition_sequence), 0) + 1 AS next_sequence FROM decision_dispositions WHERE decision_id = ?").get(decisionId),
  )?.next_sequence ?? 1;
  const supersedes = request.supersedesDispositionSequence ?? null;
  const reverts = request.revertsDispositionSequence ?? null;
  if ((request.disposition === "superseded") !== (supersedes !== null) || (request.disposition === "revoked") !== (reverts !== null)) {
    throw refusal("DECISION_DISPOSITION_INVALID", "superseded and revoked dispositions require exactly their matching prior reference");
  }
  for (const [kind, reference] of [["supersedes", supersedes], ["reverts", reverts]] as const) {
    if (reference === null) continue;
    if (reference >= sequence || !dispositionReference(db, decisionId, reference)) {
      throw refusal("DECISION_REFERENCE_INVALID", `${kind} must name an earlier disposition on the same decision`);
    }
    if (db.prepare(`SELECT 1 FROM decision_dispositions WHERE decision_id = ? AND ${kind}_disposition_sequence = ?`).get(decisionId, reference)) {
      throw refusal("DECISION_REFERENCE_INVALID", `${kind} target was already consumed`);
    }
  }
  const holdAction = request.holdAction ?? "none";
  const holdCode = request.holdCode ?? null;
  const holdReference = request.holdReferenceSequence ?? null;
  if (
    (holdAction === "none" && (holdCode !== null || holdReference !== null)) ||
    (holdAction === "set" && (holdCode === null || holdReference !== null)) ||
    (holdAction === "clear" && (holdCode === null || holdReference === null))
  ) {
    throw refusal("DECISION_REFERENCE_INVALID", "hold set/clear fields are inconsistent");
  }
  if (holdAction === "clear") {
    const setter = dispositionReference(db, decisionId, holdReference);
    if (!setter || setter.hold_action !== "set" || setter.hold_code !== holdCode || holdReference! >= sequence ||
        db.prepare("SELECT 1 FROM decision_dispositions WHERE decision_id = ? AND hold_action = 'clear' AND hold_reference_sequence = ?").get(decisionId, holdReference)) {
      throw refusal("DECISION_REFERENCE_INVALID", "hold clear must name one active earlier setter for the same code");
    }
  }
  const preparedEvidence = prepareDecisionEvidence(db, request, governor.governance_epoch, decision.decision_class);
  const evidenceIds = new Set(preparedEvidence.map((item) => item.input.evidenceId));
  const conditions = request.conditions ?? [];
  for (const condition of conditions) {
    if (condition.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId))) {
      throw refusal("EVIDENCE_REQUIRED", "every typed condition must name evidence bound to this exact disposition");
    }
  }
  if (request.disposition === "adopted") {
    const activeHolds = db.prepare(
      `SELECT setter.disposition_sequence FROM decision_dispositions setter
       WHERE setter.decision_id = ? AND setter.hold_action = 'set'
         AND NOT EXISTS (
           SELECT 1 FROM decision_dispositions clearer
           WHERE clearer.decision_id = setter.decision_id AND clearer.hold_action = 'clear'
             AND clearer.hold_reference_sequence = setter.disposition_sequence
         )`,
    ).all(decisionId) as Array<{ disposition_sequence: number }>;
    const remaining = activeHolds.filter((row) => !(holdAction === "clear" && row.disposition_sequence === holdReference));
    if (holdAction === "set" || remaining.length > 0) throw refusal("DECISION_DISPOSITION_INVALID", "active Decision holds block adoption");
  }
  const reasonJson = boundedCanonicalObject(request.reason ?? {}, "decision reason");
  assertRedactedEvidence(JSON.parse(reasonJson), "decision reason");
  const conditionsJson = canonicalJson(conditions);
  if (Buffer.byteLength(conditionsJson, "utf8") > 16 * 1024) throw refusal("EVIDENCE_REDACTION_INVALID", "decision conditions exceed 16 KiB");
  const nextRevision = decision.current_resource_revision + 1;
  const update = db.prepare(
    `UPDATE decisions SET current_resource_revision = ?
     WHERE decision_id = ? AND project_id = ? AND current_resource_revision = ?`,
  ).run(nextRevision, decisionId, request.projectId, expectedResourceRevision);
  if (update.changes !== 1) {
    throw refusal("RESOURCE_REVISION_STALE", "decision compare-and-swap failed", {
      currentResourceRevision: decision.current_resource_revision,
      expectedResourceRevision,
    });
  }
  const createdAtMs = now();
  db.prepare(
    `INSERT INTO decision_dispositions
      (decision_id, disposition_sequence, disposition, actor_receipt_id, reason_json, created_at_ms, idempotency_key,
       conditions_json, hold_action, hold_code, hold_reference_sequence,
       supersedes_disposition_sequence, reverts_disposition_sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    decisionId,
    sequence,
    request.disposition,
    actorReceiptId,
    reasonJson,
    createdAtMs,
    request.idempotencyKey,
    conditionsJson,
    holdAction,
    holdCode,
    holdReference,
    supersedes,
    reverts,
  );
  const insertArtifact = db.prepare(
    `INSERT INTO evidence_artifacts
      (project_id, evidence_id, evidence_kind, source_kind, source_ref, execution_attempt_id,
       content_digest, redacted_json, redacted_digest, durable_ref_json, artifact_identity_digest, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRelation = db.prepare(
    `INSERT INTO decision_evidence
      (project_id, decision_id, evidence_sequence, evidence_id, disposition_sequence,
       relation_kind, relation_json, created_at_ms, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let evidenceSequence = asRow<{ next_sequence: number }>(db.prepare(
    "SELECT COALESCE(MAX(evidence_sequence), 0) + 1 AS next_sequence FROM decision_evidence WHERE project_id = ? AND decision_id = ?",
  ).get(request.projectId, decisionId))?.next_sequence ?? 1;
  for (const prepared of preparedEvidence) {
    if (!prepared.exists) {
      insertArtifact.run(
        request.projectId,
        prepared.input.evidenceId,
        prepared.input.evidenceKind,
        prepared.input.sourceKind,
        prepared.input.sourceRef,
        prepared.input.executionAttemptId,
        prepared.input.contentDigest,
        prepared.redactedJson,
        prepared.redactedDigest,
        prepared.durableRefJson,
        prepared.artifactIdentityDigest,
        createdAtMs,
      );
    }
    insertRelation.run(
      request.projectId,
      decisionId,
      evidenceSequence++,
      prepared.input.evidenceId,
      sequence,
      prepared.input.relationKind,
      prepared.relationJson,
      createdAtMs,
      request.idempotencyKey,
    );
  }
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
      event: {
        decisionId,
        dispositionSequence: sequence,
        disposition: request.disposition,
        evidenceIds: preparedEvidence.map((item) => item.input.evidenceId),
      },
    },
    { expected: preparedEvidence.length + 1, attempted: preparedEvidence.length + 1, verified: preparedEvidence.length + 1 },
    {
      currentConfigRevision: currentRevision,
      currentGovernanceEpoch: governor.governance_epoch,
      currentResourceRevision: nextRevision,
      expectedResourceRevision,
      evidence: { dispositionSequence: sequence, evidenceIds: preparedEvidence.map((item) => item.input.evidenceId) },
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
  const generation = asRow<{
    status: string;
    role_requirement_id: string;
    config_revision: number;
    holder_execution_attempt_id: string;
    holder_context_digest: string;
    holder_executed_profile_digest: string;
    qualification_id: string;
    eligibility_derivation_digest: string;
  }>(
    db.prepare(`SELECT status, role_requirement_id, config_revision, holder_execution_attempt_id,
                       holder_context_digest, holder_executed_profile_digest, qualification_id,
                       eligibility_derivation_digest
                FROM role_generations WHERE project_id = ? AND role_id = ? AND generation = ?`).get(
      request.projectId,
      actor.role_id,
      actor.role_generation,
    ),
  );
  if (!head || head.current_generation !== actor.role_generation) throw refusal("ROLE_GENERATION_STALE", "role actor is not the current generation");
  if (!generation || generation.status !== "active") throw refusal("ROLE_NOT_ACTIVE", "role actor is not active");
  if (generation.holder_execution_attempt_id !== actor.subject_id) throw refusal("ROLE_HOLDER_MISMATCH", "role actor does not bind the current holder context");
  const attempt = asRow<{ origin: string; state: string; native_receipt_digest: string | null; actual_profile_digest: string | null }>(
    db.prepare("SELECT origin, state, native_receipt_digest, actual_profile_digest FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ?").get(
      request.projectId,
      generation.holder_execution_attempt_id,
    ),
  );
  if (
    !attempt ||
    attempt.origin !== "role_holder" ||
    attempt.state !== "done" ||
    attempt.native_receipt_digest !== generation.holder_context_digest ||
    attempt.actual_profile_digest !== generation.holder_executed_profile_digest
  ) {
    throw refusal("ROLE_HOLDER_MISMATCH", "role holder has no complete canonical execution attempt");
  }
  const eligibility = asRow<{
    current_qualification_id: string;
    effective_status: string;
    config_revision: number;
    expires_at_ms: number | null;
    derivation_digest: string;
  }>(db.prepare(
    `SELECT current_qualification_id, effective_status, config_revision, expires_at_ms, derivation_digest
     FROM eligibility_projections
     WHERE project_id = ? AND role_requirement_id = ? AND profile_digest = ?`,
  ).get(request.projectId, generation.role_requirement_id, generation.holder_executed_profile_digest));
  if (
    !eligibility || eligibility.current_qualification_id !== generation.qualification_id ||
    eligibility.effective_status !== "eligible" || eligibility.config_revision !== generation.config_revision ||
    eligibility.derivation_digest !== generation.eligibility_derivation_digest ||
    (eligibility.expires_at_ms !== null && eligibility.expires_at_ms <= now())
  ) {
    throw refusal("ROLE_UNQUALIFIED", "role actor no longer has current eligible qualification evidence");
  }
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

function materializeRoleHolderAttempt(
  db: SqliteDatabase,
  request: ApplyRequest,
  context: ResolvedRoleContext,
  resolved: ResolvedRoleRequirement,
  governanceEpoch: number,
  roleGeneration: number,
  holderContextDigest: string,
): void {
  const environment = context.baseContext.environment as { path: string; branchName: string | null };
  const attemptEvidence = {
    origin: "role_holder",
    projectId: request.projectId,
    executionAttemptId: context.holderExecutionAttemptId,
    configRevision: resolved.configRevision,
    governanceEpoch,
    repoTargetId: resolved.requirement.repoTargetId,
    roleId: resolved.requirement.roleId,
    bbServerId: context.bbServerId,
    threadId: context.threadId,
    environmentId: context.environmentId,
    sourceId: context.sourceId,
    hostId: context.hostId,
    providerThreadId: context.providerThreadId,
    nativeRequestId: context.nativeRequestId,
    requestEventId: context.requestEventId,
    requestEventSeq: context.requestEventSeq,
    acceptedEventId: context.acceptedEventId,
    acceptedEventSeq: context.acceptedEventSeq,
    startEventId: context.startEventId,
    startEventSeq: context.startEventSeq,
    completionEventId: context.completionEventId,
    completionEventSeq: context.completionEventSeq,
    actualProfileDigest: context.profileDigest,
    holderContextDigest,
  };
  const attemptDigest = sha256(canonicalJson(attemptEvidence));
  const existing = asRow<{ origin: string; state: string; attempt_digest: string; native_receipt_digest: string | null }>(
    db.prepare("SELECT origin, state, attempt_digest, native_receipt_digest FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ?").get(
      request.projectId,
      context.holderExecutionAttemptId,
    ),
  );
  if (existing) {
    if (existing.origin !== "role_holder" || existing.state !== "done" || existing.attempt_digest !== attemptDigest || existing.native_receipt_digest !== holderContextDigest) {
      throw refusal("ROLE_HOLDER_MISMATCH", "canonical role-holder attempt conflicts with the exact holder facts");
    }
    return;
  }
  const createdAtMs = now();
  db.prepare(
    `INSERT INTO execution_attempts (
      project_id, execution_attempt_id, assignment_id, origin, assignment_digest, lane_id,
      assignment_kind, attempt_ordinal, dispatch_kind, config_revision, governance_epoch,
      work_item_id, repo_target_id, role_id, role_generation, state, bb_server_id,
      environment_id, source_id, host_id, environment_path, thread_id, provider_thread_id,
      native_request_id, request_event_id, request_event_seq, accepted_event_id, accepted_event_seq,
      first_action_event_id, first_action_event_seq, completion_event_id, completion_event_seq,
      actual_provider_id, actual_model, actual_reasoning_level, actual_permission_mode,
      actual_service_tier, actual_visibility, actual_profile_digest, branch_name,
      environment_digest, native_receipt_digest, reason_code, last_event_seq,
      created_at_ms, observed_at_ms, completed_at_ms, attempt_digest
    ) VALUES (?, ?, NULL, 'role_holder', NULL, NULL, NULL, 1, NULL, ?, ?, NULL, ?, ?, ?,
      'done', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      'role_holder_observed', ?, ?, ?, ?, ?)`
  ).run(
    request.projectId,
    context.holderExecutionAttemptId,
    resolved.configRevision,
    governanceEpoch,
    resolved.requirement.repoTargetId,
    resolved.requirement.roleId,
    roleGeneration,
    context.bbServerId,
    context.environmentId,
    context.sourceId,
    context.hostId,
    environment.path,
    context.threadId,
    context.providerThreadId,
    context.nativeRequestId,
    context.requestEventId,
    context.requestEventSeq,
    context.acceptedEventId,
    context.acceptedEventSeq,
    context.startEventId,
    context.startEventSeq,
    context.completionEventId,
    context.completionEventSeq,
    context.profile.providerId,
    context.profile.model,
    context.profile.reasoningLevel,
    context.profile.permissionMode,
    context.profile.serviceTier,
    context.profile.visibility,
    context.profileDigest,
    environment.branchName,
    sha256(canonicalJson(context.baseContext.environment)),
    holderContextDigest,
    context.completionEventSeq,
    createdAtMs,
    createdAtMs,
    createdAtMs,
    attemptDigest,
  );
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
  materializeRoleHolderAttempt(
    db,
    request,
    context,
    resolved,
    governor.governance_epoch,
    nextGeneration,
    expectedContextDigest,
  );
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

type AssignmentIntent = z.infer<typeof assignmentIntentSchema>;
type TerminalReport = z.infer<typeof terminalReportSchema>;

interface AssignmentRow {
  project_id: string;
  assignment_id: string;
  work_item_id: string;
  assignment_kind: "write" | "review" | "probe";
  lane_id: string;
  role_requirement_id: string;
  role_id: (typeof ROLE_IDS)[number];
  role_generation: number;
  config_revision: number;
  governance_epoch: number;
  work_item_revision: number;
  repo_target_id: string;
  branch_name: string;
  base_sha: string;
  candidate_semantics: "base" | "frozen";
  candidate_sha: string | null;
  bb_server_id: string;
  environment_id: string;
  source_id: string;
  host_id: string;
  environment_path: string;
  environment_mode: "managed-worktree";
  frozen_brief_version: 1;
  frozen_brief_digest: string;
  requested_provider_id: string;
  requested_model: string;
  requested_reasoning_level: string;
  requested_permission_mode: string;
  requested_service_tier: string;
  requested_visibility: "visible";
  requested_profile_digest: string;
  dispatch_kind: "spawn" | "attach";
  attach_thread_id: string | null;
  parent_assignment_id: string | null;
  depth: 0;
  deadline_at_ms: number;
  assignment_digest: string;
}

interface ExecutionAttemptRow {
  project_id: string;
  execution_attempt_id: string;
  assignment_id: string | null;
  origin: "assignment" | "role_holder" | "legacy_unresolved";
  assignment_digest: string | null;
  lane_id: string | null;
  assignment_kind: "write" | "review" | "probe" | null;
  attempt_ordinal: number;
  dispatch_kind: "spawn" | "attach" | null;
  config_revision: number;
  governance_epoch: number;
  work_item_id: string | null;
  repo_target_id: string | null;
  role_id: string;
  role_generation: number;
  branch_name: string | null;
  base_sha: string | null;
  state: "prepared" | "armed" | "content_delivered" | "running" | "done" | "blocked" | "failed" | "dispatch_unknown";
  bb_server_id: string;
  environment_id: string;
  source_id: string;
  host_id: string;
  environment_path: string;
  thread_id: string | null;
  provider_thread_id: string | null;
  native_request_id: string | null;
  request_event_id: string | null;
  request_event_seq: number | null;
  accepted_event_id: string | null;
  accepted_event_seq: number | null;
  first_action_event_id: string | null;
  first_action_event_seq: number | null;
  content_event_id: string | null;
  content_event_seq: number | null;
  content_receipt_digest: string | null;
  frozen_brief_digest: string | null;
  environment_digest: string | null;
  actual_provider_id: string | null;
  actual_model: string | null;
  actual_reasoning_level: string | null;
  actual_permission_mode: string | null;
  actual_service_tier: string | null;
  actual_visibility: "visible" | "hidden" | null;
  native_receipt_digest: string | null;
  actual_profile_digest: string | null;
  candidate_sha: string | null;
  terminal_result: "DONE" | "BLOCKED" | null;
  reported_outcome: "DONE" | "BLOCKED" | null;
  terminal_report_digest: string | null;
  conflicting_terminal_digest: string | null;
  terminal_event_id: string | null;
  terminal_event_seq: number | null;
  completed_at_ms: number | null;
  reason_code: string | null;
  last_event_seq: number | null;
  attempt_digest: string;
}

const NATIVE_EVIDENCE_COLUMNS = [
  "thread_id", "provider_thread_id", "native_request_id",
  "request_event_id", "request_event_seq", "accepted_event_id", "accepted_event_seq",
  "first_action_event_id", "first_action_event_seq", "content_event_id", "content_event_seq",
  "content_receipt_digest", "actual_provider_id", "actual_model", "actual_reasoning_level",
  "actual_permission_mode", "actual_service_tier", "actual_visibility", "actual_profile_digest",
  "native_receipt_digest", "last_event_seq",
] as const;
type NativeEvidenceColumn = (typeof NATIVE_EVIDENCE_COLUMNS)[number];
type NativeEvidenceSnapshot = Record<NativeEvidenceColumn, string | number | null>;

const ACTIVE_ASSIGNMENT_STATES = ["prepared", "armed", "content_delivered", "running", "dispatch_unknown"] as const;
const ACTIVE_ASSIGNMENT_SQL = "('prepared','armed','content_delivered','running','dispatch_unknown')";

function requestedProfile(assignment: AssignmentRow): ExecutionProfile {
  return {
    providerId: assignment.requested_provider_id,
    model: assignment.requested_model,
    reasoningLevel: assignment.requested_reasoning_level,
    permissionMode: assignment.requested_permission_mode,
    serviceTier: assignment.requested_service_tier,
    visibility: assignment.requested_visibility,
  };
}

function assignmentEnvironmentDigest(assignment: Pick<AssignmentIntent, "environment" | "branchName" | "baseSha" | "candidateSha">): string {
  return sha256(canonicalJson({
    ...assignment.environment,
    branchName: assignment.branchName,
    baseSha: assignment.baseSha,
    candidateSha: assignment.candidateSha,
  }));
}

function immutableAssignmentDigest(
  assignment: AssignmentIntent,
  projectId: string,
  configRevision: number,
  governanceEpoch: number,
  workItemRevision: number,
  repoTargetId: string,
): string {
  const { assignmentId: _assignmentId, ...intent } = assignment;
  return sha256(canonicalJson({ projectId, configRevision, governanceEpoch, workItemRevision, repoTargetId, intent }));
}

function storedAssignmentIntent(assignment: AssignmentRow): AssignmentIntent {
  return {
    assignmentId: assignment.assignment_id,
    workItemId: assignment.work_item_id,
    assignmentKind: assignment.assignment_kind,
    laneId: assignment.lane_id,
    roleRequirementId: assignment.role_requirement_id,
    roleId: assignment.role_id,
    roleGeneration: assignment.role_generation,
    branchName: assignment.branch_name,
    baseSha: assignment.base_sha,
    candidateSemantics: assignment.candidate_semantics,
    candidateSha: assignment.candidate_sha,
    environment: {
      bbServerId: assignment.bb_server_id,
      environmentId: assignment.environment_id,
      sourceId: assignment.source_id,
      hostId: assignment.host_id,
      path: assignment.environment_path,
      mode: assignment.environment_mode,
    },
    frozenBriefVersion: assignment.frozen_brief_version,
    frozenBriefDigest: assignment.frozen_brief_digest,
    requestedProfile: requestedProfile(assignment),
    dispatchKind: assignment.dispatch_kind,
    attachThreadId: assignment.attach_thread_id,
    parentAssignmentId: assignment.parent_assignment_id,
    depth: assignment.depth,
    deadlineAtMs: assignment.deadline_at_ms,
  };
}

function assignmentRows(db: SqliteDatabase, request: ApplyRequest): { assignment: AssignmentRow; attempt: ExecutionAttemptRow } {
  if (!request.assignmentId || !request.executionAttemptId) throw refusal("INVALID_INPUT", "assignment and execution attempt identities are required");
  const assignment = asRow<AssignmentRow>(
    db.prepare("SELECT * FROM assignments WHERE project_id = ? AND assignment_id = ?").get(request.projectId, request.assignmentId),
  );
  const attempt = asRow<ExecutionAttemptRow>(
    db.prepare("SELECT * FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ?").get(request.projectId, request.executionAttemptId),
  );
  if (!assignment || !attempt || attempt.assignment_id !== assignment.assignment_id) {
    throw refusal("RESOURCE_UNKNOWN", "assignment or canonical execution attempt is unavailable");
  }
  return { assignment, attempt };
}

function requireCanonicalRoleGeneration(
  db: SqliteDatabase,
  projectId: string,
  roleId: string,
  roleGeneration: number,
  roleRequirementId: string,
): void {
  const head = asRow<{ current_generation: number }>(
    db.prepare("SELECT current_generation FROM role_generation_heads WHERE project_id = ? AND role_id = ?").get(projectId, roleId),
  );
  const generation = asRow<{ status: string; role_requirement_id: string; holder_execution_attempt_id: string }>(
    db.prepare("SELECT status, role_requirement_id, holder_execution_attempt_id FROM role_generations WHERE project_id = ? AND role_id = ? AND generation = ?").get(
      projectId,
      roleId,
      roleGeneration,
    ),
  );
  if (!head || head.current_generation !== roleGeneration) throw refusal("ROLE_GENERATION_STALE", "assignment role generation is not current");
  if (!generation || generation.status !== "active") throw refusal("ROLE_NOT_ACTIVE", "assignment role generation is not active");
  if (generation.role_requirement_id !== roleRequirementId) throw refusal("ROLE_REQUIREMENT_UNKNOWN", "assignment role requirement does not match its generation");
  const holder = asRow<{ origin: string; state: string; native_receipt_digest: string | null }>(
    db.prepare("SELECT origin, state, native_receipt_digest FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ?").get(
      projectId,
      generation.holder_execution_attempt_id,
    ),
  );
  if (!holder || holder.origin !== "role_holder" || holder.state !== "done" || !holder.native_receipt_digest) {
    throw refusal("ROLE_HOLDER_MISMATCH", "assignment role holder has no complete canonical execution attempt");
  }
}

function revalidateAssignmentReference(
  db: SqliteDatabase,
  request: ApplyRequest,
  assignment: AssignmentRow,
  attempt: ExecutionAttemptRow,
): { governor: { governance_epoch: number; fence_token: string; state: string } } {
  const configRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  if (configRevision !== assignment.config_revision || governor.governance_epoch !== assignment.governance_epoch) {
    throw refusal("ASSIGNMENT_HEAD_STALE", "assignment config or governance head moved");
  }
  requireCanonicalRoleGeneration(db, request.projectId, assignment.role_id, assignment.role_generation, assignment.role_requirement_id);
  const workItem = requireWorkItem(
    db,
    { ...request, workItemId: assignment.work_item_id, repoTargetId: assignment.repo_target_id, expectedResourceRevision: assignment.work_item_revision },
    configRevision,
    assignment.work_item_revision,
  );
  const target = requireTarget(db, request.projectId, configRevision, assignment.repo_target_id) as { source_id: string; host_id: string; path: string };
  if (
    workItem.repo_target_id !== assignment.repo_target_id || target.source_id !== assignment.source_id ||
    target.host_id !== assignment.host_id || target.path !== assignment.environment_path
  ) {
    throw refusal("EXECUTION_CONTEXT_FOREIGN", "assignment environment no longer matches its exact target");
  }
  const intent = storedAssignmentIntent(assignment);
  const profileDigest = sha256(canonicalJson(intent.requestedProfile));
  const assignmentDigest = immutableAssignmentDigest(
    intent,
    request.projectId,
    assignment.config_revision,
    assignment.governance_epoch,
    assignment.work_item_revision,
    assignment.repo_target_id,
  );
  const executionAttemptId = sha256(canonicalJson({ projectId: request.projectId, assignmentDigest, attemptOrdinal: 1 }));
  const attemptDigest = sha256(canonicalJson({ projectId: request.projectId, executionAttemptId, assignmentDigest, state: "prepared" }));
  const requirement = roleRequirementsFromJson(storedConfigJson(db, request.projectId, configRevision))
    .find((candidate) => candidate.roleRequirementId === assignment.role_requirement_id);
  if (
    !requirement || requirement.roleId !== assignment.role_id ||
    (requirement.repoTargetId !== null && requirement.repoTargetId !== assignment.repo_target_id) ||
    !profileEquals(requirement.executedProfile, intent.requestedProfile)
  ) {
    throw refusal("ROLE_REQUIREMENT_UNKNOWN", "assignment role requirement or executed profile is no longer canonical");
  }
  if (
    assignment.assignment_digest !== assignmentDigest || assignment.requested_profile_digest !== profileDigest ||
    attempt.execution_attempt_id !== executionAttemptId || attempt.attempt_digest !== attemptDigest ||
    attempt.assignment_id !== assignment.assignment_id || attempt.origin !== "assignment" ||
    attempt.assignment_digest !== assignmentDigest || attempt.attempt_ordinal !== 1 ||
    attempt.lane_id !== assignment.lane_id || attempt.assignment_kind !== assignment.assignment_kind ||
    attempt.dispatch_kind !== assignment.dispatch_kind || attempt.config_revision !== assignment.config_revision ||
    attempt.governance_epoch !== assignment.governance_epoch || attempt.work_item_id !== assignment.work_item_id ||
    attempt.repo_target_id !== assignment.repo_target_id || attempt.role_id !== assignment.role_id ||
    attempt.role_generation !== assignment.role_generation || attempt.bb_server_id !== assignment.bb_server_id ||
    attempt.environment_id !== assignment.environment_id || attempt.source_id !== assignment.source_id ||
    attempt.host_id !== assignment.host_id || attempt.environment_path !== assignment.environment_path ||
    attempt.frozen_brief_digest !== assignment.frozen_brief_digest || attempt.branch_name !== assignment.branch_name ||
    attempt.base_sha !== assignment.base_sha || attempt.environment_digest !== assignmentEnvironmentDigest(intent)
  ) {
    throw refusal("ASSIGNMENT_HEAD_STALE", "assignment or execution attempt no longer matches its immutable stored intent");
  }
  return { governor };
}

function requireAssignmentActor(
  db: SqliteDatabase,
  request: ApplyRequest,
  roleId: string,
  roleGeneration: number,
): void {
  const actor = asRow<{ actor_kind: string; subject_id: string; role_id: string | null; role_generation: number | null }>(
    db.prepare("SELECT actor_kind, subject_id, role_id, role_generation FROM actor_receipts WHERE project_id = ? AND receipt_id = ?").get(
      request.projectId,
      request.actorReceiptId,
    ),
  );
  const generation = asRow<{ holder_execution_attempt_id: string }>(
    db.prepare("SELECT holder_execution_attempt_id FROM role_generations WHERE project_id = ? AND role_id = ? AND generation = ?").get(
      request.projectId,
      roleId,
      roleGeneration,
    ),
  );
  if (
    !actor || actor.actor_kind !== "role" || actor.role_id !== roleId || actor.role_generation !== roleGeneration ||
    !generation || actor.subject_id !== generation.holder_execution_attempt_id
  ) {
    throw refusal("ROLE_HOLDER_MISMATCH", "assignment actor is not the exact current role holder");
  }
}

function revalidateAssignmentAuthority(
  db: SqliteDatabase,
  request: ApplyRequest,
  assignment: AssignmentRow,
  attempt: ExecutionAttemptRow,
): { actorReceiptId: string; governor: { governance_epoch: number; fence_token: string; state: string } } {
  const actorReceiptId = requireActor(db, request);
  requireRoleActorBinding(db, request);
  requireAssignmentActor(db, request, assignment.role_id, assignment.role_generation);
  const { governor } = revalidateAssignmentReference(db, request, assignment, attempt);
  return { actorReceiptId, governor };
}

function hasUnresolvedWriterTerminalConflict(db: SqliteDatabase, projectId: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM execution_attempts
     WHERE project_id = ? AND origin = 'assignment' AND assignment_kind = 'write'
       AND conflicting_terminal_digest IS NOT NULL LIMIT 1`,
  ).get(projectId));
}

function preflightAssignmentPrepare(db: SqliteDatabase, request: ApplyRequest): void {
  const assignment = request.assignment;
  if (!assignment) throw refusal("INVALID_INPUT", "assignment_prepare requires immutable assignment intent");
  const configRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  requireActor(db, request);
  requireRoleActorBinding(db, request);
  requireAssignmentActor(db, request, assignment.roleId, assignment.roleGeneration);
  if (assignment.requestedProfile.permissionMode !== "full" || assignment.requestedProfile.visibility !== "visible") {
    throw refusal("EXECUTION_PROFILE_MISMATCH", "assignment requires explicit full permission and visible execution");
  }
  if (assignment.assignmentKind === "write" ? assignment.candidateSemantics !== "base" : assignment.candidateSemantics !== "frozen") {
    throw refusal("ASSIGNMENT_HEAD_STALE", "assignment candidate semantics do not match its kind");
  }
  if (!request.repoTargetId) throw refusal("REPO_TARGET_REQUIRED", "assignment requires one exact repository target");
  const workItem = requireWorkItem(db, { ...request, workItemId: assignment.workItemId }, configRevision);
  if (assignment.assignmentKind === "write" ? !["ready", "in_progress"].includes(workItem.lifecycle_state) : workItem.lifecycle_state !== "in_progress") {
    throw refusal("WORK_ITEM_STATE_INVALID", "WorkItem state does not permit this assignment kind");
  }
  const target = requireTarget(db, request.projectId, configRevision, request.repoTargetId) as { source_id: string; host_id: string; path: string };
  if (target.source_id !== assignment.environment.sourceId || target.host_id !== assignment.environment.hostId || target.path !== assignment.environment.path) {
    throw refusal("EXECUTION_CONTEXT_FOREIGN", "assignment environment does not match the exact repository target");
  }
  requireCanonicalRoleGeneration(db, request.projectId, assignment.roleId, assignment.roleGeneration, assignment.roleRequirementId);
  const requirement = roleRequirementsFromJson(storedConfigJson(db, request.projectId, configRevision))
    .find((candidate) => candidate.roleRequirementId === assignment.roleRequirementId);
  if (!requirement || requirement.roleId !== assignment.roleId) throw refusal("ROLE_REQUIREMENT_UNKNOWN", "assignment role requirement is not configured");
  if (requirement.repoTargetId !== null && requirement.repoTargetId !== request.repoTargetId) throw refusal("REPO_TARGET_FOREIGN", "assignment role requirement targets another repository");
  if (!profileEquals(requirement.executedProfile, assignment.requestedProfile)) throw refusal("EXECUTION_PROFILE_MISMATCH", "requested assignment profile does not match the role requirement");
  if (assignment.assignmentKind === "write" && hasUnresolvedWriterTerminalConflict(db, request.projectId)) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", "an unresolved terminal conflict blocks new writing admission");
  }
  const activeWriters = asRow<{ count: number }>(db.prepare(
    `SELECT COUNT(*) AS count FROM execution_attempts WHERE project_id = ? AND origin = 'assignment'
     AND assignment_kind = 'write' AND state IN ${ACTIVE_ASSIGNMENT_SQL}`,
  ).get(request.projectId))?.count ?? 0;
  const laneOccupied = db.prepare(
    `SELECT 1 FROM execution_attempts WHERE project_id = ? AND lane_id = ? AND origin = 'assignment'
     AND assignment_kind = 'write' AND state IN ${ACTIVE_ASSIGNMENT_SQL}`,
  ).get(request.projectId, assignment.laneId);
  const ceiling = writingLaneCeilingFromJson(storedConfigJson(db, request.projectId, configRevision));
  if (assignment.assignmentKind === "write" && (laneOccupied || activeWriters >= ceiling)) {
    throw refusal("LANE_WRITER_EXISTS", "writing lane or project writing ceiling is occupied", { expected: ceiling, attempted: activeWriters, verified: activeWriters });
  }
  const assignmentDigest = immutableAssignmentDigest(
    assignment,
    request.projectId,
    configRevision,
    governor.governance_epoch,
    workItem.resource_revision,
    request.repoTargetId,
  );
  if (db.prepare(`SELECT 1 FROM execution_attempts WHERE project_id = ? AND assignment_digest = ? AND state IN ${ACTIVE_ASSIGNMENT_SQL}`).get(request.projectId, assignmentDigest)) {
    throw refusal("LANE_WRITER_EXISTS", "an unresolved attempt already owns this immutable assignment intent");
  }
  if (db.prepare("SELECT 1 FROM assignments WHERE project_id = ? AND assignment_id = ?").get(request.projectId, assignment.assignmentId)) {
    throw refusal("IDEMPOTENCY_KEY_CONFLICT", "assignment identity is immutable and already exists");
  }
}

function requireNativeAssignmentWorkspace(
  request: ApplyRequest,
  assignment: AssignmentIntent,
  rawInspection: NativeAssignmentInspection,
  target: { source_id: string; host_id: string; path: string; default_branch: string },
): NativeAssignmentInspection {
  const parsed = z.object({
    bbServerId: id.nullable(),
    projectId: id.nullable(),
    environmentId: id.nullable(),
    sourceId: id.nullable(),
    hostId: id.nullable(),
    environmentPath: id.nullable(),
    environmentMode: id.nullable(),
    environmentStatus: id.nullable(),
    workingTreeState: z.enum(["clean", "dirty", "unknown"]),
    branchName: id.nullable(),
    headSha: gitShaSchema.nullable(),
    baseSha: gitShaSchema.nullable(),
    candidateSha: gitShaSchema.nullable(),
    defaultBranchName: id.nullable(),
    defaultBranchHeadSha: gitShaSchema.nullable(),
    mergeBaseSha: gitShaSchema.nullable(),
    threadId: id.nullable(),
    threadProviderId: id.nullable(),
    threadVisibility: z.enum(["visible", "hidden"]).nullable(),
  }).strict().safeParse(rawInspection);
  if (!parsed.success) throw refusal("BB_FACTS_UNAVAILABLE", "exact native BB/Git assignment facts are unavailable");
  const inspection = parsed.data;
  if (
    !inspection.bbServerId || !inspection.projectId || !inspection.environmentId ||
    !inspection.sourceId || !inspection.hostId || !inspection.environmentPath ||
    !inspection.environmentMode || !inspection.environmentStatus || !inspection.branchName ||
    !inspection.headSha || !inspection.baseSha || !inspection.defaultBranchName ||
    !inspection.defaultBranchHeadSha || !inspection.mergeBaseSha ||
    inspection.environmentStatus !== "ready" || inspection.workingTreeState === "unknown"
  ) {
    throw refusal("BB_FACTS_UNAVAILABLE", "native environment identity, readiness, cleanliness, or ancestry is unresolved");
  }
  if (
    inspection.bbServerId !== assignment.environment.bbServerId ||
    inspection.projectId !== request.projectId ||
    inspection.environmentId !== assignment.environment.environmentId ||
    inspection.sourceId !== assignment.environment.sourceId ||
    inspection.hostId !== assignment.environment.hostId ||
    inspection.environmentPath !== assignment.environment.path ||
    inspection.environmentMode !== "managed-worktree" ||
    inspection.workingTreeState !== "clean" ||
    inspection.branchName !== assignment.branchName ||
    inspection.defaultBranchName !== target.default_branch ||
    target.source_id !== assignment.environment.sourceId ||
    target.host_id !== assignment.environment.hostId ||
    target.path !== assignment.environment.path
  ) {
    throw refusal("EXECUTION_CONTEXT_FOREIGN", "native environment is dirty, moved, foreign, or not the exact managed worktree target");
  }
  if (inspection.baseSha !== assignment.baseSha || inspection.candidateSha !== assignment.candidateSha) {
    throw refusal("ASSIGNMENT_HEAD_STALE", "native branch base or candidate does not match the immutable assignment");
  }
  if (assignment.assignmentKind === "write") {
    if (inspection.headSha !== assignment.baseSha || inspection.mergeBaseSha !== inspection.headSha) {
      throw refusal("ASSIGNMENT_HEAD_STALE", "writer head is stale, ahead of, or not an ancestor of the current default branch");
    }
  } else if (
    inspection.headSha !== assignment.candidateSha ||
    inspection.mergeBaseSha !== inspection.defaultBranchHeadSha
  ) {
    throw refusal("ASSIGNMENT_HEAD_STALE", "frozen candidate is not the exact clean head descended from the current default branch");
  }
  return inspection;
}

function applyAssignmentPrepare(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  inspection: NativeAssignmentInspection,
): FoundationResult {
  const assignment = request.assignment;
  if (!assignment) throw refusal("INVALID_INPUT", "assignment_prepare requires immutable assignment intent");
  const configRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  requireRoleActorBinding(db, request);
  requireAssignmentActor(db, request, assignment.roleId, assignment.roleGeneration);
  if (assignment.requestedProfile.permissionMode !== "full" || assignment.requestedProfile.visibility !== "visible") {
    throw refusal("EXECUTION_PROFILE_MISMATCH", "assignment requires explicit full permission and visible execution");
  }
  if (assignment.assignmentKind === "write" ? assignment.candidateSemantics !== "base" : assignment.candidateSemantics !== "frozen") {
    throw refusal("ASSIGNMENT_HEAD_STALE", "assignment candidate semantics do not match its kind");
  }
  if (!request.repoTargetId) throw refusal("REPO_TARGET_REQUIRED", "assignment requires one exact repository target");
  const target = requireTarget(db, request.projectId, configRevision, request.repoTargetId) as {
    source_id: string;
    host_id: string;
    path: string;
    default_branch: string;
  };
  inspection = requireNativeAssignmentWorkspace(request, assignment, inspection, target);
  if (
    assignment.dispatchKind === "attach" &&
    (inspection.threadId !== assignment.attachThreadId || inspection.threadProviderId !== assignment.requestedProfile.providerId || inspection.threadVisibility !== "visible")
  ) {
    throw refusal(inspection.threadVisibility === "hidden" ? "ROLE_CONTEXT_HIDDEN" : "EXECUTION_CONTEXT_FOREIGN", "attach thread does not match the exact visible assignment context");
  }
  if (assignment.dispatchKind === "spawn" && (inspection.threadId !== null || inspection.threadProviderId !== null || inspection.threadVisibility !== null)) {
    throw refusal("EXECUTION_CONTEXT_FOREIGN", "spawn preparation cannot adopt an existing thread");
  }
  const workItem = requireWorkItem(
    db,
    { ...request, workItemId: assignment.workItemId, expectedResourceRevision: request.expectedResourceRevision },
    configRevision,
  );
  if (assignment.assignmentKind === "write" && !["ready", "in_progress"].includes(workItem.lifecycle_state)) {
    throw refusal("WORK_ITEM_STATE_INVALID", "write assignment requires a ready or in-progress WorkItem");
  }
  if (assignment.assignmentKind !== "write" && workItem.lifecycle_state !== "in_progress") {
    throw refusal("WORK_ITEM_STATE_INVALID", "review and probe assignments require an in-progress WorkItem");
  }
  requireCanonicalRoleGeneration(db, request.projectId, assignment.roleId, assignment.roleGeneration, assignment.roleRequirementId);
  const requirements = roleRequirementsFromJson(storedConfigJson(db, request.projectId, configRevision));
  const requirement = requirements.find((candidate) => candidate.roleRequirementId === assignment.roleRequirementId);
  if (!requirement || requirement.roleId !== assignment.roleId) throw refusal("ROLE_REQUIREMENT_UNKNOWN", "assignment role requirement is not configured");
  if (requirement.repoTargetId !== null && requirement.repoTargetId !== request.repoTargetId) throw refusal("REPO_TARGET_FOREIGN", "assignment role requirement targets another repository");
  if (!profileEquals(requirement.executedProfile, assignment.requestedProfile)) throw refusal("EXECUTION_PROFILE_MISMATCH", "requested assignment profile does not match the role requirement");
  if (assignment.assignmentKind === "write" && hasUnresolvedWriterTerminalConflict(db, request.projectId)) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", "an unresolved terminal conflict blocks new writing admission");
  }
  const configJson = storedConfigJson(db, request.projectId, configRevision);
  const ceiling = writingLaneCeilingFromJson(configJson);
  const activeWriterRows = db.prepare(
    `SELECT execution_attempt_id, lane_id FROM execution_attempts
     WHERE project_id = ? AND origin = 'assignment' AND assignment_kind = 'write' AND state IN ${ACTIVE_ASSIGNMENT_SQL}
     ORDER BY lane_id, execution_attempt_id`,
  ).all(request.projectId) as Array<{ execution_attempt_id: string; lane_id: string }>;
  const laneHolder = activeWriterRows.find((row) => row.lane_id === assignment.laneId);
  if (assignment.assignmentKind === "write" && (laneHolder || activeWriterRows.length >= ceiling)) {
    throw refusal("LANE_WRITER_EXISTS", "writing lane or project writing ceiling is occupied", {
      expected: ceiling,
      attempted: activeWriterRows.length,
      verified: activeWriterRows.length,
    });
  }
  const assignmentDigest = immutableAssignmentDigest(
    assignment,
    request.projectId,
    configRevision,
    governor.governance_epoch,
    workItem.resource_revision,
    request.repoTargetId,
  );
  const unresolvedIntent = asRow<{ execution_attempt_id: string }>(
    db.prepare(`SELECT execution_attempt_id FROM execution_attempts WHERE project_id = ? AND assignment_digest = ? AND state IN ${ACTIVE_ASSIGNMENT_SQL}`).get(
      request.projectId,
      assignmentDigest,
    ),
  );
  if (unresolvedIntent) throw refusal("LANE_WRITER_EXISTS", "an unresolved attempt already owns this immutable assignment intent");
  if (db.prepare("SELECT 1 FROM assignments WHERE project_id = ? AND assignment_id = ?").get(request.projectId, assignment.assignmentId)) {
    throw refusal("IDEMPOTENCY_KEY_CONFLICT", "assignment identity is immutable and already exists");
  }
  const executionAttemptId = sha256(canonicalJson({ projectId: request.projectId, assignmentDigest, attemptOrdinal: 1 }));
  const profileDigest = sha256(canonicalJson(assignment.requestedProfile));
  const environmentDigest = assignmentEnvironmentDigest(assignment);
  const eventSequence = nextEventSequence(db, request.projectId);
  const createdAtMs = now();
  db.prepare(
    `INSERT INTO assignments (
      project_id, assignment_id, work_item_id, assignment_kind, lane_id, role_requirement_id,
      role_id, role_generation, config_revision, governance_epoch, work_item_revision,
      repo_target_id, branch_name, base_sha, candidate_semantics, candidate_sha, bb_server_id,
      environment_id, source_id, host_id, environment_path, environment_mode,
      frozen_brief_version, frozen_brief_digest, requested_provider_id, requested_model,
      requested_reasoning_level, requested_permission_mode, requested_service_tier,
      requested_visibility, requested_profile_digest, dispatch_kind, attach_thread_id,
      parent_assignment_id, depth, deadline_at_ms, assignment_digest, idempotency_key,
      creation_event_sequence, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'managed-worktree',
      ?, ?, ?, ?, ?, ?, ?, 'visible', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
  ).run(
    request.projectId, assignment.assignmentId, assignment.workItemId, assignment.assignmentKind,
    assignment.laneId, assignment.roleRequirementId, assignment.roleId, assignment.roleGeneration,
    configRevision, governor.governance_epoch, workItem.resource_revision, request.repoTargetId,
    assignment.branchName, assignment.baseSha, assignment.candidateSemantics, assignment.candidateSha,
    assignment.environment.bbServerId, assignment.environment.environmentId, assignment.environment.sourceId,
    assignment.environment.hostId, assignment.environment.path, assignment.frozenBriefVersion,
    assignment.frozenBriefDigest, assignment.requestedProfile.providerId, assignment.requestedProfile.model,
    assignment.requestedProfile.reasoningLevel, assignment.requestedProfile.permissionMode,
    assignment.requestedProfile.serviceTier, profileDigest, assignment.dispatchKind,
    assignment.attachThreadId, assignment.parentAssignmentId, assignment.deadlineAtMs, assignmentDigest,
    request.idempotencyKey, eventSequence, createdAtMs,
  );
  const attemptDigest = sha256(canonicalJson({ projectId: request.projectId, executionAttemptId, assignmentDigest, state: "prepared" }));
  db.prepare(
    `INSERT INTO execution_attempts (
      project_id, execution_attempt_id, assignment_id, origin, assignment_digest, lane_id,
      assignment_kind, attempt_ordinal, dispatch_kind, config_revision, governance_epoch,
      work_item_id, repo_target_id, role_id, role_generation, state, bb_server_id,
      environment_id, source_id, host_id, environment_path, thread_id, frozen_brief_digest,
      branch_name, base_sha, candidate_sha, environment_digest, created_at_ms, attempt_digest
    ) VALUES (?, ?, ?, 'assignment', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    request.projectId, executionAttemptId, assignment.assignmentId, assignmentDigest, assignment.laneId,
    assignment.assignmentKind, assignment.dispatchKind, configRevision, governor.governance_epoch,
    assignment.workItemId, request.repoTargetId, assignment.roleId, assignment.roleGeneration,
    assignment.environment.bbServerId, assignment.environment.environmentId, assignment.environment.sourceId,
    assignment.environment.hostId, assignment.environment.path, assignment.attachThreadId,
    assignment.frozenBriefDigest, assignment.branchName, assignment.baseSha, assignment.candidateSha,
    environmentDigest, createdAtMs, attemptDigest,
  );
  return commitMutation(
    db,
    request,
    digest,
    actorReceiptId,
    { aggregateType: "assignment", aggregateId: assignment.assignmentId, aggregateRevision: 1, eventType: "assignment_prepared", event: { assignmentId: assignment.assignmentId, executionAttemptId, assignmentDigest, laneId: assignment.laneId, assignmentKind: assignment.assignmentKind } },
    { expected: 2, attempted: 2, verified: 2 },
    { currentConfigRevision: configRevision, currentGovernanceEpoch: governor.governance_epoch, currentResourceRevision: workItem.resource_revision, evidence: { assignmentId: assignment.assignmentId, executionAttemptId, assignmentDigest, requestedProfileDigest: profileDigest, environmentDigest, activeWriterCount: activeWriterRows.length + (assignment.assignmentKind === "write" ? 1 : 0), writingLaneCeiling: ceiling } },
  );
}

export function explicitExecutionInputSources(serviceTier?: string): NativeAssignmentInput["executionInputSources"] {
  return {
    providerId: "explicit",
    model: "explicit",
    reasoningLevel: "explicit",
    permissionMode: "explicit",
    ...(serviceTier ? { serviceTier: "explicit" as const } : {}),
  };
}

function nativeAssignmentInput(assignment: AssignmentRow, attempt: ExecutionAttemptRow, frozenBriefContent: string): NativeAssignmentInput {
  const candidateScope: NativeAssignmentInput["candidateScope"] = assignment.assignment_kind === "write"
    ? { mode: "write", candidateSemantics: "base", candidateSha: null }
    : { mode: "read-only", candidateSemantics: "frozen", candidateSha: assignment.candidate_sha!, mutations: "forbidden" };
  return {
    projectId: assignment.project_id,
    assignmentId: assignment.assignment_id,
    executionAttemptId: attempt.execution_attempt_id,
    assignmentKind: assignment.assignment_kind,
    dispatchKind: assignment.dispatch_kind,
    attachThreadId: assignment.attach_thread_id,
    repoTargetId: assignment.repo_target_id,
    branchName: assignment.branch_name,
    baseSha: assignment.base_sha,
    candidateSha: assignment.candidate_sha,
    candidateScope,
    environment: {
      bbServerId: assignment.bb_server_id,
      environmentId: assignment.environment_id,
      sourceId: assignment.source_id,
      hostId: assignment.host_id,
      path: assignment.environment_path,
      mode: "managed-worktree",
    },
    requestedProfile: requestedProfile(assignment),
    executionInputSources: explicitExecutionInputSources(assignment.requested_service_tier || undefined),
    frozenBriefContent,
    frozenBriefDigest: assignment.frozen_brief_digest,
  };
}

function nativeContextMatches(assignment: AssignmentRow, attempt: ExecutionAttemptRow, evidence: NativeAssignmentEvidence): boolean {
  return (
    evidence.assignmentId === assignment.assignment_id &&
    evidence.executionAttemptId === attempt.execution_attempt_id &&
    evidence.bbServerId === assignment.bb_server_id &&
    evidence.projectId === assignment.project_id &&
    evidence.environmentId === assignment.environment_id &&
    evidence.sourceId === assignment.source_id &&
    evidence.hostId === assignment.host_id &&
    evidence.environmentPath === assignment.environment_path &&
    evidence.branchName === assignment.branch_name &&
    evidence.baseSha === assignment.base_sha &&
    evidence.candidateSha === assignment.candidate_sha &&
    (attempt.thread_id === null || evidence.threadId === attempt.thread_id) &&
    (attempt.native_request_id === null || evidence.nativeRequestId === attempt.native_request_id)
  );
}

function positiveNativeEvidence(
  assignment: AssignmentRow,
  attempt: ExecutionAttemptRow,
  evidence: NativeAssignmentEvidence,
): { profile: ExecutionProfile; profileDigest: string; nativeReceiptDigest: string; state: "content_delivered" | "running" } {
  const requiredStrings = [
    evidence.assignmentId,
    evidence.executionAttemptId,
    evidence.bbServerId,
    evidence.projectId,
    evidence.environmentId,
    evidence.sourceId,
    evidence.hostId,
    evidence.environmentPath,
    evidence.threadId,
    evidence.providerThreadId,
    evidence.nativeRequestId,
    evidence.requestEventId,
    evidence.acceptedEventId,
    evidence.firstActionEventId,
    evidence.contentEventId,
    evidence.contentDigest,
    evidence.branchName,
    evidence.baseSha,
  ];
  if (requiredStrings.some((value) => !stringField(value)) || !evidence.actualProfile) {
    throw refusal("DISPATCH_UNKNOWN", "native evidence lacks exact first-action, content, context, or profile facts");
  }
  if (!nativeContextMatches(assignment, attempt, evidence)) {
    throw refusal("EXECUTION_CONTEXT_FOREIGN", "native evidence belongs to another exact execution context");
  }
  if (evidence.contentDigest !== assignment.frozen_brief_digest) {
    throw refusal("DISPATCH_UNKNOWN", "native content receipt does not bind the exact frozen brief");
  }
  if (!profileEquals(evidence.actualProfile, requestedProfile(assignment))) {
    throw refusal("EXECUTION_PROFILE_MISMATCH", "actual execution profile does not match the requested profile");
  }
  if (
    !evidence.requestEventSeq || !evidence.acceptedEventSeq || !evidence.firstActionEventSeq || !evidence.contentEventSeq ||
    !(evidence.requestEventSeq < evidence.acceptedEventSeq && evidence.acceptedEventSeq <= evidence.firstActionEventSeq && evidence.firstActionEventSeq <= evidence.contentEventSeq)
  ) {
    throw refusal("DISPATCH_UNKNOWN", "native event correlation is absent or ambiguously ordered");
  }
  const profileDigest = sha256(canonicalJson(evidence.actualProfile));
  const nativeReceiptDigest = sha256(canonicalJson({
    projectId: assignment.project_id,
    assignmentId: assignment.assignment_id,
    threadId: evidence.threadId,
    providerThreadId: evidence.providerThreadId,
    nativeRequestId: evidence.nativeRequestId,
    requestEventId: evidence.requestEventId,
    requestEventSeq: evidence.requestEventSeq,
    acceptedEventId: evidence.acceptedEventId,
    acceptedEventSeq: evidence.acceptedEventSeq,
    firstActionEventId: evidence.firstActionEventId,
    firstActionEventSeq: evidence.firstActionEventSeq,
    contentEventId: evidence.contentEventId,
    contentEventSeq: evidence.contentEventSeq,
    contentDigest: evidence.contentDigest,
    actualProfileDigest: profileDigest,
  }));
  return { profile: evidence.actualProfile, profileDigest, nativeReceiptDigest, state: "content_delivered" };
}

function nativeEvidenceSnapshot(attempt: ExecutionAttemptRow): NativeEvidenceSnapshot {
  return Object.fromEntries(NATIVE_EVIDENCE_COLUMNS.map((column) => [column, attempt[column]])) as NativeEvidenceSnapshot;
}

function incomingNativeEvidence(
  evidence: NativeAssignmentEvidence,
  positive: ReturnType<typeof positiveNativeEvidence> | null,
): NativeEvidenceSnapshot {
  const profile = positive?.profile ?? evidence.actualProfile ?? null;
  return {
    thread_id: evidence.threadId ?? null,
    provider_thread_id: evidence.providerThreadId ?? null,
    native_request_id: evidence.nativeRequestId ?? null,
    request_event_id: evidence.requestEventId ?? null,
    request_event_seq: evidence.requestEventSeq ?? null,
    accepted_event_id: evidence.acceptedEventId ?? null,
    accepted_event_seq: evidence.acceptedEventSeq ?? null,
    first_action_event_id: evidence.firstActionEventId ?? null,
    first_action_event_seq: evidence.firstActionEventSeq ?? null,
    content_event_id: evidence.contentEventId ?? null,
    content_event_seq: evidence.contentEventSeq ?? null,
    content_receipt_digest: evidence.contentDigest ?? null,
    actual_provider_id: profile?.providerId ?? null,
    actual_model: profile?.model ?? null,
    actual_reasoning_level: profile?.reasoningLevel ?? null,
    actual_permission_mode: profile?.permissionMode ?? null,
    actual_service_tier: profile?.serviceTier ?? null,
    actual_visibility: profile?.visibility ?? null,
    actual_profile_digest: positive?.profileDigest ?? (profile ? sha256(canonicalJson(profile)) : null),
    native_receipt_digest: positive?.nativeReceiptDigest ?? null,
    last_event_seq: evidence.lastEventSeq ?? evidence.contentEventSeq ?? null,
  };
}

function mergeNativeEvidence(
  retained: NativeEvidenceSnapshot,
  incoming: NativeEvidenceSnapshot,
): { merged: NativeEvidenceSnapshot; contradiction: boolean } {
  let contradiction = false;
  const merged = Object.fromEntries(NATIVE_EVIDENCE_COLUMNS.map((column) => {
    const current = retained[column];
    const next = incoming[column];
    if (current !== null && next !== null && current !== next) contradiction = true;
    return [column, current ?? next];
  })) as NativeEvidenceSnapshot;
  return { merged, contradiction };
}

function exactPreEffectRefusal(
  assignment: AssignmentRow,
  attempt: ExecutionAttemptRow,
  evidence: NativeAssignmentEvidence,
  operation: "dispatch" | "reconcile",
  incoming: NativeEvidenceSnapshot,
): boolean {
  if (!nativeContextMatches(assignment, attempt, evidence)) return false;
  const effectColumns: NativeEvidenceColumn[] = [
    "accepted_event_id", "accepted_event_seq", "first_action_event_id", "first_action_event_seq",
    "content_event_id", "content_event_seq", "content_receipt_digest", "actual_provider_id",
    "actual_model", "actual_reasoning_level", "actual_permission_mode", "actual_service_tier",
    "actual_visibility", "actual_profile_digest", "native_receipt_digest",
  ];
  if (effectColumns.some((column) => attempt[column] !== null || incoming[column] !== null)) return false;
  if (operation === "dispatch") {
    return NATIVE_EVIDENCE_COLUMNS.every((column) =>
      (attempt[column] === null && incoming[column] === null) || incoming[column] === attempt[column]
    );
  }
  if (!attempt.thread_id || !attempt.native_request_id) return false;
  return NATIVE_EVIDENCE_COLUMNS.every((column) => attempt[column] === null || incoming[column] === attempt[column]);
}

function recordNativeEvidence(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  assignment: AssignmentRow,
  attempt: ExecutionAttemptRow,
  evidence: NativeAssignmentEvidence,
  operation: "dispatch" | "reconcile",
): FoundationResult {
  return transaction(db, () => {
    const replay = checkIdempotency(db, request, digest);
    if (replay) return replay;
    const current = assignmentRows(db, request);
    const retained = nativeEvidenceSnapshot(attempt);
    const currentRetained = nativeEvidenceSnapshot(current.attempt);
    if (current.attempt.state !== attempt.state || canonicalJson(currentRetained) !== canonicalJson(retained)) {
      throw refusal("ASSIGNMENT_HEAD_STALE", "attempt state moved before native evidence was recorded");
    }
    const authority = revalidateAssignmentAuthority(db, request, current.assignment, current.attempt);
    const observedAtMs = evidence.observedAtMs ?? now();
    let positive: ReturnType<typeof positiveNativeEvidence> | null = null;
    let outcome: FoundationCode = "DISPATCH_UNKNOWN";
    let state: ExecutionAttemptRow["state"] = "dispatch_unknown";
    let reasonCode = evidence.reasonCode || "dispatch_unknown";
    let acceptIncoming = nativeContextMatches(current.assignment, current.attempt, evidence);
    try {
      if (evidence.disposition === "confirmed") {
        positive = positiveNativeEvidence(current.assignment, current.attempt, evidence);
        outcome = "OK";
        state = positive.state;
      }
    } catch (error) {
      if (error instanceof Refusal && ["EXECUTION_PROFILE_MISMATCH", "EXECUTION_CONTEXT_FOREIGN"].includes(error.data.code)) {
        reasonCode = error.data.code;
        outcome = error.data.code;
        if (error.data.code === "EXECUTION_CONTEXT_FOREIGN") acceptIncoming = false;
      }
      state = "dispatch_unknown";
    }
    const incoming = incomingNativeEvidence(evidence, positive);
    if (evidence.disposition === "refused") {
      if (exactPreEffectRefusal(current.assignment, current.attempt, evidence, operation, incoming)) {
        state = "failed";
        outcome = "EXECUTION_PROFILE_UNKNOWN";
      } else {
        state = "dispatch_unknown";
        outcome = acceptIncoming ? "DISPATCH_UNKNOWN" : "EXECUTION_CONTEXT_FOREIGN";
        reasonCode = acceptIncoming ? "refusal_not_proven_pre_effect" : "EXECUTION_CONTEXT_FOREIGN";
      }
    }
    const mergedResult = mergeNativeEvidence(retained, acceptIncoming ? incoming : retained);
    const missingRetainedConfirmation = positive !== null && NATIVE_EVIDENCE_COLUMNS.some(
      (column) => retained[column] !== null && incoming[column] !== retained[column],
    );
    const evidenceContradiction = mergedResult.contradiction || missingRetainedConfirmation;
    const merged = evidenceContradiction ? retained : mergedResult.merged;
    if (evidenceContradiction) {
      positive = null;
      state = "dispatch_unknown";
      outcome = "DISPATCH_UNKNOWN";
      reasonCode = "retained_native_evidence_contradiction";
    }
    const terminalDeadlineReason = observedAtMs > current.assignment.deadline_at_ms ? "assignment_deadline_exceeded" : reasonCode;
    const setColumns = NATIVE_EVIDENCE_COLUMNS.map((column) => `${column} = ?`).join(", ");
    const priorPredicate = NATIVE_EVIDENCE_COLUMNS.map((column) => `${column} IS ?`).join(" AND ");
    const updated = db.prepare(
      `UPDATE execution_attempts SET state = ?, ${setColumns}, reason_code = ?, observed_at_ms = ?
       WHERE project_id = ? AND execution_attempt_id = ? AND state = ? AND ${priorPredicate}`,
    ).run(
      state,
      ...NATIVE_EVIDENCE_COLUMNS.map((column) => merged[column]),
      terminalDeadlineReason,
      observedAtMs,
      request.projectId,
      current.attempt.execution_attempt_id,
      current.attempt.state,
      ...NATIVE_EVIDENCE_COLUMNS.map((column) => retained[column]),
    );
    if (updated.changes !== 1) throw refusal("DISPATCH_UNKNOWN", "attempt native-evidence compare-and-swap failed");
    const aggregateRevision = nextAggregateRevision(db, request.projectId, "execution_attempt", current.attempt.execution_attempt_id);
    return commitMutation(
      db,
      request,
      digest,
      authority.actorReceiptId,
      { aggregateType: "execution_attempt", aggregateId: current.attempt.execution_attempt_id, aggregateRevision, eventType: state === "dispatch_unknown" ? "assignment_dispatch_unknown" : state === "failed" ? "assignment_dispatch_failed" : "assignment_content_delivered", event: { assignmentId: current.assignment.assignment_id, executionAttemptId: current.attempt.execution_attempt_id, operation, state, reasonCode: terminalDeadlineReason, nativeRequestId: merged.native_request_id, threadId: merged.thread_id, lastEventSeq: merged.last_event_seq } },
      { expected: 1, attempted: 1, verified: outcome === "OK" ? 1 : 0 },
      { currentConfigRevision: current.assignment.config_revision, currentGovernanceEpoch: authority.governor.governance_epoch, evidence: { assignmentId: current.assignment.assignment_id, executionAttemptId: current.attempt.execution_attempt_id, state, reasonCode: terminalDeadlineReason, nativeReceiptDigest: merged.native_receipt_digest, actualProfileDigest: merged.actual_profile_digest, threadId: merged.thread_id, nativeRequestId: merged.native_request_id, lastEventSeq: merged.last_event_seq } },
      outcome,
    );
  });
}

function applyAssignmentNative(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  adapter: NativeAssignmentAdapter | null,
  operation: "dispatch" | "reconcile",
): FoundationResult {
  let possibleNativeEffect = false;
  try {
    const replay = checkIdempotency(db, request, digest);
    if (replay) return replay;
    if (!adapter) return result("DISPATCH_UNKNOWN", request.projectId, 1, 0, 0, { message: "native assignment adapter is unavailable" });
    const frozenBriefContent = request.frozenBriefContent;
    const { assignment, attempt } = transaction(db, () => {
      const replayInTransaction = checkIdempotency(db, request, digest);
      if (replayInTransaction) throw refusal("IDEMPOTENCY_KEY_CONFLICT", "assignment operation was concurrently committed");
      const rows = assignmentRows(db, request);
      const authority = revalidateAssignmentAuthority(db, request, rows.assignment, rows.attempt);
      if (!frozenBriefContent || sha256(frozenBriefContent) !== rows.assignment.frozen_brief_digest) {
        throw refusal("ASSIGNMENT_HEAD_STALE", "exact frozen brief content does not match immutable intent");
      }
      if (operation === "dispatch" && rows.attempt.state !== "prepared") {
        throw refusal(rows.attempt.state === "dispatch_unknown" ? "DISPATCH_UNKNOWN" : "ASSIGNMENT_HEAD_STALE", "assignment attempt is not dispatchable");
      }
      if (operation === "reconcile" && rows.attempt.state !== "dispatch_unknown") {
        throw refusal("ASSIGNMENT_HEAD_STALE", "only an ambiguous dispatch may be reconciled");
      }
      if (operation === "reconcile") return rows;

      const retained = nativeEvidenceSnapshot(rows.attempt);
      const priorPredicate = NATIVE_EVIDENCE_COLUMNS.map((column) => `${column} IS ?`).join(" AND ");
      const claimed = db.prepare(
        `UPDATE execution_attempts SET state = 'dispatch_unknown', reason_code = 'dispatch_claimed', observed_at_ms = ?
         WHERE project_id = ? AND execution_attempt_id = ? AND state = 'prepared' AND ${priorPredicate}`,
      ).run(
        now(),
        request.projectId,
        rows.attempt.execution_attempt_id,
        ...NATIVE_EVIDENCE_COLUMNS.map((column) => retained[column]),
      );
      if (claimed.changes !== 1) throw refusal("DISPATCH_UNKNOWN", "dispatch claim compare-and-swap failed");
      const claimIdentity = sha256(canonicalJson({
        phase: "assignment_dispatch_claim",
        projectId: request.projectId,
        executionAttemptId: rows.attempt.execution_attempt_id,
        requestDigest: digest,
      }));
      const claimRequest = { ...request, idempotencyKey: `assignment-dispatch-claim-${claimIdentity}` };
      const claimDigest = sha256(canonicalJson({ claimIdentity, requestDigest: digest }));
      const aggregateRevision = nextAggregateRevision(db, request.projectId, "execution_attempt", rows.attempt.execution_attempt_id);
      commitMutation(
        db,
        claimRequest,
        claimDigest,
        authority.actorReceiptId,
        { aggregateType: "execution_attempt", aggregateId: rows.attempt.execution_attempt_id, aggregateRevision, eventType: "assignment_dispatch_claimed", event: { assignmentId: rows.assignment.assignment_id, executionAttemptId: rows.attempt.execution_attempt_id, state: "dispatch_unknown", reasonCode: "dispatch_claimed" } },
        { expected: 1, attempted: 1, verified: 1 },
        { currentConfigRevision: rows.assignment.config_revision, currentGovernanceEpoch: authority.governor.governance_epoch, evidence: { assignmentId: rows.assignment.assignment_id, executionAttemptId: rows.attempt.execution_attempt_id, state: "dispatch_unknown", reasonCode: "dispatch_claimed" } },
        "DISPATCH_UNKNOWN",
      );
      return assignmentRows(db, request);
    });
    const input = nativeAssignmentInput(assignment, attempt, frozenBriefContent!);
    let evidence: NativeAssignmentEvidence;
    possibleNativeEffect = true;
    try {
      evidence = operation === "dispatch"
        ? adapter.dispatch(input)
        : adapter.reconcile({ ...input, threadId: attempt.thread_id, nativeRequestId: attempt.native_request_id });
    } catch {
      evidence = { disposition: "ambiguous", reasonCode: "native_transport_ambiguous", threadId: attempt.thread_id ?? undefined, nativeRequestId: attempt.native_request_id ?? undefined };
    }
    return recordNativeEvidence(db, request, digest, assignment, attempt, evidence, operation);
  } catch (error) {
    if (possibleNativeEffect) return result("DISPATCH_UNKNOWN", request.projectId, 1, 1, 0, { message: "native effect may have occurred; durable dispatch claim remains unresolved" });
    if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
    return result("INTERNAL_ERROR", request.projectId, 1, 0, 0, { message: "internal assignment mutation error" });
  }
}

function terminalCorrelationMatches(assignment: AssignmentRow, attempt: ExecutionAttemptRow, report: TerminalReport): boolean {
  return (
    report.projectId === assignment.project_id &&
    report.assignmentId === assignment.assignment_id &&
    report.executionAttemptId === attempt.execution_attempt_id &&
    report.workItemId === assignment.work_item_id &&
    report.roleId === assignment.role_id &&
    report.roleGeneration === assignment.role_generation &&
    report.repoTargetId === assignment.repo_target_id &&
    report.environmentId === assignment.environment_id &&
    report.threadId === attempt.thread_id &&
    report.branchName === assignment.branch_name &&
    report.baseSha === assignment.base_sha &&
    report.nativeReceiptDigest === attempt.native_receipt_digest &&
    report.actualProfileDigest === attempt.actual_profile_digest &&
    (assignment.candidate_semantics === "base" || report.candidateSha === assignment.candidate_sha) &&
    report.receiptEventSeq > (attempt.last_event_seq ?? 0) &&
    report.reportedAtMs <= report.receivedAtMs
  );
}

function applyAssignmentTerminal(db: SqliteDatabase, request: ApplyRequest, digest: string): FoundationResult {
  const report = request.terminalReport;
  if (!report) throw refusal("TERMINAL_REPORT_REQUIRED", "assignment terminal mutation requires one exact versioned report");
  const { assignment, attempt } = assignmentRows(db, request);
  const reportDigest = sha256(canonicalJson(report));
  if (attempt.terminal_report_digest) {
    if (attempt.terminal_report_digest === reportDigest) {
      const original = asRow<{ outcome_json: string }>(
        db.prepare("SELECT outcome_json FROM mutation_receipts WHERE project_id = ? AND operation_class = 'assignment_terminal' AND json_extract(outcome_json, '$.evidence.terminalReportDigest') = ? ORDER BY created_at_ms LIMIT 1").get(
          request.projectId,
          reportDigest,
        ),
      );
      if (original) return JSON.parse(original.outcome_json) as FoundationResult;
    }
    const authority = revalidateAssignmentAuthority(db, request, assignment, attempt);
    if (attempt.conflicting_terminal_digest !== null) {
      throw refusal("TERMINAL_REPORT_AMBIGUOUS", "a different terminal conflict is already retained");
    }
    const updated = db.prepare(
      `UPDATE execution_attempts SET conflicting_terminal_digest = ?, reason_code = 'terminal_report_ambiguous'
       WHERE project_id = ? AND execution_attempt_id = ? AND state IS ?
         AND terminal_result IS ? AND reported_outcome IS ? AND terminal_report_digest IS ?
         AND conflicting_terminal_digest IS ? AND terminal_event_id IS ? AND terminal_event_seq IS ?
         AND candidate_sha IS ? AND native_receipt_digest IS ? AND actual_profile_digest IS ?
         AND completed_at_ms IS ? AND reason_code IS ? AND last_event_seq IS ?`,
    ).run(
      reportDigest,
      request.projectId,
      attempt.execution_attempt_id,
      attempt.state,
      attempt.terminal_result,
      attempt.reported_outcome,
      attempt.terminal_report_digest,
      attempt.conflicting_terminal_digest,
      attempt.terminal_event_id,
      attempt.terminal_event_seq,
      attempt.candidate_sha,
      attempt.native_receipt_digest,
      attempt.actual_profile_digest,
      attempt.completed_at_ms,
      attempt.reason_code,
      attempt.last_event_seq,
    );
    if (updated.changes !== 1) throw refusal("TERMINAL_REPORT_AMBIGUOUS", "terminal conflict compare-and-swap failed");
    const aggregateRevision = nextAggregateRevision(db, request.projectId, "execution_attempt", attempt.execution_attempt_id);
    return commitMutation(
      db,
      request,
      digest,
      authority.actorReceiptId,
      { aggregateType: "execution_attempt", aggregateId: attempt.execution_attempt_id, aggregateRevision, eventType: "assignment_terminal_ambiguous", event: { assignmentId: assignment.assignment_id, executionAttemptId: attempt.execution_attempt_id, terminalReportDigest: attempt.terminal_report_digest, conflictingTerminalDigest: reportDigest } },
      { expected: 1, attempted: 1, verified: 0 },
      { message: "terminal evidence conflicts with the retained report", currentConfigRevision: assignment.config_revision, currentGovernanceEpoch: authority.governor.governance_epoch, evidence: { assignmentId: assignment.assignment_id, executionAttemptId: attempt.execution_attempt_id, terminalReportDigest: attempt.terminal_report_digest, conflictingTerminalDigest: reportDigest } },
      "TERMINAL_REPORT_AMBIGUOUS",
    );
  }
  if (attempt.state === "dispatch_unknown") throw refusal("DISPATCH_UNKNOWN", "ambiguous dispatch must be reconciled before terminal evidence");
  if (!attempt.native_receipt_digest || !attempt.actual_profile_digest || !attempt.thread_id || !terminalCorrelationMatches(assignment, attempt, report)) {
    throw refusal("EXECUTION_CONTEXT_FOREIGN", "terminal report does not match the exact assignment, native receipt, or executed profile");
  }
  if (report.candidateObservationDigest !== sha256(canonicalJson({ branchName: report.branchName, baseSha: report.baseSha, candidateSha: report.candidateSha }))) {
    throw refusal("ASSIGNMENT_HEAD_STALE", "terminal candidate observation digest is invalid");
  }
  const authority = revalidateAssignmentAuthority(db, request, assignment, attempt);
  const late = report.receivedAtMs > assignment.deadline_at_ms;
  const state = late || report.outcome === "BLOCKED" ? "blocked" : "done";
  const terminalResult = late ? "BLOCKED" : report.outcome;
  const reasonCode = late ? "terminal_report_late" : report.reasonCode;
  const updated = db.prepare(
    `UPDATE execution_attempts SET state = ?, terminal_result = ?, reported_outcome = ?, terminal_report_digest = ?,
     terminal_event_id = ?, terminal_event_seq = ?, candidate_sha = ?, reason_code = ?,
     completed_at_ms = ?, observed_at_ms = ?, last_event_seq = ?
     WHERE project_id = ? AND execution_attempt_id = ? AND state IN ('armed', 'content_delivered', 'running', 'failed')
       AND terminal_report_digest IS NULL`,
  ).run(
    state,
    terminalResult,
    report.outcome,
    reportDigest,
    report.receiptEventId,
    report.receiptEventSeq,
    report.candidateSha,
    reasonCode,
    report.receivedAtMs,
    report.receivedAtMs,
    report.receiptEventSeq,
    request.projectId,
    attempt.execution_attempt_id,
  );
  if (updated.changes !== 1) throw refusal("ASSIGNMENT_HEAD_STALE", "terminal attempt compare-and-swap failed");
  const aggregateRevision = nextAggregateRevision(db, request.projectId, "execution_attempt", attempt.execution_attempt_id);
  return commitMutation(
    db,
    request,
    digest,
    authority.actorReceiptId,
    { aggregateType: "execution_attempt", aggregateId: attempt.execution_attempt_id, aggregateRevision, eventType: "assignment_terminal_reported", event: { assignmentId: assignment.assignment_id, executionAttemptId: attempt.execution_attempt_id, state, terminalResult, reportedOutcome: report.outcome, terminalReportDigest: reportDigest, reasonCode } },
    { expected: 1, attempted: 1, verified: 1 },
    { currentConfigRevision: assignment.config_revision, currentGovernanceEpoch: authority.governor.governance_epoch, evidence: { assignmentId: assignment.assignment_id, executionAttemptId: attempt.execution_attempt_id, state, terminalResult, reportedOutcome: report.outcome, terminalReportDigest: reportDigest, reasonCode, deadlineAtMs: assignment.deadline_at_ms, receivedAtMs: report.receivedAtMs } },
  );
}

function applyAssignmentMutation(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  adapter: NativeAssignmentAdapter | null,
): FoundationResult {
  if (request.operationClass === "assignment_dispatch" || request.operationClass === "assignment_reconcile") {
    return applyAssignmentNative(db, request, digest, adapter, request.operationClass === "assignment_dispatch" ? "dispatch" : "reconcile");
  }
  try {
    let inspection: NativeAssignmentInspection | null = null;
    if (request.operationClass === "assignment_prepare") {
      const replay = checkIdempotency(db, request, digest);
      if (replay) return replay;
      if (!request.assignment || !request.repoTargetId) {
        throw refusal("EXECUTION_CONTEXT_FOREIGN", "assignment preparation requires immutable intent and one exact target");
      }
      if (!adapter) throw refusal("BB_FACTS_UNAVAILABLE", "assignment preparation requires one native BB fact adapter");
      transaction(db, () => preflightAssignmentPrepare(db, request));
      try {
        inspection = adapter.inspect({ projectId: request.projectId, repoTargetId: request.repoTargetId, assignment: request.assignment });
      } catch {
        throw refusal("BB_FACTS_UNAVAILABLE", "exact native BB/Git assignment facts are unavailable");
      }
    }
    return transaction(db, () => {
      const replay = checkIdempotency(db, request, digest);
      if (replay) return replay;
      return request.operationClass === "assignment_prepare"
        ? applyAssignmentPrepare(db, request, digest, inspection!)
        : applyAssignmentTerminal(db, request, digest);
    });
  } catch (error) {
    if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
    if (isConstraintError(error)) return unavailableResult(request.projectId, "canonical assignment mutation could not be committed unambiguously");
    return result("INTERNAL_ERROR", request.projectId, 1, 0, 0, { message: "internal assignment mutation error" });
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
  nativeAssignmentAdapter: NativeAssignmentAdapter | null = null,
  reviewFactReader: ReviewFactReader | null = null,
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
    if (["assignment_prepare", "assignment_dispatch", "assignment_reconcile", "assignment_terminal"].includes(request.operationClass)) {
      return applyAssignmentMutation(db, request, digest, nativeAssignmentAdapter);
    }
    if (request.operationClass === "decision_disposition") {
      return applyDecisionMutation(db, request, digest, reviewFactReader);
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
        case "decision_create":
          return applyDecisionCreate(db, request, digest);
        case "decision_disposition":
          throw refusal("INTERNAL_ERROR", "decision disposition must use the Decision resolver");
        case "work_item_create":
          return applyWorkItemCreate(db, request, digest);
        case "work_item_transition":
          return applyWorkItemTransition(db, request, digest);
        case "github_issue_projection":
          throw refusal("INTERNAL_ERROR", "projection must not run inside the canonical transaction");
        case "qualification_observation_record":
        case "role_generation_succession":
          throw refusal("INTERNAL_ERROR", "role fact operations must not run inside the canonical transaction");
        case "assignment_prepare":
        case "assignment_dispatch":
        case "assignment_reconcile":
        case "assignment_terminal":
          throw refusal("INTERNAL_ERROR", "assignment operations must use the assignment resolver");
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
    decision_dispositions: "decision_dispositions.decision_id, decision_dispositions.disposition_sequence",
    evidence_artifacts: "evidence_id",
    decision_evidence: "decision_evidence.decision_id, decision_evidence.evidence_sequence",
    mutation_receipts: "idempotency_key",
    state_events: "event_sequence",
    work_items: "work_item_id",
    external_work_refs: "work_item_id, provider",
    qualification_observations: "qualification_id",
    eligibility_projections: "role_requirement_id, profile_digest",
    assignments: "assignment_id",
    execution_attempts: "execution_attempt_id",
    role_generations: "role_id, generation",
    role_generation_heads: "role_id",
  };
  const query =
    table === "decision_dispositions" || table === "decision_evidence"
      ? `SELECT ${table}.* FROM ${table}
         JOIN decisions ON decisions.decision_id = ${table}.decision_id
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

function decisionDoctorEvidence(db: SqliteDatabase, projectId: string): {
  unresolvedDecisions: Array<{ decisionId: string; reason: string }>;
  issues: Array<{ decisionId?: string; evidenceId?: string; reason: string }>;
  derivedHolds: Array<{ decisionId: string; holdCode: string; setterSequence: number }>;
  artifactCount: number;
  relationCount: number;
} {
  const decisions = db.prepare("SELECT * FROM decisions WHERE project_id = ? ORDER BY decision_id").all(projectId) as DecisionRow[];
  const artifacts = db.prepare("SELECT * FROM evidence_artifacts WHERE project_id = ? ORDER BY evidence_id").all(projectId) as Array<Record<string, string | number | null>>;
  const unresolvedDecisions: Array<{ decisionId: string; reason: string }> = [];
  const issues: Array<{ decisionId?: string; evidenceId?: string; reason: string }> = [];
  const derivedHolds: Array<{ decisionId: string; holdCode: string; setterSequence: number }> = [];
  let relationCount = 0;
  for (const decision of decisions) {
    if (
      !(DECISION_CLASSES as readonly string[]).includes(decision.decision_class ?? "") ||
      !decision.options_json || !decision.decision_identity_digest ||
      decision.scope_digest !== sha256(decision.scope_json) ||
      storedDecisionIdentityDigest(decision) !== decision.decision_identity_digest
    ) {
      unresolvedDecisions.push({ decisionId: decision.decision_id, reason: "DECISION_IDENTITY_CONFLICT" });
    }
    const dispositions = db.prepare(
      "SELECT * FROM decision_dispositions WHERE decision_id = ? ORDER BY disposition_sequence",
    ).all(decision.decision_id) as Array<Record<string, string | number | null>>;
    const seenReverts = new Set<number>();
    const seenSupersedes = new Set<number>();
    const activeHolds = new Map<number, string>();
    for (const [index, disposition] of dispositions.entries()) {
      const sequence = Number(disposition.disposition_sequence);
      if (sequence !== index + 1) issues.push({ decisionId: decision.decision_id, reason: "disposition_sequence_not_contiguous" });
      const actor = asRow<{ actor_kind: string; project_id: string; verification_state: string; receipt_digest: string; subject_id: string; role_id: string | null; role_generation: number | null }>(
        db.prepare("SELECT * FROM actor_receipts WHERE receipt_id = ?").get(disposition.actor_receipt_id),
      );
      if (!actor || actor.project_id !== projectId || actor.verification_state !== "verified" || !["role", "operator"].includes(actor.actor_kind)) {
        issues.push({ decisionId: decision.decision_id, reason: "decision_actor_invalid" });
      } else {
        const receiptDigest = sha256(canonicalJson({
          projectId: actor.project_id,
          receiptId: disposition.actor_receipt_id,
          actorKind: actor.actor_kind,
          subjectId: actor.subject_id,
          roleId: actor.role_id,
          roleGeneration: actor.role_generation,
          verificationState: actor.verification_state,
        }));
        if (receiptDigest !== actor.receipt_digest) issues.push({ decisionId: decision.decision_id, reason: "decision_actor_digest_invalid" });
        if (actor.actor_kind === "role") {
          const role = asRow<{ current_generation: number; status: string; holder_execution_attempt_id: string; holder_context_digest: string; holder_executed_profile_digest: string; qualification_id: string; eligibility_derivation_digest: string; role_requirement_id: string }>(db.prepare(
            `SELECT role_generation_heads.current_generation, role_generations.status,
                    role_generations.holder_execution_attempt_id, role_generations.holder_context_digest,
                    role_generations.holder_executed_profile_digest, role_generations.qualification_id,
                    role_generations.eligibility_derivation_digest, role_generations.role_requirement_id
             FROM role_generation_heads JOIN role_generations
               ON role_generations.project_id = role_generation_heads.project_id
              AND role_generations.role_id = role_generation_heads.role_id
              AND role_generations.generation = role_generation_heads.current_generation
             WHERE role_generation_heads.project_id = ? AND role_generation_heads.role_id = ?`,
          ).get(projectId, actor.role_id));
          const holder = role && asRow<{ state: string; origin: string; native_receipt_digest: string | null; actual_profile_digest: string | null }>(
            db.prepare("SELECT state, origin, native_receipt_digest, actual_profile_digest FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ?").get(projectId, role.holder_execution_attempt_id),
          );
          const eligibility = role && asRow<{ current_qualification_id: string; effective_status: string; expires_at_ms: number | null; derivation_digest: string }>(db.prepare(
            "SELECT current_qualification_id, effective_status, expires_at_ms, derivation_digest FROM eligibility_projections WHERE project_id = ? AND role_requirement_id = ? AND profile_digest = ?",
          ).get(projectId, role.role_requirement_id, role.holder_executed_profile_digest));
          if (
            !role || actor.role_generation !== role.current_generation || role.status !== "active" || actor.subject_id !== role.holder_execution_attempt_id ||
            !holder || holder.origin !== "role_holder" || holder.state !== "done" || holder.native_receipt_digest !== role.holder_context_digest ||
            holder.actual_profile_digest !== role.holder_executed_profile_digest || !eligibility ||
            eligibility.current_qualification_id !== role.qualification_id || eligibility.effective_status !== "eligible" ||
            eligibility.derivation_digest !== role.eligibility_derivation_digest ||
            (eligibility.expires_at_ms !== null && eligibility.expires_at_ms <= now())
          ) {
            issues.push({ decisionId: decision.decision_id, reason: "decision_role_binding_invalid" });
          }
        }
      }
      try {
        const conditions = JSON.parse(String(disposition.conditions_json));
        if (canonicalJson(conditions) !== disposition.conditions_json || !Array.isArray(conditions)) throw new Error("invalid");
      } catch {
        issues.push({ decisionId: decision.decision_id, reason: "decision_conditions_invalid" });
      }
      for (const [kind, value, seen] of [
        ["supersedes", disposition.supersedes_disposition_sequence, seenSupersedes],
        ["reverts", disposition.reverts_disposition_sequence, seenReverts],
      ] as const) {
        if (value === null) continue;
        const reference = Number(value);
        if (reference >= sequence || reference < 1 || reference > dispositions.length || seen.has(reference)) {
          issues.push({ decisionId: decision.decision_id, reason: `${kind}_reference_invalid` });
        }
        seen.add(reference);
      }
      if (disposition.hold_action === "set" && typeof disposition.hold_code === "string") activeHolds.set(sequence, disposition.hold_code);
      if (disposition.hold_action === "clear") {
        const reference = Number(disposition.hold_reference_sequence);
        if (!activeHolds.has(reference) || activeHolds.get(reference) !== disposition.hold_code) {
          issues.push({ decisionId: decision.decision_id, reason: "hold_reference_invalid" });
        } else {
          activeHolds.delete(reference);
        }
      }
    }
    for (const [setterSequence, holdCode] of activeHolds) derivedHolds.push({ decisionId: decision.decision_id, holdCode, setterSequence });
    const relations = db.prepare(
      "SELECT * FROM decision_evidence WHERE project_id = ? AND decision_id = ? ORDER BY evidence_sequence",
    ).all(projectId, decision.decision_id) as Array<Record<string, string | number | null>>;
    relationCount += relations.length;
    for (const [index, relation] of relations.entries()) {
      if (Number(relation.evidence_sequence) !== index + 1) issues.push({ decisionId: decision.decision_id, reason: "evidence_sequence_not_contiguous" });
      if (!dispositions.some((row) => row.disposition_sequence === relation.disposition_sequence)) {
        issues.push({ decisionId: decision.decision_id, evidenceId: String(relation.evidence_id), reason: "evidence_disposition_unknown" });
      }
      if (!artifacts.some((artifact) => artifact.evidence_id === relation.evidence_id)) {
        issues.push({ decisionId: decision.decision_id, evidenceId: String(relation.evidence_id), reason: "evidence_artifact_unknown" });
      }
    }
  }
  for (const artifact of artifacts) {
    const evidenceId = String(artifact.evidence_id);
    try {
      const redacted = JSON.parse(String(artifact.redacted_json));
      const durableRef = JSON.parse(String(artifact.durable_ref_json));
      assertRedactedEvidence(redacted, "evidence redacted metadata");
      assertRedactedEvidence(durableRef, "evidence durable reference");
      const expectedIdentity = sha256(canonicalJson({
        projectId,
        evidenceId,
        evidenceKind: artifact.evidence_kind,
        sourceKind: artifact.source_kind,
        sourceRef: artifact.source_ref,
        executionAttemptId: artifact.execution_attempt_id,
        contentDigest: artifact.content_digest,
        redactedDigest: sha256(canonicalJson(redacted)),
        durableRef,
      }));
      if (
        canonicalJson(redacted) !== artifact.redacted_json || canonicalJson(durableRef) !== artifact.durable_ref_json ||
        sha256(canonicalJson(redacted)) !== artifact.redacted_digest || expectedIdentity !== artifact.artifact_identity_digest
      ) {
        issues.push({ evidenceId, reason: "evidence_artifact_digest_invalid" });
      }
    } catch {
      issues.push({ evidenceId, reason: "evidence_artifact_redaction_invalid" });
    }
    if (artifact.evidence_kind === "delegated_action_receipt") {
      const attempt = asRow<{ state: string; terminal_result: string | null; reported_outcome: string | null; terminal_report_digest: string | null; native_receipt_digest: string | null; actual_profile_digest: string | null; conflicting_terminal_digest: string | null }>(
        db.prepare("SELECT state, terminal_result, reported_outcome, terminal_report_digest, native_receipt_digest, actual_profile_digest, conflicting_terminal_digest FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ?").get(projectId, artifact.execution_attempt_id),
      );
      if (
        !attempt || attempt.state !== "done" || attempt.terminal_result !== "DONE" || attempt.reported_outcome !== "DONE" ||
        attempt.terminal_report_digest !== artifact.content_digest || !attempt.native_receipt_digest || !attempt.actual_profile_digest ||
        attempt.conflicting_terminal_digest !== null
      ) {
        issues.push({ evidenceId, reason: "delegated_evidence_binding_invalid" });
      }
    }
  }
  return { unresolvedDecisions, issues, derivedHolds, artifactCount: artifacts.length, relationCount };
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
              role_generations.holder_execution_attempt_id,
              execution_attempts.state AS holder_attempt_state,
              execution_attempts.native_receipt_digest AS holder_native_receipt_digest
       FROM role_generation_heads
       JOIN role_generations ON role_generations.project_id = role_generation_heads.project_id
         AND role_generations.role_id = role_generation_heads.role_id
         AND role_generations.generation = role_generation_heads.current_generation
       LEFT JOIN execution_attempts ON execution_attempts.project_id = role_generations.project_id
         AND execution_attempts.execution_attempt_id = role_generations.holder_execution_attempt_id
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
    const configJson = storedConfigJson(db, projectId, configHead.config_revision);
    const writingLaneCeiling = writingLaneCeilingFromJson(configJson);
    const assignmentAttempts = db.prepare(
      `SELECT assignments.assignment_id, assignments.assignment_kind, assignments.lane_id,
              assignments.repo_target_id, assignments.branch_name, assignments.base_sha,
              assignments.candidate_sha, assignments.environment_id, assignments.deadline_at_ms,
              assignments.requested_provider_id, assignments.requested_model,
              assignments.requested_reasoning_level, assignments.requested_permission_mode,
              assignments.requested_service_tier, assignments.requested_visibility,
              assignments.requested_profile_digest, execution_attempts.execution_attempt_id,
              execution_attempts.state, execution_attempts.thread_id, execution_attempts.native_request_id,
              execution_attempts.actual_provider_id, execution_attempts.actual_model,
              execution_attempts.actual_reasoning_level, execution_attempts.actual_permission_mode,
              execution_attempts.actual_service_tier, execution_attempts.actual_visibility,
              execution_attempts.actual_profile_digest, execution_attempts.native_receipt_digest,
              execution_attempts.terminal_result, execution_attempts.reported_outcome,
              execution_attempts.terminal_report_digest, execution_attempts.conflicting_terminal_digest,
              execution_attempts.reason_code, execution_attempts.last_event_seq
       FROM assignments JOIN execution_attempts
         ON execution_attempts.project_id = assignments.project_id
        AND execution_attempts.assignment_id = assignments.assignment_id
       WHERE assignments.project_id = ? ORDER BY assignments.assignment_id, execution_attempts.execution_attempt_id`,
    ).all(projectId) as Array<Record<string, unknown>>;
    const activeWriters = assignmentAttempts.filter(
      (row) => row.assignment_kind === "write" && (
        (ACTIVE_ASSIGNMENT_STATES as readonly unknown[]).includes(row.state) || row.conflicting_terminal_digest !== null
      ),
    );
    const unresolvedAttempts = assignmentAttempts.filter(
      (row) => row.state === "dispatch_unknown" || row.conflicting_terminal_digest !== null || row.terminal_report_digest === null,
    );
    const unresolvedRoleHolders = roleGenerationHeads
      .filter((row) => row.holder_attempt_state !== "done" || !row.holder_native_receipt_digest)
      .map((row) => ({ roleId: row.role_id, generation: row.current_generation, holderExecutionAttemptId: row.holder_execution_attempt_id, reason: "ROLE_HOLDER_UNRESOLVED" }));
    const decisionIntegrity = decisionDoctorEvidence(db, projectId);
    const cachedConsumers = cachedConsumerRolloutEvidence(SCHEMA_VERSION);
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
        unresolvedRoleHolders,
        qualificationObservationCount: observationCount,
        eligibility,
        assignments: assignmentAttempts,
        capacity: {
          writingLaneCeiling,
          activeWriterCount: activeWriters.length,
          activeWriterLaneIds: activeWriters.map((row) => row.lane_id),
          duplicateLaneIds: [...new Set(activeWriters.map((row) => row.lane_id).filter((laneId, index, all) => all.indexOf(laneId) !== index))],
          ceilingViolated: activeWriters.length > writingLaneCeiling,
        },
        unresolvedAttempts,
        decisionIntegrity,
        cachedConsumers,
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
