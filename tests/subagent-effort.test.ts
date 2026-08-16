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

  it("records the current supervisor-ratified role matrix and explicit spawn boundary", () => {
    expect(operationsModel).toContain("Director | `pi` | `kimi-coding/k3` | HIGH");
    expect(operationsModel).toContain("K3 is director-only; it is never a review fallback.");
    expect(operationsModel).toContain("Orchestrator primary | Claude harness / `claude-code` | `claude-opus-5` | MEDIUM");
    expect(operationsModel).toContain("Orchestrator alternate | Codex harness / `codex` | `gpt-5.6-sol` | MEDIUM");
    expect(operationsModel).toContain("Orchestrator alternate | Codex harness / `codex` | `gpt-5.6-terra` | MEDIUM");
    expect(operationsModel).toContain("Never Luna or below.");
    expect(operationsModel).toContain("pending epoch-2 orchestrator succession");
    expect(operationsModel).toMatch(/Watch item: monitor the shared Anthropic account window across the amended\norchestrator, app-side supervisor wakes, and `claude-opus-5` cold reviews\./u);
    expect(operationsModel).toContain("do not hot-swap a healthy live orchestrator");
    expect(operationsModel).toMatch(/If that window saturates, `codex\/gpt-5\.6-sol`\nMEDIUM is the standing fallback,\npre-authorized without a new decision\./u);
    expect(operationsModel).toContain("Merge-bound implementer | Pi harness / `pi` | `zai/glm-5.3` | MEDIUM or HIGH");
    expect(operationsModel).toContain("Tier-A reviewer | Codex harness / `codex` | `gpt-5.6-sol` | HIGH");
    expect(operationsModel).toContain("Tier-A reviewer fallback | Codex harness / `codex` | `gpt-5.6-terra` | HIGH");
    expect(operationsModel).toContain("`gpt-5.6-terra` HIGH is acceptable when `gpt-5.6-sol` authored");
    expect(operationsModel).toContain("Tier-B reviewer | Codex harness / `codex` | `gpt-5.6-luna` | MEDIUM");
    expect(operationsModel).toContain("Reviewer default harness/provider is Codex; the tier rows name the actual model");
    expect(operationsModel).toContain("Mechanical probe | Pi harness / `pi` | `deepseek-v4-flash` | LOW");
    expect(operationsModel).toContain("Mechanical probe | Pi harness / `pi` | `glm-5-turbo` | LOW");
    expect(operationsModel).toContain("The v14 `director-seat` amendment remains the existing project-orchestrator");
    expect(operationsModel).toContain("Opus-medium standby");
    expect(operationsModel).toContain("current graded qualification probe");
    expect(operationsModel).toMatch(/The coding probe for\n`muse-spark-1\.2` is \[GH-106\]/u);
    expect(operationsModel).toMatch(/the Terra placement probe is\n\[GH-105\]/u);
    expect(operationsModel).toMatch(/Every new spawn must provide explicit `provider`, `model`, `reasoning`, and\n`visibility: "visible"` flags\./u);
    expect(operationsModel).toMatch(/A requested profile is Assignment intent only\. Eligibility and review routing\nuse the actual harness\/provider, model, reasoning, permission and visibility\nrecorded by the ExecutionAttempt\/provider receipt;/u);
    expect(operationsModel).not.toContain("K3 HIGH");
    expect(operationsModel).not.toContain("`glm-5.3` is barred");
  });
});
