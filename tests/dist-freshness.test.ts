import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/check-dist.mjs");

describe("dist freshness gate", () => {
  it("makes verify reject a divergent committed bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-collab-verify-dist-"));
    try {
      mkdirSync(join(root, "dist"));
      mkdirSync(join(root, "scripts"));
      writeFileSync(join(root, "dist/app.js"), "committed\n");
      writeFileSync(join(root, "scripts/check-css-bundle.mjs"), "");
      writeFileSync(join(root, "scripts/role-brief-bundle.mjs"), "");
      copyFileSync(script, join(root, "scripts/check-dist.mjs"));
      const { verify } = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).scripts;
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "node -e 0", test: "node -e 0", build: "node -e 0", verify } }));
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });

      writeFileSync(join(root, "dist/app.js"), "divergent\n");
      const result = spawnSync("npm", ["run", "verify"], { cwd: root, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fresh build diverged from committed dist: dist/app.js");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes an honest artifact and names a hand-edited artifact when it fails", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-collab-dist-freshness-"));
    try {
      mkdirSync(join(root, "dist"));
      writeFileSync(join(root, "dist/server.js"), "honest\n");
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      execFileSync("git", ["add", "dist/server.js"], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
      const sourceRoot = join(root, "source-checkout");
      const bin = join(root, "bin");
      mkdirSync(sourceRoot);
      mkdirSync(bin);
      const bb = join(bin, "bb");
      const writePluginList = (plugins: unknown[]) => {
        writeFileSync(bb, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ plugins }))});\n`);
        chmodSync(bb, 0o755);
      };
      writePluginList([{ id: "bb-collab", rootDir: root, source: `path:${root}` }]);
      const deployedEnvironment = { ...process.env, PATH: `${bin}:${process.env.PATH}` };

      const honest = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
      expect(honest.status).toBe(0);
      expect(honest.stdout).toContain("committed dist matches fresh build");

      const deployedHonest = spawnSync(process.execPath, [script, "--deployed"], { cwd: sourceRoot, encoding: "utf8", env: deployedEnvironment });
      expect(deployedHonest.status).toBe(0);
      expect(deployedHonest.stdout).toBe("");
      expect(deployedHonest.stderr).toBe("");

      writeFileSync(join(root, "dist/server.js"), "hand edited\n");
      const stale = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("dist/server.js");

      execFileSync("git", ["add", "dist/server.js"], { cwd: root });
      const deployedStale = spawnSync(process.execPath, [script, "--deployed"], { cwd: sourceRoot, encoding: "utf8", env: deployedEnvironment });
      expect(deployedStale.status).toBe(1);
      expect(deployedStale.stderr).toContain(`deployed dist at ${root} diverges from committed dist: dist/server.js`);
      expect(deployedStale.stderr).toContain("running plugin no longer matches commit");

      writePluginList([]);
      const unresolved = spawnSync(process.execPath, [script, "--deployed"], { cwd: sourceRoot, encoding: "utf8", env: deployedEnvironment });
      expect(unresolved.status).toBe(1);
      expect(unresolved.stderr).toContain("cannot resolve deployed bb-collab checkout: expected one installed plugin, found 0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
