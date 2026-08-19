import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";

const deployed = process.argv.includes("--deployed");
const root = deployed ? deployedRoot() : process.cwd();
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "dist"], { cwd: root, encoding: "utf8" });
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "dist"], { cwd: root, encoding: "utf8" });
const artifacts = [...new Set(`${changed}${untracked}`.trim().split("\n").filter(Boolean))];

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
  let result;
  try {
    result = JSON.parse(execFileSync("bb", ["plugin", "list", "--json"], { encoding: "utf8" }));
  } catch (error) {
    throw new Error(`cannot resolve deployed bb-collab checkout: ${error instanceof Error ? error.message : String(error)}`);
  }
  const matches = Array.isArray(result?.plugins) ? result.plugins.filter((plugin) => plugin?.id === "bb-collab") : [];
  if (matches.length !== 1) throw new Error(`cannot resolve deployed bb-collab checkout: expected one installed plugin, found ${matches.length}`);
  const { rootDir, source } = matches[0];
  if (typeof rootDir !== "string" || !isAbsolute(rootDir) || source !== `path:${rootDir}`) {
    throw new Error("cannot resolve deployed bb-collab checkout: installed plugin is not an absolute path source");
  }
  return rootDir;
}
