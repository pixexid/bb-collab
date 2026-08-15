import { readFileSync } from "node:fs";

const eventPath = process.argv[2];
if (!eventPath) throw new Error("usage: check-review-tier.mjs <github-event-path>");

const event = JSON.parse(readFileSync(eventPath, "utf8"));
const body = event.pull_request?.body ?? "";
const files = readFileSync(0, "utf8").split(/\r?\n/u).filter(Boolean);

const declarations = body.match(/^\s*Review tier\s*:\s*([ABC])\s*$/gmu) ?? [];
const declared = declarations.length === 1 ? declarations[0].match(/([ABC])\s*$/u)?.[1] ?? null : null;
const tierA = [
  /^AGENTS\.md$/u,
  /^\.github\/workflows\/verify\.yml$/u,
  /^docs\/(?:adr\/0001-founding-contract|issue-76-tiered-review-policy|operations-model|roadmap)\.md$/u,
  /^scripts\/check-review-tier\.mjs$/u,
  /(^|\/)(?:authority|approval|atomicity|concurrency|cutover|migration|provenance|receipt|spend)(?:[-_.\/]|$)/iu,
  /(^|\/)foundation\.ts$/u,
];
const tierC = [/^docs\//u, /^tests\//u, /(?:^|\/)(?:README|AGENTS)\.md$/u, /^dist\//u];
const required = files.some((file) => tierA.some((pattern) => pattern.test(file)))
  ? "A"
  : files.length > 0 && files.every((file) => tierC.some((pattern) => pattern.test(file)))
    ? "C"
    : "B";

if (declared === null) {
  console.error("::error::Every pull request body must declare exactly one `Review tier: A`, `Review tier: B`, or `Review tier: C`.");
  process.exit(1);
}

if (declared !== required) {
  console.error(`::warning::Review finding: declared Tier ${declared}, but touched surfaces require Tier ${required}.`);
}

const rule = {
  A: "cold exact-head review before merge",
  B: "local verify and CI before merge; cold review post-merge in parallel",
  C: "local verify and CI only",
}[declared];
console.log(`Review tier ${declared}: ${rule}`);
