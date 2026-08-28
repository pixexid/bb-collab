import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, manifestFor } from "../scripts/release-artifact.mjs";

describe("deployed release automation", () => {
  it("reports divergent deployed bytes through the production checker", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-collab-deployed-release-"));
    try {
      mkdirSync(join(root, "dist"));
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "node -e 0" } }));
      writeFileSync(join(root, "dist/server.js"), "release bytes\n");
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      writeFileSync(join(root, ".bb-collab-release.json"), `${canonicalJson(manifestFor(root, commit))}\n`);
      writeFileSync(join(root, "dist/server.js"), "divergent\n");

      const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/check-dist.mjs"), "--deployed"], { cwd: root, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("release artifact digest mismatch: dist/server.js");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
