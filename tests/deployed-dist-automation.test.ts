import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

describe("deployed dist automation", () => {
  it("reports divergent deployed dist from the checkout filesystem", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-collab-deployed-dist-"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/server.js"), "committed\n");
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "Test");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "fixture");
    writeFileSync(join(root, "dist/server.js"), "divergent\n");
    try {
      const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/check-dist.mjs"), "--deployed"], { cwd: root, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("deployed working tree dist/");
      expect(result.stderr).toContain("dist/server.js");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
