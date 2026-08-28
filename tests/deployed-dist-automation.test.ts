import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
describe("deployed release automation", () => {
  it("refuses deployment without an active host-local receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-collab-deployed-release-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      const bb = join(bin, "bb");
      writeFileSync(bb, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ dataDir: join(root, "bb-data") })}'\n`);
      chmodSync(bb, 0o755);
      const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/check-dist.mjs"), "--deployed"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("active deployment receipt is unavailable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
