import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("plugins/bb-plugin-threads-list/package.json", "utf8"));
const tag = `threads-list/v${version}`;
const legacy = `bb-plugin-threads-list@${version}`;
try {
  execFileSync("git", ["tag", "-d", legacy], { stdio: "ignore" });
} catch {}
execFileSync("git", ["tag", tag]);
console.log(`Created ${tag}`);
