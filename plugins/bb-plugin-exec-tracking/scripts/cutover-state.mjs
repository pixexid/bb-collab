#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
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
} else {
  throw new Error("usage: cutover-state.mjs capture|backup|compare <source> <target>");
}
