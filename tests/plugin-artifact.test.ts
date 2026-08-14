import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(ROOT);

describe("path-install server artifact", () => {
  it("loads without a plugin dependency tree", async () => {
    const cleanRoot = mkdtempSync(join(tmpdir(), "bb-collab-artifact-"));
    try {
      const artifactRoot = join(cleanRoot, "dist");
      mkdirSync(artifactRoot, { recursive: true });
      const server = readFileSync(join(PROJECT_ROOT, "dist/server.js"), "utf8").replace(/\n\/\/# sourceMappingURL=.*$/mu, "\n");
      writeFileSync(join(artifactRoot, "server.js"), server);
      cpSync(join(PROJECT_ROOT, "dist/server.meta.json"), join(artifactRoot, "server.meta.json"));
      const sdkRoot = join(cleanRoot, "node_modules/@bb");
      mkdirSync(sdkRoot, { recursive: true });
      symlinkSync(join(PROJECT_ROOT, "node_modules/@bb/plugin-sdk"), join(sdkRoot, "plugin-sdk"));

      const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
      expect(manifest.bb.server).toBe("./dist/server.js");
      expect(existsSync(join(cleanRoot, "node_modules/zod"))).toBe(false);
      expect(readFileSync(join(artifactRoot, "server.js"), "utf8")).not.toMatch(/(?:from|require\() ["']zod["']/);

      const loaded = await import(pathToFileURL(join(artifactRoot, "server.js")).href);
      expect(typeof loaded.default).toBe("function");
    } finally {
      rmSync(cleanRoot, { recursive: true, force: true });
    }
  });

  // The server artifact is tracked but the app bundle was not, so checking a
  // path install out to a new commit updated the backend and left the previous
  // frontend in place. The two then disagreed about an RPC's shape and the
  // sidebar crashed. Ship them together or not at all.
  it("tracks the app bundle alongside the server artifact", () => {
    const tracked = execFileSync("git", ["ls-files", "dist"], { cwd: PROJECT_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(tracked).toEqual(expect.arrayContaining([
      "dist/server.js",
      "dist/server.meta.json",
      "dist/app.js",
      "dist/app.meta.json",
    ]));

    const appMeta = JSON.parse(readFileSync(join(PROJECT_ROOT, "dist/app.meta.json"), "utf8"));
    const serverMeta = JSON.parse(readFileSync(join(PROJECT_ROOT, "dist/server.meta.json"), "utf8"));
    expect(appMeta.pluginVersion).toBe(serverMeta.pluginVersion);
    expect(appMeta.sdkVersion).toBe(serverMeta.sdkVersion);
  });
});
