import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const MAX_BODY_BYTES = 4_096;
const MAX_ID_LENGTH = 128;
const MAX_INSTRUCTION_LENGTH = 16_384;
const MAX_TRIGGERS = 1_000;
const MAX_DELIVERIES_PER_TRIGGER = 1_000;
const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TRIGGER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const doorbellInput = z.object({
  triggerId: z.string().regex(TRIGGER_ID),
  deliveryId: z.string().regex(DELIVERY_ID),
}).strict();

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS triggers (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    instruction TEXT NOT NULL CHECK (length(instruction) BETWEEN 1 AND ${MAX_INSTRUCTION_LENGTH}),
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS deliveries (
    trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
    delivery_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'sent')),
    reserved_at_ms INTEGER NOT NULL,
    sent_at_ms INTEGER,
    PRIMARY KEY (trigger_id, delivery_id)
  ) STRICT`,
];

type Db = ReturnType<BbPluginApi["storage"]["database"]>;
type Trigger = {
  id: string;
  project_id: string;
  thread_id: string;
  instruction: string;
  created_at_ms: number;
};
type Delivery = { status: "reserved" | "sent" };

export default function plugin(bb: BbPluginApi): void {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  bb.http.route("POST", "/doorbell", (context) => deliver(bb, db, context), { auth: "token" });
  bb.cli.register({
    name: "external-trigger",
    summary: "Manage project-scoped external thread doorbells",
    commands: [
      {
        name: "create",
        summary: "Bind an exact existing project thread and local instruction",
        usage: "bb external-trigger create --project <id> --thread <id> --instruction <text>",
      },
      {
        name: "list",
        summary: "List triggers and bounded delivery state for a project",
        usage: "bb external-trigger list --project <id>",
      },
      {
        name: "remove",
        summary: "Remove a trigger so future doorbells fail closed",
        usage: "bb external-trigger remove --project <id> --trigger <id>",
      },
    ],
    run: (argv, context) => runCli(bb, db, argv, context.projectId),
  });
}

async function deliver(bb: BbPluginApi, db: Db, context: Parameters<Parameters<BbPluginApi["http"]["route"]>[2]>[0]): Promise<Response> {
  if (context.req.header("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return json({ error: "invalid_request" }, 415);
  }
  const contentLength = Number(context.req.header("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json({ error: "request_too_large" }, 413);
  }

  let raw: string;
  try {
    raw = await context.req.text();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return json({ error: "request_too_large" }, 413);
  }

  let input: z.infer<typeof doorbellInput>;
  try {
    input = doorbellInput.parse(JSON.parse(raw));
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const trigger = readTrigger(db, input.triggerId);
  if (!trigger) return json({ error: "trigger_not_found" }, 404);
  if (!(await exactLiveTarget(bb, trigger))) return json({ error: "target_invalid" }, 409);

  const reservation = reserve(db, trigger, input.deliveryId);
  if (reservation.outcome === "missing") return json({ error: "trigger_not_found" }, 404);
  if (reservation.outcome === "duplicate") {
    return json({ outcome: "duplicate", triggerId: trigger.id, deliveryId: input.deliveryId });
  }
  if (reservation.outcome === "full") return json({ error: "delivery_limit_reached" }, 429);

  try {
    await bb.sdk.threads.send({
      threadId: trigger.thread_id,
      mode: "auto",
      input: [{
        type: "text",
        text: `External event ${input.deliveryId} received for trigger ${trigger.id}.\n${trigger.instruction}`,
        mentions: [],
      }],
    });
  } catch (error) {
    bb.log.warn(`external-trigger: ambiguous delivery retained for ${trigger.id}/${input.deliveryId}: ${describe(error)}`);
    return json({ outcome: "ambiguous", triggerId: trigger.id, deliveryId: input.deliveryId }, 503);
  }

  try {
    const changed = db.prepare(
      `UPDATE deliveries SET status = 'sent', sent_at_ms = ?
       WHERE trigger_id = ? AND delivery_id = ? AND status = 'reserved'`,
    ).run(Date.now(), trigger.id, input.deliveryId).changes;
    if (changed !== 1) {
      bb.log.warn(`external-trigger: delivery settlement ambiguous for ${trigger.id}/${input.deliveryId}`);
      return json({ outcome: "ambiguous", triggerId: trigger.id, deliveryId: input.deliveryId }, 503);
    }
  } catch (error) {
    bb.log.warn(`external-trigger: delivery settlement ambiguous for ${trigger.id}/${input.deliveryId}: ${describe(error)}`);
    return json({ outcome: "ambiguous", triggerId: trigger.id, deliveryId: input.deliveryId }, 503);
  }

  return json({ outcome: "sent", triggerId: trigger.id, deliveryId: input.deliveryId });
}

async function exactLiveTarget(bb: BbPluginApi, trigger: Trigger): Promise<boolean> {
  try {
    const project = await bb.sdk.projects.get({ projectId: trigger.project_id });
    const thread = await bb.sdk.threads.get({ threadId: trigger.thread_id });
    return project.id === trigger.project_id
      && thread.id === trigger.thread_id
      && thread.projectId === trigger.project_id
      && thread.archivedAt === null
      && thread.deletedAt === null;
  } catch {
    return false;
  }
}

function reserve(db: Db, trigger: Trigger, deliveryId: string):
  | { outcome: "reserved" }
  | { outcome: "duplicate" }
  | { outcome: "missing" }
  | { outcome: "full" } {
  return db.transaction((): { outcome: "reserved" | "duplicate" | "missing" | "full" } => {
    if (!readTrigger(db, trigger.id)) return { outcome: "missing" };
    const existing = db.prepare(
      `SELECT status FROM deliveries WHERE trigger_id = ? AND delivery_id = ?`,
    ).get(trigger.id, deliveryId) as Delivery | undefined;
    if (existing) return { outcome: "duplicate" };
    const count = db.prepare(
      `SELECT count(*) AS count FROM deliveries WHERE trigger_id = ?`,
    ).get(trigger.id) as { count: number };
    if (count.count >= MAX_DELIVERIES_PER_TRIGGER) return { outcome: "full" };
    db.prepare(
      `INSERT INTO deliveries (trigger_id, delivery_id, status, reserved_at_ms)
       VALUES (?, ?, 'reserved', ?)`,
    ).run(trigger.id, deliveryId, Date.now());
    return { outcome: "reserved" };
  })();
}

async function runCli(bb: BbPluginApi, db: Db, argv: string[], contextProjectId?: string): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const [command, ...rest] = argv;
  try {
    const args = parseArgs(rest);
    const projectId = required(args, "project");
    if (contextProjectId && contextProjectId !== projectId) throw new Error("project scope mismatch");
    if (command === "create") {
      const threadId = required(args, "thread");
      const instruction = required(args, "instruction");
      if (instruction.length > MAX_INSTRUCTION_LENGTH) throw new Error("instruction too long");
      await assertTarget(bb, projectId, threadId);
      const id = args.trigger ?? randomUUID();
      if (!TRIGGER_ID.test(id)) throw new Error("invalid trigger");
      const createdAt = Date.now();
      db.transaction(() => {
        const count = db.prepare(`SELECT count(*) AS count FROM triggers`).get() as { count: number };
        if (count.count >= MAX_TRIGGERS) throw new Error("trigger limit reached");
        db.prepare(
          `INSERT INTO triggers (id, project_id, thread_id, instruction, created_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(id, projectId, threadId, instruction, createdAt);
      })();
      return { exitCode: 0, stdout: `${JSON.stringify({ id, projectId, threadId })}\n` };
    }
    if (command === "list") {
      const rows = db.prepare(
        `SELECT t.id, t.project_id AS projectId, t.thread_id AS threadId,
                t.created_at_ms AS createdAtMs,
                count(d.delivery_id) AS deliveryCount,
                sum(CASE WHEN d.status = 'reserved' THEN 1 ELSE 0 END) AS reservedCount,
                sum(CASE WHEN d.status = 'sent' THEN 1 ELSE 0 END) AS sentCount
         FROM triggers t LEFT JOIN deliveries d ON d.trigger_id = t.id
         WHERE t.project_id = ? GROUP BY t.id ORDER BY t.created_at_ms, t.id`,
      ).all(projectId);
      return { exitCode: 0, stdout: `${JSON.stringify(rows)}\n` };
    }
    if (command === "remove") {
      const triggerId = required(args, "trigger");
      const removed = db.transaction(() => {
        const result = db.prepare(`DELETE FROM triggers WHERE id = ? AND project_id = ?`).run(triggerId, projectId);
        return result.changes === 1;
      })();
      if (!removed) throw new Error("trigger not found");
      return { exitCode: 0, stdout: `${JSON.stringify({ removed: triggerId })}\n` };
    }
    throw new Error("usage: create, list, or remove");
  } catch (error) {
    return { exitCode: 2, stderr: `${describe(error)}\n` };
  }
}

async function assertTarget(bb: BbPluginApi, projectId: string, threadId: string): Promise<void> {
  const project = await bb.sdk.projects.get({ projectId });
  const thread = await bb.sdk.threads.get({ threadId });
  if (project.id !== projectId || thread.id !== threadId || thread.projectId !== projectId || thread.archivedAt !== null || thread.deletedAt !== null) {
    throw new Error("project/thread identity is not an active exact target");
  }
}

function readTrigger(db: Db, id: string): Trigger | undefined {
  return db.prepare(
    `SELECT id, project_id, thread_id, instruction, created_at_ms FROM triggers WHERE id = ?`,
  ).get(id) as Trigger | undefined;
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--") || token === "--") throw new Error("arguments must use --name value");
    const name = token.slice(2);
    if (!/^(?:project|thread|instruction|trigger)$/u.test(name) || result[name]) throw new Error(`invalid or repeated --${name}`);
    const value = argv[++index];
    if (!value || value.startsWith("--") || value.length > (name === "instruction" ? MAX_INSTRUCTION_LENGTH : MAX_ID_LENGTH)) throw new Error(`invalid --${name}`);
    result[name] = value;
  }
  return result;
}

function required(args: Record<string, string>, name: string): string {
  const value = args[name];
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
