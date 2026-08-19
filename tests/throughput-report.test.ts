import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderWeeklyThroughputReport, weeklyThroughputReport, type ThroughputFacts } from "../src/throughput-report.js";

const window = { startAtMs: 0, endAtMs: 7 * 86_400_000 };
const empty: ThroughputFacts = { dialsLandedAtMs: null, issues: [], merges: [], reviews: [], defects: [] };

describe("weekly throughput report", () => {
  it("defines medians, cadence bins, review latency, and escapes deterministically", () => {
    const report = weeklyThroughputReport({
      dialsLandedAtMs: 10,
      issues: [{ id: "i2", openedAtMs: 0, closedAtMs: 3_600_000 }, { id: "i1", openedAtMs: 0, closedAtMs: 7_200_000 }, { id: "missing", openedAtMs: null, closedAtMs: 2_000 }],
      merges: [
        { id: "m1", mergedAtMs: 0, tier: "A" },
        { id: "m2", mergedAtMs: 0.5 * 3_600_000, tier: "B" },
        { id: "m3", mergedAtMs: 2 * 3_600_000, tier: "C" },
        { id: "m4", mergedAtMs: 6 * 3_600_000, tier: null },
        { id: "m5", mergedAtMs: 12 * 3_600_000, tier: "A" },
      ],
      reviews: [{ id: "r1", tier: "B", submittedAtMs: 0, completedAtMs: 3_600_000 }],
      defects: [{ id: "d1", reverted: true, postMergeSeverity: "P0" }, { id: "d2", reverted: false, postMergeSeverity: "P1" }],
    }, window);
    expect(report.issueOpenToClose).toEqual({ medianHours: 1.5, maximumHours: 2, completed: 2, unknown: 1 });
    expect(report.firstReportAtMs).toBe(7 * 86_400_000 + 10);
    expect(report.mergeCadence).toMatchObject({ histogram: { "<1h": 1, "1-3h": 1, "3-6h": 1, ">=6h": 1 }, maximumGapHours: 6 });
    expect(report.reviewTierDeclarations).toEqual({ A: 2, B: 1, C: 1, unknown: 1 });
    expect(report.reviewLatencyByTier.B).toMatchObject({ status: "known", medianHours: 1 });
    expect(report.defectEscape).toMatchObject({ reverts: { status: "known", total: 1 }, postMergeP0s: { status: "known", count: 1 }, postMergeP1s: { status: "known", count: 1 } });
    expect(report.dialGuidance).toContain("above");
    expect(renderWeeklyThroughputReport(report)).toBe(JSON.stringify(report));
  });

  it("reports empty windows as unknown without inventing metrics", () => {
    const report = weeklyThroughputReport(empty, window);
    expect(report.issueOpenToClose.medianHours).toBeNull();
    expect(report.reviewLatencyByTier.A.status).toBe("unknown");
    expect(report.defectEscape).toMatchObject({ reverts: { status: "unknown", total: null }, postMergeP0s: { status: "unknown", count: null }, postMergeP1s: { status: "unknown", count: null } });
    expect(report.dialGuidance).toContain("unknown");
  });

  it("keeps partial issue and review windows explicit", () => {
    const report = weeklyThroughputReport({
      ...empty,
      issues: [{ id: "open", openedAtMs: 1, closedAtMs: null }],
      reviews: [{ id: "pending", tier: "A", submittedAtMs: 1, completedAtMs: null }],
    }, window);
    expect(report.issueOpenToClose).toEqual({ medianHours: null, maximumHours: null, completed: 0, unknown: 1 });
    expect(report.reviewLatencyByTier.A).toEqual({ status: "partial", medianHours: null, completed: 0, unknown: 1 });
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

  it("labels an outlier cohort beside the weekly aggregate without inventing review rounds", () => {
    const report = weeklyThroughputReport({
      ...empty,
      issues: [{ id: "issue", openedAtMs: 0, closedAtMs: 2 * 3_600_000 }],
      merges: [{ id: "first", mergedAtMs: 0 }, { id: "second", mergedAtMs: 7 * 3_600_000 }],
      outlierCohorts: [{ label: "high-throughput day", startAtMs: 0, endAtMs: 8 * 3_600_000 }],
      unknownReasons: { reviewLatency: "review linkage unavailable" },
    }, window);
    expect(report.outlierCohorts).toEqual([{
      label: "high-throughput day",
      window: { startAtMs: 0, endAtMs: 8 * 3_600_000 },
      issueOpenToClose: { maximumHours: 2, completed: 1, unknown: 0 },
      mergeCadence: { maximumGapHours: 7, knownMerges: 2 },
      reviewRounds: { status: "unknown", reason: "review linkage unavailable" },
    }]);
  });

  it("runs the existing calculator through the GitHub-backed reporting command", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-collab-throughput-"));
    const gh = join(directory, "gh");
    writeFileSync(gh, `#!/bin/sh
case "$1 $2" in
  "issue list") printf '%s' '[{"number":1,"createdAt":"2026-08-16T00:30:32Z","closedAt":"2026-08-16T01:30:32Z","state":"CLOSED"}]' ;;
  "pr list") printf '%s' '[{"number":2,"mergedAt":"2026-08-16T01:00:32Z","body":"Review tier: B","title":"ship"}]' ;;
  "label list") printf '%s' '[]' ;;
  "api repos/pixexid/bb-collab/pulls/338/reviews") printf '%s' '[]' ;;
  *) exit 2 ;;
esac
`);
    chmodSync(gh, 0o755);
    try {
      const output = execFileSync(process.execPath, [
        join(process.cwd(), "scripts", "weekly-throughput-report.mjs"),
        "--repo", "pixexid/bb-collab",
        "--start", "2026-08-16T00:30:32Z",
        "--end", "2026-08-23T00:30:32Z",
        "--dials-landed-at", "2026-08-16T00:30:32Z",
        "--outlier-label", "operator-noted day",
        "--outlier-start", "2026-08-16T00:30:32Z",
        "--outlier-end", "2026-08-16T02:30:32Z",
      ], { encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` } });
      const report = JSON.parse(output);
      expect(report.issueOpenToClose).toMatchObject({ medianHours: 1, maximumHours: 1, completed: 1 });
      expect(report.reviewTierDeclarations).toEqual({ A: 0, B: 1, C: 0, unknown: 0 });
      expect(report.laneSlotUtilization.status).toBe("unknown");
      expect(report.reviewLatencyByTier.B.status).toBe("unknown");
      expect(report.defectEscape.postMergeP0s).toMatchObject({ status: "unknown", count: null });
      expect(report.outlierCohorts[0]).toMatchObject({ label: "operator-noted day", issueOpenToClose: { completed: 1 }, mergeCadence: { knownMerges: 1 }, reviewRounds: { status: "unknown" } });
      expect(report.sourceCommands.issues).toContain("gh issue list");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("computes linked done-review latency from canonical export and preserves unknown for empty export", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-collab-linked-review-"));
    const gh = join(directory, "gh");
    const bb = join(directory, "bb");
    writeFileSync(gh, `#!/bin/sh
case "$1 $2" in
  "issue list") printf '%s' '[]' ;;
  "pr list") printf '%s' '[{"number":338,"mergedAt":"2026-08-13T00:00:00Z","body":"Review tier: B","title":"review target"}]' ;;
  "label list") printf '%s' '[]' ;;
  *) exit 2 ;;
esac
`);
    const writeBb = (recordsNdjson: string) => {
      const payload = JSON.stringify({ evidence: { export: { recordsNdjson } } });
      writeFileSync(bb, `#!/bin/sh
case "$1 $2" in
  "project list") printf '%s' '[{"id":"project-test","gitRemoteUrl":"https://github.com/pixexid/bb-collab.git"}]' ;;
  "collab export") printf '%s' '${payload}' ;;
  *) exit 2 ;;
esac
`);
      chmodSync(bb, 0o755);
    };
    const { BB_CLI: _bbCli, ...testEnv } = process.env;
    const run = () => JSON.parse(execFileSync(process.execPath, [
      join(process.cwd(), "scripts", "weekly-throughput-report.mjs"),
      "--repo", "pixexid/bb-collab", "--start", "2026-08-12T00:00:00Z", "--end", "2026-08-20T00:00:00Z", "--dials-landed-at", "2026-08-13T00:00:00Z",
    ], { encoding: "utf8", env: { ...testEnv, PATH: `${directory}:${process.env.PATH ?? ""}` } }));
    chmodSync(gh, 0o755);
    try {
      writeBb('{"table":"execution_attempts","row":{"execution_attempt_id":"review-1","review_pr_number":338,"created_at_ms":1786579200000,"completed_at_ms":1786584600000,"state":"done"}}');
      const known = run().reviewLatencyByTier;
      expect(known.B).toEqual({ status: "known", medianHours: 1.5, completed: 1, unknown: 0 });
      expect(known.B).not.toHaveProperty("reason");

      writeBb("");
      const unknown = run().reviewLatencyByTier;
      expect(unknown.B.status).toBe("unknown");
      expect(unknown.B).toHaveProperty("reason", "no canonically linked Tier B review observations");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
