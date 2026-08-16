import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveSubagentReasoningLevel } from "../src/subagent-effort.js";

const operationsModel = readFileSync("docs/operations-model.md", "utf8");
const agents = readFileSync("AGENTS.md", "utf8");
const adr = readFileSync("docs/adr/0001-founding-contract.md", "utf8");

describe("subagent effort directive", () => {
  it("defaults omitted mechanical effort to low while preserving explicit hard-core high/max", () => {
    expect(resolveSubagentReasoningLevel({ taskKind: "mechanical", parentReasoningLevel: "max" })).toBe("low");
    expect(resolveSubagentReasoningLevel({ taskKind: "hard-core", parentReasoningLevel: "high" })).toBe("high");
    expect(resolveSubagentReasoningLevel({ taskKind: "mechanical", parentReasoningLevel: "low", requestedReasoningLevel: "max" })).toBe("max");
    expect(operationsModel).toContain("codex/gpt-5.6-luna");
    expect(operationsModel).toContain("resolves to LOW");
    expect(operationsModel).toMatch(/omitted reasoning value on a\nmechanical subtask/u);
    expect(operationsModel).toContain("resolves to LOW");
    expect(operationsModel).toContain("hard core may opt into an explicit HIGH or MAX value");
  });

  it("does not allow unrelated parent effort to escalate mechanical work", () => {
    expect(resolveSubagentReasoningLevel({ taskKind: "mechanical", parentReasoningLevel: "high" })).toBe("low");
    expect(operationsModel).toMatch(/parent worker's HIGH or MAX effort must not\nsilently escalate it/u);
    expect(agents).toContain("a parent's HIGH or MAX effort is not inherited by mechanical work");
    expect(adr).toContain("including when their parent used HIGH or MAX");
  });

  it("keeps requested versus executed reasoning on the existing assignment receipt seam", () => {
    expect(operationsModel).toMatch(/Assignment\/ExecutionAttempt receipt comparison records requested versus\nexecuted reasoning/u);
    expect(adr).toMatch(/Assignment requested profile and ExecutionAttempt actual profile are the\nconformance record/u);
  });
});
