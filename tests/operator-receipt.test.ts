import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
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

describe("interim operator receipts", () => {
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
      const receipt = persistInterimOperatorReceipt(first, { ...input, callerPluginId: "bb-collab" }, 123);
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
});
