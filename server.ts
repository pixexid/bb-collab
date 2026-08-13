import { defineRpcContract, type BbPluginApi, type PluginCliContext } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  SUPERVISOR_THREAD_ID,
  createLaneWatcher,
  openLaneViews,
  readLaneStates,
  subscribeToThreadChanges,
  threadEventStatus,
} from "./src/awareness.js";
import {
  BB_VERSION_RANGE,
  MIGRATIONS,
  PLUGIN_ID,
  PLUGIN_SDK_VERSION,
  applyRequestSchema,
  databaseIsReady,
  doctor,
  exportFoundation,
  operatorAuthRequired,
  operatorReceiptConfirmationSchema,
  operatorReceiptRequestSchema,
  OPERATOR_RECEIPT_RETIREMENT_CONDITION,
  persistInterimOperatorReceipt,
  parseApplyRequest,
  type FoundationResult,
  type SqliteDatabase,
} from "./src/foundation.js";

const projectIdSchema = z.string().trim().min(1).max(256);
const mutationReceiptSchema = z
  .object({
    projectId: projectIdSchema,
    idempotencyKey: z.string(),
    operationClass: z.string(),
    requestDigest: z.string(),
    committedEventSequence: z.number().int().positive(),
    createdAtMs: z.number().int().nonnegative(),
  })
  .strict();
const exportSchema = z
  .object({
    manifest: z
      .object({
        schemaVersion: z.number().int().positive(),
        contractVersion: z.number().int().positive(),
        pluginId: z.string(),
        projectId: projectIdSchema,
        migrationStatementIds: z.array(z.number().int().nonnegative()),
        schemaDigest: z.string(),
        contractDigest: z.string(),
        rowCount: z.number().int().nonnegative(),
        tableCounts: z.record(z.string(), z.number().int().nonnegative()),
        recordsDigest: z.string(),
        artifactIndexDigest: z.string(),
        exportRootDigest: z.string(),
      })
      .strict(),
    recordsNdjson: z.string(),
    artifactIndex: z.array(
      z
        .object({
          evidenceId: z.string(),
          evidenceKind: z.string(),
          sourceKind: z.string(),
          sourceRef: z.string(),
          executionAttemptId: z.string().nullable(),
          contentDigest: z.string(),
          redactedJson: z.string(),
          redactedDigest: z.string(),
          durableRefJson: z.string(),
          artifactIdentityDigest: z.string(),
        })
        .strict(),
    ),
    checksums: z.record(z.string(), z.string()),
  })
  .strict();
export const foundationResultSchema = z
  .object({
    outcome: z.string(),
    subject: z.string(),
    expected: z.number().int().nonnegative(),
    attempted: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    message: z.string().optional(),
    currentConfigRevision: z.number().int().positive().optional(),
    expectedConfigRevision: z.number().int().nonnegative().optional(),
    currentGovernanceEpoch: z.number().int().positive().optional(),
    expectedGovernanceEpoch: z.number().int().nonnegative().optional(),
    currentResourceRevision: z.number().int().positive().optional(),
    expectedResourceRevision: z.number().int().positive().optional(),
    mutationReceipt: mutationReceiptSchema.optional(),
    operatorReceipt: z
      .object({
        receiptId: z.string(),
        projectId: projectIdSchema,
        receiptType: z.literal("operator_confirmation"),
        mutationClass: z.string(),
        candidateHead: z.string(),
        bindingDigest: z.string(),
        status: z.literal("interim"),
        retirementCondition: z.literal(OPERATOR_RECEIPT_RETIREMENT_CONDITION),
        callerThreadId: z.string(),
        callerPluginId: z.string(),
        requestedFromBackground: z.boolean(),
        receiptDigest: z.string(),
        createdAtMs: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    eventSequence: z.number().int().positive().optional(),
    evidence: z.unknown().optional(),
    export: exportSchema.optional(),
  })
  .strict();

const laneViewSchema = z
  .object({
    projectId: projectIdSchema,
    laneId: projectIdSchema,
    assignmentId: projectIdSchema,
    assignmentKind: z.enum(["write", "review", "probe"]),
    workItemId: projectIdSchema,
    threadId: projectIdSchema.nullable(),
    executionAttemptId: projectIdSchema,
    attemptState: z.string(),
    workerStatus: z.enum(["active", "idle", "error", "starting", "stopping"]).nullable(),
    waitingOn: z.string().nullable(),
    ageMs: z.number().int().nonnegative(),
    tone: z.enum(["default", "running", "success", "error"]),
  })
  .strict();

const laneListSchema = z.array(laneViewSchema);
const sidebarThreadIdSchema = z.string().trim().min(1).max(256);
const sidebarThreadStateSchema = z.string().trim().min(1).max(64);
const sidebarThreadStateKey = (threadId: string) => `sidebar.thread-state:${threadId}`;

export const rpcContract = defineRpcContract({
  lanes: {
    input: z.object({}).strict(),
    output: laneListSchema,
  },
  threadStates: {
    input: z.object({ threadIds: z.array(sidebarThreadIdSchema).max(256) }).strict(),
    output: z.record(z.string(), sidebarThreadStateSchema),
  },
  setThreadState: {
    input: z.object({ threadId: sidebarThreadIdSchema, state: sidebarThreadStateSchema.nullable() }).strict(),
    output: z.object({ state: sidebarThreadStateSchema.nullable() }).strict(),
  },
  doctor: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: foundationResultSchema,
  },
  export: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: foundationResultSchema,
  },
  apply: {
    input: applyRequestSchema,
    output: foundationResultSchema,
  },
  operatorReceipt: {
    input: operatorReceiptRequestSchema,
    output: foundationResultSchema,
  },
});

function jsonResult(result: FoundationResult): string {
  return JSON.stringify(result);
}

function cliResult(result: FoundationResult) {
  return {
    exitCode: result.outcome === "OK" ? 0 : 2,
    stdout: jsonResult(result),
  };
}

function invalidCli(message: string) {
  return cliResult({
    outcome: "INVALID_INPUT",
    subject: "cli",
    expected: 1,
    attempted: 0,
    verified: 0,
    message,
  });
}

function operatorReceiptResult(
  projectId: string,
  outcome: FoundationResult["outcome"],
  message: string,
  extra: Pick<FoundationResult, "operatorReceipt"> = {},
): FoundationResult {
  return { outcome, subject: projectId, expected: 1, attempted: extra.operatorReceipt ? 1 : 0, verified: extra.operatorReceipt ? 1 : 0, message, ...extra };
}

function parseFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (args.indexOf(name, index + 1) >= 0 || !args[index + 1] || args[index + 1].startsWith("--")) return "";
  return args[index + 1];
}

function unexpectedFlags(args: string[], allowed: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) return arg;
    if (!allowed.includes(arg)) return arg;
    index += 1;
    if (!args[index] || args[index].startsWith("--")) return arg;
  }
  return null;
}

async function runCli(
  db: SqliteDatabase | null,
  sdk: Parameters<typeof doctor>[1],
  argv: string[],
  _ctx: PluginCliContext,
) {
  const command = argv[0];
  const args = argv.slice(1);
  if (!command || !["doctor", "export", "apply"].includes(command)) return invalidCli("expected doctor, export, or apply");
  const projectId = parseFlag(args, "--project");
  if (!projectId) return invalidCli("--project PROJECT_ID is required; CLI context is never used as a fallback");
  if (command === "apply") {
    const unknown = unexpectedFlags(args, ["--project", "--request"]);
    if (unknown) return invalidCli(`unexpected flag ${unknown}`);
    const requestJson = parseFlag(args, "--request");
    if (!requestJson) return invalidCli("--request JSON is required");
    try {
      const request = parseApplyRequest(JSON.parse(requestJson));
      if (request.projectId !== projectId) return invalidCli("--project does not match request.projectId");
      return cliResult(operatorAuthRequired(projectId));
    } catch (error) {
      return invalidCli(error instanceof Error ? error.message : String(error));
    }
  }
  const unknown = unexpectedFlags(args, ["--project"]);
  if (unknown) return invalidCli(`unexpected flag ${unknown}`);
  if (command === "doctor") return cliResult(await doctor(db, sdk, projectId));
  return cliResult(exportFoundation(db, projectId));
}

export default async function plugin(bb: BbPluginApi) {
  let db: SqliteDatabase | null = null;
  try {
    db = bb.storage.database();
    databaseIsReady(db);
    bb.storage.migrate(db, MIGRATIONS);
  } catch (error) {
    bb.log.error(`canonical store unavailable: ${String(error)}`);
    db = null;
  }

  const watcher = createLaneWatcher({
    readLanes: () => (db ? readLaneStates(db) : []),
    steer: async (lane) => {
      await bb.sdk.threads.send({
        threadId: SUPERVISOR_THREAD_ID,
        mode: "steer",
        input: [
          {
            type: "text",
            text: `Lane ${lane.laneId} is open while worker ${lane.threadId ?? "unknown"} is idle without a terminal receipt. Reconcile assignment ${lane.assignmentId}.`,
            mentions: [],
          },
        ],
      });
    },
  });

  const observe = (payload: Parameters<typeof threadEventStatus>[0]) => {
    const { id, status } = threadEventStatus(payload);
    return watcher.observe(id, status);
  };
  bb.events.on("thread.active", (payload) => void observe(payload).catch((error) => bb.log.warn(`lane observation failed: ${String(error)}`)));
  bb.events.on("thread.idle", (payload) => void observe(payload).catch((error) => bb.log.warn(`lane observation failed: ${String(error)}`)));
  bb.events.on("thread.failed", (payload) => void observe(payload).catch((error) => bb.log.warn(`lane observation failed: ${String(error)}`)));
  const unsubscribe = subscribeToThreadChanges(bb.sdk, (threadId, status) => watcher.observe(threadId, status));
  bb.onDispose(unsubscribe);
  bb.background.service("lane-watcher", {
    start(signal) {
      return new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });

  bb.http.route("GET", "/lanes", () =>
    new Response(JSON.stringify(db ? openLaneViews(db) : []), {
      headers: { "content-type": "application/json" },
    }),
  );

  bb.rpc.register(rpcContract, {
    lanes() {
      return db ? openLaneViews(db) : [];
    },
    async threadStates(input) {
      const entries = await Promise.all(input.threadIds.map(async (threadId) => {
        const value = await bb.storage.kv.get<unknown>(sidebarThreadStateKey(threadId));
        const parsed = sidebarThreadStateSchema.safeParse(value);
        return parsed.success ? ([threadId, parsed.data] as const) : null;
      }));
      return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== null));
    },
    async setThreadState(input) {
      if (input.state === null) await bb.storage.kv.delete(sidebarThreadStateKey(input.threadId));
      else await bb.storage.kv.set(sidebarThreadStateKey(input.threadId), input.state);
      return { state: input.state };
    },
    async doctor(input) {
      return doctor(db, bb.sdk, input.projectId);
    },
    async export(input) {
      return exportFoundation(db, input.projectId);
    },
    async apply(input) {
      return operatorAuthRequired(input.projectId);
    },
    async operatorReceipt(input) {
      if (!db) return operatorReceiptResult(input.projectId, "CANONICAL_STORE_UNAVAILABLE", "canonical SQLite store is unavailable");
      const interaction = await bb.ui.requestInput({
        threadId: input.callerThreadId,
        rendererId: "operator-receipt",
        title: "Confirm operator receipt",
        payload: {
          kind: "operator_receipt_confirmation",
          projectId: input.projectId,
          mutationClass: input.mutationClass,
          candidateHead: input.candidateHead,
          retirementCondition: OPERATOR_RECEIPT_RETIREMENT_CONDITION,
          requestedFromBackground: input.requestedFromBackground,
        },
      });
      if (interaction.outcome === "cancelled") {
        return operatorReceiptResult(input.projectId, "OPERATOR_RECEIPT_CANCELLED", `operator confirmation cancelled: ${interaction.reason}`);
      }
      const confirmation = operatorReceiptConfirmationSchema.safeParse(interaction.value);
      if (!confirmation.success) return operatorReceiptResult(input.projectId, "INVALID_INPUT", "operator confirmation form result is invalid");
      if (!confirmation.data.confirmed) return operatorReceiptResult(input.projectId, "OPERATOR_RECEIPT_CANCELLED", "operator confirmation was not accepted");
      if (
        confirmation.data.projectId !== input.projectId ||
        confirmation.data.mutationClass !== input.mutationClass ||
        confirmation.data.candidateHead !== input.candidateHead
      ) {
        return operatorReceiptResult(input.projectId, "OPERATOR_RECEIPT_STALE", "operator confirmation binding is stale");
      }
      try {
        const receipt = persistInterimOperatorReceipt(db, { ...input, callerPluginId: bb.pluginId });
        return operatorReceiptResult(input.projectId, "OK", "interim operator receipt persisted", { operatorReceipt: receipt });
      } catch {
        return operatorReceiptResult(input.projectId, "INTERNAL_ERROR", "interim operator receipt was not persisted");
      }
    },
  });

  bb.cli.register({
    name: "collab",
    summary: "Inspect the bb-collab foundation and guarded conformance boundary",
    commands: [
      { name: "doctor", summary: "Read-only project/store conformance check", usage: "bb collab doctor --project PROJECT_ID" },
      { name: "export", summary: "Deterministic bounded foundation export", usage: "bb collab export --project PROJECT_ID" },
      {
        name: "apply",
        summary: "Explicit foundation apply (operator authentication required)",
        usage: "bb collab apply --project PROJECT_ID --request JSON",
      },
    ],
    run(argv, context) {
      return runCli(db, bb.sdk, argv, context);
    },
  });

  bb.log.info(`${PLUGIN_ID} loaded for BB ${BB_VERSION_RANGE}; plugin SDK ${PLUGIN_SDK_VERSION}`);
}
