import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { roleBriefBundle } from "./role-brief-bundle.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = mkdtempSync(join(tmpdir(), "bb-collab-build-"));

try {
  for (const name of ["server.ts", "app.tsx", "tsconfig.json", "assets", "src", "types", "vendor"]) {
    cpSync(join(root, name), join(stage, name), { recursive: true });
  }
  writeFileSync(join(stage, "role-briefs.json"), JSON.stringify(roleBriefBundle(root)));
  writeFileSync(join(stage, ".gitignore"), "role-briefs.json\nserver.ts\ntsconfig.json\ntypes/\nvendor/\n");
  symlinkSync(join(root, "node_modules"), join(stage, "node_modules"), "dir");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  manifest.bb.server = "./server.ts";
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync("bb", ["plugin", "build", stage], { cwd: stage, stdio: "inherit" });
  rmSync(join(root, "dist"), { recursive: true, force: true });
  cpSync(join(stage, "dist"), join(root, "dist"), { recursive: true });
  cpSync(join(stage, "role-briefs.json"), join(root, "dist", "role-briefs.json"));
  // Every tracked artifact names its entry through the throwaway staging
  // directory, so both need the same rewrite or a rebuild churns a committed
  // bundle on nothing but a random temp name.
  const stagedEntryComment = /\/\/ .*?bb-collab-build-[^/]+\/(?=(?:server\.ts|app\.tsx|src\/))/gu;
  for (const artifact of ["dist/server.js", "dist/app.js"]) {
    const artifactPath = join(root, artifact);
    const normalized = readFileSync(artifactPath, "utf8")
      .replace(stagedEntryComment, "// ")
      .replace(/^\/\/ .*?\/node_modules\//gmu, "// node_modules/")
      .replace(/[ \t]+$/gmu, "");
    if (/^\/\/ .*?\/node_modules\//mu.test(normalized)) {
      throw new Error(`${artifact} contains an unnormalized node_modules path comment`);
    }
    writeFileSync(artifactPath, normalized);
  }
  const sourceMapPath = join(root, "dist/server.js.map");
  const sourceMap = JSON.parse(readFileSync(sourceMapPath, "utf8"));
  sourceMap.sources = sourceMap.sources.map((source) => source
    .replace(/^.*?bb-collab-build-[^/]+\//u, "")
    .replace(/^.*?node_modules\//u, "node_modules/"));
  writeFileSync(sourceMapPath, `${JSON.stringify(sourceMap)}\n`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
