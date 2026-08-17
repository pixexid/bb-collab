import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = {
  ponytail: "docs/ponytail.md",
  roles: {
    director: "docs/roles/director.md",
    orchestrator: "docs/roles/orchestrator.md",
    worker: "docs/roles/worker.md",
  },
};

export function roleBriefBundle(directory = root) {
  return {
    ponytail: readFileSync(join(directory, files.ponytail), "utf8"),
    roles: Object.fromEntries(Object.entries(files.roles).map(([role, path]) => [role, readFileSync(join(directory, path), "utf8")])),
  };
}

export function assertRoleBriefBundle(directory = root, artifact = join(directory, "dist", "role-briefs.json")) {
  const expected = JSON.stringify(roleBriefBundle(directory));
  const actual = readFileSync(artifact, "utf8").trim();
  if (actual !== expected) throw new Error("role brief bundle differs from canonical docs; rebuild before shipping");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) assertRoleBriefBundle(root, process.argv[2]);
