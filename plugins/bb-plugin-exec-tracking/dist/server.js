import { createRequire as __createRequire } from "node:module";
import { dirname as __pathDirname } from "node:path";
import { fileURLToPath as __fileURLToPath } from "node:url";
const require = __createRequire(import.meta.url);
var __filename = __fileURLToPath(import.meta.url);
var __dirname = __pathDirname(__filename);

// server.ts
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
var SCRIPT_REL = path.join("bin", "record_executed_triples.py");
var ROLE_RESOLVER_REL = path.join("bin", "resolve_role_wake.py");
var WAKE_POINTER = "event; inspect canonical state";
var STDOUT_CAP = 4096;
var STDERR_CAP = 4096;
var ROLE_RESOLVER_TIMEOUT_MS = 7e3;
var INFO_MARKERS = ["ignored ", "conflict "];
var RETRY_DELAY_MS = 1e3;
var WAKE_SCHEMA = `CREATE TABLE IF NOT EXISTS role_wake_dedupe (
    project_id TEXT NOT NULL,
    role_thread_id TEXT NOT NULL,
    family TEXT NOT NULL,
    semantic_key TEXT NOT NULL,
    pending INTEGER NOT NULL CHECK (pending IN (0, 1)),
    reservation TEXT,
    PRIMARY KEY (project_id, role_thread_id)
  ) STRICT`;
var WAKE_MIGRATIONS = [WAKE_SCHEMA];
function plugin(bb) {
  const db = bb.storage.database();
  bb.storage.migrate(db, WAKE_MIGRATIONS);
  const retryTimers = /* @__PURE__ */ new Map();
  let loadTimer;
  const scheduleRetry = (target, reservation) => {
    if (retryTimers.has(reservation)) return;
    retryTimers.set(reservation, setTimeout(() => {
      retryTimers.delete(reservation);
      void retryWake(bb, db, target, reservation, scheduleRetry).catch((failure) => {
        bb.log.warn(`exec-tracking: silent wake retry refused: ${describe(failure)}`);
      });
    }, RETRY_DELAY_MS));
  };
  bb.onDispose(() => {
    if (loadTimer) clearTimeout(loadTimer);
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
  });
  const settings = bb.settings.define({
    checkoutPath: {
      type: "string",
      label: "Absolute path to the llm-collab checkout (where bin/, projects.json, and collab.config.json live)"
    },
    pythonPath: {
      type: "string",
      label: "Absolute path to python3.11 (server PATH is narrow; bare python3.11 gave ENOENT)"
    }
  });
  bb.events.on("thread.created", ({ thread }) => {
    void onCreated(bb, settings, thread).catch((error) => {
      bb.log.warn(`exec-tracking: thread.created handler failed: ${describe(error)}`);
    });
  });
  for (const event of ["thread.failed", "thread.archived", "thread.deleted"]) {
    bb.events.on(event, ({ thread, ...payload }) => {
      const error = "error" in payload ? payload.error : null;
      void wakeForThread(bb, settings, db, event, thread, error, scheduleRetry).catch((failure) => {
        bb.log.warn(`exec-tracking: ${event} wake refused for thread ${thread.id}: ${describe(failure)}`);
      });
    });
  }
  bb.events.on("thread.idle", ({ thread }) => {
    void rearmForIdle(bb, settings, db, thread).catch((failure) => {
      bb.log.warn(`exec-tracking: idle re-arm refused for thread ${thread.id}: ${describe(failure)}`);
    });
  });
  bb.cli.register({
    name: "silent-wake",
    summary: "Queue one silent orchestrator pointer from a residual watcher",
    commands: [{
      name: "emit",
      summary: "Emit a pr-artifacts or heartbeat semantic wake",
      usage: "bb silent-wake emit --project <id> --producer <pr-artifacts|heartbeat> --semantic <sha256>"
    }],
    run: (argv) => runWakeCli(bb, settings, db, argv, scheduleRetry)
  });
  loadTimer = setTimeout(() => {
    resumeRetryableWakes(db, scheduleRetry);
    void reconcileAbnormalThreads(bb, settings, db, scheduleRetry).catch((failure) => {
      bb.log.warn(`exec-tracking: load reconcile refused: ${describe(failure)}`);
    });
  }, 0);
}
async function onCreated(bb, settings, thread) {
  const cfg = await settings.get();
  if (!cfg.checkoutPath || !cfg.pythonPath) {
    bb.log.warn(
      "exec-tracking: checkoutPath and pythonPath must be set before triples are recorded"
    );
    return;
  }
  const threadId = thread?.id;
  const threadProject = thread?.projectId;
  if (!threadId || !threadProject) return;
  const provider = thread?.providerId ?? null;
  let resolved;
  try {
    resolved = await bb.sdk.threads.defaultExecutionOptions({ threadId });
  } catch (error) {
    spawnRecorder(bb, cfg, threadId, threadProject, provider, [
      "--unresolved",
      "profile_resolution_error",
      "--failure-detail",
      describe(error)
    ]);
    return;
  }
  const model = resolved?.model ?? null;
  const reasoningLevel = resolved?.reasoningLevel ?? null;
  const source = resolved?.source ?? null;
  if (resolved && model && reasoningLevel && source) {
    spawnRecorder(bb, cfg, threadId, threadProject, provider, [
      "--model",
      model,
      "--reasoning-level",
      reasoningLevel,
      "--source",
      source
    ]);
  } else if (resolved === null) {
    spawnRecorder(bb, cfg, threadId, threadProject, provider, [
      "--unresolved",
      "profile_not_resolved"
    ]);
  } else {
    spawnRecorder(bb, cfg, threadId, threadProject, provider, [
      "--unresolved",
      "profile_incomplete"
    ]);
  }
}
function spawnRecorder(bb, cfg, threadId, threadProject, provider, tripleArgs) {
  const script = path.join(cfg.checkoutPath, SCRIPT_REL);
  const argv = [
    cfg.pythonPath,
    script,
    "--thread-id",
    threadId,
    "--thread-project",
    threadProject,
    ...provider ? ["--provider", provider] : [],
    ...tripleArgs
  ];
  let stderr = "";
  let stdout = "";
  try {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: cfg.checkoutPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < STDOUT_CAP) stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      bb.log.warn(`exec-tracking: recorder spawn failed for thread ${threadId}: ${describe(error)}`);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        bb.log.warn(`exec-tracking: recorder exited ${code} for thread ${threadId}: ${stderr.trim()}`);
        return;
      }
      const line = stdout.trim();
      if (INFO_MARKERS.some((marker) => line.startsWith(marker))) {
        bb.log.info(`exec-tracking: ${line}`);
      }
    });
    child.unref();
  } catch (error) {
    bb.log.warn(`exec-tracking: recorder could not spawn for thread ${threadId}: ${describe(error)}`);
  }
}
async function wakeForThread(bb, settings, db, event, thread, error, scheduleRetry) {
  const semantic = digest([
    event,
    thread.id,
    thread.updatedAt ?? null,
    thread.archivedAt ?? null,
    thread.deletedAt ?? null,
    error
  ]);
  return requestWake(
    bb,
    settings,
    db,
    { threadProject: thread.projectId },
    `worker:${thread.id}`,
    semantic,
    scheduleRetry
  );
}
async function requestWake(bb, settings, db, scope, family, semantic, scheduleRetry) {
  const target = await resolveRole(settings, scope);
  return deliverWake(bb, db, target, family, semantic, scheduleRetry);
}
async function deliverWake(bb, db, target, family, semantic, scheduleRetry) {
  const reservation = randomUUID();
  const claimed = db.prepare(`
    INSERT INTO role_wake_dedupe
      (project_id, role_thread_id, family, semantic_key, pending, reservation)
    VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(project_id, role_thread_id) DO UPDATE SET
      family = excluded.family,
      semantic_key = excluded.semantic_key,
      pending = CASE WHEN role_wake_dedupe.pending = 0 THEN 1 ELSE role_wake_dedupe.pending END,
      reservation = CASE
        WHEN role_wake_dedupe.pending = 0 THEN excluded.reservation
        ELSE role_wake_dedupe.reservation
      END
    WHERE role_wake_dedupe.pending = 0
       OR role_wake_dedupe.family <> excluded.family
       OR role_wake_dedupe.semantic_key <> excluded.semantic_key
    RETURNING reservation
  `).get(target.project_id, target.thread_id, family, semantic, reservation);
  if (claimed?.reservation !== reservation) return "coalesced";
  return sendReservedWake(
    bb,
    db,
    target,
    reservation,
    family,
    semantic,
    scheduleRetry
  );
}
async function sendReservedWake(bb, db, target, reservation, family, semantic, scheduleRetry) {
  const settleConfirmedFailure = db.prepare(`
        UPDATE role_wake_dedupe
        SET
          pending = CASE WHEN family = ? AND semantic_key = ? THEN 0 ELSE 1 END,
          reservation = CASE
            WHEN family = ? AND semantic_key = ? THEN NULL
            ELSE reservation
          END
        WHERE project_id = ? AND role_thread_id = ? AND reservation = ?
        RETURNING family, semantic_key, pending
      `);
  let attemptedFamily = family;
  let attemptedSemantic = semantic;
  while (true) {
    try {
      await bb.sdk.threads.send({
        threadId: target.thread_id,
        input: [{
          type: "text",
          text: WAKE_POINTER,
          mentions: [],
          visibility: "agent-only"
        }],
        mode: "queue-if-active"
      });
      return "accepted";
    } catch (failure) {
      if (isRetryableFailure(failure)) {
        const retryReservation = `retry:${randomUUID()}`;
        const retained = db.prepare(`
          UPDATE role_wake_dedupe
          SET reservation = ?
          WHERE project_id = ? AND role_thread_id = ?
            AND pending = 1 AND reservation = ?
          RETURNING reservation
        `).get(
          retryReservation,
          target.project_id,
          target.thread_id,
          reservation
        );
        if (!retained) return "coalesced";
        scheduleRetry(target, retryReservation);
        bb.log.warn(
          `exec-tracking: silent wake retryable failure for project ${target.project_id} role ${target.thread_id} (${failureStatus(failure)}); retry scheduled`
        );
        return "retrying";
      }
      if (!isConfirmedFailure(failure)) {
        bb.log.warn(
          `exec-tracking: silent wake acceptance ambiguous for project ${target.project_id} role ${target.thread_id}; retry suppressed`
        );
        return "ambiguous";
      }
      const latest = settleConfirmedFailure.get(
        attemptedFamily,
        attemptedSemantic,
        attemptedFamily,
        attemptedSemantic,
        target.project_id,
        target.thread_id,
        reservation
      );
      bb.log.warn(
        `exec-tracking: silent wake confirmed failed for project ${target.project_id} role ${target.thread_id} (${failureStatus(failure)})`
      );
      if (!latest || latest.pending === 0) return "confirmed-failure";
      attemptedFamily = latest.family;
      attemptedSemantic = latest.semantic_key;
    }
  }
}
async function retryWake(bb, db, target, retryReservation, scheduleRetry) {
  if (!retryReservation.startsWith("retry:")) return "coalesced";
  const reservation = randomUUID();
  const claimed = db.prepare(`
    UPDATE role_wake_dedupe
    SET reservation = ?
    WHERE project_id = ? AND role_thread_id = ?
      AND pending = 1 AND reservation = ?
    RETURNING family, semantic_key
  `).get(
    reservation,
    target.project_id,
    target.thread_id,
    retryReservation
  );
  if (!claimed) return "coalesced";
  return sendReservedWake(
    bb,
    db,
    target,
    reservation,
    claimed.family,
    claimed.semantic_key,
    scheduleRetry
  );
}
function resumeRetryableWakes(db, scheduleRetry) {
  const rows = db.prepare(`
    SELECT project_id, role_thread_id, reservation
    FROM role_wake_dedupe
    WHERE pending = 1 AND reservation LIKE 'retry:%'
  `).all();
  for (const row of rows) {
    scheduleRetry(
      { project_id: row.project_id, thread_id: row.role_thread_id },
      row.reservation
    );
  }
}
function rearmWake(db, target, threadId) {
  const family = `worker:${threadId}`;
  db.prepare(`
    UPDATE role_wake_dedupe
    SET pending = 0, reservation = NULL
    WHERE project_id = ? AND role_thread_id = ?
      AND (? = role_thread_id OR family = ?)
  `).run(target.project_id, target.thread_id, threadId, family);
}
async function rearmForIdle(bb, settings, db, thread) {
  const target = await resolveRole(settings, { threadProject: thread.projectId });
  rearmWake(db, target, thread.id);
}
async function runWakeCli(bb, settings, db, argv, scheduleRetry) {
  try {
    const parsed = parseWakeCli(argv);
    const result = await requestWake(
      bb,
      settings,
      db,
      { project: parsed.project },
      parsed.producer,
      parsed.semantic,
      scheduleRetry
    );
    if (result === "confirmed-failure") {
      return { exitCode: 1, stderr: "silent wake confirmed failed; reservation released\n" };
    }
    return { exitCode: 0, stdout: `${result}
` };
  } catch (failure) {
    return { exitCode: 1, stderr: `silent wake refused: ${describe(failure)}
` };
  }
}
function parseWakeCli(argv) {
  if (argv[0] !== "emit" || argv.length !== 7) throw new Error("usage: silent-wake emit --project <id> --producer <pr-artifacts|heartbeat> --semantic <sha256>");
  const values = /* @__PURE__ */ new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith("--") || !value || values.has(flag)) throw new Error("invalid or repeated silent-wake argument");
    values.set(flag, value);
  }
  const project = values.get("--project");
  const producer = values.get("--producer");
  const semantic = values.get("--semantic");
  if (!project || project !== project.trim()) throw new Error("--project must be non-empty unpadded text");
  if (producer !== "pr-artifacts" && producer !== "heartbeat") throw new Error("--producer must be pr-artifacts or heartbeat");
  if (!semantic || !/^[0-9a-f]{64}$/.test(semantic)) throw new Error("--semantic must be a lowercase SHA-256 digest");
  return { project, producer, semantic };
}
async function reconcileAbnormalThreads(bb, settings, db, scheduleRetry) {
  const limit = 200;
  for (let offset = 0; ; offset += limit) {
    const threads = await bb.sdk.threads.list({
      archived: false,
      includeHidden: true,
      limit,
      offset
    });
    for (const thread of threads) {
      if (thread.status === "error" || thread.status === "stopping") {
        await wakeForThread(bb, settings, db, "load.reconcile", thread, null, scheduleRetry);
      }
    }
    if (threads.length < limit) return;
  }
}
async function resolveRole(settings, scope) {
  const cfg = await settings.get();
  if (!cfg.checkoutPath || !cfg.pythonPath) {
    throw new Error("checkoutPath and pythonPath must be configured");
  }
  const script = path.join(cfg.checkoutPath, ROLE_RESOLVER_REL);
  const args = [
    script,
    ..."threadProject" in scope ? ["--thread-project", scope.threadProject] : ["--project", scope.project]
  ];
  const output = await boundedChild(cfg.pythonPath, args, cfg.checkoutPath);
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("role resolver returned malformed JSON");
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.project_id !== "string" || typeof parsed.thread_id !== "string" || !parsed.project_id || !parsed.thread_id) {
    throw new Error("role resolver returned an invalid target");
  }
  return parsed;
}
function boundedChild(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const deadlineAt = Date.now() + ROLE_RESOLVER_TIMEOUT_MS;
    let stdout = "";
    let stderr = "";
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let settled = false;
    const finish = (error, output = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
      error ? reject(error) : resolve(output);
    };
    const abort = (error) => {
      child.kill("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish(error);
    };
    const onStdout = (chunk) => {
      stdout += chunk.toString("utf-8");
      if (stdout.length > STDOUT_CAP) abort(new Error("role resolver output exceeded its bound"));
    };
    const onStderr = (chunk) => {
      stderr += chunk.toString("utf-8");
      if (stderr.length > STDERR_CAP) abort(new Error("role resolver output exceeded its bound"));
    };
    const onError = (error) => finish(error);
    const onClose = (code) => {
      if (stdout.length > STDOUT_CAP || stderr.length > STDERR_CAP) {
        finish(new Error("role resolver output exceeded its bound"));
      } else if (code !== 0) {
        finish(new Error(stderr.trim() || `role resolver exited ${code}`));
      } else {
        finish(void 0, stdout.trim());
      }
    };
    const timer = setTimeout(
      () => abort(new Error(`role resolver exceeded ${ROLE_RESOLVER_TIMEOUT_MS}ms`)),
      Math.max(0, deadlineAt - Date.now())
    );
    timer.unref();
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
  });
}
function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function isConfirmedFailure(failure) {
  const status = failureStatusNumber(failure);
  return status !== null && status >= 400 && status < 500;
}
function isRetryableFailure(failure) {
  const status = failureStatusNumber(failure);
  return status === 408 || status === 425 || status === 429;
}
function failureStatusNumber(failure) {
  if (!failure || typeof failure !== "object" || !("status" in failure)) return null;
  const status = failure.status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}
function failureStatus(failure) {
  return failureStatusNumber(failure)?.toString() ?? "unknown";
}
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
export {
  ROLE_RESOLVER_TIMEOUT_MS,
  WAKE_SCHEMA,
  plugin as default,
  deliverWake,
  rearmWake,
  resumeRetryableWakes,
  retryWake
};
//# sourceMappingURL=server.js.map
