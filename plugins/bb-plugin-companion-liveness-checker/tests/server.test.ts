import { describe, expect, it } from "vitest";
import { reconcile, type Expected, type Receipt } from "../server.js";

const expected = (dueAtMs = 100): Expected[] => [{ projectId: "p", intervalId: "i", dueAtMs }];
const receipt = (overrides: Partial<Receipt> = {}): Receipt => ({ intervalId: "i", observedAtMs: 101, threadId: "t", coverage: "known", reportDigest: "d", ...overrides });

describe("companion liveness reconciliation", () => {
  it("reports a due interval with no receipt as missing", () => {
    expect(reconcile(expected(), [], 200)).toEqual([{ intervalId: "i", status: "missing" }]);
  });
  it("does not conflate late or blind receipts with missing", () => {
    expect(reconcile(expected(), [receipt({ observedAtMs: 300101 })], 300200)).toEqual([{ intervalId: "i", status: "late", observedAtMs: 300101 }]);
    expect(reconcile(expected(), [receipt({ coverage: "blind" })], 200)).toEqual([{ intervalId: "i", status: "blind", observedAtMs: 101 }]);
  });
  it("does not report an on-time known receipt", () => {
    expect(reconcile(expected(), [receipt()], 200)).toEqual([]);
  });
  it("does not judge an interval before it is due", () => {
    expect(reconcile(expected(), [], 99)).toEqual([]);
  });
});
