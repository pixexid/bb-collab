import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const plugin = process.argv[2] ?? "threads-list";
const stripTrailing = process.argv.includes("--strip-trailing");
const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), `plugins/bb-plugin-${plugin}/dist`);
for (const name of ["app.js", "server.js"]) {
  const path = join(dist, name);
  if (!existsSync(path)) continue;
  const normalized = readFileSync(path, "utf8").replace(new RegExp(`// .*?/plugins/bb-plugin-${plugin}/`, "gu"), "// ");
  writeFileSync(path, stripTrailing ? normalized.replace(/[ \t]+$/gmu, "") : normalized);
}
