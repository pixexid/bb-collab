export type ReportTier = "A" | "B" | "C";
export type CadenceBin = "<1h" | "1-3h" | "3-6h" | ">=6h";

type UnknownMetric = { status: "unknown"; reason: string };

export type ThroughputFacts = {
  dialsLandedAtMs: number | null;
  issues: Array<{
    id: string;
    openedAtMs: number | null;
    closedAtMs: number | null;
    githubState?: "open" | "closed" | "unknown";
    acceptance?: "complete" | "incomplete" | "unknown";
    mergedWorkCount?: number | null;
  }>;
  merges: Array<{ id: string; mergedAtMs: number | null; tier?: ReportTier | null; title?: string }>;
  reviews: Array<{
    id: string;
    tier: ReportTier | null;
    submittedAtMs: number | null;
    completedAtMs: number | null;
  }>;
  defects: Array<{
    id: string;
    reverted: boolean | null;
    postMergeSeverity: "P0" | "P1" | null;
  }>;
  outlierCohorts?: Array<{ label: string; startAtMs: number; endAtMs: number }>;
  unknownReasons?: Partial<Record<"laneSlotUtilization" | "reviewLatency" | "reverts" | "postMergeSeverity", string>>;
  sourceCommands?: Partial<Record<"issues" | "merges" | "reviewTiers" | "reviewLatency" | "laneSlotUtilization" | "defectEscape", string>>;
};

export type WeeklyThroughputReport = {
  window: { startAtMs: number; endAtMs: number };
  firstReportAtMs: number | null;
  benchmark: { issueOpenToCloseMedianHours: 0.8 };
  issueOpenToClose: { medianHours: number | null; maximumHours: number | null; completed: number; unknown: number };
  issueAcceptanceAudit: { openCompleted: string[]; openIncomplete: string[]; unknown: string[]; status: "pass" | "fail" | "unknown" };
  mergeCadence: { histogram: Record<CadenceBin, number>; maximumGapHours: number | null; knownMerges: number; unknown: number };
  reviewTierDeclarations: Record<ReportTier | "unknown", number>;
  laneSlotUtilization: UnknownMetric;
  reviewLatencyByTier: Record<ReportTier, UnknownMetric | { status: "known" | "partial"; medianHours: number | null; completed: number; unknown: number }>;
  defectEscape: {
    reverts: UnknownMetric & { total: null; observedExplicitRevertIds: string[] } | { status: "known"; total: number; observedExplicitRevertIds: string[] };
    postMergeP0s: UnknownMetric & { count: null } | { status: "known"; count: number };
    postMergeP1s: UnknownMetric & { count: null } | { status: "known"; count: number };
  };
  outlierCohorts: Array<{
    label: string;
    window: { startAtMs: number; endAtMs: number };
    issueOpenToClose: { maximumHours: number | null; completed: number; unknown: number };
    mergeCadence: { maximumGapHours: number | null; knownMerges: number };
    reviewRounds: UnknownMetric | { status: "known"; reason?: never };
  }>;
  sourceCommands: ThroughputFacts["sourceCommands"];
  dialGuidance: string;
};

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const hours = (ms: number) => Number((ms / 3_600_000).toFixed(3));
const inWindow = (at: number | null, start: number, end: number) => at !== null && at >= start && at < end;
const overlapsWindow = (startAt: number | null, endAt: number | null, start: number, end: number) =>
  startAt !== null && startAt < end && (endAt === null || endAt > start);

export function weeklyThroughputReport(facts: ThroughputFacts, window: { startAtMs: number; endAtMs: number }): WeeklyThroughputReport {
  const issueCandidates = facts.issues.filter((issue) => inWindow(issue.openedAtMs, window.startAtMs, window.endAtMs) || inWindow(issue.closedAtMs, window.startAtMs, window.endAtMs));
  const issueDurations = issueCandidates.filter((issue) => inWindow(issue.closedAtMs, window.startAtMs, window.endAtMs) && issue.openedAtMs !== null)
    .map((issue) => issue.closedAtMs! - issue.openedAtMs!);
  const issueUnknown = issueCandidates.filter((issue) => issue.openedAtMs === null || issue.closedAtMs === null).length;
  const issueAcceptanceAudit = { openCompleted: [], openIncomplete: [], unknown: [], status: "pass" } as WeeklyThroughputReport["issueAcceptanceAudit"];
  for (const issue of facts.issues) {
    const state = issue.githubState ?? "unknown";
    if (state === "closed") continue;
    if (state !== "open" || issue.acceptance === "unknown" || issue.acceptance === undefined) {
      issueAcceptanceAudit.unknown.push(issue.id);
    } else if (issue.acceptance === "incomplete") {
      issueAcceptanceAudit.openIncomplete.push(issue.id);
    } else if (issue.mergedWorkCount === null || issue.mergedWorkCount === undefined) {
      issueAcceptanceAudit.unknown.push(issue.id);
    } else if (issue.acceptance === "complete" && issue.mergedWorkCount > 0) {
      issueAcceptanceAudit.openCompleted.push(issue.id);
    } else {
      issueAcceptanceAudit.unknown.push(issue.id);
    }
  }
  issueAcceptanceAudit.status = issueAcceptanceAudit.openCompleted.length > 0
    ? "fail"
    : issueAcceptanceAudit.unknown.length > 0
      ? "unknown"
      : "pass";

  const mergeTimes = facts.merges.filter((merge) => merge.mergedAtMs !== null).map((merge) => merge.mergedAtMs!).sort((a, b) => a - b);
  const histogram: Record<CadenceBin, number> = { "<1h": 0, "1-3h": 0, "3-6h": 0, ">=6h": 0 };
  const mergeGaps: number[] = [];
  for (let i = 1; i < mergeTimes.length; i += 1) {
    if (!inWindow(mergeTimes[i], window.startAtMs, window.endAtMs)) continue;
    const gap = hours(mergeTimes[i] - mergeTimes[i - 1]);
    mergeGaps.push(gap);
    histogram[gap < 1 ? "<1h" : gap < 3 ? "1-3h" : gap < 6 ? "3-6h" : ">=6h"] += 1;
  }

  const reviewLatencyByTier = Object.fromEntries((["A", "B", "C"] as const).map((tier) => {
    if (facts.unknownReasons?.reviewLatency) return [tier, { status: "unknown", reason: facts.unknownReasons.reviewLatency }];
    const reviews = facts.reviews.filter((review) => review.tier === tier && (inWindow(review.submittedAtMs, window.startAtMs, window.endAtMs) || inWindow(review.completedAtMs, window.startAtMs, window.endAtMs)));
    if (reviews.length === 0) return [tier, { status: "unknown", reason: `no canonically linked Tier ${tier} review observations` }];
    const completed = reviews.filter((review) => inWindow(review.completedAtMs, window.startAtMs, window.endAtMs) && review.submittedAtMs !== null);
    const unknown = reviews.length - completed.length;
    return [tier, { status: unknown === 0 ? "known" : "partial", medianHours: median(completed.map((review) => hours(review.completedAtMs! - review.submittedAtMs!))), completed: completed.length, unknown }];
  })) as WeeklyThroughputReport["reviewLatencyByTier"];
  const defects = facts.defects;
  const explicitRevertIds = defects.filter((defect) => defect.reverted === true).map((defect) => defect.id);
  const reverts = facts.unknownReasons?.reverts || defects.length === 0 || defects.some((defect) => defect.reverted === null)
    ? { status: "unknown" as const, total: null, observedExplicitRevertIds: explicitRevertIds, reason: facts.unknownReasons?.reverts ?? "revert coverage is unavailable" }
    : { status: "known" as const, total: explicitRevertIds.length, observedExplicitRevertIds: explicitRevertIds };
  const severityUnknown = facts.unknownReasons?.postMergeSeverity || defects.length === 0 || defects.some((defect) => defect.postMergeSeverity === null);
  const postMergeP0s = severityUnknown
    ? { status: "unknown" as const, count: null, reason: facts.unknownReasons?.postMergeSeverity ?? "post-merge severity coverage is unavailable" }
    : { status: "known" as const, count: defects.filter((defect) => defect.postMergeSeverity === "P0").length };
  const postMergeP1s = severityUnknown
    ? { status: "unknown" as const, count: null, reason: facts.unknownReasons?.postMergeSeverity ?? "post-merge severity coverage is unavailable" }
    : { status: "known" as const, count: defects.filter((defect) => defect.postMergeSeverity === "P1").length };
  const reviewTierDeclarations = { A: 0, B: 0, C: 0, unknown: 0 };
  for (const merge of facts.merges) {
    if (!inWindow(merge.mergedAtMs, window.startAtMs, window.endAtMs)) continue;
    reviewTierDeclarations[merge.tier ?? "unknown"] += 1;
  }
  const outlierCohorts = (facts.outlierCohorts ?? []).map((cohort) => {
    const issues = facts.issues.filter((issue) => inWindow(issue.closedAtMs, cohort.startAtMs, cohort.endAtMs));
    const durations = issues.filter((issue) => issue.openedAtMs !== null).map((issue) => issue.closedAtMs! - issue.openedAtMs!);
    const cohortMerges = mergeTimes.filter((mergedAtMs) => inWindow(mergedAtMs, cohort.startAtMs, cohort.endAtMs));
    const gaps = cohortMerges.slice(1).map((mergedAtMs, index) => mergedAtMs - cohortMerges[index]);
    const cohortReviews = facts.reviews.filter((review) => overlapsWindow(review.submittedAtMs, review.completedAtMs, cohort.startAtMs, cohort.endAtMs));
    return {
      label: cohort.label,
      window: { startAtMs: cohort.startAtMs, endAtMs: cohort.endAtMs },
      issueOpenToClose: { maximumHours: durations.length ? hours(Math.max(...durations)) : null, completed: durations.length, unknown: issues.length - durations.length },
      mergeCadence: { maximumGapHours: gaps.length ? hours(Math.max(...gaps)) : null, knownMerges: cohortMerges.length },
      reviewRounds: cohortReviews.length === 0
        ? { status: "unknown" as const, reason: facts.unknownReasons?.reviewLatency ?? "no canonically linked review observations" }
        : { status: "known" as const },
    };
  });
  const issueMedian = median(issueDurations);
  const issueMedianHours = issueMedian === null ? null : issueMedian / 3_600_000;
  const dialGuidance = issueMedianHours === null
    ? "unknown: no complete issue open-to-close observations; do not adjust dials."
    : issueMedianHours <= 0.8
      ? "at or below the 0.8h benchmark: hold dials; do not auto-adjust."
      : "above the 0.8h benchmark: hold the dial pending complete defect/review evidence; do not auto-adjust.";

  return {
    window,
    firstReportAtMs: facts.dialsLandedAtMs === null ? null : facts.dialsLandedAtMs + 7 * 86_400_000,
    benchmark: { issueOpenToCloseMedianHours: 0.8 },
    issueOpenToClose: { medianHours: issueMedian === null ? null : hours(issueMedian), maximumHours: issueDurations.length ? hours(Math.max(...issueDurations)) : null, completed: issueDurations.length, unknown: issueUnknown },
    issueAcceptanceAudit,
    mergeCadence: { histogram, maximumGapHours: mergeGaps.length ? Math.max(...mergeGaps) : null, knownMerges: mergeTimes.filter((merge) => inWindow(merge, window.startAtMs, window.endAtMs)).length, unknown: facts.merges.filter((merge) => merge.mergedAtMs === null).length },
    reviewTierDeclarations,
    laneSlotUtilization: { status: "unknown", reason: facts.unknownReasons?.laneSlotUtilization ?? "lane slot utilization is unavailable" },
    reviewLatencyByTier,
    defectEscape: { reverts, postMergeP0s, postMergeP1s },
    outlierCohorts,
    sourceCommands: facts.sourceCommands,
    dialGuidance,
  };
}

export const renderWeeklyThroughputReport = (report: WeeklyThroughputReport) => JSON.stringify(report);
