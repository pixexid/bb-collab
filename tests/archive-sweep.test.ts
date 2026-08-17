import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import { MIGRATIONS, databaseIsReady, PLUGIN_ID } from "../src/foundation.js";
import * as awareness from "../src/awareness.js";
import { runArchiveSweep } from "../src/archive-sweep.js";

const now = 48 * 60 * 60 * 1000;
const PROJECT_ID = "proj_a8zzfsx36j";
const idle = (id: string, extra: Record<string, unknown> = {}) => makeThreadResponse({
  id,
  projectId: PROJECT_ID,
  status: "idle",
  archivedAt: null,
  deletedAt: null,
  updatedAt: 0,
  ...extra,
});

function fixture({ activateArchiveChildOnSecondList = false, includeCanonicalSeat = false } = {}) {
  const db = new Database(":memory:");
  databaseIsReady(db);
  for (const migration of MIGRATIONS) db.exec(migration);
  db.pragma("foreign_keys = OFF");
  db.prepare("INSERT INTO execution_attempts (project_id, execution_attempt_id, origin, attempt_ordinal, config_revision, governance_epoch, role_id, role_generation, state, bb_server_id, environment_id, source_id, host_id, environment_path, environment_digest, attempt_digest, created_at_ms, thread_id) VALUES (?, 'bound', 'role_holder', 1, 1, 1, 'worker', 1, 'done', 'server', 'env', 'source', 'host', 'path', 'environment', 'attempt', 1, 'bound-holder')").run(PROJECT_ID);
  db.prepare("INSERT INTO role_generations (project_id, role_id, generation, role_requirement_id, config_revision, repo_target_id, status, predecessor_generation, holder_execution_attempt_id, holder_context_digest, holder_executed_profile_digest, qualification_id, eligibility_derivation_digest, created_at_ms, activated_at_ms, retired_at_ms) VALUES (?, 'worker', 1, 'worker-v1', 1, NULL, 'active', NULL, 'bound', 'context', 'profile', 'qualification', 'eligibility', 1, 1, NULL)").run(PROJECT_ID);
  db.prepare("INSERT INTO role_generation_heads (project_id, role_id, current_generation, updated_at_ms) VALUES (?, 'worker', 1, 1)").run(PROJECT_ID);
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO execution_attempts (project_id, execution_attempt_id, origin, attempt_ordinal, config_revision, governance_epoch, role_id, role_generation, state, bb_server_id, environment_id, source_id, host_id, environment_path, environment_digest, attempt_digest, created_at_ms, thread_id) VALUES ('project-2', 'foreign', 'role_holder', 1, 1, 1, 'worker', 1, 'done', 'server', 'env', 'source', 'host', 'path', 'environment', 'attempt', 1, 'foreign')").run();
  const threads = [
    idle("bound-parent"),
    idle("bound-holder", { parentThreadId: "bound-parent" }),
    ...(includeCanonicalSeat ? [idle("canonical-seat")] : []),
    idle("open-pr", { environmentId: "env-pr" }),
    idle("open-pr-parent"),
    idle("open-pr-child", { parentThreadId: "open-pr-parent", environmentId: "env-pr" }),
    idle("parent"),
    makeThreadResponse({ id: "child", projectId: PROJECT_ID, status: "active", archivedAt: null, deletedAt: null, parentThreadId: "parent", updatedAt: now }),
    idle("source-root"),
    makeThreadResponse({ id: "hidden-active-fork", projectId: PROJECT_ID, status: "active", archivedAt: null, deletedAt: null, sourceThreadId: "source-root", updatedAt: now }),
    idle("ancestor"),
    idle("middle", { parentThreadId: "ancestor" }),
    makeThreadResponse({ id: "grandchild", projectId: PROJECT_ID, status: "active", archivedAt: null, deletedAt: null, parentThreadId: "middle", updatedAt: now }),
    idle("fresh-parent"),
    makeThreadResponse({ id: "fresh-child", projectId: PROJECT_ID, status: "idle", archivedAt: null, deletedAt: null, parentThreadId: "fresh-parent", updatedAt: now }),
    idle("archive-parent"),
    idle("archive-child", { parentThreadId: "archive-parent" }),
    idle("ordinary"),
    idle("foreign", { projectId: "project-2" }),
  ];
  let listCalls = 0;
  const host = createFakePluginHost({
    pluginId: PLUGIN_ID,
    sdk: {
      threads: {
        list: async ({ projectId }: { projectId?: string } = {}) => {
          listCalls += 1;
          if (activateArchiveChildOnSecondList && listCalls === 2) threads.push(makeThreadResponse({ id: "late-active-child", projectId: PROJECT_ID, status: "active", archivedAt: null, deletedAt: null, parentThreadId: "archive-parent", updatedAt: now }));
          return threads.filter((thread) => thread.projectId === projectId);
        },
        archive: async ({ threadId }: { threadId: string }) => ({
          ok: true as const,
          archivedThreadIds: {
            "archive-parent": ["archive-parent", "archive-child"],
            "bound-parent": ["bound-parent", "bound-holder"],
            parent: ["parent", "child"],
            "source-root": ["source-root", "hidden-active-fork"],
          }[threadId] ?? [threadId],
        }),
      },
      environments: {
        pullRequest: (async ({ environmentId }: { environmentId: string }) => environmentId === "env-pr"
          ? { outcome: "available" as const, pullRequest: { state: "open" } }
          : { outcome: "absent" as const }) as never,
      },
    },
  });
  return { db, host };
}

afterEach(() => {
  delete process.env.BB_COLLAB_ARCHIVE_IDLE_H;
  vi.restoreAllMocks();
});

describe("thread archive sweep", () => {
  it("bound role-holder idle past floor is not archived", async () => {
    const { db, host } = fixture();
    process.env.BB_COLLAB_ARCHIVE_IDLE_H = "24";
    const result = await runArchiveSweep(host.bb, db, PROJECT_ID, true, now);
    expect(result.archivableThreadIds).not.toContain("bound-holder");
    expect(result.archivedThreadIds).not.toContain("bound-holder");
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).not.toContainEqual([{ threadId: "bound-holder" }]);
    db.close();
  });

  it("live canonical seat idle past floor is not archived", async () => {
    const { db, host } = fixture({ includeCanonicalSeat: true });
    const readRoleHolderStates = vi.spyOn(awareness, "readRoleHolderStates").mockReturnValue([{
      project_id: PROJECT_ID,
      role_id: "project-orchestrator",
      role_generation: 1,
      execution_attempt_id: "canonical-holder",
      thread_id: "canonical-seat",
    }]);
    process.env.BB_COLLAB_ARCHIVE_IDLE_H = "24";
    const result = await runArchiveSweep(host.bb, db, PROJECT_ID, true, now);
    expect(readRoleHolderStates).toHaveBeenCalled();
    expect(result.archivableThreadIds).not.toContain("canonical-seat");
    expect(result.archivedThreadIds).not.toContain("canonical-seat");
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).not.toContainEqual([{ threadId: "canonical-seat" }]);
    db.close();
  });

  it("open-PR thread is not archived", async () => {
    const { db, host } = fixture();
    process.env.BB_COLLAB_ARCHIVE_IDLE_H = "24";
    const result = await runArchiveSweep(host.bb, db, PROJECT_ID, true, now);
    expect(result.archivableThreadIds).not.toContain("open-pr");
    expect(result.archivedThreadIds).not.toContain("open-pr");
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).not.toContainEqual([{ threadId: "open-pr" }]);
    db.close();
  });

  it("parent with one live child is not archived", async () => {
    const { db, host } = fixture();
    process.env.BB_COLLAB_ARCHIVE_IDLE_H = "24";
    const result = await runArchiveSweep(host.bb, db, PROJECT_ID, true, now);
    expect(result.archivableThreadIds).not.toContain("parent");
    expect(result.archivedThreadIds).not.toContain("parent");
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).not.toContainEqual([{ threadId: "parent" }]);
    db.close();
  });

  it("ordinary idle thread past floor is archived only through explicit opt-in apply", async () => {
    const { db, host } = fixture();
    process.env.BB_COLLAB_ARCHIVE_IDLE_H = "24";
    expect(await runArchiveSweep(host.bb, db, PROJECT_ID, false, now)).toMatchObject({ outcome: "reported", archivedThreadIds: [] });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    expect(await runArchiveSweep(host.bb, db, PROJECT_ID, true, now)).toMatchObject({
      outcome: "applied",
      archivableThreadIds: ["archive-parent", "ordinary"],
      archivedThreadIds: ["archive-parent", "archive-child", "ordinary"],
    });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([[{ threadId: "archive-parent" }], [{ threadId: "ordinary" }]]);
    expect(host.harness.inspection.sdk.callsTo("threads.list")).toEqual([
      [{ projectId: PROJECT_ID, archived: false, includeHidden: true, limit: 1000 }],
      [{ projectId: PROJECT_ID, archived: false, includeHidden: true, limit: 1000 }],
      [{ projectId: PROJECT_ID, archived: false, includeHidden: true, limit: 1000 }],
      [{ projectId: PROJECT_ID, archived: false, includeHidden: true, limit: 1000 }],
    ]);
    db.close();
  });

  it("hidden source-thread fork protects its archive root", async () => {
    const { db, host } = fixture();
    const result = await runArchiveSweep(host.bb, db, PROJECT_ID, true, now);
    expect(result.archivableThreadIds).not.toContain("source-root");
    expect(result.archivedThreadIds).not.toContain("source-root");
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).not.toContainEqual([{ threadId: "source-root" }]);
    db.close();
  });

  it("refuses opt-in apply when a candidate changes after the report", async () => {
    const { db, host } = fixture({ activateArchiveChildOnSecondList: true });
    const result = await runArchiveSweep(host.bb, db, PROJECT_ID, true, now);
    expect(result).toMatchObject({ outcome: "refused", message: expect.stringContaining("candidate changed") });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    db.close();
  });

  it("refuses rather than treating an empty execution_attempts table as an empty protected set", async () => {
    const { db, host } = fixture();
    db.exec("DELETE FROM execution_attempts");
    expect(await runArchiveSweep(host.bb, db, PROJECT_ID, false, now)).toMatchObject({ outcome: "refused", message: expect.stringContaining("empty") });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    db.close();
  });

  it("a project without a live seat still archives an ordinary idle thread", async () => {
    const { db, host } = fixture();
    expect(await runArchiveSweep(host.bb, db, "project-2", false, now)).toMatchObject({ outcome: "reported", archivableThreadIds: ["foreign"] });
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    db.close();
  });
});
