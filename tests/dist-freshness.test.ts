import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, manifestFor, verifyRelease } from "../scripts/release-artifact.mjs";

const script = join(process.cwd(), "scripts/release-artifact.mjs");

function fixture(nested = false) {
  const root = mkdtempSync(join(tmpdir(), "bb-collab-release-"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    scripts: { build: "node -e 0" },
    ...(nested ? { workspaces: ["plugins/*"] } : {}),
  }));
  writeFileSync(join(root, "dist/server.js"), 'import { defineRpcContract } from "@bb/plugin-sdk";\nexport default defineRpcContract;\n');
  const writeSdk = (name: string) => {
    const sdkRoot = join(root, "node_modules", ...name.split("/"));
    mkdirSync(join(sdkRoot, "dist"), { recursive: true });
    writeFileSync(join(sdkRoot, "package.json"), JSON.stringify({ name, version: "0.4.21", type: "module", exports: { ".": "./dist/index.js" } }));
    writeFileSync(join(sdkRoot, "dist/index.js"), "export const defineRpcContract = {};\n");
  };
  writeSdk("@bb/plugin-sdk");
  if (nested) {
    mkdirSync(join(root, "plugins/current/dist"), { recursive: true });
    writeFileSync(join(root, "plugins/current/package.json"), JSON.stringify({ scripts: { build: "node -e 0" } }));
    writeFileSync(join(root, "plugins/current/dist/server.js"), 'import { defineRpcContract } from "@get-bb/plugin-sdk";\nexport default defineRpcContract;\n');
    writeSdk("@get-bb/plugin-sdk");
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const manifest = manifestFor(root, commit, root);
  const manifestPath = join(root, "release-manifest.json");
  writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`);
  return { root, manifestPath };
}

describe("release artifact gate", () => {
  it("keeps generated output outside source authority", () => {
    const tracked = execFileSync("git", ["ls-files", "dist/**", "plugins/*/dist/**"], { encoding: "utf8" });
    expect(tracked).toBe("");
    expect(JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).scripts.verify).not.toContain("check-dist.mjs");
  });

  it("refuses an ambient release toolchain", () => {
    const bin = mkdtempSync(join(tmpdir(), "bb-collab-ambient-bb-"));
    try {
      const bb = join(bin, "bb");
      writeFileSync(bb, "#!/bin/sh\necho 0.39.0\n");
      chmodSync(bb, 0o755);
      const result = spawnSync(process.execPath, [script, "build"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, BB_COLLAB_RELEASE_PINNED: "1", PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("release build requires Node v22.23.1 and bb 0.40.0");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("accepts matching bytes and rejects a stale artifact independently", () => {
    const { root, manifestPath } = fixture();
    try {
      expect(verifyRelease(root, manifestPath, root).releaseDigest).toMatch(/^[0-9a-f]{64}$/u);
      writeFileSync(join(root, "dist/server.js"), "stale bytes\n");
      expect(() => verifyRelease(root, manifestPath, root)).toThrow("release artifact digest mismatch: dist/server.js");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a dirty exact-source checkout", () => {
    const { root, manifestPath } = fixture();
    try {
      const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      packageJson.description = "dirty tracked source";
      writeFileSync(join(root, "package.json"), JSON.stringify(packageJson));
      expect(() => verifyRelease(root, manifestPath, root)).toThrow("release source checkout has tracked changes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const name of ["@bb/plugin-sdk", "@get-bb/plugin-sdk"] as const) {
    it(`refuses old SDK bytes behind ${name}`, () => {
      const { root } = fixture(true);
      try {
        const path = join(root, "node_modules", ...name.split("/"), "package.json");
        const dependency = JSON.parse(readFileSync(path, "utf8"));
        dependency.version = "0.4.8";
        writeFileSync(path, JSON.stringify(dependency));
        expect(() => manifestFor(root, undefined, root)).toThrow(`release runtime closure ${name} does not match the pinned plugin SDK`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("binds schema v2 to an inactive sorted closed-world artifact inventory", () => {
    const { root, manifestPath } = fixture(true);
    try {
      const manifest = verifyRelease(root, manifestPath, root);
      expect(manifest).toMatchObject({
        version: 2,
        loadAuthority: "inactive",
        artifactRoots: ["dist", "plugins/current/dist"],
        runtimeExternals: [
          { entry: "dist/server.js", specifiers: ["@bb/plugin-sdk"] },
          { entry: "plugins/current/dist/server.js", specifiers: ["@get-bb/plugin-sdk"] },
        ],
      });
      expect(manifest.files.map(({ path }) => path)).toEqual([
        "dist/server.js",
        "node_modules/@bb/plugin-sdk/dist/index.js",
        "node_modules/@bb/plugin-sdk/package.json",
        "node_modules/@get-bb/plugin-sdk/dist/index.js",
        "node_modules/@get-bb/plugin-sdk/package.json",
        "plugins/current/dist/server.js",
      ]);
      const { releaseDigest: _releaseDigest, ...payload } = manifest;
      expect(manifest.releaseDigest).toBe(createHash("sha256").update(canonicalJson(payload)).digest("hex"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an extra file beneath a declared root", () => {
    const { root, manifestPath } = fixture();
    try {
      writeFileSync(join(root, "dist/obsolete.js"), "unmanifested\n");
      expect(() => verifyRelease(root, manifestPath, root)).toThrow("release artifact file set does not match its manifest");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const sdk of ["@bb/plugin-sdk", "@get-bb/plugin-sdk"] as const) {
    it(`generation refuses a missing ${sdk} closure file`, () => {
      const { root } = fixture(sdk === "@get-bb/plugin-sdk");
      try {
        rmSync(join(root, "node_modules", ...sdk.split("/"), "dist/index.js"));
        expect(() => manifestFor(root, undefined, root)).toThrow("runtime external is missing from candidate closure");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("verification refuses an extra unmanifested closure file", () => {
    const { root, manifestPath } = fixture();
    try {
      writeFileSync(join(root, "node_modules/@bb/plugin-sdk/extra.js"), "unmanifested\n");
      expect(() => verifyRelease(root, manifestPath, root)).toThrow("release runtime closure file set does not match its imports");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verification refuses source node_modules fallback", () => {
    const { root, manifestPath } = fixture();
    const closure = join(root, "node_modules");
    const sourceModules = join(root, "source-node_modules");
    try {
      renameSync(closure, sourceModules);
      symlinkSync(sourceModules, closure, "dir");
      expect(() => verifyRelease(root, manifestPath, root)).toThrow("release closure contains a mutable or unsupported entry");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verification refuses omission of a nested plugin external", () => {
    const { root, manifestPath } = fixture(true);
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.runtimeExternals[1].specifiers = [];
      const { releaseDigest: _releaseDigest, ...payload } = manifest;
      manifest.releaseDigest = createHash("sha256").update(canonicalJson(payload)).digest("hex");
      writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`);
      expect(() => verifyRelease(root, manifestPath, root)).toThrow("release runtime external inventory does not match server entries");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a source map beneath a declared root", () => {
    const { root, manifestPath } = fixture();
    try {
      writeFileSync(join(root, "dist/server.js.map"), "unmanifested\n");
      expect(() => verifyRelease(root, manifestPath, root)).toThrow("unmanifested release file: dist/server.js.map");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an orphan artifact root before manifest generation", () => {
    const { root } = fixture();
    try {
      mkdirSync(join(root, "plugins/old/dist"), { recursive: true });
      writeFileSync(join(root, "plugins/old/dist/server.js"), "orphan\n");
      expect(() => manifestFor(root, undefined, root)).toThrow("undeclared artifact root: plugins/old/dist");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an empty orphan artifact root before manifest generation", () => {
    const { root } = fixture();
    try {
      mkdirSync(join(root, "plugins/old/dist"), { recursive: true });
      expect(() => manifestFor(root, undefined, root)).toThrow("undeclared artifact root: plugins/old/dist");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an orphan artifact root added after manifest generation", () => {
    const { root, manifestPath } = fixture();
    try {
      mkdirSync(join(root, "plugins/old/dist"), { recursive: true });
      writeFileSync(join(root, "plugins/old/dist/server.js"), "orphan\n");
      expect(() => verifyRelease(root, manifestPath, root)).toThrow("undeclared artifact root: plugins/old/dist");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a removed package whose dist root remains", () => {
    const { root } = fixture(true);
    try {
      rmSync(join(root, "plugins/current/package.json"));
      expect(() => manifestFor(root, undefined, root)).toThrow("undeclared artifact root: plugins/current/dist");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a missing declared artifact root", () => {
    const { root } = fixture(true);
    try {
      rmSync(join(root, "plugins/current/dist"), { recursive: true, force: true });
      expect(() => manifestFor(root, undefined, root)).toThrow("missing artifact root: plugins/current/dist");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an empty declared artifact root", () => {
    const { root } = fixture(true);
    try {
      rmSync(join(root, "plugins/current/dist"), { recursive: true, force: true });
      mkdirSync(join(root, "plugins/current/dist"));
      expect(() => manifestFor(root, undefined, root)).toThrow("empty artifact root: plugins/current/dist");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a missing inactive authority marker", () => {
    const { root, manifestPath } = fixture();
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      delete manifest.loadAuthority;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(() => verifyRelease(root, manifestPath, root)).toThrow("invalid release manifest fields");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a changed inactive authority marker", () => {
    const { root, manifestPath } = fixture();
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.loadAuthority = "active";
      writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(() => verifyRelease(root, manifestPath, root)).toThrow("release manifest loadAuthority must be inactive");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const [name, mutate] of [
    ["duplicate artifact root", (manifest: any) => manifest.artifactRoots.push(manifest.artifactRoots[0])],
    ["traversal path", (manifest: any) => { manifest.files[0].path = "dist/../server.js"; }],
    ["ambient manifest toolchain", (manifest: any) => { manifest.toolchain.bbVersion = "ambient"; }],
    ["changed manifest digest", (manifest: any) => { manifest.releaseDigest = "0".repeat(64); }],
  ] as const) {
    it(`refuses a ${name}`, () => {
      const { root, manifestPath } = fixture();
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        mutate(manifest);
        writeFileSync(manifestPath, JSON.stringify(manifest));
        expect(() => verifyRelease(root, manifestPath, root)).toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("rejects a release manifest from another source commit", () => {
    const { root, manifestPath } = fixture();
    try {
      writeFileSync(join(root, "source.txt"), "new source\n");
      execFileSync("git", ["add", "source.txt"], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "move source"], { cwd: root });
      expect(() => verifyRelease(root, manifestPath, root)).toThrow(/does not match source commit/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
