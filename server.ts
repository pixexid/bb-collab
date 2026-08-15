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
  applyAuthorizedMutation,
  applyRequestSchema,
  approverAttestationRequestSchema,
  authorizedApproverAttestation,
  databaseIsReady,
  doctor,
  exportFoundation,
  operatorReceiptConfirmationSchema,
  operatorReceiptRequestSchema,
  isDerivedActorMutationClass,
  OPERATOR_RECEIPT_RETIREMENT_CONDITION,
  persistBootstrapOperatorReceipt,
  persistInterimOperatorReceipt,
  parseApplyRequest,
  type ApplyRequest,
  type FoundationResult,
  type RoleFactReader,
  type SqliteDatabase,
} from "./src/foundation.js";

const projectIdSchema = z.string().trim().min(1).max(256);
const mutationReceiptSchema = z
  .object({
    projectId: projectIdSchema,
    idempotencyKey: z.string(),
    operationClass: z.string(),
    requestDigest: z.string(),
    operatorReceiptId: z.string().nullable(),
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
    actorReceiptId: z.string().optional(),
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
        approverId: z.string().nullable(),
        authorizingDecisionId: z.string().nullable(),
        authorizingDispositionSequence: z.number().int().positive().nullable(),
        idempotencyKey: z.string(),
        requestDigest: z.string(),
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
const sidebarReasoningLevelSchema = z.enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]);
const sidebarThreadExecutionSchema = z
  .object({ model: z.string(), reasoning: sidebarReasoningLevelSchema })
  .strict();
const sidebarCollapseKindSchema = z.enum(["project", "thread"]);
const sidebarCollapseKey = (kind: "project" | "thread", id: string) => `sidebar.collapse:${kind}:${id}`;

export const rpcContract = defineRpcContract({
  lanes: {
    input: z.object({}).strict(),
    output: laneListSchema,
  },
  threadStates: {
    input: z.object({ threadIds: z.array(sidebarThreadIdSchema).max(256) }).strict(),
    output: z.record(z.string(), sidebarThreadStateSchema),
  },
  threadModels: {
    input: z.object({ threadIds: z.array(sidebarThreadIdSchema).max(256) }).strict(),
    output: z.record(z.string(), sidebarThreadExecutionSchema.nullable()),
  },
  setThreadState: {
    input: z.object({ threadId: sidebarThreadIdSchema, state: sidebarThreadStateSchema.nullable() }).strict(),
    output: z.object({ state: sidebarThreadStateSchema.nullable() }).strict(),
  },
  sidebarCollapseState: {
    input: z.object({
      projectIds: z.array(sidebarThreadIdSchema).max(256),
      threadIds: z.array(sidebarThreadIdSchema).max(256),
    }).strict(),
    output: z.object({
      projects: z.record(z.string(), z.boolean()),
      threads: z.record(z.string(), z.boolean()),
    }).strict(),
  },
  setSidebarCollapse: {
    input: z.object({ kind: sidebarCollapseKindSchema, id: sidebarThreadIdSchema, collapsed: z.boolean() }).strict(),
    output: z.object({ kind: sidebarCollapseKindSchema, id: sidebarThreadIdSchema, collapsed: z.boolean() }).strict(),
  },
  reorderPinned: {
    input: z.object({
      threadId: sidebarThreadIdSchema,
      previousThreadId: sidebarThreadIdSchema.nullable(),
      nextThreadId: sidebarThreadIdSchema.nullable(),
    }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
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
  approverAttestation: {
    input: approverAttestationRequestSchema,
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
  extra: Pick<FoundationResult, "operatorReceipt" | "actorReceiptId"> = {},
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

function isRoleMutation(request: ApplyRequest): boolean {
  return request.operationClass === "qualification_observation_record" || request.operationClass === "role_generation_succession";
}

function unavailableRoleFactReader(serverId: string): RoleFactReader {
  const unavailable = () => { throw new Error("live role facts are unavailable"); };
  return {
    serverId: () => serverId,
    thread: unavailable,
    events: unavailable,
    environment: unavailable,
    project: unavailable,
    host: unavailable,
    version: unavailable,
  };
}

async function readLiveRoleFactReader(
  sdk: BbPluginApi["sdk"],
  serverId: string,
  request: ApplyRequest,
): Promise<RoleFactReader | null> {
  if (!isRoleMutation(request) || !request.roleContext) return null;
  try {
    const thread = await sdk.threads.get({ threadId: request.roleContext.threadId });
    const events = await sdk.threads.events.list({ threadId: request.roleContext.threadId, limit: "257" });
    const environment = thread.environmentId ? await sdk.environments.get({ environmentId: thread.environmentId }) : null;
    const [project, version, host] = await Promise.all([
      sdk.projects.get({ projectId: request.projectId }),
      sdk.system.version(),
      environment ? sdk.hosts.get({ hostId: environment.hostId }) : Promise.resolve(null),
    ]);
    if (!environment || !host) return unavailableRoleFactReader(serverId);
    const facts = {
      thread: {
        id: thread.id,
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: thread.providerId,
        status: thread.status,
        visibility: thread.visibility,
      },
      events: events.map((event) => ({ id: event.id, seq: event.seq, type: event.type, data: event.data as Record<string, unknown> })),
      environment: {
        id: environment.id,
        projectId: environment.projectId,
        hostId: environment.hostId,
        path: environment.path,
        managed: environment.managed,
        isGitRepo: environment.isGitRepo,
        isWorktree: environment.isWorktree,
        workspaceProvisionType: environment.workspaceProvisionType,
        branchName: environment.branchName,
        baseBranch: environment.baseBranch,
        defaultBranch: environment.defaultBranch,
        mergeBaseBranch: environment.mergeBaseBranch,
        status: environment.status,
      },
      project: {
        id: project.id,
        kind: project.kind,
        name: project.name,
        gitRemoteUrl: project.gitRemoteUrl,
        sources: project.sources.map((source) => ({ id: source.id, projectId: source.projectId, hostId: source.hostId, path: source.path })),
      },
      host: { id: host.id, status: host.status, maxPermissionMode: host.maxPermissionMode },
      version: version.currentVersion,
    };
    return {
      serverId: () => serverId,
      thread: (threadId) => threadId === facts.thread.id ? structuredClone(facts.thread) : unavailableRoleFactReader(serverId).thread(threadId),
      events: (threadId) => threadId === facts.thread.id ? structuredClone(facts.events) : unavailableRoleFactReader(serverId).events(threadId),
      environment: (environmentId) => environmentId === facts.environment.id ? structuredClone(facts.environment) : unavailableRoleFactReader(serverId).environment(environmentId),
      project: (projectId) => projectId === facts.project.id ? structuredClone(facts.project) : unavailableRoleFactReader(serverId).project(projectId),
      host: (hostId) => hostId === facts.host.id ? structuredClone(facts.host) : unavailableRoleFactReader(serverId).host(hostId),
      version: () => facts.version,
    };
  } catch {
    return unavailableRoleFactReader(serverId);
  }
}

async function applyLiveAuthorizedMutation(bb: BbPluginApi, db: SqliteDatabase | null, input: unknown): Promise<FoundationResult> {
  const parsed = applyRequestSchema.safeParse(input);
  const reader = parsed.success ? await readLiveRoleFactReader(bb.sdk, bb.server.loopbackBaseUrl, parsed.data) : null;
  return applyAuthorizedMutation(db, input, null, reader);
}

async function runCli(
  db: SqliteDatabase | null,
  bb: BbPluginApi,
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
      const rawRequest = JSON.parse(requestJson);
      const request = parseApplyRequest(rawRequest);
      if (request.projectId !== projectId) return invalidCli("--project does not match request.projectId");
      return cliResult(await applyLiveAuthorizedMutation(bb, db, rawRequest));
    } catch (error) {
      return invalidCli(error instanceof Error ? error.message : String(error));
    }
  }
  const unknown = unexpectedFlags(args, ["--project"]);
  if (unknown) return invalidCli(`unexpected flag ${unknown}`);
  if (command === "doctor") return cliResult(await doctor(db, bb.sdk, projectId));
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

  const readPendingExternalWait = async (threadId: string) => {
    try {
      const interactions = await bb.sdk.threads.interactions.list({ threadId });
      return interactions.some((interaction) => interaction.status === "pending");
    } catch {
      return true;
    }
  };

  const watcher = createLaneWatcher({
    readLanes: () => (db ? readLaneStates(db) : []),
    isExternallyWaiting: readPendingExternalWait,
    readWorker: async (threadId) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const archived = thread.archivedAt !== null || thread.deletedAt !== null;
      return {
        status: thread.status,
        pendingExternalWait: archived ? true : await readPendingExternalWait(threadId),
        archived,
      };
    },
    steer: async (lane) => {
      if (!lane.threadId || lane.threadId === SUPERVISOR_THREAD_ID) return;
      await bb.sdk.threads.send({
        threadId: lane.threadId,
        mode: "steer",
        input: [
          {
            type: "text",
            text: `Lane ${lane.laneId} is idle without a terminal receipt or pending external wait. Continue assignment ${lane.assignmentId} and finish with exactly one DONE|BLOCKED terminal receipt.`,
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
  bb.events.on("thread.archived", (payload) => void watcher.observe(payload.thread.id, payload.thread.status, false, true).catch((error) => bb.log.warn(`lane observation failed: ${String(error)}`)));
  bb.events.on("thread.deleted", (payload) => void watcher.observe(payload.thread.id, payload.thread.status, false, true).catch((error) => bb.log.warn(`lane observation failed: ${String(error)}`)));
  const unsubscribe = subscribeToThreadChanges(bb.sdk, (threadId, status, archived = false) => watcher.observe(threadId, status, undefined, archived));
  bb.onDispose(unsubscribe);
  bb.background.service("lane-watcher", {
    async start(signal) {
      while (!signal.aborted) {
        await watcher.poll().catch((error) => bb.log.warn(`lane poll failed: ${String(error)}`));
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          timer = setTimeout(done, 1_000);
          signal.addEventListener("abort", done, { once: true });
        });
      }
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
    async threadModels(input) {
      const entries = await Promise.all(input.threadIds.map(async (threadId) => {
        try {
          const options = await bb.sdk.threads.defaultExecutionOptions({ threadId });
          // Model and reasoning are only ever the host's resolved facts; an
          // absent option set stays absent rather than becoming a default.
          return [threadId, options ? { model: options.model, reasoning: options.reasoningLevel } : null] as const;
        } catch {
          return [threadId, null] as const;
        }
      }));
      return Object.fromEntries(entries);
    },
    async setThreadState(input) {
      if (input.state === null) await bb.storage.kv.delete(sidebarThreadStateKey(input.threadId));
      else await bb.storage.kv.set(sidebarThreadStateKey(input.threadId), input.state);
      return { state: input.state };
    },
    async sidebarCollapseState(input) {
      const read = async (kind: "project" | "thread", ids: readonly string[]) => {
        const entries = await Promise.all(ids.map(async (id) => {
          const value = await bb.storage.kv.get<unknown>(sidebarCollapseKey(kind, id));
          return value === true ? ([id, true] as const) : null;
        }));
        return Object.fromEntries(entries.filter((entry): entry is readonly [string, true] => entry !== null));
      };
      return {
        projects: await read("project", input.projectIds),
        threads: await read("thread", input.threadIds),
      };
    },
    async setSidebarCollapse(input) {
      const key = sidebarCollapseKey(input.kind, input.id);
      if (input.collapsed) await bb.storage.kv.set(key, true);
      else await bb.storage.kv.delete(key);
      return input;
    },
    async reorderPinned(input) {
      await bb.sdk.threads.reorderPinned(input);
      return { ok: true as const };
    },
    async doctor(input) {
      return doctor(db, bb.sdk, input.projectId);
    },
    async export(input) {
      return exportFoundation(db, input.projectId);
    },
    async apply(input) {
      return applyLiveAuthorizedMutation(bb, db, input);
    },
    async operatorReceipt(input) {
      if (!db) return operatorReceiptResult(input.projectId, "CANONICAL_STORE_UNAVAILABLE", "canonical SQLite store is unavailable");
      const interaction = await bb.ui.requestInput({
        threadId: input.callerThreadId,
        rendererId: "operator-receipt",
        title: "Confirm operator receipt",
        timeoutMs: 3_600_000,
        payload: {
          kind: "operator_receipt_confirmation",
          projectId: input.projectId,
          mutationClass: input.mutationClass,
          candidateHead: input.candidateHead,
          idempotencyKey: input.idempotencyKey,
          requestDigest: input.requestDigest,
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
        confirmation.data.candidateHead !== input.candidateHead ||
        confirmation.data.idempotencyKey !== input.idempotencyKey ||
        confirmation.data.requestDigest !== input.requestDigest
      ) {
        return operatorReceiptResult(input.projectId, "OPERATOR_RECEIPT_STALE", "operator confirmation binding is stale");
      }
      try {
        if (isDerivedActorMutationClass(input.mutationClass)) {
          const issued = persistBootstrapOperatorReceipt(db, { ...input, callerPluginId: bb.pluginId });
          return operatorReceiptResult(input.projectId, "OK", "interim operator receipt and derived actor receipt persisted", issued);
        }
        const receipt = persistInterimOperatorReceipt(db, { ...input, callerPluginId: bb.pluginId });
        return operatorReceiptResult(input.projectId, "OK", "interim operator receipt persisted", { operatorReceipt: receipt });
      } catch {
        return operatorReceiptResult(input.projectId, "INTERNAL_ERROR", "interim operator receipt was not persisted");
      }
    },
    approverAttestation(input) {
      return authorizedApproverAttestation(db, input, bb.pluginId);
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
        summary: "Explicit foundation apply (exact one-request receipt required)",
        usage: "bb collab apply --project PROJECT_ID --request JSON",
      },
    ],
    run(argv, context) {
      return runCli(db, bb, argv, context);
    },
  });

  bb.log.info(`${PLUGIN_ID} loaded for BB ${BB_VERSION_RANGE}; plugin SDK ${PLUGIN_SDK_VERSION}`);
}
