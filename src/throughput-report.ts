export type ReportTier = "A" | "B" | "C";

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
  merges: Array<{ id: string; mergedAtMs: number | null }>;
  lanes: Array<{
    id: string;
    orchestratorId: string | null;
    startedAtMs: number | null;
    endedAtMs: number | null;
  }>;
  startableWindows: Array<{
    orchestratorId: string;
    startAtMs: number;
    endAtMs: number;
    writingLaneCeiling: number | null;
  }>;
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
};

export type WeeklyThroughputReport = {
  window: { startAtMs: number; endAtMs: number };
  firstReportAtMs: number | null;
  benchmark: { issueOpenToCloseMedianHours: 0.8 };
  issueOpenToClose: { medianHours: number | null; completed: number; unknown: number };
  issueAcceptanceAudit: { openCompleted: string[]; openIncomplete: string[]; unknown: string[]; status: "pass" | "fail" | "unknown" };
  mergeCadence: { histogram: Record<"<1d" | "1-3d" | "3-7d" | ">=7d", number>; knownMerges: number; unknown: number };
  laneSlotUtilization: Record<string, { utilization: number | null; occupiedMs: number; availableMs: number; unknown: number }>;
  reviewLatencyByTier: Record<ReportTier, { medianHours: number | null; completed: number; unknown: number }>;
  defectEscape: { reverts: number | null; postMergeP0s: number | null; postMergeP1s: number | null; unknown: number };
  dialGuidance: string;
};

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const hours = (ms: number) => Number((ms / 3_600_000).toFixed(3));
const overlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
const inWindow = (at: number | null, start: number, end: number) => at !== null && at >= start && at < end;

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
  const histogram = { "<1d": 0, "1-3d": 0, "3-7d": 0, ">=7d": 0 } as Record<"<1d" | "1-3d" | "3-7d" | ">=7d", number>;
  for (let i = 1; i < mergeTimes.length; i += 1) {
    if (!inWindow(mergeTimes[i], window.startAtMs, window.endAtMs)) continue;
    const days = (mergeTimes[i] - mergeTimes[i - 1]) / 86_400_000;
    histogram[days < 1 ? "<1d" : days < 3 ? "1-3d" : days < 7 ? "3-7d" : ">=7d"] += 1;
  }

  const utilization: WeeklyThroughputReport["laneSlotUtilization"] = {};
  for (const orchestratorId of [...new Set(facts.startableWindows.map((entry) => entry.orchestratorId))].sort()) {
    const windows = facts.startableWindows.filter((entry) => entry.orchestratorId === orchestratorId);
    const availableMs = windows.reduce((total, entry) => total + overlap(entry.startAtMs, entry.endAtMs, window.startAtMs, window.endAtMs), 0);
    const ceiling = windows.every((entry) => entry.writingLaneCeiling !== null) ? windows[0]?.writingLaneCeiling ?? null : null;
    const occupiedMs = facts.lanes.filter((lane) => lane.orchestratorId === orchestratorId).reduce((total, lane) => total + windows.reduce((sum, entry) => sum + overlap(lane.startedAtMs ?? 0, lane.endedAtMs ?? window.endAtMs, entry.startAtMs, entry.endAtMs), 0), 0);
    utilization[orchestratorId] = { utilization: ceiling && availableMs ? Number((occupiedMs / (availableMs * ceiling)).toFixed(3)) : null, occupiedMs, availableMs: availableMs * (ceiling ?? 0), unknown: ceiling === null ? windows.length : 0 };
  }

  const reviewLatencyByTier = Object.fromEntries((["A", "B", "C"] as const).map((tier) => {
    const reviews = facts.reviews.filter((review) => review.tier === tier && (inWindow(review.submittedAtMs, window.startAtMs, window.endAtMs) || inWindow(review.completedAtMs, window.startAtMs, window.endAtMs)));
    const completed = reviews.filter((review) => inWindow(review.completedAtMs, window.startAtMs, window.endAtMs) && review.submittedAtMs !== null);
    return [tier, { medianHours: median(completed.map((review) => hours(review.completedAtMs! - review.submittedAtMs!))), completed: completed.length, unknown: reviews.length - completed.length }];
  })) as WeeklyThroughputReport["reviewLatencyByTier"];
  const defects = facts.defects;
  const issueMedian = median(issueDurations);
  const maxCeiling = Math.max(0, ...facts.startableWindows.map((entry) => entry.writingLaneCeiling ?? 0));
  const utilizationValues = Object.values(utilization).map((entry) => entry.utilization).filter((value): value is number => value !== null);
  const issueMedianHours = issueMedian === null ? null : issueMedian / 3_600_000;
  const dialGuidance = issueMedianHours === null
    ? "unknown: no complete issue open-to-close observations; do not adjust dials."
    : issueMedianHours <= 0.8
      ? "at or below the 0.8h benchmark: hold dials; do not auto-adjust."
      : utilizationValues.some((value) => value >= 0.8) && maxCeiling < 3
        ? `above the 0.8h benchmark with busy startable slots: consider raising writingLaneCeiling by one, up to 3, after defect/review checks; do not auto-adjust.`
        : utilizationValues.length && utilizationValues.every((value) => value < 0.5)
          ? "above the 0.8h benchmark with underused slots: do not raise the dial; investigate queue, review, or missing-fact blockers."
          : "above the 0.8h benchmark: hold the dial pending complete utilization and defect/review evidence; do not auto-adjust.";

  return {
    window,
    firstReportAtMs: facts.dialsLandedAtMs === null ? null : facts.dialsLandedAtMs + 7 * 86_400_000,
    benchmark: { issueOpenToCloseMedianHours: 0.8 },
    issueOpenToClose: { medianHours: issueMedian === null ? null : hours(issueMedian), completed: issueDurations.length, unknown: issueUnknown },
    issueAcceptanceAudit,
    mergeCadence: { histogram, knownMerges: mergeTimes.filter((merge) => inWindow(merge, window.startAtMs, window.endAtMs)).length, unknown: facts.merges.filter((merge) => merge.mergedAtMs === null).length },
    laneSlotUtilization: utilization,
    reviewLatencyByTier,
    defectEscape: { reverts: defects.some((defect) => defect.reverted === null) ? null : defects.filter((defect) => defect.reverted).length, postMergeP0s: defects.some((defect) => defect.postMergeSeverity === null) ? null : defects.filter((defect) => defect.postMergeSeverity === "P0").length, postMergeP1s: defects.some((defect) => defect.postMergeSeverity === null) ? null : defects.filter((defect) => defect.postMergeSeverity === "P1").length, unknown: defects.filter((defect) => defect.reverted === null || defect.postMergeSeverity === null).length },
    dialGuidance,
  };
}

export const renderWeeklyThroughputReport = (report: WeeklyThroughputReport) => JSON.stringify(report);
