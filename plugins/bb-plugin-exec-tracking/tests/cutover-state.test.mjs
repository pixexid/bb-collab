import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";

const root = resolve(import.meta.dirname, "..");
const helper = join(root, "scripts", "cutover-state.mjs");
const run = (...args) => execFileSync(process.execPath, [helper, ...args], { stdio: "pipe" });

test("cutover helper proves backup, pending refusal, and exact ordered state", () => {
  const directory = mkdtempSync(join(tmpdir(), "exec-cutover-"));
  const database = join(directory, "data.db");
  const backup = join(directory, "backup.db");
  const before = join(directory, "before.json");
  const after = join(directory, "after.json");
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;
    INSERT INTO _bb_migrations VALUES (1, 100);
    CREATE TABLE role_wake_dedupe (
      project_id TEXT NOT NULL, role_thread_id TEXT NOT NULL, family TEXT NOT NULL,
      semantic_key TEXT NOT NULL, pending INTEGER NOT NULL, reservation TEXT,
      PRIMARY KEY (project_id, role_thread_id)
    ) STRICT;
    INSERT INTO role_wake_dedupe VALUES ('project-b', 'thread-b', 'worker:b', 'b', 0, NULL);
    INSERT INTO role_wake_dedupe VALUES ('project-a', 'thread-a', 'worker:a', 'a', 0, NULL);
  `);
  db.close();

  run("capture", database, before);
  run("backup", database, backup);
  run("capture", backup, after);
  run("compare", before, after);
  assert.deepEqual(JSON.parse(readFileSync(before, "utf8")).tables[1].rows.map((row) => row.project_id), ["project-a", "project-b"]);

  const changed = new DatabaseSync(database);
  changed.exec("UPDATE role_wake_dedupe SET pending = 1, reservation = 'in-flight' WHERE project_id = 'project-a'");
  changed.close();
  assert.throws(() => run("capture", database, join(directory, "pending.json")), /pending/);

  const mutant = JSON.parse(readFileSync(before, "utf8"));
  mutant.tables[1].rows[0].semantic_key = "mutated";
  writeFileSync(after, `${JSON.stringify(mutant, null, 2)}\n`);
  assert.throws(() => run("compare", before, after), /snapshots differ/);
});

test("runbook is symlink-only and invokes every cutover-state control", () => {
  const runbook = readFileSync(join(root, "CUTOVER.md"), "utf8");
  assert.doesNotMatch(runbook, /bb plugin (?:remove|install)/);
  assert.doesNotMatch(runbook, /(?:path:\/|\/(?:Users|home|private|Volumes|opt|usr\/local)\/|^[A-Z_]+=\/(?!\/))/m);
  for (const mode of ["capture", "backup", "compare"]) {
    assert.match(runbook, new RegExp(`STATE_HELPER\" ${mode}`));
  }
  assert.match(runbook, /ln -s/);
  assert.match(runbook, /unlink/);
});

test("abnormal preflight blocks only live owned candidates", () => {
  const directory = mkdtempSync(join(tmpdir(), "exec-candidates-"));
  mkdirSync(join(directory, "bin"));
  writeFileSync(join(directory, "bin", "resolve_role_wake.py"), `
const project = process.argv.at(-1);
if (project === "proj_owned") {
  process.stdout.write(JSON.stringify({ project_id: "collab-a", thread_id: "role-a" }));
} else {
  process.stderr.write(\`native bb project '\${project}' has no registered collab owner; refusing wake\\n\`);
  process.exitCode = 1;
}
`);
  const settings = join(directory, "settings.json");
  writeFileSync(settings, JSON.stringify({ values: { checkoutPath: directory, pythonPath: process.execPath } }));
  const rows = [
    { id: "archived-owned", projectId: "proj_owned", status: "error", archivedAt: 1, deletedAt: null },
    { id: "deleted-owned", projectId: "proj_owned", status: "stopping", archivedAt: null, deletedAt: 2 },
    { id: "live-unowned", projectId: "proj_unowned", status: "error", archivedAt: null, deletedAt: null },
  ];
  const threads = join(directory, "threads.json");
  writeFileSync(threads, JSON.stringify(rows));
  const allowed = join(directory, "allowed.json");
  run("abnormal-candidates", threads, settings, allowed);
  assert.deepEqual(JSON.parse(readFileSync(allowed, "utf8")), {
    liveAbnormalCount: 1,
    unowned: [{ id: "live-unowned", projectId: "proj_unowned", status: "error" }],
  });

  writeFileSync(threads, JSON.stringify([...rows,
    { id: "live-owned", projectId: "proj_owned", status: "stopping", archivedAt: null, deletedAt: null },
  ]));
  assert.throws(
    () => run("abnormal-candidates", threads, settings, join(directory, "blocked.json")),
    /live abnormal thread live-owned resolves to a wake owner/,
  );
});
