#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exists = (path) => {
  try { lstatSync(path); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

function normalize(value) {
  if (typeof value === "bigint") return { bigint: value.toString() };
  if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString("hex") };
  return value;
}

function snapshot(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.exec("PRAGMA query_only = ON");
  try {
    const schema = db.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all();
    const tables = schema.filter(({ type }) => type === "table").map(({ name }) => {
      const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
      const ordered = [...columns].sort((left, right) => {
        if (left.pk && right.pk) return left.pk - right.pk;
        if (left.pk) return -1;
        if (right.pk) return 1;
        return left.cid - right.cid;
      });
      const order = ordered.length ? ` ORDER BY ${ordered.map(({ name: column }) => quote(column)).join(", ")}` : "";
      const statement = db.prepare(`SELECT * FROM ${quote(name)}${order}`);
      statement.setReadBigInts(true);
      const rows = statement.all()
        .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalize(value)])));
      return { name, columns, rows, rowDigest: digest(rows) };
    });
    const wake = tables.find(({ name }) => name === "role_wake_dedupe");
    if (!wake) throw new Error("role_wake_dedupe is absent");
    const pending = wake.rows.filter(({ pending }) => pending !== 0 && pending?.bigint !== "0");
    if (pending.length) throw new Error(`refused: ${pending.length} role_wake_dedupe row(s) are pending`);
    return {
      schema,
      migrations: tables.find(({ name }) => name === "_bb_migrations")?.rows ?? [],
      tables,
    };
  } finally {
    db.close();
  }
}

function abnormalCandidates(threadsPath, settingsPath) {
  const threads = JSON.parse(readFileSync(threadsPath, "utf8"));
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (!Array.isArray(threads)) throw new Error("refused: thread list is not an array");
  const checkoutPath = settings?.values?.checkoutPath;
  const pythonPath = settings?.values?.pythonPath;
  if (typeof checkoutPath !== "string" || !isAbsolute(checkoutPath)
    || typeof pythonPath !== "string" || !isAbsolute(pythonPath)) {
    throw new Error("refused: resolver settings are absent");
  }
  const candidates = threads.filter((thread) => {
    if (!thread || typeof thread !== "object"
      || typeof thread.id !== "string" || typeof thread.projectId !== "string"
      || !("archivedAt" in thread) || !("deletedAt" in thread) || typeof thread.status !== "string") {
      throw new Error("refused: malformed thread list row");
    }
    return thread.archivedAt === null && thread.deletedAt === null
      && (thread.status === "error" || thread.status === "stopping");
  });
  const unowned = [];
  for (const thread of candidates) {
    if (!/^proj_[a-z0-9]+$/u.test(thread.projectId)) throw new Error("refused: invalid native project id");
    const result = spawnSync(
      pythonPath,
      [join(checkoutPath, "bin", "resolve_role_wake.py"), "--thread-project", thread.projectId],
      { cwd: checkoutPath, encoding: "utf8", timeout: 7_000, maxBuffer: 8_192 },
    );
    if (result.error) throw new Error(`refused: resolver process failed: ${result.error.message}`);
    if (result.status === 0) {
      let target;
      try { target = JSON.parse(result.stdout); } catch { throw new Error("refused: resolver returned malformed JSON"); }
      if (!target || typeof target.project_id !== "string" || !target.project_id
        || typeof target.thread_id !== "string" || !target.thread_id || result.stderr !== "") {
        throw new Error("refused: resolver returned an invalid target");
      }
      throw new Error(`refused: live abnormal thread ${thread.id} resolves to a wake owner`);
    }
    const ordinary = `native bb project '${thread.projectId}' has no registered collab owner; refusing wake\n`;
    if (result.status !== 1 || result.stdout !== "" || result.stderr !== ordinary) {
      throw new Error(`refused: resolver failed unexpectedly for thread ${thread.id}`);
    }
    unowned.push({ id: thread.id, projectId: thread.projectId, status: thread.status });
  }
  return { liveAbnormalCount: candidates.length, unowned };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`refused: malformed ${label}: ${error.message}`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateEngines(value, label) {
  if (!isRecord(value) || typeof value.bb !== "string" || !value.bb
    || typeof value.bbPluginSdk !== "string" || !value.bbPluginSdk
    || Object.values(value).some((engine) => typeof engine !== "string" || !engine)) {
    throw new Error(`refused: malformed ${label} engines`);
  }
}

function validateSource(value, label) {
  if (!isRecord(value) || typeof value.requested !== "string" || !value.requested
    || typeof value.resolved !== "string" || !value.resolved
    || value.requested !== value.resolved
    || !Number.isSafeInteger(value.installedAt) || value.installedAt < 0
    || !Array.isArray(value.history)) {
    throw new Error(`refused: malformed ${label} source`);
  }
  validateEngines(value.engines, label);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  return value;
}

function compareSource(beforePath, afterPath, manifestPath) {
  const before = readJson(beforePath, "pre-source JSON");
  const after = readJson(afterPath, "post-source JSON");
  const manifest = readJson(manifestPath, "candidate package JSON");
  validateSource(before, "pre-source");
  validateSource(after, "post-source");
  if (!isRecord(manifest)) throw new Error("refused: malformed candidate package JSON");
  validateEngines(manifest.engines, "candidate package");
  for (const field of ["requested", "resolved", "installedAt", "history"]) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      throw new Error(`refused: source ${field} changed`);
    }
  }
  if (JSON.stringify(canonicalJson(after.engines)) !== JSON.stringify(canonicalJson(manifest.engines))) {
    throw new Error("refused: post-source engines differ from candidate manifest");
  }
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "capture" && args.length === 2) {
  const [databasePath, outputPath] = args;
  if (exists(outputPath)) throw new Error(`refused: output already exists: ${outputPath}`);
  writeFileSync(outputPath, `${JSON.stringify(snapshot(databasePath), null, 2)}\n`, { flag: "wx", mode: 0o600 });
} else if (mode === "backup" && args.length === 2) {
  const [databasePath, outputPath] = args;
  if (exists(outputPath)) throw new Error(`refused: backup already exists: ${outputPath}`);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    await backup(db, outputPath);
  } finally {
    db.close();
  }
} else if (mode === "compare" && args.length === 2) {
  const [beforePath, afterPath] = args;
  if (readFileSync(beforePath, "utf8") !== readFileSync(afterPath, "utf8")) {
    throw new Error("refused: deterministic database snapshots differ");
  }
} else if (mode === "abnormal-candidates" && args.length === 3) {
  const [threadsPath, settingsPath, outputPath] = args;
  if (exists(outputPath)) throw new Error(`refused: output already exists: ${outputPath}`);
  writeFileSync(outputPath, `${JSON.stringify(abnormalCandidates(threadsPath, settingsPath), null, 2)}\n`, { flag: "wx", mode: 0o600 });
} else if (mode === "compare-source" && args.length === 3) {
  compareSource(...args);
} else {
  throw new Error("usage: cutover-state.mjs capture|backup|compare|abnormal-candidates|compare-source <inputs...>");
}
