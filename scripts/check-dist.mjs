import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const deployed = process.argv.includes("--deployed");
const root = deployed ? deployedRoot() : process.cwd();
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const tracked = gitLines(["ls-files", "-z"]);
const trackedDist = tracked.filter(isDistPath);
const trackedMaps = trackedDist.filter((name) => name.endsWith(".map"));
if (trackedMaps.length > 0) {
  throw new Error(`generated source maps must not be tracked: ${trackedMaps.join(", ")}`);
}

if (!deployed) rebuildWorkspaceBundles(trackedDist);

const changed = gitLines(["diff", "--name-only", "-z", "HEAD"]);
const untracked = gitLines(["ls-files", "--others", "--exclude-standard", "-z"]);
const artifacts = [...new Set([...changed, ...untracked].filter(isDistPath))];

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

function gitLines(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function isDistPath(name) {
  return name === "dist" || name.startsWith("dist/") || name.includes("/dist/");
}

function rebuildWorkspaceBundles(files) {
  const packages = new Set();
  for (const file of files) {
    let directory = join(root, dirname(file));
    while (directory.startsWith(root) && directory !== root) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest)) {
        if (directory !== root) packages.add(directory);
        break;
      }
      directory = dirname(directory);
    }
  }
  for (const directory of packages) {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (!manifest.scripts?.build) {
      throw new Error(`cannot verify ${relative(root, directory)}/dist: package has no build script`);
    }
    console.log(`rebuilding ${relative(root, directory)}/dist to verify committed artifacts`);
    execFileSync("npm", ["run", "build"], { cwd: directory, stdio: "inherit" });
  }
}

function deployedRoot() {
  return process.cwd();
}
