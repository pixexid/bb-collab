import { describe, expect, it } from "vitest";
import { renderWeeklyThroughputReport, weeklyThroughputReport, type ThroughputFacts } from "../src/throughput-report.js";

const window = { startAtMs: 0, endAtMs: 7 * 86_400_000 };
const empty: ThroughputFacts = { dialsLandedAtMs: null, issues: [], merges: [], lanes: [], startableWindows: [], reviews: [], defects: [] };

describe("weekly throughput report", () => {
  it("defines medians, cadence bins, slot utilization, review latency, and escapes deterministically", () => {
    const report = weeklyThroughputReport({
      dialsLandedAtMs: 10,
      issues: [{ id: "i2", openedAtMs: 0, closedAtMs: 3_600_000 }, { id: "i1", openedAtMs: 0, closedAtMs: 7_200_000 }, { id: "missing", openedAtMs: null, closedAtMs: 2_000 }],
      merges: [{ id: "m2", mergedAtMs: 0 }, { id: "m1", mergedAtMs: 86_400_000 }, { id: "m3", mergedAtMs: 4 * 86_400_000 }],
      lanes: [{ id: "l1", orchestratorId: "o1", startedAtMs: 0, endedAtMs: 3_600_000 }],
      startableWindows: [{ orchestratorId: "o1", startAtMs: 0, endAtMs: 7_200_000, writingLaneCeiling: 2 }],
      reviews: [{ id: "r1", tier: "B", submittedAtMs: 0, completedAtMs: 3_600_000 }],
      defects: [{ id: "d1", reverted: true, postMergeSeverity: "P0" }, { id: "d2", reverted: false, postMergeSeverity: "P1" }],
    }, window);
    expect(report.issueOpenToClose).toEqual({ medianHours: 1.5, completed: 2, unknown: 1 });
    expect(report.firstReportAtMs).toBe(7 * 86_400_000 + 10);
    expect(report.mergeCadence.histogram).toEqual({ "<1d": 0, "1-3d": 1, "3-7d": 1, ">=7d": 0 });
    expect(report.laneSlotUtilization.o1.utilization).toBe(0.25);
    expect(report.reviewLatencyByTier.B.medianHours).toBe(1);
    expect(report.defectEscape).toMatchObject({ reverts: 1, postMergeP0s: 1, postMergeP1s: 1 });
    expect(report.dialGuidance).toContain("underused slots");
    expect(renderWeeklyThroughputReport(report)).toBe(JSON.stringify(report));
  });

  it("reports empty windows as unknown without inventing metrics", () => {
    const report = weeklyThroughputReport(empty, window);
    expect(report.issueOpenToClose.medianHours).toBeNull();
    expect(report.reviewLatencyByTier).toEqual({ A: { medianHours: null, completed: 0, unknown: 0 }, B: { medianHours: null, completed: 0, unknown: 0 }, C: { medianHours: null, completed: 0, unknown: 0 } });
    expect(report.dialGuidance).toContain("unknown");
  });

  it("keeps partial issue and review windows explicit", () => {
    const report = weeklyThroughputReport({
      ...empty,
      issues: [{ id: "open", openedAtMs: 1, closedAtMs: null }],
      reviews: [{ id: "pending", tier: "A", submittedAtMs: 1, completedAtMs: null }],
    }, window);
    expect(report.issueOpenToClose).toEqual({ medianHours: null, completed: 0, unknown: 1 });
    expect(report.reviewLatencyByTier.A).toEqual({ medianHours: null, completed: 0, unknown: 1 });
  });

  it("compares dial guidance in hours on both sides of the benchmark", () => {
    const facts = { ...empty, issues: [{ id: "issue", openedAtMs: 0, closedAtMs: 2_880_000 }] };
    expect(weeklyThroughputReport(facts, window).dialGuidance).toContain("at or below");
    expect(weeklyThroughputReport({ ...facts, issues: [{ ...facts.issues[0], closedAtMs: 2_880_001 }] }, window).dialGuidance).toContain("above");
  });

  it("audits open issue acceptance without treating incomplete or unknown state as closable", () => {
    const report = weeklyThroughputReport({
      ...empty,
      issues: [
        { id: "complete", openedAtMs: null, closedAtMs: null, githubState: "open", acceptance: "complete", mergedWorkCount: 1 },
        { id: "incomplete", openedAtMs: null, closedAtMs: null, githubState: "open", acceptance: "incomplete", mergedWorkCount: 2 },
        { id: "incomplete-no-count", openedAtMs: null, closedAtMs: null, githubState: "open", acceptance: "incomplete", mergedWorkCount: null },
        { id: "unknown", openedAtMs: null, closedAtMs: null, githubState: "unknown", acceptance: "complete", mergedWorkCount: 1 },
        { id: "closed", openedAtMs: null, closedAtMs: null, githubState: "closed", acceptance: "complete", mergedWorkCount: 1 },
      ],
    }, window);
    expect(report.issueAcceptanceAudit).toEqual({ openCompleted: ["complete"], openIncomplete: ["incomplete", "incomplete-no-count"], unknown: ["unknown"], status: "fail" });
    expect(weeklyThroughputReport({ ...empty, issues: [{ id: "incomplete", openedAtMs: null, closedAtMs: null, githubState: "open", acceptance: "incomplete", mergedWorkCount: 0 }] }, window).issueAcceptanceAudit.status).toBe("pass");
    expect(weeklyThroughputReport({ ...empty, issues: [{ id: "unknown", openedAtMs: null, closedAtMs: null, githubState: "unknown", acceptance: "complete", mergedWorkCount: 1 }] }, window).issueAcceptanceAudit.status).toBe("unknown");
  });
});
