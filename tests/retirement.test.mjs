import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const retired = [
  "server.ts",
  "app.tsx",
  "src",
  "launchd",
  "plugins/bb-plugin-companion-watcher",
  "plugins/bb-plugin-exec-tracking",
  "plugins/bb-plugin-lanes",
  "plugins/bb-plugin-operator-inbox",
];

function hasFiles(path) {
  if (!existsSync(path)) return false;
  return readdirSync(path, { withFileTypes: true }).some((entry) =>
    entry.isFile() || hasFiles(`${path}/${entry.name}`));
}

test("the governor and every coupled runtime are absent", () => {
  assert.deepEqual(retired.filter((path) => existsSync(path) && (path.includes(".") || hasFiles(path))), []);
  assert.equal(JSON.parse(readFileSync("package.json", "utf8")).bb, undefined);
  assert.deepEqual(
    JSON.parse(readFileSync("marketplace.json", "utf8")).plugins.map(({ id }) => id),
    ["threads-list"],
  );
  assert.deepEqual(
    JSON.parse(readFileSync(".bb/plugins.json", "utf8")).plugins.map(({ name }) => name),
    ["threads-list"],
  );
  assert.equal(readFileSync("plugins/bb-plugin-threads-list/server.ts", "utf8").includes("bb-collab"), false);
});
