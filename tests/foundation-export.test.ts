import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import plugin from "../server.js";
import {
  MAX_EXPORT_ROWS,
  exportFoundation,
  sha256,
  type ExportFilePayload,
  type FoundationResult,
} from "../src/foundation.js";

it("keeps an export RPC spill path out of ordinary copies", async () => {
  const host = createFakePluginHost({ pluginId: "bb-collab" });
  await plugin(host.bb);
  const db = host.bb.storage.database();
  const insert = db.prepare(`INSERT INTO evidence_artifacts (
    project_id, evidence_id, evidence_kind, source_kind, source_ref, execution_attempt_id,
    content_digest, redacted_json, redacted_digest, durable_ref_json, artifact_identity_digest, created_at_ms
  ) VALUES (?, ?, 'test', 'test', ?, NULL, ?, '{}', ?, '{}', ?, 0)`);
  for (let index = 0; index <= MAX_EXPORT_ROWS; index += 1) {
    const id = `evidence-${index}`;
    const digest = sha256(id);
    insert.run("project-synthetic", id, id, digest, digest, digest);
  }

  try {
    const rpcResult = await host.harness.callRpc("export", { projectId: "project-synthetic" }) as FoundationResult;
    const rpcExportFile = (rpcResult.evidence as { exportFile: ExportFilePayload }).exportFile;
    const localResult = exportFoundation(db, "project-synthetic");
    const localExportFile = (localResult.evidence as { exportFile: ExportFilePayload }).exportFile;
    const serialized = JSON.parse(JSON.stringify(localResult)) as typeof localResult;
    const displayDirectory = ((serialized.evidence as { exportFile: ExportFilePayload }).exportFile).directory;
    const copies = [{ kind: "spread", value: { ...rpcExportFile } }, { kind: "structuredClone", value: structuredClone(rpcExportFile) }];

    expect(Object.keys(rpcExportFile)).not.toContain("directory");
    expect(isAbsolute(displayDirectory)).toBe(false);
    for (const copy of copies) {
      expect(copy.value).not.toHaveProperty("directory");
      expect(isAbsolute(copy.value.displayDirectory!)).toBe(false);
      expect(copy.value.displayDirectory!.split("/")).not.toContain(basename(dirname(dirname(localExportFile.directory))));
      expect(JSON.stringify(copy.value)).not.toContain(localExportFile.directory);
    }
    expect(Object.getOwnPropertyDescriptor(localExportFile, "directory")?.enumerable).toBe(false);
    expect(isAbsolute(localExportFile.directory)).toBe(true);
    expect(readFileSync(join(localExportFile.directory, "manifest.json"), "utf8")).not.toBe("");
  } finally {
    await host.harness.dispose();
  }
});
