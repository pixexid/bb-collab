import type Database from "better-sqlite3";
import {
  applyFixtureMutation,
  canonicalJson,
  sha256,
  type ApplyRequest,
  type FoundationResult,
  type SqliteDatabase,
} from "./foundation.js";

export function seedVerifiedFixtureReceipt(
  db: SqliteDatabase,
  input: {
    projectId: string;
    receiptId: string;
    actorKind?: string;
    subjectId?: string;
    roleId?: string | null;
    roleGeneration?: number | null;
  },
): void {
  const actorKind = input.actorKind ?? "fixture";
  const subjectId = input.subjectId ?? input.receiptId;
  const receiptDigest = sha256(
    canonicalJson({
      projectId: input.projectId,
      receiptId: input.receiptId,
      actorKind,
      subjectId,
      roleId: input.roleId ?? null,
      roleGeneration: input.roleGeneration ?? null,
      verificationState: "verified",
    }),
  );
  db.prepare(
    `INSERT INTO actor_receipts
      (project_id, receipt_id, actor_kind, subject_id, role_id, role_generation,
       verification_state, receipt_digest, issued_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, ?)`,
  ).run(
    input.projectId,
    input.receiptId,
    actorKind,
    subjectId,
    input.roleId ?? null,
    input.roleGeneration ?? null,
    receiptDigest,
    Date.now(),
  );
}

export function seedFixtureDecision(
  db: SqliteDatabase,
  input: {
    projectId: string;
    decisionId: string;
    configRevision?: number;
    repoTargetId?: string | null;
    scope?: unknown;
    resourceRevision?: number;
  },
): void {
  const scopeJson = canonicalJson(input.scope ?? { fixture: true });
  db.prepare(
    `INSERT INTO decisions
      (decision_id, project_id, config_revision, repo_target_id, scope_json,
       scope_digest, current_resource_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.decisionId,
    input.projectId,
    input.configRevision ?? 1,
    input.repoTargetId ?? null,
    scopeJson,
    sha256(scopeJson),
    input.resourceRevision ?? 1,
  );
}

export function applyWithFixtureReceipt(db: Database.Database, request: ApplyRequest): FoundationResult {
  return applyFixtureMutation(db, request);
}
