import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
describe("deployed release automation", () => {
  it("refuses inactive release candidates as deployed authority", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-collab-deployed-release-"));
    try {
      const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/check-dist.mjs"), "--deployed"], { cwd: root, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("release candidate is inactive: loaded-authority activation is owned by #423");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
