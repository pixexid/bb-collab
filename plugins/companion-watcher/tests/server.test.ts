import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate, isMergeReady, isWatchedThread, openStore, shouldEscalate } from "../server.js";

const dbs: Database.Database[] = [];
function db(active = 0, ceiling = 3) {
  const value = new Database(":memory:"); dbs.push(value);
  value.exec(`CREATE TABLE role_generation_heads (project_id TEXT, role_id TEXT, current_generation INTEGER);
    CREATE TABLE role_generations (project_id TEXT, role_id TEXT, generation INTEGER, holder_execution_attempt_id TEXT);
    CREATE TABLE execution_attempts (project_id TEXT, execution_attempt_id TEXT, thread_id TEXT, origin TEXT, state TEXT);
    CREATE TABLE project_config_heads (project_id TEXT, config_revision INTEGER);
    CREATE TABLE project_config_revisions (project_id TEXT, config_revision INTEGER, canonical_config_json TEXT);`);
  value.prepare("INSERT INTO role_generation_heads VALUES ('p','project-orchestrator',1)").run();
  value.prepare("INSERT INTO role_generations VALUES ('p','project-orchestrator',1,'o')").run();
  value.prepare("INSERT INTO execution_attempts VALUES ('p','o','orch','role_holder','done')").run();
  value.prepare("INSERT INTO project_config_heads VALUES ('p',1)").run();
  value.prepare("INSERT INTO project_config_revisions VALUES ('p',1,?)").run(JSON.stringify({ extensions: { bbCollab: { writingLaneCeiling: ceiling } } }));
  for (let i = 0; i < active; i++) value.prepare("INSERT INTO execution_attempts VALUES ('p',?,?,'assignment','running')").run(`a${i}`, `lane${i}`);
  return value;
}
afterEach(() => { while (dbs.length) dbs.pop()!.close(); });

describe("mechanical conditions", () => {
  it("wakes with each condition's contents", () => {
    const findings = evaluate(db(), "p", [{ id: "m1", content: [{ type: "text", text: "ping" }] }], [508], [{ number: 493, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: ["SUCCESS"] }]);
    expect(findings.map((f) => f.condition)).toEqual(["queue", "startable", "pr"]);
    expect(findings.map((f) => f.text).join("; ")).toContain("#508");
    expect(findings.map((f) => f.text).join("; ")).toContain("PR #493 merge-ready and unmerged");
  });
  it("stays silent for legitimate operator waiting", () => {
    expect(evaluate(db(), "p", [], [], [])).toEqual([]);
  });
  it("stays silent when all work is blocked", () => {
    expect(evaluate(db(), "p", [], [], [])).toEqual([]);
  });
  it("stays silent when lanes are active, while reaching the evaluation", () => {
    expect(evaluate(db(1), "p", [{ id: "m1" }], [508], [{ number: 493, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: ["SUCCESS"] }])).toEqual([]);
  });
  it("does not wake for parked queues or non-green PRs", () => {
    expect(evaluate(db(), "p", [], [], [{ number: 493, state: "OPEN", mergeStateStatus: "DIRTY", reviewDecision: "APPROVED", checks: ["SUCCESS"] }])).toEqual([]);
  });
  it("requires clean merge readiness, approval, and successful checks", () => {
    expect(isMergeReady({ number: 1, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: ["SUCCESS"] })).toBe(true);
    for (const pr of [
      { mergeStateStatus: "DIRTY" },
      { reviewDecision: "REVIEW_REQUIRED" },
      { checks: ["SUCCESS", "FAILURE"] },
    ]) expect(isMergeReady({ number: 1, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: ["SUCCESS"], ...pr })).toBe(false);
  });
  it("opens unavailable stores defensively and identifies only the cached orchestrator", () => {
    const errors: unknown[] = [];
    expect(openStore("/missing/bb-collab.db", (error) => errors.push(error))).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(isWatchedThread("orch", "p", new Map([["p", "orch"]]))).toBe(true);
    expect(isWatchedThread("lane", "p", new Map([["p", "orch"]]))).toBe(false);
  });
  it("requires evidence of a completed turn before escalating", () => {
    const prior = { sentAt: 100, fingerprint: "same", turns: 1 };
    expect(shouldEscalate(prior, undefined, "same")).toBe(false);
    expect(shouldEscalate(prior, 100, "same")).toBe(false);
    expect(shouldEscalate(prior, 101, "same")).toBe(true);
  });
});
