import { describe, expect, it } from "vitest";
import { resolveSubagentReasoningLevel } from "../src/subagent-effort.js";

describe("subagent effort directive", () => {
  it("defaults omitted mechanical effort to low while preserving explicit hard-core high/max", () => {
    expect(resolveSubagentReasoningLevel({ taskKind: "mechanical", parentReasoningLevel: "max" })).toBe("low");
    expect(resolveSubagentReasoningLevel({ taskKind: "hard-core", parentReasoningLevel: "high" })).toBe("high");
    expect(resolveSubagentReasoningLevel({ taskKind: "mechanical", parentReasoningLevel: "low", requestedReasoningLevel: "max" })).toBe("max");
  });

  it("does not allow unrelated parent effort to escalate mechanical work", () => {
    expect(resolveSubagentReasoningLevel({ taskKind: "mechanical", parentReasoningLevel: "high" })).toBe("low");
  });
});
