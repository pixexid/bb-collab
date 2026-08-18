import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifact = process.argv[2] ?? join(root, "dist", "app.css");
const css = readFileSync(artifact, "utf8");
const source = [readFileSync(join(root, "app.tsx"), "utf8"), ...readdirSync(join(root, "src"), { recursive: true })
  .filter((path) => path.endsWith(".ts") || path.endsWith(".tsx"))
  .map((path) => readFileSync(join(root, "src", path), "utf8"))].join("\n");
const sourceTokens = new Set([
  ...source.matchAll(/(["'])([^"']*?)\1/g),
  ...source.matchAll(/`([^`]*)`/g),
].flatMap((match) => match[2] ?? match[1]).flatMap((value) => value.split(/\s+/u).filter(Boolean)));
const leaked = [...css.matchAll(/^\s+\.((?:\\.|[^\\{\s])+?)\s*\{/gmu)]
  .map((match) => match[1].replace(/\\([^\n])/gu, "$1"))
  .filter((className) => !sourceTokens.has(className));
if (leaked.length > 0) {
  throw new Error(`dist/app.css contains classes absent from app.tsx/src: ${leaked.join(", ")}`);
}
