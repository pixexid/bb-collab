import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { hasActiveWorkers, parseJudgment, readRoleThread, routeJudgment } from "../server.js";

const dbs: Database.Database[] = [];
function db(active = 0) {
  const value = new Database(":memory:"); dbs.push(value);
  value.exec(`CREATE TABLE role_generation_heads (project_id TEXT, role_id TEXT, current_generation INTEGER);
    CREATE TABLE role_generations (project_id TEXT, role_id TEXT, generation INTEGER, holder_execution_attempt_id TEXT);
    CREATE TABLE execution_attempts (project_id TEXT, execution_attempt_id TEXT, thread_id TEXT, origin TEXT, state TEXT);`);
  value.prepare("INSERT INTO role_generation_heads VALUES ('p','project-orchestrator',1)").run();
  value.prepare("INSERT INTO role_generations VALUES ('p','project-orchestrator',1,'o')").run();
  value.prepare("INSERT INTO execution_attempts VALUES ('p','o','orch','role_holder','done')").run();
  for (let i = 0; i < active; i++) value.prepare("INSERT INTO execution_attempts VALUES ('p',?,?,'work_item','running')").run(`a${i}`, `lane${i}`);
  return value;
}
afterEach(() => { while (dbs.length) dbs.pop()!.close(); });

const affirmative = parseJudgment("COVERAGE: known\nFINDING: promised follow-up was not done\nESCALATE: yes");

describe("semantic idle guard", () => {
  it("parses only anchored judgments and degrades malformed coverage to blind", () => {
    expect(affirmative).toMatchObject({ illegitimate: true, coverage: "known" });
    expect(parseJudgment("prefix COVERAGE: known\nFINDING: parked\nESCALATE: yes")).toMatchObject({ illegitimate: true, coverage: "blind" });
    expect(parseJudgment("COVERAGE: partial\nFINDING: parked")).toMatchObject({ illegitimate: false, coverage: "partial" });
    expect(parseJudgment("COVERAGE: known\nESCALATE: yes")).toMatchObject({ illegitimate: false });
  });

  it("silences active workers using the existing non-terminal predicate", () => {
    expect(hasActiveWorkers(db(1), "p")).toBe(true);
    expect(hasActiveWorkers(db(), "p")).toBe(false);
  });

  it("rereads the canonical orchestrator head", () => {
    const store = db();
    expect(readRoleThread(store, "p", "project-orchestrator")).toBe("orch");
    store.prepare("UPDATE execution_attempts SET thread_id='successor' WHERE execution_attempt_id='o'").run();
    expect(readRoleThread(store, "p", "project-orchestrator")).toBe("successor");
  });

  it("backs off unchanged findings, then routes a post-turn repeat to the director", () => {
    const prior = { sentAt: 100, fingerprint: affirmative.fingerprint };
    expect(routeJudgment(prior, affirmative, 200, undefined)).toBeUndefined();
    expect(routeJudgment(prior, affirmative, 600_100, undefined)).toBe("orchestrator");
    expect(routeJudgment(prior, affirmative, 200, 101)).toBe("director");
  });

  it("holds repeated director escalations for 24 hours", () => {
    const prior = { sentAt: 100, fingerprint: affirmative.fingerprint, escalatedAt: 150 };
    expect(routeJudgment(prior, affirmative, 23 * 60 * 60_000, 200)).toBeUndefined();
    expect(routeJudgment(prior, affirmative, 25 * 60 * 60_000, 200)).toBe("director");
  });
});
