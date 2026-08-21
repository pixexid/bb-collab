import { describe, expect, it } from "vitest";
import { digest, intervalId, nextWake, parseJudgment } from "../server.js";

describe("Alzheimer companion guardrails", () => {
  it("pins a bounded jittered due interval", () => {
    expect(nextWake(0, 60, 5, 0)).toBe(55 * 60_000);
    expect(nextWake(0, 60, 5, 0.999)).toBe(65 * 60_000);
  });
  it("derives the frozen cadence interval", () => {
    expect(intervalId("p", 3_600_001, 60)).toBe("alzheimer:p:1");
  });
  it("distinguishes judged clear from unreadable coverage", () => {
    expect(parseJudgment("COVERAGE: known\nall clear")).toMatchObject({ coverage: "known", escalate: false });
    expect(parseJudgment("read failed")).toMatchObject({ coverage: "blind" });
  });
  it("digests the exact report", () => {
    expect(digest("report")).toHaveLength(64);
    expect(digest("report")).not.toBe(digest("changed"));
  });
});
