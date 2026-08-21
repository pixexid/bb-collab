import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { coverageReason, evaluate, isMergeReady, openStore, parsePullRequests, readOrchestrator, shouldEscalate } from "../server.js";

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
    const findings = evaluate(db(), "p", [{ id: "m1", content: [{ type: "text", text: "ping\nmore" }] }], [{ number: 508, title: "Start this work" }], [{ number: 493, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", headCommitOid: "head", approvedCommitOids: ["head"], checks: ["SUCCESS"] }]);
    expect(findings.map((f) => f.condition)).toEqual(["queue", "startable", "pr"]);
    expect(findings.map((f) => f.text).join("; ")).toContain('"ping"');
    expect(findings.map((f) => f.text).join("; ")).toContain("#508 Start this work");
    expect(findings.map((f) => f.text).join("; ")).toContain("PR #493 merge-ready and unmerged");
  });
  it("stays silent for legitimate operator waiting", () => {
    expect(evaluate(db(), "p", [], [], [])).toEqual([]);
  });
  it("stays silent when all work is blocked", () => {
    expect(evaluate(db(), "p", [], [], [])).toEqual([]);
  });
  it("stays silent when lanes are active, while reaching the evaluation", () => {
    expect(evaluate(db(1), "p", [{ id: "m1" }], [{ number: 508, title: "Start this work" }], [{ number: 493, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", headCommitOid: "head", approvedCommitOids: ["head"], checks: ["SUCCESS"] }])).toEqual([]);
  });
  it("does not wake for parked queues or non-green PRs", () => {
    expect(evaluate(db(), "p", [], [], [{ number: 493, state: "OPEN", mergeStateStatus: "DIRTY", reviewDecision: "APPROVED", headCommitOid: "head", approvedCommitOids: ["head"], checks: ["SUCCESS"] }])).toEqual([]);
  });
  it("requires clean merge readiness, approval, and successful checks", () => {
    expect(isMergeReady({ number: 1, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", headCommitOid: "head", approvedCommitOids: ["head"], checks: ["SUCCESS"] })).toBe(true);
    for (const pr of [
      { mergeStateStatus: "DIRTY" },
      { reviewDecision: "REVIEW_REQUIRED" },
      { checks: ["SUCCESS", "FAILURE"] },
    ]) expect(isMergeReady({ number: 1, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", headCommitOid: "head", approvedCommitOids: ["head"], checks: ["SUCCESS"], ...pr })).toBe(false);
  });
  it("requires an approval for the current head", () => {
    const pr = { number: 1, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", headCommitOid: "head", approvedCommitOids: ["old"], checks: ["SUCCESS"] };
    expect(isMergeReady(pr)).toBe(false);
    expect(isMergeReady({ ...pr, approvedCommitOids: ["head"] })).toBe(true);
  });
  it("rejects incomplete GitHub payloads instead of treating them as not owed", () => {
    expect(() => parsePullRequests([{ number: 1, state: "OPEN" }])).not.toThrow();
    expect(() => parsePullRequests([{ number: 1, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", headRefOid: "head", reviews: [], statusCheckRollup: [] }])).not.toThrow();
  });
  it("accepts CheckRun conclusions and StatusContext states without suppressing other PRs", () => {
    const invalid: unknown[] = [];
    const prs = parsePullRequests([
      { number: 1, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", headRefOid: "head", reviews: [], statusCheckRollup: [{ state: "SUCCESS" }] },
      { number: 2, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", headRefOid: "head", reviews: [], statusCheckRollup: [{ conclusion: "SUCCESS" }] },
      { number: 3, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", headRefOid: "head", reviews: [], statusCheckRollup: [{ name: "unknown" }] },
    ], (error) => invalid.push(error));
    expect(prs).toHaveLength(2);
    expect(prs.every((pr) => pr.checks?.[0] === "SUCCESS")).toBe(true);
    expect(invalid).toHaveLength(1);
  });
  it("keeps the committed bundle source map in sync", () => {
    const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const map = JSON.parse(readFileSync(new URL("../dist/server.js.map", import.meta.url), "utf8")) as { sourcesContent?: string[] };
    expect(map.sourcesContent).toContain(source);
  });
  it("opens unavailable stores defensively and rereads the current orchestrator head", () => {
    const errors: unknown[] = [];
    expect(openStore("/missing/bb-collab.db", (error) => errors.push(error))).toBeUndefined();
    expect(errors).toHaveLength(1);
    const store = db();
    expect(readOrchestrator(store, "p")).toBe("orch");
    store.prepare("UPDATE execution_attempts SET thread_id='successor' WHERE execution_attempt_id='o'").run();
    expect(readOrchestrator(store, "p")).toBe("successor");
  });
  it("labels store, GitHub, SDK, and wake failures by the caught cause", () => {
    expect(coverageReason("store", "read failed")).toContain("canonical-store-unavailable");
    expect(coverageReason("github", "timeout")).toContain("github-unavailable");
    expect(coverageReason("sdk", "request failed")).toContain("sdk-unavailable");
    expect(coverageReason("wake", "send failed")).toContain("wake-delivery-failed");
  });
  it("requires evidence of a completed turn before escalating", () => {
    const prior = { sentAt: 100, fingerprint: "same", turns: 1 };
    expect(shouldEscalate(prior, undefined, "same")).toBe(false);
    expect(shouldEscalate(prior, 100, "same")).toBe(false);
    expect(shouldEscalate(prior, 101, "same")).toBe(true);
  });
});
