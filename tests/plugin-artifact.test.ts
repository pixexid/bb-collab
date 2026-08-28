import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { isLiveCachedConsumerRolloutArtifact } from "../server.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(ROOT);
const sourceDetail = (root: string) => ({
  requested: `path:${root}`,
  resolved: `path:${root}`,
  engines: {},
  history: [],
});

async function guardedArtifact(moduleUrl: string, source: ReturnType<typeof sourceDetail> | "throw") {
  const host = createFakePluginHost({ pluginId: "bb-collab" });
  host.harness.sdk.stub("plugins.getSource", async ({ pluginId }: { pluginId: string }) => {
    expect(pluginId).toBe("bb-collab");
    if (source === "throw") throw new Error("source unavailable");
    return source;
  });
  return isLiveCachedConsumerRolloutArtifact(moduleUrl, host.bb);
}

describe("path-install server artifact", () => {
  it("binds artifact paths to the host-resolved plugin root and fails closed", async () => {
    const liveArtifact = pathToFileURL(join(PROJECT_ROOT, "dist/server.js")).href;
    const notDistArtifact = pathToFileURL(join(PROJECT_ROOT, "notdist/server.js")).href;
    expect(await guardedArtifact(`${liveArtifact}?bbPluginLoad=7.9#reload`, sourceDetail(PROJECT_ROOT))).toBe(true);
    expect(await guardedArtifact(liveArtifact, sourceDetail(PROJECT_ROOT))).toBe(true);
    expect(await guardedArtifact(notDistArtifact, sourceDetail(PROJECT_ROOT))).toBe(false);
    expect(await guardedArtifact(liveArtifact, sourceDetail(join(PROJECT_ROOT, "other-root")))).toBe(false);
    expect(await guardedArtifact(`${liveArtifact}?bbPluginLoad=7.9#reload`, "throw")).toBe(false);
    expect(await guardedArtifact(`${liveArtifact}?bbPluginLoad=7.9#reload`, sourceDetail("relative-root"))).toBe(false);
    expect(await guardedArtifact(`${liveArtifact}?bbPluginLoad=7.9#reload`, {
      requested: "npm:bb-collab",
      resolved: "npm:bb-collab",
      engines: {},
      history: [],
    })).toBe(false);
  });

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
      const scratchHost = createFakePluginHost({ pluginId: "bb-collab" });
      scratchHost.harness.sdk.stub("plugins.getSource", async () => sourceDetail(PROJECT_ROOT));
      expect(await loaded.isLiveCachedConsumerRolloutArtifact(
        pathToFileURL(join(artifactRoot, "server.js")).href,
        scratchHost.bb,
      )).toBe(false);
    } finally {
      rmSync(cleanRoot, { recursive: true, force: true });
    }
  });

  // The inactive candidate keeps every generated bundle in one closed-world
  // artifact without claiming that the host loads it.
  it("includes the app bundle alongside the server artifact candidate", () => {
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "release/release-manifest.json"), "utf8"));
    expect(manifest.files.map(({ path }: { path: string }) => path)).toEqual(expect.arrayContaining([
      "dist/server.js",
      "dist/server.meta.json",
      "dist/app.js",
      "dist/app.meta.json",
      "dist/role-briefs.json",
    ]));

    const appMeta = JSON.parse(readFileSync(join(PROJECT_ROOT, "dist/app.meta.json"), "utf8"));
    const serverMeta = JSON.parse(readFileSync(join(PROJECT_ROOT, "dist/server.meta.json"), "utf8"));
    expect(appMeta.pluginVersion).toBe(serverMeta.pluginVersion);
    expect(appMeta.sdkVersion).toBe(serverMeta.sdkVersion);
  });

  // The build stages into a randomly named temp directory. A release artifact
  // that still names it differs on every rebuild, so a clean candidate would
  // not stay clean.
  it("normalizes the staging path out of every released bundle", () => {
    for (const artifact of ["dist/server.js", "dist/app.js"]) {
      expect(readFileSync(join(PROJECT_ROOT, artifact), "utf8"), artifact).not.toContain("bb-collab-build-");
    }
  });
});
