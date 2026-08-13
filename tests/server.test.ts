import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineRpcContract } from "@bb/plugin-sdk";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import plugin from "../server.js";
import {
  MIGRATIONS,
  PLUGIN_ID,
  applyFixtureMutation,
  databaseIsReady,
  exportFoundation,
  type ApplyRequest,
} from "../src/foundation.js";
import {
  applyWithFixtureReceipt,
  seedFixtureDecision,
  seedVerifiedFixtureReceipt,
} from "../src/test-support.js";

const PROJECT_ID = "proj_test";
const FOREIGN_PROJECT_ID = "proj_foreign";
const RECEIPT_ID = "receipt-test";
const TARGET_ID = "target-main";

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

function hostFor(projectId = PROJECT_ID) {
  const project = projectFacts(projectId);
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
    },
    target: {
      repoTargetId: TARGET_ID,
      sourceId: "source-main",
      hostId: "host-main",
      path: "/workspace/project",
      remoteUrl: null,
      defaultBranch: "main",
    },
    ...overrides,
  };
}

async function loadedHost(projectId = PROJECT_ID) {
  const host = hostFor(projectId);
  await plugin(host.bb);
  return host;
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

function directDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "bb-collab-issue3-"));
  const path = join(directory, "data.db");
  const db = new Database(path);
  databaseIsReady(db);
  for (const statement of MIGRATIONS) db.exec(statement);
  return { db, path, directory };
}

describe("bb-collab plugin boundary", () => {
  it("loads one CLI/RPC seam and refuses production apply before any write", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    const request = bootstrapRequest();
    const before = exportFoundation(db, PROJECT_ID);

    const rpc = await host.harness.callRpc("apply", request);
    expect(rpc).toMatchObject({ outcome: "OPERATOR_AUTH_REQUIRED", expected: 1, attempted: 0, verified: 0 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    const cli = await host.harness.runCli([
      "apply",
      "--project",
      PROJECT_ID,
      "--request",
      JSON.stringify(request),
    ]);
    expect(cli.exitCode).toBe(2);
    expect(JSON.parse(cli.stdout)).toMatchObject({ outcome: "OPERATOR_AUTH_REQUIRED" });
    expect(host.harness.inspection.registrations.services).toEqual([]);
    expect(host.harness.inspection.registrations.schedules).toEqual([]);
    expect(host.harness.inspection.registrations.rpcMethods.sort()).toEqual(["apply", "doctor", "export"]);
  });

  it("proves fixture bootstrap, read-only doctor, deterministic export, and exact BB fact reads", async () => {
    const host = await loadedHost();
    const { db } = seedAndBootstrap(host);
    const changesBeforeDoctor = db.prepare("SELECT total_changes() AS count").get();

    const doctorResult = await host.harness.callRpc("doctor", { projectId: PROJECT_ID });
    expect(doctorResult).toMatchObject({ outcome: "OK", expected: 2, attempted: 2, verified: 2 });
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(changesBeforeDoctor);
    expect(host.harness.inspection.sdk.callsTo("system.version")).toHaveLength(1);
    expect(host.harness.inspection.sdk.callsTo("projects.get")).toEqual([[{ projectId: PROJECT_ID }]]);
    expect(host.harness.inspection.sdk.callsTo("hosts.get")).toEqual([[{ hostId: "host-main" }]]);

    const first = await host.harness.callRpc("export", { projectId: PROJECT_ID });
    const second = await host.harness.callRpc("export", { projectId: PROJECT_ID });
    expect(second).toEqual(first);
    expect(first).toMatchObject({ outcome: "OK", expected: 8, attempted: 8, verified: 8 });
    expect((first as { export: { manifest: { migrationStatementIds: number[]; schemaDigest: string } } }).export.manifest.migrationStatementIds).toEqual(
      Array.from({ length: 10 }, (_, index) => index),
    );
    expect((first as { export: { checksums: Record<string, string> } }).export.checksums).toHaveProperty("records.ndjson");
  });

  it("rejects stale config without changing any foundation bytes", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    const before = exportFoundation(db, PROJECT_ID);
    const stale = applyWithFixtureReceipt(db, {
      ...bootstrapRequest(),
      operationClass: "config_revision",
      idempotencyKey: "config-stale",
      expectedConfigRevision: 0,
      configRevision: 1,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
      config: { permissionMode: "auto" },
      target: { ...bootstrapRequest().target!, defaultBranch: "develop" },
    });
    expect(stale.outcome).toBe("PROJECT_CONFIG_STALE");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("returns the original receipt on duplicate idempotency and refuses conflicting reuse", async () => {
    const host = await loadedHost();
    const { db, request } = seedAndBootstrap(host);
    const replay = applyWithFixtureReceipt(db, request);
    expect(replay).toEqual(applyWithFixtureReceipt(db, request));

    const beforeConflict = exportFoundation(db, PROJECT_ID);
    const conflict = applyWithFixtureReceipt(db, {
      ...request,
      config: { permissionMode: "auto", different: true },
    });
    expect(conflict.outcome).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeConflict);
    expect(db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts").get()).toEqual({ count: 1 });
  });

  it("rejects missing, unknown, and foreign actor receipts before bootstrap mutation", async () => {
    const missingHost = await loadedHost();
    const missingDb = missingHost.bb.storage.database();
    const missing = applyWithFixtureReceipt(missingDb, bootstrapRequest(PROJECT_ID, { actorReceiptId: null }));
    expect(missing.outcome).toBe("ACTOR_RECEIPT_REQUIRED");
    expect(missingDb.prepare("SELECT COUNT(*) AS count FROM project_config_revisions").get()).toEqual({ count: 0 });

    const unknownHost = await loadedHost();
    const unknownDb = unknownHost.bb.storage.database();
    const unknown = applyWithFixtureReceipt(unknownDb, bootstrapRequest(PROJECT_ID, { actorReceiptId: "missing" }));
    expect(unknown.outcome).toBe("ACTOR_RECEIPT_UNKNOWN");
    expect(unknownDb.prepare("SELECT COUNT(*) AS count FROM state_events").get()).toEqual({ count: 0 });

    const foreignHost = await loadedHost();
    const foreignDb = foreignHost.bb.storage.database();
    seedVerifiedFixtureReceipt(foreignDb, { projectId: FOREIGN_PROJECT_ID, receiptId: RECEIPT_ID });
    const foreign = applyWithFixtureReceipt(foreignDb, bootstrapRequest(PROJECT_ID));
    expect(foreign.outcome).toBe("ACTOR_RECEIPT_FOREIGN");
    expect(foreignDb.prepare("SELECT COUNT(*) AS count FROM project_config_heads").get()).toEqual({ count: 0 });
  });

  it("wins one governorship CAS race and leaves no loser receipt or event", async () => {
    const { db: firstDb, path, directory } = directDatabase();
    const secondDb = new Database(path);
    databaseIsReady(secondDb);
    try {
      seedVerifiedFixtureReceipt(firstDb, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      seedVerifiedFixtureReceipt(firstDb, { projectId: PROJECT_ID, receiptId: "receipt-second" });
      const firstBootstrap = applyFixtureMutation(firstDb, bootstrapRequest());
      const fenceToken = (firstBootstrap.evidence as { fenceToken: string }).fenceToken;
      const baseClaim = {
        projectId: PROJECT_ID,
        operationClass: "governor_claim" as const,
        actorReceiptId: RECEIPT_ID,
        expectedConfigRevision: 1,
        expectedGovernanceEpoch: 1,
        expectedFenceToken: fenceToken,
        runtimeId: "runtime-a",
      };
      const winner = applyFixtureMutation(firstDb, { ...baseClaim, idempotencyKey: "claim-a" });
      const loser = applyFixtureMutation(secondDb, {
        ...baseClaim,
        actorReceiptId: "receipt-second",
        idempotencyKey: "claim-b",
        runtimeId: "runtime-b",
      });
      expect(winner.outcome).toBe("OK");
      expect(loser.outcome).toBe("GOVERNOR_CAS_FAILED");
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM project_governorship_heads").get()).toEqual({ count: 1 });
      expect(firstDb.prepare("SELECT governance_epoch FROM project_governorship_heads").get()).toEqual({ governance_epoch: 2 });
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM mutation_receipts").get()).toEqual({ count: 2 });
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM state_events").get()).toEqual({ count: 2 });
      expect(firstDb.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = 'claim-b'").get()).toBeUndefined();
    } finally {
      secondDb.close();
      firstDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps disposition history append-only and rejects stale resource revisions", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host, PROJECT_ID, {
      decision: {
        decisionId: "decision-1",
        repoTargetId: TARGET_ID,
        scope: { operation: "review" },
        resourceRevision: 1,
      },
    });
    const first = applyWithFixtureReceipt(db, {
      projectId: PROJECT_ID,
      operationClass: "decision_disposition",
      idempotencyKey: "disposition-1",
      actorReceiptId: RECEIPT_ID,
      expectedConfigRevision: 1,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
      repoTargetId: TARGET_ID,
      decisionId: "decision-1",
      disposition: "adopted",
      expectedResourceRevision: 1,
      reason: { source: "fixture" },
    });
    expect(first.outcome).toBe("OK");
    const stale = applyWithFixtureReceipt(db, {
      projectId: PROJECT_ID,
      operationClass: "decision_disposition",
      idempotencyKey: "disposition-stale",
      actorReceiptId: RECEIPT_ID,
      expectedConfigRevision: 1,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
      repoTargetId: TARGET_ID,
      decisionId: "decision-1",
      disposition: "rejected",
      expectedResourceRevision: 1,
      reason: { source: "stale" },
    });
    expect(stale.outcome).toBe("RESOURCE_REVISION_STALE");
    expect(db.prepare("SELECT disposition_sequence FROM decision_dispositions").all()).toEqual([{ disposition_sequence: 1 }]);
  });

  it("reopens the real SQLite file and recovers the committed idempotent receipt", () => {
    const { db, path, directory } = directDatabase();
    try {
      seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      const committed = applyFixtureMutation(db, bootstrapRequest());
      const before = exportFoundation(db, PROJECT_ID);
      db.close();
      const reopened = new Database(path);
      databaseIsReady(reopened);
      try {
        expect(applyFixtureMutation(reopened, bootstrapRequest())).toEqual(committed);
        expect(exportFoundation(reopened, PROJECT_ID)).toEqual(before);
        expect(reopened.prepare("SELECT COUNT(*) AS count FROM state_events").get()).toEqual({ count: 1 });
      } finally {
        reopened.close();
      }
    } finally {
      if (db.open) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves state across the official harness reload lifecycle", async () => {
    const host = await loadedHost();
    const { db } = seedAndBootstrap(host);
    const before = exportFoundation(db, PROJECT_ID);
    const reloaded = await host.harness.lifecycle.reload(plugin);
    expect(await reloaded.harness.callRpc("export", { projectId: PROJECT_ID })).toEqual(before);
    await reloaded.harness.lifecycle.dispose();
  });

  it("keeps target resolution fail-closed and rejects malformed/non-JSON RPC boundaries", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    const before = exportFoundation(db, PROJECT_ID);
    const missingTarget = applyWithFixtureReceipt(db, {
      ...bootstrapRequest(),
      operationClass: "config_revision",
      idempotencyKey: "target-missing",
      expectedConfigRevision: 1,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
      config: undefined,
      target: undefined,
      repoTargetId: undefined,
    });
    expect(missingTarget.outcome).toBe("REPO_TARGET_REQUIRED");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    const foreignTarget = applyWithFixtureReceipt(db, {
      ...bootstrapRequest(),
      operationClass: "config_revision",
      idempotencyKey: "target-foreign",
      expectedConfigRevision: 1,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
      config: undefined,
      target: undefined,
      repoTargetId: "foreign-target",
    });
    expect(foreignTarget.outcome).toBe("REPO_TARGET_FOREIGN");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    await expect(host.harness.callRpc("doctor", { projectId: PROJECT_ID, extra: true })).rejects.toThrow();

    const bad = createFakePluginHost({ pluginId: "bad-boundary" });
    const badContract = defineRpcContract({
      bad: {
        input: z.null(),
        output: z.unknown(),
      },
    });
    bad.bb.rpc.register(badContract, {
      bad: () => ({ ok: BigInt(1) }) as never,
    });
    await expect(bad.harness.callRpc("bad", null)).rejects.toThrow(/non_json_result|not a JSON value/iu);
  });

  it("rejects secret material in config before the first mutation", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
    const result = applyWithFixtureReceipt(db, bootstrapRequest(PROJECT_ID, { config: { apiKey: "plaintext" } }));
    expect(result.outcome).toBe("CONFIG_SECRET_FORBIDDEN");
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_config_revisions").get()).toEqual({ count: 0 });
  });

  it("supports an immutable config revision and stable target id", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    const appended = applyWithFixtureReceipt(db, {
      ...bootstrapRequest(),
      operationClass: "config_revision",
      idempotencyKey: "config-2",
      expectedConfigRevision: 1,
      configRevision: 2,
      expectedGovernanceEpoch: 1,
      expectedFenceToken: fenceToken,
      config: { permissionMode: "auto", visibility: "visible", repositoryTargets: [TARGET_ID] },
      target: { ...bootstrapRequest().target!, defaultBranch: "develop" },
    });
    expect(appended.outcome).toBe("OK");
    expect(db.prepare("SELECT config_revision FROM project_config_heads").get()).toEqual({ config_revision: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_config_revisions").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT repo_target_id FROM repository_targets ORDER BY config_revision").all()).toEqual([
      { repo_target_id: TARGET_ID },
      { repo_target_id: TARGET_ID },
    ]);
  });

  it("rejects an ambiguous target when a revision omits the exact target", async () => {
    const { db, path, directory } = directDatabase();
    try {
      seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      const initial = applyFixtureMutation(db, bootstrapRequest());
      const fenceToken = (initial.evidence as { fenceToken: string }).fenceToken;
      db.prepare(
        `INSERT INTO repository_targets
          (project_id, repo_target_id, config_revision, source_id, host_id, path, remote_url, default_branch, target_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(PROJECT_ID, "target-second", 1, "source-second", "host-main", "/workspace/second", null, "main", "digest");
      const result = applyFixtureMutation(db, {
        ...bootstrapRequest(),
        operationClass: "config_revision",
        idempotencyKey: "ambiguous-target",
        expectedConfigRevision: 1,
        expectedGovernanceEpoch: 1,
        expectedFenceToken: fenceToken,
        config: undefined,
        target: undefined,
        repoTargetId: null,
      });
      expect(result.outcome).toBe("REPO_TARGET_AMBIGUOUS");
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses one read-only default and non-zero refusal exits for CLI input", async () => {
    const host = await loadedHost();
    const cli = await host.harness.runCli(["doctor", "--project", PROJECT_ID, "unexpected"]);
    expect(cli.exitCode).toBe(2);
    expect(JSON.parse(cli.stdout).outcome).toBe("INVALID_INPUT");
    const missingProject = await host.harness.runCli(["doctor"]);
    expect(missingProject.exitCode).toBe(2);
    expect(JSON.parse(missingProject.stdout).outcome).toBe("INVALID_INPUT");
  });

  it("keeps fixture insertion outside the production RPC/CLI surface", async () => {
    const host = await loadedHost();
    const registrations = host.harness.inspection.registrations;
    expect(registrations.rpcMethods).not.toContain("seed-fixture-receipt");
    expect(registrations.cli?.commands.map((command) => command.name)).toEqual(["doctor", "export", "apply"]);
    expect(registrations.httpRoutes).toEqual([]);
    expect(seedFixtureDecision).toBeTypeOf("function");
  });
});
