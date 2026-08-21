import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      expect(result.stderr).toContain("working tree dist/ differs from commit");
      expect(result.stderr).toContain("dist/app.js");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not ignore a force-tracked source map", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-collab-dist-map-"));
    try {
      mkdirSync(join(root, "dist"));
      writeFileSync(join(root, "dist/server.js.map"), "map\n");
      writeFileSync(join(root, ".gitignore"), "dist/*\n");
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      execFileSync("git", ["add", ".gitignore"], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
      execFileSync("git", ["add", "-f", "dist/server.js.map"], { cwd: root });
      writeFileSync(join(root, "dist/server.js.map"), "changed map\n");
      const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dist/server.js.map");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a committed source-only change when a nested bundle is not rebuilt", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-collab-nested-dist-"));
    const packageRoot = join(root, "packages", "nested");
    try {
      mkdirSync(join(packageRoot, "src"), { recursive: true });
      mkdirSync(join(packageRoot, "dist"));
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ scripts: { build: "node build.mjs" } }));
      writeFileSync(join(packageRoot, "build.mjs"), [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'const source = readFileSync("src/message.txt", "utf8");',
        'writeFileSync("dist/bundle.js", `export default ${JSON.stringify(source)};\\n`);',
        "",
      ].join("\n"));
      writeFileSync(join(packageRoot, "src/message.txt"), "first\n");
      execFileSync("npm", ["run", "build", "--silent"], { cwd: packageRoot });
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });

      writeFileSync(join(packageRoot, "src/message.txt"), "second\n");
      execFileSync("git", ["add", "packages/nested/src/message.txt"], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "source-only change"], { cwd: root });

      const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("packages/nested/dist/bundle.js");
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
      mkdirSync(sourceRoot);

      const honest = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
      expect(honest.status).toBe(0);
      expect(honest.stdout).toContain("working tree dist/ matches commit");

      const deployedHonest = spawnSync(process.execPath, [script, "--deployed"], { cwd: root, encoding: "utf8" });
      expect(deployedHonest.status).toBe(0);
      expect(deployedHonest.stdout).toBe("");
      expect(deployedHonest.stderr).toBe("");

      writeFileSync(join(root, "dist/server.js"), "hand edited\n");
      const stale = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("dist/server.js");

      execFileSync("git", ["add", "dist/server.js"], { cwd: root });
      const deployedStale = spawnSync(process.execPath, [script, "--deployed"], { cwd: root, encoding: "utf8" });
      expect(deployedStale.status).toBe(1);
      expect(deployedStale.stderr).toContain("deployed working tree dist/");
      expect(deployedStale.stderr).toContain("dist/server.js");

      const cleanRoot = join(root, "clean-checkout");
      mkdirSync(join(cleanRoot, "dist"), { recursive: true });
      writeFileSync(join(cleanRoot, "dist/server.js"), "clean\n");
      execFileSync("git", ["init", "--quiet"], { cwd: cleanRoot });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: cleanRoot });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: cleanRoot });
      execFileSync("git", ["add", "."], { cwd: cleanRoot });
      execFileSync("git", ["commit", "--quiet", "-m", "clean"], { cwd: cleanRoot });
      const redirected = spawnSync(process.execPath, [script, "--deployed"], { cwd: root, encoding: "utf8", env: { ...process.env, BB_COLLAB_DEPLOYED_ROOT: cleanRoot } });
      expect(redirected.status).toBe(1);
      expect(redirected.stderr).toContain("deployed working tree dist/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
