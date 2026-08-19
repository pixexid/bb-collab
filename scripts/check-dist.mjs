import { execFileSync } from "node:child_process";

const deployed = process.argv.includes("--deployed");
const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "dist"], { encoding: "utf8" });
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "dist"], { encoding: "utf8" });
const artifacts = [...new Set(`${changed}${untracked}`.trim().split("\n").filter(Boolean))];

if (artifacts.length > 0) {
  for (const artifact of deployed ? [] : artifacts.filter((name) => name.endsWith(".meta.json"))) {
    process.stderr.write(execFileSync("git", ["diff", "--", artifact], { encoding: "utf8" }));
  }
  if (deployed) {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    throw new Error(`deployed dist diverges from committed dist: ${artifacts.join(", ")}; running plugin no longer matches commit ${commit}`);
  }
  throw new Error(`fresh build diverged from committed dist: ${artifacts.join(", ")}`);
}
if (!deployed) console.log("committed dist matches fresh build");
