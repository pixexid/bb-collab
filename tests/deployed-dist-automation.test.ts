import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server.js";
import { PLUGIN_ID } from "../src/foundation.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

describe("deployed dist automation", () => {
  it("reports divergent deployed dist when the recurring schedule fires", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-collab-deployed-dist-"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/server.js"), "committed\n");
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "Test");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "fixture");
    writeFileSync(join(root, "dist/server.js"), "divergent\n");

    const bin = join(root, "bin");
    mkdirSync(bin);
    const bb = join(bin, "bb");
    writeFileSync(bb, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ plugins: [{ id: "bb-collab", rootDir: root, source: `path:${root}` }] }))});\n`);
    chmodSync(bb, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      const host = createFakePluginHost({
        pluginId: PLUGIN_ID,
        sdk: {
          projects: { list: async () => [] },
          plugins: { list: async () => ({ plugins: [] }) as never },
          threads: { list: async () => [] },
        },
      });
      await plugin(host.bb);
      await host.harness.runSchedule("fleet-watchdog");
      expect(host.harness.inspection.logEntries).toContainEqual(expect.objectContaining({
        level: "error",
        message: expect.stringContaining(`deployed working tree dist/ at ${root} differs from commit`),
      }));
      await host.harness.lifecycle.dispose();
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
