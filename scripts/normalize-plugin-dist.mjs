import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), "plugins/bb-plugin-threads-list/dist");
for (const name of ["app.js", "server.js"]) {
  const path = join(dist, name);
  writeFileSync(path, readFileSync(path, "utf8").replace(/\/\/ .*?\/plugins\/bb-plugin-threads-list\//gu, "// "));
}
