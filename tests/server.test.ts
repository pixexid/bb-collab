import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineRpcContract } from "@bb/plugin-sdk";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import plugin from "../server.js";
import {
  DEFERRED_ISSUE_3_OUTCOMES,
  MAX_EXPORT_ROWS,
  MIGRATIONS,
  PLUGIN_ID,
  applyFixtureMutation,
  canonicalJson,
  databaseIsReady,
  doctor,
  exportFoundation,
  sha256,
  type ApplyRequest,
} from "../src/foundation.js";
import {
  applyWithFixtureReceipt,
  DeterministicGitHubIssueAdapter,
  seedFixtureDecision,
  seedVerifiedFixtureReceipt,
} from "../src/test-support.js";

const PROJECT_ID = "proj_test";
const FOREIGN_PROJECT_ID = "proj_foreign";
const RECEIPT_ID = "receipt-test";
const TARGET_ID = "target-main";
const SECOND_TARGET_ID = "target-second";
const WORK_ITEM_ID = "work-item-1";
const GITHUB_OWNER = "example";
const GITHUB_REPO = "project";
const CONNECTOR_HOST = "github.test";

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
      extensions: {
        bbCollab: {
          githubIssues: {
            repositoryMappings: [
              { repoTargetId: TARGET_ID, owner: GITHUB_OWNER, repo: GITHUB_REPO, connectorHost: CONNECTOR_HOST },
            ],
            issue: {
              titlePrefix: "[bb] ",
              bodyPrefix: "canonical: ",
              managedLabels: {
                names: ["work-proposed", "work-ready", "work-active", "work-done"],
                byLifecycle: {
                  proposed: ["work-proposed"],
                  ready: ["work-ready"],
                  in_progress: ["work-active"],
                  succeeded: ["work-done"],
                  failed: ["work-done"],
                  cancelled: ["work-done"],
                },
              },
            },
          },
        },
      },
    },
    targets: [
      {
        repoTargetId: TARGET_ID,
        sourceId: "source-main",
        hostId: "host-main",
        path: "/workspace/project",
        remoteUrl: null,
        defaultBranch: "main",
      },
    ],
    ...overrides,
  };
}

function workItemCreateRequest(fenceToken: string, overrides: Partial<ApplyRequest> = {}): ApplyRequest {
  return {
    projectId: PROJECT_ID,
    operationClass: "work_item_create",
    idempotencyKey: "work-item-create-1",
    actorReceiptId: RECEIPT_ID,
    expectedConfigRevision: 1,
    expectedGovernanceEpoch: 1,
    expectedFenceToken: fenceToken,
    repoTargetId: TARGET_ID,
    expectedResourceRevision: null,
    workItem: { workItemId: WORK_ITEM_ID, title: "Ship projection", body: "Keep canonical state local." },
    ...overrides,
  };
}

function transitionRequest(
  fenceToken: string,
  state: ApplyRequest["lifecycleState"],
  expectedResourceRevision: number,
  overrides: Partial<ApplyRequest> = {},
): ApplyRequest {
  return {
    projectId: PROJECT_ID,
    operationClass: "work_item_transition",
    idempotencyKey: `work-item-${state}-${expectedResourceRevision}`,
    actorReceiptId: RECEIPT_ID,
    expectedConfigRevision: 1,
    expectedGovernanceEpoch: 1,
    expectedFenceToken: fenceToken,
    repoTargetId: TARGET_ID,
    expectedResourceRevision,
    workItemId: WORK_ITEM_ID,
    lifecycleState: state,
    ...overrides,
  };
}

function projectionRequest(
  fenceToken: string,
  expectedResourceRevision: number,
  overrides: Partial<ApplyRequest> = {},
): ApplyRequest {
  return {
    projectId: PROJECT_ID,
    operationClass: "github_issue_projection",
    idempotencyKey: `project-github-${expectedResourceRevision}`,
    actorReceiptId: RECEIPT_ID,
    expectedConfigRevision: 1,
    expectedGovernanceEpoch: 1,
    expectedFenceToken: fenceToken,
    repoTargetId: TARGET_ID,
    expectedResourceRevision,
    workItemId: WORK_ITEM_ID,
    projectionKind: "github_issue",
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
    expect((first as { export: { manifest: { schemaVersion: number } } }).export.manifest.schemaVersion).toBe(2);
    expect((first as { export: { manifest: { migrationStatementIds: number[]; schemaDigest: string } } }).export.manifest.migrationStatementIds).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
    expect((first as { export: { checksums: Record<string, string> } }).export.checksums).toHaveProperty("records.ndjson");
  });

  it("returns a deterministic bounded result past the export row ceiling", () => {
    const { db, directory } = directDatabase();
    try {
      for (let index = 0; index <= MAX_EXPORT_ROWS; index += 1) {
        seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: `export-${index}` });
      }
      const first = exportFoundation(db, PROJECT_ID);
      const second = exportFoundation(db, PROJECT_ID);
      expect(first).toEqual(second);
      expect(first).toMatchObject({
        outcome: "EXPORT_BOUNDED",
        expected: MAX_EXPORT_ROWS + 1,
        attempted: MAX_EXPORT_ROWS + 1,
        verified: 0,
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
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
      targets: [{ ...bootstrapRequest().targets![0]!, defaultBranch: "develop" }],
    });
    expect(stale.outcome).toBe("PROJECT_CONFIG_STALE");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
  });

  it("rejects wrong governor epochs and tokens without writes", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    const before = exportFoundation(db, PROJECT_ID);
    const request = {
      ...bootstrapRequest(),
      operationClass: "config_revision" as const,
      expectedConfigRevision: 1,
      configRevision: 2,
      config: { permissionMode: "auto", visibility: "visible", repositoryTargets: [TARGET_ID] },
      targets: [{ ...bootstrapRequest().targets![0]!, defaultBranch: "develop" }],
    };
    const wrongEpoch = applyWithFixtureReceipt(db, {
      ...request,
      idempotencyKey: "governor-wrong-epoch",
      expectedGovernanceEpoch: 99,
      expectedFenceToken: fenceToken,
    });
    expect(wrongEpoch.outcome).toBe("GOVERNOR_EPOCH_STALE");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    const wrongToken = applyWithFixtureReceipt(db, {
      ...request,
      idempotencyKey: "governor-wrong-token",
      expectedGovernanceEpoch: 1,
      expectedFenceToken: "wrong-token",
    });
    expect(wrongToken.outcome).toBe("GOVERNOR_EPOCH_STALE");
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

  it("reports canonical-store unavailability without attempting a write", () => {
    expect(applyFixtureMutation(null, bootstrapRequest())).toMatchObject({
      outcome: "CANONICAL_STORE_UNAVAILABLE",
      expected: 1,
      attempted: 0,
      verified: 0,
    });
  });

  it("reports an unknown BB project without changing the real SQLite state", async () => {
    const { db, directory } = directDatabase();
    try {
      const before = exportFoundation(db, PROJECT_ID);
      const result = await doctor(
        db,
        {
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
          projects: { get: async () => { throw new Error("unknown project"); } },
          hosts: { get: async () => { throw new Error("not reached"); } },
        },
        PROJECT_ID,
      );
      expect(result.outcome).toBe("PROJECT_UNKNOWN");
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports an incomplete governor head as unavailable without mutation", () => {
    const { db, directory } = directDatabase();
    try {
      seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      const configJson = canonicalJson({ permissionMode: "full", visibility: "visible" });
      db.prepare(
        `INSERT INTO project_config_revisions
          (project_id, config_revision, canonical_config_json, config_digest, created_at_ms)
         VALUES (?, 1, ?, ?, 1)`,
      ).run(PROJECT_ID, configJson, sha256(configJson));
      db.prepare(
        "INSERT INTO project_config_heads (project_id, config_revision, updated_at_ms) VALUES (?, 1, 1)",
      ).run(PROJECT_ID);
      // Test-only corrupt-state fixture: no sanctioned issue #3 operation creates a config without a governor head.
      const before = exportFoundation(db, PROJECT_ID);
      const result = applyFixtureMutation(db, {
        ...bootstrapRequest(),
        operationClass: "config_revision",
        idempotencyKey: "governor-missing",
        expectedConfigRevision: 1,
        configRevision: 2,
        expectedGovernanceEpoch: 1,
        expectedFenceToken: "missing",
        config: { permissionMode: "auto", visibility: "visible", repositoryTargets: [TARGET_ID] },
        targets: [{ ...bootstrapRequest().targets![0]!, defaultBranch: "develop" }],
      });
      expect(result.outcome).toBe("GOVERNOR_UNAVAILABLE");
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records the frozen cutover outcome as deferred for issue #3", () => {
    expect(DEFERRED_ISSUE_3_OUTCOMES).toEqual(["PROJECT_FROZEN"]);
  });

  it("serializes two real SQLite governorship contenders and leaves no loser receipt or event", async () => {
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
      // better-sqlite3 calls are synchronous; BEGIN IMMEDIATE serializes contenders, so the second connection observes the winner's stale epoch/token.
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

  it("classifies unexpected mutation errors without leaking internal details", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
    const before = exportFoundation(db, PROJECT_ID);
    const result = (() => {
      const clock = vi.spyOn(Date, "now").mockImplementation(() => {
        throw new Error("sensitive internal detail");
      });
      try {
        return applyFixtureMutation(db, bootstrapRequest());
      } finally {
        clock.mockRestore();
      }
    })();
    expect(result).toMatchObject({ outcome: "INTERNAL_ERROR", message: "internal mutation error" });
    expect(result.message).not.toContain("sensitive internal detail");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
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
      targets: undefined,
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
      targets: undefined,
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

  it("rejects duplicate targets and selectors absent from the collection", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
    const before = exportFoundation(db, PROJECT_ID);
    const target = bootstrapRequest().targets![0]!;
    const duplicate = applyWithFixtureReceipt(db, bootstrapRequest(PROJECT_ID, {
      idempotencyKey: "duplicate-targets",
      targets: [target, { ...target, sourceId: "source-other", path: "/workspace/other" }],
    }));
    expect(duplicate.outcome).toBe("INVALID_INPUT");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    const empty = applyWithFixtureReceipt(db, bootstrapRequest(PROJECT_ID, {
      idempotencyKey: "empty-targets",
      targets: [],
    }));
    expect(empty.outcome).toBe("REPO_TARGET_REQUIRED");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    const foreignSelector = applyWithFixtureReceipt(db, bootstrapRequest(PROJECT_ID, {
      idempotencyKey: "foreign-selector",
      repoTargetId: "target-foreign",
    }));
    expect(foreignSelector.outcome).toBe("REPO_TARGET_FOREIGN");
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
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
      targets: [{ ...bootstrapRequest().targets![0]!, defaultBranch: "develop" }],
    });
    expect(appended.outcome).toBe("OK");
    expect(db.prepare("SELECT config_revision FROM project_config_heads").get()).toEqual({ config_revision: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_config_revisions").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT repo_target_id FROM repository_targets ORDER BY config_revision").all()).toEqual([
      { repo_target_id: TARGET_ID },
      { repo_target_id: TARGET_ID },
    ]);
  });

  it("creates multiple targets through the resolver and rejects an ambiguous selector", async () => {
    const { db, path, directory } = directDatabase();
    try {
      seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      const initial = applyFixtureMutation(db, bootstrapRequest());
      const fenceToken = (initial.evidence as { fenceToken: string }).fenceToken;
      const secondTarget = {
        ...bootstrapRequest().targets![0]!,
        repoTargetId: SECOND_TARGET_ID,
        sourceId: "source-second",
        path: "/workspace/second",
      };
      const expanded = applyFixtureMutation(db, {
        ...bootstrapRequest(),
        operationClass: "config_revision",
        idempotencyKey: "targets-2",
        expectedConfigRevision: 1,
        configRevision: 2,
        expectedGovernanceEpoch: 1,
        expectedFenceToken: fenceToken,
        repoTargetId: null,
        config: { permissionMode: "auto", visibility: "visible", repositoryTargets: [TARGET_ID, SECOND_TARGET_ID] },
        targets: [bootstrapRequest().targets![0]!, secondTarget],
      });
      expect(expanded).toMatchObject({ outcome: "OK", expected: 3, attempted: 3, verified: 3 });
      expect(db.prepare("SELECT repo_target_id FROM repository_targets WHERE config_revision = 2 ORDER BY repo_target_id").all()).toEqual([
        { repo_target_id: TARGET_ID },
        { repo_target_id: SECOND_TARGET_ID },
      ]);
      const before = exportFoundation(db, PROJECT_ID);
      const result = applyFixtureMutation(db, {
        ...bootstrapRequest(),
        operationClass: "config_revision",
        idempotencyKey: "ambiguous-target",
        expectedConfigRevision: 2,
        configRevision: 3,
        expectedGovernanceEpoch: 1,
        expectedFenceToken: fenceToken,
        config: undefined,
        targets: undefined,
        repoTargetId: null,
      });
      expect(result.outcome).toBe("REPO_TARGET_AMBIGUOUS");
      expect(exportFoundation(db, PROJECT_ID)).toEqual(before);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces the frozen WorkItem lifecycle, exact target, and resource-revision CAS", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    const created = applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken));
    expect(created).toMatchObject({ outcome: "OK", currentResourceRevision: 1 });
    expect(db.prepare("SELECT lifecycle_state, resource_revision FROM work_items").get()).toEqual({ lifecycle_state: "proposed", resource_revision: 1 });

    const beforeInvalid = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "succeeded", 1))).toMatchObject({ outcome: "WORK_ITEM_STATE_INVALID", attempted: 0 });
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "ready", 1, { idempotencyKey: "wrong-target", repoTargetId: "target-other" }))).toMatchObject({ outcome: "REPO_TARGET_FOREIGN", attempted: 0 });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(beforeInvalid);

    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "ready", 1))).toMatchObject({ outcome: "OK", currentResourceRevision: 2 });
    const afterWinner = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "in_progress", 1, { idempotencyKey: "stale-transition" }))).toMatchObject({
      outcome: "WORK_ITEM_REVISION_STALE",
      currentResourceRevision: 2,
      expectedResourceRevision: 1,
    });
    expect(exportFoundation(db, PROJECT_ID)).toEqual(afterWinner);
    expect(db.prepare("SELECT COUNT(*) AS count FROM state_events WHERE aggregate_type = 'work_item'").get()).toEqual({ count: 2 });
  });

  it("creates one exact GitHub projection, replays idempotently, and survives plugin reload", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    const adapter = new DeterministicGitHubIssueAdapter();
    const request = projectionRequest(fenceToken, 1);
    const projected = applyWithFixtureReceipt(db, request, adapter);
    expect(projected).toMatchObject({ outcome: "OK", expected: 1, attempted: 1, verified: 1 });
    expect(adapter.mutationCalls).toEqual([
      expect.objectContaining({ kind: "create", owner: GITHUB_OWNER, repo: GITHUB_REPO, addLabels: ["work-proposed"], removeLabels: [] }),
    ]);
    expect(db.prepare("SELECT projection_state, issue_number, projected_resource_revision FROM external_work_refs").get()).toEqual({
      projection_state: "current",
      issue_number: 1,
      projected_resource_revision: 1,
    });
    expect(db.prepare("SELECT lifecycle_state FROM work_items").get()).toEqual({ lifecycle_state: "proposed" });

    const reads = adapter.readCalls.length;
    expect(applyWithFixtureReceipt(db, request, null)).toEqual(projected);
    const unavailable = new DeterministicGitHubIssueAdapter();
    unavailable.available = false;
    expect(applyWithFixtureReceipt(db, request, unavailable)).toEqual(projected);
    expect(unavailable.mutationCalls).toHaveLength(0);
    expect(unavailable.readCalls).toHaveLength(0);
    expect(adapter.mutationCalls).toHaveLength(1);
    expect(adapter.readCalls).toHaveLength(reads);
    const conflictRequest = { ...request, workItemId: "different-work-item" };
    const conflict = applyWithFixtureReceipt(db, conflictRequest, null);
    expect(conflict).toEqual(applyWithFixtureReceipt(db, conflictRequest, unavailable));
    expect(conflict.outcome).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(adapter.mutationCalls).toHaveLength(1);

    const beforeReload = exportFoundation(db, PROJECT_ID);
    const reloaded = await host.harness.lifecycle.reload(plugin);
    const reloadedDb = reloaded.bb.storage.database();
    expect(exportFoundation(reloadedDb, PROJECT_ID)).toEqual(beforeReload);
    expect(applyWithFixtureReceipt(reloadedDb, request, adapter)).toEqual(projected);
    expect(adapter.mutationCalls).toHaveLength(1);
    await reloaded.harness.lifecycle.dispose();
  });

  it("refuses unknown, stale, unmapped, mismatched, and conflicting projection targets before adapter mutation", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    const adapter = new DeterministicGitHubIssueAdapter();
    const before = exportFoundation(db, PROJECT_ID);
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1, { workItemId: "missing" }), adapter).outcome).toBe("WORK_ITEM_UNKNOWN");
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 2, { idempotencyKey: "stale-projection" }), adapter).outcome).toBe("WORK_ITEM_REVISION_STALE");
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1, { idempotencyKey: "wrong-projection-target", repoTargetId: SECOND_TARGET_ID }), adapter).outcome).toBe("REPO_TARGET_FOREIGN");
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1, { idempotencyKey: "wrong-connector" }), new DeterministicGitHubIssueAdapter("other-host")).outcome).toBe("EXTERNAL_TARGET_MISMATCH");
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1, { idempotencyKey: "no-capability" }), null).outcome).toBe("EXTERNAL_CAPABILITY_REQUIRED");
    const unmappedProject = "proj_unmapped";
    const unmappedReceipt = "receipt-unmapped";
    const unmappedWorkItem = "foreign-only-work-item";
    seedVerifiedFixtureReceipt(db, { projectId: unmappedProject, receiptId: unmappedReceipt });
    const unmappedBootstrap = applyWithFixtureReceipt(db, bootstrapRequest(unmappedProject, {
      idempotencyKey: "bootstrap-unmapped",
      actorReceiptId: unmappedReceipt,
      config: { permissionMode: "full", visibility: "visible", repositoryTargets: [TARGET_ID] },
    }));
    const unmappedFence = (unmappedBootstrap.evidence as { fenceToken: string }).fenceToken;
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(unmappedFence, {
      projectId: unmappedProject,
      idempotencyKey: "create-unmapped",
      actorReceiptId: unmappedReceipt,
      workItem: { workItemId: unmappedWorkItem, title: "Unmapped", body: "Fixture" },
    })).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, projectionRequest(unmappedFence, 1, {
      projectId: unmappedProject,
      idempotencyKey: "project-unmapped",
      actorReceiptId: unmappedReceipt,
      workItemId: unmappedWorkItem,
    }), adapter).outcome).toBe("EXTERNAL_TARGET_REQUIRED");
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1, {
      idempotencyKey: "foreign-work-item",
      workItemId: unmappedWorkItem,
    }), adapter).outcome).toBe("WORK_ITEM_FOREIGN");
    expect(adapter.mutationCalls).toHaveLength(0);
    expect(adapter.readCalls).toHaveLength(0);
    expect(exportFoundation(db, PROJECT_ID)).toEqual(before);

    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1), adapter).outcome).toBe("OK");
    db.prepare("UPDATE external_work_refs SET owner = 'foreign-owner'").run();
    const calls = adapter.mutationCalls.length;
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1, { idempotencyKey: "foreign-ref" }), adapter).outcome).toBe("EXTERNAL_REF_CONFLICT");
    expect(adapter.mutationCalls).toHaveLength(calls);
  });

  it("treats external delete and close as non-authoritative without replacement creation", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    const adapter = new DeterministicGitHubIssueAdapter();
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1), adapter).outcome).toBe("OK");
    const original = adapter.snapshot(GITHUB_OWNER, GITHUB_REPO, 1)!;
    adapter.remove(GITHUB_OWNER, GITHUB_REPO, 1);
    const missingRequest = projectionRequest(fenceToken, 1, { idempotencyKey: "missing-external" });
    expect(applyWithFixtureReceipt(db, missingRequest, adapter).outcome).toBe("EXTERNAL_NOT_FOUND");
    expect(db.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = 'missing-external'").get()).toBeUndefined();
    expect(adapter.mutationCalls).toHaveLength(1);
    expect(db.prepare("SELECT lifecycle_state FROM work_items").get()).toEqual({ lifecycle_state: "proposed" });

    adapter.put(original);
    expect(applyWithFixtureReceipt(db, missingRequest, adapter).outcome).toBe("OK");
    const unavailableRequest = projectionRequest(fenceToken, 1, { idempotencyKey: "unavailable-external" });
    adapter.readOutcomes.push("unavailable");
    expect(applyWithFixtureReceipt(db, unavailableRequest, adapter).outcome).toBe("EXTERNAL_UNAVAILABLE");
    expect(db.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = 'unavailable-external'").get()).toBeUndefined();
    expect(applyWithFixtureReceipt(db, unavailableRequest, adapter).outcome).toBe("OK");

    adapter.put({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      issueNumber: 1,
      title: "[bb] Ship projection",
      body: "canonical: Keep canonical state local.",
      state: "closed",
      labels: ["work-proposed"],
      externalRevision: "manual-close",
    });
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1, { idempotencyKey: "closed-external" }), adapter).outcome).toBe("EXTERNAL_DIVERGED");
    expect(adapter.mutationCalls).toHaveLength(1);
    expect(db.prepare("SELECT lifecycle_state FROM work_items").get()).toEqual({ lifecycle_state: "proposed" });
    expect(db.prepare("SELECT projection_state FROM external_work_refs").get()).toEqual({ projection_state: "drifted" });
  });

  it("preserves unmanaged labels while projecting a canonical lifecycle transition", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    const adapter = new DeterministicGitHubIssueAdapter();
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1), adapter).outcome).toBe("OK");
    const external = adapter.snapshot(GITHUB_OWNER, GITHUB_REPO, 1)!;
    adapter.put({ ...external, labels: [...external.labels, "human-triage"], externalRevision: "manual-unmanaged-label" });
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "ready", 1)).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 2), adapter).outcome).toBe("OK");
    expect(adapter.mutationCalls[1]).toMatchObject({
      kind: "update",
      addLabels: ["work-ready"],
      removeLabels: ["work-proposed"],
    });
    expect(adapter.snapshot(GITHUB_OWNER, GITHUB_REPO, 1)?.labels).toEqual(["human-triage", "work-ready"]);
    expect(db.prepare("SELECT lifecycle_state, resource_revision FROM work_items").get()).toEqual({ lifecycle_state: "ready", resource_revision: 2 });
  });

  it("durably fences contradictory delivery and suppresses same/new-key retry after reopen", () => {
    const { db, path, directory } = directDatabase();
    try {
      seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      const bootstrapped = applyFixtureMutation(db, bootstrapRequest());
      const fenceToken = (bootstrapped.evidence as { fenceToken: string }).fenceToken;
      expect(applyFixtureMutation(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
      const adapter = new DeterministicGitHubIssueAdapter();
      adapter.nextMutationOutcome = "wrong_identity";
      const mutate = adapter.mutate.bind(adapter);
      let reservationInsideMutation: unknown;
      adapter.mutate = (input) => {
        reservationInsideMutation = db.prepare(
          `SELECT state_events.event_type, state_events.actor_receipt_id, actor_receipts.verification_state,
                  external_work_refs.projection_state
           FROM state_events
           JOIN actor_receipts ON actor_receipts.project_id = state_events.project_id
             AND actor_receipts.receipt_id = state_events.actor_receipt_id
           JOIN external_work_refs ON external_work_refs.project_id = state_events.project_id
             AND external_work_refs.work_item_id = state_events.aggregate_id
           WHERE state_events.event_type = 'github_issue_projection_reserved'
           ORDER BY state_events.event_sequence DESC LIMIT 1`,
        ).get();
        return mutate(input);
      };
      const request = projectionRequest(fenceToken, 1);
      const ambiguous = applyFixtureMutation(db, request, adapter);
      expect(ambiguous).toMatchObject({ outcome: "EXTERNAL_DELIVERY_AMBIGUOUS", attempted: 1, verified: 0 });
      expect(reservationInsideMutation).toEqual({
        event_type: "github_issue_projection_reserved",
        actor_receipt_id: RECEIPT_ID,
        verification_state: "verified",
        projection_state: "pending",
      });
      expect(adapter.mutationCalls).toHaveLength(1);
      expect(db.prepare("SELECT projection_state FROM external_work_refs").get()).toEqual({ projection_state: "delivery_ambiguous" });
      const before = exportFoundation(db, PROJECT_ID);
      db.close();

      const reopened = new Database(path);
      databaseIsReady(reopened);
      try {
        expect(reopened.prepare(
          "SELECT event_type, actor_receipt_id FROM state_events WHERE event_type = 'github_issue_projection_reserved'",
        ).get()).toEqual({ event_type: "github_issue_projection_reserved", actor_receipt_id: RECEIPT_ID });
        const retryAdapter = new DeterministicGitHubIssueAdapter();
        expect(applyFixtureMutation(reopened, request, retryAdapter)).toEqual(ambiguous);
        expect(applyFixtureMutation(reopened, { ...request, idempotencyKey: "new-key-after-ambiguity" }, retryAdapter).outcome).toBe("EXTERNAL_DELIVERY_AMBIGUOUS");
        expect(retryAdapter.mutationCalls).toHaveLength(0);
        expect(retryAdapter.readCalls).toHaveLength(0);
        expect(exportFoundation(reopened, PROJECT_ID)).toEqual(before);
      } finally {
        reopened.close();
      }
    } finally {
      if (db.open) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("durably fences an update whose exact read-back is lost", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    const adapter = new DeterministicGitHubIssueAdapter();
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1), adapter).outcome).toBe("OK");
    expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "ready", 1)).outcome).toBe("OK");
    adapter.readOutcomes.push("normal", "missing");
    const request = projectionRequest(fenceToken, 2);
    const ambiguous = applyWithFixtureReceipt(db, request, adapter);
    expect(ambiguous.outcome).toBe("EXTERNAL_DELIVERY_AMBIGUOUS");
    expect(adapter.mutationCalls).toHaveLength(2);
    expect(db.prepare(
      "SELECT event_type, actor_receipt_id FROM state_events WHERE event_type = 'github_issue_projection_reserved' ORDER BY event_sequence",
    ).all()).toEqual([
      { event_type: "github_issue_projection_reserved", actor_receipt_id: RECEIPT_ID },
      { event_type: "github_issue_projection_reserved", actor_receipt_id: RECEIPT_ID },
    ]);
    expect(db.prepare("SELECT projection_state FROM external_work_refs").get()).toEqual({ projection_state: "delivery_ambiguous" });
    const calls = adapter.mutationCalls.length;
    expect(applyWithFixtureReceipt(db, request, adapter)).toEqual(ambiguous);
    expect(applyWithFixtureReceipt(db, { ...request, idempotencyKey: "update-after-ambiguous" }, adapter).outcome).toBe("EXTERNAL_DELIVERY_AMBIGUOUS");
    expect(adapter.mutationCalls).toHaveLength(calls);
  });

  it("fences a WorkItem transition/projection race after the one external mutation", async () => {
    const host = await loadedHost();
    const { db, fenceToken } = seedAndBootstrap(host);
    expect(applyWithFixtureReceipt(db, workItemCreateRequest(fenceToken)).outcome).toBe("OK");
    const adapter = new DeterministicGitHubIssueAdapter();
    const mutate = adapter.mutate.bind(adapter);
    adapter.mutate = (input) => {
      const snapshot = mutate(input);
      expect(applyWithFixtureReceipt(db, transitionRequest(fenceToken, "ready", 1, { idempotencyKey: "race-winner" })).outcome).toBe("OK");
      return snapshot;
    };
    expect(applyWithFixtureReceipt(db, projectionRequest(fenceToken, 1), adapter).outcome).toBe("EXTERNAL_DELIVERY_AMBIGUOUS");
    expect(adapter.mutationCalls).toHaveLength(1);
    expect(db.prepare("SELECT lifecycle_state, resource_revision FROM work_items").get()).toEqual({ lifecycle_state: "ready", resource_revision: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM state_events WHERE aggregate_type = 'work_item'").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT projection_state FROM external_work_refs").get()).toEqual({ projection_state: "pending" });
  });

  it("never overwrites a newer reservation or finalized ref with stale projection context", async () => {
    const driftHost = await loadedHost();
    const { db: driftDb, fenceToken: driftFence } = seedAndBootstrap(driftHost);
    expect(applyWithFixtureReceipt(driftDb, workItemCreateRequest(driftFence)).outcome).toBe("OK");
    const driftAdapter = new DeterministicGitHubIssueAdapter();
    expect(applyWithFixtureReceipt(driftDb, projectionRequest(driftFence, 1), driftAdapter).outcome).toBe("OK");
    const drifted = driftAdapter.snapshot(GITHUB_OWNER, GITHUB_REPO, 1)!;
    driftAdapter.put({ ...drifted, state: "closed", externalRevision: "manual-close" });
    const read = driftAdapter.read.bind(driftAdapter);
    driftAdapter.read = (owner, repo, issueNumber) => {
      const snapshot = read(owner, repo, issueNumber);
      driftDb.prepare(
        `UPDATE external_work_refs SET projection_state = 'pending', desired_digest = 'newer-desired',
         last_idempotency_key = 'newer-reservation', last_request_digest = 'newer-request'
         WHERE project_id = ? AND work_item_id = ?`,
      ).run(PROJECT_ID, WORK_ITEM_ID);
      return snapshot;
    };
    expect(applyWithFixtureReceipt(driftDb, projectionRequest(driftFence, 1, { idempotencyKey: "stale-drift" }), driftAdapter).outcome).toBe("EXTERNAL_DIVERGED");
    expect(driftDb.prepare("SELECT projection_state, desired_digest, last_idempotency_key FROM external_work_refs").get()).toEqual({
      projection_state: "pending",
      desired_digest: "newer-desired",
      last_idempotency_key: "newer-reservation",
    });
    expect(driftDb.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = 'stale-drift'").get()).toBeUndefined();

    const finalizeHost = await loadedHost();
    const { db: finalizeDb, fenceToken: finalizeFence } = seedAndBootstrap(finalizeHost);
    expect(applyWithFixtureReceipt(finalizeDb, workItemCreateRequest(finalizeFence)).outcome).toBe("OK");
    const finalizeAdapter = new DeterministicGitHubIssueAdapter();
    const mutate = finalizeAdapter.mutate.bind(finalizeAdapter);
    finalizeAdapter.mutate = (input) => {
      const snapshot = mutate(input);
      finalizeDb.prepare(
        `UPDATE external_work_refs SET issue_number = ?, projection_state = 'current',
         projected_resource_revision = 1, desired_digest = 'newer-finalized',
         observed_external_revision = 'newer-revision', observed_external_digest = 'newer-observed',
         last_idempotency_key = 'newer-finalization', last_request_digest = 'newer-request'
         WHERE project_id = ? AND work_item_id = ?`,
      ).run(snapshot.issueNumber, PROJECT_ID, WORK_ITEM_ID);
      return snapshot;
    };
    expect(applyWithFixtureReceipt(finalizeDb, projectionRequest(finalizeFence, 1), finalizeAdapter).outcome).toBe("EXTERNAL_DELIVERY_AMBIGUOUS");
    expect(finalizeDb.prepare("SELECT projection_state, desired_digest, last_idempotency_key FROM external_work_refs").get()).toEqual({
      projection_state: "current",
      desired_digest: "newer-finalized",
      last_idempotency_key: "newer-finalization",
    });
    expect(finalizeDb.prepare("SELECT 1 FROM mutation_receipts WHERE idempotency_key = 'project-github-1'").get()).toBeUndefined();
  });

  it("accepts partial lifecycle-label maps and rejects unknown or undeclared labels", async () => {
    const partialHost = await loadedHost();
    const partialDb = partialHost.bb.storage.database();
    seedVerifiedFixtureReceipt(partialDb, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
    const partialConfig = structuredClone(bootstrapRequest().config) as {
      extensions: { bbCollab: { githubIssues: { issue: { managedLabels: { byLifecycle: Record<string, string[]> } } } } };
    };
    partialConfig.extensions.bbCollab.githubIssues.issue.managedLabels.byLifecycle = { ready: ["work-ready"] };
    expect(applyWithFixtureReceipt(partialDb, bootstrapRequest(PROJECT_ID, { config: partialConfig })).outcome).toBe("OK");

    const invalidLifecycleLabels: Array<[string, Record<string, string[]>]> = [
      ["unknown", { parked: ["work-ready"] }],
      ["undeclared", { ready: ["not-declared"] }],
    ];
    for (const [name, byLifecycle] of invalidLifecycleLabels) {
      const host = await loadedHost();
      const db = host.bb.storage.database();
      seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
      const config = structuredClone(bootstrapRequest().config) as typeof partialConfig;
      config.extensions.bbCollab.githubIssues.issue.managedLabels.byLifecycle = byLifecycle;
      expect(applyWithFixtureReceipt(db, bootstrapRequest(PROJECT_ID, { idempotencyKey: `labels-${name}`, config })).outcome).toBe("INVALID_INPUT");
      expect(db.prepare("SELECT COUNT(*) AS count FROM project_config_revisions").get()).toEqual({ count: 0 });
    }
  });

  it("rejects malformed or duplicate namespaced GitHub mappings before bootstrap mutation", async () => {
    const host = await loadedHost();
    const db = host.bb.storage.database();
    seedVerifiedFixtureReceipt(db, { projectId: PROJECT_ID, receiptId: RECEIPT_ID });
    const base = bootstrapRequest().config as Record<string, unknown>;
    const extensions = structuredClone(base.extensions) as {
      bbCollab: { githubIssues: { repositoryMappings: unknown[] } };
    };
    extensions.bbCollab.githubIssues.repositoryMappings.push({ repoTargetId: TARGET_ID, owner: "other", repo: "other", connectorHost: CONNECTOR_HOST });
    expect(applyWithFixtureReceipt(db, bootstrapRequest(PROJECT_ID, { config: { ...base, extensions } })).outcome).toBe("INVALID_INPUT");
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_config_revisions").get()).toEqual({ count: 0 });
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
