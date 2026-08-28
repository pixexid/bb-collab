import { join, resolve } from "node:path";
import { verifyRelease } from "./release-artifact.mjs";

const root = process.cwd();
const deployed = process.argv.includes("--deployed");
const releaseIndex = process.argv.indexOf("--release");
if (!deployed && releaseIndex < 0) throw new Error("usage: check-dist.mjs --deployed | --release <directory>");

if (deployed) throw new Error("release candidate is inactive: loaded-authority activation is owned by #423");
else {
  const directory = resolve(process.argv[releaseIndex + 1] ?? "");
  verifyRelease(directory, join(directory, "release-manifest.json"), root);
}
