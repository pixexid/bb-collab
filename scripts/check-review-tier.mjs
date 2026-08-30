import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { visibleMarkdown } from "./pr-lifecycle.mjs";
import { requiredReviewTier } from "../src/review-tier.mjs";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const eventPath = process.argv[2];
  if (!eventPath) throw new Error("usage: check-review-tier.mjs <github-event-path>");

  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const body = visibleMarkdown(event.pull_request?.body ?? "");
  const files = readFileSync(0, "utf8").split(/\r?\n/u).filter(Boolean);
  const declarations = body.match(/^\s*Review tier\s*:\s*([ABC])\s*$/gmu) ?? [];
  const declared = declarations.length === 1 ? declarations[0].match(/([ABC])\s*$/u)?.[1] ?? null : null;
  const required = requiredReviewTier(files);

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
}
