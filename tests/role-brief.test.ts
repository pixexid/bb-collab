import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function project(projectId: string) {
  return { id: projectId, name: "Brief project", sources: [{ id: "source-main" }] };
}

describe("role briefs", () => {
  it("composes canonical docs with live project pointers", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab" });
    host.harness.sdk.stub("projects.get", (async ({ projectId }: { projectId: string }) => project(projectId)) as never);
    await plugin(host.bb);

    await expect(host.harness.callRpc("roleBrief", { projectId: "project-brief", role: "worker" })).resolves.toMatchObject({
      role: "worker",
      project: { id: "project-brief", name: "Brief project", sourceIds: ["source-main"] },
      pointers: { canonicalStoreQuery: "role_generation_heads joined to role_generations", currentSeats: [] },
      ponytail: expect.stringContaining("Does this need to exist at all?"),
      roleContent: expect.stringContaining("# Worker"),
      prompt: expect.stringContaining("## Ponytail preamble"),
    });
  });

  it("briefs a created worker through the lifecycle event", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab" });
    host.harness.sdk.stub("projects.get", (async ({ projectId }: { projectId: string }) => project(projectId)) as never);
    host.harness.sdk.stub("threads.send", (async () => ({ ok: true })) as never);
    await plugin(host.bb);

    await expect(host.harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "worker-brief", projectId: "project-brief" }) })).resolves.toEqual({ errors: [] });
    const request = host.harness.inspection.sdk.callsTo("threads.send")[0]?.[0] as { threadId: string; mode: string; input: Array<{ visibility: string; text: string }> };
    expect(request).toMatchObject({ threadId: "worker-brief", mode: "queue-if-active" });
    expect(request.input[0]).toMatchObject({ visibility: "agent-only", text: expect.stringContaining("Does this need to exist at all?") });
  });

  it("rejects a stale generated bundle", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-collab-role-brief-"));
    try {
      const artifact = join(directory, "role-briefs.json");
      writeFileSync(artifact, readFileSync(join(root, "dist", "role-briefs.json"), "utf8").replace("# Ponytail", "# Stale Ponytail"));
      expect(() => execFileSync(process.execPath, [join(root, "scripts", "role-brief-bundle.mjs"), artifact], { cwd: root, stdio: "pipe" })).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
