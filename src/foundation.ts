import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { CheckoutDivergence } from "./checkout-divergence.js";

export const PLUGIN_ID = "bb-collab";
export const BB_VERSION_RANGE = ">=0.37.0";
export const PLUGIN_SDK_VERSION = "0.4.1";
// Runtime contract version; the separate instruction contract is INSTRUCTION_CONTRACT_VERSION: 34 in AGENTS.md.
export const RUNTIME_CONTRACT_VERSION = 22;
export const SCHEMA_VERSION = 23;
// v22 establishes the director's exact accepted-profile set.
const PREVIOUS_RUNTIME_CONTRACT_VERSION = 21;
export const DEFAULT_WRITING_LANE_CEILING = 3;
export const MAX_WRITING_LANE_CEILING = 3;
// Schema v23 adds forward-only lane-capacity intervals; runtime policy remains v22.
const PREVIOUS_SCHEMA_VERSION = 22;
export const ROLE_IDS = ["director", "project-orchestrator", "worker", "independent-reviewer"] as const;
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
  "repository_targets",
  "project_governorships",
  "project_governorship_heads",
  "migration_runs",
  "actor_receipts",
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
      'github_issue_projection', 'qualification_observation_record',
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
    state TEXT NOT NULL CHECK (state IN ('prepared', 'armed', 'content_delivered', 'running', 'done', 'blocked', 'failed', 'dispatch_unknown', 'superseded')),
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
];

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
  operationClasses: ["migration_prepare", "migration_step"],
  migrationStates: MIGRATION_STATES,
  migrationSteps: MIGRATION_STEPS,
  roleCapacityPolicy: {
    roleIds: [...ROLE_IDS],
    maxRequirements: ROLE_IDS.length,
    scoping: {
      director: "project",
      "project-orchestrator": "project",
      worker: "repository-target",
      "independent-reviewer": "repository-target",
    },
  },
  roleStandbyPolicy: {
    role: "director",
    field: "standby_profile_json",
    requirement: "one named profile with a provider different from the executed holder",
    authority: "none",
    traffic: "none",
  },
  writingLanePolicy: {
    configPath: "extensions.bbCollab.writingLaneCeiling",
    default: DEFAULT_WRITING_LANE_CEILING,
    maximum: MAX_WRITING_LANE_CEILING,
    lowerRequiresExplicitDecision: true,
    readOnlyAssignmentKinds: ["review", "probe"],
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

export const WORK_ITEM_STATES = ["proposed", "ready", "in_progress", "review_pending", "blocked", "succeeded", "failed", "cancelled"] as const;
// review_pending is authorship-complete but non-terminal: it covers human review and CI-only waiting.
export const WORK_ITEM_NON_TERMINAL_STATES = ["proposed", "ready", "in_progress", "review_pending", "blocked"] as const;
export const WORK_ITEM_CAPACITY_LIFECYCLE_STATES = ["in_progress"] as const;
export const WORK_ITEM_CAPACITY_ATTEMPT_STATES = ["prepared", "armed", "content_delivered", "running", "dispatch_unknown"] as const;
export const WORK_ITEM_IDLE_ACTIVE_ATTEMPT_STATES = ["prepared", "armed", "content_delivered", "running"] as const;
export const WORK_ITEM_IDLE_BLIND_ATTEMPT_STATES = ["dispatch_unknown"] as const;

export interface WorkItemCapacityLaneEvidence {
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

export function workItemCapacityLaneEvidence(db: SqliteDatabase, projectId: string): WorkItemCapacityEvidence {
  const lanes = (db.prepare(
    `SELECT execution_attempts.lane_id, execution_attempts.thread_id, execution_attempts.state, execution_attempts.observed_at_ms
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
    githubIssue: githubIssueBindingSchema.optional(),
  })
  .strict();
const githubRefPartSchema = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9_.-]+$/u);
const workItemBlockerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("work_item_succeeded"), workItemId: id }).strict(),
  z.object({ kind: z.literal("github_issue_closed"), owner: githubRefPartSchema, repo: githubRefPartSchema, issueNumber: z.number().int().positive().refine(Number.isSafeInteger) }).strict(),
]);
const workItemBlockerWithDeclarationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("work_item_succeeded"), workItemId: id, declaredBySeat: id, note: z.string().trim().min(1).max(4096).optional() }).strict(),
  z.object({ kind: z.literal("github_issue_closed"), owner: githubRefPartSchema, repo: githubRefPartSchema, issueNumber: z.number().int().positive().refine(Number.isSafeInteger), declaredBySeat: id, note: z.string().trim().min(1).max(4096).optional() }).strict(),
]);
const workItemWaitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), schedule: id, declaredBySeat: id }).strict(),
  z.object({ kind: z.literal("seat"), seat: z.enum(ROLE_IDS), declaredBySeat: id }).strict(),
  ...workItemBlockerWithDeclarationSchema.options,
]);
const workItemExternalEventSchema = z.object({
  kind: z.enum(["github_issue_closed", "github_issue_reopened"]),
  owner: githubRefPartSchema,
  repo: githubRefPartSchema,
  issueNumber: z.number().int().positive().refine(Number.isSafeInteger),
}).strict();
const gitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/u);
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
    reviewPrNumber: z.number().int().positive().refine(Number.isSafeInteger, "reviewPrNumber must be a safe integer").optional(),
    reviewPrHeadSha: gitShaSchema.optional(),
  })
  .strict()
  .superRefine((attempt, ctx) => {
    const linked = attempt.reviewPrNumber !== undefined || attempt.reviewPrHeadSha !== undefined;
    if (attempt.assignmentKind !== "review" && linked) {
      ctx.addIssue({ code: "custom", message: "pull request linkage is valid only for review attempts" });
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

const roleIdSchema = z.enum(ROLE_IDS);
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
const roleRequirementsSchema = z.array(roleRequirementSchema).max(ROLE_IDS.length).superRefine((requirements, ctx) => {
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
export const OPERATOR_RECEIPT_RETIREMENT_CONDITION = "host-issued receipt get-bb/bb#1541" as const;
export const CANONICAL_MUTATION_CLASSES = [
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
    operationClass: z.enum(CANONICAL_MUTATION_CLASSES),
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
    workItemWait: workItemWaitSchema.nullable().optional(),
    workItemUnblock: workItemBlockerSchema.optional(),
    workItemExternalEvent: workItemExternalEventSchema.optional(),
    workAttempt: workAttemptSchema.optional(),
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
    standbyProfile: executionProfileSchema.optional(),
    assignment: assignmentIntentSchema.optional(),
    assignmentId: id.optional(),
    executionAttemptId: id.optional(),
    frozenBriefContent: z.string().max(256 * 1024).optional(),
    terminalReport: terminalReportSchema.optional(),
    migration: migrationPrepareSchema.optional(),
    migrationStep: migrationStepSchema.optional(),
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

export type GitHubIssueReader = (owner: string, repo: string, issueNumber: number) => GitHubIssueSnapshot | null;

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
  seq: number;
  type: string;
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
  const providerThreadId = stringField(acceptedEvent.data.providerThreadId);
  if (!providerThreadId) throw refusal("EXECUTION_PROFILE_UNKNOWN", "provider thread correlation is unavailable");
  const starts = events.filter((event) => event.type === "turn/started" && event.data.providerThreadId === providerThreadId);
  if (starts.length !== 1) throw refusal("EXECUTION_PROFILE_UNKNOWN", "correlated execution start is missing or ambiguous");
  const startEvent = starts[0]!;
  const completions = events.filter((event) => event.type === "turn/completed" && event.data.providerThreadId === providerThreadId);
  if (completions.length !== 1) throw refusal("EXECUTION_COMPLETION_AMBIGUOUS", "correlated execution completion is missing or ambiguous");
  const correlatedCompletion = completions[0]!;
  if (correlatedCompletion.id !== completion.id || correlatedCompletion.seq !== completion.seq) {
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
  actorReceiptId?: string;
  eventSequence?: number;
  evidence?: unknown;
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
      if (roleRequirements !== undefined) {
        const parsed = roleRequirementsSchema.safeParse(roleRequirements);
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
    lifecycleState: request.lifecycleState ?? undefined,
    workItemWait: request.workItemWait === undefined ? undefined : request.workItemWait,
    workAttempt: request.workAttempt ?? undefined,
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
}): string {
  return sha256(canonicalJson({
    projectId: input.projectId,
    receiptId: input.receiptId,
    actorKind: input.actorKind,
    subjectId: input.subjectId,
    roleId: input.roleId,
    roleGeneration: input.roleGeneration,
    verificationState: input.verificationState,
    operatorReceiptId: input.operatorReceiptId,
    retirementCondition: input.retirementCondition,
  }));
}

function mutationRequestDigest(request: ApplyRequest): string {
  return sha256(canonicalJson(Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined))));
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
    operator_receipt_id: string | null;
    retirement_condition: string | null;
    receipt_digest: string;
  }>(
    db.prepare("SELECT project_id, actor_kind, subject_id, role_id, role_generation, verification_state, operator_receipt_id, retirement_condition, receipt_digest FROM actor_receipts WHERE receipt_id = ?").get(request.actorReceiptId),
  );
  if (!row) throw refusal("ACTOR_RECEIPT_UNKNOWN", "actor receipt is not known");
  if (row.project_id !== request.projectId) throw refusal("ACTOR_RECEIPT_FOREIGN", "actor receipt belongs to another project");
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
  if (request.expectedGovernanceEpoch !== head.governance_epoch || request.expectedFenceToken !== head.fence_token) {
    throw refusal("GOVERNOR_EPOCH_STALE", "expected governorship epoch or fence token is stale", {
      currentGovernanceEpoch: head.governance_epoch,
      expectedGovernanceEpoch: request.expectedGovernanceEpoch ?? undefined,
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

function requireAdoptedMigrationDecision(
  db: SqliteDatabase,
  projectId: string,
  configRevision: number,
  decisionId: string,
  dispositionSequence: number,
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
    throw refusal("INVALID_INPUT", "migration requires the current adopted Decision disposition");
  }
  const actor = asRow<{
    project_id: string; actor_kind: string; subject_id: string; role_id: string | null; role_generation: number | null;
    verification_state: string; operator_receipt_id: string | null; retirement_condition: string | null; receipt_digest: string;
  }>(db.prepare(
    "SELECT project_id, actor_kind, subject_id, role_id, role_generation, verification_state, operator_receipt_id, retirement_condition, receipt_digest FROM actor_receipts WHERE receipt_id = ?",
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
  });
  if (!actor || actor.project_id !== projectId || actor.actor_kind !== "role" || actor.verification_state !== "verified" || actor.receipt_digest !== actorDigest) {
    throw refusal("ACTOR_RECEIPT_UNVERIFIED", "authorizing Decision actor receipt is not verified");
  }
  requireRoleActorBinding(db, { projectId, actorReceiptId: disposition.actor_receipt_id } as ApplyRequest);
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
  requireRoleActorBinding(db, request);
  const migration = request.migration;
  if (!migration || request.migrationStep) throw refusal("INVALID_INPUT", "migration_prepare requires one immutable MigrationRun input");
  if (migration.targetRuntimeId !== PLUGIN_ID || migration.retentionUntilMs <= now()) {
    throw refusal("INVALID_INPUT", "migration prepare requires the exact target runtime and future retention");
  }
  requireAdoptedMigrationDecision(
    db, request.projectId, configRevision, migration.decisionId, migration.decisionDispositionSequence,
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
  requireRoleActorBinding(db, request);
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
  requireAdoptedMigrationDecision(db, request.projectId, configRevision, run.decision_id, run.decision_disposition_sequence);
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

function requireDecisionActor(db: SqliteDatabase, request: ApplyRequest): string {
  const actorReceiptId = requireActor(db, request);
  const actor = asRow<{ actor_kind: string; role_id: string | null }>(
    db.prepare("SELECT actor_kind, role_id FROM actor_receipts WHERE project_id = ? AND receipt_id = ?").get(request.projectId, actorReceiptId),
  );
  if (!actor || actor.actor_kind !== "role") {
    throw refusal("ACTOR_RECEIPT_UNVERIFIED", "decision authority requires a current role actor");
  }
  requireRoleActorBinding(db, request);
  if (actor.role_id !== "project-orchestrator") {
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
  const actorReceiptId = requireDecisionActor(db, request);
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
  const actorReceiptId = requireDecisionActor(db, request);
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
  const source = context.baseContext.source as { path?: unknown };
  if (target.source_id !== context.sourceId || target.host_id !== context.hostId || target.path !== source.path) {
    throw refusal("ROLE_CONTEXT_FOREIGN", "holder context does not match the exact repository target source, host, and path");
  }
}

function requireRoleActorBinding(db: SqliteDatabase, request: ApplyRequest, required = true): void {
  if (!request.actorReceiptId) return;
  const actor = asRow<{ actor_kind: string; subject_id: string; role_id: string | null; role_generation: number | null }>(
    db.prepare("SELECT actor_kind, subject_id, role_id, role_generation FROM actor_receipts WHERE project_id = ? AND receipt_id = ?").get(
      request.projectId,
      request.actorReceiptId,
    ),
  );
  if (!actor || actor.actor_kind !== "role") {
    if (!required) return;
    throw refusal("ACTOR_RECEIPT_UNVERIFIED", "current role actor receipt is required");
  }
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
    holder_requested_profile_digest: string;
    qualification_id: string;
    eligibility_derivation_digest: string;
  }>(
    db.prepare(`SELECT status, role_requirement_id, config_revision, holder_execution_attempt_id,
                       holder_context_digest, holder_requested_profile_digest, qualification_id,
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
     WHERE project_id = ? AND role_requirement_id = ? AND requested_profile_digest = ?`,
  ).get(request.projectId, generation.role_requirement_id, generation.holder_requested_profile_digest));
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
      project_id, qualification_id, role_requirement_id, config_revision, repo_target_id,
      role_requirement_digest, requested_profile_digest, requested_provider_id, requested_model, requested_reasoning_level,
      requested_permission_mode, requested_service_tier, requested_visibility, thread_id, environment_id, source_id, host_id,
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
      project_id, role_requirement_id, requested_profile_digest, current_qualification_id,
      effective_status, qualification_context_digest, config_revision, role_requirement_digest,
      derived_at_ms, expires_at_ms, derivation_digest, reason_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  requireRoleActorBinding(db, request, false);
  if (!request.roleId || !request.qualificationId || !request.profileDigest || !request.fixtureContextDigest) {
    throw refusal("INVALID_INPUT", "role succession requires role, qualification, profile, and fixture context identities");
  }
  const resolved = requireRoleRequirement(db, request, configRevision);
  requireRoleTargetContext(db, request, resolved, context);
  if (!roleRequirementProfileMatches(resolved.requirement, context.profile) || request.profileDigest !== context.requestedProfileDigest) {
    throw refusal("EXECUTION_PROFILE_MISMATCH", "holder requested profile does not match the role requirement");
  }
  const standbyProfile = request.standbyProfile;
  if (resolved.requirement.standbyProfile && (!standbyProfile || !roleRequirementProfileMatches(resolved.requirement, standbyProfile))) {
    throw refusal("ROLE_STANDBY_INVALID", "director-seat succession requires another allowed profile from its configured pair");
  }
  if (request.roleId === "director") {
    if (!standbyProfile || standbyProfile.providerId === context.profile.providerId) {
      throw refusal("ROLE_STANDBY_INVALID", "director succession requires a named standby from another provider");
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
    db.prepare("SELECT * FROM eligibility_projections WHERE project_id = ? AND role_requirement_id = ? AND requested_profile_digest = ?").get(
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
      holder_requested_profile_digest, qualification_id, eligibility_derivation_digest,
      created_at_ms, activated_at_ms, retired_at_ms, standby_profile_json
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
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
    context.requestedProfileDigest,
    request.qualificationId,
    projection.derivation_digest,
    createdAtMs,
    createdAtMs,
    standbyProfile ? canonicalJson(standbyProfile) : null,
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
      event: {
        roleId: request.roleId,
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

type WorkAttempt = z.infer<typeof workAttemptSchema>;
type WorkAttemptState = "running" | "done" | "failed";
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
  attemptOrdinal: number;
  laneId: string;
  threadId: string | null;
  reviewPrNumber: number | null;
  reviewPrHeadSha: string | null;
}): string {
  return sha256(canonicalJson({ origin: "work_item", ...input }));
}

function insertWorkItemAttempt(
  db: SqliteDatabase,
  input: {
    projectId: string;
    workItemId: string;
    configRevision: number;
    repoTargetId: string;
    laneId: string;
    threadId: string | null;
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
  },
): string {
  const executionAttemptId = workAttemptId(input);
  const attemptDigest = sha256(canonicalJson({
    origin: "work_item",
    executionAttemptId,
    projectId: input.projectId,
    workItemId: input.workItemId,
    laneId: input.laneId,
    threadId: input.threadId,
    assignmentKind: input.assignmentKind,
    requestedProfileDigest: input.requestedProfile ? requestedProfileDigest(input.requestedProfile) : null,
    reviewPrNumber: input.reviewPrNumber,
    reviewPrHeadSha: input.reviewPrHeadSha,
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
       requested_provider_id, requested_model, requested_reasoning_level, requested_profile_digest,
       review_pr_number, review_pr_head_sha, progress_json, lease_owner_thread_id, continuation_of_attempt_id, created_at_ms,
       observed_at_ms, completed_at_ms, attempt_digest
     ) VALUES (
       @projectId, @executionAttemptId, 'work_item', @laneId, @assignmentKind, @attemptOrdinal,
       @configRevision, @workItemId, @repoTargetId, @state, @threadId, @reasonCode,
       @requestedProviderId, @requestedModel, @requestedReasoningLevel, @requestedProfileDigest,
       @reviewPrNumber, @reviewPrHeadSha,
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
    requestedProviderId: input.requestedProfile?.providerId ?? null,
    requestedModel: input.requestedProfile?.model ?? null,
    requestedReasoningLevel: input.requestedProfile?.reasoningLevel ?? null,
    requestedProfileDigest: input.requestedProfile ? requestedProfileDigest(input.requestedProfile) : null,
    reviewPrNumber: input.reviewPrNumber,
    reviewPrHeadSha: input.reviewPrHeadSha,
    leaseOwnerThreadId: input.leaseOwnerThreadId,
    continuationOfAttemptId: input.continuationOfAttemptId,
    createdAtMs: input.createdAtMs,
    observedAtMs: input.observedAtMs,
    completedAtMs: input.completedAtMs,
    attemptDigest,
  });
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
    const rows = db.prepare(
      `SELECT project_id, work_item_id, config_revision, repo_target_id, body, lifecycle_state, created_at_ms, updated_at_ms
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
): { execution_attempt_id: string; review_pr_number: number | null; review_pr_head_sha: string | null } | undefined {
  const assignmentFilter = assignmentKind === undefined ? "" : " AND assignment_kind = ?";
  return asRow<{ execution_attempt_id: string; review_pr_number: number | null; review_pr_head_sha: string | null }>(db.prepare(
    `SELECT execution_attempt_id, review_pr_number, review_pr_head_sha FROM execution_attempts
     WHERE project_id = ? AND work_item_id = ? AND origin = 'work_item'
       AND state IN (${ACTIVE_WORK_ATTEMPT_STATES.map(() => "?").join(", ")})${assignmentFilter}
     ORDER BY attempt_ordinal DESC LIMIT 1`,
  ).get(projectId, workItemId, ...ACTIVE_WORK_ATTEMPT_STATES, ...(assignmentKind === undefined ? [] : [assignmentKind])));
}

function terminalizeWorkItemAttempt(
  db: SqliteDatabase,
  projectId: string,
  workItemId: string,
  state: "done" | "blocked" | "failed" | "superseded",
  assignmentKind?: WorkAttempt["assignmentKind"],
): string | null {
  const active = activeWorkItemAttempt(db, projectId, workItemId, assignmentKind);
  if (!active) return null;
  const completedAtMs = now();
  db.prepare(
    `UPDATE execution_attempts
     SET state = ?, observed_at_ms = ?, completed_at_ms = ?, lease_owner_thread_id = NULL,
         progress_json = '{}'
     WHERE project_id = ? AND execution_attempt_id = ?`,
  ).run(state, completedAtMs, completedAtMs, projectId, active.execution_attempt_id);
  return active.execution_attempt_id;
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
  waker_kind: "schedule" | "seat" | "work_item_succeeded" | "github_issue_closed";
  declared_at_ms: number;
  declared_by_seat: string;
  note: string | null;
}

type WorkItemBlocker = NonNullable<ApplyRequest["workItemUnblock"]>;

function workItemBlockerWaker(blocker: WorkItemBlocker): string {
  return blocker.kind === "work_item_succeeded"
    ? blocker.workItemId
    : `${blocker.owner}/${blocker.repo}#${blocker.issueNumber}`;
}

function storedWorkItemBlocker(row: WorkItemWaitRow): WorkItemBlocker | null {
  if (row.waker_kind === "work_item_succeeded") {
    return { kind: "work_item_succeeded", workItemId: row.waker };
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

function workItemGithubReadTarget(request: ApplyRequest): { owner: string; repo: string; issueNumber: number } | null {
  const targets = [request.workItemWait, request.workItemUnblock, request.workItemExternalEvent]
    .flatMap((value) => value && value.kind !== "work_item_succeeded" && value.kind !== "schedule" && value.kind !== "seat"
      ? [{ owner: value.owner, repo: value.repo, issueNumber: value.issueNumber }]
      : []);
  if (targets.length > 1) throw refusal("WORK_ITEM_STATE_INVALID", "work item transition accepts one external condition");
  return targets[0] ?? null;
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
  requireTarget(db, request.projectId, configRevision, request.repoTargetId, allowStaleConfig);
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
  if (request.workItemWait !== undefined) throw refusal("WORK_ITEM_STATE_INVALID", "work item wait requires a work item transition");
  if (!request.repoTargetId) throw refusal("REPO_TARGET_REQUIRED", "work item create requires an exact repository target");
  requireTarget(db, request.projectId, configRevision, request.repoTargetId);
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
  const workItem = {
    project_id: request.projectId,
    work_item_id: request.workItem.workItemId,
    config_revision: configRevision,
    repo_target_id: request.repoTargetId,
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
  ready: ["in_progress", "blocked", "cancelled"],
  in_progress: ["review_pending", "blocked", "failed", "cancelled"],
  review_pending: ["in_progress", "blocked", "succeeded", "failed", "cancelled"],
  blocked: ["ready", "cancelled"],
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

function requireBlockerCondition(
  db: SqliteDatabase,
  request: ApplyRequest,
  blocker: WorkItemBlocker,
  githubObservation: GitHubIssueSnapshot | null,
  satisfied: boolean,
): void {
  let conditionSatisfied: boolean;
  if (blocker.kind === "work_item_succeeded") {
    if (blocker.workItemId === request.workItemId) throw refusal("WORK_ITEM_STATE_INVALID", "work item cannot block on itself");
    const dependency = asRow<{ lifecycle_state: WorkItemState }>(db.prepare(
      "SELECT lifecycle_state FROM work_items WHERE project_id = ? AND work_item_id = ?",
    ).get(request.projectId, blocker.workItemId));
    if (!dependency) throw refusal("WORK_ITEM_UNKNOWN", "blocking work item does not exist in the exact project");
    if (["failed", "cancelled"].includes(dependency.lifecycle_state)) {
      throw refusal("WORK_ITEM_STATE_INVALID", "work item cannot block on a terminal dependency that did not succeed");
    }
    conditionSatisfied = dependency.lifecycle_state === "succeeded";
  } else {
    if (!githubObservation) throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub blocker observation is unavailable");
    conditionSatisfied = githubObservation.state === "closed";
  }
  if (conditionSatisfied !== satisfied) {
    throw refusal("WORK_ITEM_STATE_INVALID", satisfied ? "work item blocker has not fired" : "work item blocker already fired");
  }
}

function recordedGithubCloseObservation(
  db: SqliteDatabase,
  projectId: string,
  workItemId: string,
  resourceRevision: number,
): { kind: "github_issue_closed"; owner: string; repo: string; issueNumber: number; externalRevision: string } {
  const row = asRow<{ event_json: string }>(db.prepare(
    `SELECT event_json FROM state_events
     WHERE project_id = ? AND aggregate_type = 'work_item' AND aggregate_id = ?
       AND aggregate_revision = ? AND event_type = 'work_item_transitioned'
     ORDER BY event_sequence DESC LIMIT 1`,
  ).get(projectId, workItemId, resourceRevision));
  if (!row) throw refusal("WORK_ITEM_STATE_INVALID", "succeeded work item has no recorded close observation");
  let event: unknown;
  try {
    event = JSON.parse(row.event_json);
  } catch {
    throw refusal("WORK_ITEM_STATE_INVALID", "succeeded work item close observation is malformed");
  }
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

function applyWorkItemTransition(
  db: SqliteDatabase,
  request: ApplyRequest,
  digest: string,
  githubObservation: GitHubIssueSnapshot | null,
): FoundationResult {
  const configRevision = requireConfig(db, request);
  const governor = requireGovernor(db, request);
  const actorReceiptId = requireActor(db, request);
  const nextState = request.lifecycleState;
  const workItem = requireWorkItem(
    db,
    request,
    configRevision,
    request.expectedResourceRevision,
    nextState !== undefined || request.workItemWait === null,
  );
  const wait = request.workItemWait;
  const unblock = request.workItemUnblock;
  const externalEvent = request.workItemExternalEvent;
  const workAttempt = request.workAttempt;
  const existingWait = asRow<WorkItemWaitRow>(db.prepare(
    "SELECT * FROM work_item_waits WHERE project_id = ? AND work_item_id = ?",
  ).get(request.projectId, workItem.work_item_id));
  const machineWait = wait && (wait.kind === "work_item_succeeded" || wait.kind === "github_issue_closed") ? wait : null;
  const enteringBlocked = nextState === "blocked";
  if (enteringBlocked) {
    if (!machineWait || workAttempt !== undefined || unblock !== undefined || externalEvent !== undefined) {
      throw refusal("WORK_ITEM_STATE_INVALID", "entering blocked requires exactly one machine-evaluable blocker");
    }
    if (existingWait) throw refusal("WORK_ITEM_WAIT_OPEN", "work item already carries an open wait");
    const blocker: WorkItemBlocker = machineWait.kind === "work_item_succeeded"
      ? { kind: machineWait.kind, workItemId: machineWait.workItemId }
      : { kind: machineWait.kind, owner: machineWait.owner, repo: machineWait.repo, issueNumber: machineWait.issueNumber };
    requireBlockerCondition(db, request, blocker, githubObservation, false);
  } else if (wait !== undefined && (nextState !== undefined || workAttempt !== undefined)) {
    throw refusal("WORK_ITEM_STATE_INVALID", "work item wait mutation cannot change lifecycle state");
  }
  if (wait !== undefined && !enteringBlocked) {
    if (machineWait) throw refusal("WORK_ITEM_STATE_INVALID", "machine-evaluable blocker requires an atomic transition to blocked");
    if (["blocked", "succeeded", "failed", "cancelled"].includes(workItem.lifecycle_state)) {
      throw refusal("WORK_ITEM_STATE_INVALID", "blocked or terminal work item cannot carry a human wait");
    }
    if (wait !== null && existingWait) throw refusal("WORK_ITEM_WAIT_OPEN", "work item already carries an open wait");
    if (wait === null && !existingWait) throw refusal("WORK_ITEM_WAIT_OPEN", "work item carries no open wait");
    const nextRevision = workItem.resource_revision + 1;
    const updated = db.prepare(
      `UPDATE work_items SET resource_revision = ?, updated_at_ms = ?
       WHERE project_id = ? AND work_item_id = ? AND resource_revision = ?`,
    ).run(nextRevision, now(), request.projectId, workItem.work_item_id, workItem.resource_revision);
    if (updated.changes !== 1) throw refusal("WORK_ITEM_REVISION_STALE", "work item compare-and-swap failed", {
      currentResourceRevision: workItem.resource_revision,
      expectedResourceRevision: request.expectedResourceRevision ?? undefined,
    });
    if (wait === null) {
      db.prepare("DELETE FROM work_item_waits WHERE project_id = ? AND work_item_id = ?").run(request.projectId, workItem.work_item_id);
    } else {
      if (wait.kind !== "schedule" && wait.kind !== "seat") throw refusal("WORK_ITEM_STATE_INVALID", "machine-evaluable blocker requires blocked");
      db.prepare(
        `INSERT INTO work_item_waits (project_id, work_item_id, waker, waker_kind, declared_at_ms, declared_by_seat, note)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      ).run(request.projectId, workItem.work_item_id, wait.kind === "schedule" ? wait.schedule : wait.seat, wait.kind, now(), wait.declaredBySeat);
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
        event: { workItemId: workItem.work_item_id, ...(wait === null ? {} : { waker: wait, declaredBySeat: wait.declaredBySeat }) },
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
  const priorReview = redispatchingReview
    ? activeWorkItemAttempt(db, request.projectId, workItem.work_item_id, "review")
    : undefined;
  if (redispatchingReview && (
    !workAttempt || !workAttempt.threadId || !workAttempt.requestedProfile ||
    workAttempt.reviewPrNumber === undefined || workAttempt.reviewPrHeadSha === undefined ||
    !priorReview || priorReview.review_pr_number !== workAttempt.reviewPrNumber ||
    priorReview.review_pr_head_sha !== workAttempt.reviewPrHeadSha
  )) {
    throw refusal("WORK_ITEM_STATE_INVALID", "review re-dispatch requires one active review and the same exact PR head, replacement thread, and profile");
  }
  if (workAttempt !== undefined && nextState === undefined) {
    if (workItem.lifecycle_state !== "in_progress") {
      throw refusal("WORK_ITEM_STATE_INVALID", "replacement work attempts require an in-progress work item");
    }
    if (workAttempt.assignmentKind !== "write") {
      throw refusal("WORK_ITEM_STATE_INVALID", "replacement work attempts must be writing attempts");
    }
    const prior = activeWorkItemAttempt(db, request.projectId, workItem.work_item_id);
    const nextRevision = workItem.resource_revision + 1;
    const updated = db.prepare(
      `UPDATE work_items SET resource_revision = ?, updated_at_ms = ?
       WHERE project_id = ? AND work_item_id = ? AND resource_revision = ?`,
    ).run(nextRevision, now(), request.projectId, workItem.work_item_id, workItem.resource_revision);
    if (updated.changes !== 1) throw refusal("WORK_ITEM_REVISION_STALE", "work item compare-and-swap failed", {
      currentResourceRevision: workItem.resource_revision,
      expectedResourceRevision: request.expectedResourceRevision ?? undefined,
    });
    if (prior) terminalizeWorkItemAttempt(db, request.projectId, workItem.work_item_id, "superseded");
    const createdAtMs = now();
    const executionAttemptId = insertWorkItemAttempt(db, {
      projectId: request.projectId,
      workItemId: workItem.work_item_id,
      configRevision: workItem.config_revision,
      repoTargetId: workItem.repo_target_id,
      laneId: workAttempt.laneId,
      threadId: workAttempt.threadId ?? null,
      leaseOwnerThreadId: workAttempt.threadId ?? null,
      assignmentKind: workAttempt.assignmentKind,
      requestedProfile: requireWorkAttemptProfile(workAttempt),
      attemptOrdinal: nextWorkAttemptOrdinal(db, request.projectId, workItem.work_item_id),
      state: "running",
      reasonCode: "work_item_dispatch",
      createdAtMs,
      observedAtMs: createdAtMs,
      completedAtMs: null,
      continuationOfAttemptId: prior?.execution_attempt_id ?? null,
      reviewPrNumber: null,
      reviewPrHeadSha: null,
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
  if (!nextState || (!redispatchingReview && !WORK_ITEM_TRANSITIONS[workItem.lifecycle_state].includes(nextState))) {
    throw refusal("WORK_ITEM_STATE_INVALID", "work item lifecycle transition is not allowed");
  }
  let recordedExternalEvent: { kind: "github_issue_closed" | "github_issue_reopened"; owner: string; repo: string; issueNumber: number; externalRevision: string } | null = null;
  if (workItem.lifecycle_state === "blocked") {
    const storedBlocker = existingWait ? storedWorkItemBlocker(existingWait) : null;
    if (!storedBlocker) throw refusal("WORK_ITEM_STATE_INVALID", "blocked work item has no valid machine-evaluable blocker");
    if (nextState === "ready") {
      if (!unblock || !sameWorkItemBlocker(storedBlocker, unblock)) {
        throw refusal("WORK_ITEM_STATE_INVALID", "blocked to ready requires the exact stored blocker");
      }
      requireBlockerCondition(db, request, unblock, githubObservation, true);
    } else if (unblock !== undefined) {
      throw refusal("WORK_ITEM_STATE_INVALID", "work item unblock evidence only permits blocked to ready");
    }
  } else if (unblock !== undefined) {
    throw refusal("WORK_ITEM_STATE_INVALID", "work item unblock evidence requires a blocked work item");
  }
  if (externalEvent) {
    if (!githubObservation) throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub lifecycle observation is unavailable");
    requireBoundGithubIssue(db, request.projectId, workItem.work_item_id, externalEvent);
    if (externalEvent.kind === "github_issue_closed") {
      if (nextState !== "succeeded" || githubObservation.state !== "closed") {
        throw refusal("WORK_ITEM_STATE_INVALID", "close observation only permits a transition to succeeded");
      }
    } else {
      if (workItem.lifecycle_state !== "succeeded" || nextState !== "ready" || githubObservation.state !== "open") {
        throw refusal("WORK_ITEM_STATE_INVALID", "reopen observation only permits succeeded to ready");
      }
      const prior = recordedGithubCloseObservation(db, request.projectId, workItem.work_item_id, workItem.resource_revision);
      if (
        prior.owner !== externalEvent.owner ||
        prior.repo !== externalEvent.repo ||
        prior.issueNumber !== externalEvent.issueNumber ||
        prior.externalRevision === githubObservation.externalRevision
      ) throw refusal("WORK_ITEM_STATE_INVALID", "GitHub reopen does not follow the exact recorded close observation");
    }
    recordedExternalEvent = { ...externalEvent, externalRevision: githubObservation.externalRevision };
  } else if (workItem.lifecycle_state === "succeeded" && nextState === "ready") {
    throw refusal("WORK_ITEM_STATE_INVALID", "succeeded work item can return only after a proven GitHub issue reopening");
  }
  if (nextState === "in_progress" && workAttempt === undefined) {
    throw refusal("WORK_ITEM_STATE_INVALID", "entering in-progress requires a work attempt");
  }
  if (nextState === "review_pending" && !redispatchingReview && !activeWorkItemAttempt(db, request.projectId, workItem.work_item_id, "write")) {
    throw refusal("WORK_ITEM_STATE_INVALID", "review-pending requires an active writing attempt to close");
  }
  if (workItem.lifecycle_state === "review_pending" && activeWorkItemAttempt(db, request.projectId, workItem.work_item_id, "write")) {
    throw refusal("WORK_ITEM_STATE_INVALID", "review-pending cannot carry an active writing attempt");
  }
  if (["succeeded", "failed", "cancelled"].includes(nextState) && existingWait && workItem.lifecycle_state !== "blocked") {
    throw refusal("WORK_ITEM_WAIT_OPEN", "resolve the work item wait before terminalizing it");
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
  if (enteringBlocked) {
    const blocker: WorkItemBlocker = machineWait!.kind === "work_item_succeeded"
      ? { kind: machineWait!.kind, workItemId: machineWait!.workItemId }
      : { kind: machineWait!.kind, owner: machineWait!.owner, repo: machineWait!.repo, issueNumber: machineWait!.issueNumber };
    db.prepare(
      `INSERT INTO work_item_waits (project_id, work_item_id, waker, waker_kind, declared_at_ms, declared_by_seat, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(request.projectId, workItem.work_item_id, workItemBlockerWaker(blocker), blocker.kind, now(), machineWait!.declaredBySeat, machineWait!.note ?? null);
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
      configRevision: workItem.config_revision,
      repoTargetId: workItem.repo_target_id,
      laneId: workAttempt!.laneId,
      threadId: workAttempt!.threadId ?? null,
      leaseOwnerThreadId: workAttempt!.threadId ?? null,
      assignmentKind: workAttempt!.assignmentKind,
      requestedProfile: requireWorkAttemptProfile(workAttempt!),
      attemptOrdinal: nextWorkAttemptOrdinal(db, request.projectId, workItem.work_item_id),
      state: "running",
      reasonCode: "work_item_dispatch",
      createdAtMs: now(),
      observedAtMs: now(),
      completedAtMs: null,
      continuationOfAttemptId: prior?.execution_attempt_id ?? null,
      reviewPrNumber: null,
      reviewPrHeadSha: null,
    });
  } else if (nextState === "review_pending") {
    executionAttemptId = redispatchingReview
      ? terminalizeWorkItemAttempt(db, request.projectId, workItem.work_item_id, "superseded", "review")
      : terminalizeWorkItemAttempt(db, request.projectId, workItem.work_item_id, "done", "write");
    if (workAttempt) {
      reviewExecutionAttemptId = insertWorkItemAttempt(db, {
        projectId: request.projectId,
        workItemId: workItem.work_item_id,
        configRevision: workItem.config_revision,
        repoTargetId: workItem.repo_target_id,
        laneId: workAttempt.laneId,
        threadId: workAttempt.threadId ?? null,
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
      });
    }
  } else {
    executionAttemptId = terminalizeWorkItemAttempt(
      db,
      request.projectId,
      workItem.work_item_id,
      nextState === "succeeded" ? "done" : nextState === "blocked" ? "blocked" : "failed",
      workItem.lifecycle_state === "review_pending" ? "review" : undefined,
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
      eventType: "work_item_transitioned",
      event: {
        workItemId: workItem.work_item_id,
        from: workItem.lifecycle_state,
        to: nextState,
        ...(executionAttemptId === null ? {} : { executionAttemptId }),
        ...(reviewExecutionAttemptId === null ? {} : { reviewExecutionAttemptId }),
        ...(workAttempt === undefined ? {} : { workAttempt }),
        ...(machineWait === null ? {} : { blocker: machineWait }),
        ...(unblock === undefined ? {} : { unblock }),
        ...(recordedExternalEvent === null ? {} : { externalEvent: recordedExternalEvent }),
      },
    },
    { expected: 1, attempted: 1, verified: 1 },
    {
      currentConfigRevision: configRevision,
      currentGovernanceEpoch: governor.governance_epoch,
      currentResourceRevision: nextRevision,
      expectedResourceRevision: request.expectedResourceRevision ?? undefined,
        evidence: {
          workItemId: workItem.work_item_id,
          lifecycleState: nextState,
          ...(executionAttemptId === null ? {} : { executionAttemptId }),
          ...(reviewExecutionAttemptId === null ? {} : { reviewExecutionAttemptId }),
          ...(machineWait === null ? {} : { blocker: machineWait }),
          ...(unblock === undefined ? {} : { unblock }),
          ...(recordedExternalEvent === null ? {} : { externalEvent: recordedExternalEvent }),
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
    const rows = db.prepare(
      `SELECT project_id, work_item_id, config_revision, repo_target_id, title, body,
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
          idempotencyKey: `github-issue-backfill:${projectId}:${row.work_item_id}`,
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
      if ((ref.projection_state === "pending" && ref.issue_number === null) || ref.projection_state === "delivery_ambiguous") {
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
    const initialBinding = context.ref.projection_state === "pending" && context.ref.issue_number !== null && context.ref.observed_external_digest === null;
    if (!initialBinding && (!context.ref.observed_external_digest || observedDigest(current, context.desired) !== context.ref.observed_external_digest)) {
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
): FoundationResult {
  let request: ApplyRequest;
  try {
    request = parseApplyRequest(input);
  } catch (error) {
    if (error instanceof Refusal) return refusalResult("apply", error.data);
    return result("INVALID_INPUT", "apply", 1, 0, 0, { message: String(error) });
  }
  if (!db) return unavailableResult(request.projectId, "canonical SQLite store is unavailable");
  return applyFixtureMutation(db, request, githubAdapter, roleFactReader, nativeAssignmentAdapter, reviewFactReader, githubIssueReader);
}

export function applyFixtureMutation(
  db: SqliteDatabase | null,
  input: unknown,
  githubAdapter: GitHubIssueAdapter | null = null,
  roleFactReader: RoleFactReader | null = null,
  nativeAssignmentAdapter: NativeAssignmentAdapter | null = null,
  reviewFactReader: ReviewFactReader | null = null,
  githubIssueReader: GitHubIssueReader | null = null,
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
    const githubTarget = request.operationClass === "work_item_transition"
      ? workItemGithubReadTarget(request)
      : null;
    let githubObservation: GitHubIssueSnapshot | null = null;
    if (githubTarget) {
      const replay = checkIdempotency(db, request, digest);
      if (replay) return replay;
      const reader = githubIssueReader ?? (githubAdapter ? githubAdapter.read.bind(githubAdapter) : null);
      if (!reader) throw refusal("EXTERNAL_TARGET_REQUIRED", "work item transition requires a live GitHub issue reader");
      try {
        githubObservation = reader(githubTarget.owner, githubTarget.repo, githubTarget.issueNumber);
      } catch {
        throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub issue observation is unavailable");
      }
      if (
        !githubObservation ||
        githubObservation.owner !== githubTarget.owner ||
        githubObservation.repo !== githubTarget.repo ||
        githubObservation.issueNumber !== githubTarget.issueNumber
      ) throw refusal("EXTERNAL_RESPONSE_INVALID", "GitHub issue observation does not match the exact blocker identity");
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
          return applyWorkItemTransition(db, request, digest, githubObservation);
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

function tableRows(db: SqliteDatabase, table: (typeof TABLES)[number], projectId: string, offset: number): Record<string, unknown>[] {
  const orderBy: Record<(typeof TABLES)[number], string> = {
    project_config_revisions: "config_revision",
    project_config_heads: "project_id",
    repository_targets: "repo_target_id, config_revision",
    project_governorships: "governance_epoch",
    project_governorship_heads: "project_id",
    migration_runs: "migration_id",
    actor_receipts: "receipt_id",
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
    role_generation_heads: "role_id",
    lane_capacity_intervals: "interval_id",
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
    const key = `${profile.providerId}\0${profile.model}\0${profile.reasoningLevel}`;
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
      const actor = asRow<{ actor_kind: string; project_id: string; verification_state: string; receipt_digest: string; subject_id: string; role_id: string | null; role_generation: number | null; operator_receipt_id: string | null; retirement_condition: string | null }>(
        db.prepare("SELECT * FROM actor_receipts WHERE receipt_id = ?").get(disposition.actor_receipt_id),
      );
      const linkedReceipt = actor?.operator_receipt_id ? asRow<{ caller_plugin_id: string; mutation_class: string }>(db.prepare(
        "SELECT caller_plugin_id, mutation_class FROM operator_receipts WHERE project_id = ? AND receipt_id = ?",
      ).get(projectId, actor.operator_receipt_id)) : undefined;
      const pluginActor = actor?.actor_kind === "plugin" && decision.decision_class === "operator_only" && actor.subject_id === PLUGIN_ID &&
        actor.retirement_condition === OPERATOR_RECEIPT_RETIREMENT_CONDITION && linkedReceipt?.caller_plugin_id === PLUGIN_ID &&
        linkedReceipt.mutation_class === "decision_disposition";
      if (!actor || actor.project_id !== projectId || actor.verification_state !== "verified" || (!pluginActor && !["role", "operator"].includes(actor.actor_kind))) {
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
        });
        if (receiptDigest !== actor.receipt_digest) issues.push({ decisionId: decision.decision_id, reason: "decision_actor_digest_invalid" });
        if (actor.actor_kind === "role") {
          const role = asRow<{ current_generation: number; status: string; holder_execution_attempt_id: string; holder_context_digest: string; holder_requested_profile_digest: string; qualification_id: string; eligibility_derivation_digest: string; role_requirement_id: string }>(db.prepare(
            `SELECT role_generation_heads.current_generation, role_generations.status,
                    role_generations.holder_execution_attempt_id, role_generations.holder_context_digest,
                    role_generations.holder_requested_profile_digest, role_generations.qualification_id,
                    role_generations.eligibility_derivation_digest, role_generations.role_requirement_id
             FROM role_generation_heads JOIN role_generations
               ON role_generations.project_id = role_generation_heads.project_id
              AND role_generations.role_id = role_generation_heads.role_id
              AND role_generations.generation = role_generation_heads.current_generation
             WHERE role_generation_heads.project_id = ? AND role_generation_heads.role_id = ?`,
          ).get(projectId, actor.role_id));
          const holder = role && asRow<{ state: string; origin: string; native_receipt_digest: string | null; requested_profile_digest: string | null }>(
            db.prepare("SELECT state, origin, native_receipt_digest, requested_profile_digest FROM execution_attempts WHERE project_id = ? AND execution_attempt_id = ?").get(projectId, role.holder_execution_attempt_id),
          );
          const eligibility = role && asRow<{ current_qualification_id: string; effective_status: string; expires_at_ms: number | null; derivation_digest: string }>(db.prepare(
            "SELECT current_qualification_id, effective_status, expires_at_ms, derivation_digest FROM eligibility_projections WHERE project_id = ? AND role_requirement_id = ? AND requested_profile_digest = ?",
          ).get(projectId, role.role_requirement_id, role.holder_requested_profile_digest));
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
    const roleGenerationHeads = (db.prepare(
      `SELECT role_generation_heads.role_id, role_generation_heads.current_generation,
              role_generations.status, role_generations.qualification_id,
              role_generations.holder_execution_attempt_id,
              role_generations.standby_profile_json,
              execution_attempts.state AS holder_attempt_state,
              execution_attempts.native_receipt_digest AS holder_native_receipt_digest,
              execution_attempts.thread_id AS holder_thread_id
       FROM role_generation_heads
       JOIN role_generations ON role_generations.project_id = role_generation_heads.project_id
         AND role_generations.role_id = role_generation_heads.role_id
         AND role_generations.generation = role_generation_heads.current_generation
       LEFT JOIN execution_attempts ON execution_attempts.project_id = role_generations.project_id
         AND execution_attempts.execution_attempt_id = role_generations.holder_execution_attempt_id
       WHERE role_generation_heads.project_id = ? ORDER BY role_generation_heads.role_id`,
    ).all(projectId) as Array<Record<string, unknown>>).map((row): Record<string, unknown> => {
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
    const configuredRequirements = roleRequirementsFromJson(storedConfigJson(db, projectId, configHead.config_revision));
    const eligibility = (db.prepare(
      `SELECT role_requirement_id, requested_profile_digest, current_qualification_id, effective_status,
              config_revision, role_requirement_digest, expires_at_ms, reason_code
       FROM eligibility_projections WHERE project_id = ? ORDER BY role_requirement_id, requested_profile_digest`,
    ).all(projectId) as Array<Record<string, unknown>>).map((row) => {
      const requirement = configuredRequirements.find((candidate) => candidate.roleRequirementId === row.role_requirement_id);
      const stale = row.config_revision !== configHead.config_revision || !requirement || sha256(canonicalJson(requirement)) !== row.role_requirement_digest;
      const expired = typeof row.expires_at_ms === "number" && row.expires_at_ms <= now();
      return {
        roleRequirementId: row.role_requirement_id,
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
      .map((row) => ({ roleId: row.role_id, generation: row.current_generation, holderExecutionAttemptId: row.holder_execution_attempt_id, reason: "ROLE_HOLDER_UNRESOLVED" }));
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
    const doctorMessage = [pluginCompatibilityMessage, ...routing.messages].filter(Boolean).join("; ");
    const expected = targets.length + 1;
    return result("OK", projectId, expected, expected, expected, {
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
        eligibility,
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
        ...(checkoutDivergence ? { checkoutDivergence } : {}),
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
  const root = exportRootDirectory(db);
  if (root) sweepPartialExportDirectories(root);
}
