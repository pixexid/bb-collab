#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { visibleMarkdown } from "./pr-lifecycle.mjs";
import { renderWeeklyThroughputReport, weeklyThroughputReport } from "../src/throughput-report.ts";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);

const required = (name) => {
  const value = args.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const timestamp = (name) => {
  const value = Date.parse(required(name));
  if (!Number.isFinite(value)) throw new Error(`${name} must be an ISO-8601 timestamp`);
  return value;
};
const quote = (value) => /[^A-Za-z0-9_./:=@-]/u.test(value) ? JSON.stringify(value) : value;
const command = (parts) => parts.map(quote).join(" ");
const ghJson = (ghArgs) => JSON.parse(execFileSync("gh", ghArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
const tier = (body) => {
  const declarations = visibleMarkdown(body ?? "").match(/^\s*Review tier\s*:\s*([ABC])\s*$/gmu) ?? [];
  return declarations.length === 1 ? declarations[0].match(/([ABC])\s*$/u)?.[1] ?? null : null;
};

const repo = required("--repo");
const startAtMs = timestamp("--start");
const endAtMs = timestamp("--end");
const dialsLandedAtMs = timestamp("--dials-landed-at");
if (startAtMs >= endAtMs) throw new Error("--start must be before --end");

const outlierValues = [args.get("--outlier-label"), args.get("--outlier-start"), args.get("--outlier-end")];
if (outlierValues.some(Boolean) && !outlierValues.every(Boolean)) throw new Error("outlier label, start, and end must be supplied together");
const outlierCohorts = outlierValues.every(Boolean)
  ? [{ label: outlierValues[0], startAtMs: Date.parse(outlierValues[1]), endAtMs: Date.parse(outlierValues[2]) }]
  : [];
if (outlierCohorts.some((cohort) => !Number.isFinite(cohort.startAtMs) || !Number.isFinite(cohort.endAtMs) || cohort.startAtMs >= cohort.endAtMs)) {
  throw new Error("outlier bounds must be valid increasing ISO-8601 timestamps");
}

const issueArgs = ["issue", "list", "--repo", repo, "--state", "all", "--limit", "1000", "--json", "number,createdAt,closedAt,state"];
const mergeArgs = ["pr", "list", "--repo", repo, "--state", "merged", "--limit", "1000", "--json", "number,mergedAt,body,title"];
const labelArgs = ["label", "list", "--repo", repo, "--limit", "1000", "--json", "name"];
const reviewArgs = ["api", `repos/${repo}/pulls/338/reviews`];
const issues = ghJson(issueArgs).map((issue) => ({
  id: `#${issue.number}`,
  openedAtMs: Date.parse(issue.createdAt),
  closedAtMs: issue.closedAt === null ? null : Date.parse(issue.closedAt),
  githubState: issue.state === "OPEN" ? "open" : issue.state === "CLOSED" ? "closed" : "unknown",
}));
const pulls = ghJson(mergeArgs).map((pull) => ({
  id: `#${pull.number}`,
  mergedAtMs: pull.mergedAt === null ? null : Date.parse(pull.mergedAt),
  tier: tier(pull.body),
  title: pull.title,
}));
const labels = ghJson(labelArgs).map((label) => label.name.toLowerCase());
ghJson(reviewArgs);

const report = weeklyThroughputReport({
  dialsLandedAtMs,
  issues,
  merges: pulls,
  reviews: [],
  defects: pulls
    .filter((pull) => pull.mergedAtMs !== null && pull.mergedAtMs >= startAtMs && pull.mergedAtMs < endAtMs)
    .map((pull) => ({ id: pull.id, reverted: /^revert(?:\b|:)/iu.test(pull.title) ? true : null, postMergeSeverity: null })),
  outlierCohorts,
  unknownReasons: {
    laneSlotUtilization: "PR #338 emits zero-lane and blind episodes but does not persist full-cap intervals; startability must not be recomputed",
    reviewLatency: "BB review threads are not canonically linked to pull requests; GitHub PR #338 review evidence is empty",
    reverts: "only explicit revert-titled merged pull requests are observable; manual rollback coverage is unknown",
    postMergeSeverity: labels.some((label) => label === "p0" || label === "p1")
      ? "P0/P1 labels exist but post-merge culprit-PR linkage is not canonical"
      : "GitHub has no P0/P1 label convention and no canonical culprit-PR linkage",
  },
  sourceCommands: {
    issues: command(["gh", ...issueArgs]),
    merges: command(["gh", ...mergeArgs]),
    reviewTiers: `${command(["gh", ...mergeArgs])}; parse exactly one visible 'Review tier: A|B|C' declaration`,
    reviewLatency: command(["gh", ...reviewArgs]),
    laneSlotUtilization: "rg -n 'activeLanes.value > 0|activeLanes=0|idle-fleet coverage=blind|idle-fleet.wake' server.ts src/awareness.ts",
    defectEscape: command(["gh", ...labelArgs]),
  },
}, { startAtMs, endAtMs });

process.stdout.write(`${renderWeeklyThroughputReport(report)}\n`);
