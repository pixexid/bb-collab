import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { defaultStateDirectory, verifyActiveReceipt } from "./activate-release.mjs";
import { verifyRelease } from "./release-artifact.mjs";

const root = process.cwd();
const deployed = process.argv.includes("--deployed");
const releaseIndex = process.argv.indexOf("--release");
if (!deployed && releaseIndex < 0) throw new Error("usage: check-dist.mjs --deployed | --release <directory>");

if (deployed) {
  const status = JSON.parse(execFileSync("bb", ["status", "--json"], { encoding: "utf8" }));
  verifyActiveReceipt({ stateDirectory: defaultStateDirectory(status.dataDir) });
}
else {
  const directory = resolve(process.argv[releaseIndex + 1] ?? "");
  verifyRelease(directory, join(directory, "release-manifest.json"), root);
}
