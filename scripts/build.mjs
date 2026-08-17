import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { roleBriefBundle } from "./role-brief-bundle.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = mkdtempSync(join(tmpdir(), "bb-collab-build-"));

try {
  for (const name of ["server.ts", "app.tsx", "tsconfig.json", "src", "types", "vendor", "docs"]) {
    cpSync(join(root, name), join(stage, name), { recursive: true });
  }
  writeFileSync(join(stage, "role-briefs.json"), JSON.stringify(roleBriefBundle(stage)));
  symlinkSync(join(root, "node_modules"), join(stage, "node_modules"), "dir");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  manifest.bb.server = "./server.ts";
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync("bb", ["plugin", "build", stage], { stdio: "inherit" });
  cpSync(join(stage, "dist"), join(root, "dist"), { recursive: true });
  cpSync(join(stage, "role-briefs.json"), join(root, "dist", "role-briefs.json"));
  // Every tracked artifact names its entry through the throwaway staging
  // directory, so both need the same rewrite or a rebuild churns a committed
  // bundle on nothing but a random temp name.
  const stagedEntryComment = /\/\/ .*?bb-collab-build-[^/]+\/(?=(?:server\.ts|app\.tsx|src\/))/gu;
  for (const artifact of ["dist/server.js", "dist/app.js"]) {
    const artifactPath = join(root, artifact);
    writeFileSync(
      artifactPath,
      readFileSync(artifactPath, "utf8")
        .replace(stagedEntryComment, "// ")
        .replace(/[ \t]+$/gmu, ""),
    );
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
