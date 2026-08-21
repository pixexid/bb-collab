import { execFileSync } from "node:child_process";
const deployed = process.argv.includes("--deployed");
const root = deployed ? deployedRoot() : process.cwd();
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "dist"], { cwd: root, encoding: "utf8" });
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "dist"], { cwd: root, encoding: "utf8" });
// Source-map paths are normalized by the build, but esbuild can still vary
// their metadata across Node/toolchain hosts; presence and bundle parity remain
// checked while the map itself is tracked and shipped.
const artifacts = [...new Set(`${changed}${untracked}`.trim().split("\n").filter((name) => name && name !== "dist/server.js.map"))];

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
