import { execFileSync } from "node:child_process";

const changed = execFileSync("git", ["diff", "--name-only", "--", "dist"], { encoding: "utf8" });
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "dist"], { encoding: "utf8" });
const artifacts = [...new Set(`${changed}${untracked}`.trim().split("\n").filter(Boolean))];

if (artifacts.length > 0) {
  for (const artifact of artifacts.filter((name) => name.endsWith(".meta.json"))) {
    process.stderr.write(execFileSync("git", ["diff", "--", artifact], { encoding: "utf8" }));
  }
  throw new Error(`fresh build diverged from committed dist: ${artifacts.join(", ")}`);
}
console.log("committed dist matches fresh build");
