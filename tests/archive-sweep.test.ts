import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import { MIGRATIONS, backfillWorkItemAttempts, databaseIsReady, PLUGIN_ID, type SqliteDatabase } from "../src/foundation.js";
import { createArchiveSweepRefusalCounter, runArchiveSweep } from "../src/archive-sweep.js";

const now = 48 * 60 * 60 * 1000;
const PROJECT_ID = "proj_a8zzfsx36j";
const openDbs: Array<{ close(): void }> = [];

const idle = (id: string, extra: Record<string, unknown> = {}) => makeThreadResponse({
  id,
  projectId: PROJECT_ID,
  status: "idle",
  archivedAt: null,
  deletedAt: null,
  updatedAt: 0,
  ...extra,
});

function insertAttempt(
  db: SqliteDatabase,
  input: {
    id: string;
    projectId?: string;
    origin: "role_holder" | "work_item";
    threadId: string | null;
    roleId?: string;
    workItemId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO execution_attempts (
       project_id, execution_attempt_id, origin, attempt_ordinal, config_revision,
       governance_epoch, work_item_id, lane_id, assignment_kind, role_id,
       role_generation, state, bb_server_id, environment_id, source_id, host_id,
       environment_path, thread_id, environment_digest, created_at_ms, attempt_digest
     ) VALUES (?, ?, ?, 1, 1, 1, ?, ?, ?, ?, 1, 'done', 'server', 'env', 'source',
               'host', 'path', ?, 'environment', 1, ?)`,
  ).run(
    input.projectId ?? PROJECT_ID,
    input.id,
    input.origin,
    input.workItemId ?? null,
    input.origin === "work_item" ? `lane-${input.id}` : null,
    input.origin === "work_item" ? "review" : null,
    input.roleId ?? "worker",
    input.threadId,
    `attempt-${input.id}`,
  );
}

function insertGeneration(
  db: SqliteDatabase,
  roleId: string,
  roleRequirementId: string,
  attemptId: string,
  status: "active" | "retired" = "active",
): void {
  db.prepare(
    `INSERT INTO role_generations (
       project_id, role_id, generation, role_requirement_id, config_revision,
       repo_target_id, status, predecessor_generation, holder_execution_attempt_id,
       holder_context_digest, holder_executed_profile_digest, qualification_id,
       eligibility_derivation_digest, created_at_ms, activated_at_ms, retired_at_ms
     ) VALUES (?, ?, 1, ?, 1, NULL, ?, NULL, ?, 'context', 'profile',
               'qualification', 'eligibility', 1, 1, ?)`,
  ).run(PROJECT_ID, roleId, roleRequirementId, status, attemptId, status === "retired" ? 2 : null);
}

function fixture(options: {
  includeUnknownStatus?: boolean;
  includeUnresolvableEnvironment?: boolean;
  includeUnresolvableChild?: boolean;
  includeUnknownPullRequest?: boolean;
  includeUnreadableArchiveState?: boolean;
  activateArchiveChildOnSecondReport?: boolean;
  activateArchiveChildOnThirdReport?: boolean;
  includeLegacyArchiveCoverage?: boolean;
  includeForeignProject?: boolean;
  throwOnList?: boolean;
} = {}) {
  const db = new Database(":memory:");
  openDbs.push(db);
  databaseIsReady(db);
  db.transaction(() => {
    for (const migration of MIGRATIONS) db.exec(migration);
  })();
  backfillWorkItemAttempts(db, Number.MAX_SAFE_INTEGER);
  db.pragma("foreign_keys = OFF");
  insertAttempt(db, { id: "role-holder", origin: "role_holder", threadId: "role-holder" });
  insertAttempt(db, { id: "director-holder", origin: "role_holder", threadId: "director-exemption", roleId: "director" });
  insertAttempt(db, { id: "orchestrator-holder", origin: "role_holder", threadId: "orchestrator-seat", roleId: "project-orchestrator" });
  insertAttempt(db, { id: "work-item", origin: "work_item", threadId: "work-item-bound", workItemId: "work-item-1" });
  if (options.includeForeignProject) insertAttempt(db, { id: "foreign-bound", origin: "role_holder", threadId: "foreign-bound", projectId: "project-2" });
  insertGeneration(db, "worker", "worker-v1", "role-holder", "retired");
  insertGeneration(db, "director", "director-seat", "director-holder");
  insertGeneration(db, "project-orchestrator", "orchestrator-v1", "orchestrator-holder");
  db.prepare("INSERT INTO role_generation_heads (project_id, role_id, current_generation, updated_at_ms) VALUES (?, 'director', 1, 1), (?, 'project-orchestrator', 1, 1)").run(PROJECT_ID, PROJECT_ID);
  db.pragma("foreign_keys = ON");

  const threads = [
    idle("role-holder", options.includeLegacyArchiveCoverage ? { parentThreadId: "bound-parent" } : {}),
    idle("work-item-bound"),
    idle("director-exemption"),
    idle("orchestrator-seat"),
    idle("open-pr", { environmentId: "env-pr" }),
    idle("draft-pr", { environmentId: "env-draft" }),
    idle("parent"),
    makeThreadResponse({ id: "live-child", projectId: PROJECT_ID, status: "active", archivedAt: null, deletedAt: null, parentThreadId: "parent", updatedAt: now }),
    idle("source-root"),
    makeThreadResponse({ id: "hidden-fork", projectId: PROJECT_ID, status: "active", archivedAt: null, deletedAt: null, sourceThreadId: "source-root", updatedAt: now }),
    makeThreadResponse({ id: "starting", projectId: PROJECT_ID, status: "starting", archivedAt: null, deletedAt: null, updatedAt: 0 }),
    idle("fresh", { updatedAt: now }),
    idle("fallback-boundary", { updatedAt: now - 12 * 60 * 60 * 1000 }),
    ...(options.includeLegacyArchiveCoverage ? [
      idle("bound-parent"),
      idle("open-pr-parent"),
      idle("open-pr-child", { parentThreadId: "open-pr-parent", environmentId: "env-pr" }),
      idle("ancestor"),
      idle("middle", { parentThreadId: "ancestor" }),
      makeThreadResponse({ id: "grandchild", projectId: PROJECT_ID, status: "active", archivedAt: null, deletedAt: null, parentThreadId: "middle", updatedAt: now }),
      idle("fresh-parent"),
      idle("fresh-child", { parentThreadId: "fresh-parent", updatedAt: now }),
      idle("archive-parent"),
      idle("archive-child", { parentThreadId: "archive-parent" }),
    ] : []),
    idle("ordinary"),
    idle("archived-thread", { archivedAt: now }),
    ...(options.includeUnknownStatus ? [makeThreadResponse({ id: "unknown-status", projectId: PROJECT_ID, status: "unknown" as never, archivedAt: null, deletedAt: null, updatedAt: 0 })] : []),
    ...(options.includeUnresolvableEnvironment ? [idle("unresolvable-environment", { environmentId: "env-missing" })] : []),
    ...(options.includeUnknownPullRequest ? [idle("unknown-pull-request", { environmentId: "env-unknown" })] : []),
    ...(options.includeUnresolvableChild ? [idle("unresolvable-child", { parentThreadId: "missing-parent" })] : []),
    ...(options.includeForeignProject ? [idle("foreign", { projectId: "project-2" }), idle("foreign-bound", { projectId: "project-2" })] : []),
  ];

  let unarchivedListCalls = 0;
  const host = createFakePluginHost({
    pluginId: PLUGIN_ID,
    sdk: {
      threads: {
        list: async ({ projectId, archived = false, limit = 1000, offset = 0 }: { projectId?: string; archived?: boolean; limit?: number; offset?: number } = {}) => {
          if (options.throwOnList) throw new Error("thread inventory unavailable");
          if (!archived) {
            unarchivedListCalls += 1;
            if (options.activateArchiveChildOnSecondReport && unarchivedListCalls === 2) {
              threads.push(makeThreadResponse({ id: "late-active-child", projectId: PROJECT_ID, status: "active", archivedAt: null, deletedAt: null, parentThreadId: "ordinary", updatedAt: now }));
            }
            if (options.activateArchiveChildOnThirdReport && unarchivedListCalls === 3) {
              threads.push(makeThreadResponse({ id: "late-active-child", projectId: PROJECT_ID, status: "active", archivedAt: null, deletedAt: null, parentThreadId: "ordinary", updatedAt: now }));
            }
          }
          return threads
            .filter((thread) => thread.projectId === projectId && ((thread.archivedAt !== null) === archived))
            .map((thread) => options.includeUnreadableArchiveState && thread.id === "archived-thread"
              ? { ...thread, archivedAt: undefined as never }
              : thread)
            .slice(offset, offset + limit);
        },
        archive: async ({ threadId }: { threadId: string }) => ({
          ok: true as const,
          archivedThreadIds: {
            "bound-parent": ["bound-parent", "role-holder"],
            "archive-parent": ["archive-parent", "archive-child"],
            parent: ["parent", "live-child"],
            "source-root": ["source-root", "hidden-fork"],
          }[threadId] ?? [threadId],
        }),
      },
      environments: {
        pullRequest: (async ({ environmentId }: { environmentId: string }) => {
          if (environmentId === "env-missing") throw new Error("Environment unavailable");
          if (environmentId === "env-unknown") return { outcome: "unknown" } as never;
          if (environmentId === "env-pr" || environmentId === "env-draft") {
            return { outcome: "available" as const, pullRequest: { state: environmentId === "env-pr" ? "open" as const : "draft" as const } };
          }
          return { outcome: "absent" as const };
        }) as never,
      },
    },
  });
  return { db, host };
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  delete process.env.BB_COLLAB_ARCHIVE_IDLE_H;
});

async function report(host: ReturnType<typeof fixture>["host"], db: SqliteDatabase | null, configuredIdleHours?: string) {
  if (configuredIdleHours === undefined) delete process.env.BB_COLLAB_ARCHIVE_IDLE_H;
  else process.env.BB_COLLAB_ARCHIVE_IDLE_H = configuredIdleHours;
  return runArchiveSweep(host.bb, db, PROJECT_ID, false, now);
}

describe("thread archive sweep", () => {
  it("folds exact archive refusal keys across projects and cycles", () => {
    const counter = createArchiveSweepRefusalCounter(1234);
    counter.beginCycle();
    expect(counter.observe("constructed refusal", "project-a")).toMatchObject({
      guard: "thread-archive-sweep",
      reason: "constructed refusal",
      occurrencesSinceReload: 1,
      cyclesSinceReload: 1,
      projectsSinceReload: 1,
      sinceReloadAtMs: 1234,
    });
    expect(counter.observe("constructed refusal", "project-b")).toMatchObject({ occurrencesSinceReload: 2, cyclesSinceReload: 1, projectsSinceReload: 2 });
    counter.beginCycle();
    expect(counter.observe("constructed refusal", "project-a")).toMatchObject({ occurrencesSinceReload: 3, cyclesSinceReload: 2, projectsSinceReload: 2 });
    expect(counter.observe("different refusal", "project-a")).toMatchObject({ reason: "different refusal", occurrencesSinceReload: 1, cyclesSinceReload: 1, projectsSinceReload: 1 });
  });

  it("protects every execution-attempt thread binding, including work-item attempts", async () => {
    const { db, host } = fixture();
    const result = await report(host, db);
    expect(result.outcome).toBe("reported");
    expect(result.protectedThreadCount).toBe(4);
    expect(result.archivableThreadIds).not.toContain("work-item-bound");
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("does not archive a bound role-holder through its eligible parent", async () => {
    const { db, host } = fixture({ includeLegacyArchiveCoverage: true });
    const result = await runArchiveSweep(host.bb, db, PROJECT_ID, true, now);
    expect(result.archivableThreadIds).not.toContain("bound-parent");
    expect(result.archivedThreadIds).not.toContain("role-holder");
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).not.toContainEqual([{ threadId: "bound-parent" }]);
  });

  it("protects the director first-generation exemption holder", async () => {
    const { db, host } = fixture();
    const result = await report(host, db);
    expect(result.archivableThreadIds).not.toContain("director-exemption");
  });

  it("protects the live orchestrator seat from canonical role state during apply", async () => {
    const { db, host } = fixture();
    const result = await runArchiveSweep(host.bb, db, PROJECT_ID, true, now);
    expect(result.archivableThreadIds).not.toContain("orchestrator-seat");
    expect(result.archivedThreadIds).not.toContain("orchestrator-seat");
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).not.toContainEqual([{ threadId: "orchestrator-seat" }]);
  });

  it("protects open and draft pull-request threads during apply", async () => {
    const { db, host } = fixture({ includeLegacyArchiveCoverage: true });
    const result = await runArchiveSweep(host.bb, db, PROJECT_ID, true, now);
    expect(result.archivableThreadIds).not.toContain("open-pr");
    expect(result.archivableThreadIds).not.toContain("draft-pr");
    expect(result.archivedThreadIds).not.toContain("open-pr");
    expect(result.archivedThreadIds).not.toContain("draft-pr");
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).not.toContainEqual([{ threadId: "open-pr" }]);
  });

  it("protects a parent with a live child and a source root with a live fork during apply", async () => {
    const { db, host } = fixture();
    const result = await runArchiveSweep(host.bb, db, PROJECT_ID, true, now);
    expect(result.archivableThreadIds).not.toContain("parent");
    expect(result.archivableThreadIds).not.toContain("source-root");
    expect(result.archivedThreadIds).not.toContain("parent");
    expect(result.archivedThreadIds).not.toContain("source-root");
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).not.toContainEqual([{ threadId: "parent" }]);
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).not.toContainEqual([{ threadId: "source-root" }]);
  });

  it("protects active, starting, fresh, and already archived threads", async () => {
    const { db, host } = fixture();
    const result = await report(host, db);
    expect(result.archivableThreadIds).not.toContain("live-child");
    expect(result.archivableThreadIds).not.toContain("starting");
    expect(result.archivableThreadIds).not.toContain("fresh");
    expect(result.archivableThreadIds).not.toContain("archived-thread");
  });

  it("archives only an ordinary idle thread in the dry-run report", async () => {
    const { db, host } = fixture();
    const result = await report(host, db);
    expect(result).toMatchObject({ outcome: "reported", archivedThreadIds: [] });
    expect(result.archivableThreadIds).toContain("ordinary");
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("omitting apply defaults to dry-run and never archives a valid candidate", async () => {
    const { db, host } = fixture();
    const result = await runArchiveSweep(host.bb, db, PROJECT_ID);
    expect(result).toMatchObject({ outcome: "reported", archivedThreadIds: [] });
    expect(result.archivableThreadIds).toContain("ordinary");
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("explicit apply archives exactly the reported candidate id", async () => {
    const { db, host } = fixture();
    const result = await runArchiveSweep(host.bb, db, PROJECT_ID, true, now);
    expect(result).toMatchObject({ outcome: "applied", archivableThreadIds: ["ordinary"], archivedThreadIds: ["ordinary"] });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([[{ threadId: "ordinary" }]]);
  });

  it("collapses eligible child roots and aggregates cascaded archive ids", async () => {
    const { db, host } = fixture({ includeLegacyArchiveCoverage: true });
    const result = await runArchiveSweep(host.bb, db, PROJECT_ID, true, now);
    expect(result).toMatchObject({
      outcome: "applied",
      archivableThreadIds: ["archive-parent", "ordinary"],
      archivedThreadIds: ["archive-parent", "archive-child", "ordinary"],
    });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([[{ threadId: "archive-parent" }], [{ threadId: "ordinary" }]]);
  });

  it("rechecks every archive root before applying", async () => {
    const { db, host } = fixture({ includeLegacyArchiveCoverage: true, activateArchiveChildOnThirdReport: true });
    const result = await runArchiveSweep(host.bb, db, PROJECT_ID, true, now);
    expect(result).toMatchObject({
      outcome: "refused",
      archivedThreadIds: ["archive-parent", "archive-child"],
      message: expect.stringContaining("candidate changed before apply: ordinary"),
    });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([[{ threadId: "archive-parent" }]]);
  });

  it("refuses explicit apply when a candidate changes after the report", async () => {
    const { db, host } = fixture({ activateArchiveChildOnSecondReport: true });
    const result = await runArchiveSweep(host.bb, db, PROJECT_ID, true, now);
    expect(result).toMatchObject({ outcome: "refused", message: expect.stringContaining("candidate changed") });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  for (const [label, configuredIdleHours] of [
    ["missing", undefined],
    ["malformed", "not-a-number"],
    ["zero", "0"],
    ["negative", "-1"],
  ] as const) {
    it(`falls back to 24 hours for a ${label} idle setting`, async () => {
      const { db, host } = fixture();
      const result = await report(host, db, configuredIdleHours);
      expect(result.archivableThreadIds).toContain("ordinary");
      expect(result.archivableThreadIds).not.toContain("fallback-boundary");
    });
  }

  it("isolates a dangling environment and protects only that thread", async () => {
    const { db, host } = fixture({ includeUnresolvableEnvironment: true });
    const result = await report(host, db);
    expect(result).toMatchObject({ outcome: "reported", unresolvedThreadCount: 1 });
    expect(result.archivableThreadIds).toContain("ordinary");
    expect(result.archivableThreadIds).not.toContain("unresolvable-environment");
    expect(host.harness.inspection.sdk.callsTo("environments.pullRequest")).toContainEqual([{ environmentId: "env-pr" }]);
  });

  it("protects an unknown pull-request result", async () => {
    const { db, host } = fixture({ includeUnknownPullRequest: true });
    const result = await report(host, db);
    expect(result.archivableThreadIds).not.toContain("unknown-pull-request");
  });

  it("protects an unknown thread status", async () => {
    const { db, host } = fixture({ includeUnknownStatus: true });
    const result = await report(host, db);
    expect(result.outcome).toBe("reported");
    expect(result.archivableThreadIds).not.toContain("unknown-status");
  });

  it("refuses an unreadable execution-attempt binding", async () => {
    const { db, host } = fixture();
    db.prepare("UPDATE execution_attempts SET thread_id = NULL WHERE execution_attempt_id = 'work-item'").run();
    const result = await report(host, db);
    expect(result).toMatchObject({ outcome: "refused", message: expect.stringContaining("thread binding") });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("refuses an unreadable role-generation holder binding", async () => {
    const { db, host } = fixture();
    db.prepare("DELETE FROM execution_attempts WHERE execution_attempt_id = 'orchestrator-holder'").run();
    const result = await report(host, db);
    expect(result).toMatchObject({ outcome: "refused", message: expect.stringContaining("holder binding") });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("refuses an empty execution-attempt table", async () => {
    const { db, host } = fixture();
    db.exec("DELETE FROM execution_attempts");
    const result = await report(host, db);
    expect(result).toMatchObject({ outcome: "refused", message: expect.stringContaining("empty") });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("refuses an unresolvable child relationship", async () => {
    const { db, host } = fixture({ includeUnresolvableChild: true });
    const result = await report(host, db);
    expect(result).toMatchObject({ outcome: "refused", message: expect.stringContaining("relationship") });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("refuses an unreadable thread inventory", async () => {
    const { db, host } = fixture({ throwOnList: true });
    const result = await report(host, db);
    expect(result).toMatchObject({ outcome: "refused", message: expect.stringContaining("thread inventory") });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("refuses an unreadable archived-state field", async () => {
    const { db, host } = fixture({ includeUnreadableArchiveState: true });
    const result = await report(host, db);
    expect(result).toMatchObject({ outcome: "refused", message: expect.stringContaining("archive state") });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("refuses when the canonical store is unavailable", async () => {
    const { host } = fixture();
    const result = await report(host, null);
    expect(result).toMatchObject({ outcome: "refused", message: "canonical store unavailable" });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("scopes an unbound thread to a project with independent attempt evidence", async () => {
    const { db, host } = fixture({ includeForeignProject: true });
    const result = await runArchiveSweep(host.bb, db, "project-2", false, now);
    expect(result).toMatchObject({ outcome: "reported", archivableThreadIds: ["foreign"] });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });
});
