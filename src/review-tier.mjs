const tierA = [
  /^AGENTS\.md$/u,
  /^app\.tsx$/u,
  /^\.github\/workflows\/verify\.yml$/u,
  /^\.github\/workflows\/issue-lifecycle\.yml$/u,
  /^\.github\/workflows\/issue-lifecycle-audit\.yml$/u,
  /^docs\/(?:adr\/0001-founding-contract|import-manifest|issue-76-tiered-review-policy|operations-model|threat-model)\.md$/u,
  /^scripts\/build\.mjs$/u,
  /^scripts\/release-artifact\.(?:d\.mts|mjs)$/u,
  /^scripts\/activate-release\.(?:d\.mts|mjs)$/u,
  /^scripts\/check-pr-lifecycle\.mjs$/u,
  /^scripts\/handle-merged-pr-lifecycle\.mjs$/u,
  /^scripts\/audit-issue-lifecycle\.mjs$/u,
  /^scripts\/audit-issue-lifecycle\.d\.mts$/u,
  /^scripts\/pr-lifecycle\.d\.mts$/u,
  /^scripts\/pr-lifecycle\.mjs$/u,
  /^scripts\/check-review-tier\.mjs$/u,
  /^scripts\/check-composed-pr\.mjs$/u,
  /^scripts\/check-dist\.mjs$/u,
  /^scripts\/check-production-reachability\.mjs$/u,
  /^scripts\/read-executed-profile\.mjs$/u,
  /^scripts\/review-verdict-acceptance\.mjs$/u,
  /^scripts\/check-css-bundle\.mjs$/u,
  /^package\.json$/u,
  /^server\.ts$/u,
  /(?:^|\/|[-_.])(?:authority|approval|atomicity|concurrenc(?:y|ies)|cutover|migrations?|provenance|receipts?|spend)(?:[-_.\/]|$)/iu,
  /(^|\/)foundation\.ts$/u,
];
const tierC = [/^docs\//u, /^tests\//u, /(?:^|\/)dist\//u, /(?:^|\/)(?:README|AGENTS)\.md$/u];

export const requiredReviewTier = (files) => files.some((file) => tierA.some((pattern) => pattern.test(file)))
  ? "A"
  : files.length > 0 && files.every((file) => tierC.some((pattern) => pattern.test(file)))
    ? "C"
    : "B";
