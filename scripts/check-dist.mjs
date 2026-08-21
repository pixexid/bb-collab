import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
const deployed = process.argv.includes("--deployed");
const root = deployed ? deployedRoot() : process.cwd();
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "dist"], { cwd: root, encoding: "utf8" })
  .trim().split("\n").filter(Boolean);
// Source-map contents can include host/toolchain metadata: ignore content changes, but not presence.
const contentChanges = changed.filter((name) => !name.endsWith(".map"));
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "dist"], { cwd: root, encoding: "utf8" });
const tracked = execFileSync("git", ["ls-files", "--", "dist"], { cwd: root, encoding: "utf8" });
const missing = tracked.trim().split("\n").filter((name) => name && !existsSync(join(root, name)));
const artifacts = [...new Set(`${contentChanges.join("\n")}\n${untracked}\n${missing.join("\n")}`.trim().split("\n").filter(Boolean))];

if (artifacts.length > 0) {
  for (const artifact of deployed ? [] : artifacts.filter((name) => name.endsWith(".meta.json"))) {
    process.stderr.write(execFileSync("git", ["diff", "--", artifact], { cwd: root, encoding: "utf8" }));
  }
  if (deployed) {
    throw new Error(`deployed working tree dist/ at ${root} differs from commit ${commit}: ${artifacts.join(", ")}`);
  }
  throw new Error(`working tree dist/ differs from commit ${commit}: ${artifacts.join(", ")}`);
}
if (!deployed) console.log(`working tree dist/ matches commit ${commit}`);

function deployedRoot() {
  return process.cwd();
}
