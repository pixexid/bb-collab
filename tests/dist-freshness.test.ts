import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, manifestFor, verifyRelease } from "../scripts/release-artifact.mjs";

const script = join(process.cwd(), "scripts/release-artifact.mjs");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bb-collab-release-"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "node -e 0" } }));
  writeFileSync(join(root, "dist/server.js"), "release bytes\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const manifest = manifestFor(root, commit);
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
      writeFileSync(bb, "#!/bin/sh\necho 0.40.0\n");
      chmodSync(bb, 0o755);
      const result = spawnSync(process.execPath, [script, "build"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, BB_COLLAB_RELEASE_PINNED: "1", PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("release build requires Node v22.23.1 and bb 0.39.0");
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

  it("rejects a release manifest from another source commit", () => {
    const { root, manifestPath } = fixture();
    try {
      writeFileSync(join(root, "source.txt"), "new source\n");
      execFileSync("git", ["add", "source.txt"], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "move source"], { cwd: root });
      expect(() => verifyRelease(root, manifestPath, root)).toThrow(/does not match deployed commit/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
