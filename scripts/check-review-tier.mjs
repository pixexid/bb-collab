import { readFileSync } from "node:fs";
import { visibleMarkdown } from "./pr-lifecycle.mjs";

const eventPath = process.argv[2];
if (!eventPath) throw new Error("usage: check-review-tier.mjs <github-event-path>");

const event = JSON.parse(readFileSync(eventPath, "utf8"));
const body = visibleMarkdown(event.pull_request?.body ?? "");
const files = readFileSync(0, "utf8").split(/\r?\n/u).filter(Boolean);

const declarations = body.match(/^\s*Review tier\s*:\s*([ABC])\s*$/gmu) ?? [];
const declared = declarations.length === 1 ? declarations[0].match(/([ABC])\s*$/u)?.[1] ?? null : null;
const tierA = [
  /^AGENTS\.md$/u,
  /^app\.tsx$/u,
  /^\.github\/workflows\/verify\.yml$/u,
  /^\.github\/workflows\/issue-lifecycle\.yml$/u,
  /^\.github\/workflows\/issue-lifecycle-audit\.yml$/u,
  /(?:^|\/)dist\//u,
  /^docs\/(?:adr\/0001-founding-contract|import-manifest|issue-76-tiered-review-policy|operations-model|threat-model)\.md$/u,
  /^scripts\/build\.mjs$/u,
  /^scripts\/check-pr-lifecycle\.mjs$/u,
  /^scripts\/handle-merged-pr-lifecycle\.mjs$/u,
  /^scripts\/audit-issue-lifecycle\.mjs$/u,
  /^scripts\/audit-issue-lifecycle\.d\.mts$/u,
  /^scripts\/pr-lifecycle\.d\.mts$/u,
  /^scripts\/pr-lifecycle\.mjs$/u,
  /^scripts\/check-review-tier\.mjs$/u,
  /^server\.ts$/u,
  /(?:^|\/|[-_.])(?:authority|approval|atomicity|concurrenc(?:y|ies)|cutover|migrations?|provenance|receipts?|spend)(?:[-_.\/]|$)/iu,
  /(^|\/)foundation\.ts$/u,
];
const tierC = [/^docs\//u, /^tests\//u, /(?:^|\/)(?:README|AGENTS)\.md$/u];
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
  if ({ A: 3, B: 2, C: 1 }[required] > { A: 3, B: 2, C: 1 }[declared]) {
    console.error(`::error::Review finding: declared Tier ${declared}, but touched surfaces require Tier ${required}.`);
    process.exitCode = 1;
  } else {
    console.error(`::warning::Review finding: declared Tier ${declared}, but touched surfaces require Tier ${required}.`);
  }
}

const ruleTier = { A: 3, B: 2, C: 1 }[declared] > { A: 3, B: 2, C: 1 }[required] ? declared : required;
const rule = {
  A: "cold exact-head review before merge",
  B: "local verify and CI before merge; cold review post-merge in parallel",
  C: "local verify and CI only",
}[ruleTier];
console.log(`Review tier ${ruleTier}: ${rule}`);
