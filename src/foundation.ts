import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { readRoleHolderStates } from "./awareness.js";
import type { CheckoutDivergence } from "./checkout-divergence.js";
import { maintainedIssueBody } from "./github-issue-brief.js";

export const PLUGIN_ID = "bb-collab";
export const BB_VERSION_RANGE = ">=0.37.0";
export const PLUGIN_SDK_VERSION = "0.4.1";
// Runtime contract version; the separate instruction contract is INSTRUCTION_CONTRACT_VERSION in AGENTS.md.
export const RUNTIME_CONTRACT_VERSION = 35;
export const SCHEMA_VERSION = 35;
// v27 records correlated terminal evidence and first-class interrupted attempts.
const PREVIOUS_RUNTIME_CONTRACT_VERSION = 27;
export const DEFAULT_WRITING_LANE_CEILING = 3;
export const MAX_WRITING_LANE_CEILING = 3;
// Schema v32 repairs the append-only v31 migration ledger without changing runtime state.
const PREVIOUS_SCHEMA_VERSION = 32;
export const ROLE_IDS = ["director", "project-orchestrator", "worker", "independent-reviewer"] as const;
export const ROLE_GENERATION_EVENT_TYPES = ["role_generation_created", "role_generation_succeeded"] as const;
export type RoleGenerationEventType = (typeof ROLE_GENERATION_EVENT_TYPES)[number];
export type AuthenticatedNativeCaller = Readonly<{ projectId: string; threadId: string }>;

export function roleGenerationEventType(generation: number, predecessorGeneration: number | null): RoleGenerationEventType {
  if (generation === 1 && predecessorGeneration === null) return "role_generation_created";
  if (generation > 1 && predecessorGeneration !== null) return "role_generation_succeeded";
  throw new Error("role generation has no valid creation or succession semantics");
}
export const DIRECTOR_SEAT_ROLE_REQUIREMENT_ID = "director-seat" as const;
const directorSeatPrimaryProfile = {
  providerId: "claude-code",
  model: "claude-opus-5[1m]",
  reasoningLevel: "medium",
  permissionMode: "full",
  serviceTier: "default",
  visibility: "visible" as const,
};
const directorSeatSecondaryProfile = {
  providerId: "pi",
  model: "zai/glm-5.3",
  reasoningLevel: "high",
  permissionMode: "full",
  serviceTier: "default",
  visibility: "visible" as const,
};
const directorSeatK3Profile = {
  providerId: "pi",
  model: "kimi-coding/k3",
  reasoningLevel: "high",
  permissionMode: "full",
  serviceTier: "default",
  visibility: "visible" as const,
};
const directorSeatProfiles = [directorSeatPrimaryProfile, directorSeatSecondaryProfile, directorSeatK3Profile] as const;
export const LLM_COLLAB_SOURCE_FENCE = "f988d9711d3778f751e4ec0e32ebbf7b0893c80f" as const;
export const LLM_COLLAB_MERGED_MAIN_SHA = "0686d34" as const;
export const LLM_COLLAB_EVIDENCE_RESOURCE_REVISION = 4 as const;
export const EVIDENCE_ONLY_EQUIVALENCE_DISPOSITION =
  "no canonical state existed to migrate; historical archive preserved as evidence, read-only" as const;
// ponytail: page database reads at 256 rows; spill responses over 512 KiB to atomic files.
export const MAX_EXPORT_ROWS = 256;
export const ROLE_CONTEXT_EVENT_PAGE_SIZE = 256;
export const MAX_EXPORT_BYTES = 512 * 1024;
export const MAX_SOURCE_EVIDENCE_MANIFEST_BYTES = Math.floor(MAX_EXPORT_BYTES / 8);
export const TABLES = [
  "project_config_revisions",
  "project_config_heads",
  "orchestration_domains",
  "repository_targets",
  "project_governorships",
  "project_governorship_heads",
  "migration_runs",
  "actor_receipts",
  "bootstrap_derivation_receipts",
  "operator_receipts",
  "authorized_approvers",
  "decisions",
  "decision_dispositions",
  "evidence_artifacts",
  "decision_evidence",
  "mutation_receipts",
  "state_events",
  "work_items",
  "work_item_waits",
  "external_work_refs",
  "work_item_github_backfills",
  "qualification_observations",
  "eligibility_projections",
  "assignments",
  "execution_attempts",
  "role_generations",
  "role_generation_heads",
  "lane_capacity_intervals",
  "lane_capacity_refresh_evidence",
  "operator_messages",
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
  // Retained deliberately, not vestigial. The assignment subsystem was severed in full
  // (no reads, no writes), but this table cannot be dropped: execution_attempts
  // declares FOREIGN KEY (project_id, assignment_id) REFERENCES assignments, and SQLite
  // resolves an FK's parent table when it PREPARES the statement, not when it checks the
  // value. With foreign_keys=ON, dropping this table makes every execution_attempts insert
  // fail with "no such table: main.assignments" — including inserts whose assignment_id is
  // NULL. PRAGMA foreign_key_check comes back clean after the drop, so the damage does not
  // surface until the next write. Removing it therefore means rebuilding execution_attempts,
  // which holds live role-holder history, to buy a cosmetic line-count gain. Ruled 2026-08-18:
  // the table stays. GH-192 carries the reproduction and the ruling.
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
    state TEXT NOT NULL CHECK (state IN ('prepared', 'armed', 'content_delivered', 'running', 'done', 'blocked', 'failed', 'interrupted', 'dispatch_unknown')),
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
  `CREATE TABLE IF NOT EXISTS migration_runs (
    migration_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source_system TEXT NOT NULL DEFAULT 'llm-collab' CHECK (source_system = 'llm-collab'),
    source_runtime_id TEXT NOT NULL,
    target_runtime_id TEXT NOT NULL,
    source_contract_digest TEXT NOT NULL,
    source_schema_digest TEXT NOT NULL,
    source_export_digest TEXT,
    config_revision INTEGER NOT NULL CHECK (config_revision > 0),
    decision_id TEXT NOT NULL,
    decision_disposition_sequence INTEGER NOT NULL CHECK (decision_disposition_sequence > 0),
    state TEXT NOT NULL CHECK (state IN
      ('prepared', 'frozen', 'exported', 'imported', 'equivalent', 'target_active', 'exercised', 'retired', 'rolled_back', 'fix_forward_required')),
    resource_revision INTEGER NOT NULL CHECK (resource_revision > 0),
    source_event_ceiling INTEGER CHECK (source_event_ceiling IS NULL OR source_event_ceiling >= 0),
    source_snapshot_digest TEXT NOT NULL,
    source_governor_epoch INTEGER NOT NULL CHECK (source_governor_epoch > 0),
    target_governor_epoch INTEGER NOT NULL CHECK (target_governor_epoch > 0),
    mutator_inventory_digest TEXT,
    quiescence_digest TEXT,
    import_root_digest TEXT,
    equivalence_digest TEXT,
    recovery_digest TEXT,
    retention_until_ms INTEGER NOT NULL CHECK (retention_until_ms >= 0),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY (project_id, config_revision)
      REFERENCES project_config_revisions(project_id, config_revision),
    FOREIGN KEY (decision_id, decision_disposition_sequence)
      REFERENCES decision_dispositions(decision_id, disposition_sequence),
    FOREIGN KEY (project_id, source_governor_epoch)
      REFERENCES project_governorships(project_id, governance_epoch),
    FOREIGN KEY (project_id, target_governor_epoch)
      REFERENCES project_governorships(project_id, governance_epoch)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS migration_runs_final_export_identity
    ON migration_runs(source_system, project_id, source_export_digest)
    WHERE source_export_digest IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS migration_runs_one_open
    ON migration_runs(source_system, project_id)
    WHERE state NOT IN ('retired', 'rolled_back')`,
  `CREATE TABLE IF NOT EXISTS operator_receipts (
    project_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL UNIQUE,
    receipt_type TEXT NOT NULL CHECK (receipt_type = 'operator_confirmation'),
    mutation_class TEXT NOT NULL CHECK (mutation_class IN (
      'bootstrap', 'config_revision', 'governor_claim', 'decision_create',
      'decision_disposition', 'work_item_create', 'work_item_transition',
      'github_issue_projection', 'github_pr_observation_record', 'qualification_observation_record',
      'role_generation_succession', 'assignment_prepare', 'assignment_dispatch',
      'assignment_reconcile', 'assignment_terminal', 'migration_prepare',
      'migration_step'
    )),
    candidate_head TEXT NOT NULL CHECK (
      length(candidate_head) BETWEEN 40 AND 64
      AND candidate_head NOT GLOB '*[^0-9a-f]*'
    ),
    binding_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status = 'interim'),
    retirement_condition TEXT NOT NULL CHECK (retirement_condition = 'host-issued receipt get-bb/bb#1541'),
    caller_thread_id TEXT NOT NULL,
    caller_plugin_id TEXT NOT NULL,
    requested_from_background INTEGER NOT NULL CHECK (requested_from_background IN (0, 1)),
    receipt_digest TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (project_id, receipt_id)
  )`,
  `ALTER TABLE operator_receipts ADD COLUMN idempotency_key TEXT;
   ALTER TABLE operator_receipts ADD COLUMN request_digest TEXT;
   ALTER TABLE operator_receipts ADD COLUMN consumed_at_ms INTEGER;
   ALTER TABLE operator_receipts ADD COLUMN consumed_event_sequence INTEGER;
   ALTER TABLE state_events ADD COLUMN operator_receipt_id TEXT;
   ALTER TABLE mutation_receipts ADD COLUMN operator_receipt_id TEXT`,
  `ALTER TABLE actor_receipts ADD COLUMN operator_receipt_id TEXT;
   ALTER TABLE actor_receipts ADD COLUMN retirement_condition TEXT`,
  `CREATE TABLE IF NOT EXISTS authorized_approvers (
    project_id TEXT NOT NULL,
    approver_id TEXT NOT NULL,
    authorizing_decision_id TEXT NOT NULL,
    authorizing_disposition_sequence INTEGER NOT NULL CHECK (authorizing_disposition_sequence > 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    allowed_mutation_classes_json TEXT NOT NULL CHECK (json_valid(allowed_mutation_classes_json)),
    retirement_condition TEXT NOT NULL CHECK (retirement_condition = 'host-issued receipt get-bb/bb#1541'),
    created_at_ms INTEGER NOT NULL,
    revoked_at_ms INTEGER,
    PRIMARY KEY (project_id, approver_id, authorizing_decision_id, authorizing_disposition_sequence),
    FOREIGN KEY (authorizing_decision_id, authorizing_disposition_sequence)
      REFERENCES decision_dispositions(decision_id, disposition_sequence),
    CHECK ((status = 'active' AND revoked_at_ms IS NULL) OR (status = 'revoked' AND revoked_at_ms IS NOT NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS authorized_approvers_one_active
    ON authorized_approvers(project_id, approver_id) WHERE status = 'active';
  ALTER TABLE operator_receipts ADD COLUMN approver_id TEXT;
  ALTER TABLE operator_receipts ADD COLUMN authorizing_decision_id TEXT;
  ALTER TABLE operator_receipts ADD COLUMN authorizing_disposition_sequence INTEGER;`,
  `ALTER TABLE role_generations ADD COLUMN standby_profile_json TEXT
   CHECK (standby_profile_json IS NULL OR json_valid(standby_profile_json))`,
  `ALTER TABLE operator_receipts ADD COLUMN issuance_provenance TEXT
   CHECK (issuance_provenance IN ('console', 'attestation') OR issuance_provenance IS NULL)`,
  `CREATE TABLE IF NOT EXISTS work_item_waits (
    project_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    waker TEXT NOT NULL,
    declared_at_ms INTEGER NOT NULL CHECK (declared_at_ms >= 0),
    declared_by_seat TEXT NOT NULL,
    PRIMARY KEY (project_id, work_item_id),
    FOREIGN KEY (project_id, work_item_id)
      REFERENCES work_items(project_id, work_item_id)
  )`,
  `ALTER TABLE work_item_waits ADD COLUMN waker_kind TEXT NOT NULL DEFAULT 'schedule'
   CHECK (waker_kind IN ('schedule', 'seat'))`,
  `CREATE TABLE IF NOT EXISTS operator_messages (
    message_id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL CHECK (length(project_id) > 0),
    recipient TEXT NOT NULL CHECK (recipient IN ('operator', 'supervisor')),
    sender_thread_id TEXT NOT NULL CHECK (length(sender_thread_id) > 0),
    severity TEXT NOT NULL CHECK (severity IN ('routine', 'needs-decision', 'urgent')),
    message_text TEXT NOT NULL CHECK (length(trim(message_text)) > 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    read_at_ms INTEGER CHECK (read_at_ms IS NULL OR read_at_ms >= created_at_ms),
    replied_at_ms INTEGER CHECK (replied_at_ms IS NULL OR replied_at_ms >= created_at_ms),
    reply_text TEXT,
    reply_delivery_error TEXT,
    notification_attempted_at_ms INTEGER,
    notification_error TEXT,
    FOREIGN KEY (project_id) REFERENCES project_config_heads(project_id),
    CHECK (reply_text IS NULL OR length(trim(reply_text)) > 0),
    CHECK (replied_at_ms IS NULL OR reply_text IS NOT NULL),
    CHECK (reply_delivery_error IS NULL OR (replied_at_ms IS NULL AND reply_text IS NOT NULL))
  )`,
  `PRAGMA defer_foreign_keys = ON;
  CREATE TABLE execution_attempts_gh300 (
    project_id TEXT NOT NULL,
    execution_attempt_id TEXT NOT NULL,
    assignment_id TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('assignment', 'role_holder', 'legacy_unresolved', 'work_item')),
    assignment_digest TEXT,
    lane_id TEXT,
    assignment_kind TEXT CHECK (assignment_kind IS NULL OR assignment_kind IN ('write', 'review', 'probe')),
    attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal > 0),
    dispatch_kind TEXT CHECK (dispatch_kind IS NULL OR dispatch_kind IN ('spawn', 'attach')),
    config_revision INTEGER NOT NULL,
    governance_epoch INTEGER CHECK (governance_epoch IS NULL OR governance_epoch > 0),
    work_item_id TEXT,
    repo_target_id TEXT,
    role_id TEXT,
    role_generation INTEGER CHECK (role_generation IS NULL OR role_generation > 0),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'armed', 'content_delivered', 'running', 'done', 'blocked', 'failed', 'interrupted', 'dispatch_unknown', 'superseded')),
    bb_server_id TEXT,
    environment_id TEXT,
    source_id TEXT,
    host_id TEXT,
    environment_path TEXT,
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
    environment_digest TEXT,
    native_receipt_digest TEXT,
    terminal_result TEXT CHECK (terminal_result IS NULL OR terminal_result IN ('DONE', 'BLOCKED')),
    reported_outcome TEXT CHECK (reported_outcome IS NULL OR reported_outcome IN ('DONE', 'BLOCKED')),
    terminal_report_digest TEXT,
    conflicting_terminal_digest TEXT,
    reason_code TEXT,
    last_event_seq INTEGER,
    progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
    lease_owner_thread_id TEXT,
    lease_expires_at_ms INTEGER CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
    continuation_of_attempt_id TEXT,
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
           (origin IN ('role_holder', 'legacy_unresolved', 'work_item') AND assignment_id IS NULL)),
    CHECK ((origin = 'work_item' AND work_item_id IS NOT NULL AND lane_id IS NOT NULL AND assignment_kind IS NOT NULL) OR
           origin != 'work_item'),
    CHECK (origin = 'work_item' OR
           (role_id IS NOT NULL AND role_generation IS NOT NULL AND governance_epoch IS NOT NULL AND
            bb_server_id IS NOT NULL AND environment_id IS NOT NULL AND source_id IS NOT NULL AND
            host_id IS NOT NULL AND environment_path IS NOT NULL AND environment_digest IS NOT NULL))
  );
  INSERT INTO execution_attempts_gh300 (
    project_id, execution_attempt_id, assignment_id, origin, assignment_digest, lane_id,
    assignment_kind, attempt_ordinal, dispatch_kind, config_revision, governance_epoch,
    work_item_id, repo_target_id, role_id, role_generation, state, bb_server_id,
    environment_id, source_id, host_id, environment_path, thread_id, provider_thread_id,
    native_request_id, request_event_id, request_event_seq, accepted_event_id, accepted_event_seq,
    first_action_event_id, first_action_event_seq, content_event_id, content_event_seq,
    completion_event_id, completion_event_seq, terminal_event_id, terminal_event_seq,
    frozen_brief_digest, content_receipt_digest, actual_provider_id, actual_model,
    actual_reasoning_level, actual_permission_mode, actual_service_tier, actual_visibility,
    actual_profile_digest, branch_name, base_sha, candidate_sha, environment_digest,
    native_receipt_digest, terminal_result, reported_outcome, terminal_report_digest,
    conflicting_terminal_digest, reason_code, last_event_seq, progress_json,
    lease_owner_thread_id, lease_expires_at_ms, continuation_of_attempt_id, created_at_ms,
    observed_at_ms, completed_at_ms, attempt_digest
  ) SELECT
    project_id, execution_attempt_id, assignment_id, origin, assignment_digest, lane_id,
    assignment_kind, attempt_ordinal, dispatch_kind, config_revision, governance_epoch,
    work_item_id, repo_target_id, role_id, role_generation, state, bb_server_id,
    environment_id, source_id, host_id, environment_path, thread_id, provider_thread_id,
    native_request_id, request_event_id, request_event_seq, accepted_event_id, accepted_event_seq,
    first_action_event_id, first_action_event_seq, content_event_id, content_event_seq,
    completion_event_id, completion_event_seq, terminal_event_id, terminal_event_seq,
    frozen_brief_digest, content_receipt_digest, actual_provider_id, actual_model,
    actual_reasoning_level, actual_permission_mode, actual_service_tier, actual_visibility,
    actual_profile_digest, branch_name, base_sha, candidate_sha, environment_digest,
    native_receipt_digest, terminal_result, reported_outcome, terminal_report_digest,
    conflicting_terminal_digest, reason_code, last_event_seq, '{}', NULL, NULL, NULL,
    created_at_ms, observed_at_ms, completed_at_ms, attempt_digest
  FROM execution_attempts;
  DROP TABLE execution_attempts;
  ALTER TABLE execution_attempts_gh300 RENAME TO execution_attempts;
  CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_active_assignment
    ON execution_attempts(project_id, assignment_digest)
    WHERE origin = 'assignment' AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown');
  CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_active_writer_lane
    ON execution_attempts(project_id, lane_id)
    WHERE origin IN ('assignment', 'work_item') AND assignment_kind = 'write'
      AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown');
  CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_active_work_item
    ON execution_attempts(project_id, work_item_id)
    WHERE origin = 'work_item' AND assignment_kind = 'write'
      AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown');
  CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_active_writer_thread
    ON execution_attempts(project_id, thread_id)
    WHERE origin = 'work_item' AND assignment_kind = 'write' AND thread_id IS NOT NULL
      AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown');
  CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_native_request
    ON execution_attempts(bb_server_id, thread_id, native_request_id)
    WHERE thread_id IS NOT NULL AND native_request_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS execution_attempts_project_state
    ON execution_attempts(project_id, state, assignment_kind, lane_id)`,
  `PRAGMA defer_foreign_keys = ON;
  CREATE TABLE work_items_gh295 (
    project_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    config_revision INTEGER NOT NULL,
    repo_target_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL
      CHECK (lifecycle_state IN ('proposed', 'ready', 'in_progress', 'review_pending', 'succeeded', 'failed', 'cancelled')),
    resource_revision INTEGER NOT NULL CHECK (resource_revision > 0),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (project_id, work_item_id),
    FOREIGN KEY (project_id, config_revision)
      REFERENCES project_config_revisions(project_id, config_revision),
    FOREIGN KEY (project_id, repo_target_id, config_revision)
      REFERENCES repository_targets(project_id, repo_target_id, config_revision)
  );
  INSERT INTO work_items_gh295 (
    project_id, work_item_id, config_revision, repo_target_id, title, body,
    lifecycle_state, resource_revision, created_at_ms, updated_at_ms
  ) SELECT
    project_id, work_item_id, config_revision, repo_target_id, title, body,
    lifecycle_state, resource_revision, created_at_ms, updated_at_ms
  FROM work_items;
  DROP TABLE work_items;
  ALTER TABLE work_items_gh295 RENAME TO work_items`,
  `CREATE TABLE IF NOT EXISTS work_item_github_backfills (
    project_id TEXT PRIMARY KEY,
    epoch_created_at_ms INTEGER NOT NULL CHECK (epoch_created_at_ms >= 0),
    state TEXT NOT NULL CHECK (state IN ('attempted', 'completed', 'degraded')),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `ALTER TABLE work_item_github_backfills
     ADD COLUMN config_revision INTEGER CHECK (config_revision IS NULL OR config_revision > 0);
   ALTER TABLE work_item_github_backfills
     ADD COLUMN attempt_reason TEXT CHECK (attempt_reason IS NULL OR attempt_reason IN ('initial', 'config_revision_changed'))`,
  `ALTER TABLE execution_attempts ADD COLUMN review_pr_number INTEGER CHECK (review_pr_number IS NULL OR review_pr_number > 0);
   ALTER TABLE execution_attempts ADD COLUMN review_pr_head_sha TEXT CHECK (review_pr_head_sha IS NULL OR review_pr_head_sha GLOB '[0-9a-f]*');`,
  `ALTER TABLE execution_attempts RENAME COLUMN actual_provider_id TO requested_provider_id;
   ALTER TABLE execution_attempts RENAME COLUMN actual_model TO requested_model;
   ALTER TABLE execution_attempts RENAME COLUMN actual_reasoning_level TO requested_reasoning_level;
   ALTER TABLE execution_attempts RENAME COLUMN actual_permission_mode TO requested_permission_mode;
   ALTER TABLE execution_attempts RENAME COLUMN actual_service_tier TO requested_service_tier;
   ALTER TABLE execution_attempts RENAME COLUMN actual_visibility TO requested_visibility;
   ALTER TABLE execution_attempts RENAME COLUMN actual_profile_digest TO requested_profile_digest;
   ALTER TABLE qualification_observations RENAME COLUMN executed_profile_digest TO requested_profile_digest;
   ALTER TABLE qualification_observations RENAME COLUMN provider_id TO requested_provider_id;
   ALTER TABLE qualification_observations RENAME COLUMN model TO requested_model;
   ALTER TABLE qualification_observations RENAME COLUMN reasoning_level TO requested_reasoning_level;
   ALTER TABLE qualification_observations RENAME COLUMN permission_mode TO requested_permission_mode;
   ALTER TABLE qualification_observations RENAME COLUMN service_tier TO requested_service_tier;
   ALTER TABLE qualification_observations RENAME COLUMN visibility TO requested_visibility;
   ALTER TABLE eligibility_projections RENAME COLUMN profile_digest TO requested_profile_digest;
   ALTER TABLE role_generations RENAME COLUMN holder_executed_profile_digest TO holder_requested_profile_digest;`,
  `PRAGMA defer_foreign_keys = ON;
   CREATE TEMP TABLE gh200_assignments AS SELECT * FROM assignments;
   CREATE TEMP TABLE gh200_external_work_refs AS SELECT * FROM external_work_refs;
   CREATE TEMP TABLE gh200_work_item_waits AS SELECT * FROM work_item_waits;
   DELETE FROM assignments;
   DELETE FROM external_work_refs;
   DELETE FROM work_item_waits;
   CREATE TABLE work_items_gh200 (
     project_id TEXT NOT NULL,
     work_item_id TEXT NOT NULL,
     config_revision INTEGER NOT NULL,
     repo_target_id TEXT NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     lifecycle_state TEXT NOT NULL
       CHECK (lifecycle_state IN ('proposed', 'ready', 'in_progress', 'review_pending', 'blocked', 'succeeded', 'failed', 'cancelled')),
     resource_revision INTEGER NOT NULL CHECK (resource_revision > 0),
     created_at_ms INTEGER NOT NULL,
     updated_at_ms INTEGER NOT NULL,
     PRIMARY KEY (project_id, work_item_id),
     FOREIGN KEY (project_id, config_revision)
       REFERENCES project_config_revisions(project_id, config_revision),
     FOREIGN KEY (project_id, repo_target_id, config_revision)
       REFERENCES repository_targets(project_id, repo_target_id, config_revision)
   );
   INSERT INTO work_items_gh200 SELECT * FROM work_items;
   DROP TABLE work_items;
   ALTER TABLE work_items_gh200 RENAME TO work_items;
   CREATE TABLE work_item_waits_gh200 (
     project_id TEXT NOT NULL,
     work_item_id TEXT NOT NULL,
     waker TEXT NOT NULL,
     declared_at_ms INTEGER NOT NULL CHECK (declared_at_ms >= 0),
     declared_by_seat TEXT NOT NULL,
     waker_kind TEXT NOT NULL
       CHECK (waker_kind IN ('schedule', 'seat', 'work_item_succeeded', 'github_issue_closed')),
     note TEXT CHECK (note IS NULL OR length(note) <= 4096),
     PRIMARY KEY (project_id, work_item_id),
     FOREIGN KEY (project_id, work_item_id)
       REFERENCES work_items(project_id, work_item_id)
   );
   DROP TABLE work_item_waits;
   ALTER TABLE work_item_waits_gh200 RENAME TO work_item_waits;
   INSERT INTO assignments SELECT * FROM gh200_assignments;
   INSERT INTO external_work_refs SELECT * FROM gh200_external_work_refs;
   INSERT INTO work_item_waits (
     project_id, work_item_id, waker, declared_at_ms, declared_by_seat, waker_kind, note
   ) SELECT project_id, work_item_id, waker, declared_at_ms, declared_by_seat, waker_kind, NULL
     FROM gh200_work_item_waits;
   DROP TABLE gh200_assignments;
   DROP TABLE gh200_external_work_refs;
   DROP TABLE gh200_work_item_waits;`,
  `CREATE TABLE IF NOT EXISTS lane_capacity_intervals (
    interval_id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL CHECK (length(project_id) > 0),
    orchestrator_thread_id TEXT NOT NULL CHECK (length(orchestrator_thread_id) > 0),
    orchestrator_role_generation INTEGER NOT NULL CHECK (orchestrator_role_generation > 0),
    coverage_state TEXT NOT NULL CHECK (coverage_state IN ('known', 'blind')),
    active_lane_count INTEGER CHECK (active_lane_count IS NULL OR active_lane_count >= 0),
    writing_lane_ceiling INTEGER CHECK (writing_lane_ceiling IS NULL OR writing_lane_ceiling >= 0),
    startable_work INTEGER CHECK (startable_work IS NULL OR startable_work IN (0, 1)),
    reason TEXT,
    started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
    last_confirmed_at_ms INTEGER NOT NULL CHECK (last_confirmed_at_ms >= started_at_ms),
    ended_at_ms INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= started_at_ms),
    FOREIGN KEY (project_id) REFERENCES project_config_heads(project_id),
    CHECK ((coverage_state = 'known' AND active_lane_count IS NOT NULL AND writing_lane_ceiling IS NOT NULL AND startable_work IS NOT NULL AND reason IS NULL)
      OR (coverage_state = 'blind' AND reason IS NOT NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS lane_capacity_intervals_one_open
    ON lane_capacity_intervals(project_id) WHERE ended_at_ms IS NULL;`,
  `ALTER TABLE execution_attempts ADD COLUMN lane_capacity_observation_id TEXT
     CHECK (lane_capacity_observation_id IS NULL OR length(lane_capacity_observation_id) > 0);
   ALTER TABLE lane_capacity_intervals ADD COLUMN lane_capacity_observation_id TEXT
     CHECK (lane_capacity_observation_id IS NULL OR length(lane_capacity_observation_id) > 0);
   CREATE TRIGGER execution_attempts_lane_capacity_observation_immutable
     BEFORE UPDATE OF lane_capacity_observation_id ON execution_attempts
     WHEN OLD.lane_capacity_observation_id IS NOT NULL
       AND NEW.lane_capacity_observation_id IS NOT OLD.lane_capacity_observation_id
     BEGIN SELECT RAISE(ABORT, 'lane capacity observation identifier is immutable'); END;
   CREATE TRIGGER lane_capacity_intervals_observation_immutable
     BEFORE UPDATE OF lane_capacity_observation_id ON lane_capacity_intervals
     WHEN NEW.lane_capacity_observation_id IS NOT OLD.lane_capacity_observation_id
     BEGIN SELECT RAISE(ABORT, 'lane capacity observation identifier is immutable'); END;`,
  `CREATE TABLE IF NOT EXISTS lane_capacity_refresh_evidence (
    project_id TEXT NOT NULL CHECK (length(project_id) > 0),
    lane_capacity_observation_id TEXT NOT NULL CHECK (length(lane_capacity_observation_id) > 0),
    execution_attempt_id TEXT NOT NULL CHECK (length(execution_attempt_id) > 0),
    observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
    PRIMARY KEY (project_id, lane_capacity_observation_id, execution_attempt_id),
    FOREIGN KEY (project_id, execution_attempt_id)
      REFERENCES execution_attempts(project_id, execution_attempt_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS lane_capacity_intervals_observation_id
    ON lane_capacity_intervals(project_id, lane_capacity_observation_id)
    WHERE lane_capacity_observation_id IS NOT NULL;`,
  `CREATE TRIGGER lane_capacity_refresh_evidence_immutable_update
     BEFORE UPDATE ON lane_capacity_refresh_evidence
     BEGIN SELECT RAISE(ABORT, 'lane capacity refresh evidence is immutable'); END;
   CREATE TRIGGER lane_capacity_refresh_evidence_immutable_delete
     BEFORE DELETE ON lane_capacity_refresh_evidence
     BEGIN SELECT RAISE(ABORT, 'lane capacity refresh evidence is immutable'); END;`,
  `ALTER TABLE operator_messages ADD COLUMN archived_at_ms INTEGER
   CHECK (archived_at_ms IS NULL OR archived_at_ms >= created_at_ms)`,
  `CREATE TABLE IF NOT EXISTS bootstrap_derivation_receipts (
    project_id TEXT NOT NULL,
    derivation_id TEXT NOT NULL UNIQUE,
    genesis_receipt_id TEXT NOT NULL UNIQUE,
    source_project_id TEXT NOT NULL,
    source_governance_epoch INTEGER NOT NULL CHECK (source_governance_epoch > 0),
    source_fence_token TEXT NOT NULL,
    source_governor_actor_receipt_id TEXT NOT NULL,
    authorizing_decision_id TEXT NOT NULL,
    authorizing_disposition_sequence INTEGER NOT NULL CHECK (authorizing_disposition_sequence > 0),
    request_digest TEXT NOT NULL,
    consumed_at_ms INTEGER NOT NULL CHECK (consumed_at_ms >= 0),
    FOREIGN KEY (source_project_id, source_governance_epoch)
      REFERENCES project_governorships(project_id, governance_epoch),
    FOREIGN KEY (source_project_id, source_governor_actor_receipt_id)
      REFERENCES actor_receipts(project_id, receipt_id),
    FOREIGN KEY (authorizing_decision_id, authorizing_disposition_sequence)
      REFERENCES decision_dispositions(decision_id, disposition_sequence),
    PRIMARY KEY (project_id, derivation_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS bootstrap_derivation_one_per_target
    ON bootstrap_derivation_receipts(project_id);`,
  `ALTER TABLE bootstrap_derivation_receipts ADD COLUMN operational_actor_receipt_id TEXT;`,
  `ALTER TABLE decisions ADD COLUMN authority_root_json TEXT CHECK (authority_root_json IS NULL OR json_valid(authority_root_json));
   ALTER TABLE decisions ADD COLUMN authority_root_digest TEXT`,
  `PRAGMA defer_foreign_keys = ON;
   CREATE TABLE execution_attempts_gh624 (
     project_id TEXT NOT NULL,
     execution_attempt_id TEXT NOT NULL,
     assignment_id TEXT,
     origin TEXT NOT NULL CHECK (origin IN ('assignment', 'role_holder', 'legacy_unresolved', 'work_item')),
     assignment_digest TEXT,
     lane_id TEXT,
     assignment_kind TEXT CHECK (assignment_kind IS NULL OR assignment_kind IN ('write', 'review', 'probe')),
     attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal > 0),
     dispatch_kind TEXT CHECK (dispatch_kind IS NULL OR dispatch_kind IN ('spawn', 'attach')),
     config_revision INTEGER NOT NULL,
     governance_epoch INTEGER CHECK (governance_epoch IS NULL OR governance_epoch > 0),
     work_item_id TEXT,
     repo_target_id TEXT,
     role_id TEXT,
     role_generation INTEGER CHECK (role_generation IS NULL OR role_generation > 0),
     state TEXT NOT NULL CHECK (state IN ('prepared', 'armed', 'content_delivered', 'running', 'done', 'blocked', 'failed', 'interrupted', 'dispatch_unknown', 'superseded')),
     bb_server_id TEXT,
     environment_id TEXT,
     source_id TEXT,
     host_id TEXT,
     environment_path TEXT,
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
     requested_provider_id TEXT,
     requested_model TEXT,
     requested_reasoning_level TEXT,
     requested_permission_mode TEXT,
     requested_service_tier TEXT,
     requested_visibility TEXT CHECK (requested_visibility IS NULL OR requested_visibility IN ('visible', 'hidden')),
     requested_profile_digest TEXT,
     branch_name TEXT,
     base_sha TEXT,
     candidate_sha TEXT,
     environment_digest TEXT,
     native_receipt_digest TEXT,
     terminal_result TEXT CHECK (terminal_result IS NULL OR terminal_result IN ('DONE', 'BLOCKED')),
     reported_outcome TEXT CHECK (reported_outcome IS NULL OR reported_outcome IN ('DONE', 'BLOCKED')),
     terminal_report_digest TEXT,
     conflicting_terminal_digest TEXT,
     reason_code TEXT,
     last_event_seq INTEGER,
     progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
     lease_owner_thread_id TEXT,
     lease_expires_at_ms INTEGER CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
     continuation_of_attempt_id TEXT,
     created_at_ms INTEGER NOT NULL,
     observed_at_ms INTEGER,
     completed_at_ms INTEGER,
     attempt_digest TEXT NOT NULL,
     review_pr_number INTEGER CHECK (review_pr_number IS NULL OR review_pr_number > 0),
     review_pr_head_sha TEXT CHECK (review_pr_head_sha IS NULL OR review_pr_head_sha GLOB '[0-9a-f]*'),
     lane_capacity_observation_id TEXT CHECK (lane_capacity_observation_id IS NULL OR length(lane_capacity_observation_id) > 0),
     terminalization_class TEXT,
     terminal_report_json TEXT CHECK (terminal_report_json IS NULL OR json_valid(terminal_report_json)),
     terminal_actual_profile_digest TEXT,
     interruption_reason TEXT,
     interruption_event_id TEXT,
     interruption_event_seq INTEGER,
     interruption_turn_id TEXT,
     interruption_evidence_digest TEXT,
     PRIMARY KEY (project_id, execution_attempt_id),
     FOREIGN KEY (project_id, assignment_id) REFERENCES assignments(project_id, assignment_id),
     FOREIGN KEY (project_id, repo_target_id, config_revision) REFERENCES repository_targets(project_id, repo_target_id, config_revision),
     CHECK ((origin = 'assignment' AND assignment_id IS NOT NULL AND assignment_digest IS NOT NULL AND lane_id IS NOT NULL AND assignment_kind IS NOT NULL) OR
       (origin IN ('role_holder', 'legacy_unresolved', 'work_item') AND assignment_id IS NULL)),
     CHECK ((origin = 'work_item' AND work_item_id IS NOT NULL AND lane_id IS NOT NULL AND assignment_kind IS NOT NULL) OR origin != 'work_item'),
     CHECK (origin = 'work_item' OR
       (role_id IS NOT NULL AND role_generation IS NOT NULL AND governance_epoch IS NOT NULL AND bb_server_id IS NOT NULL AND
        environment_id IS NOT NULL AND source_id IS NOT NULL AND host_id IS NOT NULL AND environment_path IS NOT NULL AND environment_digest IS NOT NULL))
   );
   INSERT INTO execution_attempts_gh624 (
     project_id, execution_attempt_id, assignment_id, origin, assignment_digest, lane_id, assignment_kind, attempt_ordinal,
     dispatch_kind, config_revision, governance_epoch, work_item_id, repo_target_id, role_id, role_generation, state,
     bb_server_id, environment_id, source_id, host_id, environment_path, thread_id, provider_thread_id, native_request_id,
     request_event_id, request_event_seq, accepted_event_id, accepted_event_seq, first_action_event_id, first_action_event_seq,
     content_event_id, content_event_seq, completion_event_id, completion_event_seq, terminal_event_id, terminal_event_seq,
     frozen_brief_digest, content_receipt_digest, requested_provider_id, requested_model, requested_reasoning_level,
     requested_permission_mode, requested_service_tier, requested_visibility, requested_profile_digest, branch_name, base_sha,
     candidate_sha, environment_digest, native_receipt_digest, terminal_result, reported_outcome, terminal_report_digest,
     conflicting_terminal_digest, reason_code, last_event_seq, progress_json, lease_owner_thread_id, lease_expires_at_ms,
     continuation_of_attempt_id, created_at_ms, observed_at_ms, completed_at_ms, attempt_digest, review_pr_number,
     review_pr_head_sha, lane_capacity_observation_id, terminalization_class, terminal_report_json, terminal_actual_profile_digest,
     interruption_reason, interruption_event_id, interruption_event_seq, interruption_turn_id, interruption_evidence_digest
   ) SELECT project_id, execution_attempt_id, assignment_id, origin, assignment_digest, lane_id, assignment_kind, attempt_ordinal,
     dispatch_kind, config_revision, governance_epoch, work_item_id, repo_target_id, role_id, role_generation, state,
     bb_server_id, environment_id, source_id, host_id, environment_path, thread_id, provider_thread_id, native_request_id,
     request_event_id, request_event_seq, accepted_event_id, accepted_event_seq, first_action_event_id, first_action_event_seq,
     content_event_id, content_event_seq, completion_event_id, completion_event_seq, terminal_event_id, terminal_event_seq,
     frozen_brief_digest, content_receipt_digest, requested_provider_id, requested_model, requested_reasoning_level,
     requested_permission_mode, requested_service_tier, requested_visibility, requested_profile_digest, branch_name, base_sha,
     candidate_sha, environment_digest, native_receipt_digest, terminal_result, reported_outcome, terminal_report_digest,
     conflicting_terminal_digest, reason_code, last_event_seq, progress_json, lease_owner_thread_id, lease_expires_at_ms,
     continuation_of_attempt_id, created_at_ms, observed_at_ms, completed_at_ms, attempt_digest, review_pr_number,
     review_pr_head_sha, lane_capacity_observation_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
   FROM execution_attempts;
   DROP TABLE execution_attempts;
   ALTER TABLE execution_attempts_gh624 RENAME TO execution_attempts;
   CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_active_assignment
     ON execution_attempts(project_id, assignment_digest)
     WHERE origin = 'assignment' AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown');
   CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_active_writer_lane
     ON execution_attempts(project_id, lane_id)
     WHERE origin IN ('assignment', 'work_item') AND assignment_kind = 'write'
       AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown');
   CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_active_work_item
     ON execution_attempts(project_id, work_item_id)
     WHERE origin = 'work_item' AND assignment_kind = 'write'
       AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown');
   CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_active_writer_thread
     ON execution_attempts(project_id, thread_id)
     WHERE origin = 'work_item' AND assignment_kind = 'write' AND thread_id IS NOT NULL
       AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown');
   CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_native_request
     ON execution_attempts(bb_server_id, thread_id, native_request_id)
     WHERE thread_id IS NOT NULL AND native_request_id IS NOT NULL;
   CREATE INDEX IF NOT EXISTS execution_attempts_project_state
     ON execution_attempts(project_id, state, assignment_kind, lane_id);
   CREATE INDEX IF NOT EXISTS execution_attempts_interrupted_pending
     ON execution_attempts(project_id, work_item_id, attempt_ordinal)
     WHERE origin = 'work_item' AND state = 'interrupted';
   CREATE TRIGGER execution_attempts_lane_capacity_observation_immutable
     BEFORE UPDATE OF lane_capacity_observation_id ON execution_attempts
     WHEN OLD.lane_capacity_observation_id IS NOT NULL AND NEW.lane_capacity_observation_id IS NOT OLD.lane_capacity_observation_id
     BEGIN SELECT RAISE(ABORT, 'lane capacity observation identifier is immutable'); END;`,
];

const GH636_REPAIR_CHILD_TABLES = `   ALTER TABLE decision_evidence RENAME TO execution_attempts_gh636_decision_evidence;
   ALTER TABLE evidence_artifacts RENAME TO execution_attempts_gh636_evidence_artifacts;
   ALTER TABLE lane_capacity_refresh_evidence RENAME TO execution_attempts_gh636_lane_capacity_refresh_evidence;
   DROP TRIGGER lane_capacity_refresh_evidence_immutable_update;
   DROP TRIGGER lane_capacity_refresh_evidence_immutable_delete;
   CREATE TABLE evidence_artifacts (
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
   INSERT INTO evidence_artifacts (
     project_id, evidence_id, evidence_kind, source_kind, source_ref, execution_attempt_id,
     content_digest, redacted_json, redacted_digest, durable_ref_json, artifact_identity_digest, created_at_ms
   ) SELECT project_id, evidence_id, evidence_kind, source_kind, source_ref, execution_attempt_id,
     content_digest, redacted_json, redacted_digest, durable_ref_json, artifact_identity_digest, created_at_ms
   FROM execution_attempts_gh636_evidence_artifacts;
   CREATE TABLE decision_evidence (
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
   );
   INSERT INTO decision_evidence (
     project_id, decision_id, evidence_sequence, evidence_id, disposition_sequence,
     relation_kind, relation_json, created_at_ms, idempotency_key
   ) SELECT project_id, decision_id, evidence_sequence, evidence_id, disposition_sequence,
     relation_kind, relation_json, created_at_ms, idempotency_key
   FROM execution_attempts_gh636_decision_evidence;
   CREATE TABLE lane_capacity_refresh_evidence (
     project_id TEXT NOT NULL CHECK (length(project_id) > 0),
     lane_capacity_observation_id TEXT NOT NULL CHECK (length(lane_capacity_observation_id) > 0),
     execution_attempt_id TEXT NOT NULL CHECK (length(execution_attempt_id) > 0),
     observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
     PRIMARY KEY (project_id, lane_capacity_observation_id, execution_attempt_id),
     FOREIGN KEY (project_id, execution_attempt_id)
       REFERENCES execution_attempts(project_id, execution_attempt_id)
   );
   INSERT INTO lane_capacity_refresh_evidence (
     project_id, lane_capacity_observation_id, execution_attempt_id, observed_at_ms
   ) SELECT project_id, lane_capacity_observation_id, execution_attempt_id, observed_at_ms
   FROM execution_attempts_gh636_lane_capacity_refresh_evidence;
   DROP TABLE execution_attempts_gh636_decision_evidence;
   DROP TABLE execution_attempts_gh636_evidence_artifacts;
   DROP TABLE execution_attempts_gh636_lane_capacity_refresh_evidence;
   CREATE TRIGGER lane_capacity_refresh_evidence_immutable_update
     BEFORE UPDATE ON lane_capacity_refresh_evidence
     BEGIN SELECT RAISE(ABORT, 'lane capacity refresh evidence is immutable'); END;
   CREATE TRIGGER lane_capacity_refresh_evidence_immutable_delete
     BEFORE DELETE ON lane_capacity_refresh_evidence
     BEGIN SELECT RAISE(ABORT, 'lane capacity refresh evidence is immutable'); END;`;

const SHIPPED_SCHEMA31_MIGRATION = MIGRATIONS.at(-1)!;
const schema31Prefix = SHIPPED_SCHEMA31_MIGRATION.slice(0, SHIPPED_SCHEMA31_MIGRATION.indexOf("   DROP TABLE execution_attempts;"));
const GH636_SCHEMA30_REPAIR_MIGRATION = `${schema31Prefix}
   ALTER TABLE execution_attempts RENAME TO execution_attempts_gh636_old;
   DROP INDEX execution_attempts_active_assignment;
   DROP INDEX execution_attempts_active_writer_lane;
   DROP INDEX execution_attempts_active_writer_thread;
   DROP INDEX execution_attempts_active_work_item;
   DROP INDEX execution_attempts_native_request;
   DROP INDEX execution_attempts_project_state;
   DROP TRIGGER execution_attempts_lane_capacity_observation_immutable;
   ALTER TABLE execution_attempts_gh624 RENAME TO execution_attempts;
${GH636_REPAIR_CHILD_TABLES}
   DROP TABLE execution_attempts_gh636_old;
   CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_active_assignment
     ON execution_attempts(project_id, assignment_digest)
     WHERE origin = 'assignment' AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown');
   CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_active_writer_lane
     ON execution_attempts(project_id, lane_id)
     WHERE origin IN ('assignment', 'work_item') AND assignment_kind = 'write'
       AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown');
   CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_active_work_item
     ON execution_attempts(project_id, work_item_id)
     WHERE origin = 'work_item' AND assignment_kind = 'write'
       AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown');
   CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_active_writer_thread
     ON execution_attempts(project_id, thread_id)
     WHERE origin = 'work_item' AND assignment_kind = 'write' AND thread_id IS NOT NULL
       AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown');
   CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_native_request
     ON execution_attempts(bb_server_id, thread_id, native_request_id)
     WHERE thread_id IS NOT NULL AND native_request_id IS NOT NULL;
   CREATE INDEX IF NOT EXISTS execution_attempts_project_state
     ON execution_attempts(project_id, state, assignment_kind, lane_id);
   CREATE INDEX IF NOT EXISTS execution_attempts_interrupted_pending
     ON execution_attempts(project_id, work_item_id, attempt_ordinal)
     WHERE origin = 'work_item' AND state = 'interrupted';
   CREATE TRIGGER execution_attempts_lane_capacity_observation_immutable
     BEFORE UPDATE OF lane_capacity_observation_id ON execution_attempts
     WHEN OLD.lane_capacity_observation_id IS NOT NULL AND NEW.lane_capacity_observation_id IS NOT OLD.lane_capacity_observation_id
     BEGIN SELECT RAISE(ABORT, 'lane capacity observation identifier is immutable'); END;`;
MIGRATIONS.push(GH636_REPAIR_CHILD_TABLES);

const GH637_DOMAIN_MIGRATION = `
  CREATE TABLE orchestration_domains (
    project_id TEXT NOT NULL,
    config_revision INTEGER NOT NULL,
    domain_id TEXT NOT NULL,
    task_classes_json TEXT NOT NULL CHECK (json_valid(task_classes_json)),
    role_requirements_json TEXT NOT NULL CHECK (json_valid(role_requirements_json)),
    domain_digest TEXT NOT NULL,
    PRIMARY KEY (project_id, config_revision, domain_id),
    FOREIGN KEY (project_id, config_revision)
      REFERENCES project_config_revisions(project_id, config_revision)
  );
  ALTER TABLE actor_receipts ADD COLUMN domain_id TEXT;
  ALTER TABLE work_items ADD COLUMN domain_id TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE work_items ADD COLUMN task_class TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE work_item_waits ADD COLUMN domain_id TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE qualification_observations ADD COLUMN domain_id TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE eligibility_projections ADD COLUMN domain_id TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE role_generations ADD COLUMN domain_id TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE assignments ADD COLUMN domain_id TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE execution_attempts ADD COLUMN domain_id TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE lane_capacity_intervals ADD COLUMN domain_id TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE lane_capacity_refresh_evidence ADD COLUMN domain_id TEXT NOT NULL DEFAULT 'default';
  INSERT INTO orchestration_domains
    (project_id, config_revision, domain_id, task_classes_json, role_requirements_json, domain_digest)
  SELECT project_id, config_revision, 'default', '["default"]',
         COALESCE(json_extract(canonical_config_json, '$.extensions.bbCollab.roleRequirements'), '[]'),
         config_digest
    FROM project_config_revisions;
  PRAGMA defer_foreign_keys = ON;
  CREATE TEMP TABLE gh637_role_generations AS SELECT * FROM role_generations;
  CREATE TEMP TABLE gh637_assignments AS SELECT * FROM assignments;
  CREATE TEMP TABLE gh637_role_generation_heads AS SELECT * FROM role_generation_heads;
  CREATE TEMP TABLE gh637_execution_attempts AS SELECT * FROM execution_attempts;
  CREATE TEMP TABLE gh637_evidence_artifacts AS SELECT * FROM evidence_artifacts;
  CREATE TEMP TABLE gh637_decision_evidence AS SELECT * FROM decision_evidence;
  CREATE TEMP TABLE gh637_lane_capacity_refresh_evidence AS SELECT * FROM lane_capacity_refresh_evidence;
  DROP TRIGGER IF EXISTS lane_capacity_refresh_evidence_immutable_update;
  DROP TRIGGER IF EXISTS lane_capacity_refresh_evidence_immutable_delete;
  DELETE FROM decision_evidence;
  DELETE FROM evidence_artifacts;
  DELETE FROM lane_capacity_refresh_evidence;
  DELETE FROM execution_attempts;
  DELETE FROM assignments;
  DELETE FROM role_generation_heads;
  DELETE FROM role_generations;
  DROP TABLE role_generation_heads;
  DROP TABLE assignments;
  DROP TABLE role_generations;
  CREATE TABLE role_generations (
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
    holder_requested_profile_digest TEXT NOT NULL,
    qualification_id TEXT NOT NULL,
    eligibility_derivation_digest TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    activated_at_ms INTEGER NOT NULL,
    retired_at_ms INTEGER,
    standby_profile_json TEXT CHECK (standby_profile_json IS NULL OR json_valid(standby_profile_json)),
    domain_id TEXT NOT NULL DEFAULT 'default',
    PRIMARY KEY (project_id, role_id, generation, domain_id),
    FOREIGN KEY (project_id, config_revision)
      REFERENCES project_config_revisions(project_id, config_revision),
    FOREIGN KEY (project_id, repo_target_id, config_revision)
      REFERENCES repository_targets(project_id, repo_target_id, config_revision),
    FOREIGN KEY (project_id, qualification_id)
      REFERENCES qualification_observations(project_id, qualification_id),
    FOREIGN KEY (project_id, role_id, predecessor_generation, domain_id)
      REFERENCES role_generations(project_id, role_id, generation, domain_id),
    CHECK ((generation = 1 AND predecessor_generation IS NULL) OR
           (generation > 1 AND predecessor_generation = generation - 1))
  );
  CREATE TABLE assignments (
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
    domain_id TEXT NOT NULL DEFAULT 'default',
    PRIMARY KEY (project_id, assignment_id),
    FOREIGN KEY (project_id, work_item_id)
      REFERENCES work_items(project_id, work_item_id),
    FOREIGN KEY (project_id, repo_target_id, config_revision)
      REFERENCES repository_targets(project_id, repo_target_id, config_revision),
    FOREIGN KEY (project_id, role_id, role_generation, domain_id)
      REFERENCES role_generations(project_id, role_id, generation, domain_id),
    FOREIGN KEY (project_id, parent_assignment_id)
      REFERENCES assignments(project_id, assignment_id),
    CHECK ((candidate_semantics = 'base' AND candidate_sha IS NULL) OR
           (candidate_semantics = 'frozen' AND candidate_sha IS NOT NULL)),
    CHECK ((dispatch_kind = 'spawn' AND attach_thread_id IS NULL) OR
           (dispatch_kind = 'attach' AND attach_thread_id IS NOT NULL))
  );
  CREATE TABLE role_generation_heads (
    project_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    domain_id TEXT NOT NULL DEFAULT 'default',
    current_generation INTEGER NOT NULL CHECK (current_generation > 0),
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (project_id, role_id, domain_id),
    FOREIGN KEY (project_id, role_id, current_generation, domain_id)
      REFERENCES role_generations(project_id, role_id, generation, domain_id)
  );
  INSERT INTO role_generations (
    project_id, role_id, generation, role_requirement_id, config_revision, repo_target_id, status,
    predecessor_generation, holder_execution_attempt_id, holder_context_digest, holder_requested_profile_digest,
    qualification_id, eligibility_derivation_digest, created_at_ms, activated_at_ms, retired_at_ms,
    standby_profile_json, domain_id
  ) SELECT project_id, role_id, generation, role_requirement_id, config_revision, repo_target_id, status,
    predecessor_generation, holder_execution_attempt_id, holder_context_digest, holder_requested_profile_digest,
    qualification_id, eligibility_derivation_digest, created_at_ms, activated_at_ms, retired_at_ms,
    standby_profile_json, COALESCE(domain_id, 'default') FROM gh637_role_generations;
  INSERT INTO assignments SELECT project_id, assignment_id, work_item_id, assignment_kind, lane_id,
    role_requirement_id, role_id, role_generation, config_revision, governance_epoch, work_item_revision,
    repo_target_id, branch_name, base_sha, candidate_semantics, candidate_sha, bb_server_id, environment_id,
    source_id, host_id, environment_path, environment_mode, frozen_brief_version, frozen_brief_digest,
    requested_provider_id, requested_model, requested_reasoning_level, requested_permission_mode,
    requested_service_tier, requested_visibility, requested_profile_digest, dispatch_kind, attach_thread_id,
    parent_assignment_id, depth, deadline_at_ms, assignment_digest, idempotency_key, creation_event_sequence,
    created_at_ms, COALESCE(domain_id, 'default') FROM gh637_assignments;
  INSERT INTO role_generation_heads (project_id, role_id, domain_id, current_generation, updated_at_ms)
    SELECT project_id, role_id, 'default', current_generation, updated_at_ms FROM gh637_role_generation_heads;
  INSERT INTO execution_attempts SELECT * FROM gh637_execution_attempts;
  INSERT INTO evidence_artifacts SELECT * FROM gh637_evidence_artifacts;
  INSERT INTO decision_evidence SELECT * FROM gh637_decision_evidence;
  INSERT INTO lane_capacity_refresh_evidence SELECT * FROM gh637_lane_capacity_refresh_evidence;
  CREATE TRIGGER lane_capacity_refresh_evidence_immutable_update
    BEFORE UPDATE ON lane_capacity_refresh_evidence
    BEGIN SELECT RAISE(ABORT, 'lane capacity refresh evidence is immutable'); END;
  CREATE TRIGGER lane_capacity_refresh_evidence_immutable_delete
    BEFORE DELETE ON lane_capacity_refresh_evidence
    BEGIN SELECT RAISE(ABORT, 'lane capacity refresh evidence is immutable'); END;
  DROP TABLE gh637_lane_capacity_refresh_evidence;
  DROP TABLE gh637_decision_evidence;
  DROP TABLE gh637_evidence_artifacts;
  DROP TABLE gh637_execution_attempts;
  DROP TABLE gh637_role_generation_heads;
  DROP TABLE gh637_assignments;
  DROP TABLE gh637_role_generations;
`;
MIGRATIONS.push(GH637_DOMAIN_MIGRATION);
export const GH637_DOMAIN_MIGRATION_ID = MIGRATIONS.length - 1;
export const GH636_PREVIOUS_MIGRATION_ID = MIGRATIONS.length - 3;
export const GH636_REPAIR_MIGRATION_ID = MIGRATIONS.length - 2;

// GH644: review candidates are explicit and immutable. PR reviews retain their
// exact PR identity; local reviews carry the frozen checkout observation.
const GH644_LOCAL_CANDIDATE_REVIEW_MIGRATION = `
  ALTER TABLE execution_attempts ADD COLUMN review_candidate_kind TEXT
    CHECK (review_candidate_kind IS NULL OR review_candidate_kind IN ('pull-request', 'local'));
  ALTER TABLE execution_attempts ADD COLUMN review_candidate_json TEXT
    CHECK (review_candidate_json IS NULL OR json_valid(review_candidate_json));
  ALTER TABLE execution_attempts ADD COLUMN review_role_requirement_id TEXT;
  ALTER TABLE execution_attempts ADD COLUMN review_role_id TEXT;
  ALTER TABLE execution_attempts ADD COLUMN review_role_generation INTEGER
    CHECK (review_role_generation IS NULL OR review_role_generation > 0);
  ALTER TABLE execution_attempts ADD COLUMN review_frozen_brief_version INTEGER
    CHECK (review_frozen_brief_version IS NULL OR review_frozen_brief_version = 1);
  ALTER TABLE execution_attempts ADD COLUMN review_frozen_brief_content TEXT;
  ALTER TABLE execution_attempts ADD COLUMN review_frozen_brief_digest TEXT
    CHECK (review_frozen_brief_digest IS NULL OR review_frozen_brief_digest GLOB '[0-9a-f]*');
  ALTER TABLE execution_attempts ADD COLUMN review_return_path_json TEXT
    CHECK (review_return_path_json IS NULL OR json_valid(review_return_path_json));
  ALTER TABLE execution_attempts ADD COLUMN dispatch_input_digest TEXT
    CHECK (dispatch_input_digest IS NULL OR dispatch_input_digest GLOB '[0-9a-f]*');
  UPDATE execution_attempts
  SET review_candidate_kind = 'pull-request',
      review_candidate_json = json_object('candidateKind', 'pull-request', 'headSha', review_pr_head_sha, 'prNumber', review_pr_number)
  WHERE assignment_kind = 'review' AND review_pr_number IS NOT NULL AND review_pr_head_sha IS NOT NULL;
`;
MIGRATIONS.push(GH644_LOCAL_CANDIDATE_REVIEW_MIGRATION);
export const GH644_LOCAL_CANDIDATE_REVIEW_MIGRATION_ID = MIGRATIONS.length - 1;

const GH658_GITHUB_PR_WAIT_MIGRATION = `
  PRAGMA defer_foreign_keys = ON;
  CREATE TABLE work_item_waits_gh658 (
    project_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    waker TEXT NOT NULL,
    declared_at_ms INTEGER NOT NULL CHECK (declared_at_ms >= 0),
    declared_by_seat TEXT NOT NULL,
    waker_kind TEXT NOT NULL
      CHECK (waker_kind IN ('schedule', 'seat', 'work_item_succeeded', 'github_issue_closed', 'github_pr')),
    note TEXT CHECK (note IS NULL OR length(note) <= 4096),
    domain_id TEXT NOT NULL DEFAULT 'default',
    pr_owner TEXT,
    pr_repo TEXT,
    pr_number INTEGER CHECK (pr_number IS NULL OR pr_number > 0),
    pr_condition_kind TEXT CHECK (pr_condition_kind IS NULL OR pr_condition_kind IN ('pr_merged', 'pr_checks', 'pr_review_state')),
    pr_expected_state TEXT,
    pr_expected_head_sha TEXT CHECK (pr_expected_head_sha IS NULL OR (length(pr_expected_head_sha) = 40 AND pr_expected_head_sha NOT GLOB '*[^0-9a-f]*')),
    pr_execution_attempt_id TEXT,
    pr_waiting_thread_id TEXT,
    pr_waiting_role_id TEXT,
    pr_waiting_role_generation INTEGER CHECK (pr_waiting_role_generation IS NULL OR pr_waiting_role_generation > 0),
    pr_waker_schedule TEXT,
    pr_deadline_at_ms INTEGER CHECK (pr_deadline_at_ms IS NULL OR pr_deadline_at_ms >= 0),
    pr_initial_semantic_digest TEXT,
    pr_last_observed_semantic_digest TEXT,
    pr_delivery_state TEXT NOT NULL DEFAULT 'pending'
      CHECK (pr_delivery_state IN ('pending', 'fired', 'expired', 'cancelled', 'delivery_ambiguous')),
    PRIMARY KEY (project_id, work_item_id),
    FOREIGN KEY (project_id, work_item_id) REFERENCES work_items(project_id, work_item_id),
    CHECK ((waker_kind = 'github_pr' AND pr_owner IS NOT NULL AND pr_repo IS NOT NULL AND pr_number IS NOT NULL
      AND pr_condition_kind IS NOT NULL AND pr_expected_state IS NOT NULL AND pr_execution_attempt_id IS NOT NULL
      AND pr_waiting_thread_id IS NOT NULL AND pr_waiting_role_id IS NOT NULL AND pr_waiting_role_generation IS NOT NULL
      AND pr_waker_schedule IS NOT NULL AND pr_deadline_at_ms IS NOT NULL
      AND pr_initial_semantic_digest IS NOT NULL AND pr_last_observed_semantic_digest IS NOT NULL)
      OR waker_kind != 'github_pr'),
    CHECK ((pr_condition_kind IN ('pr_checks', 'pr_review_state') AND pr_expected_head_sha IS NOT NULL)
      OR pr_condition_kind IS NULL OR pr_condition_kind = 'pr_merged')
  );
  INSERT INTO work_item_waits_gh658 (
    project_id, work_item_id, waker, declared_at_ms, declared_by_seat, waker_kind, note, domain_id
  ) SELECT project_id, work_item_id, waker, declared_at_ms, declared_by_seat, waker_kind, note, domain_id
    FROM work_item_waits;
  DROP TABLE work_item_waits;
  ALTER TABLE work_item_waits_gh658 RENAME TO work_item_waits;
  CREATE INDEX work_item_waits_github_pr_delivery
    ON work_item_waits(project_id, waker_kind, pr_delivery_state, pr_deadline_at_ms)
    WHERE waker_kind = 'github_pr';
  CREATE TABLE operator_receipts_gh658 (
    project_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL UNIQUE,
    receipt_type TEXT NOT NULL CHECK (receipt_type = 'operator_confirmation'),
    mutation_class TEXT NOT NULL CHECK (mutation_class IN (
      'bootstrap', 'config_revision', 'governor_claim', 'decision_create',
      'decision_disposition', 'work_item_create', 'work_item_transition',
      'github_issue_projection', 'github_pr_observation_record', 'qualification_observation_record',
      'role_generation_succession', 'assignment_prepare', 'assignment_dispatch',
      'assignment_reconcile', 'assignment_terminal', 'migration_prepare',
      'migration_step'
    )),
    candidate_head TEXT NOT NULL CHECK (length(candidate_head) BETWEEN 40 AND 64 AND candidate_head NOT GLOB '*[^0-9a-f]*'),
    binding_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status = 'interim'),
    retirement_condition TEXT NOT NULL CHECK (retirement_condition = 'host-issued receipt get-bb/bb#1541'),
    caller_thread_id TEXT NOT NULL,
    caller_plugin_id TEXT NOT NULL,
    requested_from_background INTEGER NOT NULL CHECK (requested_from_background IN (0, 1)),
    receipt_digest TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    idempotency_key TEXT,
    request_digest TEXT,
    consumed_at_ms INTEGER,
    consumed_event_sequence INTEGER,
    approver_id TEXT,
    authorizing_decision_id TEXT,
    authorizing_disposition_sequence INTEGER,
    issuance_provenance TEXT CHECK (issuance_provenance IN ('console', 'attestation') OR issuance_provenance IS NULL),
    PRIMARY KEY (project_id, receipt_id)
  );
  INSERT INTO operator_receipts_gh658 SELECT * FROM operator_receipts;
  DROP TABLE operator_receipts;
  ALTER TABLE operator_receipts_gh658 RENAME TO operator_receipts;`;
MIGRATIONS.push(GH658_GITHUB_PR_WAIT_MIGRATION);
export const GH658_GITHUB_PR_WAIT_MIGRATION_ID = MIGRATIONS.length - 1;

export const schemaDigest = sha256(MIGRATIONS.join("\n"));
export const GH300_BACKFILL_MIGRATION_ID = MIGRATIONS.findIndex((statement) => statement.includes("CREATE TABLE execution_attempts_gh300"));
export const CACHED_CONSUMERS = [
  "server.rpcContract",
  "server.collabCli",
  "src/foundation.consumedLegacyReplayProbe",
  "src/foundation.newLegacyApplyProvenanceProbe",
] as const;
const CACHED_CONSUMER_ROLLOUT_POLICY = {
  class: "operator_receipts.consumed_replay_provenance",
  staleV20Receipt: "unknown",
  currentNewLegacyApply: "OPERATOR_RECEIPT_INVALID",
  requiredV21ConsumedLegacyReplay: "OK",
  refusal: "OPERATOR_RECEIPT_INVALID",
} as const;

export type CachedConsumerObservation = {
  name: (typeof CACHED_CONSUMERS)[number];
  observedSchemaVersion: number;
  observedContractVersion: number;
};

type CachedConsumerProbe = () => Promise<{
  observedSchemaVersion: number;
  observedContractVersion: number;
  consumedLegacyReplay?: Pick<FoundationResult, "outcome">;
  newApplyRefusal?: Pick<FoundationResult, "outcome">;
}>;

export async function assembleV22CachedConsumerRolloutEvidence(input: {
  rpcContract?: CachedConsumerProbe;
  collabCli?: CachedConsumerProbe;
  consumedLegacyReplay?: CachedConsumerProbe;
  newLegacyApplyProvenance?: CachedConsumerProbe;
}): Promise<NonNullable<ApplyRequest["decisionEvidence"]>[number]> {
  const probes = [
    ["server.rpcContract", input.rpcContract],
    ["server.collabCli", input.collabCli],
    ["src/foundation.consumedLegacyReplayProbe", input.consumedLegacyReplay],
    ["src/foundation.newLegacyApplyProvenanceProbe", input.newLegacyApplyProvenance],
  ] as const;
  if (probes.some(([, probe]) => typeof probe !== "function")) {
    throw new Error("cached-consumer v22 rollout evidence requires execution from all four consumers");
  }
  const executed = await Promise.all(probes.map(async ([name, probe]) => ({
    name,
    ...(await probe!()),
  })));
  const reread = cachedConsumerRolloutEvidence(executed);
  const consumedLegacyReplay = executed[2]!.consumedLegacyReplay;
  const newApply = executed[3]!.newApplyRefusal;
  if (
    reread.action !== "reread" || reread.expected !== 4 || reread.attempted !== 4 || reread.verified !== 4 ||
    consumedLegacyReplay?.outcome !== "OK" || newApply?.outcome !== "OPERATOR_RECEIPT_INVALID"
  ) {
    throw new Error("cached-consumer v22 rollout evidence requires four rereads, consumed legacy replay, and the current new-apply refusal");
  }
  const durableRefJson = canonicalJson({
    kind: "cached_consumer_v22_rollout_receipt",
    reread,
    consumedLegacyReplay: {
      outcome: consumedLegacyReplay.outcome,
    },
    newApplyGuard: {
      nullProvenance: { outcome: newApply.outcome },
    },
  });
  return {
    evidenceId: "cached-consumer-v22-rollout-receipt",
    evidenceKind: "release",
    sourceKind: "release",
    sourceRef: "live-plugin:dist/server.js",
    executionAttemptId: null,
    contentDigest: sha256(durableRefJson),
    redactedJson: canonicalJson({ evidenceId: "cached-consumer-v22-rollout-receipt", redacted: true }),
    durableRefJson,
    relationKind: "supporting",
    relation: { purpose: "cached-consumer-v22-rollout" },
  };
}

export function cachedConsumerRolloutEvidence(observations: readonly CachedConsumerObservation[]) {
  const names = observations.map((observation) => observation.name);
  const requiredNames = [...CACHED_CONSUMERS];
  const verifiedNames = new Set(observations
    .filter((observation) => observation.observedSchemaVersion === SCHEMA_VERSION && observation.observedContractVersion === RUNTIME_CONTRACT_VERSION)
    .map((observation) => observation.name));
  const verified = requiredNames.filter((name) => verifiedNames.has(name)).length;
  const reread = observations.length === requiredNames.length && verified === requiredNames.length &&
    canonicalJson([...new Set(names)].sort()) === canonicalJson(requiredNames.slice().sort());
  const evidence = {
    names,
    observations,
    oldSchemaVersion: PREVIOUS_SCHEMA_VERSION,
    newSchemaVersion: SCHEMA_VERSION,
    oldContractVersion: PREVIOUS_RUNTIME_CONTRACT_VERSION,
    newContractVersion: RUNTIME_CONTRACT_VERSION,
    action: reread ? "reread" : "refused",
    incompatiblePolicy: CACHED_CONSUMER_ROLLOUT_POLICY,
    expected: requiredNames.length,
    attempted: observations.length,
    verified,
    schemaDigest,
  };
  return { ...evidence, rolloutReceiptDigest: sha256(canonicalJson(evidence)) };
}

function unknownCachedConsumerRolloutEvidence() {
  return {
    names: [...CACHED_CONSUMERS],
    observations: [],
    oldSchemaVersion: PREVIOUS_SCHEMA_VERSION,
    newSchemaVersion: SCHEMA_VERSION,
    oldContractVersion: PREVIOUS_RUNTIME_CONTRACT_VERSION,
    newContractVersion: RUNTIME_CONTRACT_VERSION,
    action: "unknown" as const,
    incompatiblePolicy: CACHED_CONSUMER_ROLLOUT_POLICY,
    expected: CACHED_CONSUMERS.length,
    attempted: 0,
    verified: 0,
    schemaDigest,
    reason: "no persisted cached-consumer rollout receipt is available",
  };
}

function persistedCachedConsumerRolloutEvidence(db: SqliteDatabase, projectId: string) {
  const row = asRow<{
    evidence_kind: string;
    source_kind: string;
    source_ref: string;
    execution_attempt_id: string | null;
    content_digest: string;
    redacted_json: string;
    redacted_digest: string;
    durable_ref_json: string;
    artifact_identity_digest: string;
  }>(db.prepare(
    `SELECT evidence_kind, source_kind, source_ref, execution_attempt_id, content_digest,
            redacted_json, redacted_digest, durable_ref_json, artifact_identity_digest
     FROM evidence_artifacts
     WHERE project_id = ? AND evidence_id = 'cached-consumer-v22-rollout-receipt'`,
  ).get(projectId));
  if (!row) return unknownCachedConsumerRolloutEvidence();
  try {
    const redacted = JSON.parse(row.redacted_json);
    const durableRef = JSON.parse(row.durable_ref_json);
    assertRedactedEvidence(redacted, "cached-consumer rollout redacted metadata");
    assertRedactedEvidence(durableRef, "cached-consumer rollout durable reference");
    const expectedIdentity = sha256(canonicalJson({
      projectId,
      evidenceId: "cached-consumer-v22-rollout-receipt",
      evidenceKind: row.evidence_kind,
      sourceKind: row.source_kind,
      sourceRef: row.source_ref,
      executionAttemptId: row.execution_attempt_id,
      contentDigest: row.content_digest,
      redactedDigest: sha256(canonicalJson(redacted)),
      durableRef,
    }));
    if (
      row.evidence_kind !== "release" || row.source_kind !== "release" || row.source_ref !== "live-plugin:dist/server.js" ||
      canonicalJson(redacted) !== row.redacted_json || canonicalJson(durableRef) !== row.durable_ref_json ||
      sha256(canonicalJson(redacted)) !== row.redacted_digest || expectedIdentity !== row.artifact_identity_digest
    ) return unknownCachedConsumerRolloutEvidence();
    const receipt = durableRef as {
      kind?: unknown;
      reread?: { observations?: unknown; rolloutReceiptDigest?: unknown };
      consumedLegacyReplay?: { outcome?: unknown };
      newApplyGuard?: {
        nullProvenance?: { outcome?: unknown };
      };
    };
    if (!Array.isArray(receipt.reread?.observations)) return unknownCachedConsumerRolloutEvidence();
    const reread = cachedConsumerRolloutEvidence(receipt.reread.observations as CachedConsumerObservation[]);
    if (
      receipt.kind !== "cached_consumer_v22_rollout_receipt" ||
      receipt.reread.rolloutReceiptDigest !== reread.rolloutReceiptDigest ||
      reread.action !== "reread" || reread.expected !== 4 || reread.attempted !== 4 || reread.verified !== 4 ||
      receipt.consumedLegacyReplay?.outcome !== "OK" ||
      receipt.newApplyGuard?.nullProvenance?.outcome !== "OPERATOR_RECEIPT_INVALID"
    ) return unknownCachedConsumerRolloutEvidence();
    return reread;
  } catch {
    return unknownCachedConsumerRolloutEvidence();
  }
}

const id = z.string().trim().min(1).max(256);
const roleIdSchema = z.enum(ROLE_IDS);
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
export const MIGRATION_STATES = [
  "prepared",
  "frozen",
  "exported",
  "imported",
  "equivalent",
  "target_active",
  "exercised",
  "retired",
  "rolled_back",
  "fix_forward_required",
] as const;
export const MIGRATION_STEPS = [
  "record_inventory",
  "record_quiescence",
  "freeze",
  "record_export",
  "record_import",
  "record_equivalence",
  "activate",
  "record_exercise",
  "retire",
  "rollback",
  "mark_fix_forward_required",
] as const;
export const contractDigest = sha256(canonicalJson({
  contractVersion: RUNTIME_CONTRACT_VERSION,
  operationClasses: ["migration_prepare", "migration_step", "execution_attempt_terminal_report", "execution_attempt_interruption"],
  migrationStates: MIGRATION_STATES,
  migrationSteps: MIGRATION_STEPS,
  roleCapacityPolicy: {
    roleIds: [...ROLE_IDS],
    maxDomains: 128,
    maxTaskClassesPerDomain: 128,
    identity: "configured-domain-scoped-role-requirement",
    scoping: {
      director: "project-domain",
      "project-orchestrator": "project-domain",
      worker: "repository-target-domain",
      "independent-reviewer": "repository-target-domain",
    },
  },
  roleStandbyPolicy: {
    role: "director",
    field: "standby_profile_json",
    requirement: "one named profile with a provider different from the executed holder",
    authority: "none",
    traffic: "none",
  },
  roleConfigContinuationPolicy: "dispatch authority continues across revisions only when exact role inputs and target source identity are unchanged",
  writingLanePolicy: {
    configPath: "extensions.bbCollab.writingLaneCeiling",
    default: DEFAULT_WRITING_LANE_CEILING,
    maximum: MAX_WRITING_LANE_CEILING,
    lowerRequiresExplicitDecision: true,
    readOnlyAssignmentKinds: ["review", "probe"],
  },
  reviewCandidatePolicy: {
    kinds: ["pull-request", "local"],
    pullRequest: "exact positive PR number plus lowercase 40-hex head SHA",
    local: ["base SHA exists in the candidate repository", "candidate SHA exists as the exact checkout HEAD", "managed-worktree environment", "branch checkout", "clean reachable observation", "candidate server identity", "base-ancestor merge proof", "target source identity"],
    exclusivity: "PR identity and local identity are mutually exclusive",
    probe: "never a review",
    authority: "local reviews persist exact reviewer requirement/generation, frozen brief/return path, and native input digest",
    finalObservation: "local candidate is rechecked immediately before every native spawn or retry",
  },
  directorSeatPolicy: {
    roleRequirementId: DIRECTOR_SEAT_ROLE_REQUIREMENT_ID,
    roleId: "director",
    profiles: directorSeatProfiles,
    writingLaneCapacity: 0,
    environment: "managed-worktree",
    assignmentKinds: [],
  },
  cachedConsumerRolloutPolicy: {
    consumers: [...CACHED_CONSUMERS],
    expected: 4,
    attempted: 4,
    verified: 4,
    staleV20Receipt: CACHED_CONSUMER_ROLLOUT_POLICY,
  },
  roleHolderEligibilityPolicy: {
    nativeWitnessMarker: "witness",
    refusal: "ROLE_CONTEXT_WITNESS",
  },
  decisionAuthorityPolicy: {
    crossProjectBootstrap: {
      decisionClass: "operator_only",
      repoTargetId: null,
      scope: { operation: "cross_project_bootstrap", sourceProjectId: "request.projectId", targetProjectId: "distinct", repoTargetId: null },
      options: { rootOfTrust: "host_local_operator" },
      authority: "exact_verified_plugin_receipt_on_current_source_governorship_head",
      rootFields: ["projectId", "governanceEpoch", "fenceToken", "actorReceiptId", "actorReceiptDigest"],
    },
  },
}));
const migrationArtifactSchema = z
  .object({
    evidenceId: id,
    evidenceKind: id,
    sourceKind: id,
    sourceRef: id,
    executionAttemptId: id.nullable(),
    contentDigest: digestSchema,
    redactedJson: z.string(),
    redactedDigest: digestSchema,
    durableRefJson: z.string(),
    artifactIdentityDigest: digestSchema,
  })
  .strict();
const migrationExportManifestSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    contractVersion: z.number().int().positive(),
    pluginId: id,
    projectId: id,
    migrationStatementIds: z.array(z.number().int().nonnegative()),
    schemaDigest: digestSchema,
    contractDigest: digestSchema,
    rowCount: z.number().int().nonnegative(),
    tableCounts: z.record(z.string(), z.number().int().nonnegative()),
    recordsDigest: digestSchema,
    artifactIndexDigest: digestSchema,
    exportRootDigest: digestSchema,
  })
  .strict();
const migrationExportSchema = z.union([
  z.object({
    manifest: migrationExportManifestSchema,
    recordsNdjson: z.string().max(MAX_EXPORT_BYTES),
    artifactIndex: z.array(migrationArtifactSchema).max(MAX_EXPORT_ROWS),
    checksums: z.record(z.string(), digestSchema),
  }).strict(),
  z.object({
    kind: z.literal("canonical-export-files"),
    complete: z.literal(true),
    directory: z.string().min(1).max(4096).optional(),
    displayDirectory: z.string().min(1).max(4096).optional(),
    manifest: migrationExportManifestSchema,
    checksums: z.record(z.string(), digestSchema),
  }).strict().refine((value) => value.directory !== undefined || value.displayDirectory !== undefined, { message: "file export directory is required" }),
]);
const migrationPrepareSchema = z
  .object({
    migrationId: id,
    sourceSystem: z.literal("llm-collab"),
    sourceRuntimeId: id,
    targetRuntimeId: id,
    sourceContractDigest: digestSchema,
    sourceSchemaDigest: digestSchema,
    sourceSnapshotDigest: digestSchema,
    decisionId: id,
    decisionDispositionSequence: z.number().int().positive(),
    retentionUntilMs: z.number().int().nonnegative(),
  })
  .strict();
const sourceEvidenceManifestSchema = z
  .object({
    sourceSystem: z.literal("llm-collab"),
    sourceFence: z.literal(LLM_COLLAB_SOURCE_FENCE),
    resourceRevision: z.literal(LLM_COLLAB_EVIDENCE_RESOURCE_REVISION),
    mergedMainSha: z.literal(LLM_COLLAB_MERGED_MAIN_SHA),
    canonical: z.literal(false),
    files: z
      .array(z.object({ path: id, digest: digestSchema }).strict())
      .min(1)
      .max(MAX_EXPORT_ROWS)
      .superRefine((files, ctx) => {
        const paths = files.map((file) => file.path);
        if (new Set(paths).size !== paths.length) ctx.addIssue({ code: "custom", message: "source evidence files must be unique" });
        if (canonicalJson(paths) !== canonicalJson([...paths].sort())) ctx.addIssue({ code: "custom", message: "source evidence files must be sorted" });
      }),
    manifestDigest: digestSchema,
  })
  .strict();
const migrationStepSchema = z
  .object({
    migrationId: id,
    step: z.enum(MIGRATION_STEPS),
    proofDigest: digestSchema,
    repositoryTargetsDigest: digestSchema,
    sourceEventCeiling: z.number().int().nonnegative().optional(),
    sourceSnapshotDigest: digestSchema.optional(),
    export: migrationExportSchema.optional(),
    sourceEvidenceManifest: sourceEvidenceManifestSchema.optional(),
    canonicalImport: z
      .object({ expected: z.number().int().nonnegative(), attempted: z.number().int().nonnegative(), verified: z.number().int().nonnegative() })
      .strict()
      .optional(),
    importRootDigest: digestSchema.optional(),
    equivalenceDigest: digestSchema.optional(),
    equivalenceDisposition: z.string().optional(),
    recoveryDigest: digestSchema.optional(),
    canaries: z
      .object({
        expected: z.number().int().positive(),
        attempted: z.number().int().nonnegative(),
        verified: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
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
    const keys = scope.targets.map((target) => JSON.stringify([target.workItemId, target.repoTargetId]));
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
    const keys = connectors.map((connector) => JSON.stringify([connector.repoTargetId, connector.connectorId]));
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
const crossProjectBootstrapScopeSchema = z
  .object({
    operation: z.literal("cross_project_bootstrap"),
    sourceProjectId: id,
    targetProjectId: id,
    repoTargetId: z.null(),
  })
  .strict();
const crossProjectBootstrapOptionsSchema = z
  .object({ rootOfTrust: z.literal("host_local_operator") })
  .strict();
const decisionAuthorityRootSchema = z
  .object({
    projectId: id,
    governanceEpoch: z.number().int().positive(),
    fenceToken: id,
    actorReceiptId: id,
    actorReceiptDigest: digestSchema,
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
const bootstrapAuthoritySchema = z
  .object({
    derivationId: id,
    genesisReceiptId: id,
    sourceProjectId: id,
    sourceGovernanceEpoch: z.number().int().positive(),
    sourceFenceToken: id,
    authorizingDecisionId: id,
    authorizingDispositionSequence: z.number().int().positive(),
  })
  .strict();

export const WORK_ITEM_STATES = ["proposed", "ready", "in_progress", "review_pending", "blocked", "succeeded", "failed", "cancelled"] as const;
// review_pending is authorship-complete but non-terminal: it covers human review and CI-only waiting.
export const WORK_ITEM_NON_TERMINAL_STATES = ["proposed", "ready", "in_progress", "review_pending", "blocked"] as const;
export const WORK_ITEM_CAPACITY_LIFECYCLE_STATES = ["in_progress"] as const;
export const WORK_ITEM_CAPACITY_ATTEMPT_STATES = ["prepared", "armed", "content_delivered", "running", "dispatch_unknown"] as const;
export const WORK_ITEM_IDLE_ACTIVE_ATTEMPT_STATES = ["prepared", "armed", "content_delivered", "running"] as const;
export const WORK_ITEM_IDLE_BLIND_ATTEMPT_STATES = ["dispatch_unknown"] as const;
// 30s is 6x the observed ~5s prepare-to-finalize span; slower dispatches still surface on the next sweep.
export const PREPARED_DISPATCH_MIN_AGE_MS = 30_000;

export interface WorkItemCapacityLaneEvidence {
  execution_attempt_id: string;
  domain_id: string;
  lane_id: string;
  thread_id: string | null;
  state: (typeof WORK_ITEM_CAPACITY_ATTEMPT_STATES)[number];
  observed_at_ms: number | null;
  idle_kind: "active" | "blind";
}

export interface WorkItemCapacityEvidence {
  lanes: WorkItemCapacityLaneEvidence[];
  unboundWorkItemIds: string[];
}

export interface WorkItemDispatchThread {
  id: string;
  parentThreadId: string | null;
  title: string | null;
  archivedAt: number | null;
  deletedAt: number | null;
}

export interface WorkItemDispatchWedge {
  executionAttemptId: string;
  workItemId: string;
  domainId?: string;
}

export interface WorkItemDispatchIntent {
  idempotencyKey: string;
  parentThreadId: string;
  title: string | null;
}

export const threadlessPreparedClosurePopulation = (projectId: string) => ({
  projectId,
  source: "bb.sdk.threads.list",
  active: "all pages with archived=false",
  archived: "all pages with archived=true",
  deleted: "excluded because threads.list does not expose deleted history",
} as const);

export const THREADLESS_PREPARED_INVENTORY_OBSERVATION_BOUND = "two complete project-scoped active/archive list reads; deleted, retitled, marker-truncated, and unsanctioned children are outside the observation" as const;

export function parseWorkItemDispatchIntent(reasonCode: string | null): WorkItemDispatchIntent | null {
  const prefix = "work_item_dispatch_intent:";
  if (!reasonCode?.startsWith(prefix)) return null;
  const marker = reasonCode.slice(prefix.length);
  const parentMarker = marker.lastIndexOf(":parent=");
  if (parentMarker < 1) return null;
  const idempotencyKey = marker.slice(0, parentMarker);
  const parentAndTitle = marker.slice(parentMarker + ":parent=".length);
  if (!idempotencyKey || !parentAndTitle) return null;
  const titleMarker = parentAndTitle.indexOf(":title=");
  const parentThreadId = titleMarker < 0 ? parentAndTitle : parentAndTitle.slice(0, titleMarker);
  if (!parentThreadId) return null;
  if (titleMarker < 0) return { idempotencyKey, parentThreadId, title: null };
  try {
    return { idempotencyKey, parentThreadId, title: decodeURIComponent(parentAndTitle.slice(titleMarker + ":title=".length)) };
  } catch {
    return null;
  }
}

/** Reconcile only positive identity evidence; ambiguity remains a capacity-consuming wedge. */
export function reconcilePreparedWorkItemDispatches(
  db: SqliteDatabase,
  projectId: string,
  threads: WorkItemDispatchThread[],
): WorkItemDispatchWedge[] {
  const preparedBeforeMs = now() - PREPARED_DISPATCH_MIN_AGE_MS;
  const prepared = db.prepare(
    `SELECT execution_attempt_id, work_item_id, reason_code FROM execution_attempts
     WHERE project_id = ? AND origin = 'work_item' AND assignment_kind IN ('write', 'review')
       AND state = 'prepared' AND thread_id IS NULL AND created_at_ms < ?`,
  ).all(projectId, preparedBeforeMs) as Array<{ execution_attempt_id: string; work_item_id: string; reason_code: string | null }>;
  const wedges: WorkItemDispatchWedge[] = [];
  for (const attempt of prepared) {
    const intent = parseWorkItemDispatchIntent(attempt.reason_code);
    if (!intent || intent.title === null) {
      wedges.push({ executionAttemptId: attempt.execution_attempt_id, workItemId: attempt.work_item_id });
      continue;
    }
    const thread = threads.find((candidate) =>
      candidate.parentThreadId === intent.parentThreadId && candidate.archivedAt === null && candidate.deletedAt === null &&
      candidate.title === `${intent.title} [dispatch:${intent.idempotencyKey}]`,
    );
    const observedAtMs = now();
    if (thread) {
      const result = db.prepare(
        `UPDATE execution_attempts
         SET state = 'running', thread_id = ?, lease_owner_thread_id = ?, reason_code = 'work_item_dispatch', observed_at_ms = ?
         WHERE project_id = ? AND execution_attempt_id = ? AND state = 'prepared' AND thread_id IS NULL`,
      ).run(thread.id, thread.id, observedAtMs, projectId, attempt.execution_attempt_id);
      if (result.changes > 0) continue;
    }
    wedges.push({ executionAttemptId: attempt.execution_attempt_id, workItemId: attempt.work_item_id });
  }
  return wedges;
}

export function workItemCapacityLaneEvidence(db: SqliteDatabase, projectId: string): WorkItemCapacityEvidence {
  const hasDomainColumn = tableColumns(db, "execution_attempts").includes("domain_id");
  const lanes = (db.prepare(
    `SELECT execution_attempts.execution_attempt_id, execution_attempts.lane_id, execution_attempts.thread_id, execution_attempts.state, execution_attempts.observed_at_ms, ${hasDomainColumn ? "execution_attempts.domain_id" : "'default' AS domain_id"}
     FROM execution_attempts
     JOIN work_items ON work_items.project_id = execution_attempts.project_id
       AND work_items.work_item_id = execution_attempts.work_item_id
     WHERE execution_attempts.project_id = ?
       AND execution_attempts.origin = 'work_item'
       AND execution_attempts.assignment_kind = 'write'
       AND work_items.lifecycle_state IN (${WORK_ITEM_CAPACITY_LIFECYCLE_STATES.map(() => "?").join(", ")})
       AND execution_attempts.state IN (${WORK_ITEM_CAPACITY_ATTEMPT_STATES.map(() => "?").join(", ")})
     ORDER BY execution_attempts.lane_id, execution_attempts.execution_attempt_id`,
  ).all(projectId, ...WORK_ITEM_CAPACITY_LIFECYCLE_STATES, ...WORK_ITEM_CAPACITY_ATTEMPT_STATES) as Array<{
    execution_attempt_id: string;
    domain_id: string;
    lane_id: string;
    thread_id: string | null;
    state: (typeof WORK_ITEM_CAPACITY_ATTEMPT_STATES)[number];
    observed_at_ms: number | null;
  }>).map((row) => ({
    ...row,
    idle_kind: WORK_ITEM_IDLE_ACTIVE_ATTEMPT_STATES.includes(row.state as (typeof WORK_ITEM_IDLE_ACTIVE_ATTEMPT_STATES)[number]) ? "active" as const : "blind" as const,
  }));
  const unboundWorkItemIds = (db.prepare(
    `SELECT work_items.work_item_id
     FROM work_items
     WHERE work_items.project_id = ?
       AND work_items.lifecycle_state IN (${WORK_ITEM_CAPACITY_LIFECYCLE_STATES.map(() => "?").join(", ")})
       AND NOT EXISTS (
         SELECT 1 FROM execution_attempts
         WHERE execution_attempts.project_id = work_items.project_id
           AND execution_attempts.work_item_id = work_items.work_item_id
           AND execution_attempts.origin = 'work_item'
           AND execution_attempts.assignment_kind = 'write'
           AND execution_attempts.state IN (${WORK_ITEM_CAPACITY_ATTEMPT_STATES.map(() => "?").join(", ")})
       )
     ORDER BY work_items.work_item_id`,
  ).all(projectId, ...WORK_ITEM_CAPACITY_LIFECYCLE_STATES, ...WORK_ITEM_CAPACITY_ATTEMPT_STATES) as Array<{ work_item_id: string }>).map((row) => row.work_item_id);
  return { lanes, unboundWorkItemIds };
}

const workItemStateSchema = z.enum(WORK_ITEM_STATES);
const githubIssueBindingSchema = z
  .object({
    issueNumber: z.number().int().positive().refine(Number.isSafeInteger, "issueNumber must be a safe integer"),
  })
  .strict();
const workItemInputSchema = z
  .object({
    workItemId: id,
    title: z.string().max(4096),
    body: z.string().max(64 * 1024),
    taskClass: id.optional(),
    domainId: id.optional(),
    githubIssue: githubIssueBindingSchema.optional(),
  })
  .strict();
const githubRefPartSchema = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9_.-]+$/u);
const pullRequestHeadShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const githubPrMergeStateSchema = z.enum(["open", "closed_unmerged", "merged"]);
const githubPrChecksStateSchema = z.enum(["pending", "success", "failure", "cancelled", "unknown"]);
const githubPrReviewStateSchema = z.enum(["none", "approved", "changes_requested", "dismissed_or_changed", "unknown"]);
const githubPrConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pr_merged"), owner: githubRefPartSchema, repo: githubRefPartSchema,
    prNumber: z.number().int().positive().refine(Number.isSafeInteger), expectedState: githubPrMergeStateSchema,
    expectedHeadSha: pullRequestHeadShaSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("pr_checks"), owner: githubRefPartSchema, repo: githubRefPartSchema,
    prNumber: z.number().int().positive().refine(Number.isSafeInteger), expectedState: githubPrChecksStateSchema,
    expectedHeadSha: pullRequestHeadShaSchema,
  }).strict(),
  z.object({
    kind: z.literal("pr_review_state"), owner: githubRefPartSchema, repo: githubRefPartSchema,
    prNumber: z.number().int().positive().refine(Number.isSafeInteger), expectedState: githubPrReviewStateSchema,
    expectedHeadSha: pullRequestHeadShaSchema,
  }).strict(),
]);
const githubPrWaitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pr_merged"), owner: githubRefPartSchema, repo: githubRefPartSchema,
    prNumber: z.number().int().positive().refine(Number.isSafeInteger), expectedState: githubPrMergeStateSchema,
    expectedHeadSha: pullRequestHeadShaSchema.optional(), declaredBySeat: id, executionAttemptId: id,
    waitingThreadId: id, waitingRoleId: roleIdSchema, waitingRoleGeneration: z.number().int().positive(),
    wakerSchedule: id, deadlineAtMs: z.number().int().nonnegative(), note: z.string().trim().min(1).max(4096).optional() }).strict(),
  z.object({ kind: z.literal("pr_checks"), owner: githubRefPartSchema, repo: githubRefPartSchema,
    prNumber: z.number().int().positive().refine(Number.isSafeInteger), expectedState: githubPrChecksStateSchema,
    expectedHeadSha: pullRequestHeadShaSchema, declaredBySeat: id, executionAttemptId: id,
    waitingThreadId: id, waitingRoleId: roleIdSchema, waitingRoleGeneration: z.number().int().positive(),
    wakerSchedule: id, deadlineAtMs: z.number().int().nonnegative(), note: z.string().trim().min(1).max(4096).optional() }).strict(),
  z.object({ kind: z.literal("pr_review_state"), owner: githubRefPartSchema, repo: githubRefPartSchema,
    prNumber: z.number().int().positive().refine(Number.isSafeInteger), expectedState: githubPrReviewStateSchema,
    expectedHeadSha: pullRequestHeadShaSchema, declaredBySeat: id, executionAttemptId: id,
    waitingThreadId: id, waitingRoleId: roleIdSchema, waitingRoleGeneration: z.number().int().positive(),
    wakerSchedule: id, deadlineAtMs: z.number().int().nonnegative(), note: z.string().trim().min(1).max(4096).optional() }).strict(),
]);
const workItemBlockerSchema = z.union([
  z.object({ kind: z.literal("work_item_succeeded"), workItemId: id }).strict(),
  z.object({ kind: z.literal("github_issue_closed"), owner: githubRefPartSchema, repo: githubRefPartSchema, issueNumber: z.number().int().positive().refine(Number.isSafeInteger) }).strict(),
  githubPrConditionSchema,
]);
const workItemBlockerWithDeclarationSchema = z.union([
  z.object({ kind: z.literal("work_item_succeeded"), workItemId: id, declaredBySeat: id, note: z.string().trim().min(1).max(4096).optional() }).strict(),
  z.object({ kind: z.literal("github_issue_closed"), owner: githubRefPartSchema, repo: githubRefPartSchema, issueNumber: z.number().int().positive().refine(Number.isSafeInteger), declaredBySeat: id, note: z.string().trim().min(1).max(4096).optional() }).strict(),
  githubPrWaitSchema,
]);
const workItemWaitSchema = z.union([
  z.object({ kind: z.literal("schedule"), schedule: id, declaredBySeat: id }).strict(),
  z.object({ kind: z.literal("seat"), seat: z.enum(ROLE_IDS), declaredBySeat: id }).strict(),
  workItemBlockerWithDeclarationSchema,
]);
const workItemExternalEventSchema = z.object({
  kind: z.enum(["github_issue_closed", "github_issue_reopened"]),
  owner: githubRefPartSchema,
  repo: githubRefPartSchema,
  issueNumber: z.number().int().positive().refine(Number.isSafeInteger),
}).strict();
const gitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/u);
const workItemSatisfactionEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("config_revision"), configRevision: z.number().int().positive(), digest: digestSchema }).strict(),
  z.object({ kind: z.literal("decision"), decisionId: id }).strict(),
  z.object({ kind: z.literal("github_issue_closed"), owner: githubRefPartSchema, repo: githubRefPartSchema, issueNumber: z.number().int().positive().refine(Number.isSafeInteger) }).strict(),
]);
const projectionRecoveryEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github_issue_unchanged"),
    owner: githubRefPartSchema,
    repo: githubRefPartSchema,
    issueNumber: z.number().int().positive().refine(Number.isSafeInteger),
    externalRevision: id,
  }).strict(),
  z.object({
    kind: z.literal("github_issue_observed"),
    owner: githubRefPartSchema,
    repo: githubRefPartSchema,
    issueNumber: z.number().int().positive().refine(Number.isSafeInteger),
    externalRevision: id,
  }).strict(),
]);
const githubPrObservationSchema = z.object({
  repositoryIdentity: z.object({ owner: githubRefPartSchema, repo: githubRefPartSchema }).strict(),
  pullRequestNumber: z.number().int().positive().refine(Number.isSafeInteger),
  headSha: pullRequestHeadShaSchema,
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  checksSummary: githubPrChecksStateSchema,
  reviewDecision: githubPrReviewStateSchema,
}).strict();

function isGithubPrWait(value: unknown): value is GithubPrWaitRegistration {
  return typeof value === "object" && value !== null && "kind" in value &&
    (value.kind === "pr_merged" || value.kind === "pr_checks" || value.kind === "pr_review_state");
}
const reviewCandidateKindSchema = z.enum(["pull-request", "local"]);
const reviewCandidateEnvironmentSchema = z
  .object({
    bbServerId: id,
    environmentId: id,
    sourceId: id,
    hostId: id,
    path: id,
    mode: z.literal("managed-worktree"),
  })
  .strict();
const reviewCandidateCheckoutSchema = z
  .object({
    branchName: id,
    headSha: gitShaSchema,
  })
  .strict();
const reviewCandidateObservationSchema = z
  .object({
    clean: z.literal(true),
    reachable: z.literal(true),
  })
  .strict();
const reviewReturnPathSchema = z
  .object({
    threadId: id,
    statuses: z.tuple([z.literal("DONE"), z.literal("BLOCKED"), z.literal("WAITING")]),
  })
  .strict();
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
const workAttemptSchema = z
  .object({
    laneId: id,
    threadId: id.optional(),
    assignmentKind: z.enum(["write", "review", "probe"]),
    requestedProfile: executionProfileSchema.optional(),
    candidateKind: reviewCandidateKindSchema.optional(),
    reviewPrNumber: z.number().int().positive().refine(Number.isSafeInteger, "reviewPrNumber must be a safe integer").optional(),
    reviewPrHeadSha: pullRequestHeadShaSchema.optional(),
    reviewBaseSha: gitShaSchema.optional(),
    reviewCandidateSha: gitShaSchema.optional(),
    reviewCandidateEnvironment: reviewCandidateEnvironmentSchema.optional(),
    reviewCandidateCheckout: reviewCandidateCheckoutSchema.optional(),
    reviewCandidateObservation: reviewCandidateObservationSchema.optional(),
    reviewRoleRequirementId: id.optional(),
    reviewRoleId: z.literal("independent-reviewer").optional(),
    reviewRoleGeneration: z.number().int().positive().optional(),
    reviewFrozenBriefVersion: z.literal(1).optional(),
    reviewFrozenBriefContent: z.string().max(256 * 1024).optional(),
    reviewFrozenBriefDigest: digestSchema.optional(),
    reviewReturnPath: reviewReturnPathSchema.optional(),
    dispatchInputDigest: digestSchema.optional(),
  })
  .strict()
  .superRefine((attempt, ctx) => {
    const reviewFields = [
      attempt.candidateKind,
      attempt.reviewPrNumber,
      attempt.reviewPrHeadSha,
      attempt.reviewBaseSha,
      attempt.reviewCandidateSha,
      attempt.reviewCandidateEnvironment,
      attempt.reviewCandidateCheckout,
      attempt.reviewCandidateObservation,
      attempt.reviewRoleRequirementId,
      attempt.reviewRoleId,
      attempt.reviewRoleGeneration,
      attempt.reviewFrozenBriefVersion,
      attempt.reviewFrozenBriefContent,
      attempt.reviewFrozenBriefDigest,
      attempt.reviewReturnPath,
      attempt.dispatchInputDigest,
    ];
    const linked = reviewFields.some((value) => value !== undefined);
    if (attempt.assignmentKind !== "review") {
      if (linked) ctx.addIssue({ code: "custom", message: "review candidate linkage is valid only for review attempts" });
      return;
    }
    if (attempt.candidateKind === undefined) {
      ctx.addIssue({ code: "custom", path: ["candidateKind"], message: "review attempts require an explicit candidate kind" });
      return;
    }
    if (attempt.candidateKind === "pull-request") {
      if (attempt.reviewPrNumber === undefined || attempt.reviewPrHeadSha === undefined) {
        ctx.addIssue({ code: "custom", message: "pull-request reviews require an exact PR number and head SHA" });
      }
      if (attempt.reviewBaseSha !== undefined || attempt.reviewCandidateSha !== undefined || attempt.reviewCandidateEnvironment !== undefined || attempt.reviewCandidateCheckout !== undefined || attempt.reviewCandidateObservation !== undefined || attempt.reviewRoleRequirementId !== undefined || attempt.reviewRoleId !== undefined || attempt.reviewRoleGeneration !== undefined || attempt.reviewFrozenBriefVersion !== undefined || attempt.reviewFrozenBriefContent !== undefined || attempt.reviewFrozenBriefDigest !== undefined || attempt.reviewReturnPath !== undefined || attempt.dispatchInputDigest !== undefined) {
        ctx.addIssue({ code: "custom", message: "pull-request reviews cannot carry local candidate identity" });
      }
    } else {
      if (attempt.reviewPrNumber !== undefined || attempt.reviewPrHeadSha !== undefined) {
        ctx.addIssue({ code: "custom", message: "local reviews cannot carry pull-request identity" });
      }
      if (attempt.reviewBaseSha === undefined || attempt.reviewCandidateSha === undefined || attempt.reviewCandidateEnvironment === undefined || attempt.reviewCandidateCheckout === undefined || attempt.reviewCandidateObservation === undefined) {
        ctx.addIssue({ code: "custom", message: "local reviews require exact base, candidate, environment, checkout, and clean/reachable observation" });
      }
      if (attempt.reviewCandidateSha !== undefined && attempt.reviewCandidateCheckout !== undefined && attempt.reviewCandidateSha !== attempt.reviewCandidateCheckout.headSha) {
        ctx.addIssue({ code: "custom", path: ["reviewCandidateCheckout", "headSha"], message: "local checkout head must equal the candidate SHA" });
      }
      if (attempt.reviewRoleRequirementId === undefined || attempt.reviewRoleId === undefined || attempt.reviewRoleGeneration === undefined) {
        ctx.addIssue({ code: "custom", message: "local reviews require the exact reviewer requirement and generation" });
      }
      if (attempt.reviewFrozenBriefVersion === undefined || attempt.reviewFrozenBriefContent === undefined || attempt.reviewFrozenBriefDigest === undefined || attempt.reviewReturnPath === undefined) {
        ctx.addIssue({ code: "custom", message: "local reviews require a frozen brief and explicit return path" });
      }
      if (attempt.reviewFrozenBriefContent !== undefined && attempt.reviewFrozenBriefDigest !== undefined && sha256(attempt.reviewFrozenBriefContent) !== attempt.reviewFrozenBriefDigest) {
        ctx.addIssue({ code: "custom", path: ["reviewFrozenBriefDigest"], message: "frozen brief digest must equal the brief content" });
      }
    }
  });

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

function profileIsOneOf(profile: unknown, profiles: readonly unknown[]): boolean {
  const value = canonicalJson(profile);
  return profiles.some((candidate) => value === canonicalJson(candidate));
}

function isRatifiedDirectorSeatRequirement(requirement: {
  roleRequirementId: string;
  executedProfile: unknown;
  standbyProfile?: unknown;
}): boolean {
  return requirement.roleRequirementId === DIRECTOR_SEAT_ROLE_REQUIREMENT_ID &&
    profileIsOneOf(requirement.executedProfile, directorSeatProfiles) &&
    profileIsOneOf(requirement.standbyProfile, directorSeatProfiles) &&
    canonicalJson(requirement.executedProfile) !== canonicalJson(requirement.standbyProfile);
}

const roleRequirementSchema = z
  .object({
    roleRequirementId: id,
    roleId: roleIdSchema,
    repoTargetId: id.nullable(),
    executedProfile: executionProfileSchema,
    standbyProfile: executionProfileSchema.optional(),
    writingLaneCapacity: z.literal(0).optional(),
  })
  .strict()
  .superRefine((requirement, ctx) => {
    if (["director", "project-orchestrator"].includes(requirement.roleId) && requirement.repoTargetId !== null) {
      ctx.addIssue({ code: "custom", path: ["repoTargetId"], message: "project-orchestrator must be project-scoped" });
    }
    if (requirement.roleId === "worker" && requirement.repoTargetId === null) {
      ctx.addIssue({ code: "custom", path: ["repoTargetId"], message: "worker requires an exact repository target" });
    }
    if (requirement.roleId === "independent-reviewer" && requirement.repoTargetId === null) {
      ctx.addIssue({ code: "custom", path: ["repoTargetId"], message: "independent-reviewer requires an exact repository target" });
    }
    if (requirement.executedProfile.visibility !== "visible") {
      ctx.addIssue({ code: "custom", path: ["executedProfile", "visibility"], message: "active role holders must be visible" });
    }
    const isDirectorSeat = requirement.roleRequirementId === DIRECTOR_SEAT_ROLE_REQUIREMENT_ID;
    if (requirement.roleId === "director" && !isDirectorSeat) {
      ctx.addIssue({ code: "custom", path: ["roleRequirementId"], message: "director role is reserved for director-seat" });
    }
    if (isDirectorSeat) {
      if (requirement.roleId !== "director") {
        ctx.addIssue({ code: "custom", path: ["roleId"], message: "director-seat must use the director role" });
      }
      if (requirement.repoTargetId !== null) {
        ctx.addIssue({ code: "custom", path: ["repoTargetId"], message: "director-seat must be project-scoped" });
      }
      if (requirement.writingLaneCapacity !== 0) {
        ctx.addIssue({ code: "custom", path: ["writingLaneCapacity"], message: "director-seat has no writing-lane capacity" });
      }
      if (!isRatifiedDirectorSeatRequirement(requirement)) {
        ctx.addIssue({ code: "custom", path: ["executedProfile"], message: "director-seat requires the exact ratified profile pair" });
      }
    } else if (requirement.standbyProfile !== undefined || requirement.writingLaneCapacity !== undefined) {
      ctx.addIssue({ code: "custom", path: ["roleRequirementId"], message: "standby profile and writing capacity are reserved for director-seat" });
    }
  });
const roleRequirementsSchema = z.array(roleRequirementSchema).max(128).superRefine((requirements, ctx) => {
  const requirementIds = new Set<string>();
  const seatRoleIds = new Set<string>();
  const selectors = new Set<string>();
  requirements.forEach((requirement, index) => {
    if (requirementIds.has(requirement.roleRequirementId)) {
      ctx.addIssue({ code: "custom", path: [index, "roleRequirementId"], message: "duplicate role requirement" });
    }
    if (["director", "project-orchestrator"].includes(requirement.roleId) && seatRoleIds.has(requirement.roleId)) {
      ctx.addIssue({ code: "custom", path: [index, "roleId"], message: "duplicate logical role" });
    }
    const selector = canonicalJson([requirement.roleId, requirement.repoTargetId, requirement.executedProfile]);
    if (selectors.has(selector)) {
      ctx.addIssue({ code: "custom", path: [index], message: "duplicate indistinguishable role requirement selector" });
    }
    requirementIds.add(requirement.roleRequirementId);
    if (["director", "project-orchestrator"].includes(requirement.roleId)) seatRoleIds.add(requirement.roleId);
    selectors.add(selector);
  });
});
const domainSchema = z.object({
  domainId: id,
  taskClasses: z.array(id).min(1).max(128),
  roleRequirements: roleRequirementsSchema,
}).strict().superRefine((domain, ctx) => {
  if (new Set(domain.taskClasses).size !== domain.taskClasses.length) {
    ctx.addIssue({ code: "custom", path: ["taskClasses"], message: "domain task classes must be unique" });
  }
});
const domainsSchema = z.array(domainSchema).min(1).max(128).superRefine((domains, ctx) => {
  const domainIds = new Set<string>();
  const taskClasses = new Set<string>();
  const requirementIds = new Set<string>();
  for (const [index, domain] of domains.entries()) {
    if (domainIds.has(domain.domainId)) ctx.addIssue({ code: "custom", path: [index, "domainId"], message: "duplicate domain" });
    domainIds.add(domain.domainId);
    for (const taskClass of domain.taskClasses) {
      if (taskClasses.has(taskClass)) ctx.addIssue({ code: "custom", path: [index, "taskClasses"], message: "task class is ambiguous across domains" });
      taskClasses.add(taskClass);
    }
    for (const requirement of domain.roleRequirements) {
      if (requirementIds.has(requirement.roleRequirementId)) ctx.addIssue({ code: "custom", path: [index, "roleRequirements"], message: "role requirement identity is ambiguous across domains" });
      requirementIds.add(requirement.roleRequirementId);
    }
  }
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
export const CANONICAL_MUTATION_CLASSES = [
  "bootstrap",
  "config_revision",
  "governor_claim",
  "decision_create",
  "decision_disposition",
  "work_item_create",
  "work_item_transition",
  "execution_attempt_terminal_report",
  "execution_attempt_interruption",
  "github_issue_projection",
  "github_pr_observation_record",
  "qualification_observation_record",
  "role_generation_succession",
  "migration_prepare",
  "migration_step",
] as const;
export type OperatorReceiptProvenance = "console" | "attestation";

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
    assignmentId: id.nullable(),
    executionAttemptId: id,
    workItemId: id,
    roleId: roleIdSchema.nullable(),
    roleGeneration: z.number().int().positive().nullable(),
    repoTargetId: id,
    environmentId: id.nullable(),
    threadId: id,
    branchName: id.nullable(),
    baseSha: gitShaSchema.nullable(),
    candidateSha: gitShaSchema.nullable(),
    nativeReceiptDigest: digestSchema,
    actualProfileDigest: digestSchema,
    candidateObservationDigest: digestSchema,
    reasonCode: id,
    nativeEventId: id,
    nativeEventSeq: z.number().int().positive(),
    nativeTurnId: id,
    evidence: z.array(terminalEvidenceSchema).min(1).max(64),
    reportedAtMs: z.number().int().nonnegative().optional(),
    receiptEventId: id.optional(),
    receiptEventSeq: z.number().int().positive().optional(),
    receivedAtMs: z.number().int().nonnegative().optional(),
  })
  .strict();
const reviewHandoffSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("accepted-write-terminal-report"),
    executionAttemptId: id,
    terminalReportDigest: digestSchema,
    terminalEventId: id,
    terminalEventSeq: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal("active-write-legacy-handoff"),
    executionAttemptId: id,
  }).strict(),
]);
type ReviewHandoff = z.infer<typeof reviewHandoffSchema>;
const LEGACY_REVIEW_HANDOFF_REASON = "legacy-work-item-review-handoff";
const interruptionEvidenceSchema = z
  .object({
    projectId: id,
    workItemId: id,
    executionAttemptId: id,
    threadId: id,
    reason: z.enum(["manual-stop", "host-daemon-restarted", "provider-turn-idle"]),
    nativeEventType: z.literal("system/thread/interrupted"),
    nativeEventId: id,
    nativeEventSeq: z.number().int().positive(),
    nativeTurnId: id.nullable(),
    evidenceDigest: digestSchema,
  })
  .strict();
const historicalCorrectionSchema = z
  .object({
    correctionId: id,
    priorState: z.literal("done"),
    evidenceDigest: digestSchema,
    evidence: z.array(z.object({
      eventId: id,
      eventSeq: z.number().int().positive(),
    }).strict()).min(2).max(16),
  })
  .strict();
const threadlessPreparedClosureSchema = z
  .object({
    correctionId: id,
    dispatchMarker: id,
    evidence: z.tuple([
      z.object({
        kind: z.literal("preparation"),
        eventSequence: z.number().int().positive(),
        reference: id,
        digest: digestSchema,
      }).strict(),
      z.object({
        kind: z.enum(["dispatch_guard_proof", "dispatch_refusal"]),
        reference: id,
        digest: digestSchema,
      }).strict(),
      z.object({
        kind: z.literal("replay_conflict"),
        reference: id,
        requestDigest: digestSchema,
        digest: digestSchema,
      }).strict(),
      z.object({
        kind: z.enum(["terminalization_guard_proof", "terminalization_refusal"]),
        reference: id,
        digest: digestSchema,
      }).strict(),
      z.object({
        kind: z.literal("zero_thread"),
        reference: id,
        population: z.object({
          projectId: id,
          source: z.literal("bb.sdk.threads.list"),
          active: z.literal("all pages with archived=false"),
          archived: z.literal("all pages with archived=true"),
          deleted: z.literal("excluded because threads.list does not expose deleted history"),
        }).strict(),
        activeCount: z.number().int().nonnegative(),
        archivedCount: z.number().int().nonnegative(),
        matchingCount: z.literal(0),
        observationCount: z.literal(2).optional(),
        observationBound: z.literal(THREADLESS_PREPARED_INVENTORY_OBSERVATION_BOUND).optional(),
        snapshotDigest: digestSchema.optional(),
        digest: digestSchema,
      }).strict(),
    ]),
  })
  .strict();
const strandedExecutionAttemptClosureSchema = z
  .object({
    correctionId: id,
    evidence: z.object({
      kind: z.literal("stranded-execution-attempt"),
      projectId: id,
      workItemId: id,
      executionAttemptId: id,
      threadId: id,
      nativeEventId: id,
      nativeEventSeq: z.number().int().positive(),
      nativeTurnId: id,
      incapacity: z.enum(["environment-unavailable", "native-correlation-ambiguous"]),
      digest: digestSchema,
    }).strict(),
  })
  .strict();

export const applyRequestSchema = z
  .object({
    projectId: id,
    operationClass: z.enum(CANONICAL_MUTATION_CLASSES),
    idempotencyKey: id,
    actorReceiptId: id.nullable().optional(),
    bootstrapAuthority: bootstrapAuthoritySchema.optional(),
    expectedConfigRevision: z.number().int().nonnegative().nullable().optional(),
    configRevision: z.number().int().positive().nullable().optional(),
    expectedGovernanceEpoch: z.number().int().nonnegative().nullable().optional(),
    expectedFenceToken: id.nullable().optional(),
    repoTargetId: id.nullable().optional(),
    domainId: id.optional(),
    taskClass: id.optional(),
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
    workItemBody: z.string().max(64 * 1024).optional(),
    lifecycleState: workItemStateSchema.optional(),
    workItemWait: workItemWaitSchema.nullable().optional(),
    workItemUnblock: workItemBlockerSchema.optional(),
    workItemExternalEvent: workItemExternalEventSchema.optional(),
    githubPrObservation: githubPrObservationSchema.optional(),
    githubPrDeliveryDisposition: z.enum(["cancelled", "delivery_ambiguous"]).optional(),
    satisfactionEvidence: workItemSatisfactionEvidenceSchema.optional(),
    projectionRecoveryEvidence: projectionRecoveryEvidenceSchema.optional(),
    workAttempt: workAttemptSchema.optional(),
    reviewHandoff: reviewHandoffSchema.optional(),
    projectionKind: z.literal("github_issue").optional(),
    queueLabel: z.literal("queue:dispatched").optional(),
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
    standbyProfile: executionProfileSchema.optional(),
    assignment: assignmentIntentSchema.optional(),
    assignmentId: id.optional(),
    executionAttemptId: id.optional(),
    frozenBriefContent: z.string().max(256 * 1024).optional(),
    terminalReport: terminalReportSchema.optional(),
    interruption: interruptionEvidenceSchema.optional(),
    historicalCorrection: historicalCorrectionSchema.optional(),
    threadlessPreparedClosure: threadlessPreparedClosureSchema.optional(),
    strandedExecutionAttemptClosure: strandedExecutionAttemptClosureSchema.optional(),
    migration: migrationPrepareSchema.optional(),
    migrationStep: migrationStepSchema.optional(),
  })
  .strict();

export type ApplyRequest = z.infer<typeof applyRequestSchema>;
export type GithubPrWait = z.infer<typeof githubPrConditionSchema>;
export type GithubPrWaitRegistration = z.infer<typeof githubPrWaitSchema>;
export type GithubPrObservation = z.infer<typeof githubPrObservationSchema>;
export const registerProjectRequestSchema = z
  .object({
    projectId: id,
    idempotencyKey: id,
    runtimeId: id.optional(),
    config: z.unknown(),
    targets: targetCollectionSchema,
    bootstrapAuthority: bootstrapAuthoritySchema,
  })
  .strict();
export type RegisterProjectRequest = z.infer<typeof registerProjectRequestSchema>;

export function parseRegisterProjectRequest(input: unknown): ApplyRequest {
  const parsed = registerProjectRequestSchema.safeParse(input);
  if (!parsed.success) throw refusal("INVALID_INPUT", parsed.error.message);
  return parseApplyRequest({
    ...parsed.data,
    operationClass: "bootstrap",
    actorReceiptId: null,
    expectedConfigRevision: null,
    configRevision: 1,
    expectedGovernanceEpoch: null,
    expectedFenceToken: null,
    repoTargetId: null,
  });
}

type DecisionEvidenceInput = z.infer<typeof decisionEvidenceSchema>;
export type SqliteDatabase = Database.Database;

export interface GitHubIssueSnapshot {
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason?: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED";
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
  readAsync?(owner: string, repo: string, issueNumber: number): Promise<GitHubIssueSnapshot | null>;
  mutateAsync?(input: GitHubIssueMutation): Promise<GitHubIssueSnapshot>;
}

export type GitHubIssueReader = (owner: string, repo: string, issueNumber: number, connectorHost?: string) => GitHubIssueSnapshot | null;

export interface RoleThreadFact {
  id: string;
  projectId: string;
  environmentId: string | null;
  providerId: string;
  title: string | null;
  titleFallback: string | null;
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
  threadId?: string;
  seq: number;
  type: string;
  scope?: { kind: "thread" } | { kind: "turn"; turnId: string };
  data: Record<string, unknown>;
}

export interface RoleFactReader {
  serverId(): string;
  thread(threadId: string): RoleThreadFact;
  event(threadId: string, eventId: string, eventSeq: number): RoleEventFact;
  eventsAfter(threadId: string, afterSeq: number, limit: number): RoleEventFact[];
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

export type AuthoritativeTerminalEvidence = {
  projectId: string;
  workItemId: string;
  executionAttemptId: string;
  repoTargetId: string;
  resourceRevision: number;
  assignmentId: string | null;
  roleId: (typeof ROLE_IDS)[number] | null;
  roleGeneration: number | null;
  environmentId: string | null;
  threadId: string;
  branchName: string | null;
  baseSha: string | null;
  candidateSha: string | null;
  nativeReceiptDigest: string;
  actualProfileDigest: string;
  candidateObservationDigest: string;
  nativeEventId: string;
  nativeEventSeq: number;
  nativeTurnId: string;
  evidence: Array<{ kind: string; digest: string; ref: string }>;
};

export function threadlessPreparedReplayProbeDigest(input: {
  projectId: string;
  workItemId: string;
  executionAttemptId: string;
  idempotencyKey: string;
}): string {
  return sha256(canonicalJson({
    kind: "threadless-prepared-closure-replay-probe",
    ...input,
  }));
}

export type ThreadlessPreparedOrigin = {
  eventSequence: number;
  eventType: "work_item_transitioned" | "work_item_attempt_registered";
  eventJson: string;
  idempotencyKey: string;
  requestDigest: string;
};

export function resolveThreadlessPreparedOrigin(
  db: SqliteDatabase,
  input: { projectId: string; workItemId: string; executionAttemptId: string; idempotencyKey: string },
): ThreadlessPreparedOrigin {
  const rows = db.prepare(
    `SELECT e.event_sequence, e.event_type, e.event_json, e.idempotency_key,
            m.request_digest, m.committed_event_sequence, m.operation_class
     FROM state_events e
     LEFT JOIN mutation_receipts m
       ON m.project_id = e.project_id AND m.idempotency_key = e.idempotency_key
     WHERE e.project_id = ? AND e.aggregate_type = 'work_item' AND e.aggregate_id = ?
       AND e.event_type IN ('work_item_transitioned', 'work_item_attempt_registered')
       AND json_extract(e.event_json, '$.executionAttemptId') = ?
     ORDER BY e.event_sequence`,
  ).all(input.projectId, input.workItemId, input.executionAttemptId) as Array<{
    event_sequence: number;
    event_type: string;
    event_json: string;
    idempotency_key: string;
    request_digest: string | null;
    committed_event_sequence: number | null;
    operation_class: string | null;
  }>;
  if (rows.length !== 1) {
    throw refusal("WORK_ITEM_STATE_INVALID", "thread-less closure requires one exact durable dispatch preparation and intent receipt");
  }
  const row = rows[0]!;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.event_json) as Record<string, unknown>;
  } catch {
    throw refusal("WORK_ITEM_STATE_INVALID", "thread-less closure preparation event is malformed");
  }
  const workAttempt = payload.workAttempt;
  const exactCommon = payload.workItemId === input.workItemId &&
    payload.executionAttemptId === input.executionAttemptId &&
    typeof workAttempt === "object" && workAttempt !== null &&
    (workAttempt as Record<string, unknown>).assignmentKind === "write";
  const exactOrigin = row.event_type === "work_item_transitioned"
    ? exactCommon && (payload.from === "ready" || payload.from === "review_pending") && payload.to === "in_progress"
    : row.event_type === "work_item_attempt_registered" && exactCommon && payload.from === undefined && payload.to === undefined;
  if (
    !exactOrigin || row.idempotency_key !== input.idempotencyKey || row.operation_class !== "work_item_transition" ||
    row.committed_event_sequence !== row.event_sequence || row.request_digest === null
  ) {
    throw refusal("WORK_ITEM_STATE_INVALID", "thread-less closure preparation origin is not the exact durable event and receipt pair");
  }
  return {
    eventSequence: row.event_sequence,
    eventType: row.event_type as ThreadlessPreparedOrigin["eventType"],
    eventJson: row.event_json,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
  };
}

export function threadlessPreparedInventoryEvidenceDigest(input: {
  projectId: string;
  executionAttemptId: string;
  dispatchMarker: string;
  population: ReturnType<typeof threadlessPreparedClosurePopulation>;
  activeCount: number;
  archivedCount: number;
  matchingCount: number;
  observationCount: 2;
  observationBound: typeof THREADLESS_PREPARED_INVENTORY_OBSERVATION_BOUND;
  snapshotDigest: string;
}): string {
  return sha256(canonicalJson({ kind: "threadless-prepared-inventory-evidence", ...input }));
}

export function buildTerminalReport(input: {
  evidence: AuthoritativeTerminalEvidence;
  outcome: "DONE" | "BLOCKED";
  reasonCode: string;
}): TerminalReport {
  return {
    receiptVersion: 1,
    outcome: input.outcome,
    projectId: input.evidence.projectId,
    assignmentId: input.evidence.assignmentId,
    executionAttemptId: input.evidence.executionAttemptId,
    workItemId: input.evidence.workItemId,
    roleId: input.evidence.roleId,
    roleGeneration: input.evidence.roleGeneration,
    repoTargetId: input.evidence.repoTargetId,
    environmentId: input.evidence.environmentId,
    threadId: input.evidence.threadId,
    branchName: input.evidence.branchName,
    baseSha: input.evidence.baseSha,
    candidateSha: input.evidence.candidateSha,
    nativeReceiptDigest: input.evidence.nativeReceiptDigest,
    actualProfileDigest: input.evidence.actualProfileDigest,
    candidateObservationDigest: input.evidence.candidateObservationDigest,
    reasonCode: input.reasonCode,
    nativeEventId: input.evidence.nativeEventId,
    nativeEventSeq: input.evidence.nativeEventSeq,
    nativeTurnId: input.evidence.nativeTurnId,
    evidence: input.evidence.evidence,
  };
}

export type AuthoritativeHistoricalInterruption = {
  projectId: string;
  workItemId: string;
  executionAttemptId: string;
  repoTargetId: string;
  resourceRevision: number;
  threadId: string;
  reason: InterruptionEvidence["reason"];
  nativeEventId: string;
  nativeEventSeq: number;
  nativeTurnId: string | null;
  evidenceDigest: string;
  correctionEvidenceDigest: string;
  evidence: Array<{
    eventId: string;
    eventSeq: number;
    threadId: string;
    eventType: "system/thread/interrupted" | "turn/completed";
    turnId: string | null;
    providerThreadId: string | null;
    status: "interrupted" | null;
    reason: InterruptionEvidence["reason"] | null;
  }>;
  zeroRealWriter: boolean;
};

export interface ExecutionAttemptEvidenceReader {
  terminal(input: { projectId: string; workItemId: string; executionAttemptId: string; nativeEventId: string; nativeEventSeq: number; nativeTurnId: string }): AuthoritativeTerminalEvidence;
  historical(input: { projectId: string; workItemId: string; executionAttemptId: string; nativeEventId: string; nativeEventSeq: number; threadId: string }): AuthoritativeHistoricalInterruption;
}

export interface ResolvedRoleContext {
  profile: ExecutionProfile;
  requestedProfileDigest: string;
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

function turnScopeId(event: RoleEventFact): string | null {
  return event.scope?.kind === "turn" ? stringField(event.scope.turnId) : null;
}

export function roleContextPreflightRefusal(
  facts: {
    thread: RoleThreadFact;
    requestEvent: RoleEventFact;
    completion: RoleEventFact;
    environment: RoleEnvironmentFact;
    project: RoleProjectFact;
    host: RoleHostFact;
    bbVersion: string;
    bbServerId: string;
  },
  request: ApplyRequest,
): readonly [FoundationCode, string] | null {
  const roleContext = request.roleContext;
  if (!roleContext) return ["ROLE_CONTEXT_REQUIRED", "exact BB role context facts are required"];
  if (roleContext.completionEventSeq <= roleContext.requestEventSeq) {
    return ["EXECUTION_COMPLETION_AMBIGUOUS", "completion event sequence does not follow the request event sequence"];
  }
  if (facts.thread.id !== roleContext.threadId || facts.thread.projectId !== request.projectId || facts.project.id !== request.projectId) {
    return ["ROLE_CONTEXT_FOREIGN", "thread or project context belongs to another project"];
  }
  if (/\bwitness\b/iu.test(`${facts.thread.title ?? ""}\n${facts.thread.titleFallback ?? ""}`)) {
    return ["ROLE_CONTEXT_WITNESS", "witness threads cannot hold active roles"];
  }
  if (facts.thread.visibility !== "visible") return ["ROLE_CONTEXT_HIDDEN", "hidden threads cannot hold active roles"];
  if (facts.thread.status !== "active" && facts.thread.status !== "idle") return ["ROLE_CONTEXT_UNKNOWN", "holder thread is not in a usable execution state"];
  if (facts.environment.id !== facts.thread.environmentId || facts.environment.projectId !== request.projectId) {
    return ["ROLE_CONTEXT_FOREIGN", "environment context does not match the holder thread and project"];
  }
  const exactManagedWorktree =
    facts.environment.status === "ready" && !!facts.environment.path && facts.environment.managed && facts.environment.isGitRepo && facts.environment.isWorktree &&
    facts.environment.workspaceProvisionType === "managed-worktree";
  if (!exactManagedWorktree) return ["ROLE_CONTEXT_FOREIGN", "holder environment is not an exact ready managed worktree"];
  const sources = facts.project.sources.filter(
    (source) => source.projectId === request.projectId && source.hostId === facts.environment.hostId,
  );
  if (sources.length !== 1) return ["ROLE_CONTEXT_FOREIGN", "holder environment does not resolve to one exact project source on its host"];
  if (facts.host.id !== facts.environment.hostId || facts.host.status !== "connected") return ["ROLE_CONTEXT_UNKNOWN", "holder host is unavailable"];
  if (!stringField(facts.bbVersion) || !stringField(facts.bbServerId)) {
    return ["ROLE_CONTEXT_UNKNOWN", "BB version or event facts are unavailable"];
  }
  if (
    facts.requestEvent.id !== roleContext.requestEventId || facts.requestEvent.seq !== roleContext.requestEventSeq ||
    facts.requestEvent.type !== "client/turn/requested"
  ) {
    return ["EXECUTION_PROFILE_UNKNOWN", "the exact execution-bearing request event is unavailable"];
  }
  if (facts.completion.id !== roleContext.completionEventId || facts.completion.seq !== roleContext.completionEventSeq) {
    return ["EXECUTION_COMPLETION_AMBIGUOUS", "completion does not match the exact requested correlation"];
  }
  if (facts.requestEvent.threadId !== roleContext.threadId || facts.completion.threadId !== roleContext.threadId) {
    return ["ROLE_CONTEXT_FOREIGN", "cited role events belong to another native thread"];
  }
  if (facts.requestEvent.scope?.kind !== "thread") {
    return ["EXECUTION_PROFILE_UNKNOWN", "execution request must have thread scope"];
  }
  if (!turnScopeId(facts.completion)) {
    return ["EXECUTION_COMPLETION_AMBIGUOUS", "cited completion turn scope is missing or invalid"];
  }
  return null;
}

export function resolveRoleContext(reader: RoleFactReader | null, request: ApplyRequest): ResolvedRoleContext {
  if (!reader || !request.roleContext) throw refusal("ROLE_CONTEXT_REQUIRED", "exact BB role context facts are required");
  const roleContext = request.roleContext;
  let thread: RoleThreadFact;
  let requestEvent: RoleEventFact;
  let completion: RoleEventFact;
  let correlationEvents: RoleEventFact[];
  let environment: RoleEnvironmentFact;
  let project: RoleProjectFact;
  let host: RoleHostFact;
  let bbVersion: string;
  let bbServerId: string;
  try {
    bbServerId = reader.serverId();
    thread = reader.thread(request.roleContext.threadId);
    requestEvent = reader.event(request.roleContext.threadId, request.roleContext.requestEventId, request.roleContext.requestEventSeq);
    completion = reader.event(request.roleContext.threadId, request.roleContext.completionEventId, request.roleContext.completionEventSeq);
    if (roleContext.completionEventSeq <= roleContext.requestEventSeq) {
      throw refusal("EXECUTION_COMPLETION_AMBIGUOUS", "completion event sequence does not follow the request event sequence");
    }
    if (!thread.environmentId) throw refusal("ROLE_CONTEXT_REQUIRED", "holder thread has no environment");
    environment = reader.environment(thread.environmentId);
    project = reader.project(request.projectId);
    host = reader.host(environment.hostId);
    bbVersion = reader.version();
    const preflightRefusal = roleContextPreflightRefusal(
      { thread, requestEvent, completion, environment, project, host, bbVersion, bbServerId },
      request,
    );
    if (preflightRefusal) throw refusal(...preflightRefusal);
    correlationEvents = [];
    let afterSeq = roleContext.requestEventSeq;
    while (true) {
      const page = reader.eventsAfter(roleContext.threadId, afterSeq, ROLE_CONTEXT_EVENT_PAGE_SIZE);
      correlationEvents.push(...page);
      if (
        page.some((event) => event.id === roleContext.completionEventId && event.seq === roleContext.completionEventSeq) ||
        page.some((event) => event.seq >= roleContext.completionEventSeq) ||
        page.length < ROLE_CONTEXT_EVENT_PAGE_SIZE
      ) {
        break;
      }
      const nextAfterSeq = page.at(-1)!.seq;
      if (nextAfterSeq <= afterSeq) {
        break;
      }
      afterSeq = nextAfterSeq;
    }
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw refusal("ROLE_CONTEXT_UNKNOWN", "one or more exact BB context facts are unavailable");
  }
  // BB-managed worktrees have a derived execution path, not the canonical source path.
  // Keep both exact paths in the evidence and resolve the source only through the
  // native project/host binding; unmanaged or ambiguous contexts already refused above.
  const sources = project.sources.filter(
    (source) => source.projectId === request.projectId && source.hostId === environment.hostId,
  );
  const completionIndex = correlationEvents.findIndex(
    (event) => event.id === roleContext.completionEventId && event.seq === roleContext.completionEventSeq,
  );
  if (completionIndex < 0) {
    throw refusal("EXECUTION_COMPLETION_AMBIGUOUS", "reader-returned correlation is not terminated by the exact cited completion");
  }
  const linkedEvents = correlationEvents.slice(0, completionIndex + 1);
  for (let index = 0; index < linkedEvents.length; index += 1) {
    const event = linkedEvents[index]!;
    if (event.seq <= roleContext.requestEventSeq || (index > 0 && event.seq <= linkedEvents[index - 1]!.seq)) {
      throw refusal("EXECUTION_COMPLETION_AMBIGUOUS", "reader-returned correlation events are not strictly ordered after the cited request");
    }
  }
  const linkedCorrelationEvents = correlationEvents.slice(0, completionIndex);
  if (correlationEvents[completionIndex]!.id !== completion.id || correlationEvents[completionIndex]!.seq !== completion.seq) {
    throw refusal("EXECUTION_COMPLETION_AMBIGUOUS", "reader-returned completion does not match the exact cited completion");
  }
  const events = [requestEvent, ...linkedCorrelationEvents, completion];
  const execution = requestEvent.data.execution as Record<string, unknown> | undefined;
  const requestId = stringField(requestEvent.data.requestId);
  if (!execution || !requestId) throw refusal("EXECUTION_PROFILE_UNKNOWN", "execution request correlation is incomplete");
  const model = stringField(execution.model);
  const reasoningLevel = stringField(execution.reasoningLevel);
  const permissionMode = stringField(execution.permissionMode);
  const serviceTier = stringField(execution.serviceTier);
  const executionSource = stringField(execution.source);
  if (!model || !reasoningLevel || !permissionMode || !serviceTier || executionSource !== "client/turn/requested") {
    throw refusal("EXECUTION_PROFILE_UNKNOWN", "execution profile fields are incomplete");
  }
  const accepted = events.filter(
    (event) => event.type === "turn/input/accepted" && event.data.clientRequestId === requestId,
  );
  if (accepted.length !== 1) throw refusal("EXECUTION_COMPLETION_AMBIGUOUS", "execution input correlation is missing or ambiguous");
  const acceptedEvent = accepted[0]!;
  if (acceptedEvent.threadId !== roleContext.threadId || !turnScopeId(acceptedEvent)) {
    throw refusal("ROLE_CONTEXT_FOREIGN", "execution input belongs to another native thread or turn");
  }
  const providerThreadId = stringField(acceptedEvent.data.providerThreadId);
  if (!providerThreadId) throw refusal("EXECUTION_PROFILE_UNKNOWN", "provider thread correlation is unavailable");
  const turnId = turnScopeId(completion)!;
  const starts = events.filter((event) => event.type === "turn/started" && turnScopeId(event) === turnId);
  if (starts.length !== 1) throw refusal("EXECUTION_PROFILE_UNKNOWN", "correlated execution start is missing or ambiguous");
  const startEvent = starts[0]!;
  if (startEvent.threadId !== roleContext.threadId || startEvent.data.providerThreadId !== providerThreadId) {
    throw refusal("EXECUTION_PROFILE_UNKNOWN", "correlated execution start belongs to another native thread or provider thread");
  }
  const completions = events.filter((event) => event.type === "turn/completed" && turnScopeId(event) === turnId);
  if (completions.length !== 1) throw refusal("EXECUTION_COMPLETION_AMBIGUOUS", "correlated execution completion is missing or ambiguous");
  const correlatedCompletion = completions[0]!;
  if (
    correlatedCompletion.id !== completion.id || correlatedCompletion.seq !== completion.seq ||
    correlatedCompletion.threadId !== roleContext.threadId || correlatedCompletion.data.providerThreadId !== providerThreadId
  ) {
    throw refusal("EXECUTION_COMPLETION_AMBIGUOUS", "completion does not match the exact requested correlation");
  }
  if (!(requestEvent.seq < acceptedEvent.seq && acceptedEvent.seq < startEvent.seq && startEvent.seq < completion.seq)) {
    throw refusal("EXECUTION_COMPLETION_AMBIGUOUS", "request, acceptance, execution start, and completion are not strictly ordered");
  }
  if (completion.data.status !== "completed") throw refusal("EXECUTION_PROFILE_UNKNOWN", "execution did not complete successfully");
  if (events.some((event) => event.type === "provider/modelFallback" && event.data.providerThreadId === providerThreadId && (
    turnScopeId(event) === turnId ||
    (event.scope?.kind === "thread" && acceptedEvent.seq < event.seq && event.seq < completion.seq)
  ))) {
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
    thread: { id: thread.id, projectId: thread.projectId, providerId: thread.providerId, title: thread.title, titleFallback: thread.titleFallback, status: thread.status, visibility: thread.visibility },
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
      turnId,
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
    turnId,
    requestId,
    requestEventId: requestEvent.id,
    requestEventSeq: requestEvent.seq,
    completionEventId: completion.id,
    completionEventSeq: completion.seq,
  }));
  return {
    profile,
    requestedProfileDigest: requestedProfileDigest(profile),
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
  | "DOMAIN_REQUIRED"
  | "DOMAIN_AMBIGUOUS"
  | "DOMAIN_FOREIGN"
  | "DOMAIN_CONFIG_STALE"
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
  | "BOOTSTRAP_AUTHORITY_REQUIRED"
  | "BOOTSTRAP_SOURCE_INVALID"
  | "BOOTSTRAP_DERIVATION_CONFLICT"
  | "BOOTSTRAP_DERIVATION_REUSED"
  | "BOOTSTRAP_GENESIS_REUSED"
  | "BOOTSTRAP_AUTHORITY_INVALID"
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
  | "WORK_ITEM_WAIT_OPEN"
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
  | "ROLE_CONTEXT_WITNESS"
  | "ROLE_HOLDER_MISMATCH"
  | "ROLE_STANDBY_INVALID"
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
  | "OPERATOR_RECEIPT_INVALID"
  | "CONFIG_SECRET_FORBIDDEN"
  | "MALFORMED_JSON"
  | "INVALID_INPUT"
  | "BB_VERSION_INCOMPATIBLE"
  | "BB_FACTS_UNAVAILABLE"
  | "PLUGIN_SOURCE_UNAVAILABLE"
  | "HOST_UNAVAILABLE"
  | "EXPORT_BOUNDED"
  | "SOURCE_FREEZE_UNPROVEN"
  | "IMPORT_EQUIVALENCE_FAILED"
  | "MIGRATION_FIX_FORWARD_REQUIRED";

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
  replay?: boolean;
  subject: string;
  expected: number;
  attempted: number;
  verified: number;
  message?: string;
  structurallyImpossibleAtRevision?: boolean;
  currentConfigRevision?: number;
  expectedConfigRevision?: number;
  currentGovernanceEpoch?: number;
  expectedGovernanceEpoch?: number;
  fenceMatched?: boolean;
  epochPresent?: boolean;
  fencePresent?: boolean;
  currentResourceRevision?: number;
  expectedResourceRevision?: number;
  mutationReceipt?: MutationReceipt;
  actorReceiptId?: string;
  eventSequence?: number;
  eventType?: string;
  evidence?: unknown;
  registration?: "registered" | "already_satisfied" | "refused";
  export?: ExportPayload;
}

export interface ExportPayload {
  manifest: {
    schemaVersion: number;
    contractVersion: number;
    pluginId: string;
    projectId: string;
    migrationStatementIds: number[];
    schemaDigest: string;
    contractDigest: string;
    rowCount: number;
    tableCounts: Record<string, number>;
    recordsDigest: string;
    artifactIndexDigest: string;
    exportRootDigest: string;
  };
  recordsNdjson: string;
  artifactIndex: Array<{
    evidenceId: string;
    evidenceKind: string;
    sourceKind: string;
    sourceRef: string;
    executionAttemptId: string | null;
    contentDigest: string;
    redactedJson: string;
    redactedDigest: string;
    durableRefJson: string;
    artifactIdentityDigest: string;
  }>;
  checksums: Record<string, string>;
}

export interface ExportFilePayload {
  kind: "canonical-export-files";
  complete: true;
  directory: string;
  displayDirectory?: string;
  manifest: ExportPayload["manifest"];
  checksums: ExportPayload["checksums"];
}

type ExportFileInput = Omit<ExportFilePayload, "directory"> & { directory?: string };

interface RefusalData {
  code: FoundationCode;
  message: string;
  structurallyImpossibleAtRevision?: boolean;
  currentConfigRevision?: number;
  expectedConfigRevision?: number;
  currentGovernanceEpoch?: number;
  expectedGovernanceEpoch?: number;
  fenceMatched?: boolean;
  epochPresent?: boolean;
  fencePresent?: boolean;
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

export function refusal(code: FoundationCode, message: string, extra: Omit<RefusalData, "code" | "message"> = {}): Refusal {
  return new Refusal({ code, message, ...extra });
}

export function isRefusal(error: unknown): error is { readonly data: { readonly code: FoundationCode; readonly message: string } } {
  return error instanceof Refusal;
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
  if (config.visibility !== "visible") {
    throw refusal("INVALID_INPUT", "config visibility must be explicitly visible");
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
      const domains = (bbCollab as Record<string, unknown>).domains;
      if (domains !== undefined && roleRequirements !== undefined) {
        throw refusal("INVALID_INPUT", "bbCollab roleRequirements and domains cannot be mixed");
      }
      if (roleRequirements !== undefined) {
        const parsed = roleRequirementsSchema.safeParse(roleRequirements);
        if (!parsed.success) throw refusal("INVALID_INPUT", parsed.error.message);
      }
      if (domains !== undefined) {
        const parsed = domainsSchema.safeParse(domains);
        if (!parsed.success) throw refusal("INVALID_INPUT", parsed.error.message);
      }
      const writingLaneCeiling = (bbCollab as Record<string, unknown>).writingLaneCeiling;
      if (writingLaneCeiling !== undefined && (!Number.isInteger(writingLaneCeiling) || Number(writingLaneCeiling) < 0 || Number(writingLaneCeiling) > MAX_WRITING_LANE_CEILING)) {
        throw refusal("INVALID_INPUT", `writingLaneCeiling must be an integer from 0 through ${MAX_WRITING_LANE_CEILING}`);
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

export function requestedProfileDigest(profile: ExecutionProfile): string {
  return sha256(canonicalJson({ provenance: "client/turn/requested", profile }));
}
type RoleRequirement = z.infer<typeof roleRequirementSchema>;
type OrchestrationDomain = z.infer<typeof domainSchema>;

function domainDefinitionsFromConfigJson(configJson: string): OrchestrationDomain[] {
  const config = JSON.parse(configJson) as {
    extensions?: { bbCollab?: { domains?: unknown; roleRequirements?: unknown } };
  };
  const bbCollab = config.extensions?.bbCollab;
  const stripLegacyFields = (value: unknown) => Array.isArray(value) ? value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
    const { firstGenerationExemption: _legacy, ...requirement } = candidate as Record<string, unknown>;
    return requirement;
  }) : value;
  if (bbCollab?.domains !== undefined) {
    const domains = Array.isArray(bbCollab.domains)
      ? bbCollab.domains.map((domain) => domain && typeof domain === "object" && !Array.isArray(domain)
        ? { ...(domain as Record<string, unknown>), roleRequirements: stripLegacyFields((domain as { roleRequirements?: unknown }).roleRequirements) }
        : domain)
      : bbCollab.domains;
    const parsed = domainsSchema.safeParse(domains);
    if (!parsed.success) throw refusal("DOMAIN_CONFIG_STALE", "stored orchestration domains are invalid");
    return parsed.data;
  }
  const legacy = roleRequirementsSchema.safeParse(stripLegacyFields(bbCollab?.roleRequirements ?? []));
  if (!legacy.success) throw refusal("DOMAIN_CONFIG_STALE", "stored default-domain role requirements are invalid");
  return [{ domainId: "default", taskClasses: ["default"], roleRequirements: legacy.data }];
}

function flatDomainRequirements(configJson: string): Array<RoleRequirement & { domainId: string }> {
  return domainDefinitionsFromConfigJson(configJson).flatMap((domain) => domain.roleRequirements.map((requirement) => ({ ...requirement, domainId: domain.domainId })));
}

function domainForTaskClass(domains: readonly OrchestrationDomain[], taskClass: string, requestedDomainId?: string): OrchestrationDomain {
  const matches = domains.filter((domain) => domain.taskClasses.includes(taskClass));
  if (matches.length === 0) throw refusal("DOMAIN_FOREIGN", "task class is outside the configured orchestration domains");
  if (matches.length !== 1) throw refusal("DOMAIN_AMBIGUOUS", "task class does not resolve to one configured domain");
  if (requestedDomainId !== undefined && matches[0]!.domainId !== requestedDomainId) {
    throw refusal("DOMAIN_FOREIGN", "requested domain does not own the task class");
  }
  return matches[0]!;
}

function persistOrchestrationDomains(db: SqliteDatabase, projectId: string, configRevision: number, configJson: string): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_domains'").get() === undefined) return;
  for (const domain of domainDefinitionsFromConfigJson(configJson)) {
    const identity = { projectId, configRevision, domainId: domain.domainId, taskClasses: domain.taskClasses, roleRequirements: domain.roleRequirements };
    db.prepare(
      `INSERT INTO orchestration_domains
        (project_id, config_revision, domain_id, task_classes_json, role_requirements_json, domain_digest)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(projectId, configRevision, domain.domainId, canonicalJson(domain.taskClasses), canonicalJson(domain.roleRequirements), sha256(canonicalJson(identity)));
  }
}

export function configuredDomains(db: SqliteDatabase, projectId: string, configRevision: number): OrchestrationDomain[] {
  const configJson = storedConfigJson(db, projectId, configRevision);
  const configured = domainDefinitionsFromConfigJson(configJson);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_domains'").get() === undefined) return [{ domainId: "default", taskClasses: ["default"], roleRequirements: configured.flatMap((domain) => domain.roleRequirements) }];
  const rows = db.prepare(
    `SELECT domain_id, task_classes_json, role_requirements_json, domain_digest
       FROM orchestration_domains WHERE project_id = ? AND config_revision = ? ORDER BY domain_id`,
  ).all(projectId, configRevision) as Array<{ domain_id: string; task_classes_json: string; role_requirements_json: string; domain_digest: string }>;
  if (rows.length !== configured.length) throw refusal("DOMAIN_CONFIG_STALE", "domain inventory is incomplete for the exact config revision");
  const result = rows.map((row) => {
    const domain = configured.find((candidate) => candidate.domainId === row.domain_id);
    if (!domain || canonicalJson(domain.taskClasses) !== row.task_classes_json || canonicalJson(domain.roleRequirements) !== row.role_requirements_json) {
      throw refusal("DOMAIN_CONFIG_STALE", "domain inventory does not match the exact immutable config revision");
    }
    const identity = { projectId, configRevision, domainId: domain.domainId, taskClasses: domain.taskClasses, roleRequirements: domain.roleRequirements };
    if (sha256(canonicalJson(identity)) !== row.domain_digest && row.domain_digest !== sha256(configJson)) {
      throw refusal("DOMAIN_CONFIG_STALE", "domain inventory digest is stale or mixed-version");
    }
    return domain;
  });
  return result;
}

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
  const parsed = roleRequirementsSchema.safeParse(Array.isArray(value) ? value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
    const { firstGenerationExemption: _legacy, ...requirement } = candidate as Record<string, unknown>;
    return requirement;
  }) : value);
  if (!parsed.success) throw refusal("INVALID_INPUT", "stored role requirements are invalid");
  return parsed.data;
}

function requireCurrentOperatorReceiptProvenance(value: unknown): asserts value is OperatorReceiptProvenance {
  if (value !== "console" && value !== "attestation") {
    throw refusal("OPERATOR_RECEIPT_INVALID", "operator receipt issuance provenance is unknown");
  }
}

function newApplyProvenanceRefusal(value: unknown): Pick<FoundationResult, "outcome"> {
  try {
    requireCurrentOperatorReceiptProvenance(value);
    return { outcome: "OK" };
  } catch (error) {
    return { outcome: error instanceof Refusal ? error.data.code : "INTERNAL_ERROR" };
  }
}

export function probeV21ConsumedLegacyReplay(db: SqliteDatabase, projectId: string) {
  const replay = asRow<{
    consumed_at_ms: number | null;
    consumed_event_sequence: number | null;
    committed_event_sequence: number;
    operator_receipt_id: string | null;
    outcome_json: string;
  }>(db.prepare(
    `SELECT r.consumed_at_ms, r.consumed_event_sequence, m.committed_event_sequence,
            e.operator_receipt_id, m.outcome_json
       FROM operator_receipts r
       JOIN mutation_receipts m
         ON m.project_id = r.project_id
        AND m.operator_receipt_id = r.receipt_id
        AND m.idempotency_key = r.idempotency_key
        AND m.request_digest = r.request_digest
       JOIN state_events e
         ON e.project_id = m.project_id
        AND e.event_sequence = m.committed_event_sequence
      WHERE r.project_id = ?
        AND r.issuance_provenance IS NULL
        AND r.consumed_at_ms IS NOT NULL
        AND r.consumed_event_sequence = m.committed_event_sequence
        AND e.operator_receipt_id = r.receipt_id
      ORDER BY r.created_at_ms
      LIMIT 1`,
  ).get(projectId));
  const outcome = replay ? JSON.parse(replay.outcome_json) as { outcome?: unknown } : null;
  if (!replay || outcome?.outcome !== "OK") {
    throw new Error("cached-consumer v21 replay proof requires an observed consumed legacy receipt");
  }
  return {
    observedSchemaVersion: SCHEMA_VERSION,
    observedContractVersion: RUNTIME_CONTRACT_VERSION,
    consumedLegacyReplay: { outcome: "OK" as const },
  };
}

export function probeV21NewLegacyApplyProvenanceRefusal() {
  const newApplyRefusal = newApplyProvenanceRefusal(null);
  return { observedSchemaVersion: SCHEMA_VERSION, observedContractVersion: RUNTIME_CONTRACT_VERSION, newApplyRefusal };
}

export function writingLaneCeilingFromJson(configJson: string): number {
  const config = JSON.parse(configJson) as { extensions?: { bbCollab?: { writingLaneCeiling?: unknown } } };
  const value = config.extensions?.bbCollab?.writingLaneCeiling;
  if (value === undefined) return DEFAULT_WRITING_LANE_CEILING;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_WRITING_LANE_CEILING) {
    throw refusal("INVALID_INPUT", `stored writingLaneCeiling must be an integer from 0 through ${MAX_WRITING_LANE_CEILING}`);
  }
  return value;
}

export interface WorkItemDispatchConfigRequest {
  projectId: string;
  workItemId: string;
  repoTargetId: string;
  domainId?: string;
  taskClass?: string;
  expectedConfigRevision: number | null | undefined;
  expectedGovernanceEpoch: number | null | undefined;
  expectedFenceToken: string | null | undefined;
  requestedProfile: ExecutionProfile;
  assignmentKind?: "write" | "review" | "probe";
  candidateKind?: "pull-request" | "local";
}

export interface WorkItemDispatchConfigProof {
  workItemConfigRevision: number;
  currentConfigRevision: number;
  governanceEpoch: number;
  fenceToken: string;
  sourceId: string;
  hostId: string;
  path: string;
  defaultBranch: string;
  domainId: string;
  taskClass: string;
  assignmentKind: "write" | "review";
  reviewerRoleRequirementId?: string;
  reviewerRoleId?: "independent-reviewer";
  reviewerRoleGeneration?: number;
  continued: boolean;
  proofDigest: string;
}

function dispatchProfileIdentity(profile: ExecutionProfile): ExecutionProfile {
  return profile;
}

function dispatchProfileMatches(requested: ExecutionProfile, configured: ExecutionProfile): boolean {
  return canonicalJson(dispatchProfileIdentity(requested)) === canonicalJson(dispatchProfileIdentity(configured));
}

function dispatchTargetIdentity(row: Record<string, unknown>): Record<string, unknown> {
  return {
    projectId: row.project_id,
    repoTargetId: row.repo_target_id,
    sourceId: row.source_id,
    hostId: row.host_id,
    path: row.path,
    defaultBranch: row.default_branch,
  };
}

function dispatchWorkerScope(db: SqliteDatabase, projectId: string, configRevision: number, repoTargetId: string, domainId: string, taskClass: string): { roleId: "worker"; repoTargetId: string; domainId: string } {
  const domain = domainForTaskClass(configuredDomains(db, projectId, configRevision), taskClass, domainId);
  const requirements = domain.roleRequirements.filter((requirement) => requirement.roleId === "worker" && requirement.repoTargetId === repoTargetId);
  if (requirements.length === 0) throw refusal("PROJECT_CONFIG_STALE", "the exact worker scope is missing from the config revision");
  return { roleId: "worker", repoTargetId, domainId };
}

function dispatchRoleRequirement(db: SqliteDatabase, projectId: string, configRevision: number, repoTargetId: string, domainId: string, taskClass: string, requestedProfile: ExecutionProfile): RoleRequirement & { domainId: string } {
  const domain = domainForTaskClass(configuredDomains(db, projectId, configRevision), taskClass, domainId);
  const requirements = domain.roleRequirements.filter((requirement) => requirement.roleId === "independent-reviewer" && requirement.repoTargetId === repoTargetId && dispatchProfileMatches(requestedProfile, requirement.executedProfile));
  if (requirements.length !== 1) throw refusal("PROJECT_CONFIG_STALE", "the exact independent-reviewer role requirement is missing or ambiguous across the config revision");
  return { ...requirements[0]!, domainId };
}

function dispatchReviewerAuthority(
  db: SqliteDatabase,
  projectId: string,
  configRevision: number,
  repoTargetId: string,
  domainId: string,
  requirement: RoleRequirement & { domainId: string },
): { roleRequirementId: string; roleId: "independent-reviewer"; roleGeneration: number } {
  const head = asRow<{ current_generation: number }>(db.prepare(
    "SELECT current_generation FROM role_generation_heads WHERE project_id = ? AND role_id = 'independent-reviewer' AND domain_id = ?",
  ).get(projectId, domainId));
  if (!head) throw refusal("ROLE_HEAD_UNAVAILABLE", "local review requires a current independent-reviewer generation");
  const rows = db.prepare(
    `SELECT role_id, generation
       FROM role_generations
      WHERE project_id = ? AND role_id = 'independent-reviewer' AND domain_id = ?
        AND generation = ? AND role_requirement_id = ?
        AND repo_target_id = ? AND status = 'active'`,
  ).all(projectId, domainId, head.current_generation, requirement.roleRequirementId, repoTargetId) as Array<{ role_id: string; generation: number }>;
  if (rows.length !== 1 || rows[0]!.role_id !== "independent-reviewer") throw refusal("ROLE_NOT_ACTIVE", "local review requires one exact active independent-reviewer generation");
  return { roleRequirementId: requirement.roleRequirementId, roleId: "independent-reviewer", roleGeneration: rows[0]!.generation };
}

export function proveWorkItemDispatchConfig(
  db: SqliteDatabase,
  request: WorkItemDispatchConfigRequest,
  committedConfigRevision?: number,
): WorkItemDispatchConfigProof {
  const head = currentConfig(db, request.projectId);
  if (!head) throw refusal("PROJECT_CONFIG_REQUIRED", "project has no stored config revision");
  const currentConfigRevision = committedConfigRevision ?? head.config_revision;
  if (committedConfigRevision !== undefined && (committedConfigRevision > head.config_revision || !Number.isSafeInteger(committedConfigRevision))) {
    throw refusal("PROJECT_CONFIG_STALE", "committed dispatch config revision is not an existing revision before the current head");
  }
  if (committedConfigRevision === undefined && request.expectedConfigRevision !== head.config_revision) {
    throw refusal("PROJECT_CONFIG_STALE", "dispatch expected config revision does not match the current head", {
      currentConfigRevision: head.config_revision,
      expectedConfigRevision: request.expectedConfigRevision ?? undefined,
    });
  }
  const governor = asRow<{ governance_epoch: number; fence_token: string }>(db.prepare(
    "SELECT governance_epoch, fence_token FROM project_governorship_heads WHERE project_id = ? AND state = 'target_active'",
  ).get(request.projectId));
  const epochMatched = governor !== undefined && request.expectedGovernanceEpoch === governor.governance_epoch;
  const fenceMatched = governor !== undefined && request.expectedFenceToken === governor.fence_token;
  if (!governor || !epochMatched || !fenceMatched) {
    throw refusal("GOVERNOR_EPOCH_STALE", "dispatch expected governorship epoch or fence token is stale", {
      currentGovernanceEpoch: governor?.governance_epoch,
      expectedGovernanceEpoch: request.expectedGovernanceEpoch ?? undefined,
      ...(governor === undefined ? {} : { fenceMatched }),
    });
  }
  const workItem = asRow<{ config_revision: number; repo_target_id: string; domain_id: string; task_class: string }>(db.prepare(
    "SELECT config_revision, repo_target_id, domain_id, task_class FROM work_items WHERE project_id = ? AND work_item_id = ?",
  ).get(request.projectId, request.workItemId));
  if (!workItem) throw refusal("WORK_ITEM_UNKNOWN", "work item is not known in the exact project");
  if (workItem.repo_target_id !== request.repoTargetId) throw refusal("REPO_TARGET_FOREIGN", "dispatch target does not match the WorkItem target");
  if (request.domainId !== undefined && request.domainId !== workItem.domain_id) throw refusal("DOMAIN_FOREIGN", "dispatch domain does not match the immutable WorkItem domain");
  if (request.taskClass !== undefined && request.taskClass !== workItem.task_class) throw refusal("DOMAIN_FOREIGN", "dispatch task class does not match the immutable WorkItem task class");

  const currentTarget = asRow<Record<string, unknown>>(db.prepare(
    "SELECT * FROM repository_targets WHERE project_id = ? AND repo_target_id = ? AND config_revision = ?",
  ).get(request.projectId, request.repoTargetId, currentConfigRevision));
  const historicalTarget = asRow<Record<string, unknown>>(db.prepare(
    "SELECT * FROM repository_targets WHERE project_id = ? AND repo_target_id = ? AND config_revision = ?",
  ).get(request.projectId, request.repoTargetId, workItem.config_revision));
  if (!currentTarget || !historicalTarget) throw refusal("PROJECT_CONFIG_STALE", "the exact WorkItem target is missing from a config revision");

  const assignmentKind = request.assignmentKind ?? "write";
  if (assignmentKind === "probe") throw refusal("WORK_ITEM_STATE_INVALID", "probe cannot use WorkItem lane dispatch");
  const historicalWorkerScope = assignmentKind === "write"
    ? dispatchWorkerScope(db, request.projectId, workItem.config_revision, request.repoTargetId, workItem.domain_id, workItem.task_class)
    : undefined;
  const currentWorkerScope = assignmentKind === "write"
    ? dispatchWorkerScope(db, request.projectId, currentConfigRevision, request.repoTargetId, workItem.domain_id, workItem.task_class)
    : undefined;
  const historicalRole = assignmentKind === "review"
    ? dispatchRoleRequirement(db, request.projectId, workItem.config_revision, request.repoTargetId, workItem.domain_id, workItem.task_class, request.requestedProfile)
    : undefined;
  const currentRole = assignmentKind === "review"
    ? dispatchRoleRequirement(db, request.projectId, currentConfigRevision, request.repoTargetId, workItem.domain_id, workItem.task_class, request.requestedProfile)
    : undefined;
  const reviewerAuthority = assignmentKind === "review" && request.candidateKind === "local"
    ? dispatchReviewerAuthority(db, request.projectId, currentConfigRevision, request.repoTargetId, workItem.domain_id, currentRole!)
    : undefined;
  const requestedProfile = dispatchProfileIdentity(request.requestedProfile);
  if (assignmentKind === "write" && canonicalJson(historicalWorkerScope) !== canonicalJson(currentWorkerScope)) {
    throw refusal("PROJECT_CONFIG_STALE", "dispatch worker scope is not equivalent across config revisions");
  }
  if (assignmentKind === "review" && (!historicalRole || !currentRole || !dispatchProfileMatches(request.requestedProfile, historicalRole.executedProfile) || !dispatchProfileMatches(request.requestedProfile, currentRole.executedProfile))) {
    throw refusal("PROJECT_CONFIG_STALE", "dispatch profile does not equal the exact historical and current worker requirement");
  }
  const historicalConfigJson = storedConfigJson(db, request.projectId, workItem.config_revision);
  const currentConfigJson = storedConfigJson(db, request.projectId, currentConfigRevision);
  const historicalDispatchConfig = {
    permissionMode: (JSON.parse(historicalConfigJson) as Record<string, unknown>).permissionMode,
    visibility: (JSON.parse(historicalConfigJson) as Record<string, unknown>).visibility,
    writingLaneCeiling: writingLaneCeilingFromJson(historicalConfigJson),
    domainId: workItem.domain_id,
    taskClass: workItem.task_class,
    assignmentKind,
    roleRequirement: assignmentKind === "write" ? historicalWorkerScope : historicalRole,
    target: dispatchTargetIdentity(historicalTarget),
    ...(reviewerAuthority === undefined ? {} : { reviewerAuthority }),
  };
  const currentDispatchConfig = {
    permissionMode: (JSON.parse(currentConfigJson) as Record<string, unknown>).permissionMode,
    visibility: (JSON.parse(currentConfigJson) as Record<string, unknown>).visibility,
    writingLaneCeiling: writingLaneCeilingFromJson(currentConfigJson),
    domainId: workItem.domain_id,
    taskClass: workItem.task_class,
    assignmentKind,
    roleRequirement: assignmentKind === "write" ? currentWorkerScope : currentRole,
    target: dispatchTargetIdentity(currentTarget),
    ...(reviewerAuthority === undefined ? {} : { reviewerAuthority }),
  };
  if (canonicalJson(historicalDispatchConfig) !== canonicalJson(currentDispatchConfig)) {
    throw refusal("PROJECT_CONFIG_STALE", "dispatch-relevant config authority is not equivalent across revisions", {
      currentConfigRevision: head.config_revision,
      expectedConfigRevision: workItem.config_revision,
    });
  }
  const proof = {
    projectId: request.projectId,
    workItemId: request.workItemId,
    repoTargetId: request.repoTargetId,
    workItemConfigRevision: workItem.config_revision,
    currentConfigRevision,
    governanceEpoch: governor.governance_epoch,
    fenceToken: governor.fence_token,
    requestedProfile,
    dispatchConfig: historicalDispatchConfig,
  };
  return {
    workItemConfigRevision: workItem.config_revision,
    currentConfigRevision,
    governanceEpoch: governor.governance_epoch,
    fenceToken: governor.fence_token,
    sourceId: String(currentTarget.source_id),
    hostId: String(currentTarget.host_id),
    path: String(currentTarget.path),
    defaultBranch: String(currentTarget.default_branch),
    domainId: workItem.domain_id,
    taskClass: workItem.task_class,
    assignmentKind,
    ...(reviewerAuthority === undefined ? {} : {
      reviewerRoleRequirementId: reviewerAuthority.roleRequirementId,
      reviewerRoleId: reviewerAuthority.roleId,
      reviewerRoleGeneration: reviewerAuthority.roleGeneration,
    }),
    continued: workItem.config_revision !== currentConfigRevision,
    proofDigest: sha256(canonicalJson(proof)),
  };
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
  if (flatDomainRequirements(configJson).some((requirement) => requirement.repoTargetId && !targetIds.has(requirement.repoTargetId))) {
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
  // Authorization digests use this parsed form. Nullable optionals are
  // materialized as null so omitted and explicit-null requests are identical;
  // resolver-only config/governor guards are projected to null below.
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
    workItemBody: request.workItemBody ?? undefined,
    lifecycleState: request.lifecycleState ?? undefined,
    workItemWait: request.workItemWait === undefined ? undefined : request.workItemWait,
    workItemUnblock: request.workItemUnblock ?? undefined,
    workItemExternalEvent: request.workItemExternalEvent ?? undefined,
    githubPrObservation: request.githubPrObservation ?? undefined,
    githubPrDeliveryDisposition: request.githubPrDeliveryDisposition ?? undefined,
    satisfactionEvidence: request.satisfactionEvidence ?? undefined,
    projectionRecoveryEvidence: request.projectionRecoveryEvidence ?? undefined,
    workAttempt: request.workAttempt ?? undefined,
    reviewHandoff: request.reviewHandoff ?? undefined,
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
    interruption: request.interruption ?? undefined,
    historicalCorrection: request.historicalCorrection ?? undefined,
    threadlessPreparedClosure: request.threadlessPreparedClosure ?? undefined,
  };
}

export function parseApplyRequest(input: unknown): ApplyRequest {
  const parsed = applyRequestSchema.safeParse(input);
  if (!parsed.success) throw refusal("INVALID_INPUT", parsed.error.message);
  const request = normalizeRequest(parsed.data);
  if (request.bootstrapAuthority) {
    const allowedKeys = new Set([
      "projectId", "operationClass", "idempotencyKey", "runtimeId", "config", "targets",
      "bootstrapAuthority", "actorReceiptId", "expectedConfigRevision", "configRevision",
      "expectedGovernanceEpoch", "expectedFenceToken", "repoTargetId",
    ]);
    const unexpectedKeys = Object.entries(parsed.data)
      .filter(([key, value]) => value !== undefined && value !== null && !allowedKeys.has(key))
      .map(([key]) => key);
    if (
      request.operationClass !== "bootstrap" ||
      request.actorReceiptId !== null ||
      request.expectedConfigRevision !== null ||
      request.configRevision !== 1 ||
      request.expectedGovernanceEpoch !== null ||
      request.expectedFenceToken !== null ||
      request.repoTargetId !== null ||
      unexpectedKeys.length > 0
    ) {
      throw refusal("INVALID_INPUT", "bootstrapAuthority requires the exact registerProject request projection");
    }
  }
  if (request.workItemBody !== undefined && request.operationClass !== "work_item_transition") {
    throw refusal("INVALID_INPUT", "workItemBody is valid only on a work item transition");
  }
  return request;
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

function actorReceiptDigest(input: {
  projectId: string;
  receiptId: string;
  actorKind: string;
  subjectId: string;
  roleId: string | null;
  roleGeneration: number | null;
  verificationState: string;
  operatorReceiptId: string | null;
  retirementCondition: string | null;
  domainId?: string | null;
}): string {
  const payload: Record<string, unknown> = {
    projectId: input.projectId,
    receiptId: input.receiptId,
    actorKind: input.actorKind,
    subjectId: input.subjectId,
    roleId: input.roleId,
    roleGeneration: input.roleGeneration,
    verificationState: input.verificationState,
    operatorReceiptId: input.operatorReceiptId,
    retirementCondition: input.retirementCondition,
  };
  if (input.domainId !== undefined && input.domainId !== null) payload.domainId = input.domainId;
  return sha256(canonicalJson(payload));
}

export function mutationRequestDigest(request: ApplyRequest): string {
  return sha256(canonicalJson(Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined))));
}

function refusalResult(subject: string, data: RefusalData, expected = 1, attempted = 0, verified = 0): FoundationResult {
  return result(data.code, subject, data.expected ?? expected, data.attempted ?? attempted, data.verified ?? verified, {
    message: data.message,
    ...(data.structurallyImpossibleAtRevision === undefined ? {} : { structurallyImpossibleAtRevision: data.structurallyImpossibleAtRevision }),
    ...(data.currentConfigRevision === undefined ? {} : { currentConfigRevision: data.currentConfigRevision }),
    ...(data.expectedConfigRevision === undefined ? {} : { expectedConfigRevision: data.expectedConfigRevision }),
    ...(data.currentGovernanceEpoch === undefined ? {} : { currentGovernanceEpoch: data.currentGovernanceEpoch }),
    ...(data.expectedGovernanceEpoch === undefined ? {} : { expectedGovernanceEpoch: data.expectedGovernanceEpoch }),
    ...(data.fenceMatched === undefined ? {} : { fenceMatched: data.fenceMatched }),
    ...(data.epochPresent === undefined ? {} : { epochPresent: data.epochPresent }),
    ...(data.fencePresent === undefined ? {} : { fencePresent: data.fencePresent }),
    ...(data.currentResourceRevision === undefined ? {} : { currentResourceRevision: data.currentResourceRevision }),
    ...(data.expectedResourceRevision === undefined ? {} : { expectedResourceRevision: data.expectedResourceRevision }),
  });
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

function requireConfig(db: SqliteDatabase, request: ApplyRequest, boundWorkItemConfigRevision?: number): number {
  const head = currentConfig(db, request.projectId);
  if (!head) throw refusal("PROJECT_CONFIG_REQUIRED", "project has no stored config revision");
  if (request.expectedConfigRevision !== head.config_revision && request.expectedConfigRevision !== boundWorkItemConfigRevision) {
    throw refusal("PROJECT_CONFIG_STALE", "expected config revision does not match the current head", {
      currentConfigRevision: head.config_revision,
      expectedConfigRevision: request.expectedConfigRevision ?? undefined,
    });
  }
  return head.config_revision;
}

function isBootstrapGenesisReceipt(db: SqliteDatabase, receiptId: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM bootstrap_derivation_receipts WHERE genesis_receipt_id = ?",
  ).get(receiptId));
}

function isLegacyBootstrapGovernor(db: SqliteDatabase, projectId: string, receiptId: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1
     FROM bootstrap_derivation_receipts AS derivations
     JOIN project_governorships AS governors
       ON governors.project_id = derivations.project_id
      AND governors.actor_receipt_id = derivations.genesis_receipt_id
     JOIN project_governorship_heads AS heads
       ON heads.project_id = governors.project_id
      AND heads.governance_epoch = governors.governance_epoch
     WHERE derivations.project_id = ?
       AND derivations.genesis_receipt_id = ?
       AND derivations.operational_actor_receipt_id IS NULL
       AND heads.state = 'target_active'`,
  ).get(projectId, receiptId));
}

function requireActor(db: SqliteDatabase, request: ApplyRequest): string {
  if (!request.actorReceiptId) throw refusal("ACTOR_RECEIPT_REQUIRED", "a typed actor receipt is required");
  const hasDomainColumn = tableColumns(db, "actor_receipts").includes("domain_id");
  const row = asRow<{
    project_id: string;
    actor_kind: string;
    subject_id: string;
    role_id: string | null;
    role_generation: number | null;
    verification_state: string;
    operator_receipt_id: string | null;
    retirement_condition: string | null;
    domain_id: string | null;
    receipt_digest: string;
  }>(
    db.prepare(`SELECT project_id, actor_kind, subject_id, role_id, role_generation, verification_state, operator_receipt_id, retirement_condition, ${hasDomainColumn ? "domain_id" : "NULL AS domain_id"}, receipt_digest FROM actor_receipts WHERE receipt_id = ?`).get(request.actorReceiptId),
  );
  if (!row) throw refusal("ACTOR_RECEIPT_UNKNOWN", "actor receipt is not known");
  if (row.project_id !== request.projectId) throw refusal("ACTOR_RECEIPT_FOREIGN", "actor receipt belongs to another project");
  if (isBootstrapGenesisReceipt(db, request.actorReceiptId) && !isLegacyBootstrapGovernor(db, request.projectId, request.actorReceiptId)) {
    throw refusal("BOOTSTRAP_GENESIS_REUSED", "bootstrap genesis receipt is single-use and cannot authorize a later mutation");
  }
  if (row.verification_state !== "verified") throw refusal("ACTOR_RECEIPT_UNVERIFIED", "actor receipt is not verified");
  const expectedDigest = actorReceiptDigest({
    projectId: row.project_id,
    receiptId: request.actorReceiptId,
    actorKind: row.actor_kind,
    subjectId: row.subject_id,
    roleId: row.role_id,
    roleGeneration: row.role_generation,
    verificationState: row.verification_state,
    operatorReceiptId: row.operator_receipt_id,
    retirementCondition: row.retirement_condition,
    domainId: row.domain_id,
  });
  if (row.receipt_digest !== expectedDigest) throw refusal("ACTOR_RECEIPT_UNVERIFIED", "actor receipt digest is invalid");
  return request.actorReceiptId;
}

function requireGovernor(db: SqliteDatabase, request: ApplyRequest): { governance_epoch: number; fence_token: string; state: string } {
  const head = asRow<{ governance_epoch: number; fence_token: string; state: string }>(
    db.prepare("SELECT governance_epoch, fence_token, state FROM project_governorship_heads WHERE project_id = ?").get(request.projectId),
  );
  // Issue #3 only reports this on an incomplete/corrupt state; no sanctioned path creates it.
  if (!head) throw refusal("GOVERNOR_UNAVAILABLE", "project has no current governorship head");
  const epochMatched = request.expectedGovernanceEpoch === head.governance_epoch;
  const fenceMatched = request.expectedFenceToken === head.fence_token;
  if (!epochMatched || !fenceMatched) {
    throw refusal("GOVERNOR_EPOCH_STALE", "expected governorship epoch or fence token is stale", {
      currentGovernanceEpoch: head.governance_epoch,
      expectedGovernanceEpoch: request.expectedGovernanceEpoch ?? undefined,
      fenceMatched,
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
  allowStaleTarget = false,
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
  const sameProject = asRow<Record<string, unknown>>(
    db.prepare("SELECT * FROM repository_targets WHERE project_id = ? AND repo_target_id = ? ORDER BY config_revision DESC LIMIT 1").get(projectId, targetId),
  );
  if (sameProject && allowStaleTarget) return sameProject;
  if (sameProject) throw refusal("REPO_TARGET_STALE", "repository target is not registered in the expected config revision");
  throw refusal("REPO_TARGET_FOREIGN", "repository target is not registered for this project");
}

export function checkMutationIdempotency(db: SqliteDatabase, request: ApplyRequest): FoundationResult | null {
  try {
    return checkIdempotency(db, request, mutationRequestDigest(request));
  } catch (error) {
    if (isRefusal(error)) return refusalResult(request.projectId, error.data);
    throw error;
  }
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
  const replay = JSON.parse(row.outcome_json) as FoundationResult;
  if (request.operationClass === "github_pr_observation_record" && replay.evidence !== null && typeof replay.evidence === "object" && !Array.isArray(replay.evidence)) {
    replay.evidence = { ...replay.evidence as Record<string, unknown>, wake: false };
  }
  Object.defineProperty(replay, "replay", { value: true });
  return replay;
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
  digest: string,
  actorReceiptId: string,
  event: StateEventInput,
): { eventSequence: number; createdAtMs: number } {
  const eventSequence = nextEventSequence(db, request.projectId);
  const createdAtMs = now();
  db.prepare(
    `INSERT INTO state_events (
      project_id, event_sequence, aggregate_type, aggregate_id, aggregate_revision,
      event_type, actor_receipt_id, operator_receipt_id, idempotency_key, event_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
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
  const { eventSequence, createdAtMs } = appendStateEvent(db, request, digest, actorReceiptId, event);
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
      outcome_json, committed_event_sequence, created_at_ms, operator_receipt_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
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

function deriveBootstrapActor(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
): { actorReceiptId: string; evidence: Record<string, unknown> } {
  const authority = request.bootstrapAuthority;
  if (!authority || request.actorReceiptId) throw refusal("BOOTSTRAP_AUTHORITY_REQUIRED", "bootstrap derivation requires one source authority and no target actor receipt");
  if (authority.sourceProjectId === request.projectId) throw refusal("BOOTSTRAP_SOURCE_INVALID", "bootstrap derivation requires a distinct source project");
  if (db.prepare(
    "SELECT 1 FROM bootstrap_derivation_receipts WHERE derivation_id = ? OR project_id = ? OR genesis_receipt_id = ?",
  ).get(authority.derivationId, request.projectId, authority.genesisReceiptId)) {
    throw refusal("BOOTSTRAP_DERIVATION_REUSED", "bootstrap genesis receipt or derivation is already consumed");
  }
  const sourceHead = asRow<{ governance_epoch: number; fence_token: string; state: string }>(
    db.prepare("SELECT governance_epoch, fence_token, state FROM project_governorship_heads WHERE project_id = ?").get(authority.sourceProjectId),
  );
  if (!sourceHead) throw refusal("GOVERNOR_UNAVAILABLE", "bootstrap source has no current governorship head");
  const epochMatched = sourceHead.governance_epoch === authority.sourceGovernanceEpoch;
  const fenceMatched = sourceHead.fence_token === authority.sourceFenceToken;
  if (!epochMatched || !fenceMatched) {
    throw refusal("GOVERNOR_EPOCH_STALE", "bootstrap source governorship fence or epoch is stale", {
      currentGovernanceEpoch: sourceHead.governance_epoch,
      expectedGovernanceEpoch: authority.sourceGovernanceEpoch,
      fenceMatched,
    });
  }
  if (sourceHead.state !== "target_active") throw refusal("PROJECT_FROZEN", "bootstrap source governorship is not writable");
  const sourceGovernor = asRow<{ actor_receipt_id: string }>(db.prepare(
    `SELECT actor_receipt_id FROM project_governorships
     WHERE project_id = ? AND governance_epoch = ? AND fence_token = ? AND state = 'target_active'`,
  ).get(authority.sourceProjectId, authority.sourceGovernanceEpoch, authority.sourceFenceToken));
  if (!sourceGovernor) throw refusal("BOOTSTRAP_SOURCE_INVALID", "bootstrap source governorship claim is incomplete");
  if (isBootstrapGenesisReceipt(db, sourceGovernor.actor_receipt_id)) {
    throw refusal("BOOTSTRAP_SOURCE_INVALID", "bootstrap source governor cannot be a consumed genesis receipt");
  }
  const sourceActor = asRow<{
    project_id: string; actor_kind: string; subject_id: string; role_id: string | null; role_generation: number | null;
    verification_state: string; operator_receipt_id: string | null; retirement_condition: string | null; domain_id: string | null; receipt_digest: string;
  }>(db.prepare(
    "SELECT project_id, actor_kind, subject_id, role_id, role_generation, verification_state, operator_receipt_id, retirement_condition, domain_id, receipt_digest FROM actor_receipts WHERE project_id = ? AND receipt_id = ?",
  ).get(authority.sourceProjectId, sourceGovernor.actor_receipt_id));
  const sourceActorDigest = sourceActor && actorReceiptDigest({
    projectId: sourceActor.project_id,
    receiptId: sourceGovernor.actor_receipt_id,
    actorKind: sourceActor.actor_kind,
    subjectId: sourceActor.subject_id,
    roleId: sourceActor.role_id,
    roleGeneration: sourceActor.role_generation,
    verificationState: sourceActor.verification_state,
    operatorReceiptId: sourceActor.operator_receipt_id,
    retirementCondition: sourceActor.retirement_condition,
    domainId: sourceActor.domain_id,
  });
  if (!sourceActor || sourceActor.project_id !== authority.sourceProjectId || sourceActor.actor_kind !== "plugin" ||
      sourceActor.subject_id !== PLUGIN_ID || sourceActor.verification_state !== "verified" || sourceActor.receipt_digest !== sourceActorDigest) {
    throw refusal("BOOTSTRAP_SOURCE_INVALID", "bootstrap source governor is not bound to the verified bb-collab plugin actor");
  }
  const sourceConfig = currentConfig(db, authority.sourceProjectId);
  if (!sourceConfig) throw refusal("PROJECT_CONFIG_REQUIRED", "bootstrap source has no current config revision");
  requireBootstrapDecisionAuthority(
    db,
    authority.sourceProjectId,
    sourceConfig.config_revision,
    authority.authorizingDecisionId,
    authority.authorizingDispositionSequence,
    authority.sourceProjectId,
    request.projectId,
  );
  if (db.prepare("SELECT 1 FROM project_config_heads WHERE project_id = ? OR EXISTS (SELECT 1 FROM project_governorship_heads WHERE project_id = ?)").get(request.projectId, request.projectId)) {
    throw refusal("BOOTSTRAP_DERIVATION_CONFLICT", "bootstrap target already has canonical state");
  }
  const existingDerivation = asRow<{ project_id: string; genesis_receipt_id: string }>(db.prepare(
    "SELECT project_id, genesis_receipt_id FROM bootstrap_derivation_receipts WHERE derivation_id = ? OR project_id = ? OR genesis_receipt_id = ?",
  ).get(authority.derivationId, request.projectId, authority.genesisReceiptId));
  if (existingDerivation) throw refusal("BOOTSTRAP_DERIVATION_REUSED", "bootstrap genesis receipt or derivation is already consumed");
  const operationalActorReceiptId = sha256(canonicalJson({
    projectId: request.projectId,
    genesisReceiptId: authority.genesisReceiptId,
    purpose: "bootstrap_operational_actor",
  }));
  if (db.prepare("SELECT 1 FROM actor_receipts WHERE receipt_id = ? OR receipt_id = ?").get(authority.genesisReceiptId, operationalActorReceiptId)) {
    throw refusal("BOOTSTRAP_DERIVATION_CONFLICT", "bootstrap genesis receipt id is already bound");
  }
  const createdAtMs = now();
  const targetActor = {
    projectId: request.projectId,
    receiptId: authority.genesisReceiptId,
    actorKind: "plugin",
    subjectId: PLUGIN_ID,
    roleId: null,
    roleGeneration: null,
    verificationState: "verified",
    operatorReceiptId: null,
    retirementCondition: null,
  };
  db.prepare(
    `INSERT INTO actor_receipts
      (project_id, receipt_id, actor_kind, subject_id, role_id, role_generation, verification_state,
       receipt_digest, issued_at_ms, operator_receipt_id, retirement_condition)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL)`,
  ).run(
    targetActor.projectId,
    targetActor.receiptId,
    targetActor.actorKind,
    targetActor.subjectId,
    targetActor.verificationState,
    actorReceiptDigest(targetActor),
    createdAtMs,
  );
  const operationalActor = {
    projectId: request.projectId,
    receiptId: operationalActorReceiptId,
    actorKind: "plugin",
    subjectId: PLUGIN_ID,
    roleId: null,
    roleGeneration: null,
    verificationState: "verified",
    operatorReceiptId: null,
    retirementCondition: null,
  };
  db.prepare(
    `INSERT INTO actor_receipts
      (project_id, receipt_id, actor_kind, subject_id, role_id, role_generation, verification_state,
       receipt_digest, issued_at_ms, operator_receipt_id, retirement_condition)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL)`,
  ).run(
    operationalActor.projectId,
    operationalActor.receiptId,
    operationalActor.actorKind,
    operationalActor.subjectId,
    operationalActor.verificationState,
    actorReceiptDigest(operationalActor),
    createdAtMs,
  );
  db.prepare(
    `INSERT INTO bootstrap_derivation_receipts
      (project_id, derivation_id, genesis_receipt_id, operational_actor_receipt_id, source_project_id, source_governance_epoch,
       source_fence_token, source_governor_actor_receipt_id, authorizing_decision_id,
       authorizing_disposition_sequence, request_digest, consumed_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    request.projectId,
    authority.derivationId,
    authority.genesisReceiptId,
    operationalActorReceiptId,
    authority.sourceProjectId,
    authority.sourceGovernanceEpoch,
    authority.sourceFenceToken,
    sourceGovernor.actor_receipt_id,
    authority.authorizingDecisionId,
    authority.authorizingDispositionSequence,
    digest,
    createdAtMs,
  );
  return {
    actorReceiptId: operationalActorReceiptId,
    evidence: {
      derivationId: authority.derivationId,
      genesisReceiptId: authority.genesisReceiptId,
      operationalActorReceiptId,
      sourceProjectId: authority.sourceProjectId,
      sourceGovernanceEpoch: authority.sourceGovernanceEpoch,
      sourceFenceToken: authority.sourceFenceToken,
      sourceGovernorActorReceiptId: sourceGovernor.actor_receipt_id,
      authorizingDecisionId: authority.authorizingDecisionId,
      authorizingDispositionSequence: authority.authorizingDispositionSequence,
    },
  };
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
  const config = request.config === undefined ? undefined : validateConfig(request.config);
  if (!config) throw refusal("INVALID_INPUT", "bootstrap requires a config object");
  const targets = requireTargetCollection(request, "bootstrap");
  requireMappedTargets(config, targets);
  const existingConfig = currentConfig(db, request.projectId);
  const existingGovernor = db
    .prepare("SELECT 1 FROM project_governorship_heads WHERE project_id = ?")
    .get(request.projectId);
  if (existingConfig || existingGovernor) {
    throw refusal(request.bootstrapAuthority ? "BOOTSTRAP_DERIVATION_CONFLICT" : "GOVERNOR_CAS_FAILED", "bootstrap head already exists");
  }
  const derived = request.bootstrapAuthority ? deriveBootstrapActor(db, request, digest) : null;
  const actorReceiptId = derived?.actorReceiptId ?? requireActor(db, request);
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
  persistOrchestrationDomains(db, request.projectId, 1, config);
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
    if (isCrossProjectBootstrapDecision(request.projectId, identity.decisionClass, decision.repoTargetId, identity.scopeJson, identity.optionsJson)) {
      throw refusal("ACTOR_RECEIPT_UNVERIFIED", "cross-project bootstrap Decisions require an existing source governorship root");
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
    { expected: targets.length + 2 + (derived ? 3 : 0), attempted: targets.length + 2 + (derived ? 3 : 0), verified: targets.length + 2 + (derived ? 3 : 0) },
    {
      currentConfigRevision: 1,
      currentGovernanceEpoch: 1,
      evidence: {
        configDigest: sha256(config),
        targetDigests: targets.map((target) => ({ repoTargetId: target.repoTargetId, digest: targetDigest(target) })),
        fenceToken,
        ...(derived ? { bootstrapDerivation: derived.evidence } : {}),
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
  persistOrchestrationDomains(db, request.projectId, nextRevision, configJson);
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
  const epochPresent = expectedEpoch !== null && expectedEpoch !== undefined;
  const fencePresent = expectedToken !== null && expectedToken !== undefined;
  if (!epochPresent || !fencePresent) {
    throw refusal("GOVERNOR_EPOCH_STALE", "governor claim requires an expected epoch and fence token", {
      currentGovernanceEpoch: currentHead.governance_epoch,
      expectedGovernanceEpoch: request.expectedGovernanceEpoch ?? undefined,
      epochPresent,
      fencePresent,
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

interface MigrationRunRow {
  migration_id: string;
  project_id: string;
  source_system: "llm-collab";
  source_runtime_id: string;
  target_runtime_id: string;
  source_contract_digest: string;
  source_schema_digest: string;
  source_export_digest: string | null;
  config_revision: number;
  decision_id: string;
  decision_disposition_sequence: number;
  state: (typeof MIGRATION_STATES)[number];
  resource_revision: number;
  source_event_ceiling: number | null;
  source_snapshot_digest: string;
  source_governor_epoch: number;
  target_governor_epoch: number;
  mutator_inventory_digest: string | null;
  quiescence_digest: string | null;
  import_root_digest: string | null;
  equivalence_digest: string | null;
  recovery_digest: string | null;
  retention_until_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}

function exactGovernor(
  db: SqliteDatabase,
  request: ApplyRequest,
): { governance_epoch: number; fence_token: string; state: "source_active" | "frozen" | "target_active" | "retired"; runtime_id: string } {
  const head = asRow<{ governance_epoch: number; fence_token: string; state: "source_active" | "frozen" | "target_active" | "retired"; runtime_id: string }>(
    db.prepare(
      `SELECT heads.governance_epoch, heads.fence_token, heads.state, governors.runtime_id
       FROM project_governorship_heads AS heads
       JOIN project_governorships AS governors
         ON governors.project_id = heads.project_id AND governors.governance_epoch = heads.governance_epoch
       WHERE heads.project_id = ?`,
    ).get(request.projectId),
  );
  if (!head) throw refusal("GOVERNOR_UNAVAILABLE", "project has no current governorship head");
  const epochMatched = request.expectedGovernanceEpoch === head.governance_epoch;
  const fenceMatched = request.expectedFenceToken === head.fence_token;
  if (!epochMatched || !fenceMatched) {
    throw refusal("GOVERNOR_EPOCH_STALE", "expected governorship epoch or fence token is stale", {
      currentGovernanceEpoch: head.governance_epoch,
      expectedGovernanceEpoch: request.expectedGovernanceEpoch ?? undefined,
      fenceMatched,
    });
  }
  return head;
}

function migrationTargetDigest(db: SqliteDatabase, projectId: string, configRevision: number): string {
  const targets = db.prepare(
    `SELECT repo_target_id, source_id, host_id, path, remote_url, default_branch, target_digest
     FROM repository_targets WHERE project_id = ? AND config_revision = ? ORDER BY repo_target_id`,
  ).all(projectId, configRevision);
  if (targets.length === 0) throw refusal("REPO_TARGET_REQUIRED", "migration requires exact configured repository targets");
  return sha256(canonicalJson(targets));
}

function requireBootstrapDecisionAuthority(
  db: SqliteDatabase,
  projectId: string,
  configRevision: number,
  decisionId: string,
  dispositionSequence: number,
  sourceProjectId: string,
  targetProjectId: string,
): void {
  const decision = asRow<DecisionRow>(db.prepare("SELECT * FROM decisions WHERE decision_id = ?").get(decisionId));
  let scope: unknown;
  let options: unknown;
  try {
    scope = JSON.parse(decision?.scope_json ?? "null");
    options = JSON.parse(decision?.options_json ?? "null");
  } catch {
    throw refusal("BOOTSTRAP_AUTHORITY_INVALID", "bootstrap authorizing Decision scope or options are malformed");
  }
  const expectedScope = {
    operation: "cross_project_bootstrap",
    sourceProjectId,
    targetProjectId,
    repoTargetId: null,
  };
  const expectedOptions = { rootOfTrust: "host_local_operator" };
  if (
    decision?.decision_class !== "operator_only" ||
    decision?.repo_target_id !== null ||
    canonicalJson(scope) !== canonicalJson(expectedScope) ||
    canonicalJson(options) !== canonicalJson(expectedOptions)
  ) {
    throw refusal("BOOTSTRAP_AUTHORITY_INVALID", "bootstrap authorizing Decision is not the exact operator-scoped source-to-target authority");
  }
  const sourceGovernor = asRow<{ actor_receipt_id: string }>(db.prepare(
    "SELECT actor_receipt_id FROM project_governorship_heads JOIN project_governorships USING (project_id, governance_epoch) WHERE project_governorship_heads.project_id = ?",
  ).get(sourceProjectId));
  if (!sourceGovernor) throw refusal("GOVERNOR_UNAVAILABLE", "bootstrap source has no current governorship head");
  const storedRoot = storedDecisionAuthorityRoot(decision);
  const currentRoot = currentBootstrapDecisionAuthorityRootForActor(db, sourceProjectId, sourceGovernor.actor_receipt_id);
  if (canonicalJson(storedRoot) !== canonicalJson(currentRoot)) {
    throw refusal("GOVERNOR_EPOCH_STALE", "bootstrap Decision authority root is no longer the current source governorship root");
  }
  requireCurrentAdoptedDecision(db, projectId, configRevision, decisionId, dispositionSequence, "bootstrap", storedRoot);
}

function requireCurrentAdoptedDecision(
  db: SqliteDatabase,
  projectId: string,
  configRevision: number,
  decisionId: string,
  dispositionSequence: number,
  authorityLabel = "bootstrap",
  authorityRoot: DecisionAuthorityRoot | null = null,
): void {
  const decision = asRow<{
    decision_id: string; project_id: string; config_revision: number; repo_target_id: string | null; scope_json: string;
    scope_digest: string; decision_class: string | null; options_json: string | null; decision_identity_digest: string | null;
    current_resource_revision: number;
  }>(db.prepare("SELECT * FROM decisions WHERE decision_id = ?").get(decisionId));
  if (!decision || decision.project_id !== projectId) throw refusal("RESOURCE_UNKNOWN", "authorizing Decision is not known in this project");
  if (decision.config_revision !== configRevision) throw refusal("PROJECT_CONFIG_STALE", "authorizing Decision config revision is stale");
  if (
    !decision.decision_class || !decision.options_json || !decision.decision_identity_digest ||
    decision.scope_digest !== sha256(decision.scope_json) ||
    storedDecisionIdentityDigest(decision) !== decision.decision_identity_digest
  ) throw refusal("INVALID_INPUT", "authorizing Decision identity is invalid");
  const disposition = asRow<{ disposition: string; actor_receipt_id: string; latest_sequence: number }>(db.prepare(
    `SELECT decision_dispositions.disposition, decision_dispositions.actor_receipt_id,
            (SELECT MAX(latest.disposition_sequence) FROM decision_dispositions AS latest
             WHERE latest.decision_id = decision_dispositions.decision_id) AS latest_sequence
     FROM decision_dispositions WHERE decision_id = ? AND disposition_sequence = ?`,
  ).get(decisionId, dispositionSequence));
  if (!disposition || disposition.disposition !== "adopted" || disposition.latest_sequence !== dispositionSequence) {
    throw refusal(authorityLabel === "migration" ? "INVALID_INPUT" : "DECISION_DISPOSITION_INVALID", `${authorityLabel} authority requires the current adopted Decision disposition`);
  }
  const actor = asRow<{
    project_id: string; actor_kind: string; subject_id: string; role_id: string | null; role_generation: number | null;
    verification_state: string; operator_receipt_id: string | null; retirement_condition: string | null; domain_id: string | null; receipt_digest: string;
  }>(db.prepare(
    "SELECT project_id, actor_kind, subject_id, role_id, role_generation, verification_state, operator_receipt_id, retirement_condition, domain_id, receipt_digest FROM actor_receipts WHERE receipt_id = ?",
  ).get(disposition.actor_receipt_id));
  const actorDigest = actor && actorReceiptDigest({
    projectId: actor.project_id,
    receiptId: disposition.actor_receipt_id,
    actorKind: actor.actor_kind,
    subjectId: actor.subject_id,
    roleId: actor.role_id,
    roleGeneration: actor.role_generation,
    verificationState: actor.verification_state,
    operatorReceiptId: actor.operator_receipt_id,
    retirementCondition: actor.retirement_condition,
    domainId: actor.domain_id,
  });
  const bootstrapPluginActor = authorityRoot !== null && disposition.actor_receipt_id === authorityRoot.actorReceiptId &&
    actor?.actor_kind === "plugin" && actor.project_id === projectId && actor.verification_state === "verified" &&
    actor.receipt_digest === authorityRoot.actorReceiptDigest;
  if (!bootstrapPluginActor && (!actor || actor.project_id !== projectId || actor.verification_state !== "verified" || actor.receipt_digest !== actorDigest)) {
    throw refusal("ACTOR_RECEIPT_UNVERIFIED", "authorizing Decision actor receipt is not verified");
  }
}

function rotateMigrationGovernor(
  db: SqliteDatabase,
  request: ApplyRequest,
  actorReceiptId: string,
  head: ReturnType<typeof exactGovernor>,
  runtimeId: string,
  state: "source_active" | "frozen" | "target_active",
): { governanceEpoch: number; fenceToken: string } {
  const governanceEpoch = head.governance_epoch + 1;
  const fenceToken = newFenceToken();
  try {
    db.prepare(
      `INSERT INTO project_governorships
        (project_id, governance_epoch, runtime_id, state, fence_token, actor_receipt_id, predecessor_epoch, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(request.projectId, governanceEpoch, runtimeId, state, fenceToken, actorReceiptId, head.governance_epoch, now());
  } catch (error) {
    if (isConstraintError(error)) throw refusal("GOVERNOR_CAS_FAILED", "migration governorship rotation lost its compare-and-swap race");
    throw error;
  }
  const updated = db.prepare(
    `UPDATE project_governorship_heads SET governance_epoch = ?, fence_token = ?, state = ?, updated_at_ms = ?
     WHERE project_id = ? AND governance_epoch = ? AND fence_token = ? AND state = ?`,
  ).run(governanceEpoch, fenceToken, state, now(), request.projectId, head.governance_epoch, head.fence_token, head.state);
  if (updated.changes !== 1) throw refusal("GOVERNOR_CAS_FAILED", "migration governorship head compare-and-swap failed");
  return { governanceEpoch, fenceToken };
}

function migrationEvent(
  step: "prepare" | (typeof MIGRATION_STEPS)[number],
  priorState: MigrationRunRow["state"] | null,
  next: MigrationRunRow,
  stepProofDigest: string,
  extra: {
    sourceExportKind?: "canonical_fixture" | "non_canonical_source_evidence";
    canonicalImport?: { expected: number; attempted: number; verified: number };
    equivalenceDisposition?: string;
    governorRelease?: { runtimeId: string; disposition: string };
  } = {},
) {
  return {
    step,
    priorState,
    newState: next.state,
    priorRevision: next.resource_revision - 1,
    newRevision: next.resource_revision,
    sourceGovernorEpoch: next.source_governor_epoch,
    targetGovernorEpoch: next.target_governor_epoch,
    sourceContractDigest: next.source_contract_digest,
    sourceSchemaDigest: next.source_schema_digest,
    sourceExportDigest: next.source_export_digest,
    sourceSnapshotDigest: next.source_snapshot_digest,
    mutatorInventoryDigest: next.mutator_inventory_digest,
    quiescenceDigest: next.quiescence_digest,
    importRootDigest: next.import_root_digest,
    equivalenceDigest: next.equivalence_digest,
    recoveryDigest: next.recovery_digest,
    stepProofDigest,
    ...extra,
  };
}

type SourceEvidenceManifest = z.infer<typeof sourceEvidenceManifestSchema>;

function validateSourceEvidenceManifest(payload: unknown): SourceEvidenceManifest {
  const parsed = sourceEvidenceManifestSchema.safeParse(payload);
  if (!parsed.success) throw refusal("IMPORT_EQUIVALENCE_FAILED", "source evidence manifest identity is invalid");
  const manifestJson = canonicalJson(parsed.data);
  if (Buffer.byteLength(manifestJson, "utf8") > MAX_SOURCE_EVIDENCE_MANIFEST_BYTES) {
    throw refusal("EXPORT_BOUNDED", "source evidence manifest exceeds the bounded byte limit");
  }
  const { manifestDigest, ...withoutDigest } = parsed.data;
  if (sha256(canonicalJson(withoutDigest)) !== manifestDigest) {
    throw refusal("IMPORT_EQUIVALENCE_FAILED", "source evidence manifest digest is not deterministic");
  }
  return parsed.data;
}

function requireZeroCanonicalImport(value: NonNullable<ApplyRequest["migrationStep"]>["canonicalImport"]): { expected: 0; attempted: 0; verified: 0 } {
  if (!value || value.expected !== 0 || value.attempted !== 0 || value.verified !== 0) {
    throw refusal("IMPORT_EQUIVALENCE_FAILED", "evidence-only migration requires exact canonical import zero-work", {
      expected: value?.expected ?? 0,
      attempted: value?.attempted ?? 0,
      verified: value?.verified ?? 0,
    });
  }
  return { expected: 0, attempted: 0, verified: 0 };
}

function recordedSourceEvidenceKind(db: SqliteDatabase, run: MigrationRunRow): boolean {
  const event = asRow<{ event_json: string }>(db.prepare(
    `SELECT event_json FROM state_events
     WHERE project_id = ? AND aggregate_type = 'migration_run' AND aggregate_id = ? AND aggregate_revision = ?
     ORDER BY event_sequence DESC LIMIT 1`,
  ).get(run.project_id, run.migration_id, run.resource_revision));
  if (!event) return false;
  let value: unknown;
  try {
    value = JSON.parse(event.event_json);
  } catch {
    throw refusal("IMPORT_EQUIVALENCE_FAILED", "recorded MigrationRun evidence event is malformed");
  }
  return Boolean(value && typeof value === "object" && (value as { sourceExportKind?: unknown }).sourceExportKind === "non_canonical_source_evidence");
}

function requireEvidenceOnlyReleaseBinding(
  run: MigrationRunRow,
  head: ReturnType<typeof exactGovernor>,
  request: ApplyRequest,
): void {
  if (
    run.target_runtime_id !== PLUGIN_ID ||
    head.runtime_id !== run.source_runtime_id ||
    (request.runtimeId !== undefined && request.runtimeId !== PLUGIN_ID)
  ) {
    throw refusal("IMPORT_EQUIVALENCE_FAILED", "evidence-only governor release requires the exact source and bb-collab runtime binding");
  }
}

function exportRootDirectory(db: SqliteDatabase): string | null {
  const main = (db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find((row) => row.name === "main");
  return main?.file ? join(dirname(main.file), ".bb-collab-exports") : null;
}

const activeExportPartials = new Set<string>();

function sweepPartialExportDirectories(root: string): void {
  try {
    if (!lstatSync(root).isDirectory()) return;
  } catch {
    return;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(".partial-")) continue;
    const partial = join(root, entry.name);
    if (!activeExportPartials.has(partial)) rmSync(partial, { recursive: true, force: true });
  }
}

function readMigrationExportFiles(db: SqliteDatabase, input: ExportFileInput): ExportPayload {
  const root = exportRootDirectory(db);
  if (!root) throw refusal("IMPORT_EQUIVALENCE_FAILED", "file export requires the exact file-backed canonical store");
  let directory: string;
  try {
    const resolvedRoot = realpathSync(root);
    const inputDirectory = input.directory ?? input.displayDirectory;
    if (!inputDirectory) throw new Error("missing path");
    directory = realpathSync(isAbsolute(inputDirectory) ? inputDirectory : join(dirname(root), inputDirectory));
    const nested = relative(resolvedRoot, directory);
    if (!nested || nested.startsWith("..") || isAbsolute(nested) || !basename(directory).startsWith("complete-")) throw new Error("foreign path");
  } catch {
    throw refusal("IMPORT_EQUIVALENCE_FAILED", "file export is not a complete export from the exact canonical store");
  }
  try {
    const manifest = migrationExportManifestSchema.parse(JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")));
    const artifactIndex = z.array(migrationArtifactSchema).parse(JSON.parse(readFileSync(join(directory, "artifact-index.json"), "utf8")));
    if (canonicalJson(manifest) !== canonicalJson(input.manifest)) throw new Error("manifest mismatch");
    return {
      manifest,
      recordsNdjson: readFileSync(join(directory, "records.ndjson"), "utf8"),
      artifactIndex,
      checksums: input.checksums,
    };
  } catch {
    throw refusal("IMPORT_EQUIVALENCE_FAILED", "file export is incomplete or malformed");
  }
}

function validateMigrationExport(
  db: SqliteDatabase,
  input: NonNullable<ApplyRequest["migrationStep"]>["export"],
  projectId: string,
): ExportPayload {
  if (!input) throw refusal("IMPORT_EQUIVALENCE_FAILED", "migration step requires the deterministic fixture export");
  const fromFiles = "kind" in input;
  const payload = fromFiles ? readMigrationExportFiles(db, input) : input;
  const manifest = payload.manifest;
  const expectedTables = Object.fromEntries(TABLES.map((table) => [table, manifest.tableCounts[table] ?? -1]));
  if (
    manifest.schemaVersion !== SCHEMA_VERSION || manifest.contractVersion !== RUNTIME_CONTRACT_VERSION ||
    manifest.pluginId !== PLUGIN_ID || manifest.projectId !== projectId ||
    canonicalJson(manifest.migrationStatementIds) !== canonicalJson(MIGRATIONS.map((_, index) => index)) ||
    manifest.schemaDigest !== schemaDigest || manifest.contractDigest !== contractDigest ||
    Object.keys(manifest.tableCounts).sort().join("\0") !== [...TABLES].sort().join("\0") ||
    Object.values(expectedTables).some((count) => count < 0)
  ) {
    throw refusal("IMPORT_EQUIVALENCE_FAILED", "fixture export identity does not match the exact runtime/schema/project contract");
  }
  const lines = payload.recordsNdjson === "" ? [] : payload.recordsNdjson.split("\n");
  const counts = Object.fromEntries(TABLES.map((table) => [table, 0])) as Record<string, number>;
  let lastTableIndex = -1;
  for (const line of lines) {
    let record: { table?: unknown; row?: unknown };
    try {
      record = JSON.parse(line) as { table?: unknown; row?: unknown };
    } catch {
      throw refusal("IMPORT_EQUIVALENCE_FAILED", "fixture export contains malformed NDJSON");
    }
    if (canonicalJson(record) !== line || typeof record.table !== "string" || !TABLES.includes(record.table as (typeof TABLES)[number])) {
      throw refusal("IMPORT_EQUIVALENCE_FAILED", "fixture export records are not canonical or reference an unknown table");
    }
    const tableIndex = TABLES.indexOf(record.table as (typeof TABLES)[number]);
    if (tableIndex < lastTableIndex) throw refusal("IMPORT_EQUIVALENCE_FAILED", "fixture export table order is not canonical");
    lastTableIndex = tableIndex;
    const row = record.row as Record<string, unknown> | null;
    if (!row || typeof row !== "object" || ("project_id" in row && row.project_id !== projectId)) {
      throw refusal("IMPORT_EQUIVALENCE_FAILED", "fixture export record references a foreign project");
    }
    counts[record.table] = (counts[record.table] ?? 0) + 1;
  }
  if (lines.length !== manifest.rowCount || canonicalJson(counts) !== canonicalJson(manifest.tableCounts)) {
    throw refusal("IMPORT_EQUIVALENCE_FAILED", "fixture export counts do not match its records");
  }
  if (
    canonicalJson(payload.artifactIndex.map((artifact) => artifact.evidenceId)) !==
      canonicalJson(payload.artifactIndex.map((artifact) => artifact.evidenceId).sort()) ||
    new Set(payload.artifactIndex.map((artifact) => artifact.evidenceId)).size !== payload.artifactIndex.length
  ) {
    throw refusal("IMPORT_EQUIVALENCE_FAILED", "fixture artifact index is not sorted and unique");
  }
  for (const artifact of payload.artifactIndex) {
    const redacted = parseCanonicalEvidenceJson(artifact.redactedJson, "migration artifact redacted metadata");
    const durable = parseCanonicalEvidenceJson(artifact.durableRefJson, "migration artifact durable reference");
    try {
      if (
        sha256(redacted.json) !== artifact.redactedDigest ||
        sha256(canonicalJson({
          projectId,
          evidenceId: artifact.evidenceId,
          evidenceKind: artifact.evidenceKind,
          sourceKind: artifact.sourceKind,
          sourceRef: artifact.sourceRef,
          executionAttemptId: artifact.executionAttemptId,
          contentDigest: artifact.contentDigest,
          redactedDigest: artifact.redactedDigest,
          durableRef: durable.value,
        })) !== artifact.artifactIdentityDigest
      ) throw new Error("digest mismatch");
    } catch {
      throw refusal("IMPORT_EQUIVALENCE_FAILED", "fixture artifact index contains invalid redacted or durable metadata");
    }
  }
  const artifactIndexJson = canonicalJson(payload.artifactIndex);
  const artifactIndexDigest = sha256(artifactIndexJson);
  const recordsDigest = sha256(payload.recordsNdjson);
  const rootInput = { ...manifest };
  delete (rootInput as Partial<typeof manifest>).exportRootDigest;
  const expectedChecksums = {
    "artifact-index.json": artifactIndexDigest,
    "manifest.json": sha256(canonicalJson(manifest)),
    "records.ndjson": recordsDigest,
  };
  if (
    payload.artifactIndex.length !== manifest.tableCounts.evidence_artifacts ||
    recordsDigest !== manifest.recordsDigest || artifactIndexDigest !== manifest.artifactIndexDigest ||
    sha256(canonicalJson(rootInput)) !== manifest.exportRootDigest ||
    canonicalJson(payload.checksums) !== canonicalJson(expectedChecksums) ||
    (!fromFiles && Buffer.byteLength(payload.recordsNdjson, "utf8") + Buffer.byteLength(artifactIndexJson, "utf8") > MAX_EXPORT_BYTES)
  ) {
    throw refusal("IMPORT_EQUIVALENCE_FAILED", "fixture export hashes, roots, or bounds do not verify");
  }
  return payload as ExportPayload;
}

function applyMigrationPrepare(db: SqliteDatabase, request: ApplyRequest, digest: string): FoundationResult {
  const configRevision = requireConfig(db, request);
  if (request.configRevision !== configRevision) throw refusal("PROJECT_CONFIG_STALE", "migration prepare must bind the current config revision");
  const head = exactGovernor(db, request);
  if (head.state !== "target_active") throw refusal("PROJECT_FROZEN", "migration prepare requires the current writable target fixture head");
  const actorReceiptId = requireActor(db, request);
  const migration = request.migration;
  if (!migration || request.migrationStep) throw refusal("INVALID_INPUT", "migration_prepare requires one immutable MigrationRun input");
  if (migration.targetRuntimeId !== PLUGIN_ID || migration.retentionUntilMs <= now()) {
    throw refusal("INVALID_INPUT", "migration prepare requires the exact target runtime and future retention");
  }
  requireCurrentAdoptedDecision(
    db, request.projectId, configRevision, migration.decisionId, migration.decisionDispositionSequence,
    "migration",
  );
  if (db.prepare("SELECT 1 FROM migration_runs WHERE source_system = 'llm-collab' AND project_id = ? AND state NOT IN ('retired', 'rolled_back')").get(request.projectId)) {
    throw refusal("INVALID_INPUT", "project already has an open MigrationRun");
  }
  const targetDigest = migrationTargetDigest(db, request.projectId, configRevision);
  const governor = rotateMigrationGovernor(db, request, actorReceiptId, head, migration.sourceRuntimeId, "source_active");
  const createdAtMs = now();
  const run: MigrationRunRow = {
    migration_id: migration.migrationId,
    project_id: request.projectId,
    source_system: migration.sourceSystem,
    source_runtime_id: migration.sourceRuntimeId,
    target_runtime_id: migration.targetRuntimeId,
    source_contract_digest: migration.sourceContractDigest,
    source_schema_digest: migration.sourceSchemaDigest,
    source_export_digest: null,
    config_revision: configRevision,
    decision_id: migration.decisionId,
    decision_disposition_sequence: migration.decisionDispositionSequence,
    state: "prepared",
    resource_revision: 1,
    source_event_ceiling: null,
    source_snapshot_digest: migration.sourceSnapshotDigest,
    source_governor_epoch: governor.governanceEpoch,
    target_governor_epoch: head.governance_epoch,
    mutator_inventory_digest: null,
    quiescence_digest: null,
    import_root_digest: null,
    equivalence_digest: null,
    recovery_digest: null,
    retention_until_ms: migration.retentionUntilMs,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
  };
  db.prepare(
    `INSERT INTO migration_runs
      (migration_id, project_id, source_system, source_runtime_id, target_runtime_id,
       source_contract_digest, source_schema_digest, source_export_digest, config_revision,
       decision_id, decision_disposition_sequence, state, resource_revision, source_event_ceiling,
       source_snapshot_digest, source_governor_epoch, target_governor_epoch, mutator_inventory_digest,
       quiescence_digest, import_root_digest, equivalence_digest, recovery_digest,
       retention_until_ms, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(
    run.migration_id, run.project_id, run.source_system, run.source_runtime_id, run.target_runtime_id,
    run.source_contract_digest, run.source_schema_digest, run.config_revision, run.decision_id,
    run.decision_disposition_sequence, run.state, run.resource_revision, run.source_snapshot_digest,
    run.source_governor_epoch, run.target_governor_epoch, run.retention_until_ms, run.created_at_ms, run.updated_at_ms,
  );
  return commitMutation(
    db, request, digest, actorReceiptId,
    { aggregateType: "migration_run", aggregateId: run.migration_id, aggregateRevision: 1, eventType: "migration_run_changed", event: migrationEvent("prepare", null, run, migration.sourceSnapshotDigest) },
    { expected: 1, attempted: 1, verified: 1 },
    { currentConfigRevision: configRevision, currentGovernanceEpoch: governor.governanceEpoch, currentResourceRevision: 1,
      evidence: { migrationId: run.migration_id, state: run.state, resourceRevision: 1, fenceToken: governor.fenceToken, repositoryTargetsDigest: targetDigest } },
  );
}

function requireCompleteCanaries(request: ApplyRequest): void {
  const canaries = request.migrationStep?.canaries;
  if (!canaries || canaries.attempted !== canaries.expected || canaries.verified !== canaries.expected) {
    throw refusal("SOURCE_FREEZE_UNPROVEN", "source mutator canaries are incomplete", {
      expected: canaries?.expected ?? 1,
      attempted: canaries?.attempted ?? 0,
      verified: canaries?.verified ?? 0,
    });
  }
}

function applyMigrationStep(db: SqliteDatabase, request: ApplyRequest, digest: string): FoundationResult {
  const configRevision = requireConfig(db, request);
  const actorReceiptId = requireActor(db, request);
  const step = request.migrationStep;
  if (!step || request.migration) throw refusal("INVALID_INPUT", "migration_step requires one closed transition input");
  const run = asRow<MigrationRunRow>(db.prepare("SELECT * FROM migration_runs WHERE project_id = ? AND migration_id = ?").get(request.projectId, step.migrationId));
  if (!run) throw refusal("RESOURCE_UNKNOWN", "MigrationRun is not known in this project");
  if (request.expectedResourceRevision !== run.resource_revision) {
    throw refusal("RESOURCE_REVISION_STALE", "MigrationRun revision is stale", {
      currentResourceRevision: run.resource_revision,
      expectedResourceRevision: request.expectedResourceRevision ?? undefined,
    });
  }
  if (request.configRevision !== configRevision || run.config_revision !== configRevision) {
    throw refusal("PROJECT_CONFIG_STALE", "MigrationRun config revision is stale");
  }
  requireCurrentAdoptedDecision(db, request.projectId, configRevision, run.decision_id, run.decision_disposition_sequence, "migration");
  const head = exactGovernor(db, request);
  const repositoryTargetsDigest = migrationTargetDigest(db, request.projectId, configRevision);
  if (step.repositoryTargetsDigest !== repositoryTargetsDigest) {
    throw refusal("IMPORT_EQUIVALENCE_FAILED", "repository target identity changed or is foreign");
  }
  const evidenceOnly = recordedSourceEvidenceKind(db, run);
  if (evidenceOnly && ["activate", "record_exercise", "retire"].includes(step.step)) {
    throw refusal("IMPORT_EQUIVALENCE_FAILED", "evidence-only MigrationRun cannot activate or retire canonical state");
  }
  if (["record_import", "record_equivalence", "activate"].includes(step.step) && run.retention_until_ms <= now()) {
    throw refusal("IMPORT_EQUIVALENCE_FAILED", "MigrationRun retention expired before equivalence/activation");
  }
  const next: MigrationRunRow = { ...run, resource_revision: run.resource_revision + 1, updated_at_ms: now() };
  let eventStep: "prepare" | (typeof MIGRATION_STEPS)[number] = step.step;
  let outcome: FoundationCode = "OK";
  let nextFenceToken = head.fence_token;
  let eventExtra: Parameters<typeof migrationEvent>[4] = {};
  let mutationCounts = { expected: 1, attempted: 1, verified: 1 };
  const requireState = (...states: MigrationRunRow["state"][]) => {
    if (!states.includes(run.state)) throw refusal("INVALID_INPUT", `${step.step} is invalid from ${run.state}`);
  };
  const requireGovernorState = (...states: typeof head.state[]) => {
    if (!states.includes(head.state)) throw refusal("PROJECT_FROZEN", `${step.step} does not match the canonical governorship state`);
  };

  switch (step.step) {
    case "record_inventory":
      requireState("prepared");
      requireGovernorState("source_active");
      next.mutator_inventory_digest = step.proofDigest;
      break;
    case "record_quiescence":
      requireState("prepared");
      requireGovernorState("source_active");
      next.quiescence_digest = step.proofDigest;
      break;
    case "freeze": {
      requireState("prepared");
      requireGovernorState("source_active");
      if (!run.mutator_inventory_digest || !run.quiescence_digest) {
        throw refusal("SOURCE_FREEZE_UNPROVEN", "inventory and quiescence proofs are required before freeze");
      }
      requireCompleteCanaries(request);
      const governor = rotateMigrationGovernor(db, request, actorReceiptId, head, run.source_runtime_id, "frozen");
      next.state = "frozen";
      next.source_governor_epoch = governor.governanceEpoch;
      nextFenceToken = governor.fenceToken;
      break;
    }
    case "record_export": {
      requireState("frozen");
      requireGovernorState("frozen");
      if (step.canonicalImport || step.importRootDigest || step.equivalenceDigest || step.equivalenceDisposition) {
        throw refusal("INVALID_INPUT", "record_export does not accept canonical import or equivalence fields");
      }
      if (step.sourceEvidenceManifest && step.export) {
        throw refusal("IMPORT_EQUIVALENCE_FAILED", "source evidence cannot be supplied as the target canonical export");
      }
      if (step.sourceEvidenceManifest) {
        const sourceEvidenceManifest = validateSourceEvidenceManifest(step.sourceEvidenceManifest);
        if (run.resource_revision !== LLM_COLLAB_EVIDENCE_RESOURCE_REVISION || step.sourceEventCeiling !== undefined || step.sourceSnapshotDigest !== run.source_snapshot_digest) {
          throw refusal("IMPORT_EQUIVALENCE_FAILED", "source evidence has no canonical source event ceiling to record");
        }
        if (db.prepare("SELECT 1 FROM migration_runs WHERE source_system = ? AND project_id = ? AND source_export_digest = ? AND migration_id <> ?").get(run.source_system, run.project_id, sourceEvidenceManifest.manifestDigest, run.migration_id)) {
          throw refusal("INVALID_INPUT", "final source evidence identity already belongs to another MigrationRun");
        }
        next.state = "exported";
        next.source_event_ceiling = null;
        next.source_export_digest = sourceEvidenceManifest.manifestDigest;
        eventExtra = { sourceExportKind: "non_canonical_source_evidence" };
        break;
      }
      const exported = validateMigrationExport(db, step.export, request.projectId);
      if (run.source_schema_digest !== exported.manifest.schemaDigest || run.source_contract_digest !== exported.manifest.contractDigest) {
        throw refusal("IMPORT_EQUIVALENCE_FAILED", "source schema or contract digest does not match the fixture export");
      }
      const ceiling = step.sourceEventCeiling;
      const currentCeiling = asRow<{ event_sequence: number }>(db.prepare("SELECT COALESCE(MAX(event_sequence), 0) AS event_sequence FROM state_events WHERE project_id = ?").get(request.projectId))?.event_sequence ?? 0;
      if (ceiling === undefined || ceiling !== currentCeiling || step.sourceSnapshotDigest !== run.source_snapshot_digest) {
        throw refusal("IMPORT_EQUIVALENCE_FAILED", "source event ceiling or snapshot digest is not exact");
      }
      if (db.prepare("SELECT 1 FROM migration_runs WHERE source_system = ? AND project_id = ? AND source_export_digest = ? AND migration_id <> ?").get(run.source_system, run.project_id, exported.manifest.exportRootDigest, run.migration_id)) {
        throw refusal("INVALID_INPUT", "final source export identity already belongs to another MigrationRun");
      }
      next.state = "exported";
      next.source_event_ceiling = ceiling;
      next.source_export_digest = exported.manifest.exportRootDigest;
      eventExtra = { sourceExportKind: "canonical_fixture" };
      break;
    }
    case "record_import": {
      requireState("exported");
      requireGovernorState("frozen");
      if (evidenceOnly) {
        if (step.export || !step.sourceEvidenceManifest) {
          throw refusal("IMPORT_EQUIVALENCE_FAILED", "source evidence cannot be supplied as the target canonical export");
        }
        const sourceEvidenceManifest = validateSourceEvidenceManifest(step.sourceEvidenceManifest);
        if (sourceEvidenceManifest.manifestDigest !== run.source_export_digest) {
          throw refusal("IMPORT_EQUIVALENCE_FAILED", "source evidence manifest does not bind the recorded source identity");
        }
        const canonicalImport = requireZeroCanonicalImport(step.canonicalImport);
        const expectedRoot = sha256(canonicalJson({
          sourceExportDigest: run.source_export_digest,
          targetRuntimeId: run.target_runtime_id,
          configRevision,
          repositoryTargetsDigest,
          canonicalImport,
        }));
        if (step.importRootDigest !== expectedRoot || step.proofDigest !== expectedRoot) {
          throw refusal("IMPORT_EQUIVALENCE_FAILED", "evidence-only import root does not bind exact hashes and zero-work proof");
        }
        next.state = "imported";
        next.import_root_digest = expectedRoot;
        eventExtra = { sourceExportKind: "non_canonical_source_evidence", canonicalImport };
        mutationCounts = canonicalImport;
        break;
      }
      if (step.sourceEvidenceManifest || step.canonicalImport) {
        throw refusal("IMPORT_EQUIVALENCE_FAILED", "source evidence is not a canonical fixture export");
      }
      const exported = validateMigrationExport(db, step.export, request.projectId);
      const expectedRoot = sha256(canonicalJson({
        sourceExportDigest: run.source_export_digest,
        targetRuntimeId: run.target_runtime_id,
        configRevision,
        repositoryTargetsDigest,
      }));
      if (exported.manifest.exportRootDigest !== run.source_export_digest || step.importRootDigest !== expectedRoot || step.proofDigest !== expectedRoot) {
        throw refusal("IMPORT_EQUIVALENCE_FAILED", "import root does not bind the exact export/runtime/config/repository identity");
      }
      next.state = "imported";
      next.import_root_digest = expectedRoot;
      break;
    }
    case "record_equivalence": {
      requireState("imported");
      requireGovernorState("frozen");
      if (evidenceOnly) {
        if (step.export || !step.sourceEvidenceManifest) {
          throw refusal("IMPORT_EQUIVALENCE_FAILED", "source evidence cannot be supplied as the target canonical export");
        }
        const sourceEvidenceManifest = validateSourceEvidenceManifest(step.sourceEvidenceManifest);
        if (sourceEvidenceManifest.manifestDigest !== run.source_export_digest) {
          throw refusal("IMPORT_EQUIVALENCE_FAILED", "source evidence manifest does not bind the recorded source identity");
        }
        const canonicalImport = requireZeroCanonicalImport(step.canonicalImport);
        if (step.equivalenceDisposition !== EVIDENCE_ONLY_EQUIVALENCE_DISPOSITION) {
          throw refusal("IMPORT_EQUIVALENCE_FAILED", "evidence-only equivalence requires the ratified disposition");
        }
        const expectedDigest = sha256(canonicalJson({
          sourceExportDigest: run.source_export_digest,
          importRootDigest: run.import_root_digest,
          sourceSnapshotDigest: run.source_snapshot_digest,
          repositoryTargetsDigest,
          canonicalImport,
          equivalenceDisposition: EVIDENCE_ONLY_EQUIVALENCE_DISPOSITION,
        }));
        if (step.equivalenceDigest !== expectedDigest || step.proofDigest !== expectedDigest) {
          throw refusal("IMPORT_EQUIVALENCE_FAILED", "evidence-only equivalence proof does not bind exact hashes and disposition");
        }
        next.state = "equivalent";
        next.equivalence_digest = expectedDigest;
        eventExtra = {
          sourceExportKind: "non_canonical_source_evidence",
          canonicalImport,
          equivalenceDisposition: EVIDENCE_ONLY_EQUIVALENCE_DISPOSITION,
        };
        mutationCounts = canonicalImport;
        break;
      }
      if (step.sourceEvidenceManifest || step.canonicalImport || step.equivalenceDisposition) {
        throw refusal("IMPORT_EQUIVALENCE_FAILED", "source evidence is not a canonical fixture export");
      }
      const exported = validateMigrationExport(db, step.export, request.projectId);
      const expectedDigest = sha256(canonicalJson({
        sourceExportDigest: run.source_export_digest,
        importRootDigest: run.import_root_digest,
        sourceSnapshotDigest: run.source_snapshot_digest,
        repositoryTargetsDigest,
      }));
      if (exported.manifest.exportRootDigest !== run.source_export_digest || step.equivalenceDigest !== expectedDigest || step.proofDigest !== expectedDigest) {
        throw refusal("IMPORT_EQUIVALENCE_FAILED", "equivalence proof does not bind exact hashes and references");
      }
      next.state = "equivalent";
      next.equivalence_digest = expectedDigest;
      break;
    }
    case "activate": {
      requireState("equivalent");
      requireGovernorState("frozen");
      const governor = rotateMigrationGovernor(db, request, actorReceiptId, head, run.target_runtime_id, "target_active");
      next.state = "target_active";
      next.target_governor_epoch = governor.governanceEpoch;
      nextFenceToken = governor.fenceToken;
      break;
    }
    case "record_exercise":
      requireState("target_active");
      requireGovernorState("target_active");
      next.state = "exercised";
      break;
    case "retire":
      requireState("exercised");
      requireGovernorState("target_active");
      next.state = "retired";
      break;
    case "rollback":
      if (evidenceOnly && run.state === "equivalent") {
        requireState("equivalent");
        requireGovernorState("frozen");
        requireEvidenceOnlyReleaseBinding(run, head, request);
        if (!step.recoveryDigest || step.recoveryDigest !== step.proofDigest) throw refusal("INVALID_INPUT", "evidence-only release requires exact recovery evidence");
        const governor = rotateMigrationGovernor(db, request, actorReceiptId, head, run.target_runtime_id, "target_active");
        next.state = "rolled_back";
        next.target_governor_epoch = governor.governanceEpoch;
        next.recovery_digest = step.recoveryDigest;
        nextFenceToken = governor.fenceToken;
        eventExtra = {
          sourceExportKind: "non_canonical_source_evidence",
          equivalenceDisposition: EVIDENCE_ONLY_EQUIVALENCE_DISPOSITION,
          governorRelease: { runtimeId: PLUGIN_ID, disposition: "evidence_only_equivalent_rollback" },
        };
      } else if (["target_active", "exercised"].includes(run.state)) {
        requireGovernorState("target_active");
        if (!step.recoveryDigest || step.recoveryDigest !== step.proofDigest) throw refusal("INVALID_INPUT", "fix-forward requires exact recovery evidence");
        next.state = "fix_forward_required";
        next.recovery_digest = step.recoveryDigest;
        eventStep = "mark_fix_forward_required";
        outcome = "MIGRATION_FIX_FORWARD_REQUIRED";
      } else {
        requireState("prepared", "frozen", "exported", "imported", "equivalent");
        requireGovernorState("source_active", "frozen");
        if (!step.recoveryDigest || step.recoveryDigest !== step.proofDigest) throw refusal("INVALID_INPUT", "rollback requires exact recovery evidence");
        const governor = rotateMigrationGovernor(db, request, actorReceiptId, head, run.source_runtime_id, "source_active");
        next.state = "rolled_back";
        next.source_governor_epoch = governor.governanceEpoch;
        next.recovery_digest = step.recoveryDigest;
        nextFenceToken = governor.fenceToken;
      }
      break;
    case "mark_fix_forward_required":
      requireState("target_active", "exercised");
      requireGovernorState("target_active");
      if (!step.recoveryDigest || step.recoveryDigest !== step.proofDigest) throw refusal("INVALID_INPUT", "fix-forward requires exact recovery evidence");
      next.state = "fix_forward_required";
      next.recovery_digest = step.recoveryDigest;
      outcome = "MIGRATION_FIX_FORWARD_REQUIRED";
      break;
  }

  const updated = db.prepare(
    `UPDATE migration_runs SET state = ?, resource_revision = ?, source_event_ceiling = ?, source_snapshot_digest = ?,
       source_governor_epoch = ?, target_governor_epoch = ?, mutator_inventory_digest = ?, quiescence_digest = ?,
       source_export_digest = ?, import_root_digest = ?, equivalence_digest = ?, recovery_digest = ?, updated_at_ms = ?
     WHERE project_id = ? AND migration_id = ? AND resource_revision = ?`,
  ).run(
    next.state, next.resource_revision, next.source_event_ceiling, next.source_snapshot_digest,
    next.source_governor_epoch, next.target_governor_epoch, next.mutator_inventory_digest, next.quiescence_digest,
    next.source_export_digest, next.import_root_digest, next.equivalence_digest, next.recovery_digest, next.updated_at_ms,
    request.projectId, next.migration_id, run.resource_revision,
  );
  if (updated.changes !== 1) throw refusal("RESOURCE_REVISION_STALE", "MigrationRun compare-and-swap failed", {
    currentResourceRevision: run.resource_revision,
    expectedResourceRevision: request.expectedResourceRevision ?? undefined,
  });
  const currentGovernanceEpoch = eventExtra.governorRelease
    ? next.target_governor_epoch
    : next.state === "retired" || next.state === "exercised" || next.state === "fix_forward_required"
    ? head.governance_epoch
    : next.state === "target_active" ? next.target_governor_epoch : next.source_governor_epoch;
  return commitMutation(
    db, request, digest, actorReceiptId,
    { aggregateType: "migration_run", aggregateId: next.migration_id, aggregateRevision: next.resource_revision, eventType: "migration_run_changed", event: migrationEvent(eventStep, run.state, next, step.proofDigest, eventExtra) },
    mutationCounts,
    { currentConfigRevision: configRevision, currentGovernanceEpoch, currentResourceRevision: next.resource_revision,
      evidence: { migrationId: next.migration_id, state: next.state, resourceRevision: next.resource_revision, fenceToken: nextFenceToken,
        repositoryTargetsDigest, sourceExportDigest: next.source_export_digest, ...eventExtra } },
    outcome,
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
  authority_root_json: string | null;
  authority_root_digest: string | null;
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

function storedDecisionIdentityDigest(decision: Pick<DecisionRow, "project_id" | "config_revision" | "repo_target_id" | "scope_json" | "decision_class" | "options_json">): string | null {
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

function isCrossProjectBootstrapDecision(
  projectId: string,
  decisionClass: string | null,
  repoTargetId: string | null,
  scopeJson: string,
  optionsJson: string | null,
): boolean {
  if (decisionClass !== "operator_only" || repoTargetId !== null || !optionsJson) return false;
  try {
    const scope = crossProjectBootstrapScopeSchema.safeParse(JSON.parse(scopeJson));
    const options = crossProjectBootstrapOptionsSchema.safeParse(JSON.parse(optionsJson));
    return scope.success && options.success && scope.data.sourceProjectId === projectId && scope.data.targetProjectId !== projectId;
  } catch {
    return false;
  }
}

type DecisionAuthorityRoot = z.infer<typeof decisionAuthorityRootSchema>;

function decisionAuthorityRootDigest(root: DecisionAuthorityRoot): string {
  return sha256(canonicalJson(root));
}

function currentBootstrapDecisionAuthorityRoot(db: SqliteDatabase, request: ApplyRequest): DecisionAuthorityRoot {
  return currentBootstrapDecisionAuthorityRootForActor(db, request.projectId, requireActor(db, request));
}

function currentBootstrapDecisionAuthorityRootForActor(db: SqliteDatabase, projectId: string, actorReceiptId: string): DecisionAuthorityRoot {
  const head = asRow<{
    project_id: string;
    governance_epoch: number;
    fence_token: string;
    state: string;
    actor_receipt_id: string;
  }>(db.prepare(
    `SELECT heads.project_id, heads.governance_epoch, heads.fence_token, heads.state, governorships.actor_receipt_id
     FROM project_governorship_heads AS heads
     JOIN project_governorships AS governorships
       ON governorships.project_id = heads.project_id AND governorships.governance_epoch = heads.governance_epoch
     WHERE heads.project_id = ?`,
  ).get(projectId));
  if (!head) throw refusal("GOVERNOR_UNAVAILABLE", "project has no current governorship head");
  if (head.actor_receipt_id !== actorReceiptId) {
    throw refusal("ACTOR_RECEIPT_UNVERIFIED", "bootstrap Decision authority requires the exact current governorship actor");
  }
  const actor = asRow<{
    project_id: string;
    actor_kind: string;
    subject_id: string;
    role_id: string | null;
    role_generation: number | null;
    verification_state: string;
    operator_receipt_id: string | null;
    retirement_condition: string | null;
    domain_id: string | null;
    receipt_digest: string;
  }>(db.prepare(
    "SELECT project_id, actor_kind, subject_id, role_id, role_generation, verification_state, operator_receipt_id, retirement_condition, domain_id, receipt_digest FROM actor_receipts WHERE project_id = ? AND receipt_id = ?",
  ).get(projectId, actorReceiptId));
  if (isBootstrapGenesisReceipt(db, actorReceiptId)) {
    throw refusal("BOOTSTRAP_GENESIS_REUSED", "bootstrap genesis receipt is single-use and cannot authorize a later Decision root");
  }
  const actorDigest = actor && actorReceiptDigest({
    projectId: actor.project_id,
    receiptId: actorReceiptId,
    actorKind: actor.actor_kind,
    subjectId: actor.subject_id,
    roleId: actor.role_id,
    roleGeneration: actor.role_generation,
    verificationState: actor.verification_state,
    operatorReceiptId: actor.operator_receipt_id,
    retirementCondition: actor.retirement_condition,
    domainId: actor.domain_id,
  });
  if (!actor || actor.project_id !== projectId || actor.actor_kind !== "plugin" || actor.subject_id !== PLUGIN_ID ||
      actor.verification_state !== "verified" || actor.receipt_digest !== actorDigest) {
    throw refusal("ACTOR_RECEIPT_UNVERIFIED", "bootstrap Decision authority requires a verified plugin governorship actor");
  }
  return {
    projectId: head.project_id,
    governanceEpoch: head.governance_epoch,
    fenceToken: head.fence_token,
    actorReceiptId,
    actorReceiptDigest: actor.receipt_digest,
  };
}

function storedDecisionAuthorityRoot(decision: DecisionRow): DecisionAuthorityRoot {
  if (!decision.authority_root_json || !decision.authority_root_digest) {
    throw refusal("DECISION_IDENTITY_CONFLICT", "bootstrap Decision has no immutable authority root");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decision.authority_root_json);
  } catch {
    throw refusal("DECISION_IDENTITY_CONFLICT", "bootstrap Decision authority root is malformed");
  }
  const root = decisionAuthorityRootSchema.safeParse(parsed);
  if (!root.success || canonicalJson(root.data) !== decision.authority_root_json || decisionAuthorityRootDigest(root.data) !== decision.authority_root_digest) {
    throw refusal("DECISION_IDENTITY_CONFLICT", "bootstrap Decision authority root integrity is invalid");
  }
  return root.data;
}

function requireDecisionAuthority(
  db: SqliteDatabase,
  request: ApplyRequest,
  decision: Pick<DecisionRow, "project_id" | "repo_target_id" | "scope_json" | "decision_class" | "options_json" | "authority_root_json" | "authority_root_digest">,
  capture = false,
): { actorReceiptId: string; authorityRoot: DecisionAuthorityRoot | null } {
  const bootstrap = isCrossProjectBootstrapDecision(
    decision.project_id,
    decision.decision_class,
    decision.repo_target_id,
    decision.scope_json,
    decision.options_json,
  );
  if (!bootstrap) return { actorReceiptId: requireDecisionActor(db, request), authorityRoot: null };
  if (capture) {
    const root = currentBootstrapDecisionAuthorityRoot(db, request);
    return { actorReceiptId: root.actorReceiptId, authorityRoot: root };
  }
  const stored = storedDecisionAuthorityRoot(decision as DecisionRow);
  const current = currentBootstrapDecisionAuthorityRoot(db, request);
  if (canonicalJson(stored) !== canonicalJson(current)) {
    throw refusal("GOVERNOR_EPOCH_STALE", "bootstrap Decision authority root is no longer the current source governorship root");
  }
  return { actorReceiptId: current.actorReceiptId, authorityRoot: stored };
}

function requireDecisionActor(db: SqliteDatabase, request: ApplyRequest): string {
  // GH-677 decision: non-bootstrap Decisions are intentionally actor-verified
  // only. Any verified plugin actor may author them; the governor fence,
  // immutable Decision identity, and operation-specific validators remain the
  // authority boundary. Role-holder binding belongs to role-aware operations,
  // not this request shape, which carries no authenticated caller thread.
  return requireActor(db, request);
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
  const authority = requireDecisionAuthority(db, request, {
    project_id: request.projectId,
    repo_target_id: decision.repoTargetId,
    scope_json: identity.scopeJson,
    decision_class: identity.decisionClass,
    options_json: identity.optionsJson,
    authority_root_json: null,
    authority_root_digest: null,
  }, true);
  const actorReceiptId = authority.actorReceiptId;
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
       current_resource_revision, decision_class, options_json, decision_identity_digest, authority_root_json, authority_root_digest)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
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
    authority.authorityRoot ? canonicalJson(authority.authorityRoot) : null,
    authority.authorityRoot ? decisionAuthorityRootDigest(authority.authorityRoot) : null,
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
    if (delegated) throw refusal("EXECUTION_CONTEXT_FOREIGN", "delegated assignment evidence is retired");
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

function applyDecisionMutation(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  _reader: ReviewFactReader | null,
): FoundationResult {
  try {
    return transaction(db, () => {
      const replay = checkIdempotency(db, request, digest);
      return replay ?? applyDecisionDisposition(db, request, digest);
    });
  } catch (error) {
    if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
    if (isConstraintError(error)) return unavailableResult(request.projectId, "canonical decision disposition could not be committed unambiguously");
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
  const authority = requireDecisionAuthority(db, request, decision);
  const actorReceiptId = authority.actorReceiptId;
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
  const output = commitMutation(
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
  return output;
}

interface ResolvedRoleRequirement {
  requirement: RoleRequirement & { domainId: string };
  digest: string;
  configRevision: number;
  domainId: string;
}

function requireRoleRequirement(db: SqliteDatabase, request: ApplyRequest, configRevision: number): ResolvedRoleRequirement {
  if (!request.roleRequirementId) throw refusal("ROLE_REQUIREMENT_UNKNOWN", "role requirement identity is required");
  const requirements = flatDomainRequirements(storedConfigJson(db, request.projectId, configRevision));
  const matches = requirements.filter((candidate) => candidate.roleRequirementId === request.roleRequirementId && (request.domainId === undefined || candidate.domainId === request.domainId));
  if (matches.length !== 1) throw refusal(matches.length === 0 ? "ROLE_REQUIREMENT_UNKNOWN" : "DOMAIN_AMBIGUOUS", "role requirement is not uniquely configured for the orchestration domain");
  const requirement = matches[0]!;
  if (request.roleId && request.roleId !== requirement.roleId) throw refusal("ROLE_REQUIREMENT_UNKNOWN", "logical role does not match its requirement");
  if (requirement.repoTargetId === null) {
    if (request.repoTargetId) throw refusal("REPO_TARGET_FOREIGN", "project-scoped role cannot accept a repository target");
  } else {
    if (!request.repoTargetId) throw refusal("REPO_TARGET_REQUIRED", "target-scoped role requires its exact repository target");
    if (request.repoTargetId !== requirement.repoTargetId) throw refusal("REPO_TARGET_FOREIGN", "role requirement target does not match the exact repository target");
    requireTarget(db, request.projectId, configRevision, request.repoTargetId);
  }
  return { requirement, digest: sha256(canonicalJson(requirement)), configRevision, domainId: requirement.domainId };
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
  const source = context.baseContext.source as { path?: unknown };
  if (target.source_id !== context.sourceId || target.host_id !== context.hostId || target.path !== source.path) {
    throw refusal("ROLE_CONTEXT_FOREIGN", "holder context does not match the exact repository target source, host, and path");
  }
}

// Role standing is an optional stronger check for role-aware paths. Canonical
// mutation authority is the verified actor receipt, not an unmintable role kind.
function requireRoleActorBinding(
  db: SqliteDatabase,
  request: ApplyRequest,
  required = false,
): { roleId: (typeof ROLE_IDS)[number]; roleGeneration: number; domainId: string } | null {
  if (!request.actorReceiptId) return null;
  const actor = asRow<{ actor_kind: string; subject_id: string; role_id: string | null; role_generation: number | null; domain_id: string | null }>(
    db.prepare("SELECT actor_kind, subject_id, role_id, role_generation, domain_id FROM actor_receipts WHERE project_id = ? AND receipt_id = ?").get(
      request.projectId,
      request.actorReceiptId,
    ),
  );
  if (!actor || actor.actor_kind !== "role") {
    if (!required) return null;
    throw refusal("ACTOR_RECEIPT_UNVERIFIED", "current role actor receipt is required");
  }
  if (!actor.role_id || actor.role_generation === null) throw refusal("ROLE_HOLDER_MISMATCH", "role actor receipt has no exact generation");
  const domainId = actor.domain_id ?? request.domainId ?? "default";
  if (request.domainId !== undefined && request.domainId !== domainId) throw refusal("DOMAIN_FOREIGN", "role actor is bound to another orchestration domain");
  const head = asRow<{ current_generation: number }>(
    db.prepare("SELECT current_generation FROM role_generation_heads WHERE project_id = ? AND role_id = ? AND domain_id = ?").get(request.projectId, actor.role_id, domainId),
  );
  const generation = asRow<{
    status: string;
    role_requirement_id: string;
    config_revision: number;
    holder_execution_attempt_id: string;
    holder_context_digest: string;
    holder_requested_profile_digest: string;
    qualification_id: string;
    eligibility_derivation_digest: string;
    domain_id: string;
  }>(
    db.prepare(`SELECT status, role_requirement_id, config_revision, holder_execution_attempt_id,
                       holder_context_digest, holder_requested_profile_digest, qualification_id,
                       eligibility_derivation_digest, domain_id
                FROM role_generations WHERE project_id = ? AND role_id = ? AND generation = ? AND domain_id = ?`).get(
      request.projectId,
      actor.role_id,
      actor.role_generation,
      domainId,
    ),
  );
  if (!head || head.current_generation !== actor.role_generation) throw refusal("ROLE_GENERATION_STALE", "role actor is not the current generation");
  if (!generation || generation.status !== "active") throw refusal("ROLE_NOT_ACTIVE", "role actor is not active");
  if (generation.holder_execution_attempt_id !== actor.subject_id) throw refusal("ROLE_HOLDER_MISMATCH", "role actor does not bind the current holder context");
  const attempt = asRow<{ origin: string; state: string; native_receipt_digest: string | null; requested_profile_digest: string | null }>(
    db.prepare("SELECT origin, state, native_receipt_digest, requested_profile_digest FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ?").get(
      request.projectId,
      generation.holder_execution_attempt_id,
    ),
  );
  if (
    !attempt ||
    attempt.origin !== "role_holder" ||
    attempt.state !== "done" ||
    attempt.native_receipt_digest !== generation.holder_context_digest ||
    attempt.requested_profile_digest !== generation.holder_requested_profile_digest
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
     WHERE project_id = ? AND role_requirement_id = ? AND requested_profile_digest = ? AND domain_id = ?`,
  ).get(request.projectId, generation.role_requirement_id, generation.holder_requested_profile_digest, domainId));
  if (
    !eligibility || eligibility.current_qualification_id !== generation.qualification_id ||
    eligibility.effective_status !== "eligible" || eligibility.config_revision !== generation.config_revision ||
    eligibility.derivation_digest !== generation.eligibility_derivation_digest ||
    (eligibility.expires_at_ms !== null && eligibility.expires_at_ms <= now())
  ) {
    throw refusal("ROLE_UNQUALIFIED", "role actor no longer has current eligible qualification evidence");
  }
  return { roleId: actor.role_id as (typeof ROLE_IDS)[number], roleGeneration: actor.role_generation, domainId };
}

function requireRoleGenerationConfigContinuation(
  db: SqliteDatabase,
  projectId: string,
  roleId: (typeof ROLE_IDS)[number],
  roleGeneration: number,
  domainId: string,
  currentConfigRevision: number,
): void {
  const generation = asRow<{ config_revision: number; role_requirement_id: string; repo_target_id: string | null }>(db.prepare(
    "SELECT config_revision, role_requirement_id, repo_target_id FROM role_generations WHERE project_id = ? AND role_id = ? AND generation = ? AND domain_id = ? AND status = 'active'",
  ).get(projectId, roleId, roleGeneration, domainId));
  if (!generation) throw refusal("ROLE_NOT_ACTIVE", "work dispatch requires the exact active role generation");
  if (generation.config_revision === currentConfigRevision) return;
  const identity = (revision: number) => {
    const requirement = configuredDomains(db, projectId, revision)
      .find((domain) => domain.domainId === domainId)?.roleRequirements
      .find((candidate) => candidate.roleRequirementId === generation.role_requirement_id);
    if (!requirement || requirement.roleId !== roleId || requirement.repoTargetId !== generation.repo_target_id) {
      throw refusal("PROJECT_CONFIG_STALE", "seated role authority changed across config revisions");
    }
    const target = generation.repo_target_id === null ? null : asRow<{ source_id: string; host_id: string; path: string }>(db.prepare(
      "SELECT source_id, host_id, path FROM repository_targets WHERE project_id = ? AND repo_target_id = ? AND config_revision = ?",
    ).get(projectId, generation.repo_target_id, revision));
    if (generation.repo_target_id !== null && !target) throw refusal("PROJECT_CONFIG_STALE", "seated role target is missing from a config revision");
    return { requirement, target };
  };
  if (canonicalJson(identity(generation.config_revision)) !== canonicalJson(identity(currentConfigRevision))) {
    throw refusal("PROJECT_CONFIG_STALE", "seated role authority changed across config revisions");
  }
}

function profileEquals(left: ExecutionProfile, right: ExecutionProfile): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function roleRequirementProfileMatches(requirement: RoleRequirement, profile: ExecutionProfile): boolean {
  if (requirement.roleRequirementId !== DIRECTOR_SEAT_ROLE_REQUIREMENT_ID) return profileEquals(profile, requirement.executedProfile);
  return profileIsOneOf(profile, directorSeatProfiles);
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
    domainId: resolved.domainId,
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
  requireRoleActorBinding(db, request, false);
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
  const requiredMatch = roleRequirementProfileMatches(resolved.requirement, context.profile);
  const declaredMatch = request.declaredProfile === undefined || profileEquals(context.profile, request.declaredProfile);
  const mismatch = !requiredMatch || !declaredMatch;
  const observationOutcome = mismatch ? "unqualified" : requestedOutcome;
  const effectiveStatus = observationOutcome === "qualified" ? "eligible" : observationOutcome === "unqualified" ? "ineligible" : "unknown";
  const reasonCode = mismatch ? "execution_profile_mismatch" : request.reasonCode;
  const evidenceDigest = sha256(canonicalJson({
    requestedProfileDigest: context.requestedProfileDigest,
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
    requestedProfileDigest: context.requestedProfileDigest,
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
      project_id, qualification_id, role_requirement_id, domain_id, config_revision, repo_target_id,
      role_requirement_digest, requested_profile_digest, requested_provider_id, requested_model, requested_reasoning_level,
      requested_permission_mode, requested_service_tier, requested_visibility, thread_id, environment_id, source_id, host_id,
      provider_thread_id, request_event_id, request_event_seq, completion_event_id, completion_event_seq,
      bb_version, plugin_sdk_version, qualification_context_digest, fixture_context_digest, outcome,
      observed_at_ms, expires_at_ms, evidence_digest, observation_digest, reason_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    request.projectId,
    qualificationId,
    resolved.requirement.roleRequirementId,
    resolved.domainId,
    configRevision,
    resolved.requirement.repoTargetId,
    resolved.digest,
    context.requestedProfileDigest,
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
    requestedProfileDigest: context.requestedProfileDigest,
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
      project_id, role_requirement_id, domain_id, requested_profile_digest, current_qualification_id,
      effective_status, qualification_context_digest, config_revision, role_requirement_digest,
      derived_at_ms, expires_at_ms, derivation_digest, reason_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, role_requirement_id, requested_profile_digest) DO UPDATE SET
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
    resolved.domainId,
    context.requestedProfileDigest,
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
      event: { qualificationId, roleRequirementId: resolved.requirement.roleRequirementId, requestedProfileDigest: context.requestedProfileDigest, outcome: observationOutcome },
    },
    { expected: 1, attempted: 1, verified: 1 },
    {
      currentConfigRevision: configRevision,
      currentGovernanceEpoch: governor.governance_epoch,
      evidence: { qualificationId, roleRequirementId: resolved.requirement.roleRequirementId, requestedProfileDigest: context.requestedProfileDigest, effectiveStatus, observationDigest, derivationDigest, reasonCode },
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
  requested_profile_digest: string;
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
    domainId: resolved.domainId,
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
    requestedProfileDigest: context.requestedProfileDigest,
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
      requested_provider_id, requested_model, requested_reasoning_level, requested_permission_mode,
      requested_service_tier, requested_visibility, requested_profile_digest, branch_name,
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
    context.requestedProfileDigest,
    environment.branchName,
    sha256(canonicalJson(context.baseContext.environment)),
    holderContextDigest,
    context.completionEventSeq,
    createdAtMs,
    createdAtMs,
    createdAtMs,
    attemptDigest,
  );
  db.prepare("UPDATE execution_attempts SET domain_id = ? WHERE project_id = ? AND execution_attempt_id = ?").run(
    resolved.domainId, request.projectId, context.holderExecutionAttemptId,
  );
}

function applyRoleGenerationMutation(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  context: ResolvedRoleContext,
): FoundationResult {
  const configRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  requireRoleActorBinding(db, request, false);
  if (!request.roleId || !request.qualificationId || !request.profileDigest || !request.fixtureContextDigest) {
    throw refusal("INVALID_INPUT", "role generation requires role, qualification, profile, and fixture context identities");
  }
  const resolved = requireRoleRequirement(db, request, configRevision);
  requireRoleTargetContext(db, request, resolved, context);
  if (!roleRequirementProfileMatches(resolved.requirement, context.profile) || request.profileDigest !== context.requestedProfileDigest) {
    throw refusal("EXECUTION_PROFILE_MISMATCH", "holder requested profile does not match the role requirement");
  }
  const standbyProfile = request.standbyProfile;
  if (resolved.requirement.standbyProfile && (!standbyProfile || !roleRequirementProfileMatches(resolved.requirement, standbyProfile))) {
    throw refusal("ROLE_STANDBY_INVALID", "director-seat role generation requires another allowed profile from its configured pair");
  }
  if (request.roleId === "director") {
    if (!standbyProfile || standbyProfile.providerId === context.profile.providerId) {
      throw refusal("ROLE_STANDBY_INVALID", "director role generation requires a named standby from another provider");
    }
  } else if (standbyProfile) {
    throw refusal("ROLE_STANDBY_INVALID", "standby is reserved for the director seat");
  }
  const expectedContextDigest = qualificationContextDigest(context, resolved, request);
  const observation = asRow<QualificationObservationRow>(
    db.prepare("SELECT * FROM qualification_observations WHERE project_id = ? AND qualification_id = ?").get(request.projectId, request.qualificationId),
  );
  if (!observation) throw refusal("ROLE_UNQUALIFIED", "qualification observation is not known");
  const projection = asRow<EligibilityProjectionRow>(
    db.prepare("SELECT * FROM eligibility_projections WHERE project_id = ? AND role_requirement_id = ? AND requested_profile_digest = ? AND domain_id = ?").get(
      request.projectId,
      resolved.requirement.roleRequirementId,
      request.profileDigest,
      resolved.domainId,
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
    observation.requested_profile_digest !== request.profileDigest ||
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
  if (request.roleId === "project-orchestrator") {
    const reconciliationIssues = workItemReconciliationIssues(db, request.projectId);
    if (reconciliationIssues.length > 0) {
      throw refusal(
        "WORK_ITEM_STATE_INVALID",
        `orchestrator handoff reconciliation refused: ${canonicalJson(reconciliationIssues)}`,
        { expected: 0, attempted: reconciliationIssues.length, verified: 0 },
      );
    }
  }
  const head = asRow<{ current_generation: number }>(
    db.prepare("SELECT current_generation FROM role_generation_heads WHERE project_id = ? AND role_id = ? AND domain_id = ?").get(request.projectId, request.roleId, resolved.domainId),
  );
  const first = request.expectedGeneration === null && request.predecessorGeneration === null;
  let nextGeneration: number;
  if (first) {
    if (head) throw refusal("ROLE_GENERATION_STALE", "first generation requires no current role head", { currentResourceRevision: head.current_generation });
    nextGeneration = ((db.prepare("SELECT COALESCE(MAX(generation), 0) AS generation FROM role_generations WHERE project_id = ? AND role_id = ? AND domain_id = ?").get(request.projectId, request.roleId, resolved.domainId) as { generation: number }).generation) + 1;
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
      db.prepare("SELECT status, domain_id FROM role_generations WHERE project_id = ? AND role_id = ? AND generation = ? AND domain_id = ?").get(
        request.projectId,
        request.roleId,
        request.predecessorGeneration,
        resolved.domainId,
      ),
    );
    if (!predecessor || !["active", "draining"].includes(predecessor.status)) throw refusal("ROLE_NOT_ACTIVE", "predecessor is not current and active or draining");
    nextGeneration = request.expectedGeneration + 1;
  }
  let eventType: RoleGenerationEventType;
  try {
    eventType = roleGenerationEventType(nextGeneration, request.predecessorGeneration ?? null);
  } catch {
    throw refusal("ROLE_PREDECESSOR_MISMATCH", "role generation is neither first-generation creation nor succession");
  }
  const createdAtMs = now();
  const persistedPredecessorGeneration = request.predecessorGeneration ?? null;
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
      project_id, role_id, generation, domain_id, role_requirement_id, config_revision, repo_target_id,
      status, predecessor_generation, holder_execution_attempt_id, holder_context_digest,
      holder_requested_profile_digest, qualification_id, eligibility_derivation_digest,
      created_at_ms, activated_at_ms, retired_at_ms, standby_profile_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    request.projectId,
    request.roleId,
    nextGeneration,
    resolved.domainId,
    resolved.requirement.roleRequirementId,
    configRevision,
    resolved.requirement.repoTargetId,
    persistedPredecessorGeneration,
    context.holderExecutionAttemptId,
    expectedContextDigest,
    context.requestedProfileDigest,
    request.qualificationId,
    projection.derivation_digest,
    createdAtMs,
    createdAtMs,
    standbyProfile ? canonicalJson(standbyProfile) : null,
  );
  if (first) {
    db.prepare("INSERT INTO role_generation_heads (project_id, role_id, domain_id, current_generation, updated_at_ms) VALUES (?, ?, ?, ?, ?)").run(
      request.projectId,
      request.roleId,
      resolved.domainId,
      nextGeneration,
      createdAtMs,
    );
  } else {
    const retired = db.prepare(
      `UPDATE role_generations SET status = 'retired', retired_at_ms = ?
       WHERE project_id = ? AND role_id = ? AND generation = ? AND domain_id = ? AND status IN ('active', 'draining')`,
    ).run(createdAtMs, request.projectId, request.roleId, request.predecessorGeneration, resolved.domainId);
    if (retired.changes !== 1) throw refusal("ROLE_NOT_ACTIVE", "predecessor retirement compare-and-swap failed");
    const advanced = db.prepare(
      `UPDATE role_generation_heads SET current_generation = ?, updated_at_ms = ?
       WHERE project_id = ? AND role_id = ? AND domain_id = ? AND current_generation = ?`,
    ).run(nextGeneration, createdAtMs, request.projectId, request.roleId, resolved.domainId, request.expectedGeneration);
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
      eventType,
      event: {
        roleId: request.roleId,
        domainId: resolved.domainId,
        generation: nextGeneration,
        predecessorGeneration: request.predecessorGeneration,
        qualificationId: request.qualificationId,
        standbyProfileDigest: standbyProfile ? sha256(canonicalJson(standbyProfile)) : null,
      },
    },
    { expected: 1, attempted: 1, verified: 1 },
    {
      currentConfigRevision: configRevision,
      currentGovernanceEpoch: governor.governance_epoch,
      currentResourceRevision: nextGeneration,
      expectedResourceRevision: request.expectedGeneration ?? undefined,
      eventType,
      evidence: {
        roleId: request.roleId,
        generation: nextGeneration,
        predecessorGeneration: request.predecessorGeneration,
        holderExecutionAttemptId: context.holderExecutionAttemptId,
        holderContextDigest: expectedContextDigest,
        requestedProfileDigest: context.requestedProfileDigest,
        qualificationId: request.qualificationId,
        eligibilityDerivationDigest: projection.derivation_digest,
        standbyProfile: standbyProfile ?? null,
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
    const configRevision = requireConfig(db, request);
    const resolved = requireRoleRequirement(db, request, configRevision);
    return transaction(db, () => {
      const replayInTransaction = checkIdempotency(db, request, digest);
      if (replayInTransaction) return replayInTransaction;
      return request.operationClass === "qualification_observation_record"
        ? applyQualificationObservation(db, request, digest, context)
        : applyRoleGenerationMutation(db, request, digest, context);
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
  domain_id: string;
  task_class: string;
  title: string;
  body: string;
  lifecycle_state: WorkItemState;
  resource_revision: number;
  created_at_ms: number;
  updated_at_ms: number;
}

type WorkAttempt = z.infer<typeof workAttemptSchema>;
type WorkAttemptState = (typeof WORK_ITEM_CAPACITY_ATTEMPT_STATES)[number] | "done" | "blocked" | "failed";
type ReviewCandidate = {
  candidateKind: "pull-request" | "local";
  prNumber?: number;
  headSha?: string;
  baseSha?: string;
  candidateSha?: string;
  environment?: z.infer<typeof reviewCandidateEnvironmentSchema>;
  checkout?: z.infer<typeof reviewCandidateCheckoutSchema>;
  observation?: z.infer<typeof reviewCandidateObservationSchema>;
};

function reviewCandidateFromAttempt(attempt: WorkAttempt): ReviewCandidate | null {
  if (attempt.assignmentKind !== "review" || !attempt.candidateKind) return null;
  return attempt.candidateKind === "pull-request"
    ? { candidateKind: "pull-request", prNumber: attempt.reviewPrNumber, headSha: attempt.reviewPrHeadSha }
    : {
      candidateKind: "local",
      baseSha: attempt.reviewBaseSha,
      candidateSha: attempt.reviewCandidateSha,
      environment: attempt.reviewCandidateEnvironment,
      checkout: attempt.reviewCandidateCheckout,
      observation: attempt.reviewCandidateObservation,
    };
}

function reviewCandidateJson(attempt: WorkAttempt): string | null {
  const candidate = reviewCandidateFromAttempt(attempt);
  return candidate ? canonicalJson(candidate) : null;
}

function reviewCandidateMatches(row: { review_candidate_kind?: string | null; review_candidate_json?: string | null }, attempt: WorkAttempt): boolean {
  const candidate = reviewCandidateFromAttempt(attempt);
  return candidate !== null && row.review_candidate_kind === candidate.candidateKind && row.review_candidate_json === canonicalJson(candidate);
}

function reviewAuthorityMatches(row: {
  review_role_requirement_id?: string | null;
  review_role_id?: string | null;
  review_role_generation?: number | null;
  review_frozen_brief_version?: number | null;
  review_frozen_brief_content?: string | null;
  review_frozen_brief_digest?: string | null;
  review_return_path_json?: string | null;
}, attempt: WorkAttempt): boolean {
  if (attempt.assignmentKind !== "review" || attempt.candidateKind !== "local") return true;
  return row.review_role_requirement_id === attempt.reviewRoleRequirementId &&
    row.review_role_id === attempt.reviewRoleId &&
    row.review_role_generation === attempt.reviewRoleGeneration &&
    row.review_frozen_brief_version === attempt.reviewFrozenBriefVersion &&
    row.review_frozen_brief_content === attempt.reviewFrozenBriefContent &&
    row.review_frozen_brief_digest === attempt.reviewFrozenBriefDigest &&
    row.review_return_path_json === canonicalJson(attempt.reviewReturnPath);
}

const ACTIVE_WORK_ATTEMPT_STATES = WORK_ITEM_CAPACITY_ATTEMPT_STATES;
const WORK_ITEM_THREAD_TOKEN = /thr_[A-Za-z0-9]+/gu;
const WORK_ITEM_LANE_SENTENCE = /^(?:Lane|Writing lane) (thr_[A-Za-z0-9]+)(?:[,.!?])?(?:[ \t]+|\r?\n|$)/u;

export interface WorkItemBackfillCounts {
  candidates: number;
  attributable: number;
  inserted: number;
  alreadyBound: number;
  residualProposed: number;
  unresolved: number;
}

function parseBackfillLane(body: string): { token: string; strippedBody: string } | null {
  const tokens = [...body.matchAll(WORK_ITEM_THREAD_TOKEN)].map((match) => match[0]);
  const distinctTokens = new Set(tokens);
  const leading = WORK_ITEM_LANE_SENTENCE.exec(body);
  if (!leading || distinctTokens.size !== 1 || leading[1] !== [...distinctTokens][0]) return null;
  return { token: leading[1], strippedBody: body.slice(leading[0].length) };
}

function workAttemptId(input: {
  projectId: string;
  workItemId: string;
  domainId?: string;
  attemptOrdinal: number;
  laneId: string;
  threadId: string | null;
  roleId?: string | null;
  roleGeneration?: number | null;
  reviewPrNumber: number | null;
  reviewPrHeadSha: string | null;
  reviewCandidateKind: string | null;
  reviewCandidateJson: string | null;
  reviewRoleRequirementId?: string | null;
  reviewRoleId?: string | null;
  reviewRoleGeneration?: number | null;
  reviewFrozenBriefVersion?: 1 | null;
  reviewFrozenBriefContent?: string | null;
  reviewFrozenBriefDigest?: string | null;
  reviewReturnPathJson?: string | null;
}): string {
  return sha256(canonicalJson({
    origin: "work_item",
    ...input,
    domainId: input.domainId ?? "default",
    reviewRoleRequirementId: input.reviewRoleRequirementId ?? null,
    reviewRoleId: input.reviewRoleId ?? null,
    reviewRoleGeneration: input.reviewRoleGeneration ?? null,
    reviewFrozenBriefVersion: input.reviewFrozenBriefVersion ?? null,
    reviewFrozenBriefContent: input.reviewFrozenBriefContent ?? null,
    reviewFrozenBriefDigest: input.reviewFrozenBriefDigest ?? null,
    reviewReturnPathJson: input.reviewReturnPathJson ?? null,
  }));
}

function insertWorkItemAttempt(
  db: SqliteDatabase,
  input: {
    projectId: string;
    workItemId: string;
    domainId?: string;
    configRevision: number;
    repoTargetId: string;
    laneId: string;
    threadId: string | null;
    roleId?: string | null;
    roleGeneration?: number | null;
    leaseOwnerThreadId: string | null;
    assignmentKind: WorkAttempt["assignmentKind"];
    requestedProfile?: ExecutionProfile;
    attemptOrdinal: number;
    state: WorkAttemptState;
    reasonCode: string;
    createdAtMs: number;
    observedAtMs: number;
    completedAtMs: number | null;
    continuationOfAttemptId: string | null;
    reviewPrNumber: number | null;
    reviewPrHeadSha: string | null;
    reviewCandidateKind: string | null;
    reviewCandidateJson: string | null;
    reviewRoleRequirementId?: string | null;
    reviewRoleId?: string | null;
    reviewRoleGeneration?: number | null;
    reviewFrozenBriefVersion?: 1 | null;
    reviewFrozenBriefContent?: string | null;
    reviewFrozenBriefDigest?: string | null;
    reviewReturnPathJson?: string | null;
    dispatchInputDigest?: string | null;
  },
): string {
  const executionAttemptId = workAttemptId(input);
  const attemptDigest = sha256(canonicalJson({
    origin: "work_item",
    executionAttemptId,
    projectId: input.projectId,
    workItemId: input.workItemId,
    domainId: input.domainId ?? "default",
    laneId: input.laneId,
    threadId: input.threadId,
    roleId: input.roleId ?? null,
    roleGeneration: input.roleGeneration ?? null,
    assignmentKind: input.assignmentKind,
    requestedProfileDigest: input.requestedProfile ? requestedProfileDigest(input.requestedProfile) : null,
    reviewPrNumber: input.reviewPrNumber,
    reviewPrHeadSha: input.reviewPrHeadSha,
    reviewCandidateKind: input.reviewCandidateKind,
    reviewCandidateJson: input.reviewCandidateJson,
    reviewRoleRequirementId: input.reviewRoleRequirementId ?? null,
    reviewRoleId: input.reviewRoleId ?? null,
    reviewRoleGeneration: input.reviewRoleGeneration ?? null,
    reviewFrozenBriefVersion: input.reviewFrozenBriefVersion ?? null,
    reviewFrozenBriefContent: input.reviewFrozenBriefContent ?? null,
    reviewFrozenBriefDigest: input.reviewFrozenBriefDigest ?? null,
    reviewReturnPathJson: input.reviewReturnPathJson ?? null,
    dispatchInputDigest: input.dispatchInputDigest ?? null,
    attemptOrdinal: input.attemptOrdinal,
    state: input.state,
    reasonCode: input.reasonCode,
    createdAtMs: input.createdAtMs,
    continuationOfAttemptId: input.continuationOfAttemptId,
  }));
  db.prepare(
    `INSERT INTO execution_attempts (
       project_id, execution_attempt_id, origin, lane_id, assignment_kind, attempt_ordinal,
       config_revision, work_item_id, repo_target_id, state, thread_id, reason_code,
       role_id, role_generation,
       requested_provider_id, requested_model, requested_reasoning_level, requested_profile_digest,
       review_pr_number, review_pr_head_sha, review_candidate_kind, review_candidate_json,
       review_role_requirement_id, review_role_id, review_role_generation, review_frozen_brief_version,
       review_frozen_brief_content, review_frozen_brief_digest, review_return_path_json, dispatch_input_digest,
       progress_json, lease_owner_thread_id, continuation_of_attempt_id, created_at_ms,
       observed_at_ms, completed_at_ms, attempt_digest
     ) VALUES (
       @projectId, @executionAttemptId, 'work_item', @laneId, @assignmentKind, @attemptOrdinal,
       @configRevision, @workItemId, @repoTargetId, @state, @threadId, @reasonCode,
       @roleId, @roleGeneration,
       @requestedProviderId, @requestedModel, @requestedReasoningLevel, @requestedProfileDigest,
       @reviewPrNumber, @reviewPrHeadSha, @reviewCandidateKind, @reviewCandidateJson,
       @reviewRoleRequirementId, @reviewRoleId, @reviewRoleGeneration, @reviewFrozenBriefVersion,
       @reviewFrozenBriefContent, @reviewFrozenBriefDigest, @reviewReturnPathJson, @dispatchInputDigest,
       '{}', @leaseOwnerThreadId, @continuationOfAttemptId, @createdAtMs,
       @observedAtMs, @completedAtMs, @attemptDigest
     )`,
  ).run({
    projectId: input.projectId,
    executionAttemptId,
    laneId: input.laneId,
    assignmentKind: input.assignmentKind,
    attemptOrdinal: input.attemptOrdinal,
    configRevision: input.configRevision,
    workItemId: input.workItemId,
    repoTargetId: input.repoTargetId,
    state: input.state,
    threadId: input.threadId,
    reasonCode: input.reasonCode,
    roleId: input.roleId ?? null,
    roleGeneration: input.roleGeneration ?? null,
    requestedProviderId: input.requestedProfile?.providerId ?? null,
    requestedModel: input.requestedProfile?.model ?? null,
    requestedReasoningLevel: input.requestedProfile?.reasoningLevel ?? null,
    requestedProfileDigest: input.requestedProfile ? requestedProfileDigest(input.requestedProfile) : null,
    reviewPrNumber: input.reviewPrNumber,
    reviewPrHeadSha: input.reviewPrHeadSha,
    reviewCandidateKind: input.reviewCandidateKind,
    reviewCandidateJson: input.reviewCandidateJson,
    reviewRoleRequirementId: input.reviewRoleRequirementId ?? null,
    reviewRoleId: input.reviewRoleId ?? null,
    reviewRoleGeneration: input.reviewRoleGeneration ?? null,
    reviewFrozenBriefVersion: input.reviewFrozenBriefVersion ?? null,
    reviewFrozenBriefContent: input.reviewFrozenBriefContent ?? null,
    reviewFrozenBriefDigest: input.reviewFrozenBriefDigest ?? null,
    reviewReturnPathJson: input.reviewReturnPathJson ?? null,
    dispatchInputDigest: input.dispatchInputDigest ?? null,
    leaseOwnerThreadId: input.leaseOwnerThreadId,
    continuationOfAttemptId: input.continuationOfAttemptId,
    createdAtMs: input.createdAtMs,
    observedAtMs: input.observedAtMs,
    completedAtMs: input.completedAtMs,
    attemptDigest,
  });
  if (input.domainId !== undefined) {
    db.prepare("UPDATE execution_attempts SET domain_id = ? WHERE project_id = ? AND execution_attempt_id = ?").run(input.domainId, input.projectId, executionAttemptId);
  }
  return executionAttemptId;
}

function requireWorkAttemptProfile(attempt: WorkAttempt): ExecutionProfile {
  if (!attempt.requestedProfile) throw refusal("EXECUTION_PROFILE_UNKNOWN", "work-item dispatch requires an explicit requested execution profile");
  return attempt.requestedProfile;
}

function gh300BackfillEpochMs(db: SqliteDatabase): number {
  const row = db.prepare("SELECT applied_at FROM _bb_migrations WHERE id = ?").get(GH300_BACKFILL_MIGRATION_ID) as { applied_at?: unknown } | undefined;
  if (typeof row?.applied_at !== "number" || !Number.isSafeInteger(row.applied_at)) {
    throw new Error("GH300 backfill refused: migration epoch is unavailable");
  }
  return row.applied_at;
}

export function backfillWorkItemAttempts(db: SqliteDatabase, migrationAppliedAtMs = gh300BackfillEpochMs(db)): WorkItemBackfillCounts {
  return transaction(db, () => {
    const hasDomainColumns = tableColumns(db, "work_items").includes("domain_id");
    const rows = db.prepare(
      `SELECT project_id, work_item_id, config_revision, repo_target_id, ${hasDomainColumns ? "domain_id, task_class," : "'default' AS domain_id, 'default' AS task_class,"} body, lifecycle_state, created_at_ms, updated_at_ms
       FROM work_items WHERE body LIKE '%thr\\_%' ESCAPE '\\' AND created_at_ms <= ? ORDER BY project_id, work_item_id`,
    ).all(migrationAppliedAtMs) as Array<WorkItemRow>;
    const counts: WorkItemBackfillCounts = { candidates: rows.length, attributable: 0, inserted: 0, alreadyBound: 0, residualProposed: 0, unresolved: 0 };
    for (const row of rows) {
      const existing = db.prepare(
        "SELECT 1 FROM execution_attempts WHERE project_id = ? AND work_item_id = ? AND origin = 'work_item' LIMIT 1",
      ).get(row.project_id, row.work_item_id);
      if (existing) {
        counts.alreadyBound += 1;
        continue;
      }
      const parsed = parseBackfillLane(row.body);
      if (row.lifecycle_state === "proposed") {
        if (!parsed) {
          counts.unresolved += 1;
          continue;
        }
        counts.residualProposed += 1;
        continue;
      }
      const state: WorkAttemptState | null = row.lifecycle_state === "succeeded"
        ? "done"
        : row.lifecycle_state === "in_progress"
          ? "running"
          : row.lifecycle_state === "review_pending"
            ? "done"
            : row.lifecycle_state === "failed" || row.lifecycle_state === "cancelled"
              ? "failed"
              : null;
      if (!parsed || state === null) {
        counts.unresolved += 1;
        continue;
      }
      counts.attributable += 1;
      insertWorkItemAttempt(db, {
        projectId: row.project_id,
        workItemId: row.work_item_id,
        domainId: row.domain_id ?? "default",
        configRevision: row.config_revision,
        repoTargetId: row.repo_target_id,
        laneId: parsed.token,
        threadId: parsed.token,
        leaseOwnerThreadId: null,
        assignmentKind: "write",
        attemptOrdinal: 1,
        state,
        reasonCode: "gh300_backfill",
        createdAtMs: row.created_at_ms,
        observedAtMs: row.updated_at_ms,
        completedAtMs: state === "running" ? null : row.updated_at_ms,
        continuationOfAttemptId: null,
        reviewPrNumber: null,
        reviewPrHeadSha: null,
        reviewCandidateKind: null,
        reviewCandidateJson: null,
      });
      db.prepare(
        "UPDATE work_items SET body = ? WHERE project_id = ? AND work_item_id = ?",
      ).run(parsed.strippedBody, row.project_id, row.work_item_id);
      counts.inserted += 1;
    }
    if (counts.unresolved > 0) {
      throw new Error(`GH300 backfill refused: ${counts.unresolved} thr_ work item(s) were not attributable`);
    }
    const remaining = (db.prepare(
      `SELECT COUNT(*) AS count FROM work_items
       WHERE body LIKE '%thr\\_%' ESCAPE '\\' AND created_at_ms <= ? AND NOT EXISTS (
         SELECT 1 FROM execution_attempts
         WHERE execution_attempts.project_id = work_items.project_id
           AND execution_attempts.work_item_id = work_items.work_item_id
           AND execution_attempts.origin = 'work_item'
       )`,
    ).get(migrationAppliedAtMs) as { count: number }).count;
    if (remaining !== counts.residualProposed) throw new Error(`GH300 backfill refused: ${remaining} thr_ work item(s) have no attempt record`);
    return counts;
  });
}

function nextWorkAttemptOrdinal(db: SqliteDatabase, projectId: string, workItemId: string): number {
  return ((db.prepare(
    "SELECT COALESCE(MAX(attempt_ordinal), 0) AS next_attempt_ordinal FROM execution_attempts WHERE project_id = ? AND work_item_id = ? AND origin = 'work_item'",
  ).get(projectId, workItemId) as { next_attempt_ordinal: number }).next_attempt_ordinal) + 1;
}

function activeWorkItemAttempt(
  db: SqliteDatabase,
  projectId: string,
  workItemId: string,
  assignmentKind?: WorkAttempt["assignmentKind"],
): { execution_attempt_id: string; review_pr_number: number | null; review_pr_head_sha: string | null; review_candidate_kind: string | null; review_candidate_json: string | null; review_role_requirement_id: string | null; review_role_id: string | null; review_role_generation: number | null; review_frozen_brief_version: number | null; review_frozen_brief_content: string | null; review_frozen_brief_digest: string | null; review_return_path_json: string | null } | undefined {
  const assignmentFilter = assignmentKind === undefined ? "" : " AND assignment_kind = ?";
  return asRow<{ execution_attempt_id: string; review_pr_number: number | null; review_pr_head_sha: string | null; review_candidate_kind: string | null; review_candidate_json: string | null; review_role_requirement_id: string | null; review_role_id: string | null; review_role_generation: number | null; review_frozen_brief_version: number | null; review_frozen_brief_content: string | null; review_frozen_brief_digest: string | null; review_return_path_json: string | null }>(db.prepare(
    `SELECT execution_attempt_id, review_pr_number, review_pr_head_sha, review_candidate_kind, review_candidate_json,
            review_role_requirement_id, review_role_id, review_role_generation, review_frozen_brief_version,
            review_frozen_brief_content, review_frozen_brief_digest, review_return_path_json FROM execution_attempts
     WHERE project_id = ? AND work_item_id = ? AND origin = 'work_item'
       AND state IN (${ACTIVE_WORK_ATTEMPT_STATES.map(() => "?").join(", ")})${assignmentFilter}
     ORDER BY attempt_ordinal DESC LIMIT 1`,
  ).get(projectId, workItemId, ...ACTIVE_WORK_ATTEMPT_STATES, ...(assignmentKind === undefined ? [] : [assignmentKind])));
}

function latestWorkItemAttempt(
  db: SqliteDatabase,
  projectId: string,
  workItemId: string,
): { execution_attempt_id: string; state: string; assignment_kind: WorkAttempt["assignmentKind"] | null; thread_id: string | null } | undefined {
  return asRow(db.prepare(
    `SELECT execution_attempt_id, state, assignment_kind, thread_id FROM execution_attempts
     WHERE project_id = ? AND work_item_id = ? AND origin = 'work_item'
     ORDER BY attempt_ordinal DESC LIMIT 1`,
  ).get(projectId, workItemId));
}

function supersedeInterruptedAttempt(db: SqliteDatabase, projectId: string, executionAttemptId: string): void {
  const updated = db.prepare(
    `UPDATE execution_attempts
     SET state = 'superseded', terminalization_class = 'resumed-continuation',
         observed_at_ms = ?, completed_at_ms = ?, lease_owner_thread_id = NULL, progress_json = '{}'
     WHERE project_id = ? AND execution_attempt_id = ? AND state = 'interrupted'`,
  ).run(now(), now(), projectId, executionAttemptId);
  if (updated.changes !== 1) throw refusal("WORK_ITEM_STATE_INVALID", "interrupted predecessor could not be cleared for explicit resume");
}

function terminalizeWorkItemAttempt(
  db: SqliteDatabase,
  projectId: string,
  workItemId: string,
  state: "done" | "blocked" | "failed" | "superseded",
  assignmentKind?: WorkAttempt["assignmentKind"],
  terminalizationClass?: string,
): string | null {
  const active = activeWorkItemAttempt(db, projectId, workItemId, assignmentKind);
  if (!active) return null;
  if (state === "done" && terminalizationClass === undefined) {
    throw refusal("TERMINAL_REPORT_REQUIRED", "done requires accepted terminal evidence or an authorized no-report class");
  }
  const completedAtMs = now();
  db.prepare(
    `UPDATE execution_attempts
     SET state = ?, observed_at_ms = ?, completed_at_ms = ?, lease_owner_thread_id = NULL,
         progress_json = '{}', terminalization_class = COALESCE(?, terminalization_class)
     WHERE project_id = ? AND execution_attempt_id = ?`,
  ).run(state, completedAtMs, completedAtMs, terminalizationClass ?? null, projectId, active.execution_attempt_id);
  return active.execution_attempt_id;
}

type InterruptionEvidence = z.infer<typeof interruptionEvidenceSchema>;
type HistoricalCorrection = z.infer<typeof historicalCorrectionSchema>;

function sameNullable(actual: unknown, expected: unknown): boolean {
  return actual === expected;
}

function requireAttemptForMutation(
  db: SqliteDatabase,
  request: ApplyRequest,
  attemptId: string,
): ExecutionAttemptRow {
  const attempt = asRow<ExecutionAttemptRow>(db.prepare(
    "SELECT * FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ?",
  ).get(request.projectId, attemptId));
  if (attempt) return attempt;
  const foreign = db.prepare("SELECT 1 FROM execution_attempts WHERE execution_attempt_id = ? LIMIT 1").get(attemptId);
  throw refusal(foreign ? "EXECUTION_CONTEXT_FOREIGN" : "TERMINAL_REPORT_AMBIGUOUS", foreign
    ? "execution attempt belongs to another project"
    : "execution attempt is not known");
}

function requireReviewHandoff(
  db: SqliteDatabase,
  request: ApplyRequest,
  workItem: WorkItemRow,
): ReviewHandoff {
  const handoff = request.reviewHandoff;
  if (!handoff || !request.executionAttemptId || handoff.executionAttemptId !== request.executionAttemptId) {
    throw refusal("WORK_ITEM_STATE_INVALID", "review-pending requires an explicit exact review handoff attempt");
  }
  if (handoff.kind === "active-write-legacy-handoff") {
    if (request.reasonCode !== LEGACY_REVIEW_HANDOFF_REASON) {
      throw refusal("WORK_ITEM_STATE_INVALID", "active-write legacy handoff requires its explicit recovery reason");
    }
    const active = requireAttemptForMutation(db, request, handoff.executionAttemptId);
    const latest = latestWorkItemAttempt(db, request.projectId, workItem.work_item_id);
    if (
      active.work_item_id !== workItem.work_item_id ||
      active.origin !== "work_item" ||
      active.assignment_kind !== "write" ||
      !WORK_ITEM_CAPACITY_ATTEMPT_STATES.includes(active.state as typeof WORK_ITEM_CAPACITY_ATTEMPT_STATES[number]) ||
      latest?.execution_attempt_id !== handoff.executionAttemptId
    ) {
      throw refusal("WORK_ITEM_STATE_INVALID", "legacy review handoff does not identify the latest active writer");
    }
    return handoff;
  }

  const attempt = requireAttemptForMutation(db, request, handoff.executionAttemptId);
  const latest = latestWorkItemAttempt(db, request.projectId, workItem.work_item_id);
  const successor = db.prepare(
    `SELECT execution_attempt_id FROM execution_attempts
     WHERE project_id = ? AND work_item_id = ? AND origin = 'work_item'
       AND attempt_ordinal > ? LIMIT 1`,
  ).get(request.projectId, workItem.work_item_id, attempt.attempt_ordinal);
  if (
    attempt.work_item_id !== workItem.work_item_id ||
    attempt.origin !== "work_item" ||
    attempt.assignment_kind !== "write" ||
    latest?.execution_attempt_id !== handoff.executionAttemptId ||
    successor ||
    activeWorkItemAttempt(db, request.projectId, workItem.work_item_id, "write") ||
    attempt.state !== "done" ||
    attempt.terminalization_class !== "accepted-terminal-report" ||
    attempt.terminal_result !== "DONE" ||
    attempt.reported_outcome !== "DONE" ||
    !attempt.terminal_report_digest ||
    !attempt.terminal_report_json ||
    !attempt.terminal_event_id ||
    attempt.terminal_event_seq === null
  ) {
    throw refusal("WORK_ITEM_STATE_INVALID", "review handoff requires the exact latest accepted DONE writing attempt");
  }
  let report: z.infer<typeof terminalReportSchema>;
  try {
    const parsed = JSON.parse(attempt.terminal_report_json);
    const result = terminalReportSchema.safeParse(parsed);
    if (!result.success || canonicalJson(result.data) !== attempt.terminal_report_json) throw new Error("invalid terminal report");
    report = result.data;
  } catch {
    throw refusal("WORK_ITEM_STATE_INVALID", "accepted terminal report JSON is missing or inconsistent");
  }
  const reportDigest = sha256(attempt.terminal_report_json);
  if (
    handoff.terminalReportDigest !== reportDigest ||
    attempt.terminal_report_digest !== reportDigest ||
    handoff.terminalEventId !== attempt.terminal_event_id ||
    handoff.terminalEventSeq !== attempt.terminal_event_seq ||
    report.outcome !== "DONE" ||
    report.projectId !== request.projectId ||
    report.workItemId !== workItem.work_item_id ||
    report.executionAttemptId !== attempt.execution_attempt_id ||
    report.nativeEventId !== attempt.terminal_event_id ||
    report.nativeEventSeq !== attempt.terminal_event_seq
  ) {
    throw refusal("WORK_ITEM_STATE_INVALID", "accepted terminal report identity or digest is inconsistent");
  }
  const acceptedEvent = asRow<{ event_json: string }>(db.prepare(
    `SELECT event_json FROM state_events
     WHERE project_id = ? AND aggregate_type = 'execution_attempt' AND aggregate_id = ?
       AND event_type = 'execution_attempt_terminal_report_accepted'
     ORDER BY event_sequence DESC LIMIT 1`,
  ).get(request.projectId, attempt.execution_attempt_id));
  let event: { executionAttemptId?: unknown; outcome?: unknown; nativeEventId?: unknown; nativeEventSeq?: unknown; terminalReportDigest?: unknown };
  try {
    const parsed = JSON.parse(acceptedEvent?.event_json ?? "null");
    event = parsed && typeof parsed === "object" ? parsed as typeof event : {};
  } catch {
    event = {};
  }
  if (
    !acceptedEvent ||
    event.executionAttemptId !== attempt.execution_attempt_id ||
    event.outcome !== "DONE" ||
    event.nativeEventId !== attempt.terminal_event_id ||
    event.nativeEventSeq !== attempt.terminal_event_seq ||
    event.terminalReportDigest !== reportDigest
  ) {
    throw refusal("WORK_ITEM_STATE_INVALID", "accepted terminal report event evidence is missing or inconsistent");
  }
  return handoff;
}

function applyExecutionAttemptTerminalReport(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  evidenceReader: ExecutionAttemptEvidenceReader | null,
  nativeSeat: AuthenticatedNativeSeat | null,
): FoundationResult {
  const configRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  requireNativeSeatActorAgreement(requireRoleActorBinding(db, request, false), nativeSeat);
  const report = request.terminalReport;
  if (!report || !request.executionAttemptId || report.projectId !== request.projectId || report.executionAttemptId !== request.executionAttemptId) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", "terminal report and request do not identify the exact project and attempt");
  }
  if (!request.workItemId || report.workItemId !== request.workItemId) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", "terminal report and request do not identify the exact work item");
  }
  if (!evidenceReader) throw refusal("TERMINAL_REPORT_AMBIGUOUS", "terminal report requires authoritative native evidence");
  const workItem = requireWorkItem(db, request, configRevision, undefined, true);
  const attempt = requireAttemptForMutation(db, request, report.executionAttemptId);
  const exact: Array<[string, unknown, unknown]> = [
    ["work item", attempt.work_item_id, report.workItemId],
    ["assignment", attempt.assignment_id, report.assignmentId],
    ["role", attempt.role_id, report.roleId],
    ["role generation", attempt.role_generation, report.roleGeneration],
    ["repository target", attempt.repo_target_id, report.repoTargetId],
    ["thread", attempt.thread_id, report.threadId],
    ["branch", attempt.branch_name, report.branchName],
    ["base", attempt.base_sha, report.baseSha],
    ["candidate", attempt.candidate_sha, report.candidateSha],
  ];
  const mismatch = exact.find(([, actual, expected]) => !sameNullable(actual, expected));
  if (mismatch) throw refusal("TERMINAL_REPORT_AMBIGUOUS", `terminal report ${mismatch[0]} identity does not match the canonical attempt`);
  // #718: work-attempt rows never persisted environment_id. A persisted identity
  // must match the report exactly here; an unpersisted one is bound to the native
  // thread's environment by the authoritative gate below.
  if (attempt.environment_id !== null && !sameNullable(report.environmentId, attempt.environment_id)) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", "terminal report environment identity does not match the canonical attempt");
  }
  if (attempt.thread_id === null || report.nativeEventSeq <= 0 || report.nativeEventId.length === 0) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", "terminal report lacks exact native thread/event evidence");
  }
  let authoritative: AuthoritativeTerminalEvidence;
  try {
    authoritative = evidenceReader.terminal({
      projectId: request.projectId,
      workItemId: workItem.work_item_id,
      executionAttemptId: report.executionAttemptId,
      nativeEventId: report.nativeEventId,
      nativeEventSeq: report.nativeEventSeq,
      nativeTurnId: report.nativeTurnId,
    });
  } catch {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", "terminal report authoritative native evidence is unavailable or foreign");
  }
  const authoritativeExact: Array<[string, unknown, unknown]> = [
    ["project", authoritative.projectId, request.projectId],
    ["work item", authoritative.workItemId, workItem.work_item_id],
    ["attempt", authoritative.executionAttemptId, report.executionAttemptId],
    ["repository target", authoritative.repoTargetId, workItem.repo_target_id],
    ["resource revision", authoritative.resourceRevision, workItem.resource_revision],
    ["assignment", authoritative.assignmentId, attempt.assignment_id],
    ["role", authoritative.roleId, attempt.role_id],
    ["role generation", authoritative.roleGeneration, attempt.role_generation],
    ["thread", authoritative.threadId, attempt.thread_id],
    ["branch", authoritative.branchName, attempt.branch_name],
    ["base", authoritative.baseSha, attempt.base_sha],
    ["candidate", authoritative.candidateSha, attempt.candidate_sha],
    ["native event", authoritative.nativeEventId, report.nativeEventId],
    ["native sequence", authoritative.nativeEventSeq, report.nativeEventSeq],
    ["native turn", authoritative.nativeTurnId, report.nativeTurnId],
    ["native receipt", authoritative.nativeReceiptDigest, report.nativeReceiptDigest],
    ["actual profile", authoritative.actualProfileDigest, report.actualProfileDigest],
    ["candidate observation", authoritative.candidateObservationDigest, report.candidateObservationDigest],
  ];
  const authoritativeMismatch = authoritativeExact.find(([, actual, expected]) => !sameNullable(actual, expected));
  if (authoritativeMismatch) throw refusal("TERMINAL_REPORT_AMBIGUOUS", `terminal report authoritative ${authoritativeMismatch[0]} evidence does not match`);
  // #718: environment binding. Persisted: native evidence must equal it.
  // Unpersisted (historical work-attempt rows): the native thread's environment
  // is the attempt's environment, and the report must carry exactly that value.
  if (attempt.environment_id !== null) {
    if (!sameNullable(authoritative.environmentId, attempt.environment_id)) throw refusal("TERMINAL_REPORT_AMBIGUOUS", "terminal report authoritative environment evidence does not match");
  } else if (authoritative.environmentId === null || !sameNullable(authoritative.environmentId, report.environmentId)) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", "terminal report environment identity does not match the native execution environment");
  }
  if (canonicalJson(authoritative.evidence) !== canonicalJson(report.evidence)) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", "terminal report evidence does not match the authoritative native evidence");
  }
  const terminalReportJson = canonicalJson(report);
  const terminalReportDigest = sha256(terminalReportJson);
  if (attempt.terminalization_class === "accepted-terminal-report") {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", attempt.terminal_report_digest === terminalReportDigest && attempt.terminal_report_json === terminalReportJson
      ? "the same terminal report was already accepted under another idempotency key"
      : "a conflicting terminal report was already accepted for this attempt");
  }
  if (!WORK_ITEM_CAPACITY_ATTEMPT_STATES.includes(attempt.state as typeof WORK_ITEM_CAPACITY_ATTEMPT_STATES[number])) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", `attempt is not reportable from state ${attempt.state}`);
  }
  const terminalState = report.outcome === "DONE" ? "done" : "blocked";
  const completedAtMs = now();
  db.prepare(
    `UPDATE execution_attempts
     SET state = ?, terminal_result = ?, reported_outcome = ?, terminal_report_digest = ?,
         terminal_report_json = ?, terminal_actual_profile_digest = ?, native_receipt_digest = ?,
         terminal_event_id = ?, terminal_event_seq = ?, terminalization_class = 'accepted-terminal-report',
         observed_at_ms = ?, completed_at_ms = ?, lease_owner_thread_id = NULL, progress_json = '{}'
     WHERE project_id = ? AND execution_attempt_id = ? AND state IN (${WORK_ITEM_CAPACITY_ATTEMPT_STATES.map(() => "?").join(", ")})`,
  ).run(
    terminalState,
    report.outcome,
    report.outcome,
    terminalReportDigest,
    terminalReportJson,
    report.actualProfileDigest,
    report.nativeReceiptDigest,
    report.nativeEventId,
    report.nativeEventSeq,
    completedAtMs,
    completedAtMs,
    request.projectId,
    report.executionAttemptId,
    ...WORK_ITEM_CAPACITY_ATTEMPT_STATES,
  );
  return commitMutation(
    db,
    request,
    digest,
    actorReceiptId,
    {
      aggregateType: "execution_attempt",
      aggregateId: report.executionAttemptId,
      aggregateRevision: nextAggregateRevision(db, request.projectId, "execution_attempt", report.executionAttemptId),
      eventType: "execution_attempt_terminal_report_accepted",
      event: {
        projectId: request.projectId,
        workItemId: report.workItemId,
        executionAttemptId: report.executionAttemptId,
        outcome: report.outcome,
        nativeEventId: report.nativeEventId,
        nativeEventSeq: report.nativeEventSeq,
        terminalReportDigest,
        originalExecution: { ownerThreadId: report.threadId, nativeEventId: report.nativeEventId, nativeEventSeq: report.nativeEventSeq, nativeTurnId: report.nativeTurnId },
        ...(nativeSeat === null ? {} : { consumption: {
          kind: "delegated-current-holder",
          path: "agent-tool:consume_execution_attempt_completion",
          domainId: nativeSeat.domainId,
          roleId: nativeSeat.roleId,
          roleGeneration: nativeSeat.roleGeneration,
          threadId: nativeSeat.threadId,
          holderExecutionAttemptId: nativeSeat.holderExecutionAttemptId,
        }}),
      },
    },
    { expected: 1, attempted: 1, verified: 1 },
    { currentConfigRevision: configRevision, currentGovernanceEpoch: governor.governance_epoch, evidence: {
      executionAttemptId: report.executionAttemptId,
      terminalReportDigest,
      originalExecution: { ownerThreadId: report.threadId, nativeEventId: report.nativeEventId, nativeEventSeq: report.nativeEventSeq, nativeTurnId: report.nativeTurnId },
      ...(nativeSeat === null ? {} : { consumption: {
        kind: "delegated-current-holder",
        path: "agent-tool:consume_execution_attempt_completion",
        domainId: nativeSeat.domainId,
        roleId: nativeSeat.roleId,
        roleGeneration: nativeSeat.roleGeneration,
        threadId: nativeSeat.threadId,
        holderExecutionAttemptId: nativeSeat.holderExecutionAttemptId,
      }}),
    } },
  );
}

function applyExecutionAttemptInterruption(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  evidenceReader: ExecutionAttemptEvidenceReader | null,
): FoundationResult {
  const configRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  requireRoleActorBinding(db, request, false);
  const evidence = request.interruption;
  if (!evidenceReader) throw refusal("TERMINAL_REPORT_AMBIGUOUS", "interruption requires authoritative native evidence");
  if (!evidence || !request.executionAttemptId || !request.workItemId || evidence.projectId !== request.projectId
    || evidence.executionAttemptId !== request.executionAttemptId || evidence.workItemId !== request.workItemId) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", "interruption evidence and request do not identify the exact project, work item, and attempt");
  }
  const attempt = requireAttemptForMutation(db, request, evidence.executionAttemptId);
  const workItem = requireWorkItem(db, request, configRevision, undefined, true);
  if (attempt.work_item_id !== evidence.workItemId || attempt.thread_id !== evidence.threadId) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", "interruption evidence does not match the canonical work item thread");
  }
  let authoritative: AuthoritativeHistoricalInterruption;
  try {
    authoritative = evidenceReader.historical({
      projectId: request.projectId,
      workItemId: workItem.work_item_id,
      executionAttemptId: evidence.executionAttemptId,
      nativeEventId: evidence.nativeEventId,
      nativeEventSeq: evidence.nativeEventSeq,
      threadId: evidence.threadId,
    });
  } catch {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", "interruption authoritative native evidence is unavailable or foreign");
  }
  const expectedEvidenceDigest = sha256(canonicalJson({
    projectId: authoritative.projectId,
    workItemId: authoritative.workItemId,
    executionAttemptId: authoritative.executionAttemptId,
    threadId: authoritative.threadId,
    reason: authoritative.reason,
    nativeEventId: authoritative.nativeEventId,
    nativeEventSeq: authoritative.nativeEventSeq,
    nativeTurnId: authoritative.nativeTurnId,
  }));
  const authoritativeExact: Array<[string, unknown, unknown]> = [
    ["project", authoritative.projectId, request.projectId],
    ["work item", authoritative.workItemId, workItem.work_item_id],
    ["attempt", authoritative.executionAttemptId, evidence.executionAttemptId],
    ["repository target", authoritative.repoTargetId, workItem.repo_target_id],
    ["resource revision", authoritative.resourceRevision, workItem.resource_revision],
    ["thread", authoritative.threadId, evidence.threadId],
    ["reason", authoritative.reason, evidence.reason],
    ["native event", authoritative.nativeEventId, evidence.nativeEventId],
    ["native sequence", authoritative.nativeEventSeq, evidence.nativeEventSeq],
    ["native turn", authoritative.nativeTurnId, evidence.nativeTurnId],
    ["evidence digest", authoritative.evidenceDigest, evidence.evidenceDigest],
  ];
  const authoritativeMismatch = authoritativeExact.find(([, actual, expected]) => !sameNullable(actual, expected));
  if (authoritativeMismatch || expectedEvidenceDigest !== evidence.evidenceDigest) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", `interruption authoritative ${authoritativeMismatch?.[0] ?? "digest"} evidence does not match`);
  }
  if (attempt.interruption_event_id !== null && attempt.interruption_event_id !== evidence.nativeEventId) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", "attempt already has different interruption evidence");
  }
  const correction = request.historicalCorrection;
  const historical = correction !== undefined;
  if (historical) {
    if (attempt.state !== "done" || correction.priorState !== "done" || attempt.terminal_report_digest !== null || attempt.reported_outcome !== null) {
      throw refusal("TERMINAL_REPORT_AMBIGUOUS", "historical correction requires an unreported false done attempt");
    }
    const expectedCorrectionDigest = sha256(canonicalJson({
      projectId: authoritative.projectId,
      workItemId: authoritative.workItemId,
      executionAttemptId: authoritative.executionAttemptId,
      threadId: authoritative.threadId,
      reason: authoritative.reason,
      evidence: authoritative.evidence,
    }));
    if (authoritative.correctionEvidenceDigest !== correction.evidenceDigest || expectedCorrectionDigest !== correction.evidenceDigest) {
      throw refusal("TERMINAL_REPORT_AMBIGUOUS", "historical correction authoritative correction digest does not match");
    }
    if (!authoritative.zeroRealWriter) throw refusal("WORK_ITEM_STATE_INVALID", "historical correction requires a proven zero-real-writer window");
    if (correction.evidence.some((item, index) => index > 0 && correction.evidence[index - 1]!.eventSeq >= item.eventSeq)) {
      throw refusal("TERMINAL_REPORT_AMBIGUOUS", "historical correction evidence must be strictly ordered by native event sequence");
    }
    if (authoritative.evidence.length !== correction.evidence.length
      || correction.evidence.some((item, index) => item.eventId !== authoritative.evidence[index]?.eventId || item.eventSeq !== authoritative.evidence[index]?.eventSeq)
      || authoritative.evidence[0]?.eventId !== evidence.nativeEventId
      || authoritative.evidence[0]?.eventSeq !== evidence.nativeEventSeq
      || authoritative.evidence[0]?.threadId !== evidence.threadId
      || authoritative.evidence[0]?.reason !== evidence.reason
      || authoritative.evidence.some((item, index) => index > 0 && item.eventSeq <= authoritative.evidence[index - 1]!.eventSeq)) {
      throw refusal("TERMINAL_REPORT_AMBIGUOUS", "historical correction evidence is not the exact ordered native interruption correlation");
    }
  } else if (!WORK_ITEM_CAPACITY_ATTEMPT_STATES.includes(attempt.state as typeof WORK_ITEM_CAPACITY_ATTEMPT_STATES[number])) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", `attempt is not interruptible from state ${attempt.state}`);
  }
  if (!historical && !(WORK_ITEM_NON_TERMINAL_STATES as readonly string[]).includes(workItem.lifecycle_state)) {
    throw refusal("WORK_ITEM_STATE_INVALID", "interruption evidence cannot create debt for a terminal work item");
  }
  const completedAtMs = now();
  db.prepare(
    `UPDATE execution_attempts
     SET state = 'interrupted', terminalization_class = 'native-interruption',
         interruption_reason = ?, interruption_event_id = ?, interruption_event_seq = ?,
         interruption_turn_id = ?, interruption_evidence_digest = ?, terminal_event_id = ?,
         terminal_event_seq = ?, observed_at_ms = ?, completed_at_ms = ?,
         lease_owner_thread_id = NULL, progress_json = '{}', reason_code = ?
     WHERE project_id = ? AND execution_attempt_id = ?`,
  ).run(
    evidence.reason,
    evidence.nativeEventId,
    evidence.nativeEventSeq,
    evidence.nativeTurnId,
    evidence.evidenceDigest,
    evidence.nativeEventId,
    evidence.nativeEventSeq,
    completedAtMs,
    completedAtMs,
    historical ? `historical-correction:${correction!.correctionId}` : `interrupted:${evidence.reason}`,
    request.projectId,
    evidence.executionAttemptId,
  );
  return commitMutation(
    db,
    request,
    digest,
    actorReceiptId,
    {
      aggregateType: "execution_attempt",
      aggregateId: evidence.executionAttemptId,
      aggregateRevision: nextAggregateRevision(db, request.projectId, "execution_attempt", evidence.executionAttemptId),
      eventType: historical ? "execution_attempt_historical_interruption_correction" : "execution_attempt_interrupted",
      event: {
        projectId: request.projectId,
        workItemId: evidence.workItemId,
        executionAttemptId: evidence.executionAttemptId,
        reason: evidence.reason,
        nativeEventType: evidence.nativeEventType,
        nativeEventId: evidence.nativeEventId,
        nativeEventSeq: evidence.nativeEventSeq,
        nativeTurnId: evidence.nativeTurnId,
        evidenceDigest: evidence.evidenceDigest,
        ...(historical ? { historicalCorrection: { ...correction!, evidence: authoritative.evidence } } : {}),
      },
    },
    { expected: 1, attempted: 1, verified: 1 },
    { currentConfigRevision: configRevision, currentGovernanceEpoch: governor.governance_epoch, evidence: { executionAttemptId: evidence.executionAttemptId, workItemId: evidence.workItemId, state: "interrupted", historicalCorrection: historical } },
  );
}

export interface WorkItemReconciliationIssue {
  kind: "authoring_attempt_count" | "review_attempt_count" | "terminal_attempt" | "duplicate_writer_lane";
  workItemId?: string;
  laneId?: string;
  lifecycleState?: WorkItemState;
  count: number;
}

export function workItemReconciliationIssues(db: SqliteDatabase, projectId: string): WorkItemReconciliationIssue[] {
  const issues: WorkItemReconciliationIssue[] = [];
  const rows = db.prepare(
    `SELECT work_items.work_item_id, work_items.lifecycle_state,
       SUM(CASE WHEN execution_attempts.origin = 'work_item'
          AND execution_attempts.assignment_kind = 'write'
          AND execution_attempts.state IN (${WORK_ITEM_CAPACITY_ATTEMPT_STATES.map(() => "?").join(", ")}) THEN 1 ELSE 0 END) AS writer_count,
       SUM(CASE WHEN execution_attempts.origin = 'work_item'
          AND execution_attempts.assignment_kind = 'review'
          AND execution_attempts.state IN (${WORK_ITEM_CAPACITY_ATTEMPT_STATES.map(() => "?").join(", ")}) THEN 1 ELSE 0 END) AS review_count
     FROM work_items
     LEFT JOIN execution_attempts ON execution_attempts.project_id = work_items.project_id
       AND execution_attempts.work_item_id = work_items.work_item_id
     WHERE work_items.project_id = ?
     GROUP BY work_items.work_item_id, work_items.lifecycle_state
     ORDER BY work_items.work_item_id`,
  ).all(...WORK_ITEM_CAPACITY_ATTEMPT_STATES, ...WORK_ITEM_CAPACITY_ATTEMPT_STATES, projectId) as Array<{
    work_item_id: string;
    lifecycle_state: WorkItemState;
    writer_count: number;
    review_count: number;
  }>;
  for (const row of rows) {
    const writerCount = Number(row.writer_count);
    const reviewCount = Number(row.review_count);
    const nonTerminal = WORK_ITEM_NON_TERMINAL_STATES.includes(row.lifecycle_state as (typeof WORK_ITEM_NON_TERMINAL_STATES)[number]);
    if (!nonTerminal && (writerCount !== 0 || reviewCount !== 0)) {
      issues.push({ kind: "terminal_attempt", workItemId: row.work_item_id, lifecycleState: row.lifecycle_state, count: writerCount + reviewCount });
      continue;
    }
    const expectedWriterCount = WORK_ITEM_CAPACITY_LIFECYCLE_STATES.includes(row.lifecycle_state as (typeof WORK_ITEM_CAPACITY_LIFECYCLE_STATES)[number]) ? 1 : 0;
    if (writerCount !== expectedWriterCount) {
      issues.push({ kind: "authoring_attempt_count", workItemId: row.work_item_id, lifecycleState: row.lifecycle_state, count: writerCount });
    }
    if (row.lifecycle_state === "review_pending" ? reviewCount > 1 : reviewCount !== 0) {
      issues.push({ kind: "review_attempt_count", workItemId: row.work_item_id, lifecycleState: row.lifecycle_state, count: reviewCount });
    }
  }
  for (const row of db.prepare(
    `SELECT lane_id, COUNT(*) AS count FROM execution_attempts
     WHERE project_id = ? AND origin = 'work_item' AND assignment_kind = 'write'
       AND state IN (${WORK_ITEM_CAPACITY_ATTEMPT_STATES.map(() => "?").join(", ")})
     GROUP BY lane_id HAVING COUNT(*) > 1 ORDER BY lane_id`,
  ).all(projectId, ...WORK_ITEM_CAPACITY_ATTEMPT_STATES) as Array<{ lane_id: string; count: number }>) {
    issues.push({ kind: "duplicate_writer_lane", laneId: row.lane_id, count: Number(row.count) });
  }
  return issues;
}

interface WorkItemWaitRow {
  project_id: string;
  work_item_id: string;
  waker: string;
  waker_kind: "schedule" | "seat" | "work_item_succeeded" | "github_issue_closed" | "github_pr";
  declared_at_ms: number;
  declared_by_seat: string;
  note: string | null;
  domain_id: string;
  pr_owner: string | null;
  pr_repo: string | null;
  pr_number: number | null;
  pr_condition_kind: GithubPrWait["kind"] | null;
  pr_expected_state: string | null;
  pr_expected_head_sha: string | null;
  pr_execution_attempt_id: string | null;
  pr_waiting_thread_id: string | null;
  pr_waiting_role_id: string | null;
  pr_waiting_role_generation: number | null;
  pr_waker_schedule: string | null;
  pr_deadline_at_ms: number | null;
  pr_initial_semantic_digest: string | null;
  pr_last_observed_semantic_digest: string | null;
  pr_delivery_state: "pending" | "fired" | "expired" | "cancelled" | "delivery_ambiguous";
}

type WorkItemBlocker = NonNullable<ApplyRequest["workItemUnblock"]>;

function workItemBlockerWaker(blocker: WorkItemBlocker): string {
  return blocker.kind === "work_item_succeeded"
    ? blocker.workItemId
    : blocker.kind === "github_issue_closed"
      ? `${blocker.owner}/${blocker.repo}#${blocker.issueNumber}`
      : `${blocker.owner}/${blocker.repo}#${blocker.prNumber}`;
}

function storedWorkItemBlocker(row: WorkItemWaitRow): WorkItemBlocker | null {
  if (row.waker_kind === "work_item_succeeded") {
    return { kind: "work_item_succeeded", workItemId: row.waker };
  }
  if (row.waker_kind === "github_pr") {
    if (!row.pr_owner || !row.pr_repo || !row.pr_number || !row.pr_condition_kind || !row.pr_expected_state || !row.pr_execution_attempt_id || !row.pr_waiting_thread_id || !row.pr_waiting_role_id || !row.pr_waiting_role_generation || !row.pr_waker_schedule || !row.pr_deadline_at_ms) return null;
    return {
      kind: row.pr_condition_kind,
      owner: row.pr_owner,
      repo: row.pr_repo,
      prNumber: row.pr_number,
      expectedState: row.pr_expected_state as GithubPrWait["expectedState"],
      ...(row.pr_expected_head_sha === null ? {} : { expectedHeadSha: row.pr_expected_head_sha }),
    } as WorkItemBlocker;
  }
  if (row.waker_kind !== "github_issue_closed") return null;
  const match = row.waker.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/u);
  const issueNumber = match?.[3] === undefined ? NaN : Number(match[3]);
  return match?.[1] && match[2] && Number.isSafeInteger(issueNumber)
    ? { kind: "github_issue_closed", owner: match[1], repo: match[2], issueNumber }
    : null;
}

function sameWorkItemBlocker(left: WorkItemBlocker, right: WorkItemBlocker): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function workItemGithubReadTarget(request: ApplyRequest): Array<{ owner: string; repo: string; issueNumber: number }> {
  const targets = [
    request.workItemWait,
    request.workItemUnblock,
    request.workItemExternalEvent,
    request.satisfactionEvidence?.kind === "github_issue_closed" ? request.satisfactionEvidence : undefined,
  ]
    .flatMap((value) => value && (value.kind === "github_issue_closed" || value.kind === "github_issue_reopened")
      ? [{ owner: value.owner, repo: value.repo, issueNumber: value.issueNumber }]
      : []);
  const swapping = request.lifecycleState === "blocked" && request.workItemWait !== undefined && request.workItemUnblock !== undefined;
  if (targets.length > 1 && !swapping) throw refusal("WORK_ITEM_STATE_INVALID", "work item transition accepts one external condition");
  return targets;
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

function validGithubSnapshotStateReason(state: GitHubIssueSnapshot["state"], reason: GitHubIssueSnapshot["stateReason"]): boolean {
  return state === "open"
    ? reason === undefined || reason === "REOPENED"
    : reason === "COMPLETED" || reason === "NOT_PLANNED" || reason === "DUPLICATE";
}

const githubSnapshotSchema = z
  .object({
    owner: id,
    repo: id,
    issueNumber: z.number().int().positive(),
    title: z.string().max(4096),
    body: z.string().max(64 * 1024),
    state: z.enum(["open", "closed"]),
    stateReason: z.enum(["COMPLETED", "NOT_PLANNED", "DUPLICATE", "REOPENED"]).optional(),
    labels: z.array(id).max(256),
    externalRevision: id,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (!validGithubSnapshotStateReason(snapshot.state, snapshot.stateReason)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["stateReason"], message: "GitHub issue state and reason do not match" });
    }
  });

export function githubPrSemanticDigest(observation: GithubPrObservation): string {
  return sha256(canonicalJson({
    repositoryIdentity: observation.repositoryIdentity,
    pullRequestNumber: observation.pullRequestNumber,
    headSha: observation.headSha,
    merge: observation.merged ? "merged" : observation.state === "open" ? "open" : "closed_unmerged",
    checks: observation.checksSummary,
    review: observation.reviewDecision,
  }));
}

function githubPrConditionSatisfied(condition: GithubPrWait, observation: GithubPrObservation): boolean {
  if (condition.owner !== observation.repositoryIdentity.owner || condition.repo !== observation.repositoryIdentity.repo || condition.prNumber !== observation.pullRequestNumber) return false;
  if (condition.expectedHeadSha !== undefined && condition.expectedHeadSha !== observation.headSha) return false;
  const observedState = condition.kind === "pr_merged"
    ? (observation.merged ? "merged" : observation.state === "open" ? "open" : "closed_unmerged")
    : condition.kind === "pr_checks" ? observation.checksSummary : observation.reviewDecision;
  return observedState !== "unknown" && observedState === condition.expectedState;
}

function githubPrHeadChanged(condition: GithubPrWait, observation: GithubPrObservation): boolean {
  return condition.expectedHeadSha !== undefined && condition.expectedHeadSha !== observation.headSha;
}

function githubRemoteIdentity(remoteUrl: string | null): { owner: string; repo: string } | null {
  if (!remoteUrl) return null;
  const match = remoteUrl.match(/(?:github\.com[/:])([^/]+)\/([^/]+?)(?:\.git)?$/iu);
  return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : null;
}

function requireGithubPrTarget(
  db: SqliteDatabase,
  projectId: string,
  configRevision: number,
  repoTargetId: string,
  condition: GithubPrWait,
): void {
  const target = requireTarget(db, projectId, configRevision, repoTargetId);
  const identity = githubRemoteIdentity(typeof target.remote_url === "string" ? target.remote_url : null);
  if (!identity || identity.owner !== condition.owner || identity.repo !== condition.repo) {
    throw refusal("REPO_TARGET_FOREIGN", "GitHub PR wait does not match the exact configured repository target");
  }
}

function requireGithubPrObservation(
  condition: GithubPrWait,
  observation: GithubPrObservation | undefined,
  exactHead = true,
): GithubPrObservation {
  if (!observation) throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub PR observation is required");
  if (
    observation.repositoryIdentity.owner !== condition.owner ||
    observation.repositoryIdentity.repo !== condition.repo ||
    observation.pullRequestNumber !== condition.prNumber
  ) throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub PR observation does not match the exact wait identity");
  if (exactHead && condition.expectedHeadSha !== undefined && condition.expectedHeadSha !== observation.headSha) {
    throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub PR observation does not match the exact expected head SHA");
  }
  return observation;
}

function requireGithubPrWaitBinding(
  db: SqliteDatabase,
  request: ApplyRequest,
  workItem: WorkItemRow,
  configRevision: number,
  wait: GithubPrWaitRegistration,
): void {
  requireGithubPrTarget(db, request.projectId, configRevision, workItem.repo_target_id, wait);
  const attempt = asRow<{ execution_attempt_id: string; work_item_id: string; thread_id: string | null; role_id: string | null; role_generation: number | null; state: string }>(db.prepare(
    "SELECT execution_attempt_id, work_item_id, thread_id, role_id, role_generation, state FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ?",
  ).get(request.projectId, wait.executionAttemptId));
  if (!attempt || attempt.work_item_id !== workItem.work_item_id || attempt.state === "interrupted" || !WORK_ITEM_CAPACITY_ATTEMPT_STATES.includes(attempt.state as typeof WORK_ITEM_CAPACITY_ATTEMPT_STATES[number])) {
    throw refusal("EXECUTION_CONTEXT_FOREIGN", "GitHub PR wait does not bind to the exact live execution attempt");
  }
  if (attempt.thread_id !== wait.waitingThreadId) throw refusal("ROLE_CONTEXT_FOREIGN", "GitHub PR wait does not bind to the exact waiting thread");
  if (attempt.role_id !== wait.waitingRoleId || attempt.role_generation !== wait.waitingRoleGeneration) {
    throw refusal("ROLE_CONTEXT_FOREIGN", "GitHub PR wait does not bind to the exact waiting seat generation");
  }
  if (wait.deadlineAtMs <= now()) throw refusal("WORK_ITEM_STATE_INVALID", "GitHub PR wait deadline is already expired");
}

function storedConfigJson(db: SqliteDatabase, projectId: string, configRevision: number): string {
  const row = asRow<{ canonical_config_json: string }>(
    db.prepare("SELECT canonical_config_json FROM project_config_revisions WHERE project_id = ? AND config_revision = ?").get(projectId, configRevision),
  );
  if (!row) throw refusal("PROJECT_CONFIG_REQUIRED", "project config revision is unavailable");
  return row.canonical_config_json;
}

function requireWorkItemSatisfactionEvidence(db: SqliteDatabase, request: ApplyRequest): NonNullable<ApplyRequest["satisfactionEvidence"]> {
  const evidence = request.satisfactionEvidence;
  if (!evidence) throw refusal("WORK_ITEM_STATE_INVALID", "satisfied-by-another-route success requires satisfaction evidence");
  if (evidence.kind === "config_revision") {
    const revision = asRow<{ config_digest: string }>(db.prepare(
      "SELECT config_digest FROM project_config_revisions WHERE project_id = ? AND config_revision = ?",
    ).get(request.projectId, evidence.configRevision));
    if (!revision || revision.config_digest !== evidence.digest) {
      throw refusal("WORK_ITEM_STATE_INVALID", "satisfaction evidence does not match the exact config revision digest");
    }
  } else if (evidence.kind === "decision") {
    const decision = asRow<DecisionRow>(db.prepare(
      "SELECT * FROM decisions WHERE project_id = ? AND decision_id = ?",
    ).get(request.projectId, evidence.decisionId));
    if (!decision || !decision.decision_identity_digest || storedDecisionIdentityDigest(decision) !== decision.decision_identity_digest) {
      throw refusal("WORK_ITEM_STATE_INVALID", "satisfaction evidence does not name an exact project Decision");
    }
  } else {
    requireBoundGithubIssue(db, request.projectId, request.workItemId!, evidence);
  }
  return evidence;
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
  allowStaleConfig = false,
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
  if (row.config_revision !== configRevision && !allowStaleConfig) {
    throw refusal("PROJECT_CONFIG_STALE", "work item is bound to a stale config revision", {
      currentConfigRevision: configRevision,
      expectedConfigRevision: row.config_revision,
    });
  }
  if (!request.repoTargetId) throw refusal("REPO_TARGET_REQUIRED", "work item mutation requires its exact repository target");
  if (request.repoTargetId !== row.repo_target_id) throw refusal("REPO_TARGET_FOREIGN", "work item target does not match the exact repository target");
  if (request.domainId !== undefined && request.domainId !== row.domain_id) throw refusal("DOMAIN_FOREIGN", "work item is bound to another orchestration domain");
  if (request.taskClass !== undefined && request.taskClass !== row.task_class) throw refusal("DOMAIN_FOREIGN", "work item is bound to another task class");
  requireTarget(db, request.projectId, configRevision, request.repoTargetId, allowStaleConfig);
  if (expectedRevision !== row.resource_revision) {
    throw refusal("WORK_ITEM_REVISION_STALE", "work item resource revision is stale", {
      currentResourceRevision: row.resource_revision,
      expectedResourceRevision: expectedRevision ?? undefined,
    });
  }
  return row;
}

function dischargeTerminalWorkItemWait(db: SqliteDatabase, projectId: string, workItemId: string): void {
  db.prepare("DELETE FROM work_item_waits WHERE project_id = ? AND work_item_id = ?").run(projectId, workItemId);
}

function applyThreadlessPreparedClosure(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  nativeSeat: AuthenticatedNativeSeat | null,
): FoundationResult {
  const closure = request.threadlessPreparedClosure;
  if (!closure || request.lifecycleState !== "failed" || !request.executionAttemptId || request.workAttempt !== undefined || request.workItemWait !== undefined || request.workItemUnblock !== undefined || request.workItemExternalEvent !== undefined) {
    throw refusal("WORK_ITEM_STATE_INVALID", "thread-less prepared closure requires a failed lifecycle transition without a work attempt or wait");
  }
  const workItemConfigRevision = request.workItemId === undefined
    ? undefined
    : asRow<{ config_revision: number }>(db.prepare(
      "SELECT config_revision FROM work_items WHERE project_id = ? AND work_item_id = ?",
    ).get(request.projectId, request.workItemId))?.config_revision;
  const configRevision = requireConfig(db, request, workItemConfigRevision);
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  requireNativeSeatActorAgreement(requireRoleActorBinding(db, request, false), nativeSeat);
  const workItem = requireWorkItem(db, request, configRevision, undefined, true);
  if (workItem.lifecycle_state !== "in_progress") {
    throw refusal("WORK_ITEM_STATE_INVALID", "thread-less prepared closure requires an in-progress work item");
  }
  const attempt = requireAttemptForMutation(db, request, request.executionAttemptId);
  const dispatchIntent = parseWorkItemDispatchIntent(attempt.reason_code);
  const expectedDispatchMarker = dispatchIntent === null ? null : `[dispatch:${dispatchIntent.idempotencyKey}]`;
  if (
    attempt.work_item_id !== workItem.work_item_id ||
    attempt.repo_target_id !== workItem.repo_target_id ||
    attempt.config_revision !== workItem.config_revision ||
    attempt.assignment_kind !== "write" ||
    attempt.assignment_id !== null ||
    attempt.assignment_digest !== null ||
    attempt.dispatch_kind !== null ||
    attempt.state !== "prepared" ||
    attempt.thread_id !== null ||
    (expectedDispatchMarker !== null && closure.dispatchMarker !== expectedDispatchMarker)
  ) {
    throw refusal("WORK_ITEM_STATE_INVALID", "thread-less prepared closure does not match the exact prepared writing attempt");
  }
  const nativeEvidence: Array<keyof ExecutionAttemptRow> = [
    "thread_id", "provider_thread_id", "native_request_id", "request_event_id", "request_event_seq",
    "accepted_event_id", "accepted_event_seq", "first_action_event_id", "first_action_event_seq",
    "content_event_id", "content_event_seq", "completion_event_id", "completion_event_seq",
    "content_receipt_digest", "native_receipt_digest", "last_event_seq", "terminal_event_id",
    "terminal_event_seq", "terminal_result", "reported_outcome", "terminal_report_digest",
    "terminalization_class", "terminal_report_json", "terminal_actual_profile_digest",
    "interruption_reason", "interruption_event_id", "interruption_event_seq", "interruption_turn_id",
    "interruption_evidence_digest", "conflicting_terminal_digest", "completed_at_ms",
    "lease_owner_thread_id", "lease_expires_at_ms",
  ];
  if (nativeEvidence.some((column) => attempt[column] !== null)) {
    throw refusal("WORK_ITEM_STATE_INVALID", "thread-less prepared closure requires zero native request, content, and terminal evidence");
  }
  const [preparation, dispatchGuardProof, replayConflict, terminalizationGuardProof, zeroThread] = closure.evidence;
  if (preparation.reference !== `state-event:${preparation.eventSequence}`) {
    throw refusal("WORK_ITEM_STATE_INVALID", "thread-less closure preparation evidence reference is not exact");
  }
  if (!closure.dispatchMarker.startsWith("[dispatch:") || !closure.dispatchMarker.endsWith("]")) {
    throw refusal("WORK_ITEM_STATE_INVALID", "thread-less closure dispatch marker is malformed");
  }
  const preparationEvent = resolveThreadlessPreparedOrigin(db, {
    projectId: request.projectId,
    workItemId: workItem.work_item_id,
    executionAttemptId: attempt.execution_attempt_id,
    idempotencyKey: closure.dispatchMarker.slice("[dispatch:".length, -1),
  });
  if (preparationEvent.eventSequence !== preparation.eventSequence || sha256(preparationEvent.eventJson) !== preparation.digest) {
    throw refusal("WORK_ITEM_STATE_INVALID", "thread-less closure preparation evidence is not the exact durable registration event");
  }
  if (
    dispatchGuardProof.kind !== "dispatch_guard_proof" ||
    dispatchGuardProof.reference !== `mutation:${preparationEvent.idempotencyKey}` ||
    closure.dispatchMarker !== `[dispatch:${preparationEvent.idempotencyKey}]`
  ) {
    throw refusal("WORK_ITEM_STATE_INVALID", "thread-less closure dispatch-guard evidence is not the exact durable intent receipt");
  }
  const replayRequestDigest = threadlessPreparedReplayProbeDigest({
    projectId: request.projectId,
    workItemId: workItem.work_item_id,
    executionAttemptId: attempt.execution_attempt_id,
    idempotencyKey: preparationEvent.idempotencyKey,
  });
  const replayProbe = {
    projectId: request.projectId,
    operationClass: "work_item_transition" as const,
    idempotencyKey: preparationEvent.idempotencyKey,
  } as ApplyRequest;
  let replayConflictObserved = false;
  try {
    if (checkIdempotency(db, replayProbe, replayRequestDigest) !== null) {
      throw refusal("WORK_ITEM_STATE_INVALID", "thread-less closure replay probe did not conflict");
    }
  } catch (error) {
    if (!isRefusal(error)) throw refusal("CANONICAL_STORE_UNAVAILABLE", "thread-less closure replay probe could not read the durable idempotency receipt");
    if (error.data.code !== "IDEMPOTENCY_KEY_CONFLICT") throw error;
    replayConflictObserved = true;
  }
  if (!replayConflictObserved) {
    throw refusal("WORK_ITEM_STATE_INVALID", "thread-less closure replay probe did not conflict");
  }
  const expectedDispatchGuardProof = sha256(canonicalJson({
    kind: "dispatch_guard_proof",
    projectId: request.projectId,
    workItemId: workItem.work_item_id,
    executionAttemptId: attempt.execution_attempt_id,
    idempotencyKey: preparationEvent.idempotencyKey,
    reasonCode: attempt.reason_code,
  }));
  if (dispatchGuardProof.digest !== expectedDispatchGuardProof) {
    throw refusal("WORK_ITEM_STATE_INVALID", "thread-less closure dispatch-guard evidence is not exact");
  }
  if (
    replayConflict.reference !== `replay:${preparationEvent.idempotencyKey}` ||
    replayConflict.requestDigest !== replayRequestDigest ||
    replayConflict.digest !== sha256(canonicalJson({
      kind: "replay_conflict",
      projectId: request.projectId,
      workItemId: workItem.work_item_id,
      executionAttemptId: attempt.execution_attempt_id,
      idempotencyKey: preparationEvent.idempotencyKey,
      requestDigest: replayConflict.requestDigest,
    }))
  ) {
    throw refusal("WORK_ITEM_STATE_INVALID", "thread-less closure replay-conflict evidence is not exact");
  }
  if (
    terminalizationGuardProof.kind !== "terminalization_guard_proof" ||
    terminalizationGuardProof.reference !== "terminalization-guard" ||
    terminalizationGuardProof.digest !== sha256(canonicalJson({
      kind: "terminalization_guard_proof",
      projectId: request.projectId,
      workItemId: workItem.work_item_id,
      executionAttemptId: attempt.execution_attempt_id,
      message: "writing attempt terminalization requires a bound lane with native stop evidence",
    }))
  ) {
    throw refusal("WORK_ITEM_STATE_INVALID", "thread-less closure terminalization-guard evidence is not exact");
  }
  if (
    zeroThread.reference !== "native-thread-inventory" ||
    zeroThread.matchingCount !== 0 ||
    zeroThread.observationCount !== 2 ||
    zeroThread.observationBound !== THREADLESS_PREPARED_INVENTORY_OBSERVATION_BOUND ||
    zeroThread.snapshotDigest === undefined ||
    canonicalJson(zeroThread.population) !== canonicalJson(threadlessPreparedClosurePopulation(request.projectId)) ||
    zeroThread.digest !== threadlessPreparedInventoryEvidenceDigest({
      projectId: request.projectId,
      executionAttemptId: attempt.execution_attempt_id,
      dispatchMarker: closure.dispatchMarker,
      population: zeroThread.population,
      activeCount: zeroThread.activeCount,
      archivedCount: zeroThread.archivedCount,
      matchingCount: zeroThread.matchingCount,
      observationCount: zeroThread.observationCount,
      observationBound: zeroThread.observationBound,
      snapshotDigest: zeroThread.snapshotDigest,
    })
  ) {
    throw refusal("WORK_ITEM_STATE_INVALID", "thread-less closure requires complete zero-thread inventory evidence");
  }
  const nextRevision = workItem.resource_revision + 1;
  const completedAtMs = now();
  const attemptUpdated = db.prepare(
    `UPDATE execution_attempts
     SET state = 'failed', observed_at_ms = ?, completed_at_ms = ?, lease_owner_thread_id = NULL,
         progress_json = '{}', terminalization_class = 'threadless-prepared-closure',
         reason_code = ?
     WHERE project_id = ? AND execution_attempt_id = ? AND state = 'prepared' AND thread_id IS NULL AND assignment_id IS NULL`,
  ).run(completedAtMs, completedAtMs, `threadless-prepared-closure:${closure.correctionId}`, request.projectId, attempt.execution_attempt_id);
  if (attemptUpdated.changes !== 1) throw refusal("WORK_ITEM_STATE_INVALID", "thread-less prepared attempt changed before closure");
  const workItemUpdated = db.prepare(
    `UPDATE work_items SET lifecycle_state = 'failed', resource_revision = ?, updated_at_ms = ?
     WHERE project_id = ? AND work_item_id = ? AND lifecycle_state = 'in_progress' AND resource_revision = ?`,
  ).run(nextRevision, completedAtMs, request.projectId, workItem.work_item_id, workItem.resource_revision);
  if (workItemUpdated.changes !== 1) throw refusal("WORK_ITEM_REVISION_STALE", "work item compare-and-swap failed during thread-less closure", {
    currentResourceRevision: workItem.resource_revision,
    expectedResourceRevision: request.expectedResourceRevision ?? undefined,
  });
  dischargeTerminalWorkItemWait(db, request.projectId, workItem.work_item_id);
  const evidence = closure.evidence;
  return commitMutation(
    db,
    request,
    digest,
    actorReceiptId,
    {
      aggregateType: "work_item",
      aggregateId: workItem.work_item_id,
      aggregateRevision: nextRevision,
      eventType: "work_item_threadless_prepared_closure",
      event: {
        workItemId: workItem.work_item_id,
        executionAttemptId: attempt.execution_attempt_id,
        from: "in_progress",
        to: "failed",
        correction: { ...closure, evidence },
      },
    },
    { expected: 1, attempted: 1, verified: 1 },
    {
      currentConfigRevision: configRevision,
      currentGovernanceEpoch: governor.governance_epoch,
      currentResourceRevision: nextRevision,
      expectedResourceRevision: request.expectedResourceRevision ?? undefined,
      evidence: { workItemId: workItem.work_item_id, executionAttemptId: attempt.execution_attempt_id, correction: closure },
    },
  );
}

function applyStrandedExecutionAttemptClosure(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  nativeSeat: AuthenticatedNativeSeat | null,
): FoundationResult {
  const closure = request.strandedExecutionAttemptClosure;
  if (!closure || request.lifecycleState !== "failed" || !request.executionAttemptId || request.workAttempt !== undefined || request.workItemWait !== undefined || request.workItemUnblock !== undefined || request.workItemExternalEvent !== undefined) {
    throw refusal("WORK_ITEM_STATE_INVALID", "stranded execution closure requires a failed lifecycle transition without a work attempt or wait");
  }
  const workItemConfigRevision = request.workItemId === undefined
    ? undefined
    : asRow<{ config_revision: number }>(db.prepare(
      "SELECT config_revision FROM work_items WHERE project_id = ? AND work_item_id = ?",
    ).get(request.projectId, request.workItemId))?.config_revision;
  const configRevision = requireConfig(db, request, workItemConfigRevision);
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  requireNativeSeatActorAgreement(requireRoleActorBinding(db, request, false), nativeSeat);
  const workItem = requireWorkItem(db, request, configRevision, undefined, true);
  if (workItem.lifecycle_state !== "in_progress") {
    throw refusal("WORK_ITEM_STATE_INVALID", "stranded execution closure requires an in-progress work item");
  }
  const attempt = requireAttemptForMutation(db, request, request.executionAttemptId);
  const evidence = closure.evidence;
  if (
    attempt.work_item_id !== workItem.work_item_id ||
    attempt.repo_target_id !== workItem.repo_target_id ||
    attempt.origin !== "work_item" ||
    attempt.assignment_kind !== "write" ||
    !WORK_ITEM_CAPACITY_ATTEMPT_STATES.includes(attempt.state as typeof WORK_ITEM_CAPACITY_ATTEMPT_STATES[number]) ||
    attempt.thread_id === null ||
    evidence.projectId !== request.projectId ||
    evidence.workItemId !== workItem.work_item_id ||
    evidence.executionAttemptId !== attempt.execution_attempt_id ||
    evidence.threadId !== attempt.thread_id
  ) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", "stranded execution closure does not match the exact active writing attempt");
  }
  const terminalFields: Array<keyof ExecutionAttemptRow> = [
    "terminal_result", "reported_outcome", "terminal_report_digest", "terminal_report_json",
    "terminal_actual_profile_digest", "terminal_event_id", "terminal_event_seq", "completed_at_ms",
  ];
  if (terminalFields.some((field) => attempt[field] !== null)) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", "stranded execution closure requires an unterminalized writing attempt");
  }
  const expectedEvidenceDigest = sha256(canonicalJson({
    kind: evidence.kind,
    projectId: evidence.projectId,
    workItemId: evidence.workItemId,
    executionAttemptId: evidence.executionAttemptId,
    threadId: evidence.threadId,
    nativeEventId: evidence.nativeEventId,
    nativeEventSeq: evidence.nativeEventSeq,
    nativeTurnId: evidence.nativeTurnId,
    incapacity: evidence.incapacity,
  }));
  if (evidence.digest !== expectedEvidenceDigest) {
    throw refusal("TERMINAL_REPORT_AMBIGUOUS", "stranded execution closure evidence digest is not exact");
  }
  const nextRevision = workItem.resource_revision + 1;
  const completedAtMs = now();
  const attemptUpdated = db.prepare(
    `UPDATE execution_attempts
     SET state = 'failed', terminal_result = 'BLOCKED', reported_outcome = 'BLOCKED',
         terminal_event_id = ?, terminal_event_seq = ?, observed_at_ms = ?, completed_at_ms = ?,
         lease_owner_thread_id = NULL, progress_json = '{}',
         terminalization_class = 'stranded-execution-closure', reason_code = ?
     WHERE project_id = ? AND execution_attempt_id = ? AND state IN (${WORK_ITEM_CAPACITY_ATTEMPT_STATES.map(() => "?").join(", ")})
       AND terminal_event_id IS NULL AND terminal_event_seq IS NULL AND terminal_report_digest IS NULL`,
  ).run(
    evidence.nativeEventId,
    evidence.nativeEventSeq,
    completedAtMs,
    completedAtMs,
    `stranded-execution-closure:${closure.correctionId}`,
    request.projectId,
    attempt.execution_attempt_id,
    ...WORK_ITEM_CAPACITY_ATTEMPT_STATES,
  );
  if (attemptUpdated.changes !== 1) throw refusal("WORK_ITEM_STATE_INVALID", "stranded execution attempt changed before closure");
  const workItemUpdated = db.prepare(
    `UPDATE work_items SET lifecycle_state = 'failed', resource_revision = ?, updated_at_ms = ?
     WHERE project_id = ? AND work_item_id = ? AND lifecycle_state = 'in_progress' AND resource_revision = ?`,
  ).run(nextRevision, completedAtMs, request.projectId, workItem.work_item_id, workItem.resource_revision);
  if (workItemUpdated.changes !== 1) throw refusal("WORK_ITEM_REVISION_STALE", "work item compare-and-swap failed during stranded execution closure", {
    currentResourceRevision: workItem.resource_revision,
    expectedResourceRevision: request.expectedResourceRevision ?? undefined,
  });
  dischargeTerminalWorkItemWait(db, request.projectId, workItem.work_item_id);
  return commitMutation(
    db,
    request,
    digest,
    actorReceiptId,
    {
      aggregateType: "work_item",
      aggregateId: workItem.work_item_id,
      aggregateRevision: nextRevision,
      eventType: "work_item_stranded_execution_attempt_closure",
      event: {
        workItemId: workItem.work_item_id,
        executionAttemptId: attempt.execution_attempt_id,
        from: "in_progress",
        to: "failed",
        correction: { ...closure, evidence },
      },
    },
    { expected: 1, attempted: 1, verified: 1 },
    {
      currentConfigRevision: configRevision,
      currentGovernanceEpoch: governor.governance_epoch,
      currentResourceRevision: nextRevision,
      expectedResourceRevision: request.expectedResourceRevision ?? undefined,
      evidence: { workItemId: workItem.work_item_id, executionAttemptId: attempt.execution_attempt_id, correction: closure },
    },
  );
}

function applyWorkItemCreate(db: SqliteDatabase, request: ApplyRequest, digest: string): FoundationResult {
  const configRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  if (!request.workItem) throw refusal("INVALID_INPUT", "work item create requires workItem");
  if (request.workItemWait !== undefined) throw refusal("WORK_ITEM_STATE_INVALID", "work item wait requires a work item transition");
  if (!request.repoTargetId) throw refusal("REPO_TARGET_REQUIRED", "work item create requires an exact repository target");
  requireTarget(db, request.projectId, configRevision, request.repoTargetId);
  const configured = configuredDomains(db, request.projectId, configRevision);
  const taskClass = request.taskClass ?? request.workItem.taskClass ?? (configured.length === 1 && configured[0]!.domainId === "default" ? "default" : undefined);
  if (!taskClass) throw refusal("DOMAIN_REQUIRED", "multi-domain work item creation requires an exact task class");
  const domain = domainForTaskClass(configured, taskClass, request.domainId ?? request.workItem.domainId);
  if (request.workItemId && request.workItemId !== request.workItem.workItemId) {
    throw refusal("WORK_ITEM_STATE_INVALID", "work item identities conflict");
  }
  if (request.expectedResourceRevision !== null) throw refusal("WORK_ITEM_REVISION_STALE", "work item create requires no existing resource revision");
  if (db.prepare("SELECT 1 FROM work_items WHERE project_id = ? AND work_item_id = ?").get(request.projectId, request.workItem.workItemId)) {
    throw refusal("WORK_ITEM_STATE_INVALID", "work item already exists");
  }
  const githubIssue = request.workItem.githubIssue;
  const githubBinding = githubIssue === undefined
    ? null
    : requireGithubMapping(db, request.projectId, configRevision, request.repoTargetId);
  const createdAtMs = now();
  db.prepare(
    `INSERT INTO work_items
      (project_id, work_item_id, config_revision, repo_target_id, domain_id, task_class, title, body,
       lifecycle_state, resource_revision, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 1, ?, ?)`,
  ).run(
    request.projectId,
    request.workItem.workItemId,
    configRevision,
    request.repoTargetId,
    domain.domainId,
    taskClass,
    request.workItem.title,
    request.workItem.body,
    createdAtMs,
    createdAtMs,
  );
  const workItem = {
    project_id: request.projectId,
    work_item_id: request.workItem.workItemId,
    config_revision: configRevision,
    repo_target_id: request.repoTargetId,
    domain_id: domain.domainId,
    task_class: taskClass,
    title: request.workItem.title,
    body: request.workItem.body,
    lifecycle_state: "proposed" as const,
    resource_revision: 1,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
  } satisfies WorkItemRow;
  const boundGithubIssue = githubIssue === undefined || githubBinding === null
    ? null
    : bindExistingGithubIssue(db, {
      projectId: request.projectId,
      workItem,
      github: githubBinding.github,
      mapping: githubBinding.mapping,
      issueNumber: githubIssue.issueNumber,
      idempotencyKey: request.idempotencyKey,
      requestDigest: digest,
    });
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
      event: {
        workItemId: request.workItem.workItemId,
        repoTargetId: request.repoTargetId,
        domainId: domain.domainId,
        taskClass,
        lifecycleState: "proposed",
        ...(boundGithubIssue === null ? {} : {
          githubIssue: {
            owner: boundGithubIssue.owner,
            repo: boundGithubIssue.repo,
            issueNumber: boundGithubIssue.issue_number,
            projectionState: boundGithubIssue.projection_state,
          },
        }),
      },
    },
    { expected: 1, attempted: 1, verified: 1 },
    {
      currentConfigRevision: configRevision,
      currentGovernanceEpoch: governor.governance_epoch,
      currentResourceRevision: 1,
      evidence: {
        workItemId: request.workItem.workItemId,
        repoTargetId: request.repoTargetId,
        domainId: domain.domainId,
        taskClass,
        lifecycleState: "proposed",
        ...(boundGithubIssue === null ? {} : {
          githubIssue: {
            owner: boundGithubIssue.owner,
            repo: boundGithubIssue.repo,
            issueNumber: boundGithubIssue.issue_number,
            projectionState: boundGithubIssue.projection_state,
          },
        }),
      },
    },
  );
}

const WORK_ITEM_TRANSITIONS: Readonly<Record<WorkItemState, readonly WorkItemState[]>> = {
  proposed: ["ready", "cancelled"],
  ready: ["in_progress", "blocked", "succeeded", "cancelled"],
  in_progress: ["review_pending", "blocked", "failed", "cancelled"],
  review_pending: ["in_progress", "blocked", "succeeded", "failed", "cancelled"],
  blocked: ["ready", "succeeded", "cancelled"],
  succeeded: ["ready"],
  failed: [],
  cancelled: [],
};

function requireBoundGithubIssue(
  db: SqliteDatabase,
  projectId: string,
  workItemId: string,
  target: { owner: string; repo: string; issueNumber: number },
): ExternalWorkRefRow {
  const ref = externalRef(db, projectId, workItemId);
  if (!ref || ref.issue_number === null) throw refusal("EXTERNAL_REF_REQUIRED", "work item has no exact GitHub issue binding");
  if (ref.owner !== target.owner || ref.repo !== target.repo || ref.issue_number !== target.issueNumber) {
    throw refusal("EXTERNAL_REF_CONFLICT", "GitHub observation does not match the work item's exact external binding");
  }
  return ref;
}

function assertNoWorkItemBlockerCycle(
  db: SqliteDatabase,
  request: ApplyRequest,
  blocker: WorkItemBlocker,
): void {
  if (blocker.kind !== "work_item_succeeded") return;
  if (blocker.workItemId === request.workItemId) throw refusal("WORK_ITEM_STATE_INVALID", "work item cannot block on itself");
  const visited = new Set<string>([request.workItemId!]);
  let dependencyId = blocker.workItemId;
  while (true) {
    if (visited.has(dependencyId)) throw refusal("WORK_ITEM_STATE_INVALID", "work item blocker dependency is cyclic");
    visited.add(dependencyId);
    const dependency = asRow<{ lifecycle_state: WorkItemState }>(db.prepare(
      "SELECT lifecycle_state FROM work_items WHERE project_id = ? AND work_item_id = ?",
    ).get(request.projectId, dependencyId));
    if (!dependency) throw refusal("WORK_ITEM_UNKNOWN", "blocking work item does not exist in the exact project");
    const next = asRow<{ waker: string; waker_kind: string }>(db.prepare(
      "SELECT waker, waker_kind FROM work_item_waits WHERE project_id = ? AND work_item_id = ?",
    ).get(request.projectId, dependencyId));
    if (!next || next.waker_kind !== "work_item_succeeded") return;
    dependencyId = next.waker;
  }
}

function blockerConditionSatisfied(
  db: SqliteDatabase,
  request: ApplyRequest,
  blocker: WorkItemBlocker,
  githubObservation: GitHubIssueSnapshot | null,
  githubPrObservation: GithubPrObservation | undefined = undefined,
): boolean {
  if (blocker.kind === "work_item_succeeded") {
    assertNoWorkItemBlockerCycle(db, request, blocker);
    const dependency = asRow<{ lifecycle_state: WorkItemState }>(db.prepare(
      "SELECT lifecycle_state FROM work_items WHERE project_id = ? AND work_item_id = ?",
    ).get(request.projectId, blocker.workItemId));
    if (!dependency) throw refusal("WORK_ITEM_UNKNOWN", "blocking work item does not exist in the exact project");
    if (["failed", "cancelled"].includes(dependency.lifecycle_state)) {
      throw refusal("WORK_ITEM_STATE_INVALID", "work item cannot block on a terminal dependency that did not succeed");
    }
    return dependency.lifecycle_state === "succeeded";
  }
  if (blocker.kind !== "github_issue_closed") return githubPrConditionSatisfied(blocker, requireGithubPrObservation(blocker, githubPrObservation));
  if (!githubObservation) throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub blocker observation is unavailable");
  if (
    githubObservation.owner !== blocker.owner ||
    githubObservation.repo !== blocker.repo ||
    githubObservation.issueNumber !== blocker.issueNumber
  ) throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub blocker observation does not match the exact stored blocker");
  return githubObservation.state === "closed";
}

function requireBlockerCondition(
  db: SqliteDatabase,
  request: ApplyRequest,
  blocker: WorkItemBlocker,
  githubObservation: GitHubIssueSnapshot | null,
  satisfied: boolean,
  githubPrObservation: GithubPrObservation | undefined = undefined,
): void {
  const conditionSatisfied = blockerConditionSatisfied(db, request, blocker, githubObservation, githubPrObservation);
  if (conditionSatisfied !== satisfied) {
    throw refusal("WORK_ITEM_STATE_INVALID", satisfied ? "work item blocker has not fired" : "work item blocker already fired");
  }
}

function recordedGithubCloseObservation(
  db: SqliteDatabase,
  projectId: string,
  workItemId: string,
  resourceRevision: number,
): { kind: "github_issue_closed"; owner: string; repo: string; issueNumber: number; externalRevision: string } | null {
  const row = asRow<{ event_json: string }>(db.prepare(
    `SELECT event_json FROM state_events
     WHERE project_id = ? AND aggregate_type = 'work_item' AND aggregate_id = ?
       AND aggregate_revision = ? AND event_type = 'work_item_transitioned'
     ORDER BY event_sequence DESC LIMIT 1`,
  ).get(projectId, workItemId, resourceRevision));
  if (!row) return null;
  let event: unknown;
  try {
    event = JSON.parse(row.event_json);
  } catch {
    throw refusal("WORK_ITEM_STATE_INVALID", "succeeded work item close observation is malformed");
  }
  const transition = z.object({
    to: z.literal("succeeded"),
    externalEvent: z.unknown().optional(),
  }).passthrough().safeParse(event);
  if (!transition.success) throw refusal("WORK_ITEM_STATE_INVALID", "succeeded work item has no exact recorded close observation");
  if (transition.data.externalEvent === undefined) return null;
  const parsed = z.object({
    to: z.literal("succeeded"),
    externalEvent: z.object({
      kind: z.literal("github_issue_closed"),
      owner: githubRefPartSchema,
      repo: githubRefPartSchema,
      issueNumber: z.number().int().positive().refine(Number.isSafeInteger),
      externalRevision: id,
    }).strict(),
  }).passthrough().safeParse(event);
  if (!parsed.success) throw refusal("WORK_ITEM_STATE_INVALID", "succeeded work item has no exact recorded close observation");
  return parsed.data.externalEvent;
}

function applyGithubPrObservation(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
): FoundationResult {
  const configRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  requireRoleActorBinding(db, request, false);
  if (!request.workItemId || !request.repoTargetId || !request.executionAttemptId) {
    throw refusal("INVALID_INPUT", "GitHub PR observation requires the exact work item, repository target, and execution attempt");
  }
  const currentWorkItem = asRow<{ resource_revision: number }>(db.prepare(
    "SELECT resource_revision FROM work_items WHERE project_id = ? AND work_item_id = ?",
  ).get(request.projectId, request.workItemId));
  if (!currentWorkItem) throw refusal("WORK_ITEM_UNKNOWN", "work item is not known in the exact project");
  const workItem = requireWorkItem(db, request, configRevision, request.expectedResourceRevision ?? currentWorkItem.resource_revision);
  const wait = asRow<WorkItemWaitRow>(db.prepare(
    "SELECT * FROM work_item_waits WHERE project_id = ? AND work_item_id = ?",
  ).get(request.projectId, workItem.work_item_id));
  if (!wait || wait.waker_kind !== "github_pr") throw refusal("WORK_ITEM_WAIT_OPEN", "work item has no open GitHub PR wait");
  const condition = storedWorkItemBlocker(wait);
  if (!condition || !isGithubPrWait(condition)) throw refusal("WORK_ITEM_STATE_INVALID", "stored GitHub PR wait is malformed");
  if (wait.pr_execution_attempt_id !== request.executionAttemptId) throw refusal("EXECUTION_CONTEXT_FOREIGN", "observation does not match the exact waiting execution attempt");
  requireGithubPrTarget(db, request.projectId, configRevision, workItem.repo_target_id, condition);
  if (request.githubPrDeliveryDisposition !== undefined) {
    const canRetainAmbiguousSend = request.githubPrDeliveryDisposition === "delivery_ambiguous" && wait.pr_delivery_state === "fired";
    if (wait.pr_delivery_state !== "pending" && !canRetainAmbiguousSend) {
      return result("OK", request.projectId, 1, 0, 0, { evidence: { status: wait.pr_delivery_state, wake: false } });
    }
    db.prepare(
      "UPDATE work_item_waits SET pr_delivery_state = ? WHERE project_id = ? AND work_item_id = ? AND waker_kind = 'github_pr' AND pr_delivery_state = ?",
    ).run(request.githubPrDeliveryDisposition, request.projectId, workItem.work_item_id, canRetainAmbiguousSend ? "fired" : "pending");
    const eventType = request.githubPrDeliveryDisposition === "cancelled"
      ? "github_pr_wait_cancelled"
      : "github_pr_wait_delivery_ambiguous";
    return commitMutation(
      db, request, digest, actorReceiptId,
      {
        aggregateType: "work_item",
        aggregateId: workItem.work_item_id,
        aggregateRevision: nextAggregateRevision(db, request.projectId, "work_item", workItem.work_item_id),
        eventType,
        event: { workItemId: workItem.work_item_id, condition, deliveryState: request.githubPrDeliveryDisposition },
      },
      { expected: 1, attempted: 1, verified: 1 },
      {
        currentConfigRevision: configRevision,
        currentGovernanceEpoch: governor.governance_epoch,
        evidence: { status: request.githubPrDeliveryDisposition, wake: false },
      },
    );
  }
  const observation = requireGithubPrObservation(condition, request.githubPrObservation, false);
  const observedAtMs = request.observedAtMs ?? now();
  if (wait.pr_delivery_state !== "pending") {
    return result("OK", request.projectId, 1, 0, 0, { evidence: { status: wait.pr_delivery_state, wake: false } });
  }
  if (wait.pr_deadline_at_ms !== null && observedAtMs >= wait.pr_deadline_at_ms) {
    db.prepare(
      "UPDATE work_item_waits SET pr_delivery_state = 'expired' WHERE project_id = ? AND work_item_id = ? AND waker_kind = 'github_pr' AND pr_delivery_state = 'pending'",
    ).run(request.projectId, workItem.work_item_id);
    return commitMutation(
      db, request, digest, actorReceiptId,
      {
        aggregateType: "work_item",
        aggregateId: workItem.work_item_id,
        aggregateRevision: nextAggregateRevision(db, request.projectId, "work_item", workItem.work_item_id),
        eventType: "github_pr_wait_expired",
        event: { workItemId: workItem.work_item_id, condition, observedAtMs, wakeKind: "github_pr_wait_expired" },
      },
      { expected: 1, attempted: 1, verified: 1 },
      { currentConfigRevision: configRevision, currentGovernanceEpoch: governor.governance_epoch, evidence: { status: "expired", wake: true } },
    );
  }
  const semanticDigest = githubPrSemanticDigest(observation);
  if (semanticDigest === wait.pr_last_observed_semantic_digest) {
    return result("OK", request.projectId, 1, 0, 0, { evidence: { status: "silent", semanticDigest, wake: false } });
  }
  const headChanged = githubPrHeadChanged(condition, observation);
  const satisfied = githubPrConditionSatisfied(condition, observation);
  const wakeKind = headChanged ? "github_pr_head_changed" : satisfied ? "github_pr_condition_satisfied" : null;
  db.prepare(
    `UPDATE work_item_waits SET pr_last_observed_semantic_digest = ?, pr_delivery_state = ?
     WHERE project_id = ? AND work_item_id = ? AND waker_kind = 'github_pr' AND pr_delivery_state = 'pending'`,
  ).run(semanticDigest, wakeKind === null ? "pending" : "fired", request.projectId, workItem.work_item_id);
  return commitMutation(
    db, request, digest, actorReceiptId,
    {
      aggregateType: "work_item",
      aggregateId: workItem.work_item_id,
      aggregateRevision: nextAggregateRevision(db, request.projectId, "work_item", workItem.work_item_id),
      eventType: "github_pr_observation_recorded",
      event: {
        workItemId: workItem.work_item_id,
        condition,
        observation,
        semanticDigest,
        previousSemanticDigest: wait.pr_last_observed_semantic_digest,
        wakeKind,
        observedAtMs,
      },
    },
    { expected: 1, attempted: 1, verified: 1 },
    {
      currentConfigRevision: configRevision,
      currentGovernanceEpoch: governor.governance_epoch,
      evidence: { status: wakeKind === null ? "observed" : "fired", wake: wakeKind !== null, wakeKind, semanticDigest },
    },
  );
}

type AuthenticatedNativeSeat = {
  roleId: "director" | "project-orchestrator";
  roleGeneration: number;
  domainId: string;
  threadId: string;
  holderExecutionAttemptId: string;
};

function requireNativeSeatActorAgreement(
  roleActor: { roleId: (typeof ROLE_IDS)[number]; roleGeneration: number } | null,
  nativeSeat: AuthenticatedNativeSeat | null,
): void {
  if (roleActor && nativeSeat && (roleActor.roleId !== nativeSeat.roleId || roleActor.roleGeneration !== nativeSeat.roleGeneration)) {
    throw refusal("ROLE_HOLDER_MISMATCH", "verified actor receipt and authenticated native caller disagree");
  }
}

function resolveAuthenticatedNativeSeat(
  db: SqliteDatabase,
  request: ApplyRequest,
  authenticatedNativeCaller: AuthenticatedNativeCaller | null,
): AuthenticatedNativeSeat | null {
  const committedDispatchIntent = request.reasonCode === "dispatch_intent_finalize" && request.lifecycleState === undefined && request.workAttempt?.threadId !== undefined;
  const requiresSeat = request.operationClass === "execution_attempt_terminal_report" ||
    (request.operationClass === "work_item_transition" && (request.workAttempt !== undefined || request.threadlessPreparedClosure !== undefined || request.strandedExecutionAttemptClosure !== undefined));
  if (!requiresSeat || !authenticatedNativeCaller || committedDispatchIntent) return null;
  if (authenticatedNativeCaller.projectId !== request.projectId) {
    throw refusal("ROLE_CONTEXT_FOREIGN", "authenticated native caller belongs to a different project");
  }
  const workItem = request.workItemId === undefined ? null : asRow<{ domain_id: string }>(db.prepare(
    "SELECT domain_id FROM work_items WHERE project_id = ? AND work_item_id = ?",
  ).get(request.projectId, request.workItemId));
  const domainId = workItem?.domain_id ?? request.domainId ?? "default";
  const holders = readRoleHolderStates(db).filter((holder) =>
    holder.project_id === request.projectId &&
    (holder.domain_id ?? "default") === domainId &&
    holder.thread_id === authenticatedNativeCaller.threadId &&
    (holder.role_id === "director" || holder.role_id === "project-orchestrator"));
  if (holders.length !== 1) throw refusal("ROLE_HOLDER_MISMATCH", "authenticated native caller is not the unique current director or project-orchestrator holder");
  return {
    roleId: holders[0]!.role_id as AuthenticatedNativeSeat["roleId"],
    roleGeneration: holders[0]!.role_generation,
    domainId,
    threadId: holders[0]!.thread_id,
    holderExecutionAttemptId: holders[0]!.execution_attempt_id,
  };
}

function applyWorkItemTransition(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  githubObservation: GitHubIssueSnapshot | null,
  githubPrObservation: GithubPrObservation | undefined,
  nativeSeat: AuthenticatedNativeSeat | null,
): FoundationResult {
  if (request.threadlessPreparedClosure !== undefined) return applyThreadlessPreparedClosure(db, request, digest, nativeSeat);
  if (request.strandedExecutionAttemptClosure !== undefined) return applyStrandedExecutionAttemptClosure(db, request, digest, nativeSeat);
  const committedDispatchIntent = request.reasonCode === "dispatch_intent_finalize" && request.lifecycleState === undefined && request.workAttempt?.threadId !== undefined;
  let configRevision: number;
  if (committedDispatchIntent) {
    const committedRevision = request.configRevision;
    if (!Number.isSafeInteger(committedRevision) || committedRevision === null || committedRevision === undefined || committedRevision <= 0 || request.fixtureContextDigest === undefined || !request.workItemId || !request.repoTargetId || !request.workAttempt?.requestedProfile) {
      throw refusal("PROJECT_CONFIG_STALE", "durable dispatch finalization proof is incomplete");
    }
    configRevision = committedRevision;
  } else {
    configRevision = requireConfig(db, request);
  }
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  // The watchdog uses a verified plugin actor rather than a role holder; role actors
  // must still prove current standing on every revalidation, including after stop.
  const roleActor = requireRoleActorBinding(db, request, false);
  requireNativeSeatActorAgreement(roleActor, nativeSeat);
  const attemptRole = nativeSeat ?? roleActor;
  if (request.workAttempt && attemptRole && !committedDispatchIntent) {
    requireRoleGenerationConfigContinuation(db, request.projectId, attemptRole.roleId, attemptRole.roleGeneration, attemptRole.domainId, configRevision);
  }
  const writeAttemptRole = attemptRole;
  const reviewAttemptRole = attemptRole;
  if (request.workAttempt && attemptRole && request.roleId !== undefined && request.roleId !== attemptRole.roleId) {
    throw refusal("ROLE_HOLDER_MISMATCH", "work attempt role does not match the authoritative role binding");
  }
  if (request.workAttempt && attemptRole && request.expectedGeneration !== null && request.expectedGeneration !== attemptRole.roleGeneration) {
    throw refusal("ROLE_GENERATION_STALE", "work attempt generation does not match the authoritative role binding");
  }
  let nextState = request.lifecycleState;
  let configContinuation: WorkItemDispatchConfigProof | null = null;
  let dispatchIntentEvidence: { committedConfigRevision: number; observedConfigRevision: number; proofDigest: string; disposition: "bound_to_durable_intent" } | null = null;
  if (committedDispatchIntent) {
    const proof = proveWorkItemDispatchConfig(db, {
      projectId: request.projectId,
      workItemId: request.workItemId!,
      repoTargetId: request.repoTargetId!,
      expectedConfigRevision: request.expectedConfigRevision,
      expectedGovernanceEpoch: request.expectedGovernanceEpoch,
      expectedFenceToken: request.expectedFenceToken,
      requestedProfile: request.workAttempt!.requestedProfile!,
      assignmentKind: request.workAttempt!.assignmentKind,
      candidateKind: request.workAttempt!.candidateKind,
    }, configRevision);
    if (proof.proofDigest !== request.fixtureContextDigest) {
      throw refusal("PROJECT_CONFIG_STALE", "durable dispatch finalization proof does not match the prepared intent");
    }
    if (proof.continued) configContinuation = proof;
    dispatchIntentEvidence = {
      committedConfigRevision: configRevision,
      observedConfigRevision: currentConfig(db, request.projectId)?.config_revision ?? configRevision,
      proofDigest: proof.proofDigest,
      disposition: "bound_to_durable_intent",
    };
  } else if (request.reasonCode === "config_revision_continuation") {
    if (!request.workItemId || !request.repoTargetId || !request.workAttempt?.requestedProfile || request.fixtureContextDigest === undefined) {
      throw refusal("PROJECT_CONFIG_STALE", "config-revision continuation proof is incomplete");
    }
    const proof = proveWorkItemDispatchConfig(db, {
      projectId: request.projectId,
      workItemId: request.workItemId,
      repoTargetId: request.repoTargetId,
      expectedConfigRevision: request.expectedConfigRevision,
      expectedGovernanceEpoch: request.expectedGovernanceEpoch,
      expectedFenceToken: request.expectedFenceToken,
      requestedProfile: request.workAttempt.requestedProfile,
      assignmentKind: request.workAttempt.assignmentKind,
      candidateKind: request.workAttempt.candidateKind,
    });
    if (!proof.continued || proof.proofDigest !== request.fixtureContextDigest) {
      throw refusal("PROJECT_CONFIG_STALE", "config-revision continuation proof is not the exact governed revision boundary");
    }
    configContinuation = proof;
  }
  const workItem = requireWorkItem(
    db,
    request,
    configRevision,
    request.expectedResourceRevision,
    nextState !== undefined || request.workItemWait === null || configContinuation !== null || committedDispatchIntent,
  );
  if (request.reasonCode === "fleet-watchdog-merge-close" && nextState !== undefined) {
    const liveAttempt = db.prepare(
      `SELECT execution_attempt_id, assignment_id, lane_id, thread_id, state
       FROM execution_attempts
       WHERE project_id = ? AND work_item_id = ? AND origin = 'work_item'
         AND state IN (${WORK_ITEM_CAPACITY_ATTEMPT_STATES.map(() => "?").join(", ")})
       ORDER BY attempt_ordinal DESC LIMIT 1`,
    ).get(request.projectId, workItem.work_item_id, ...WORK_ITEM_CAPACITY_ATTEMPT_STATES) as {
      execution_attempt_id: string;
      assignment_id: string | null;
      lane_id: string | null;
      thread_id: string | null;
      state: string;
    } | undefined;
    if (liveAttempt) {
      throw refusal("WORK_ITEM_STATE_INVALID", `fleet-watchdog merge-close requires no nonterminal canonical attempt: executionAttemptId=${liveAttempt.execution_attempt_id} assignmentId=${liveAttempt.assignment_id ?? "null"} laneId=${liveAttempt.lane_id ?? "null"} threadId=${liveAttempt.thread_id ?? "null"} state=${liveAttempt.state}`);
    }
  }
  const wait = request.workItemWait;
  const unblock = request.workItemUnblock;
  const externalEvent = request.workItemExternalEvent;
  const workAttempt = request.workAttempt;
  const satisfactionExit = nextState === "succeeded" && (workItem.lifecycle_state === "ready" || workItem.lifecycle_state === "blocked");
  const directMergeClose = request.reasonCode === "fleet-watchdog-merge-close" &&
    workItem.lifecycle_state === "in_progress" &&
    nextState === "succeeded" &&
    externalEvent?.kind === "github_issue_closed";
  const existingWait = asRow<WorkItemWaitRow>(db.prepare(
    "SELECT * FROM work_item_waits WHERE project_id = ? AND work_item_id = ?",
  ).get(request.projectId, workItem.work_item_id));
  if (request.workItemBody !== undefined && nextState === undefined && wait === undefined) {
    throw refusal("WORK_ITEM_STATE_INVALID", "work item body updates require a lifecycle or wait transition");
  }
  const machineWait = wait && (wait.kind === "work_item_succeeded" || wait.kind === "github_issue_closed" || wait.kind === "pr_merged" || wait.kind === "pr_checks" || wait.kind === "pr_review_state") ? wait : null;
  const enteringBlocked = nextState === "blocked" && workItem.lifecycle_state !== "blocked";
  const swappingBlockedWait = workItem.lifecycle_state === "blocked" && nextState === "blocked";
  let firedReplacementSwap = false;
  if (enteringBlocked) {
    if (!machineWait || workAttempt !== undefined || unblock !== undefined || externalEvent !== undefined) {
      throw refusal("WORK_ITEM_STATE_INVALID", "entering blocked requires exactly one machine-evaluable blocker");
    }
    if (existingWait) throw refusal("WORK_ITEM_WAIT_OPEN", "work item already carries an open wait");
    const blocker: WorkItemBlocker = machineWait.kind === "work_item_succeeded"
      ? { kind: machineWait.kind, workItemId: machineWait.workItemId }
      : machineWait.kind === "github_issue_closed"
        ? { kind: machineWait.kind, owner: machineWait.owner, repo: machineWait.repo, issueNumber: machineWait.issueNumber }
        : machineWait;
    if (machineWait.kind === "pr_merged" || machineWait.kind === "pr_checks" || machineWait.kind === "pr_review_state") {
      requireGithubPrWaitBinding(db, request, workItem, configRevision, machineWait);
      const observation = requireGithubPrObservation(machineWait, githubPrObservation);
      if (githubPrConditionSatisfied(machineWait, observation)) {
        return result("OK", request.projectId, 1, 0, 0, {
          registration: "already_satisfied",
          evidence: { kind: machineWait.kind, semanticDigest: githubPrSemanticDigest(observation), wake: false },
        });
      }
    }
    requireBlockerCondition(db, request, blocker, githubObservation, false, githubPrObservation);
  } else if (wait !== undefined && !swappingBlockedWait && (nextState !== undefined || workAttempt !== undefined)) {
    throw refusal("WORK_ITEM_STATE_INVALID", "work item wait mutation cannot change lifecycle state");
  }
  if (swappingBlockedWait) {
    if (!machineWait || !unblock || workAttempt !== undefined || externalEvent !== undefined) {
      throw refusal("WORK_ITEM_STATE_INVALID", "blocked wait swap requires one replacement blocker and the exact stored blocker");
    }
    const storedBlocker = existingWait ? storedWorkItemBlocker(existingWait) : null;
    if (!storedBlocker || !sameWorkItemBlocker(storedBlocker, unblock)) {
      throw refusal("WORK_ITEM_STATE_INVALID", "blocked wait swap requires the exact stored blocker");
    }
    const replacement: WorkItemBlocker = machineWait.kind === "work_item_succeeded"
      ? { kind: machineWait.kind, workItemId: machineWait.workItemId }
      : machineWait.kind === "github_issue_closed"
        ? { kind: machineWait.kind, owner: machineWait.owner, repo: machineWait.repo, issueNumber: machineWait.issueNumber }
        : machineWait;
    if (sameWorkItemBlocker(storedBlocker, replacement)) {
      throw refusal("WORK_ITEM_STATE_INVALID", "blocked wait swap requires a different replacement blocker");
    }
    if (isGithubPrWait(machineWait)) requireGithubPrWaitBinding(db, request, workItem, configRevision, machineWait);
    if (machineWait.kind === "work_item_succeeded") {
      firedReplacementSwap = blockerConditionSatisfied(db, request, replacement, githubObservation, githubPrObservation);
      if (firedReplacementSwap) nextState = "ready";
    } else {
      requireBlockerCondition(db, request, replacement, githubObservation, false, githubPrObservation);
    }
  }
  if (wait !== undefined && !enteringBlocked && !swappingBlockedWait) {
    if (machineWait) throw refusal("WORK_ITEM_STATE_INVALID", "machine-evaluable blocker requires an atomic transition to blocked");
    if (workItem.lifecycle_state === "blocked" || (wait !== null && ["succeeded", "failed", "cancelled"].includes(workItem.lifecycle_state))) {
      throw refusal("WORK_ITEM_STATE_INVALID", wait === null
        ? workItem.lifecycle_state === "blocked"
          ? "blocked work item cannot clear its machine-evaluable blocker through a wait mutation"
          : "terminal work item has no wait to clear"
        : "blocked or terminal work item cannot carry a human wait");
    }
    if (wait !== null && existingWait) throw refusal("WORK_ITEM_WAIT_OPEN", "work item already carries an open wait");
    if (wait === null && !existingWait) throw refusal("WORK_ITEM_WAIT_OPEN", "work item carries no open wait");
    const nextRevision = workItem.resource_revision + 1;
    const updated = db.prepare(
      `UPDATE work_items SET body = ?, resource_revision = ?, updated_at_ms = ?
       WHERE project_id = ? AND work_item_id = ? AND resource_revision = ?`,
    ).run(request.workItemBody ?? workItem.body, nextRevision, now(), request.projectId, workItem.work_item_id, workItem.resource_revision);
    if (updated.changes !== 1) throw refusal("WORK_ITEM_REVISION_STALE", "work item compare-and-swap failed", {
      currentResourceRevision: workItem.resource_revision,
      expectedResourceRevision: request.expectedResourceRevision ?? undefined,
    });
    if (wait === null) {
      db.prepare("DELETE FROM work_item_waits WHERE project_id = ? AND work_item_id = ?").run(request.projectId, workItem.work_item_id);
    } else {
      if (wait.kind !== "schedule" && wait.kind !== "seat") throw refusal("WORK_ITEM_STATE_INVALID", "machine-evaluable blocker requires blocked");
      db.prepare(
        `INSERT INTO work_item_waits (project_id, work_item_id, domain_id, waker, waker_kind, declared_at_ms, declared_by_seat, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(request.projectId, workItem.work_item_id, workItem.domain_id, wait.kind === "schedule" ? wait.schedule : wait.seat, wait.kind, now(), wait.declaredBySeat);
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
        eventType: wait === null ? "work_item_wait_cleared" : "work_item_wait_declared",
        event: {
          workItemId: workItem.work_item_id,
          ...(wait === null ? {} : { waker: wait, declaredBySeat: wait.declaredBySeat }),
          ...(request.workItemBody === undefined ? {} : { bodyDigest: sha256(request.workItemBody) }),
        },
      },
      { expected: 1, attempted: 1, verified: 1 },
      {
        currentConfigRevision: configRevision,
        currentGovernanceEpoch: governor.governance_epoch,
        currentResourceRevision: nextRevision,
        expectedResourceRevision: request.expectedResourceRevision ?? undefined,
        evidence: { workItemId: workItem.work_item_id, wait: wait ?? null },
      },
    );
  }
  if (workAttempt !== undefined && nextState !== undefined && nextState !== "in_progress" && nextState !== "review_pending") {
    throw refusal("WORK_ITEM_STATE_INVALID", "work attempts may only accompany in-progress or review-pending transitions");
  }
  if (workAttempt?.assignmentKind === "probe") {
    throw refusal("WORK_ITEM_STATE_INVALID", "probe attempts cannot hold a work item lifecycle state");
  }
  if (nextState === "in_progress" && workAttempt?.assignmentKind !== "write") {
    throw refusal("WORK_ITEM_STATE_INVALID", "in-progress requires a writing attempt");
  }
  if (nextState === "review_pending" && workAttempt?.assignmentKind !== undefined && workAttempt.assignmentKind !== "review") {
    throw refusal("WORK_ITEM_STATE_INVALID", "review-pending may only register a review attempt");
  }
  const redispatchingReview = workItem.lifecycle_state === "review_pending" && nextState === "review_pending";
  if (request.reviewHandoff !== undefined && (nextState !== "review_pending" || redispatchingReview)) {
    throw refusal("WORK_ITEM_STATE_INVALID", "review handoff is valid only when entering review-pending");
  }
  const priorReview = redispatchingReview
    ? activeWorkItemAttempt(db, request.projectId, workItem.work_item_id, "review")
    : undefined;
  if (redispatchingReview && (
    !workAttempt || !workAttempt.threadId || !workAttempt.requestedProfile ||
    !priorReview || !reviewCandidateMatches(priorReview, workAttempt) || !reviewAuthorityMatches(priorReview, workAttempt)
  )) {
    throw refusal("WORK_ITEM_STATE_INVALID", "review re-dispatch requires one active review and the same exact immutable candidate and profile");
  }
  if (workAttempt !== undefined && nextState === undefined) {
    if (workAttempt.assignmentKind === "review" && workAttempt.candidateKind === "local" && !workAttempt.dispatchInputDigest) {
      throw refusal("WORK_ITEM_STATE_INVALID", "local review dispatch requires the exact native input digest");
    }
    const dispatchIntent = db.prepare(
      `SELECT execution_attempt_id FROM execution_attempts
       WHERE project_id = ? AND work_item_id = ? AND origin = 'work_item'
         AND assignment_kind = ? AND state = 'prepared' AND thread_id IS NULL
       ORDER BY attempt_ordinal DESC LIMIT 1`,
    ).get(request.projectId, workItem.work_item_id, workAttempt.assignmentKind) as { execution_attempt_id: string } | undefined;
    if (dispatchIntent && workAttempt.threadId) {
      const observedAtMs = now();
      db.prepare(
        `UPDATE execution_attempts
         SET state = 'running', thread_id = ?, lease_owner_thread_id = ?, reason_code = 'work_item_dispatch', observed_at_ms = ?, dispatch_input_digest = COALESCE(?, dispatch_input_digest)
         WHERE project_id = ? AND execution_attempt_id = ? AND state = 'prepared' AND thread_id IS NULL`,
      ).run(workAttempt.threadId, workAttempt.threadId, observedAtMs, workAttempt.dispatchInputDigest ?? null, request.projectId, dispatchIntent.execution_attempt_id);
      return commitMutation(
        db,
        request,
        digest,
        actorReceiptId,
        {
          aggregateType: "work_item",
          aggregateId: workItem.work_item_id,
          aggregateRevision: workItem.resource_revision,
          eventType: "work_item_attempt_armed",
          event: {
            workItemId: workItem.work_item_id,
            executionAttemptId: dispatchIntent.execution_attempt_id,
            workAttempt,
            ...(dispatchIntentEvidence === null ? {} : { dispatchIntent: dispatchIntentEvidence }),
            ...(configContinuation === null ? {} : {
              configContinuation: {
                fromRevision: configContinuation.workItemConfigRevision,
                toRevision: configContinuation.currentConfigRevision,
                proofDigest: configContinuation.proofDigest,
                disposition: "continued",
              },
            }),
          },
        },
        { expected: 1, attempted: 1, verified: 1 },
        {
          currentConfigRevision: configRevision,
          currentGovernanceEpoch: governor.governance_epoch,
          currentResourceRevision: workItem.resource_revision,
          expectedResourceRevision: request.expectedResourceRevision ?? undefined,
          evidence: {
            workItemId: workItem.work_item_id,
            executionAttemptId: dispatchIntent.execution_attempt_id,
            workAttempt,
            ...(dispatchIntentEvidence === null ? {} : { dispatchIntent: dispatchIntentEvidence }),
            ...(configContinuation === null ? {} : { configContinuation: { fromRevision: configContinuation.workItemConfigRevision, toRevision: configContinuation.currentConfigRevision, proofDigest: configContinuation.proofDigest } }),
          },
        },
      );
    }
    if (workAttempt.assignmentKind === "review") {
      if (workItem.lifecycle_state !== "review_pending") {
        throw refusal("WORK_ITEM_STATE_INVALID", "review dispatch requires a review_pending WorkItem");
      }
      if (activeWorkItemAttempt(db, request.projectId, workItem.work_item_id, "review")) {
        throw refusal("WORK_ITEM_STATE_INVALID", "review dispatch already has one active review attempt");
      }
      const prior = latestWorkItemAttempt(db, request.projectId, workItem.work_item_id);
      const nextRevision = workItem.resource_revision + 1;
      const updated = db.prepare(
        `UPDATE work_items SET resource_revision = ?, updated_at_ms = ?
         WHERE project_id = ? AND work_item_id = ? AND resource_revision = ?`,
      ).run(nextRevision, now(), request.projectId, workItem.work_item_id, workItem.resource_revision);
      if (updated.changes !== 1) throw refusal("WORK_ITEM_REVISION_STALE", "work item compare-and-swap failed");
      const executionAttemptId = insertWorkItemAttempt(db, {
        projectId: request.projectId,
        workItemId: workItem.work_item_id,
        domainId: workItem.domain_id,
        configRevision: workItem.config_revision,
        repoTargetId: workItem.repo_target_id,
        laneId: workAttempt.laneId,
        threadId: null,
        roleId: reviewAttemptRole?.roleId ?? null,
        roleGeneration: reviewAttemptRole?.roleGeneration ?? null,
        leaseOwnerThreadId: null,
        assignmentKind: "review",
        requestedProfile: requireWorkAttemptProfile(workAttempt),
        attemptOrdinal: nextWorkAttemptOrdinal(db, request.projectId, workItem.work_item_id),
        state: "prepared",
        reasonCode: `work_item_dispatch_intent:${request.idempotencyKey}${request.reasonCode?.startsWith("dispatch_parent:") ? `:parent=${request.reasonCode.slice("dispatch_parent:".length)}` : ""}`,
        createdAtMs: now(),
        observedAtMs: now(),
        completedAtMs: null,
        continuationOfAttemptId: prior?.execution_attempt_id ?? null,
        reviewPrNumber: workAttempt.reviewPrNumber ?? null,
        reviewPrHeadSha: workAttempt.reviewPrHeadSha ?? null,
        reviewCandidateKind: workAttempt.candidateKind ?? null,
        reviewCandidateJson: reviewCandidateJson(workAttempt),
        reviewRoleRequirementId: workAttempt.reviewRoleRequirementId ?? null,
        reviewRoleId: workAttempt.reviewRoleId ?? null,
        reviewRoleGeneration: workAttempt.reviewRoleGeneration ?? null,
        reviewFrozenBriefVersion: workAttempt.reviewFrozenBriefVersion ?? null,
        reviewFrozenBriefContent: workAttempt.reviewFrozenBriefContent ?? null,
        reviewFrozenBriefDigest: workAttempt.reviewFrozenBriefDigest ?? null,
        reviewReturnPathJson: workAttempt.reviewReturnPath ? canonicalJson(workAttempt.reviewReturnPath) : null,
        dispatchInputDigest: workAttempt.dispatchInputDigest ?? null,
      });
      return commitMutation(
        db,
        request,
        digest,
        actorReceiptId,
        {
          aggregateType: "work_item",
          aggregateId: workItem.work_item_id,
          aggregateRevision: nextRevision,
          eventType: "work_item_review_attempt_registered",
          event: { workItemId: workItem.work_item_id, executionAttemptId, workAttempt },
        },
        { expected: 1, attempted: 1, verified: 1 },
        { currentConfigRevision: configRevision, currentGovernanceEpoch: governor.governance_epoch, currentResourceRevision: nextRevision, evidence: { workItemId: workItem.work_item_id, executionAttemptId, workAttempt } },
      );
    }
    if (workItem.lifecycle_state !== "in_progress") {
      throw refusal("WORK_ITEM_STATE_INVALID", "replacement work attempts require an in-progress work item");
    }
    if (workAttempt.assignmentKind !== "write") {
      throw refusal("WORK_ITEM_STATE_INVALID", "replacement work attempts must be writing attempts");
    }
    const prior = latestWorkItemAttempt(db, request.projectId, workItem.work_item_id);
    const nextRevision = workItem.resource_revision + 1;
    const updated = db.prepare(
      `UPDATE work_items SET resource_revision = ?, updated_at_ms = ?
       WHERE project_id = ? AND work_item_id = ? AND resource_revision = ?`,
    ).run(nextRevision, now(), request.projectId, workItem.work_item_id, workItem.resource_revision);
    if (updated.changes !== 1) throw refusal("WORK_ITEM_REVISION_STALE", "work item compare-and-swap failed", {
      currentResourceRevision: workItem.resource_revision,
      expectedResourceRevision: request.expectedResourceRevision ?? undefined,
    });
    if (prior?.state === "interrupted") supersedeInterruptedAttempt(db, request.projectId, prior.execution_attempt_id);
    else if (prior && WORK_ITEM_CAPACITY_ATTEMPT_STATES.includes(prior.state as typeof WORK_ITEM_CAPACITY_ATTEMPT_STATES[number])) {
      terminalizeWorkItemAttempt(db, request.projectId, workItem.work_item_id, "superseded");
    }
    const createdAtMs = now();
    const executionAttemptId = insertWorkItemAttempt(db, {
      projectId: request.projectId,
      workItemId: workItem.work_item_id,
      domainId: workItem.domain_id,
      configRevision: workItem.config_revision,
      repoTargetId: workItem.repo_target_id,
      laneId: workAttempt.laneId,
      threadId: workAttempt.threadId ?? null,
      roleId: writeAttemptRole?.roleId ?? null,
      roleGeneration: writeAttemptRole?.roleGeneration ?? null,
      leaseOwnerThreadId: workAttempt.threadId ?? null,
      assignmentKind: workAttempt.assignmentKind,
      requestedProfile: requireWorkAttemptProfile(workAttempt),
      attemptOrdinal: nextWorkAttemptOrdinal(db, request.projectId, workItem.work_item_id),
      state: workAttempt.threadId ? "running" : "prepared",
      reasonCode: workAttempt.threadId ? "work_item_dispatch" : `work_item_dispatch_intent:${request.idempotencyKey}${request.reasonCode?.startsWith("dispatch_parent:") ? `:parent=${request.reasonCode.slice("dispatch_parent:".length)}` : ""}`,
      createdAtMs,
      observedAtMs: createdAtMs,
      completedAtMs: null,
      continuationOfAttemptId: prior?.execution_attempt_id ?? null,
      reviewPrNumber: null,
      reviewPrHeadSha: null,
      reviewCandidateKind: null,
      reviewCandidateJson: null,
    });
    return commitMutation(
      db,
      request,
      digest,
      actorReceiptId,
      {
        aggregateType: "work_item",
        aggregateId: workItem.work_item_id,
        aggregateRevision: nextRevision,
        eventType: "work_item_attempt_registered",
        event: {
          workItemId: workItem.work_item_id,
          executionAttemptId,
          supersededExecutionAttemptId: prior?.execution_attempt_id ?? null,
          workAttempt,
        },
      },
      { expected: 1, attempted: 1, verified: 1 },
      {
        currentConfigRevision: configRevision,
        currentGovernanceEpoch: governor.governance_epoch,
        currentResourceRevision: nextRevision,
        expectedResourceRevision: request.expectedResourceRevision ?? undefined,
        evidence: { workItemId: workItem.work_item_id, executionAttemptId, workAttempt, supersededExecutionAttemptId: prior?.execution_attempt_id ?? null },
      },
    );
  }
  if (!nextState || (!redispatchingReview && !swappingBlockedWait && !directMergeClose && !WORK_ITEM_TRANSITIONS[workItem.lifecycle_state].includes(nextState))) {
    throw refusal("WORK_ITEM_STATE_INVALID", "work item lifecycle transition is not allowed");
  }
  const satisfactionEvidence = satisfactionExit ? requireWorkItemSatisfactionEvidence(db, request) : undefined;
  const githubIssueSatisfaction = satisfactionEvidence?.kind === "github_issue_closed";
  if (githubIssueSatisfaction && (!githubObservation || githubObservation.state !== "closed")) {
    throw refusal("WORK_ITEM_STATE_INVALID", "satisfaction evidence does not name a closed GitHub issue");
  }
  let recordedExternalEvent: { kind: "github_issue_closed" | "github_issue_reopened"; owner: string; repo: string; issueNumber: number; externalRevision: string } | null = null;
  let reopenedRef: ExternalWorkRefRow | null = null;
  if (githubObservation && !validGithubSnapshotStateReason(githubObservation.state, githubObservation.stateReason)) {
    throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub issue state and reason do not match");
  }
  if (workItem.lifecycle_state === "blocked") {
    const storedBlocker = existingWait ? storedWorkItemBlocker(existingWait) : null;
    if (!storedBlocker) throw refusal("WORK_ITEM_STATE_INVALID", "blocked work item has no valid machine-evaluable blocker");
    if (nextState === "ready") {
      if (!unblock || !sameWorkItemBlocker(storedBlocker, unblock)) {
        throw refusal("WORK_ITEM_STATE_INVALID", "blocked to ready requires the exact stored blocker");
      }
      if (!firedReplacementSwap) requireBlockerCondition(db, request, unblock, githubObservation, true, githubPrObservation);
    } else if (unblock !== undefined && !swappingBlockedWait && !satisfactionExit) {
      throw refusal("WORK_ITEM_STATE_INVALID", "work item unblock evidence only permits blocked to ready or an atomic blocker swap");
    }
    if (satisfactionExit) {
      if (unblock !== undefined && !sameWorkItemBlocker(storedBlocker, unblock)) {
        throw refusal("WORK_ITEM_STATE_INVALID", "blocked to succeeded requires the exact stored blocker when blocker evidence is supplied");
      }
      if (!githubIssueSatisfaction && !blockerConditionSatisfied(db, request, storedBlocker, githubObservation, githubPrObservation)) {
        throw refusal("WORK_ITEM_STATE_INVALID", "blocked work item blocker is still live");
      }
    }
  } else if (unblock !== undefined) {
    throw refusal("WORK_ITEM_STATE_INVALID", "work item unblock evidence requires a blocked work item");
  }
  if (externalEvent) {
    if (!githubObservation) throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub lifecycle observation is unavailable");
    const boundRef = requireBoundGithubIssue(db, request.projectId, workItem.work_item_id, externalEvent);
    if (externalEvent.kind === "github_issue_closed") {
      const absorbedBeforeStart = workItem.lifecycle_state === "proposed" && nextState === "cancelled";
      if ((!absorbedBeforeStart && nextState !== "succeeded") || githubObservation.state !== "closed") {
        throw refusal("WORK_ITEM_STATE_INVALID", "close observation only permits succeeded, or proposed to cancelled");
      }
      if (absorbedBeforeStart && githubObservation.stateReason !== "COMPLETED") {
        throw refusal("WORK_ITEM_STATE_INVALID", "proposed cancellation requires a completed GitHub close observation");
      }
    } else {
      if (workItem.lifecycle_state !== "succeeded" || nextState !== "ready" || githubObservation.state !== "open") {
        throw refusal("WORK_ITEM_STATE_INVALID", "reopen observation only permits succeeded to ready");
      }
      const prior = recordedGithubCloseObservation(db, request.projectId, workItem.work_item_id, workItem.resource_revision);
      if (prior && (
        prior.owner !== externalEvent.owner ||
        prior.repo !== externalEvent.repo ||
        prior.issueNumber !== externalEvent.issueNumber
      )) throw refusal("WORK_ITEM_STATE_INVALID", "GitHub reopen does not match the recorded close identity", { structurallyImpossibleAtRevision: true });
      const previousRevision = prior?.externalRevision ?? boundRef.observed_external_revision;
      if (previousRevision === null || previousRevision === githubObservation.externalRevision) {
        throw refusal("WORK_ITEM_STATE_INVALID", "GitHub reopen does not follow the exact recorded close observation");
      }
      reopenedRef = boundRef;
    }
    recordedExternalEvent = { ...externalEvent, externalRevision: githubObservation.externalRevision };
  } else if (workItem.lifecycle_state === "succeeded" && nextState === "ready") {
    throw refusal("WORK_ITEM_STATE_INVALID", "succeeded work item can return only after a proven GitHub issue reopening", { structurallyImpossibleAtRevision: true });
  }
  if (nextState === "in_progress" && workAttempt === undefined) {
    throw refusal("WORK_ITEM_STATE_INVALID", "entering in-progress requires a work attempt");
  }
  const reviewHandoff = nextState === "review_pending" && !redispatchingReview
    ? requireReviewHandoff(db, request, workItem)
    : undefined;
  const latestAttempt = latestWorkItemAttempt(db, request.projectId, workItem.work_item_id);
  if (nextState === "succeeded" && latestAttempt?.state === "interrupted") {
    throw refusal("WORK_ITEM_STATE_INVALID", "interrupted attempt requires explicit resume or disposition before success");
  }
  if (workItem.lifecycle_state === "review_pending" && activeWorkItemAttempt(db, request.projectId, workItem.work_item_id, "write")) {
    throw refusal("WORK_ITEM_STATE_INVALID", "review-pending cannot carry an active writing attempt");
  }
  const nextRevision = workItem.resource_revision + 1;
  const updated = db.prepare(
    `UPDATE work_items SET lifecycle_state = ?, body = ?, resource_revision = ?, updated_at_ms = ?
     WHERE project_id = ? AND work_item_id = ? AND resource_revision = ? AND lifecycle_state = ?`,
  ).run(nextState, request.workItemBody ?? workItem.body, nextRevision, now(), request.projectId, workItem.work_item_id, workItem.resource_revision, workItem.lifecycle_state);
  if (updated.changes !== 1) {
    throw refusal("WORK_ITEM_REVISION_STALE", "work item compare-and-swap failed", {
      currentResourceRevision: workItem.resource_revision,
      expectedResourceRevision: request.expectedResourceRevision ?? undefined,
    });
  }
  if (reopenedRef) {
    const refUpdated = db.prepare(
      `UPDATE external_work_refs SET observed_external_revision = ?, updated_at_ms = ?
       WHERE project_id = ? AND work_item_id = ? AND provider = 'github' AND observed_external_revision IS ?`,
    ).run(
      githubObservation!.externalRevision,
      now(),
      request.projectId,
      workItem.work_item_id,
      reopenedRef.observed_external_revision,
    );
    if (refUpdated.changes !== 1) throw refusal("EXTERNAL_REF_CONFLICT", "external ref changed before GitHub reopen was recorded");
  }
  if (["succeeded", "failed", "cancelled"].includes(nextState)) {
    dischargeTerminalWorkItemWait(db, request.projectId, workItem.work_item_id);
  } else if (enteringBlocked) {
    const blocker: WorkItemBlocker = machineWait!.kind === "work_item_succeeded"
      ? { kind: machineWait!.kind, workItemId: machineWait!.workItemId }
      : machineWait!.kind === "github_issue_closed"
        ? { kind: machineWait!.kind, owner: machineWait!.owner, repo: machineWait!.repo, issueNumber: machineWait!.issueNumber }
        : machineWait!;
    if (isGithubPrWait(machineWait!)) {
      const semanticDigest = githubPrSemanticDigest(githubPrObservation!);
      db.prepare(
        `INSERT INTO work_item_waits (
           project_id, work_item_id, domain_id, waker, waker_kind, declared_at_ms, declared_by_seat, note,
           pr_owner, pr_repo, pr_number, pr_condition_kind, pr_expected_state, pr_expected_head_sha,
           pr_execution_attempt_id, pr_waiting_thread_id, pr_waiting_role_id, pr_waiting_role_generation,
           pr_waker_schedule, pr_deadline_at_ms, pr_initial_semantic_digest, pr_last_observed_semantic_digest, pr_delivery_state
         ) VALUES (?, ?, ?, ?, 'github_pr', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(
        request.projectId, workItem.work_item_id, workItem.domain_id, workItemBlockerWaker(blocker), now(), machineWait!.declaredBySeat, machineWait!.note ?? null,
        machineWait!.owner, machineWait!.repo, machineWait!.prNumber, machineWait!.kind, machineWait!.expectedState, machineWait!.expectedHeadSha ?? null,
        machineWait!.executionAttemptId, machineWait!.waitingThreadId, machineWait!.waitingRoleId, machineWait!.waitingRoleGeneration,
        machineWait!.wakerSchedule, machineWait!.deadlineAtMs, semanticDigest, semanticDigest,
      );
    } else {
      db.prepare(
        `INSERT INTO work_item_waits (project_id, work_item_id, domain_id, waker, waker_kind, declared_at_ms, declared_by_seat, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(request.projectId, workItem.work_item_id, workItem.domain_id, workItemBlockerWaker(blocker), blocker.kind, now(), machineWait!.declaredBySeat, machineWait!.note ?? null);
    }
  } else if (swappingBlockedWait && !firedReplacementSwap) {
    const blocker: WorkItemBlocker = machineWait!.kind === "work_item_succeeded"
      ? { kind: machineWait!.kind, workItemId: machineWait!.workItemId }
      : machineWait!.kind === "github_issue_closed"
        ? { kind: machineWait!.kind, owner: machineWait!.owner, repo: machineWait!.repo, issueNumber: machineWait!.issueNumber }
        : machineWait!;
    if (isGithubPrWait(machineWait!)) {
      const semanticDigest = githubPrSemanticDigest(githubPrObservation!);
      db.prepare(
        `UPDATE work_item_waits SET domain_id = ?, waker = ?, waker_kind = 'github_pr', declared_at_ms = ?, declared_by_seat = ?, note = ?,
          pr_owner = ?, pr_repo = ?, pr_number = ?, pr_condition_kind = ?, pr_expected_state = ?, pr_expected_head_sha = ?,
          pr_execution_attempt_id = ?, pr_waiting_thread_id = ?, pr_waiting_role_id = ?, pr_waiting_role_generation = ?,
          pr_waker_schedule = ?, pr_deadline_at_ms = ?, pr_initial_semantic_digest = ?, pr_last_observed_semantic_digest = ?,
          pr_delivery_state = 'pending'
         WHERE project_id = ? AND work_item_id = ?`,
      ).run(
        workItem.domain_id, workItemBlockerWaker(blocker), now(), machineWait!.declaredBySeat, machineWait!.note ?? null,
        machineWait!.owner, machineWait!.repo, machineWait!.prNumber, machineWait!.kind, machineWait!.expectedState, machineWait!.expectedHeadSha ?? null,
        machineWait!.executionAttemptId, machineWait!.waitingThreadId, machineWait!.waitingRoleId, machineWait!.waitingRoleGeneration,
        machineWait!.wakerSchedule, machineWait!.deadlineAtMs, semanticDigest, semanticDigest, request.projectId, workItem.work_item_id,
      );
    } else {
      db.prepare(
        `UPDATE work_item_waits
         SET domain_id = ?, waker = ?, waker_kind = ?, declared_at_ms = ?, declared_by_seat = ?, note = ?
         WHERE project_id = ? AND work_item_id = ?`,
      ).run(workItem.domain_id, workItemBlockerWaker(blocker), blocker.kind, now(), machineWait!.declaredBySeat, machineWait!.note ?? null, request.projectId, workItem.work_item_id);
    }
  } else if (workItem.lifecycle_state === "blocked") {
    db.prepare("DELETE FROM work_item_waits WHERE project_id = ? AND work_item_id = ?").run(request.projectId, workItem.work_item_id);
  }
  let executionAttemptId: string | null = null;
  let reviewExecutionAttemptId: string | null = null;
  if (nextState === "in_progress") {
    const prior = workItem.lifecycle_state === "review_pending"
      ? activeWorkItemAttempt(db, request.projectId, workItem.work_item_id, "review")
      : undefined;
    if (prior) terminalizeWorkItemAttempt(db, request.projectId, workItem.work_item_id, "superseded", "review");
    executionAttemptId = insertWorkItemAttempt(db, {
      projectId: request.projectId,
      workItemId: workItem.work_item_id,
      domainId: workItem.domain_id,
      configRevision: workItem.config_revision,
      repoTargetId: workItem.repo_target_id,
      laneId: workAttempt!.laneId,
      threadId: workAttempt!.threadId ?? null,
      roleId: writeAttemptRole?.roleId ?? null,
      roleGeneration: writeAttemptRole?.roleGeneration ?? null,
      leaseOwnerThreadId: workAttempt!.threadId ?? null,
      assignmentKind: workAttempt!.assignmentKind,
      requestedProfile: requireWorkAttemptProfile(workAttempt!),
      attemptOrdinal: nextWorkAttemptOrdinal(db, request.projectId, workItem.work_item_id),
      state: workAttempt!.threadId ? "running" : "prepared",
      reasonCode: workAttempt!.threadId ? "work_item_dispatch" : `work_item_dispatch_intent:${request.idempotencyKey}${request.reasonCode?.startsWith("dispatch_parent:") ? `:parent=${request.reasonCode.slice("dispatch_parent:".length)}` : ""}`,
      createdAtMs: now(),
      observedAtMs: now(),
      completedAtMs: null,
      continuationOfAttemptId: prior?.execution_attempt_id ?? null,
      reviewPrNumber: null,
      reviewPrHeadSha: null,
      reviewCandidateKind: null,
      reviewCandidateJson: null,
    });
  } else if (nextState === "review_pending") {
    executionAttemptId = redispatchingReview
      ? terminalizeWorkItemAttempt(db, request.projectId, workItem.work_item_id, "superseded", "review")
      : reviewHandoff?.kind === "accepted-write-terminal-report"
        ? reviewHandoff.executionAttemptId
        : terminalizeWorkItemAttempt(db, request.projectId, workItem.work_item_id, "done", "write", "work-item-review-handoff");
    if (workAttempt) {
      reviewExecutionAttemptId = insertWorkItemAttempt(db, {
        projectId: request.projectId,
        workItemId: workItem.work_item_id,
        domainId: workItem.domain_id,
        configRevision: workItem.config_revision,
        repoTargetId: workItem.repo_target_id,
        laneId: workAttempt.laneId,
        threadId: workAttempt.threadId ?? null,
        roleId: reviewAttemptRole?.roleId ?? null,
        roleGeneration: reviewAttemptRole?.roleGeneration ?? null,
        leaseOwnerThreadId: workAttempt.threadId ?? null,
        assignmentKind: "review",
        requestedProfile: requireWorkAttemptProfile(workAttempt),
        attemptOrdinal: nextWorkAttemptOrdinal(db, request.projectId, workItem.work_item_id),
        state: "running",
        reasonCode: "work_item_review",
        createdAtMs: now(),
        observedAtMs: now(),
        completedAtMs: null,
        continuationOfAttemptId: executionAttemptId,
        reviewPrNumber: workAttempt.reviewPrNumber ?? null,
        reviewPrHeadSha: workAttempt.reviewPrHeadSha ?? null,
        reviewCandidateKind: workAttempt.candidateKind ?? null,
        reviewCandidateJson: reviewCandidateJson(workAttempt),
        reviewRoleRequirementId: workAttempt.reviewRoleRequirementId ?? null,
        reviewRoleId: workAttempt.reviewRoleId ?? null,
        reviewRoleGeneration: workAttempt.reviewRoleGeneration ?? null,
        reviewFrozenBriefVersion: workAttempt.reviewFrozenBriefVersion ?? null,
        reviewFrozenBriefContent: workAttempt.reviewFrozenBriefContent ?? null,
        reviewFrozenBriefDigest: workAttempt.reviewFrozenBriefDigest ?? null,
        reviewReturnPathJson: workAttempt.reviewReturnPath ? canonicalJson(workAttempt.reviewReturnPath) : null,
        dispatchInputDigest: workAttempt.dispatchInputDigest ?? null,
      });
    }
  } else {
    executionAttemptId = terminalizeWorkItemAttempt(
      db,
      request.projectId,
      workItem.work_item_id,
      nextState === "succeeded" ? "done" : nextState === "blocked" ? "blocked" : "failed",
      workItem.lifecycle_state === "review_pending" ? "review" : undefined,
      nextState === "succeeded" ? (directMergeClose ? "fleet-watchdog-merge-close" : "work-item-review-adjudication") : undefined,
    );
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
      eventType: swappingBlockedWait ? "work_item_wait_swapped" : "work_item_transitioned",
      event: {
        workItemId: workItem.work_item_id,
        from: workItem.lifecycle_state,
        to: nextState,
        ...(executionAttemptId === null ? {} : { executionAttemptId }),
        ...(reviewExecutionAttemptId === null ? {} : { reviewExecutionAttemptId }),
        ...(reviewHandoff === undefined ? {} : {
          handoffKind: reviewHandoff.kind,
          ...(reviewHandoff.kind === "accepted-write-terminal-report" ? {
            terminalReportDigest: reviewHandoff.terminalReportDigest,
            terminalEventId: reviewHandoff.terminalEventId,
            terminalEventSeq: reviewHandoff.terminalEventSeq,
          } : {}),
        }),
        ...(workAttempt === undefined ? {} : { workAttempt }),
        ...(machineWait === null ? {} : { blocker: machineWait }),
        ...(isGithubPrWait(machineWait ?? { kind: "none" }) ? { initialObservation: githubPrObservation, initialSemanticDigest: githubPrSemanticDigest(githubPrObservation!) } : {}),
        ...(unblock === undefined ? {} : { unblock }),
        ...(satisfactionEvidence === undefined ? {} : { satisfactionEvidence }),
        ...(firedReplacementSwap ? { previousBlocker: unblock, replacementBlocker: machineWait } : {}),
        ...(recordedExternalEvent === null ? {} : { externalEvent: recordedExternalEvent }),
        ...(configContinuation === null ? {} : {
          configContinuation: {
            fromRevision: configContinuation.workItemConfigRevision,
            toRevision: configContinuation.currentConfigRevision,
            proofDigest: configContinuation.proofDigest,
            disposition: "continued",
          },
        }),
        ...(request.workItemBody === undefined ? {} : { bodyDigest: sha256(request.workItemBody) }),
      },
    },
    { expected: 1, attempted: 1, verified: 1 },
    {
      currentConfigRevision: configRevision,
      currentGovernanceEpoch: governor.governance_epoch,
      currentResourceRevision: nextRevision,
      expectedResourceRevision: request.expectedResourceRevision ?? undefined,
      ...(isGithubPrWait(machineWait ?? { kind: "none" }) ? { registration: "registered" as const } : {}),
        evidence: {
          workItemId: workItem.work_item_id,
          lifecycleState: nextState,
          ...(executionAttemptId === null ? {} : { executionAttemptId }),
          ...(reviewExecutionAttemptId === null ? {} : { reviewExecutionAttemptId }),
          ...(reviewHandoff === undefined ? {} : {
            handoffKind: reviewHandoff.kind,
            ...(reviewHandoff.kind === "accepted-write-terminal-report" ? {
              terminalReportDigest: reviewHandoff.terminalReportDigest,
              terminalEventId: reviewHandoff.terminalEventId,
              terminalEventSeq: reviewHandoff.terminalEventSeq,
            } : {}),
          }),
          ...(machineWait === null ? {} : { blocker: machineWait }),
          ...(isGithubPrWait(machineWait ?? { kind: "none" }) ? { initialSemanticDigest: githubPrSemanticDigest(githubPrObservation!) } : {}),
          ...(unblock === undefined ? {} : { unblock }),
          ...(satisfactionEvidence === undefined ? {} : { satisfactionEvidence }),
          ...(firedReplacementSwap ? { previousBlocker: unblock, replacementBlocker: machineWait } : {}),
          ...(recordedExternalEvent === null ? {} : { externalEvent: recordedExternalEvent }),
          ...(configContinuation === null ? {} : {
            configContinuation: {
              fromRevision: configContinuation.workItemConfigRevision,
              toRevision: configContinuation.currentConfigRevision,
              proofDigest: configContinuation.proofDigest,
              disposition: "continued",
            },
          }),
        },
    },
  );
}

interface DesiredProjection {
  title: string;
  body: string;
  state: "open" | "closed";
  managedLabels: string[];
  managedNames: Set<string>;
  queueLabel?: "queue:dispatched";
  digest: string;
}

function desiredProjection(workItem: WorkItemRow, github: GithubIssuesConfig, blocker: string | null = null, queueLabel?: "queue:dispatched"): DesiredProjection {
  const convention = github.issue;
  const names = new Set(convention?.managedLabels?.names ?? []);
  const managedLabels = [...new Set(convention?.managedLabels?.byLifecycle?.[workItem.lifecycle_state] ?? [])].sort();
  const title = `${convention?.titlePrefix ?? ""}${workItem.title}`;
  const body = `${convention?.bodyPrefix ?? ""}${maintainedIssueBody({ lifecycleState: workItem.lifecycle_state, scope: workItem.body, blocker })}`;
  const state = (["succeeded", "failed", "cancelled"] as WorkItemState[]).includes(workItem.lifecycle_state) ? "closed" : "open";
  return {
    title,
    body,
    state,
    managedLabels,
    managedNames: names,
    ...(queueLabel === undefined ? {} : { queueLabel }),
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

function queueLabelMatches(snapshot: GitHubIssueSnapshot, desired: DesiredProjection): boolean {
  return desired.queueLabel === undefined
    || (snapshot.labels.filter((label) => label.startsWith("queue:")).every((label) => label === desired.queueLabel)
      && snapshot.labels.includes(desired.queueLabel));
}

function bindExistingGithubIssue(
  db: SqliteDatabase,
  input: {
    projectId: string;
    workItem: WorkItemRow;
    github: GithubIssuesConfig;
    mapping: z.infer<typeof githubMappingSchema>;
    issueNumber: number;
    idempotencyKey: string;
    requestDigest: string;
    observed?: GitHubIssueSnapshot;
  },
): ExternalWorkRefRow {
  const existing = externalRef(db, input.projectId, input.workItem.work_item_id);
  if (existing) {
    if (
      existing.owner !== input.mapping.owner ||
      existing.repo !== input.mapping.repo ||
      existing.issue_number !== input.issueNumber
    ) {
      throw refusal("EXTERNAL_REF_CONFLICT", "work item already has a different GitHub issue binding");
    }
    return existing;
  }
  const collision = asRow<{ work_item_id: string }>(db.prepare(
    `SELECT work_item_id FROM external_work_refs
     WHERE provider = 'github' AND owner = ? AND repo = ? AND issue_number = ?
     LIMIT 1`,
  ).get(input.mapping.owner, input.mapping.repo, input.issueNumber));
  if (collision && collision.work_item_id !== input.workItem.work_item_id) {
    throw refusal("EXTERNAL_REF_CONFLICT", "GitHub issue is already bound to another work item");
  }
  const desired = desiredProjection(input.workItem, input.github);
  const observed = input.observed;
  const createdAtMs = now();
  db.prepare(
    `INSERT INTO external_work_refs
      (project_id, work_item_id, provider, owner, repo, issue_number, projection_state,
       attempted_resource_revision, projected_resource_revision, desired_digest,
       observed_external_revision, observed_external_digest, last_idempotency_key,
       last_request_digest, created_at_ms, updated_at_ms)
     VALUES (?, ?, 'github', ?, ?, ?, 'pending', ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.projectId,
    input.workItem.work_item_id,
    input.mapping.owner,
    input.mapping.repo,
    input.issueNumber,
    input.workItem.resource_revision,
    desired.digest,
    observed?.externalRevision ?? null,
    observed ? observedDigest(observed, desired) : null,
    input.idempotencyKey,
    input.requestDigest,
    createdAtMs,
    createdAtMs,
  );
  return externalRef(db, input.projectId, input.workItem.work_item_id)!;
}

function externalRef(db: SqliteDatabase, projectId: string, workItemId: string): ExternalWorkRefRow | undefined {
  return asRow<ExternalWorkRefRow>(
    db.prepare("SELECT * FROM external_work_refs WHERE project_id = ? AND work_item_id = ? AND provider = 'github'").get(projectId, workItemId),
  );
}

const WORK_ITEM_GITHUB_ID = /^wi-gh-([1-9][0-9]*)$/u;

export type WorkItemGithubBackfillState = "attempted" | "completed" | "degraded";
const githubBackfillAttemptReasonSchema = z
  .object({
    kind: z.enum(["initial", "config_revision_changed"]),
    previousConfigRevision: z.number().int().positive().refine(Number.isSafeInteger).nullable(),
  })
  .strict();

export type WorkItemGithubBackfillAttemptReason = z.infer<typeof githubBackfillAttemptReasonSchema>;

export interface WorkItemGithubBackfillOutcome {
  workItemId: string;
  status: "bound" | "already_bound" | "unresolved";
  reason: string;
  issueNumber?: number;
}

export interface WorkItemGithubBackfillResult {
  projectId: string;
  epochCreatedAtMs: number;
  configRevision: number;
  attemptReason: WorkItemGithubBackfillAttemptReason;
  state: WorkItemGithubBackfillState;
  candidates: number;
  bound: number;
  alreadyBound: number;
  unresolved: number;
  outcomes: WorkItemGithubBackfillOutcome[];
}

type StoredWorkItemGithubBackfillResult = Omit<WorkItemGithubBackfillResult, "configRevision" | "attemptReason"> & {
  configRevision?: number;
  attemptReason?: WorkItemGithubBackfillAttemptReason;
};

interface StoredWorkItemGithubBackfillRun {
  result: StoredWorkItemGithubBackfillResult;
  configRevision: number | null;
  attemptReason: "initial" | "config_revision_changed" | null;
}

function parseGithubIssueCandidate(workItemId: string): number | null {
  const match = WORK_ITEM_GITHUB_ID.exec(workItemId);
  if (!match) return null;
  const issueNumber = Number(match[1]);
  return Number.isSafeInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
}

function readGithubBackfillRun(db: SqliteDatabase, projectId: string): StoredWorkItemGithubBackfillRun | null {
  const row = asRow<{ result_json: string; config_revision: number | null; attempt_reason: string | null }>(db.prepare(
    "SELECT result_json, config_revision, attempt_reason FROM work_item_github_backfills WHERE project_id = ?",
  ).get(projectId));
  if (!row) return null;
  try {
    const result = JSON.parse(row.result_json) as StoredWorkItemGithubBackfillResult;
    if (
      result.projectId !== projectId ||
      !Number.isSafeInteger(result.epochCreatedAtMs) ||
      !["attempted", "completed", "degraded"].includes(result.state) ||
      !Array.isArray(result.outcomes) ||
      (result.configRevision !== undefined && (!Number.isSafeInteger(result.configRevision) || result.configRevision < 1)) ||
      (result.attemptReason !== undefined && !githubBackfillAttemptReasonSchema.safeParse(result.attemptReason).success) ||
      (row.config_revision !== null && (!Number.isSafeInteger(row.config_revision) || row.config_revision < 1)) ||
      (row.attempt_reason !== null && !["initial", "config_revision_changed"].includes(row.attempt_reason)) ||
      (result.configRevision !== undefined && result.configRevision !== row.config_revision) ||
      (result.attemptReason !== undefined && result.attemptReason.kind !== row.attempt_reason)
    ) throw new Error("invalid backfill result");
    return { result, configRevision: row.config_revision, attemptReason: row.attempt_reason as StoredWorkItemGithubBackfillRun["attemptReason"] };
  } catch {
    throw new Error("GitHub WorkItem backfill marker is malformed");
  }
}

function persistGithubBackfillRun(db: SqliteDatabase, result: WorkItemGithubBackfillResult): void {
  transaction(db, () => {
    const updated = db.prepare(
      `UPDATE work_item_github_backfills
       SET config_revision = ?, attempt_reason = ?, state = ?, result_json = ?, updated_at_ms = ?
       WHERE project_id = ?`,
    ).run(result.configRevision, result.attemptReason.kind, result.state, canonicalJson(result), now(), result.projectId);
    if (updated.changes !== 1) throw new Error("GitHub WorkItem backfill marker disappeared");
  });
}

function unresolvedBackfillOutcome(workItemId: string, reason: string, issueNumber?: number): WorkItemGithubBackfillOutcome {
  return { workItemId, status: "unresolved", reason, ...(issueNumber === undefined ? {} : { issueNumber }) };
}

export function backfillWorkItemGithubIssues(
  db: SqliteDatabase,
  projectId: string,
  reader: GitHubIssueReader,
  epochCreatedAtMs = now(),
): WorkItemGithubBackfillResult {
  if (!Number.isSafeInteger(epochCreatedAtMs) || epochCreatedAtMs < 0) {
    throw new Error("GitHub WorkItem backfill epoch must be a non-negative safe integer");
  }
  const prepared = transaction(db, () => {
    const config = currentConfig(db, projectId);
    if (!config) throw refusal("PROJECT_CONFIG_REQUIRED", "project has no stored config revision");
    const existing = readGithubBackfillRun(db, projectId);
    if (
      existing?.configRevision === config.config_revision &&
      existing.result.configRevision === config.config_revision &&
      existing.result.attemptReason !== undefined
    ) {
      return { result: existing.result as WorkItemGithubBackfillResult, rows: null as WorkItemRow[] | null };
    }
    const epoch = existing?.result.epochCreatedAtMs ?? epochCreatedAtMs;
    const hasDomainColumns = tableColumns(db, "work_items").includes("domain_id");
    const rows = db.prepare(
      `SELECT project_id, work_item_id, config_revision, repo_target_id, title, ${hasDomainColumns ? "domain_id, task_class," : "'default' AS domain_id, 'default' AS task_class,"} body,
              lifecycle_state, resource_revision, created_at_ms, updated_at_ms
       FROM work_items
       WHERE project_id = ? AND created_at_ms <= ?
       ORDER BY work_item_id`,
    ).all(projectId, epoch) as WorkItemRow[];
    const attemptReason: WorkItemGithubBackfillAttemptReason = existing === null
      ? { kind: "initial", previousConfigRevision: null }
      : { kind: "config_revision_changed", previousConfigRevision: existing.configRevision };
    const result: WorkItemGithubBackfillResult = {
      projectId,
      epochCreatedAtMs: epoch,
      configRevision: config.config_revision,
      attemptReason,
      state: "attempted",
      candidates: rows.length,
      bound: 0,
      alreadyBound: 0,
      unresolved: 0,
      outcomes: [],
    };
    const timestamp = now();
    if (existing === null) {
      db.prepare(
        `INSERT INTO work_item_github_backfills
          (project_id, epoch_created_at_ms, config_revision, attempt_reason, state, result_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, 'attempted', ?, ?, ?)`,
      ).run(projectId, epoch, result.configRevision, result.attemptReason.kind, canonicalJson(result), timestamp, timestamp);
    } else {
      db.prepare(
        `UPDATE work_item_github_backfills
         SET config_revision = ?, attempt_reason = ?, state = 'attempted', result_json = ?, updated_at_ms = ?
         WHERE project_id = ?`,
      ).run(result.configRevision, result.attemptReason.kind, canonicalJson(result), timestamp, projectId);
    }
    return { result, rows };
  });
  if (prepared.rows === null) return prepared.result;

  let result = prepared.result;
  for (const row of prepared.rows) {
    const issueNumber = parseGithubIssueCandidate(row.work_item_id);
    if (issueNumber === null) {
      const outcome = unresolvedBackfillOutcome(row.work_item_id, "work_item_id_not_github_issue");
      result = { ...result, unresolved: result.unresolved + 1, outcomes: [...result.outcomes, outcome] };
      persistGithubBackfillRun(db, result);
      continue;
    }

    let mapping: ReturnType<typeof requireGithubMapping>;
    try {
      mapping = requireGithubMapping(db, row.project_id, result.configRevision, row.repo_target_id);
    } catch (error) {
      const reason = error instanceof Refusal ? error.data.code.toLowerCase() : "github_mapping_unreadable";
      const outcome = unresolvedBackfillOutcome(row.work_item_id, reason, issueNumber);
      result = { ...result, unresolved: result.unresolved + 1, outcomes: [...result.outcomes, outcome] };
      persistGithubBackfillRun(db, result);
      continue;
    }

    const existing = externalRef(db, row.project_id, row.work_item_id);
    if (existing) {
      const matches = existing.owner === mapping.mapping.owner && existing.repo === mapping.mapping.repo && existing.issue_number === issueNumber;
      const outcome = matches
        ? { workItemId: row.work_item_id, status: "already_bound" as const, reason: "existing_exact_binding", issueNumber }
        : unresolvedBackfillOutcome(row.work_item_id, "external_ref_conflict", issueNumber);
      result = matches
        ? { ...result, alreadyBound: result.alreadyBound + 1, outcomes: [...result.outcomes, outcome] }
        : { ...result, unresolved: result.unresolved + 1, outcomes: [...result.outcomes, outcome] };
      persistGithubBackfillRun(db, result);
      continue;
    }

    let snapshot: GitHubIssueSnapshot | null;
    try {
      snapshot = reader(mapping.mapping.owner, mapping.mapping.repo, issueNumber);
    } catch {
      const outcome = unresolvedBackfillOutcome(row.work_item_id, "github_issue_unreadable", issueNumber);
      result = { ...result, unresolved: result.unresolved + 1, outcomes: [...result.outcomes, outcome] };
      persistGithubBackfillRun(db, result);
      continue;
    }
    if (snapshot === null) {
      const outcome = unresolvedBackfillOutcome(row.work_item_id, "github_issue_missing", issueNumber);
      result = { ...result, unresolved: result.unresolved + 1, outcomes: [...result.outcomes, outcome] };
      persistGithubBackfillRun(db, result);
      continue;
    }
    if (
      snapshot.owner !== mapping.mapping.owner ||
      snapshot.repo !== mapping.mapping.repo ||
      snapshot.issueNumber !== issueNumber
    ) {
      const outcome = unresolvedBackfillOutcome(row.work_item_id, "github_issue_identity_mismatch", issueNumber);
      result = { ...result, unresolved: result.unresolved + 1, outcomes: [...result.outcomes, outcome] };
      persistGithubBackfillRun(db, result);
      continue;
    }

    try {
      transaction(db, () => {
        bindExistingGithubIssue(db, {
          projectId: row.project_id,
          workItem: row,
          github: mapping.github,
          mapping: mapping.mapping,
          issueNumber,
          idempotencyKey: `github-issue-backfill:${JSON.stringify([projectId, row.work_item_id])}`,
          requestDigest: sha256(canonicalJson({ projectId, workItemId: row.work_item_id, epochCreatedAtMs: result.epochCreatedAtMs, configRevision: result.configRevision })),
          observed: snapshot!,
        });
      });
      const outcome: WorkItemGithubBackfillOutcome = { workItemId: row.work_item_id, status: "bound", reason: "verified_existing_issue", issueNumber };
      result = { ...result, bound: result.bound + 1, outcomes: [...result.outcomes, outcome] };
    } catch (error) {
      const reason = error instanceof Refusal ? error.data.code.toLowerCase() : "external_ref_bind_failed";
      const outcome = unresolvedBackfillOutcome(row.work_item_id, reason, issueNumber);
      result = { ...result, unresolved: result.unresolved + 1, outcomes: [...result.outcomes, outcome] };
    }
    persistGithubBackfillRun(db, result);
  }
  result = { ...result, state: result.unresolved === 0 ? "completed" : "degraded" };
  persistGithubBackfillRun(db, result);
  return result;
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
  const workItem = requireWorkItem(db, request, configRevision, undefined, true);
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
    const workItem = requireWorkItem(db, request, configRevision, undefined, true);
    const { github, mapping } = requireGithubMapping(db, request.projectId, configRevision, workItem.repo_target_id);
    if (adapter.connectorHost !== mapping.connectorHost) throw refusal("EXTERNAL_TARGET_MISMATCH", "GitHub connector host does not match the exact mapping");
    const wait = asRow<WorkItemWaitRow>(db.prepare(
      "SELECT * FROM work_item_waits WHERE project_id = ? AND work_item_id = ?",
    ).get(request.projectId, workItem.work_item_id));
    const blocker = wait ? storedWorkItemBlocker(wait) : null;
    const desired = desiredProjection(workItem, github, blocker ? workItemBlockerWaker(blocker) : null, request.queueLabel);
    let ref = externalRef(db, request.projectId, workItem.work_item_id);
    if (ref) {
      if (ref.project_id !== request.projectId || ref.work_item_id !== workItem.work_item_id || ref.provider !== "github") {
        throw refusal("EXTERNAL_REF_FOREIGN", "external ref belongs to another canonical resource");
      }
      if (ref.owner !== mapping.owner || ref.repo !== mapping.repo) {
        throw refusal("EXTERNAL_REF_CONFLICT", "external ref conflicts with the exact repository mapping");
      }
      const recoveryEvidence = request.projectionRecoveryEvidence;
      if (recoveryEvidence !== undefined && (
        ref.issue_number === null ||
        recoveryEvidence.owner !== ref.owner ||
        recoveryEvidence.repo !== ref.repo ||
        recoveryEvidence.issueNumber !== ref.issue_number
      )) {
        throw refusal("EXTERNAL_RESPONSE_INVALID", "projection recovery evidence does not name the exact bound issue");
      }
      if (ref.projection_state === "pending" && ref.issue_number === null) {
        throw refusal("EXTERNAL_DELIVERY_AMBIGUOUS", "external delivery is durably fenced", { expected: 1, attempted: 0, verified: 0 });
      }
      if (ref.projection_state === "delivery_ambiguous" && recoveryEvidence === undefined) {
        throw refusal("EXTERNAL_DELIVERY_AMBIGUOUS", "external delivery is durably fenced", { expected: 1, attempted: 0, verified: 0 });
      }
      if (ref.projection_state === "drifted" && recoveryEvidence === undefined) {
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
      appendStateEvent(db, request, digest, actorReceiptId, {
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

function recoverAmbiguousProjection(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  context: ProjectionContext,
  adapter: GitHubIssueAdapter,
): FoundationResult {
  const evidence = request.projectionRecoveryEvidence;
  if (evidence === undefined) {
    return refusalResult(request.projectId, {
      code: context.ref.projection_state === "drifted" ? "EXTERNAL_DIVERGED" : "EXTERNAL_DELIVERY_AMBIGUOUS",
      message: context.ref.projection_state === "drifted" ? "external issue is marked drifted" : "external delivery is durably fenced",
      expected: 1,
      attempted: 0,
      verified: 0,
    });
  }
  if (context.ref.projection_state === "drifted") {
    if (evidence.kind !== "github_issue_observed") {
      return refusalResult(request.projectId, {
        code: "EXTERNAL_RESPONSE_INVALID",
        message: "drift re-baseline requires an observed external issue evidence kind",
        expected: 1,
        attempted: 0,
        verified: 0,
      });
    }
    let snapshot: GitHubIssueSnapshot;
    try {
      const value = adapter.read(evidence.owner, evidence.repo, evidence.issueNumber);
      if (value === null) return result("EXTERNAL_RESPONSE_INVALID", request.projectId, 1, 1, 0, { message: "projection re-baseline issue observation was not found" });
      snapshot = parseSnapshot(value);
    } catch (error) {
      if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
      return result("EXTERNAL_RESPONSE_INVALID", request.projectId, 1, 1, 0, { message: "projection re-baseline issue observation is invalid" });
    }
    if (
      snapshot.owner !== evidence.owner ||
      snapshot.repo !== evidence.repo ||
      snapshot.issueNumber !== evidence.issueNumber ||
      snapshot.externalRevision !== evidence.externalRevision
    ) {
      return result("EXTERNAL_RESPONSE_INVALID", request.projectId, 1, 1, 0, { message: "projection re-baseline observation does not match the exact external revision" });
    }
    const observed = observedDigest(snapshot, context.desired);
    return transaction(db, () => {
      const replay = checkIdempotency(db, request, digest);
      if (replay) return replay;
      const authority = revalidateProjectionContext(db, request, context);
      // ponytail: external adapters have no CAS; the final revision read bounds the race to the post-read local write window.
      let latest: GitHubIssueSnapshot;
      try {
        const value = adapter.read(evidence.owner, evidence.repo, evidence.issueNumber);
        if (value === null) return result("EXTERNAL_RESPONSE_INVALID", request.projectId, 1, 1, 0, { message: "projection re-baseline issue observation was not found" });
        latest = parseSnapshot(value);
      } catch (error) {
        if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
        return result("EXTERNAL_RESPONSE_INVALID", request.projectId, 1, 1, 0, { message: "projection re-baseline issue observation is invalid" });
      }
      if (
        latest.owner !== snapshot.owner ||
        latest.repo !== snapshot.repo ||
        latest.issueNumber !== snapshot.issueNumber ||
        latest.externalRevision !== snapshot.externalRevision
      ) {
        return result("EXTERNAL_RESPONSE_INVALID", request.projectId, 1, 1, 0, { message: "external issue changed after the re-baseline observation" });
      }
      const updated = db.prepare(
        `UPDATE external_work_refs SET projection_state = 'pending', attempted_resource_revision = ?,
         desired_digest = ?, observed_external_revision = ?, observed_external_digest = ?,
         last_idempotency_key = ?, last_request_digest = ?, updated_at_ms = ?
         WHERE ${EXTERNAL_REF_CAS_WHERE}`,
      ).run(
        authority.workItem.resource_revision,
        context.desired.digest,
        snapshot.externalRevision,
        observed,
        request.idempotencyKey,
        digest,
        now(),
        ...externalRefCasArgs(context.ref),
      );
      if (updated.changes !== 1) throw refusal("EXTERNAL_REF_CONFLICT", "external ref re-baseline lost its compare-and-swap race");
      return commitMutation(
        db,
        request,
        digest,
        authority.actorReceiptId,
        {
          aggregateType: "external_work_ref",
          aggregateId: authority.workItem.work_item_id,
          aggregateRevision: authority.workItem.resource_revision,
          eventType: "github_issue_projection_rebased",
          event: {
            workItemId: authority.workItem.work_item_id,
            provider: "github",
            from: "drifted",
            to: "pending",
            resolution: "external_observation_rebaselined",
            observation: evidence,
          },
        },
        { expected: 1, attempted: 1, verified: 1 },
        {
          currentConfigRevision: authority.configRevision,
          currentGovernanceEpoch: authority.governor.governance_epoch,
          currentResourceRevision: authority.workItem.resource_revision,
          expectedResourceRevision: request.expectedResourceRevision ?? undefined,
          evidence: { projectionState: "pending", resolution: "external_observation_rebaselined", observation: evidence, observedDigest: observed },
        },
      );
    });
  }
  if (context.ref.projection_state !== "delivery_ambiguous") {
    return refusalResult(request.projectId, {
      code: "EXTERNAL_DELIVERY_AMBIGUOUS",
      message: "external delivery is durably fenced",
      expected: 1,
      attempted: 0,
      verified: 0,
    });
  }
  if (evidence.kind !== "github_issue_unchanged") {
    return refusalResult(request.projectId, {
      code: "EXTERNAL_RESPONSE_INVALID",
      message: "delivery recovery requires an unchanged external issue evidence kind",
      expected: 1,
      attempted: 0,
      verified: 0,
    });
  }
  if (
    context.ref.issue_number === null ||
    context.ref.observed_external_revision === null ||
    context.ref.observed_external_digest === null
  ) {
    return refusalResult(request.projectId, {
      code: "EXTERNAL_RESPONSE_INVALID",
      message: "projection recovery evidence does not name the exact previously verified issue observation",
      expected: 1,
      attempted: 0,
      verified: 0,
    });
  }

  let snapshot: GitHubIssueSnapshot;
  try {
    const value = adapter.read(evidence.owner, evidence.repo, evidence.issueNumber);
    if (value === null) return result("EXTERNAL_RESPONSE_INVALID", request.projectId, 1, 1, 0, { message: "projection recovery issue observation was not found" });
    snapshot = parseSnapshot(value);
  } catch (error) {
    if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
    return result("EXTERNAL_RESPONSE_INVALID", request.projectId, 1, 1, 0, { message: "projection recovery issue observation is invalid" });
  }
  if (
    snapshot.owner !== evidence.owner ||
    snapshot.repo !== evidence.repo ||
    snapshot.issueNumber !== evidence.issueNumber ||
    snapshot.externalRevision !== evidence.externalRevision ||
    evidence.externalRevision !== context.ref.observed_external_revision
  ) {
    return result("EXTERNAL_RESPONSE_INVALID", request.projectId, 1, 1, 0, { message: "projection recovery observation does not match the exact external revision" });
  }
  const observed = observedDigest(snapshot, context.desired);
  if (observed !== context.ref.observed_external_digest || observed === context.desired.digest) {
    return result("EXTERNAL_RESPONSE_INVALID", request.projectId, 1, 1, 0, { message: "projection recovery observation does not prove the attempted write did not land" });
  }

  return transaction(db, () => {
    const replay = checkIdempotency(db, request, digest);
    if (replay) return replay;
    const authority = revalidateProjectionContext(db, request, context);
    const updated = db.prepare(
      `UPDATE external_work_refs SET projection_state = 'pending', attempted_resource_revision = ?,
       desired_digest = ?, last_idempotency_key = ?, last_request_digest = ?, updated_at_ms = ?
       WHERE ${EXTERNAL_REF_CAS_WHERE}`,
    ).run(
      authority.workItem.resource_revision,
      context.desired.digest,
      request.idempotencyKey,
      digest,
      now(),
      ...externalRefCasArgs(context.ref),
    );
    if (updated.changes !== 1) throw refusal("EXTERNAL_REF_CONFLICT", "external ref recovery lost its compare-and-swap race");
    return commitMutation(
      db,
      request,
      digest,
      authority.actorReceiptId,
      {
        aggregateType: "external_work_ref",
        aggregateId: authority.workItem.work_item_id,
        aggregateRevision: authority.workItem.resource_revision,
        eventType: "github_issue_projection_recovered",
        event: {
          workItemId: authority.workItem.work_item_id,
          provider: "github",
          from: "delivery_ambiguous",
          to: "pending",
          resolution: "external_write_not_observed",
          observation: evidence,
        },
      },
      { expected: 1, attempted: 1, verified: 1 },
      {
        currentConfigRevision: authority.configRevision,
        currentGovernanceEpoch: authority.governor.governance_epoch,
        currentResourceRevision: authority.workItem.resource_revision,
        expectedResourceRevision: request.expectedResourceRevision ?? undefined,
        evidence: { projectionState: "pending", resolution: "external_write_not_observed", observation: evidence, observedDigest: observed },
      },
    );
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
    appendStateEvent(db, request, digest, context.actorReceiptId, {
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
  observation?: GitHubIssueSnapshot,
): FoundationResult {
  return transaction(db, () => {
    const replay = checkIdempotency(db, request, digest);
    if (replay) return replay;
    const authority = revalidateProjectionContext(db, request, context);
    const observed = observation === undefined ? null : observedDigest(observation, context.desired);
    const updated = db.prepare(
      `UPDATE external_work_refs SET issue_number = COALESCE(?, issue_number), projection_state = ?,
       attempted_resource_revision = ?, desired_digest = ?, observed_external_revision = COALESCE(?, observed_external_revision),
       observed_external_digest = COALESCE(?, observed_external_digest), last_idempotency_key = ?, last_request_digest = ?, updated_at_ms = ?
       WHERE ${EXTERNAL_REF_CAS_WHERE}`,
    ).run(
      observation?.issueNumber ?? null,
      state,
      context.workItem.resource_revision,
      context.desired.digest,
      observation?.externalRevision ?? null,
      observed,
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
      (mutationKind === "verify" && !["current", "pending"].includes(context.ref.projection_state)) ||
      (mutationKind !== "verify" &&
        (context.ref.projection_state !== "pending" ||
          context.ref.last_idempotency_key !== request.idempotencyKey ||
          context.ref.last_request_digest !== digest))
    ) {
      throw refusal("EXTERNAL_REF_CONFLICT", "external reservation changed before projection finalization");
    }
    const observed = observedDigest(snapshot, context.desired);
    if (observed !== context.desired.digest) throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub read-back does not match the desired projection");
    if (!queueLabelMatches(snapshot, context.desired)) {
      throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub read-back does not contain the required dispatch queue label");
    }
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
  if (request.projectionRecoveryEvidence !== undefined) return recoverAmbiguousProjection(db, request, digest, context, adapter);

  let mutation: GitHubIssueMutation;
  let observation: GitHubIssueSnapshot | undefined;
  if (context.ref.issue_number === null) {
    mutation = {
      kind: "create",
      owner: context.mapping.owner,
      repo: context.mapping.repo,
      title: context.desired.title,
      body: context.desired.body,
      state: context.desired.state,
      addLabels: [...context.desired.managedLabels, ...(context.desired.queueLabel === undefined ? [] : [context.desired.queueLabel])],
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
    observation = current;
   if (current.owner !== context.mapping.owner || current.repo !== context.mapping.repo || current.issueNumber !== context.ref.issue_number) {
      return result("EXTERNAL_TARGET_MISMATCH", request.projectId, 1, 1, 0, { message: "the GitHub issue response has the wrong exact identity" });
    }
    const initialBinding = context.ref.projection_state === "pending" && context.ref.issue_number !== null && context.ref.observed_external_digest === null;
    if (!initialBinding && (!context.ref.observed_external_digest || observedDigest(current, context.desired) !== context.ref.observed_external_digest)) {
      try {
        return recordProjectionState(db, request, digest, context, "drifted", "EXTERNAL_DIVERGED", { expected: 1, attempted: 1, verified: 0 }, "the GitHub issue diverged from its last verified projection");
      } catch {
        return result("EXTERNAL_DIVERGED", request.projectId, 1, 1, 0, { message: "the GitHub issue diverged from its last verified projection" });
      }
    }
    if (observedDigest(current, context.desired) === context.desired.digest && queueLabelMatches(current, context.desired)) {
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
    const queueLabelsToRemove = context.desired.queueLabel === undefined
      ? []
      : current.labels.filter((label) => label.startsWith("queue:") && label !== context.desired.queueLabel);
    mutation = {
      kind: "update",
      owner: context.mapping.owner,
      repo: context.mapping.repo,
      issueNumber: context.ref.issue_number!,
      title: context.desired.title,
      body: context.desired.body,
      state: context.desired.state,
      addLabels: [
        ...context.desired.managedLabels.filter((label) => !currentLabels.has(label)),
        ...(context.desired.queueLabel !== undefined && !currentLabels.has(context.desired.queueLabel) ? [context.desired.queueLabel] : []),
      ],
      removeLabels: [
        ...current.labels.filter((label) => context.desired.managedNames.has(label) && !context.desired.managedLabels.includes(label)),
        ...queueLabelsToRemove,
      ],
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
    observation = readBack;
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
        observation,
      );
    } catch {
      return result("EXTERNAL_DELIVERY_AMBIGUOUS", request.projectId, 1, 1, 0, { message: "GitHub delivery or local finalization could not be proven" });
    }
  }
}

async function applyGithubIssueProjectionAsync(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  adapter: GitHubIssueAdapter,
): Promise<FoundationResult> {
  if (request.projectionRecoveryEvidence !== undefined) return applyGithubIssueProjection(db, request, digest, adapter);
  if (!adapter.readAsync || !adapter.mutateAsync) return applyGithubIssueProjection(db, request, digest, adapter);
  try {
    const replay = checkIdempotency(db, request, digest);
    if (replay) return replay;
  } catch (error) {
    if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
    return result("INTERNAL_ERROR", request.projectId, 1, 0, 0, { message: "internal mutation error" });
  }
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
  let observation: GitHubIssueSnapshot | undefined;
  if (context.ref.issue_number === null) {
    mutation = {
      kind: "create",
      owner: context.mapping.owner,
      repo: context.mapping.repo,
      title: context.desired.title,
      body: context.desired.body,
      state: context.desired.state,
      addLabels: [...context.desired.managedLabels, ...(context.desired.queueLabel === undefined ? [] : [context.desired.queueLabel])],
      removeLabels: [],
    };
  } else {
    let current: GitHubIssueSnapshot | null;
    try {
      current = await adapter.readAsync(context.mapping.owner, context.mapping.repo, context.ref.issue_number);
      if (current === null) return result("EXTERNAL_NOT_FOUND", request.projectId, 1, 1, 0, { message: "the bound GitHub issue was not found" });
      current = parseSnapshot(current);
    } catch (error) {
      if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
      return result("EXTERNAL_UNAVAILABLE", request.projectId, 1, 1, 0, { message: "the bound GitHub issue could not be read" });
    }
    observation = current;
    if (current.owner !== context.mapping.owner || current.repo !== context.mapping.repo || current.issueNumber !== context.ref.issue_number) {
      return result("EXTERNAL_TARGET_MISMATCH", request.projectId, 1, 1, 0, { message: "the GitHub issue response has the wrong exact identity" });
    }
    const initialBinding = context.ref.projection_state === "pending" && context.ref.issue_number !== null && context.ref.observed_external_digest === null;
    if (!initialBinding && (!context.ref.observed_external_digest || observedDigest(current, context.desired) !== context.ref.observed_external_digest)) {
      try {
        return recordProjectionState(db, request, digest, context, "drifted", "EXTERNAL_DIVERGED", { expected: 1, attempted: 1, verified: 0 }, "the GitHub issue diverged from its last verified projection");
      } catch {
        return result("EXTERNAL_DIVERGED", request.projectId, 1, 1, 0, { message: "the GitHub issue diverged from its last verified projection" });
      }
    }
    if (observedDigest(current, context.desired) === context.desired.digest && queueLabelMatches(current, context.desired)) {
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
    const queueLabelsToRemove = context.desired.queueLabel === undefined
      ? []
      : current.labels.filter((label) => label.startsWith("queue:") && label !== context.desired.queueLabel);
    mutation = {
      kind: "update",
      owner: context.mapping.owner,
      repo: context.mapping.repo,
      issueNumber: context.ref.issue_number!,
      title: context.desired.title,
      body: context.desired.body,
      state: context.desired.state,
      addLabels: [
        ...context.desired.managedLabels.filter((label) => !currentLabels.has(label)),
        ...(context.desired.queueLabel !== undefined && !currentLabels.has(context.desired.queueLabel) ? [context.desired.queueLabel] : []),
      ],
      removeLabels: [
        ...current.labels.filter((label) => context.desired.managedNames.has(label) && !context.desired.managedLabels.includes(label)),
        ...queueLabelsToRemove,
      ],
    };
  }

  try {
    const mutationResponse = parseSnapshot(await adapter.mutateAsync(mutation));
    if (
      mutationResponse.owner !== mutation.owner ||
      mutationResponse.repo !== mutation.repo ||
      (mutation.issueNumber !== undefined && mutationResponse.issueNumber !== mutation.issueNumber)
    ) throw new GitHubIssueAdapterError("ambiguous");
    const readBackValue = await adapter.readAsync(mutation.owner, mutation.repo, mutationResponse.issueNumber);
    if (readBackValue === null) throw new GitHubIssueAdapterError("ambiguous");
    const readBack = parseSnapshot(readBackValue);
    if (readBack.owner !== mutation.owner || readBack.repo !== mutation.repo || readBack.issueNumber !== mutationResponse.issueNumber) {
      throw new GitHubIssueAdapterError("ambiguous");
    }
    observation = readBack;
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
        observation,
      );
    } catch {
      return result("EXTERNAL_DELIVERY_AMBIGUOUS", request.projectId, 1, 1, 0, { message: "GitHub delivery or local finalization could not be proven" });
    }
  }
}

type AssignmentIntent = z.infer<typeof assignmentIntentSchema>;
export type TerminalReport = z.infer<typeof terminalReportSchema>;

function requireAssignmentWritingCapacity(requirement: RoleRequirement, assignmentKind: AssignmentIntent["assignmentKind"]): void {
  if (assignmentKind === "write" && requirement.writingLaneCapacity === 0) {
    throw refusal("LANE_WRITER_EXISTS", "role requirement has no writing-lane capacity", { expected: 0, attempted: 0, verified: 0 });
  }
}

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
  origin: "assignment" | "role_holder" | "legacy_unresolved" | "work_item";
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
  state: "prepared" | "armed" | "content_delivered" | "running" | "done" | "blocked" | "failed" | "interrupted" | "dispatch_unknown";
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
  completion_event_id: string | null;
  completion_event_seq: number | null;
  content_receipt_digest: string | null;
  frozen_brief_digest: string | null;
  environment_digest: string | null;
  requested_provider_id: string | null;
  requested_model: string | null;
  requested_reasoning_level: string | null;
  requested_permission_mode: string | null;
  requested_service_tier: string | null;
  requested_visibility: "visible" | "hidden" | null;
  native_receipt_digest: string | null;
  requested_profile_digest: string | null;
  candidate_sha: string | null;
  terminal_result: "DONE" | "BLOCKED" | null;
  reported_outcome: "DONE" | "BLOCKED" | null;
  terminal_report_digest: string | null;
  terminalization_class: string | null;
  terminal_report_json: string | null;
  terminal_actual_profile_digest: string | null;
  interruption_reason: string | null;
  interruption_event_id: string | null;
  interruption_event_seq: number | null;
  interruption_turn_id: string | null;
  interruption_evidence_digest: string | null;
  conflicting_terminal_digest: string | null;
  terminal_event_id: string | null;
  terminal_event_seq: number | null;
  lease_owner_thread_id: string | null;
  lease_expires_at_ms: number | null;
  completed_at_ms: number | null;
  reason_code: string | null;
  last_event_seq: number | null;
  attempt_digest: string;
}

const NATIVE_EVIDENCE_COLUMNS = [
  "thread_id", "provider_thread_id", "native_request_id",
  "request_event_id", "request_event_seq", "accepted_event_id", "accepted_event_seq",
  "first_action_event_id", "first_action_event_seq", "content_event_id", "content_event_seq",
  "content_receipt_digest", "requested_provider_id", "requested_model", "requested_reasoning_level",
  "requested_permission_mode", "requested_service_tier", "requested_visibility", "requested_profile_digest",
  "native_receipt_digest", "last_event_seq",
] as const;
type NativeEvidenceColumn = (typeof NATIVE_EVIDENCE_COLUMNS)[number];
type NativeEvidenceSnapshot = Record<NativeEvidenceColumn, string | number | null>;

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique|busy|locked/iu.test(error.message);
}

function unavailableResult(subject: string, message: string): FoundationResult {
  return result("CANONICAL_STORE_UNAVAILABLE", subject, 1, 0, 0, { message });
}

export function applyAuthorizedMutation(
  db: SqliteDatabase | null,
  input: unknown,
  githubAdapter: GitHubIssueAdapter | null = null,
  roleFactReader: RoleFactReader | null = null,
  nativeAssignmentAdapter: NativeAssignmentAdapter | null = null,
  reviewFactReader: ReviewFactReader | null = null,
  githubIssueReader: GitHubIssueReader | null = null,
  executionAttemptEvidenceReader: ExecutionAttemptEvidenceReader | null = null,
  dryRun = false,
  authenticatedNativeCaller: AuthenticatedNativeCaller | null = null,
): FoundationResult {
  let request: ApplyRequest;
  try {
    request = parseApplyRequest(input);
  } catch (error) {
    if (error instanceof Refusal) return refusalResult("apply", error.data);
    return result("INVALID_INPUT", "apply", 1, 0, 0, { message: String(error) });
  }
  if (!db) return unavailableResult(request.projectId, "canonical SQLite store is unavailable");
  return applyFixtureMutation(db, request, githubAdapter, roleFactReader, nativeAssignmentAdapter, reviewFactReader, githubIssueReader, executionAttemptEvidenceReader, dryRun, authenticatedNativeCaller);
}

export async function applyAuthorizedMutationAsync(
  db: SqliteDatabase | null,
  input: unknown,
  githubAdapter: GitHubIssueAdapter | null = null,
  roleFactReader: RoleFactReader | null = null,
  nativeAssignmentAdapter: NativeAssignmentAdapter | null = null,
  reviewFactReader: ReviewFactReader | null = null,
  githubIssueReader: GitHubIssueReader | null = null,
  executionAttemptEvidenceReader: ExecutionAttemptEvidenceReader | null = null,
  dryRun = false,
): Promise<FoundationResult> {
  let request: ApplyRequest;
  try {
    request = parseApplyRequest(input);
  } catch (error) {
    if (error instanceof Refusal) return refusalResult("apply", error.data);
    return result("INVALID_INPUT", "apply", 1, 0, 0, { message: String(error) });
  }
  if (!db) return unavailableResult(request.projectId, "canonical SQLite store is unavailable");
  if (request.operationClass !== "github_issue_projection" || !githubAdapter?.readAsync || !githubAdapter.mutateAsync) {
    return applyFixtureMutation(db, request, githubAdapter, roleFactReader, nativeAssignmentAdapter, reviewFactReader, githubIssueReader, executionAttemptEvidenceReader, dryRun);
  }
  try {
    return await applyGithubIssueProjectionAsync(db, request, mutationRequestDigest(request), githubAdapter);
  } catch (error) {
    if (error instanceof Refusal) return refusalResult(request.projectId, error.data);
    return result("INTERNAL_ERROR", request.projectId, 1, 0, 0, { message: "internal mutation error" });
  }
}

export function applyFixtureMutation(
  db: SqliteDatabase | null,
  input: unknown,
  githubAdapter: GitHubIssueAdapter | null = null,
  roleFactReader: RoleFactReader | null = null,
  nativeAssignmentAdapter: NativeAssignmentAdapter | null = null,
  reviewFactReader: ReviewFactReader | null = null,
  githubIssueReader: GitHubIssueReader | null = null,
  executionAttemptEvidenceReader: ExecutionAttemptEvidenceReader | null = null,
  dryRun = false,
  authenticatedNativeCaller: AuthenticatedNativeCaller | null = null,
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
    const digest = mutationRequestDigest(request);
    if (request.operationClass === "github_issue_projection") {
      return applyGithubIssueProjection(db, request, digest, githubAdapter);
    }
    if (request.operationClass === "qualification_observation_record" || request.operationClass === "role_generation_succession") {
      return applyRoleMutation(db, request, digest, roleFactReader);
    }
    if (request.operationClass === "decision_disposition") {
      return applyDecisionMutation(db, request, digest, reviewFactReader);
    }
    const githubTargets = request.operationClass === "work_item_transition"
      ? workItemGithubReadTarget(request)
      : [];
    let githubObservation: GitHubIssueSnapshot | null = null;
    if (githubTargets.length > 0) {
      const replay = checkIdempotency(db, request, digest);
      if (replay) return replay;
      const reader = githubIssueReader ?? (githubAdapter ? githubAdapter.read.bind(githubAdapter) : null);
      if (!reader) throw refusal("EXTERNAL_TARGET_REQUIRED", "work item transition requires a live GitHub issue reader");
      const observations = githubTargets.map((target) => {
        let observation: GitHubIssueSnapshot | null;
        try {
          observation = reader(target.owner, target.repo, target.issueNumber);
        } catch {
          throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub issue observation is unavailable");
        }
        if (
          !observation ||
          observation.owner !== target.owner ||
          observation.repo !== target.repo ||
          observation.issueNumber !== target.issueNumber
        ) throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub issue observation does not match the exact blocker identity");
        return observation;
      });
      const replacement = request.workItemWait && request.workItemWait.kind === "github_issue_closed"
        ? request.workItemWait
        : request.workItemExternalEvent;
      githubObservation = replacement && replacement.kind === "github_issue_closed"
        ? observations.find((observation) => observation.owner === replacement.owner && observation.repo === replacement.repo && observation.issueNumber === replacement.issueNumber) ?? null
        : observations[0] ?? null;
    }
    const mutate = () => {
      const nativeSeat = resolveAuthenticatedNativeSeat(db, request, authenticatedNativeCaller);
      const replay = checkIdempotency(db, request, digest);
      if (replay) return replay;
      switch (request.operationClass) {
        case "bootstrap":
          return applyBootstrap(db, request, digest);
        case "config_revision":
          return applyConfigRevision(db, request, digest);
        case "governor_claim":
          return applyGovernorClaim(db, request, digest);
        case "migration_prepare":
          return applyMigrationPrepare(db, request, digest);
        case "migration_step":
          return applyMigrationStep(db, request, digest);
        case "decision_create":
          return applyDecisionCreate(db, request, digest);
        case "decision_disposition":
          throw refusal("INTERNAL_ERROR", "decision disposition must use the Decision resolver");
        case "work_item_create":
          return applyWorkItemCreate(db, request, digest);
        case "work_item_transition":
          return applyWorkItemTransition(db, request, digest, githubObservation, request.githubPrObservation, nativeSeat);
        case "github_pr_observation_record":
          return applyGithubPrObservation(db, request, digest);
        case "execution_attempt_terminal_report":
          return applyExecutionAttemptTerminalReport(db, request, digest, executionAttemptEvidenceReader, nativeSeat);
        case "execution_attempt_interruption":
          return applyExecutionAttemptInterruption(db, request, digest, executionAttemptEvidenceReader);
        case "github_issue_projection":
          throw refusal("INTERNAL_ERROR", "projection must not run inside the canonical transaction");
        case "qualification_observation_record":
        case "role_generation_succession":
          throw refusal("INTERNAL_ERROR", "role fact operations must not run inside the canonical transaction");
      }
    };
    if (!dryRun) return transaction(db, mutate);
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = mutate();
      db.exec("ROLLBACK");
      return value;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve refusal */ }
      throw error;
    }
  } catch (error) {
    if (error instanceof Refusal) {
      const refused = refusalResult(request.projectId, error.data);
      const isPrRegistration = request.operationClass === "work_item_transition" && request.lifecycleState === "blocked" && isGithubPrWait(request.workItemWait);
      return isPrRegistration ? { ...refused, registration: "refused" } : refused;
    }
    if (isConstraintError(error)) return result("CANONICAL_STORE_UNAVAILABLE", request.projectId, 1, 0, 0, { message: String(error) });
    return result("INTERNAL_ERROR", request.projectId, 1, 0, 0, { message: "internal mutation error" });
  }
}

function tableRows(db: SqliteDatabase, table: (typeof TABLES)[number], projectId: string, offset: number): Record<string, unknown>[] {
  const orderBy: Record<(typeof TABLES)[number], string> = {
    project_config_revisions: "config_revision",
    project_config_heads: "project_id",
    orchestration_domains: "config_revision, domain_id",
    repository_targets: "repo_target_id, config_revision",
    project_governorships: "governance_epoch",
    project_governorship_heads: "project_id",
    migration_runs: "migration_id",
    actor_receipts: "receipt_id",
    bootstrap_derivation_receipts: "derivation_id",
    operator_receipts: "receipt_id",
    authorized_approvers: "approver_id, authorizing_decision_id, authorizing_disposition_sequence",
    decisions: "decision_id",
    decision_dispositions: "decision_dispositions.decision_id, decision_dispositions.disposition_sequence",
    evidence_artifacts: "evidence_id",
    decision_evidence: "decision_evidence.decision_id, decision_evidence.evidence_sequence",
    mutation_receipts: "idempotency_key",
    state_events: "event_sequence",
    work_items: "work_item_id",
    work_item_waits: "work_item_id",
    external_work_refs: "work_item_id, provider",
    work_item_github_backfills: "project_id",
    qualification_observations: "qualification_id",
    eligibility_projections: "role_requirement_id, requested_profile_digest",
    assignments: "assignment_id",
    execution_attempts: "execution_attempt_id",
    role_generations: "role_id, generation",
    role_generation_heads: "role_id, domain_id",
    lane_capacity_intervals: "interval_id",
    lane_capacity_refresh_evidence: "lane_capacity_observation_id, execution_attempt_id",
    operator_messages: "message_id",
  };
  const query =
    table === "decision_dispositions" || table === "decision_evidence"
      ? `SELECT ${table}.* FROM ${table}
         JOIN decisions ON decisions.decision_id = ${table}.decision_id
         WHERE decisions.project_id = ? ORDER BY ${orderBy[table]} LIMIT ? OFFSET ?`
      : `SELECT * FROM ${table} WHERE project_id = ? ORDER BY ${orderBy[table]} LIMIT ? OFFSET ?`;
  return db.prepare(query).all(projectId, MAX_EXPORT_ROWS, offset) as Record<string, unknown>[];
}

function writeFoundationExportFiles(db: SqliteDatabase, projectId: string, payload: ExportPayload): ExportFilePayload | null {
  const root = exportRootDirectory(db);
  if (!root) return null;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = join(root, `complete-${sha256(projectId).slice(0, 12)}-${payload.manifest.exportRootDigest}`);
  const matches = () =>
    sha256(readFileSync(join(directory, "records.ndjson"), "utf8")) === payload.checksums["records.ndjson"] &&
    sha256(readFileSync(join(directory, "artifact-index.json"), "utf8")) === payload.checksums["artifact-index.json"] &&
    sha256(readFileSync(join(directory, "manifest.json"), "utf8")) === payload.checksums["manifest.json"];
  const result = () => {
    const displayDirectory = relative(dirname(root), directory);
    const exportFile = { kind: "canonical-export-files", complete: true, displayDirectory, manifest: payload.manifest, checksums: payload.checksums } as ExportFilePayload;
    Object.defineProperties(exportFile, {
      directory: { value: directory },
      toJSON: {
        value: () => {
          const { displayDirectory: serializedDirectory, ...serialized } = exportFile;
          return { ...serialized, directory: serializedDirectory };
        },
      },
    });
    return exportFile;
  };
  if (existsSync(directory)) {
    if (!matches()) throw new Error("existing canonical export files do not match their export root");
    return result();
  }
  const partial = mkdtempSync(join(root, `.partial-${sha256(projectId).slice(0, 12)}-`));
  activeExportPartials.add(partial);
  try {
    writeFileSync(join(partial, "records.ndjson"), payload.recordsNdjson, { mode: 0o600 });
    writeFileSync(join(partial, "artifact-index.json"), canonicalJson(payload.artifactIndex), { mode: 0o600 });
    writeFileSync(join(partial, "manifest.json"), canonicalJson(payload.manifest), { mode: 0o600 });
    try {
      renameSync(partial, directory);
    } catch (error) {
      if (!existsSync(directory) || !matches()) throw error;
      rmSync(partial, { recursive: true, force: true });
    }
    return result();
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  } finally {
    activeExportPartials.delete(partial);
  }
}

export function exportFoundation(db: SqliteDatabase | null, projectId: string): FoundationResult {
  if (!db) return unavailableResult(projectId, "canonical SQLite store is unavailable");
  try {
    const rowsByTable = db.transaction(() => Object.fromEntries(TABLES.map((table) => {
      const rows: Record<string, unknown>[] = [];
      for (let offset = 0; ; offset += MAX_EXPORT_ROWS) {
        const page = tableRows(db, table, projectId, offset);
        rows.push(...page);
        if (page.length < MAX_EXPORT_ROWS) break;
      }
      return [table, rows];
    })))() as Record<(typeof TABLES)[number], Record<string, unknown>[]>;
    const tableCounts = Object.fromEntries(TABLES.map((table) => [table, rowsByTable[table].length]));
    const rowCount = Object.values(tableCounts).reduce((sum, count) => sum + count, 0);
    if (rowCount === 0) return result("PROJECT_CONFIG_REQUIRED", projectId, 1, 1, 0, { message: "project has no stored foundation" });
    const recordsNdjson = TABLES.flatMap((table) =>
      rowsByTable[table].map((row) => canonicalJson({ table, row })),
    ).join("\n");
    const artifactIndex = rowsByTable.evidence_artifacts.map((row) => ({
      evidenceId: String(row.evidence_id),
      evidenceKind: String(row.evidence_kind),
      sourceKind: String(row.source_kind),
      sourceRef: String(row.source_ref),
      executionAttemptId: row.execution_attempt_id === null ? null : String(row.execution_attempt_id),
      contentDigest: String(row.content_digest),
      redactedJson: String(row.redacted_json),
      redactedDigest: String(row.redacted_digest),
      durableRefJson: String(row.durable_ref_json),
      artifactIdentityDigest: String(row.artifact_identity_digest),
    }));
    const artifactIndexJson = canonicalJson(artifactIndex);
    const recordsDigest = sha256(recordsNdjson);
    const artifactIndexDigest = sha256(artifactIndexJson);
    const manifestWithoutRoot = {
      schemaVersion: SCHEMA_VERSION,
      contractVersion: RUNTIME_CONTRACT_VERSION,
      pluginId: PLUGIN_ID,
      projectId,
      migrationStatementIds: MIGRATIONS.map((_, index) => index),
      schemaDigest,
      contractDigest,
      rowCount,
      tableCounts,
      recordsDigest,
      artifactIndexDigest,
    };
    const manifest = { ...manifestWithoutRoot, exportRootDigest: sha256(canonicalJson(manifestWithoutRoot)) };
    const manifestJson = canonicalJson(manifest);
    const exportPayload: ExportPayload = {
      manifest,
      recordsNdjson,
      artifactIndex,
      checksums: {
        "artifact-index.json": artifactIndexDigest,
        "manifest.json": sha256(manifestJson),
        "records.ndjson": recordsDigest,
      },
    };
    if (artifactIndex.length > MAX_EXPORT_ROWS ||
      Buffer.byteLength(recordsNdjson, "utf8") + Buffer.byteLength(artifactIndexJson, "utf8") > MAX_EXPORT_BYTES) {
      const exportFile = writeFoundationExportFiles(db, projectId, exportPayload);
      if (!exportFile) return result("EXPORT_BOUNDED", projectId, rowCount, rowCount, 0, { message: "export exceeds inline bounds and the canonical store is not file-backed" });
      return result("OK", projectId, rowCount, rowCount, rowCount, { evidence: { exportFile } });
    }
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
  plugins: {
    list(args?: { signal?: AbortSignal }): Promise<{
      plugins: Array<{ id: string; name: string | null; version: string; status: string }>;
    }>;
    getSource(args: { pluginId: string; signal?: AbortSignal }): Promise<{
      engines: { bb?: string };
    }>;
  };
  threads: {
    list(args: { projectId: string; archived: false; includeHidden: true; limit: number; offset: number }): Promise<Array<{
      id: string;
      providerId: string;
      status: string;
    }>>;
    defaultExecutionOptions(args: { threadId: string }): Promise<{
      model: string;
      reasoningLevel: string;
    } | null>;
  };
}

type RoutingProfile = { providerId: string; model: string; reasoningLevel: string };

async function listDoctorThreads(sdk: DoctorSdk, projectId: string): Promise<Array<{ id: string; providerId: string; status: string }>> {
  const threads: Array<{ id: string; providerId: string; status: string }> = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sdk.threads.list({ projectId, archived: false, includeHidden: true, limit: 1000, offset });
    threads.push(...page);
    if (page.length < 1000) return threads;
    if (offset >= 100_000) throw new Error("thread inventory exceeded bounded pagination");
  }
}

async function routingDoctorEvidence(
  sdk: DoctorSdk,
  projectId: string,
  roleGenerationHeads: Array<Record<string, unknown>>,
): Promise<{
  messages: string[];
  activeWorkerSeatCount: number;
  workerBuckets: Array<RoutingProfile & { count: number; threadIds: string[] }>;
  unresolvedWorkerThreadIds: string[];
  escalationSeats: Array<RoutingProfile & { roleId: string; threadId: string }>;
  unresolvedEscalationRoleIds: string[];
  providerComparisons: Array<{ providerId: string; roleIds: string[]; workerSeatCount: number | null; workerSeatTotal: number; message: string }>;
}> {
  const threads = await listDoctorThreads(sdk, projectId);
  const escalationHeads = roleGenerationHeads.filter((row) =>
    row.status === "active" && (row.role_id === "director" || row.role_id === "project-orchestrator"));
  const escalationThreadIds = new Set(escalationHeads.map((row) => String(row.holder_thread_id)));
  const workerThreads = threads.filter((thread) => thread.status === "active" && !escalationThreadIds.has(thread.id));
  const profileFor = async (thread: { id: string; providerId: string }): Promise<RoutingProfile | null> => {
    try {
      const options = await sdk.threads.defaultExecutionOptions({ threadId: thread.id });
      return options && typeof thread.providerId === "string" && typeof options.model === "string" && typeof options.reasoningLevel === "string"
        ? { providerId: thread.providerId, model: options.model, reasoningLevel: options.reasoningLevel }
        : null;
    } catch {
      return null;
    }
  };
  const workerProfiles = await Promise.all(workerThreads.map(async (thread) => ({ thread, profile: await profileFor(thread) })));
  const buckets = new Map<string, RoutingProfile & { count: number; threadIds: string[] }>();
  for (const { thread, profile } of workerProfiles) {
    if (!profile) continue;
    const key = JSON.stringify([profile.providerId, profile.model, profile.reasoningLevel]);
    const bucket = buckets.get(key) ?? { ...profile, count: 0, threadIds: [] };
    bucket.count += 1;
    bucket.threadIds.push(thread.id);
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) bucket.threadIds.sort();
  const workerBuckets = [...buckets.values()].sort((left, right) =>
    `${left.providerId}/${left.model}/${left.reasoningLevel}`.localeCompare(`${right.providerId}/${right.model}/${right.reasoningLevel}`));
  const workerProviderCount = new Set(workerBuckets.map((bucket) => bucket.providerId)).size;
  const unresolvedWorkerThreadIds = workerProfiles.filter(({ profile }) => !profile).map(({ thread }) => thread.id).sort();
  const complete = unresolvedWorkerThreadIds.length === 0;
  const workerMessage = !complete
    ? `${workerThreads.length} active worker seats include ${unresolvedWorkerThreadIds.length} with unresolved routing profiles`
    : workerThreads.length === 0
      ? "No active worker seats are running"
      : workerThreads.length === 1
        ? `1 active worker seat is on ${workerBuckets[0]!.providerId}/${workerBuckets[0]!.model}/${workerBuckets[0]!.reasoningLevel}`
        : workerBuckets.length === 1
          ? `All ${workerThreads.length} active worker seats are on ${workerBuckets[0]!.providerId}/${workerBuckets[0]!.model}/${workerBuckets[0]!.reasoningLevel}`
          : workerProviderCount === 1
            ? `${workerThreads.length} active worker seats are all on provider ${workerBuckets[0]!.providerId} (${workerBuckets.length} triples): ${workerBuckets.map((bucket) => `${bucket.count} on ${bucket.providerId}/${bucket.model}/${bucket.reasoningLevel}`).join(", ")}`
          : `${workerThreads.length} active worker seats span ${workerBuckets.length} routing triples: ${workerBuckets.map((bucket) => `${bucket.count} on ${bucket.providerId}/${bucket.model}/${bucket.reasoningLevel}`).join(", ")}`;
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const resolvedEscalationSeats = await Promise.all(escalationHeads.map(async (head) => {
    const roleId = String(head.role_id);
    const threadId = String(head.holder_thread_id);
    const thread = threadById.get(threadId);
    const profile = thread ? await profileFor(thread) : null;
    return { roleId, threadId, profile };
  }));
  const escalationSeats = resolvedEscalationSeats
    .filter((seat): seat is typeof seat & { profile: RoutingProfile } => seat.profile !== null)
    .map(({ roleId, threadId, profile }) => ({ roleId, threadId, ...profile }));
  const unresolvedEscalationRoleIds = resolvedEscalationSeats.filter((seat) => !seat.profile).map((seat) => seat.roleId).sort();
  const escalationByProvider = new Map<string, typeof escalationSeats>();
  for (const seat of escalationSeats) {
    const seats = escalationByProvider.get(seat.providerId) ?? [];
    seats.push(seat);
    escalationByProvider.set(seat.providerId, seats);
  }
  const providerComparisons = [...escalationByProvider].sort(([left], [right]) => left.localeCompare(right)).map(([providerId, seats]) => {
    const roleIds = seats.map((seat) => seat.roleId).sort();
    const labels = roleIds.map((roleId) => roleId === "project-orchestrator" ? "the orchestrator" : `the ${roleId}`);
    const subjects = labels.length === 2 ? `${labels[0]} and ${labels[1]}` : labels[0]!;
    const workerSeatCount = complete ? workerProfiles.filter(({ profile }) => profile?.providerId === providerId).length : null;
    const message = workerSeatCount === null
      ? `${subjects} ${labels.length === 1 ? "uses" : "share"} provider ${providerId}; comparison with ${workerThreads.length} active worker seats is unresolved because ${unresolvedWorkerThreadIds.length} routing profiles are unavailable`
      : `${subjects} ${labels.length === 1 ? "uses" : "share"} provider ${providerId} with ${workerSeatCount} of ${workerThreads.length} active worker seats`;
    return { providerId, roleIds, workerSeatCount, workerSeatTotal: workerThreads.length, message };
  });
  return {
    messages: [
      workerMessage,
      ...providerComparisons.map((comparison) => comparison.message),
      ...(unresolvedEscalationRoleIds.length === 0 ? [] : [`Escalation routing is unresolved for ${unresolvedEscalationRoleIds.join(", ")}`]),
    ],
    activeWorkerSeatCount: workerThreads.length,
    workerBuckets,
    unresolvedWorkerThreadIds,
    escalationSeats,
    unresolvedEscalationRoleIds,
    providerComparisons,
  };
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
    let bootstrapAuthorityRoot: DecisionAuthorityRoot | null = null;
    if (
      !(DECISION_CLASSES as readonly string[]).includes(decision.decision_class ?? "") ||
      !decision.options_json || !decision.decision_identity_digest ||
      decision.scope_digest !== sha256(decision.scope_json) ||
      storedDecisionIdentityDigest(decision) !== decision.decision_identity_digest
    ) {
      unresolvedDecisions.push({ decisionId: decision.decision_id, reason: "DECISION_IDENTITY_CONFLICT" });
    }
    if (isCrossProjectBootstrapDecision(decision.project_id, decision.decision_class, decision.repo_target_id, decision.scope_json, decision.options_json)) {
      try {
        const head = asRow<{ actor_receipt_id: string }>(db.prepare(
          "SELECT project_governorships.actor_receipt_id FROM project_governorship_heads JOIN project_governorships USING (project_id, governance_epoch) WHERE project_governorship_heads.project_id = ?",
        ).get(projectId));
        const storedRoot = storedDecisionAuthorityRoot(decision);
        const currentRoot = head && currentBootstrapDecisionAuthorityRootForActor(db, projectId, head.actor_receipt_id);
        if (!currentRoot || canonicalJson(storedRoot) !== canonicalJson(currentRoot)) {
          throw new Error("authority root is not current");
        }
        bootstrapAuthorityRoot = storedRoot;
      } catch {
        unresolvedDecisions.push({ decisionId: decision.decision_id, reason: "DECISION_AUTHORITY_ROOT_INVALID" });
      }
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
      const actor = asRow<{ actor_kind: string; project_id: string; verification_state: string; receipt_digest: string; subject_id: string; role_id: string | null; role_generation: number | null; operator_receipt_id: string | null; retirement_condition: string | null; domain_id: string | null }>(
        db.prepare("SELECT * FROM actor_receipts WHERE receipt_id = ?").get(disposition.actor_receipt_id),
      );
      const bootstrapPluginActor = bootstrapAuthorityRoot !== null && disposition.actor_receipt_id === bootstrapAuthorityRoot.actorReceiptId &&
        actor?.actor_kind === "plugin" && actor.project_id === projectId && actor.verification_state === "verified" &&
        actor.receipt_digest === bootstrapAuthorityRoot.actorReceiptDigest;
      if (!actor || actor.project_id !== projectId || actor.verification_state !== "verified" ||
          (bootstrapAuthorityRoot !== null && !bootstrapPluginActor)) {
        issues.push({ decisionId: decision.decision_id, reason: "decision_actor_invalid" });
      } else {
        const receiptDigest = actorReceiptDigest({
          projectId: actor.project_id,
          receiptId: String(disposition.actor_receipt_id),
          actorKind: actor.actor_kind,
          subjectId: actor.subject_id,
          roleId: actor.role_id,
          roleGeneration: actor.role_generation,
          verificationState: actor.verification_state,
          operatorReceiptId: actor.operator_receipt_id,
          retirementCondition: actor.retirement_condition,
          domainId: actor.domain_id,
        });
        if (receiptDigest !== actor.receipt_digest) issues.push({ decisionId: decision.decision_id, reason: "decision_actor_digest_invalid" });
        if (actor.actor_kind === "role") {
          const role = asRow<{ current_generation: number; domain_id: string; status: string; holder_execution_attempt_id: string; holder_context_digest: string; holder_requested_profile_digest: string; qualification_id: string; eligibility_derivation_digest: string; role_requirement_id: string }>(db.prepare(
          `SELECT role_generation_heads.current_generation, role_generation_heads.domain_id, role_generations.status,
                    role_generations.holder_execution_attempt_id, role_generations.holder_context_digest,
                    role_generations.holder_requested_profile_digest, role_generations.qualification_id,
                    role_generations.eligibility_derivation_digest, role_generations.role_requirement_id
             FROM role_generation_heads JOIN role_generations
               ON role_generations.project_id = role_generation_heads.project_id
              AND role_generations.role_id = role_generation_heads.role_id
              AND role_generations.generation = role_generation_heads.current_generation
              AND role_generations.domain_id = role_generation_heads.domain_id
             WHERE role_generation_heads.project_id = ? AND role_generation_heads.role_id = ? AND role_generation_heads.domain_id = COALESCE((SELECT domain_id FROM actor_receipts WHERE project_id = ? AND receipt_id = ?), 'default')`,
          ).get(projectId, actor.role_id, projectId, disposition.actor_receipt_id));
          const holder = role && asRow<{ state: string; origin: string; native_receipt_digest: string | null; requested_profile_digest: string | null }>(
            db.prepare("SELECT state, origin, native_receipt_digest, requested_profile_digest FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ?").get(projectId, role.holder_execution_attempt_id),
          );
          const eligibility = role && asRow<{ current_qualification_id: string; effective_status: string; expires_at_ms: number | null; derivation_digest: string }>(db.prepare(
            "SELECT current_qualification_id, effective_status, expires_at_ms, derivation_digest FROM eligibility_projections WHERE project_id = ? AND role_requirement_id = ? AND requested_profile_digest = ? AND domain_id = ?",
          ).get(projectId, role.role_requirement_id, role.holder_requested_profile_digest, role.domain_id));
          if (
            !role || actor.role_generation !== role.current_generation || role.status !== "active" || actor.subject_id !== role.holder_execution_attempt_id ||
            !holder || holder.origin !== "role_holder" || holder.state !== "done" || holder.native_receipt_digest !== role.holder_context_digest ||
            holder.requested_profile_digest !== role.holder_requested_profile_digest || !eligibility ||
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
      const attempt = asRow<{ state: string; terminal_result: string | null; reported_outcome: string | null; terminal_report_digest: string | null; native_receipt_digest: string | null; requested_profile_digest: string | null; conflicting_terminal_digest: string | null }>(
        db.prepare("SELECT state, terminal_result, reported_outcome, terminal_report_digest, native_receipt_digest, requested_profile_digest, conflicting_terminal_digest FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ?").get(projectId, artifact.execution_attempt_id),
      );
      if (
        !attempt || attempt.state !== "done" || attempt.terminal_result !== "DONE" || attempt.reported_outcome !== "DONE" ||
        attempt.terminal_report_digest !== artifact.content_digest || !attempt.native_receipt_digest || !attempt.requested_profile_digest ||
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
  checkoutDivergence?: CheckoutDivergence,
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
    const migrationRuns = (db.prepare(
      `SELECT migration_id, source_system, source_runtime_id, target_runtime_id, source_export_digest,
              config_revision, decision_id, decision_disposition_sequence, state, resource_revision,
              source_event_ceiling, source_snapshot_digest, source_governor_epoch, target_governor_epoch,
              mutator_inventory_digest, quiescence_digest, import_root_digest, equivalence_digest,
              recovery_digest, retention_until_ms, created_at_ms, updated_at_ms
       FROM migration_runs WHERE project_id = ? ORDER BY migration_id`,
    ).all(projectId) as Array<Record<string, string | number | null>>).map((run) => {
      const state = String(run.state);
      const unresolvedProof: string[] = [];
      if (!run.mutator_inventory_digest) unresolvedProof.push("mutator_inventory");
      if (!run.quiescence_digest) unresolvedProof.push("quiescence");
      if (["exported", "imported", "equivalent", "target_active", "exercised", "retired", "fix_forward_required"].includes(String(run.state)) && !run.source_export_digest) unresolvedProof.push("source_export");
      if (["imported", "equivalent", "target_active", "exercised", "retired", "fix_forward_required"].includes(String(run.state)) && !run.import_root_digest) unresolvedProof.push("import");
      if (["equivalent", "target_active", "exercised", "retired", "fix_forward_required"].includes(String(run.state)) && !run.equivalence_digest) unresolvedProof.push("equivalence");
      return { ...run, state, retentionExpired: Number(run.retention_until_ms) <= now(), unresolvedProof };
    });
    const activeMigrationRun = migrationRuns.find((run) => !["retired", "rolled_back"].includes(String(run.state))) ?? null;
    const hasDomainRoleShape = ["role_generation_heads", "role_generations"].every((table) => tableColumns(db, table).includes("domain_id"));
    const roleGenerationHeads = (db.prepare(hasDomainRoleShape
      ? `SELECT role_generation_heads.role_id, role_generation_heads.domain_id, role_generation_heads.current_generation,
              role_generations.status, role_generations.qualification_id,
              role_generations.holder_execution_attempt_id,
              role_generations.standby_profile_json,
              (SELECT event_type FROM state_events
               WHERE state_events.project_id = role_generation_heads.project_id
                 AND state_events.aggregate_type = 'role_generation'
                 AND state_events.aggregate_id = role_generation_heads.role_id
                 AND state_events.aggregate_revision = role_generation_heads.current_generation
                 AND (json_extract(state_events.event_json, '$.domainId') = role_generation_heads.domain_id
                   OR (role_generation_heads.domain_id = 'default' AND json_extract(state_events.event_json, '$.domainId') IS NULL))
               ORDER BY state_events.event_sequence DESC LIMIT 1) AS generation_event_type,
              execution_attempts.state AS holder_attempt_state,
              execution_attempts.native_receipt_digest AS holder_native_receipt_digest,
              execution_attempts.thread_id AS holder_thread_id
       FROM role_generation_heads
       JOIN role_generations ON role_generations.project_id = role_generation_heads.project_id
         AND role_generations.role_id = role_generation_heads.role_id
         AND role_generations.generation = role_generation_heads.current_generation
         AND role_generations.domain_id = role_generation_heads.domain_id
       LEFT JOIN execution_attempts ON execution_attempts.project_id = role_generations.project_id
         AND execution_attempts.execution_attempt_id = role_generations.holder_execution_attempt_id
       WHERE role_generation_heads.project_id = ? ORDER BY role_generation_heads.role_id, role_generation_heads.domain_id`
      : `SELECT role_generation_heads.role_id, 'default' AS domain_id, role_generation_heads.current_generation,
              role_generations.status, role_generations.qualification_id,
              role_generations.holder_execution_attempt_id,
              role_generations.standby_profile_json,
              (SELECT event_type FROM state_events
               WHERE state_events.project_id = role_generation_heads.project_id
                 AND state_events.aggregate_type = 'role_generation'
                 AND state_events.aggregate_id = role_generation_heads.role_id
                 AND state_events.aggregate_revision = role_generation_heads.current_generation
                 AND (json_extract(state_events.event_json, '$.domainId') = 'default'
                   OR json_extract(state_events.event_json, '$.domainId') IS NULL)
               ORDER BY state_events.event_sequence DESC LIMIT 1) AS generation_event_type,
              execution_attempts.state AS holder_attempt_state,
              execution_attempts.native_receipt_digest AS holder_native_receipt_digest,
              execution_attempts.thread_id AS holder_thread_id
       FROM role_generation_heads
       JOIN role_generations ON role_generations.project_id = role_generation_heads.project_id
         AND role_generations.role_id = role_generation_heads.role_id
         AND role_generations.generation = role_generation_heads.current_generation
       LEFT JOIN execution_attempts ON execution_attempts.project_id = role_generations.project_id
         AND execution_attempts.execution_attempt_id = role_generations.holder_execution_attempt_id
       WHERE role_generation_heads.project_id = ? ORDER BY role_generation_heads.role_id`)
    .all(projectId) as Array<Record<string, unknown>>).map((row): Record<string, unknown> => {
      const { standby_profile_json: standbyProfileJson, ...head } = row;
      return {
        ...head,
        standby: {
          declaration: standbyProfileJson === null ? "UNDECLARED" : "DECLARED",
          coverage: "NOT_CLAIMED",
        },
      };
    });
    const observationCount = asRow<{ count: number }>(
      db.prepare("SELECT COUNT(*) AS count FROM qualification_observations WHERE project_id = ?").get(projectId),
    )?.count ?? 0;
    const configuredDomainInventory = configuredDomains(db, projectId, configHead.config_revision);
    const configuredRequirements = configuredDomainInventory.flatMap((domain) => domain.roleRequirements.map((requirement) => ({ ...requirement, domainId: domain.domainId })));
    const hasDomainEligibility = tableColumns(db, "eligibility_projections").includes("domain_id");
    const eligibility = (db.prepare(
      `SELECT role_requirement_id, ${hasDomainEligibility ? "domain_id," : "'default' AS domain_id,"} requested_profile_digest, current_qualification_id, effective_status,
              config_revision, role_requirement_digest, expires_at_ms, reason_code
       FROM eligibility_projections WHERE project_id = ? ORDER BY role_requirement_id, requested_profile_digest`,
    ).all(projectId) as Array<Record<string, unknown>>).map((row) => {
      const domainId = typeof row.domain_id === "string" ? row.domain_id : "default";
      const requirement = configuredRequirements.find((candidate) => candidate.roleRequirementId === row.role_requirement_id && candidate.domainId === domainId);
      const stale = row.config_revision !== configHead.config_revision || !requirement || sha256(canonicalJson(requirement)) !== row.role_requirement_digest;
      const expired = typeof row.expires_at_ms === "number" && row.expires_at_ms <= now();
      return {
        roleRequirementId: row.role_requirement_id,
        domainId,
        requestedProfileDigest: row.requested_profile_digest,
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
    const staleProjections = db.prepare(
      `SELECT refs.work_item_id, refs.provider, refs.owner, refs.repo, refs.issue_number,
              refs.projection_state, refs.attempted_resource_revision,
              items.resource_revision AS canonical_resource_revision
         FROM external_work_refs AS refs
         JOIN work_items AS items
           ON items.project_id = refs.project_id AND items.work_item_id = refs.work_item_id
        WHERE refs.project_id = ?
          AND refs.projection_state <> 'pending'
          AND refs.attempted_resource_revision <> items.resource_revision
        ORDER BY refs.work_item_id, refs.provider`,
    ).all(projectId) as Array<Record<string, unknown>>;
    const assignmentAttempts: Array<Record<string, unknown>> = [];
    const capacityEvidence = workItemCapacityLaneEvidence(db, projectId);
    const activeWriters = capacityEvidence.lanes;
    const idleActiveWriters = activeWriters.filter((row) => row.idle_kind === "active");
    const blindWriters = activeWriters.filter((row) => row.idle_kind === "blind");
    const unresolvedAttempts: Array<Record<string, unknown>> = [];
    const profileAuditEntries: Array<Record<string, unknown>> = [];
    const profileAudit = {
      status: "no_canonical_assignments",
      total: 0,
      compliant: 0,
      mismatch: 0,
      unknown: 0,
      entries: profileAuditEntries,
    };
    const unresolvedRoleHolders = roleGenerationHeads
      .filter((row) => row.holder_attempt_state !== "done" || !row.holder_native_receipt_digest)
      .map((row) => ({ roleId: row.role_id, domainId: row.domain_id ?? "default", generation: row.current_generation, holderExecutionAttemptId: row.holder_execution_attempt_id, reason: "ROLE_HOLDER_UNRESOLVED" }));
    const decisionIntegrity = decisionDoctorEvidence(db, projectId);
    const cachedConsumers = persistedCachedConsumerRolloutEvidence(db, projectId);
    const installedPlugins = await sdk.plugins.list();
    const incompatiblePlugins = await Promise.all(installedPlugins.plugins
      .filter((plugin) => plugin.status === "incompatible")
      .map(async (plugin) => {
        const source = await sdk.plugins.getSource({ pluginId: plugin.id });
        const name = plugin.name ?? plugin.id;
        const requiredBbRange = source.engines.bb ?? null;
        return {
          id: plugin.id,
          name,
          pluginVersion: plugin.version,
          requiredBbRange,
          bbVersion: version.currentVersion,
          loaded: false,
          message: requiredBbRange === null
            ? `plugin "${name}" ${plugin.version} is not loaded: its declared BB range is unavailable`
            : `plugin "${name}" ${plugin.version} is not loaded: declared BB range ${requiredBbRange} excludes running BB ${version.currentVersion}`,
        };
      }));
    const pluginCompatibilityMessage = incompatiblePlugins.length === 0
      ? undefined
      : incompatiblePlugins.map((plugin) => plugin.message).join("; ");
    const routing = await routingDoctorEvidence(sdk, projectId, roleGenerationHeads);
    const pluginSourceUnavailable = checkoutDivergence?.verdict === "unavailable";
    const bbCollabPluginSourceCheckout = checkoutDivergence
      ? { sourceIdentity: { kind: "plugin-source" as const, pluginId: PLUGIN_ID }, ...checkoutDivergence }
      : undefined;
    const doctorMessage = [
      pluginCompatibilityMessage,
      ...routing.messages,
      ...(staleProjections.length === 0 ? [] : [`${staleProjections.length} external projection(s) are stale against canonical resource revisions`]),
      ...(pluginSourceUnavailable ? ["bb-collab plugin-source checkout is unavailable"] : []),
    ].filter(Boolean).join("; ");
    const expected = targets.length + 1;
    return result(pluginSourceUnavailable ? "PLUGIN_SOURCE_UNAVAILABLE" : "OK", projectId, expected, expected, expected, {
      currentConfigRevision: configHead.config_revision,
      currentGovernanceEpoch: governor ? Number(governor.governance_epoch) : undefined,
      message: doctorMessage,
      evidence: {
        bbVersion: version.currentVersion,
        pluginSdkVersion: PLUGIN_SDK_VERSION,
        compatibility: {
          bb: BB_VERSION_RANGE,
          bbPluginSdk: `^${PLUGIN_SDK_VERSION}`,
          plugins: { checked: installedPlugins.plugins.length, incompatible: incompatiblePlugins },
        },
        project: { id: project.id, kind: project.kind, name: project.name, gitRemoteUrl: project.gitRemoteUrl },
        targets: targetEvidence,
        governorshipHead: governor ?? null,
        migrationRuns,
        activeMigrationRun,
        roleGenerationHeads,
        unresolvedRoleHolders,
        routing,
        qualificationObservationCount: observationCount,
        domains: configuredDomainInventory.map((domain) => ({
          domainId: domain.domainId,
          taskClasses: domain.taskClasses,
          roleRequirementIds: domain.roleRequirements.map((requirement) => requirement.roleRequirementId),
        })),
        eligibility,
        projections: { stale: staleProjections },
        assignments: assignmentAttempts,
        profileAudit,
        capacity: {
          writingLaneCeiling,
          lifecycleStates: [...WORK_ITEM_CAPACITY_LIFECYCLE_STATES],
          attemptStates: [...WORK_ITEM_CAPACITY_ATTEMPT_STATES],
          activeWriterCount: activeWriters.length,
          activeWriterLaneIds: activeWriters.map((row) => row.lane_id),
          blindWriterLaneIds: blindWriters.map((row) => row.lane_id),
          duplicateLaneIds: [...new Set(activeWriters.map((row) => row.lane_id).filter((laneId, index, all) => all.indexOf(laneId) !== index))],
          ceilingViolated: activeWriters.length > writingLaneCeiling,
        },
        idleEnforcer: {
          activeStates: [...WORK_ITEM_IDLE_ACTIVE_ATTEMPT_STATES],
          blindStates: [...WORK_ITEM_IDLE_BLIND_ATTEMPT_STATES],
          status: blindWriters.length > 0 ? "blind" : idleActiveWriters.length > 0 ? "active" : "idle",
          activeLaneCount: idleActiveWriters.length,
          activeLaneIds: idleActiveWriters.map((row) => row.lane_id),
          blindLaneCount: blindWriters.length,
          blindLaneIds: blindWriters.map((row) => row.lane_id),
        },
        unresolvedAttempts,
        decisionIntegrity,
        cachedConsumers,
        ...(bbCollabPluginSourceCheckout ? { bbCollabPluginSourceCheckout } : {}),
        schema: { version: SCHEMA_VERSION, migrationStatementIds: MIGRATIONS.map((_, index) => index), digest: schemaDigest, tables: schemaState.map((row) => row.name) },
      },
    });
  } catch (error) {
    if (error instanceof Refusal) return refusalResult(projectId, error.data);
    return result("BB_FACTS_UNAVAILABLE", projectId, 1, 0, 0, { message: String(error) });
  }
}

const EXECUTION_ATTEMPT_BASE_COLUMNS = [
  "project_id", "execution_attempt_id", "assignment_id", "origin", "assignment_digest", "lane_id", "assignment_kind", "attempt_ordinal",
  "dispatch_kind", "config_revision", "governance_epoch", "work_item_id", "repo_target_id", "role_id", "role_generation", "state",
  "bb_server_id", "environment_id", "source_id", "host_id", "environment_path", "thread_id", "provider_thread_id", "native_request_id",
  "request_event_id", "request_event_seq", "accepted_event_id", "accepted_event_seq", "first_action_event_id", "first_action_event_seq",
  "content_event_id", "content_event_seq", "completion_event_id", "completion_event_seq", "terminal_event_id", "terminal_event_seq",
  "frozen_brief_digest", "content_receipt_digest", "requested_provider_id", "requested_model", "requested_reasoning_level",
  "requested_permission_mode", "requested_service_tier", "requested_visibility", "requested_profile_digest", "branch_name", "base_sha",
  "candidate_sha", "environment_digest", "native_receipt_digest", "terminal_result", "reported_outcome", "terminal_report_digest",
  "conflicting_terminal_digest", "reason_code", "last_event_seq", "progress_json", "lease_owner_thread_id", "lease_expires_at_ms",
  "continuation_of_attempt_id", "created_at_ms", "observed_at_ms", "completed_at_ms", "attempt_digest", "review_pr_number",
  "review_pr_head_sha", "lane_capacity_observation_id",
] as const;
const EXECUTION_ATTEMPT_V31_COLUMNS = [
  ...EXECUTION_ATTEMPT_BASE_COLUMNS,
  "terminalization_class", "terminal_report_json", "terminal_actual_profile_digest", "interruption_reason", "interruption_event_id",
  "interruption_event_seq", "interruption_turn_id", "interruption_evidence_digest",
] as const;
const CHILD_TABLE_COLUMNS = {
  decision_evidence: ["project_id", "decision_id", "evidence_sequence", "evidence_id", "disposition_sequence", "relation_kind", "relation_json", "created_at_ms", "idempotency_key"],
  evidence_artifacts: ["project_id", "evidence_id", "evidence_kind", "source_kind", "source_ref", "execution_attempt_id", "content_digest", "redacted_json", "redacted_digest", "durable_ref_json", "artifact_identity_digest", "created_at_ms"],
  lane_capacity_refresh_evidence: ["project_id", "lane_capacity_observation_id", "execution_attempt_id", "observed_at_ms"],
} as const;

function tableColumns(db: SqliteDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function foreignKeyShape(db: SqliteDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string; from: string; to: string }>)
    .map(({ table: target, from, to }) => `${target}:${from}->${to}`).sort();
}

function migrationSchemaShape(db: SqliteDatabase, version: "schema30" | "schema31"): boolean {
  if (!tableExists(db, "execution_attempts") || !Object.keys(CHILD_TABLE_COLUMNS).every((table) => tableExists(db, table))) return false;
  const expectedAttempts = version === "schema30" ? EXECUTION_ATTEMPT_BASE_COLUMNS : EXECUTION_ATTEMPT_V31_COLUMNS;
  if (canonicalJson(tableColumns(db, "execution_attempts")) !== canonicalJson(expectedAttempts)) return false;
  for (const [table, columns] of Object.entries(CHILD_TABLE_COLUMNS)) {
    if (canonicalJson(tableColumns(db, table)) !== canonicalJson(columns)) return false;
  }
  if (foreignKeyShape(db, "evidence_artifacts").toString() !== [
    "execution_attempts:execution_attempt_id->execution_attempt_id",
    "execution_attempts:project_id->project_id",
  ].sort().toString()) return false;
  if (foreignKeyShape(db, "lane_capacity_refresh_evidence").toString() !== [
    "execution_attempts:execution_attempt_id->execution_attempt_id",
    "execution_attempts:project_id->project_id",
  ].sort().toString()) return false;
  if (foreignKeyShape(db, "decision_evidence").toString() !== [
    "decision_dispositions:decision_id->decision_id",
    "decision_dispositions:disposition_sequence->disposition_sequence",
    "evidence_artifacts:evidence_id->evidence_id",
    "evidence_artifacts:project_id->project_id",
  ].sort().toString()) return false;
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'execution_attempts' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
  const expectedIndexes = [
    "execution_attempts_active_assignment", "execution_attempts_active_work_item", "execution_attempts_active_writer_lane",
    "execution_attempts_active_writer_thread", "execution_attempts_native_request", "execution_attempts_project_state",
    ...(version === "schema31" ? ["execution_attempts_interrupted_pending"] : []),
  ];
  return expectedIndexes.every((name) => indexes.includes(name)) &&
    (version === "schema31" || !indexes.includes("execution_attempts_interrupted_pending"));
}

function assertMigratedSchema(db: SqliteDatabase): void {
  const schema31 = migrationSchemaShape(db, "schema31");
  const gh637Append = tableExists(db, "execution_attempts") && tableColumns(db, "execution_attempts").includes("domain_id");
  if (!schema31 && !gh637Append) throw new Error("GH636 migration ledger is ambiguous: schema-31 shape is not exact");
  if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("GH636 migration produced an integrity-check failure");
  if ((db.pragma("foreign_key_check") as unknown[]).length !== 0) throw new Error("GH636 migration produced foreign-key violations");
}

function allMigrationIdsBefore(db: SqliteDatabase, id: number): boolean {
  const applied = new Set((db.prepare("SELECT id FROM _bb_migrations").all() as Array<{ id: number }>).map(({ id: rowId }) => rowId));
  return Array.from({ length: id }, (_, index) => index).every((index) => applied.has(index));
}

function assertGh637MigrationPreflight(db: SqliteDatabase, latestApplied: boolean): void {
  const domainTableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_domains'").get() !== undefined;
  if (latestApplied !== domainTableExists) throw new Error("GH637 migration ledger is mixed-version: domain inventory and ledger disagree");
  if (latestApplied) return;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_config_revisions'").get() === undefined) return;
  const rows = db.prepare("SELECT canonical_config_json FROM project_config_revisions").all() as Array<{ canonical_config_json: string }>;
  for (const row of rows) {
    const config = JSON.parse(row.canonical_config_json) as { extensions?: { bbCollab?: { domains?: unknown } } };
    if (config.extensions?.bbCollab?.domains !== undefined) {
      throw new Error("GH637 migration refused: pre-domain schema contains explicit multi-domain authority");
    }
    domainDefinitionsFromConfigJson(row.canonical_config_json);
  }
}

function assertGh637MigratedSchema(db: SqliteDatabase): void {
  const requiredColumns = new Map<string, string[]>([
    ["work_items", ["domain_id", "task_class"]],
    ["execution_attempts", ["domain_id"]],
    ["role_generations", ["domain_id"]],
    ["role_generation_heads", ["domain_id"]],
  ]);
  for (const [table, columns] of requiredColumns) {
    const actual = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
    if (columns.some((column) => !actual.has(column))) throw new Error(`GH637 migration produced an incomplete ${table} domain shape`);
  }
  const configCount = (db.prepare("SELECT COUNT(*) AS count FROM project_config_revisions").get() as { count: number }).count;
  const domainCount = (db.prepare("SELECT COUNT(*) AS count FROM orchestration_domains").get() as { count: number }).count;
  if (configCount !== domainCount) throw new Error("GH637 migration did not map every historical config to exactly one default domain");
}

export function migrateCanonicalStore(
  db: SqliteDatabase,
  migrate: (database: SqliteDatabase, statements: string[]) => void,
): void {
  db.exec("CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const has = (id: number) => db.prepare("SELECT 1 FROM _bb_migrations WHERE id = ?").get(id) !== undefined;
  assertGh637MigrationPreflight(db, has(GH637_DOMAIN_MIGRATION_ID));
  const previousApplied = has(GH636_PREVIOUS_MIGRATION_ID);
  const repairApplied = has(GH636_REPAIR_MIGRATION_ID);
  if (repairApplied && !previousApplied) throw new Error("GH636 migration ledger is ambiguous: repair is ledgered without schema 31");
  if (!previousApplied && !repairApplied && migrationSchemaShape(db, "schema31")) {
    throw new Error("GH636 migration ledger is ambiguous: schema 31 exists without migration 43");
  }
  if (!previousApplied && !repairApplied &&
      db.prepare("SELECT 1 FROM _bb_migrations LIMIT 1").get() !== undefined &&
      !allMigrationIdsBefore(db, GH636_PREVIOUS_MIGRATION_ID)) {
    throw new Error("GH636 migration ledger is ambiguous: prior migration ledger is incomplete");
  }
  migrate(db, MIGRATIONS.slice(0, GH636_PREVIOUS_MIGRATION_ID));
  if (!previousApplied) {
    if (!allMigrationIdsBefore(db, GH636_PREVIOUS_MIGRATION_ID) || !migrationSchemaShape(db, "schema30")) {
      throw new Error("GH636 migration ledger is ambiguous: exact schema-30 pre-upgrade shape is absent");
    }
    migrate(db, [
      ...MIGRATIONS.slice(0, GH636_PREVIOUS_MIGRATION_ID),
      GH636_SCHEMA30_REPAIR_MIGRATION,
      ...MIGRATIONS.slice(GH636_REPAIR_MIGRATION_ID),
    ]);
  } else if (!repairApplied) {
    if (!migrationSchemaShape(db, "schema31")) throw new Error("GH636 migration ledger is ambiguous: migration 43 is ledgered without schema 31");
    migrate(db, MIGRATIONS);
  } else {
    migrate(db, MIGRATIONS);
  }
  if (!has(GH636_PREVIOUS_MIGRATION_ID) || !has(GH636_REPAIR_MIGRATION_ID)) throw new Error("GH636 migration ledger is incomplete");
  assertMigratedSchema(db);
  if (!has(GH637_DOMAIN_MIGRATION_ID)) throw new Error("GH637 migration ledger is incomplete");
  assertGh637MigratedSchema(db);
  if (!has(GH644_LOCAL_CANDIDATE_REVIEW_MIGRATION_ID) || !["review_candidate_kind", "review_candidate_json", "review_role_requirement_id", "review_role_id", "review_role_generation", "review_frozen_brief_version", "review_frozen_brief_content", "review_frozen_brief_digest", "review_return_path_json", "dispatch_input_digest"].every((column) => tableColumns(db, "execution_attempts").includes(column))) {
    throw new Error("GH644 migration ledger is incomplete");
  }
  if (!has(GH658_GITHUB_PR_WAIT_MIGRATION_ID)) throw new Error("GH658 migration ledger is incomplete");
}

export function databaseIsReady(db: SqliteDatabase): void {
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const root = exportRootDirectory(db);
  if (root) sweepPartialExportDirectories(root);
}
