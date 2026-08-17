import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type { JsonValue } from "@bb/plugin-sdk";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import plugin from "../server.js";
import {
  MIGRATIONS,
  OPERATOR_RECEIPT_RETIREMENT_CONDITION,
  TABLES,
  databaseIsReady,
  exportFoundation,
  persistInterimOperatorReceipt,
  type OperatorReceiptRequest,
} from "../src/foundation.js";

const PROJECT_ID = "proj_operator_receipt";
const MUTATION_CLASS = "decision_disposition" as const;
const CANDIDATE_HEAD = "a".repeat(40);
const REQUEST_DIGEST = "d".repeat(64);

function request(overrides: Partial<OperatorReceiptRequest> = {}): OperatorReceiptRequest {
  return {
    projectId: PROJECT_ID,
    mutationClass: MUTATION_CLASS,
    candidateHead: CANDIDATE_HEAD,
    idempotencyKey: "operator-request-1",
    requestDigest: REQUEST_DIGEST,
    callerThreadId: "thread-caller",
    requestedFromBackground: false,
    ...overrides,
  };
}

const issuanceProvenanceMustBeExplicit = () => {
  // @ts-expect-error receipt minting must name its issuance provenance.
  persistInterimOperatorReceipt(null as never, { ...request(), callerPluginId: "bb-collab" });
};
void issuanceProvenanceMustBeExplicit;

async function loadedHost() {
  const host = createFakePluginHost({ pluginId: "bb-collab" });
  await plugin(host.bb);
  return host;
}

async function pendingRequest(host: Awaited<ReturnType<typeof loadedHost>>, input = request()) {
  const result = host.harness.callRpc("operatorReceipt", input);
  await vi.waitFor(() => expect(host.harness.inspection.pendingInteractions).toHaveLength(1));
  return { result, id: host.harness.inspection.pendingInteractions[0].id };
}

function consoleInteraction(overrides: Record<string, unknown> = {}) {
  return {
    id: "interaction-console-1",
    threadId: "worker-thread",
    status: "pending",
    createdAt: 100,
    expiresAt: 3_600_100,
    resolvedAt: null,
    turnId: null,
    origin: { kind: "plugin", pluginId: "bb-collab", rendererId: "operator-receipt" },
    payload: {
      kind: "plugin",
      title: "Confirm operator receipt",
      data: {
        kind: "operator_receipt_confirmation",
        projectId: PROJECT_ID,
        mutationClass: MUTATION_CLASS,
        candidateHead: CANDIDATE_HEAD,
        idempotencyKey: "operator-request-1",
        requestDigest: REQUEST_DIGEST,
        callerThreadId: "worker-thread",
        retirementCondition: OPERATOR_RECEIPT_RETIREMENT_CONDITION,
        requestedFromBackground: true,
      },
    },
    resolution: null,
    ...overrides,
  };
}

describe("interim operator receipts", () => {
  it("declares a secret-only universal operator credential", async () => {
    const host = await loadedHost();
    expect(host.harness.inspection.registrations.settingsDescriptors).toEqual({
      operatorPassphrase: {
        type: "string",
        label: "Operator approval passphrase",
        description: "Required by the universal Lanes approval console; stored as a secret.",
        secret: true,
      },
    });
  });

  it("persists only an explicitly confirmed exact binding", async () => {
    const host = await loadedHost();
    const input = request();
    const pending = await pendingRequest(host, input);
    expect(host.harness.inspection.pendingInteractions[0].payload).toMatchObject({
      projectId: input.projectId,
      mutationClass: input.mutationClass,
      candidateHead: input.candidateHead,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      requestedFromBackground: input.requestedFromBackground,
    });
    expect(host.harness.inspection.pendingInteractions[0].timeoutMs).toBe(3_600_000);

    host.harness.behavior.submitInteraction(pending.id, {
      confirmed: true,
      projectId: input.projectId,
      mutationClass: input.mutationClass,
      candidateHead: input.candidateHead,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
    });

    const result = await pending.result;
    expect(result).toMatchObject({ outcome: "OK", operatorReceipt: {
      projectId: PROJECT_ID,
      mutationClass: MUTATION_CLASS,
      candidateHead: CANDIDATE_HEAD,
      status: "interim",
      retirementCondition: OPERATOR_RECEIPT_RETIREMENT_CONDITION,
      callerPluginId: "bb-collab",
    } });
    const db = host.bb.storage.database();
    expect(db.prepare("SELECT project_id, mutation_class, candidate_head, idempotency_key, request_digest, status, retirement_condition FROM operator_receipts").get()).toEqual({
      project_id: PROJECT_ID,
      mutation_class: MUTATION_CLASS,
      candidate_head: CANDIDATE_HEAD,
      idempotency_key: input.idempotencyKey,
      request_digest: input.requestDigest,
      status: "interim",
      retirement_condition: OPERATOR_RECEIPT_RETIREMENT_CONDITION,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM state_events").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts").get()).toEqual({ count: 0 });
  });

  it("does not persist a cancelled host interaction", async () => {
    const host = await loadedHost();
    const pending = await pendingRequest(host);
    host.harness.behavior.cancelInteraction(pending.id);

    await expect(pending.result).resolves.toMatchObject({ outcome: "OPERATOR_RECEIPT_CANCELLED" });
    expect(host.bb.storage.database().prepare("SELECT COUNT(*) AS count FROM operator_receipts").get()).toEqual({ count: 0 });
  });

  it("wakes the desktop worker with the console-issued receipt and evidence", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab", settings: { operatorPassphrase: "correct-secret" } });
    await plugin(host.bb);
    const input = request({ callerThreadId: "worker-thread" });
    const pending = await pendingRequest(host, input);
    const interaction = consoleInteraction({ id: pending.id, threadId: input.callerThreadId });
    host.harness.sdk.stub("threads.interactions.get", async () => interaction);
    host.harness.sdk.stub("threads.interactions.respond", async (args: unknown) => {
      host.harness.behavior.submitInteraction(pending.id, (args as { value: JsonValue }).value);
      return interaction;
    });
    const approved = await host.harness.callRpc("operatorReceiptDecision", {
      interactionId: pending.id,
      threadId: input.callerThreadId,
      projectId: input.projectId,
      mutationClass: input.mutationClass,
      candidateHead: input.candidateHead,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      callerThreadId: input.callerThreadId,
      requestedFromBackground: input.requestedFromBackground,
      createdAt: 100,
      expiresAt: 3_600_100,
      ageMs: 0,
      decision: "approve",
      passphrase: "correct-secret",
      approverThreadId: "operator-thread",
    }) as { outcome: string; operatorReceipt?: { receiptId: string }; evidence?: { evidenceId: string } };
    const worker = await pending.result as { outcome: string; operatorReceipt?: { receiptId: string }; evidence?: { evidenceId: string; source: string } };
    expect(approved.outcome).toBe("OK");
    expect(worker).toMatchObject({ outcome: "OK", operatorReceipt: { receiptId: approved.operatorReceipt?.receiptId } });
    expect(worker.evidence).toMatchObject({ evidenceId: approved.evidence?.evidenceId, source: "connect-session" });
    expect(host.bb.storage.database().prepare("SELECT COUNT(*) AS count FROM operator_receipts").get()).toEqual({ count: 1 });
    expect(host.bb.storage.database().prepare("SELECT COUNT(*) AS count FROM evidence_artifacts").get()).toEqual({ count: 1 });
  });

  it("refuses invalid form results without persisting", async () => {
    const host = await loadedHost();
    const input = request();
    const pending = await pendingRequest(host, input);
    host.harness.behavior.submitInteraction(pending.id, { confirmed: true, projectId: PROJECT_ID, mutationClass: MUTATION_CLASS, candidateHead: "a".repeat(41), idempotencyKey: input.idempotencyKey, requestDigest: input.requestDigest });

    await expect(pending.result).resolves.toMatchObject({ outcome: "INVALID_INPUT" });
    expect(host.bb.storage.database().prepare("SELECT COUNT(*) AS count FROM operator_receipts").get()).toEqual({ count: 0 });
  });

  it("refuses a stale binding even when the submitted head is otherwise valid", async () => {
    const host = await loadedHost();
    const input = request();
    const pending = await pendingRequest(host, input);
    host.harness.behavior.submitInteraction(pending.id, {
      confirmed: true,
      projectId: PROJECT_ID,
      mutationClass: MUTATION_CLASS,
      candidateHead: "b".repeat(40),
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
    });

    await expect(pending.result).resolves.toMatchObject({ outcome: "OPERATOR_RECEIPT_STALE" });
    expect(host.bb.storage.database().prepare("SELECT COUNT(*) AS count FROM operator_receipts").get()).toEqual({ count: 0 });
  });

  it("keeps the typed row and schema durable across reopen and export", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-collab-operator-receipt-"));
    const path = join(directory, "data.db");
    try {
      const first = new Database(path);
      databaseIsReady(first);
      for (const migration of MIGRATIONS) first.exec(migration);
      const input = request({ requestedFromBackground: true });
      const receipt = persistInterimOperatorReceipt(first, { ...input, callerPluginId: "bb-collab", issuanceProvenance: "console" }, 123);
      expect(TABLES).toContain("operator_receipts");
      first.close();

      const second = new Database(path);
      databaseIsReady(second);
      expect(second.prepare("SELECT status, requested_from_background, idempotency_key, request_digest, created_at_ms FROM operator_receipts WHERE receipt_id = ?").get(receipt.receiptId)).toEqual({
        status: "interim",
        requested_from_background: 1,
        idempotency_key: input.idempotencyKey,
        request_digest: input.requestDigest,
        created_at_ms: 123,
      });
      const exported = exportFoundation(second, PROJECT_ID);
      expect(exported.outcome).toBe("OK");
      expect(exported.export?.manifest.tableCounts.operator_receipts).toBe(1);
      expect(exported.export?.recordsNdjson).toContain('"table":"operator_receipts"');
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lists only live receipt interactions and fails closed before any approval write", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab", settings: { operatorPassphrase: "correct-secret" } });
    await plugin(host.bb);
    let interaction = consoleInteraction();
    host.harness.sdk.stub("threads.list", async () => [{ id: "worker-thread", hasPendingInteraction: true }]);
    host.harness.sdk.stub("threads.interactions.list", async () => [
      interaction,
      { ...interaction, id: "resolved", status: "resolved" },
      { ...interaction, id: "provider", origin: { kind: "provider" } },
      { ...interaction, id: "wrong-renderer", origin: { kind: "plugin", pluginId: "bb-collab", rendererId: "other" } },
      { ...interaction, id: "malformed", payload: { kind: "plugin", data: { kind: "not-a-receipt" } } },
    ]);
    const listed = await host.harness.callRpc("operatorReceiptRequests", {}) as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ interactionId: interaction.id, projectId: PROJECT_ID, callerThreadId: "worker-thread" });

    host.harness.sdk.stub("threads.interactions.get", async () => interaction);
    host.harness.sdk.stub("threads.interactions.respond", async () => {
      interaction = { ...interaction, status: "resolved" };
      return interaction;
    });
    const binding = listed[0];
    const before = host.bb.storage.database().prepare("SELECT COUNT(*) AS count FROM operator_receipts").get();
    for (const hostile of [
      { passphrase: undefined },
      { passphrase: "wrong-secret" },
      { passphrase: "correct-secret", projectId: "proj-foreign" },
      { passphrase: "correct-secret", interactionId: "foreign-interaction" },
      { passphrase: "correct-secret", candidateHead: "b".repeat(40) },
      { passphrase: "correct-secret", approverThreadId: "worker-thread" },
    ]) {
      const result = await host.harness.callRpc("operatorReceiptDecision", {
        ...binding,
        ...hostile,
        decision: "approve",
        approverThreadId: hostile.approverThreadId ?? null,
      }) as { outcome: string };
      expect(result.outcome).not.toBe("OK");
    }
    expect(host.bb.storage.database().prepare("SELECT COUNT(*) AS count FROM operator_receipts").get()).toEqual(before);

    const approved = await host.harness.callRpc("operatorReceiptDecision", {
      ...binding,
      decision: "approve",
      passphrase: "correct-secret",
      approverThreadId: "operator-thread",
    }) as Record<string, unknown>;
    expect(approved).toMatchObject({ outcome: "OK", evidence: { source: "connect-session", interactionId: interaction.id }, operatorReceipt: { callerThreadId: "worker-thread" } });
    expect(host.bb.storage.database().prepare("SELECT COUNT(*) AS count FROM operator_receipts").get()).toEqual({ count: 1 });
    const receiptId = (approved as { operatorReceipt: { receiptId: string } }).operatorReceipt.receiptId;
    expect(host.bb.storage.database().prepare("SELECT evidence_kind, source_kind, source_ref FROM evidence_artifacts").get()).toEqual({
      evidence_kind: "legacy_claim",
      source_kind: "legacy_claim",
      source_ref: `operator-receipt:${receiptId}`,
    });
    expect(JSON.stringify(exportFoundation(host.bb.storage.database(), PROJECT_ID))).not.toContain("correct-secret");

    const replay = await host.harness.callRpc("operatorReceiptDecision", {
      ...binding,
      decision: "approve",
      passphrase: "correct-secret",
      approverThreadId: "operator-thread",
    }) as { outcome: string };
    expect(replay.outcome).toBe("OPERATOR_RECEIPT_REUSED");
    expect(host.bb.storage.database().prepare("SELECT COUNT(*) AS count FROM operator_receipts").get()).toEqual({ count: 1 });
  });

  it("reports whether the approval passphrase is set, never what it is", async () => {
    for (const [settings, configured] of [[undefined, false], [{ operatorPassphrase: "" }, false], [{ operatorPassphrase: "correct-secret" }, true]] as const) {
      const host = createFakePluginHost({ pluginId: "bb-collab", settings });
      await plugin(host.bb);
      const state = await host.harness.callRpc("operatorPassphraseState", {});
      expect(state, JSON.stringify(settings)).toEqual({ configured });
      // The contract is `{ configured }` strict, so passphrase material has no
      // field to ride out on even if a handler tried to attach it.
      expect(JSON.stringify(state)).not.toContain("correct-secret");
    }
  });

  it("answers unknown, not unset, when the secret settings read fails", async () => {
    // #given a passphrase that *is* set, behind a settings store that throws:
    // the discriminating case, because "unset" would be a false accusation.
    const host = createFakePluginHost({ pluginId: "bb-collab", settings: { operatorPassphrase: "correct-secret" } });
    const define = host.bb.settings.define;
    host.bb.settings.define = ((descriptors) => ({
      ...define(descriptors),
      get: async () => { throw new Error("secret settings unavailable"); },
    })) as typeof define;
    await plugin(host.bb);

    // #then the console is told nothing rather than told a falsehood...
    expect(await host.harness.callRpc("operatorPassphraseState", {})).toEqual({ configured: null });

    // #and the decision path still refuses the passphrase that would have worked.
    const interaction = consoleInteraction();
    host.harness.sdk.stub("threads.list", async () => [{ id: "worker-thread", hasPendingInteraction: true }]);
    host.harness.sdk.stub("threads.interactions.list", async () => [interaction]);
    host.harness.sdk.stub("threads.interactions.get", async () => interaction);
    const [binding] = await host.harness.callRpc("operatorReceiptRequests", {}) as Array<Record<string, unknown>>;
    const refused = await host.harness.callRpc("operatorReceiptDecision", {
      ...binding,
      decision: "approve",
      passphrase: "correct-secret",
      approverThreadId: "operator-thread",
    }) as { outcome: string };
    expect(refused.outcome).toBe("OPERATOR_RECEIPT_INVALID");
    expect(host.bb.storage.database().prepare("SELECT COUNT(*) AS count FROM operator_receipts").get()).toEqual({ count: 0 });
  });

  it("publishes sidebar waiting counts without any receipt binding material", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab", settings: { operatorPassphrase: "correct-secret" } });
    await plugin(host.bb);
    const interaction = consoleInteraction();
    host.harness.sdk.stub("threads.list", async () => [{ id: "worker-thread", hasPendingInteraction: true }]);
    host.harness.sdk.stub("threads.interactions.list", async () => [
      interaction,
      { ...interaction, id: "interaction-console-2" },
      { ...interaction, id: "resolved", status: "resolved" },
    ]);

    const response = await host.harness.fetchHttp("GET", "/operator-receipt-waits");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ total: 2, threads: { "worker-thread": 2 } });
    for (const material of [PROJECT_ID, CANDIDATE_HEAD, REQUEST_DIGEST, MUTATION_CLASS, "correct-secret"]) {
      expect(body, material).not.toContain(material);
    }
  });

  // #given the interaction read is the only source of these counts #when that
  // read fails #then the outage must stay distinguishable from a proven zero,
  // because the sidebar consumer treats a 200 body as authoritative.
  it("refuses the waiting counts when the interaction read fails and still proves a real zero", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab", settings: { operatorPassphrase: "correct-secret" } });
    await plugin(host.bb);

    host.harness.sdk.stub("threads.list", async () => {
      throw new Error("interaction read unavailable");
    });
    const failed = await host.harness.fetchHttp("GET", "/operator-receipt-waits");
    const failedBody = await failed.text();
    expect(failed.ok).toBe(false);
    expect(failed.status).toBe(503);
    expect(failedBody).not.toBe(JSON.stringify({ total: 0, threads: {} }));
    expect(failedBody).not.toContain("interaction read unavailable");

    // #and a genuine no-pending read is still the exact authoritative zero.
    host.harness.sdk.stub("threads.list", async () => []);
    const empty = await host.harness.fetchHttp("GET", "/operator-receipt-waits");
    expect(empty.status).toBe(200);
    expect(JSON.parse(await empty.text())).toEqual({ total: 0, threads: {} });
  });

  it("rejects a live request through the same host interaction without writing a receipt", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab", settings: { operatorPassphrase: "correct-secret" } });
    await plugin(host.bb);
    const interaction = consoleInteraction();
    host.harness.sdk.stub("threads.interactions.get", async () => interaction);
    const responses: unknown[] = [];
    host.harness.sdk.stub("threads.interactions.respond", async (args: unknown) => {
      responses.push(args);
      return interaction;
    });
    const result = await host.harness.callRpc("operatorReceiptDecision", {
      interactionId: interaction.id,
      threadId: interaction.threadId,
      projectId: PROJECT_ID,
      mutationClass: MUTATION_CLASS,
      candidateHead: CANDIDATE_HEAD,
      idempotencyKey: "operator-request-1",
      requestDigest: REQUEST_DIGEST,
      callerThreadId: "worker-thread",
      requestedFromBackground: true,
      createdAt: interaction.createdAt,
      expiresAt: interaction.expiresAt,
      ageMs: 0,
      decision: "reject",
      passphrase: "correct-secret",
      approverThreadId: null,
    }) as { outcome: string };
    expect(result.outcome).toBe("OPERATOR_RECEIPT_CANCELLED");
    expect(responses).toHaveLength(1);
    expect((responses[0] as { value: { confirmed: boolean } }).value.confirmed).toBe(false);
    expect(host.bb.storage.database().prepare("SELECT COUNT(*) AS count FROM operator_receipts").get()).toEqual({ count: 0 });
  });
});
