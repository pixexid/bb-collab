import { defineRpcContract, type BbPluginApi, type PluginCliContext } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  OPEN_ATTEMPT_STATES,
  SUPERVISOR_THREAD_ID,
  createContinuationLedger,
  createLaneWatcher,
  openLaneViews,
  readLaneStates,
  readRoleHolderStates,
  roleQueueScopes,
  subscribeToThreadChanges,
  threadEventStatus,
  type OperatorWait,
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
  persistOperatorReceiptWithSessionEvidence,
  readOperatorReceiptWithSessionEvidence,
  parseApplyRequest,
  type ApplyRequest,
  type FoundationResult,
  type RoleFactReader,
  type SqliteDatabase,
} from "./src/foundation.js";
import {
  LIVENESS_ALERT_FLAG_FILENAME,
  LIVENESS_MARKER_FILENAME,
  WAIT_ESCALATION_KV_KEY,
  WAIT_REGISTRY_KV_KEY,
  createWaitRegistry,
  createWaitValidator,
  livenessDecision,
  livenessState,
  waitValidatorStateDir,
  type SourceObservation,
} from "./src/registered-waits.js";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
    queueState: z.enum(["ready", "running", "deferred"]),
    queueBlocked: z.boolean(),
    nextStartable: z.boolean(),
    deferredReason: z.literal("awaiting_operator").nullable(),
    deferredAtMs: z.number().int().nonnegative().nullable(),
    deferredAgeMs: z.number().int().nonnegative().nullable(),
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
const operatorReceiptInteractionDataSchema = operatorReceiptRequestSchema.extend({
  kind: z.literal("operator_receipt_confirmation"),
  retirementCondition: z.literal(OPERATOR_RECEIPT_RETIREMENT_CONDITION),
}).strict();
const operatorReceiptRequestViewSchema = z.object({
  interactionId: sidebarThreadIdSchema,
  threadId: sidebarThreadIdSchema,
  projectId: projectIdSchema,
  mutationClass: z.string().min(1),
  candidateHead: z.string().regex(/^[0-9a-f]{40,64}$/u),
  idempotencyKey: z.string().min(1),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  callerThreadId: sidebarThreadIdSchema,
  requestedFromBackground: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().nullable(),
  ageMs: z.number().int().nonnegative(),
}).strict();
const operatorReceiptDecisionSchema = operatorReceiptRequestViewSchema.extend({
  decision: z.enum(["approve", "reject"]),
  passphrase: z.string().optional(),
  approverThreadId: sidebarThreadIdSchema.nullable(),
}).strict();
type OperatorReceiptRequestView = z.infer<typeof operatorReceiptRequestViewSchema>;

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
  operatorReceiptRequests: {
    input: z.object({}).strict(),
    output: z.array(operatorReceiptRequestViewSchema),
  },
  // Whether the secret exists, never what it is. `useSettings()` excludes
  // secret settings, so the console cannot otherwise tell "unset" from
  // "set but not typed yet" — and only the first of those is an onboarding
  // problem the operator can fix. `null` is a third answer, not a default:
  // the read failed, so the console knows nothing rather than accusing the
  // operator of a setup they did do.
  operatorPassphraseState: {
    input: z.object({}).strict(),
    output: z.object({ configured: z.boolean().nullable() }).strict(),
  },
  operatorReceiptDecision: {
    input: operatorReceiptDecisionSchema,
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
  extra: Pick<FoundationResult, "operatorReceipt" | "actorReceiptId" | "evidence"> = {},
): FoundationResult {
  return { outcome, subject: projectId, expected: 1, attempted: extra.operatorReceipt ? 1 : 0, verified: extra.operatorReceipt ? 1 : 0, message, ...extra };
}

function operatorReceiptInteractionData(interaction: unknown, pluginId: string): z.infer<typeof operatorReceiptInteractionDataSchema> | null {
  if (!interaction || typeof interaction !== "object") return null;
  const value = interaction as { status?: unknown; origin?: unknown; payload?: unknown; threadId?: unknown };
  if (value.status !== "pending" || value.threadId === undefined || !value.origin || typeof value.origin !== "object") return null;
  const origin = value.origin as { kind?: unknown; pluginId?: unknown; rendererId?: unknown };
  if (origin.kind !== "plugin" || origin.pluginId !== pluginId || origin.rendererId !== "operator-receipt") return null;
  if (!value.payload || typeof value.payload !== "object") return null;
  const payload = value.payload as { kind?: unknown; data?: unknown };
  if (payload.kind !== "plugin") return null;
  const parsed = operatorReceiptInteractionDataSchema.safeParse(payload.data);
  return parsed.success && parsed.data.callerThreadId === value.threadId ? parsed.data : null;
}

async function readOperatorReceiptRequests(bb: BbPluginApi): Promise<OperatorReceiptRequestView[]> {
  const threads = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: 1000 });
  const pending = await Promise.all(threads.filter((thread) => thread.hasPendingInteraction).map(async (thread) => {
    const interactions = await bb.sdk.threads.interactions.list({ threadId: thread.id }).catch(() => []);
    return interactions.flatMap((interaction) => {
      const data = operatorReceiptInteractionData(interaction, bb.pluginId);
      if (!data) return [];
      const createdAt = typeof interaction.createdAt === "number" ? interaction.createdAt : 0;
      return [{
        interactionId: interaction.id,
        threadId: thread.id,
        projectId: data.projectId,
        mutationClass: data.mutationClass,
        candidateHead: data.candidateHead,
        idempotencyKey: data.idempotencyKey,
        requestDigest: data.requestDigest,
        callerThreadId: data.callerThreadId,
        requestedFromBackground: data.requestedFromBackground,
        createdAt,
        expiresAt: typeof interaction.expiresAt === "number" ? interaction.expiresAt : null,
        ageMs: Math.max(0, Date.now() - createdAt),
      } satisfies OperatorReceiptRequestView];
    });
  }));
  return pending.flat().sort((left, right) => right.createdAt - left.createdAt);
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

interface ValidatorCliDeps {
  waitRegistry: import("./src/registered-waits.js").WaitRegistry;
  waitValidator: import("./src/registered-waits.js").WaitValidator;
  watcher: import("./src/awareness.js").LaneWatcher;
}

async function runCli(
  db: SqliteDatabase | null,
  bb: BbPluginApi,
  argv: string[],
  ctx: PluginCliContext,
  deps: ValidatorCliDeps,
) {
  const command = argv[0];
  const args = argv.slice(1);
  if (!command || !["doctor", "export", "apply", "wait-register", "wait-cancel", "wait-list", "wait-validator"].includes(command)) {
    return invalidCli("expected doctor, export, apply, wait-register, wait-cancel, wait-list, or wait-validator");
  }
  if (command === "wait-validator") {
    const unknown = args.find((arg) => arg !== "--cycle");
    if (unknown) return invalidCli(`unexpected argument ${unknown}`);
    if (!args.includes("--cycle")) return invalidCli("--cycle is required: the validator runs exactly one durable cycle per invocation");
    try {
      await deps.watcher.poll();
      const summary = await deps.waitValidator.cycle();
      return cliResult({
        outcome: "OK",
        subject: "wait-validator",
        expected: summary.evaluated,
        attempted: summary.fired + summary.steered,
        verified: summary.fired,
        message: "durable wait validation cycle complete",
        evidence: summary,
      });
    } catch (error) {
      return cliResult({
        outcome: "INTERNAL_ERROR",
        subject: "wait-validator",
        expected: 1,
        attempted: 0,
        verified: 0,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const projectId = parseFlag(args, "--project");
  if (!projectId) return invalidCli("--project PROJECT_ID is required; CLI context is never used as a fallback");
  if (command === "wait-register" || command === "wait-cancel") {
    const unknown = unexpectedFlags(args, ["--project", "--request"]);
    if (unknown) return invalidCli(`unexpected flag ${unknown}`);
    const requestJson = parseFlag(args, "--request");
    if (!requestJson) return invalidCli("--request JSON is required");
    let request: unknown;
    try {
      request = JSON.parse(requestJson);
    } catch (error) {
      return invalidCli(error instanceof Error ? error.message : String(error));
    }
    const result = command === "wait-register"
      ? await deps.waitRegistry.register(request, ctx.threadId).catch(() => null)
      : await deps.waitRegistry.cancel(request, ctx.threadId).catch(() => null);
    if (result === null) {
      return cliResult({ outcome: "INTERNAL_ERROR", subject: projectId, expected: 1, attempted: 0, verified: 0, message: "wait registry state is unreadable; refusing fail closed" });
    }
    if (result.outcome === "refused") {
      return cliResult({ outcome: "INVALID_INPUT", subject: projectId, expected: 1, attempted: 0, verified: 0, message: result.message });
    }
    return cliResult({
      outcome: "OK",
      subject: projectId,
      expected: 1,
      attempted: 1,
      verified: 1,
      message: result.outcome === "registered" ? (result.replay ? "registered wait replayed idempotently" : "registered wait persisted") : "registered wait cancelled",
      evidence: result.outcome === "registered" ? { wait: result.wait } : { waitId: result.waitId },
    });
  }
  if (command === "wait-list") {
    const unknown = unexpectedFlags(args, ["--project"]);
    if (unknown) return invalidCli(`unexpected flag ${unknown}`);
    const state = await deps.waitRegistry.list();
    return cliResult({
      outcome: "OK",
      subject: projectId,
      expected: state.active.length,
      attempted: state.active.length,
      verified: state.active.length,
      message: `${state.active.length} active registered waits`,
      evidence: state,
    });
  }
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

type OperatorPassphraseRead = { configured: true; secret: string } | { configured: false } | { configured: null };

export default async function plugin(bb: BbPluginApi) {
  const operatorPassphrase = bb.settings.define({
    operatorPassphrase: {
      type: "string",
      label: "Operator approval passphrase",
      description: "Required by the universal Lanes approval console; stored as a secret.",
      secret: true,
    },
  });
  // The one place the secret is read. Tri-state by construction: a failed read
  // is `configured: null`, never `false`, because those are different facts
  // and only `false` is fixable by the operator. Both refuse an approval —
  // only `true` carries material, and only `configured` ever leaves the server.
  const readOperatorPassphrase = async (): Promise<OperatorPassphraseRead> => {
    let values: { operatorPassphrase?: string };
    try {
      values = await operatorPassphrase.get();
    } catch (error) {
      bb.log.error(`operator approval passphrase state unreadable: ${String(error)}`);
      return { configured: null };
    }
    return typeof values.operatorPassphrase === "string" && values.operatorPassphrase !== ""
      ? { configured: true, secret: values.operatorPassphrase }
      : { configured: false };
  };
  let db: SqliteDatabase | null = null;
  try {
    db = bb.storage.database();
    databaseIsReady(db);
    bb.storage.migrate(db, MIGRATIONS);
  } catch (error) {
    bb.log.error(`canonical store unavailable: ${String(error)}`);
    db = null;
  }

  const interactionStateCache = new Map<string, { pending: boolean; operatorWait: OperatorWait | null }>();
  const readPendingExternalWait = async (threadId: string) => {
    const cached = interactionStateCache.get(threadId);
    if (cached) {
      interactionStateCache.delete(threadId);
      return cached.pending;
    }
    try {
      const interactions = await bb.sdk.threads.interactions.list({ threadId });
      return interactions.some((interaction) => interaction.status === "pending");
    } catch {
      return true;
    }
  };

  const readPendingOperatorWaitForThread = async (threadId: string): Promise<OperatorWait | null> => {
    const interactions = await bb.sdk.threads.interactions.list({ threadId });
    const pending = interactions.filter((interaction) => interaction.status === "pending");
    let wait: OperatorWait | null = null;
    for (const interaction of pending) {
      if (!operatorReceiptInteractionData(interaction, bb.pluginId)) continue;
      wait = {
        reason: "awaiting_operator",
        createdAtMs: typeof interaction.createdAt === "number" && Number.isFinite(interaction.createdAt) ? Math.max(0, interaction.createdAt) : 0,
      };
      break;
    }
    if (wait) interactionStateCache.delete(threadId);
    else interactionStateCache.set(threadId, { pending: pending.length > 0, operatorWait: wait });
    return wait;
  };

  const continuationLedger = createContinuationLedger({
    read: () => bb.storage.kv.get<unknown>("lane-watcher.continuations"),
    write: (state) => bb.storage.kv.set("lane-watcher.continuations", state),
  });

  const operatorWaitAlertPersistence = {
    read: () => bb.storage.kv.get<unknown>("lane-watcher.operator-wait-fyi"),
    write: (state: Record<string, true>) => bb.storage.kv.set("lane-watcher.operator-wait-fyi", state),
  };

  const roleIdlePersistence = {
    read: () => bb.storage.kv.get<unknown>("lane-watcher.role-idle"),
    write: (state: Record<string, { steerCount: number; failedSteers: number; escalated: boolean; idleSinceMs: number | null; awaitingSteerOutcome: boolean }>) => bb.storage.kv.set("lane-watcher.role-idle", state),
  };

  const readRoleScopes = async () => {
    if (!db) return [];
    const operatorWaits = new Map<string, OperatorWait>();
    const threadIds = [...new Set(readLaneStates(db)
      .filter((lane) => OPEN_ATTEMPT_STATES.has(lane.attempt_state))
      .map((lane) => lane.thread_id)
      .filter((threadId): threadId is string => threadId !== null))];
    await Promise.all(threadIds.map(async (threadId) => {
      const wait = await readPendingOperatorWaitForThread(threadId);
      if (wait) operatorWaits.set(threadId, wait);
    }));
    return roleQueueScopes(
      openLaneViews(db, Date.now(), operatorWaits),
    );
  };

  // Registered waits (#93 / #57 mechanism 8). Waits are written by the
  // WAITER through the CLI seam at the moment it decides to wait; the
  // validator below only reads them, steers through the same agent-only
  // sdk seam the lane watcher uses, and records dedupe/escalation state in
  // the plugin KV. No canonical SQLite table, resolver, or receipt is ever
  // touched by a wait or by validation.
  const readThreadObservation = async (threadId: string): Promise<SourceObservation> => {
    const thread = await bb.sdk.threads.get({ threadId });
    return thread.archivedAt !== null || thread.deletedAt !== null
      ? { status: thread.status, archived: true }
      : { status: thread.status, archived: false };
  };

  const waitRegistry = createWaitRegistry({
    persistence: {
      read: () => bb.storage.kv.get<unknown>(WAIT_REGISTRY_KV_KEY),
      write: (state) => bb.storage.kv.set(WAIT_REGISTRY_KV_KEY, state),
    },
    readSource: readThreadObservation,
  });

  const waitValidator = createWaitValidator({
    registry: waitRegistry,
    escalationPersistence: {
      read: () => bb.storage.kv.get<unknown>(WAIT_ESCALATION_KV_KEY),
      write: (state) => bb.storage.kv.set(WAIT_ESCALATION_KV_KEY, state),
    },
    readSource: readThreadObservation,
    readWaiter: readThreadObservation,
    readSourceTerminals: () => {
      const terminals = new Map<string, string>();
      if (!db) return terminals;
      for (const lane of readLaneStates(db)) {
        if (!lane.thread_id) continue;
        if (!OPEN_ATTEMPT_STATES.has(lane.attempt_state)) terminals.set(lane.thread_id, `attempt ${lane.attempt_state}`);
        else if (lane.terminal_report_digest !== null) terminals.set(lane.thread_id, "terminal receipt");
      }
      return terminals;
    },
    steerWaiter: async (target) => {
      await bb.sdk.threads.send({
        threadId: target.waiterThreadId,
        mode: "steer",
        input: [
          {
            type: "text",
            visibility: "agent-only",
            text: `Registered wait ${target.waitId} fired (${target.reason}${target.detail ? `: ${target.detail}` : ""}). Wake: inspect what you were waiting on, act on it, and record the next step or blocker.`,
            mentions: [],
          },
        ],
      });
    },
    onFire: (record) => {
      bb.log.warn(`registered wait fired: ${record.waitId} (${record.reason}${record.detail ? `: ${record.detail}` : ""})`);
      bb.realtime.publish("wait-validator", { fired: record.waitId, reason: record.reason });
    },
    onEscalate: (record) => {
      bb.log.error(`registered wait escalation: waiter ${record.waiterThreadId} ignored ${record.steers} steers for ${record.waitId}; succession trigger`);
      bb.realtime.publish("wait-validator", { escalated: record.waitId, waiterThreadId: record.waiterThreadId, successionTrigger: true });
    },
  });
  await waitRegistry.recover().catch((error) => bb.log.error(`wait registry state is unreadable: ${String(error)}`));
  await waitValidator.recover().catch((error) => bb.log.error(`wait escalation state is unreadable: ${String(error)}`));

  const watcher = createLaneWatcher({
    readLanes: () => (db ? readLaneStates(db) : []),
    readRoleHolders: () => (db ? readRoleHolderStates(db) : []),
    readRoleScopes,
    readDispatcherProjectIdentity: async () => (await bb.sdk.threads.get({ threadId: SUPERVISOR_THREAD_ID })).projectId,
    roleIdlePersistence,
    continuationLedger,
    operatorWaitAlertPersistence,
    onAlert: (alert) => alert.lane
      ? bb.log.warn(`lane awareness ${alert.kind}: ${alert.lane.laneId} (${alert.count}/${alert.max})`)
      : bb.log.warn(`role awareness ${alert.kind}: ${alert.role.roleId}@${alert.role.roleGeneration} queue ${alert.role.queueHeadId}`),
    onRoleSuccessionRequired: (role) => bb.log.warn(`role succession required: ${role.roleId}@${role.roleGeneration}`),
    isExternallyWaiting: readPendingExternalWait,
    readOperatorWait: readPendingOperatorWaitForThread,
    readRegisteredWaitFor: async (threadId) => (await waitRegistry.activeWaitsFor(threadId)).length > 0,
    readWorker: async (threadId) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const archived = thread.archivedAt !== null || thread.deletedAt !== null;
      let operatorWait: OperatorWait | null = null;
      let operatorWaitKnown = true;
      if (!archived && thread.status === "idle") {
        try {
          operatorWait = await readPendingOperatorWaitForThread(threadId);
        } catch {
          operatorWaitKnown = false;
        }
      }
      return {
        status: thread.status,
        pendingExternalWait: archived || !operatorWaitKnown
          ? true
          : operatorWait ? true : await readPendingExternalWait(threadId),
        archived,
        operatorWait,
        operatorWaitKnown,
        // Native ThreadResponse has no idle-since field; the role ledger anchors this proxy on first observation.
        idleSinceMs: thread.status === "idle" ? thread.updatedAt : null,
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
            visibility: "agent-only",
            text: `Lane ${lane.laneId} is idle without a terminal receipt or pending external wait. Continue assignment ${lane.assignmentId} and finish with exactly one DONE|BLOCKED terminal receipt.`,
            mentions: [],
          },
        ],
      });
    },
    steerRole: async (role) => {
      await bb.sdk.threads.send({
        threadId: role.threadId,
        mode: "steer",
        input: [
          {
            type: "text",
            visibility: "agent-only",
            text: `Wrongful idle: queue head ${role.queueHeadId} is startable. Inspect the queue and act or record the blocker.`,
            mentions: [],
          },
        ],
      });
    },
  });
  await watcher.recover().catch((error) => bb.log.error(`lane continuation recovery failed: ${String(error)}`));

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
        await waitValidator.cycle().catch((error) => bb.log.warn(`wait validation failed: ${String(error)}`));
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

  // The self-watch, once: launchd KeepAlive restarts the validator process
  // on death; this schedule is the trivial second check. It alerts the
  // operator exactly once when the liveness marker the host-supervised
  // validator refreshes every cycle goes stale — meaning launchd itself
  // failed, which is operator territory. A missing marker is never launchd-
  // failure evidence, so it stays silent.
  bb.background.schedule("wait-validator-liveness", "*/5 * * * *", async () => {
    try {
      const stateDir = waitValidatorStateDir();
      const markerPath = join(stateDir, LIVENESS_MARKER_FILENAME);
      const flagPath = join(stateDir, LIVENESS_ALERT_FLAG_FILENAME);
      let markerAtMs: number | null = null;
      try {
        const parsed = Number(readFileSync(markerPath, "utf8").trim());
        markerAtMs = Number.isFinite(parsed) && parsed > 0 ? parsed : statSync(markerPath).mtimeMs;
      } catch {
        markerAtMs = null;
      }
      const decision = livenessDecision(livenessState(markerAtMs, Date.now()), existsSync(flagPath));
      if (decision === "clear-alert-flag") rmSync(flagPath, { force: true });
      if (decision === "alert-once") {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(flagPath, String(Date.now()));
        bb.log.error("wait-validator liveness marker is stale: host launchd supervision failed; operator attention required");
        bb.realtime.publish("wait-validator", { liveness: "stale", alert: "operator-once" });
      }
    } catch (error) {
      bb.log.warn(`wait-validator liveness check failed: ${String(error)}`);
    }
  });

  const readOpenLaneViews = async () => {
    if (!db) return [];
    const requests = await readOperatorReceiptRequests(bb);
    return openLaneViews(
      db,
      Date.now(),
      new Map(requests.map((request) => [request.callerThreadId, { reason: "awaiting_operator", createdAtMs: request.createdAt } satisfies OperatorWait])),
      await waitRegistry.activeWaiterThreadIds(),
    );
  };

  bb.http.route("GET", "/lanes", async () =>
    new Response(JSON.stringify(await readOpenLaneViews()), {
      headers: { "content-type": "application/json" },
    }),
  );

  // Counts only. A sidebar glyph needs how many are waiting and on which
  // thread; it has no use for the project, candidate head, digest or
  // idempotency key those requests carry, so this surface never carries them.
  bb.http.route("GET", "/operator-receipt-waits", async () => {
    // An unreadable interaction list is not zero waits. Answering a read
    // outage with a non-2xx leaves the client on its last known row status
    // instead of erasing a live approval, and the body carries no read detail.
    const requests = await readOperatorReceiptRequests(bb).catch(() => null);
    if (!requests) {
      return new Response(JSON.stringify({ error: "operator receipt waits unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    const threads: Record<string, number> = {};
    for (const request of requests) threads[request.threadId] = (threads[request.threadId] ?? 0) + 1;
    return new Response(JSON.stringify({ total: requests.length, threads }), {
      headers: { "content-type": "application/json" },
    });
  });

  bb.rpc.register(rpcContract, {
    lanes() {
      return readOpenLaneViews();
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
      const interactionPromise = bb.ui.requestInput({
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
          callerThreadId: input.callerThreadId,
          retirementCondition: OPERATOR_RECEIPT_RETIREMENT_CONDITION,
          requestedFromBackground: input.requestedFromBackground,
        },
      });
      bb.realtime.publish("operator-receipts", { changed: true });
      const interaction = await interactionPromise;
      if (interaction.outcome === "cancelled") {
        bb.realtime.publish("operator-receipts", { changed: true });
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
        if (confirmation.data.operatorReceiptId) {
          const issued = readOperatorReceiptWithSessionEvidence(
            db,
            input,
            confirmation.data.operatorReceiptId,
            confirmation.data.actorReceiptId,
            confirmation.data.evidenceId,
          );
          const { evidenceId, ...receiptResult } = issued;
          return operatorReceiptResult(input.projectId, "OK", "operator receipt and connect-session evidence already persisted", {
            ...receiptResult,
            evidence: { source: "connect-session", evidenceId, interactionId: confirmation.data.interactionId ?? null, workerThreadId: input.callerThreadId },
          });
        }
        if (isDerivedActorMutationClass(input.mutationClass)) {
          const issued = persistBootstrapOperatorReceipt(db, { ...input, callerPluginId: bb.pluginId });
          bb.realtime.publish("operator-receipts", { changed: true });
          return operatorReceiptResult(input.projectId, "OK", "interim operator receipt and derived actor receipt persisted", issued);
        }
        const receipt = persistInterimOperatorReceipt(db, { ...input, callerPluginId: bb.pluginId });
        bb.realtime.publish("operator-receipts", { changed: true });
        return operatorReceiptResult(input.projectId, "OK", "interim operator receipt persisted", { operatorReceipt: receipt });
      } catch {
        return operatorReceiptResult(input.projectId, "INTERNAL_ERROR", "interim operator receipt was not persisted");
      }
    },
    async operatorReceiptRequests() {
      try {
        return await readOperatorReceiptRequests(bb);
      } catch {
        return [];
      }
    },
    async operatorPassphraseState() {
      return { configured: (await readOperatorPassphrase()).configured };
    },
    async operatorReceiptDecision(input) {
      if (!db) return operatorReceiptResult(input.projectId, "CANONICAL_STORE_UNAVAILABLE", "canonical SQLite store is unavailable");
      let interaction: Awaited<ReturnType<typeof bb.sdk.threads.interactions.get>>;
      try {
        interaction = await bb.sdk.threads.interactions.get({ threadId: input.threadId, interactionId: input.interactionId });
      } catch {
        return operatorReceiptResult(input.projectId, "OPERATOR_RECEIPT_UNKNOWN", "pending operator interaction is not known");
      }
      if (interaction.id !== input.interactionId || interaction.threadId !== input.threadId) {
        return operatorReceiptResult(input.projectId, "OPERATOR_RECEIPT_FOREIGN", "operator interaction belongs to another session");
      }
      if (interaction.status !== "pending") {
        return operatorReceiptResult(input.projectId, "OPERATOR_RECEIPT_REUSED", "operator interaction was already resolved");
      }
      const data = operatorReceiptInteractionData(interaction, bb.pluginId);
      if (!data) return operatorReceiptResult(input.projectId, "OPERATOR_RECEIPT_UNKNOWN", "interaction is not a pending operator receipt request");
      if (data.projectId !== input.projectId) {
        return operatorReceiptResult(input.projectId, "OPERATOR_RECEIPT_FOREIGN", "operator receipt belongs to another project");
      }
      if (
        data.mutationClass !== input.mutationClass ||
        data.candidateHead !== input.candidateHead ||
        data.idempotencyKey !== input.idempotencyKey ||
        data.requestDigest !== input.requestDigest ||
        data.callerThreadId !== input.callerThreadId
      ) {
        return operatorReceiptResult(input.projectId, "OPERATOR_RECEIPT_STALE", "operator receipt binding is stale");
      }
      if (input.approverThreadId === data.callerThreadId) {
        return operatorReceiptResult(input.projectId, "OPERATOR_RECEIPT_INVALID", "worker self-approval is not permitted");
      }
      const stored = await readOperatorPassphrase();
      if (!stored.configured || !input.passphrase || input.passphrase !== stored.secret) {
        return operatorReceiptResult(input.projectId, "OPERATOR_RECEIPT_INVALID", "operator approval passphrase is missing or incorrect");
      }
      const confirmation = {
        confirmed: input.decision === "approve",
        projectId: data.projectId,
        mutationClass: data.mutationClass,
        candidateHead: data.candidateHead,
        idempotencyKey: data.idempotencyKey,
        requestDigest: data.requestDigest,
      };
      if (input.decision === "reject") {
        try {
          await bb.sdk.threads.interactions.respond({ threadId: input.threadId, interactionId: input.interactionId, value: confirmation });
          bb.realtime.publish("operator-receipts", { changed: true });
          return operatorReceiptResult(input.projectId, "OPERATOR_RECEIPT_CANCELLED", "operator receipt request rejected", {
            evidence: { source: "connect-session", interactionId: input.interactionId, workerThreadId: data.callerThreadId },
          });
        } catch {
          return operatorReceiptResult(input.projectId, "INTERNAL_ERROR", "operator receipt rejection was not delivered");
        }
      }
      try {
        const issued = persistOperatorReceiptWithSessionEvidence(
          db,
          { ...data, callerThreadId: data.callerThreadId, callerPluginId: bb.pluginId },
          input.interactionId,
        );
        if (!issued) return operatorReceiptResult(input.projectId, "OPERATOR_RECEIPT_REUSED", "operator receipt binding was already issued");
        const { evidenceId, ...receiptResult } = issued;
        const response = {
          ...confirmation,
          operatorReceiptId: receiptResult.operatorReceipt.receiptId,
          ...(receiptResult.actorReceiptId ? { actorReceiptId: receiptResult.actorReceiptId } : {}),
          evidenceId,
          interactionId: input.interactionId,
        };
        await bb.sdk.threads.interactions.respond({ threadId: input.threadId, interactionId: input.interactionId, value: response });
        bb.realtime.publish("operator-receipts", { changed: true });
        return operatorReceiptResult(input.projectId, "OK", "operator receipt persisted and worker interaction resolved", {
          ...receiptResult,
          evidence: { source: "connect-session", evidenceId, interactionId: input.interactionId, workerThreadId: data.callerThreadId },
        });
      } catch {
        return operatorReceiptResult(input.projectId, "INTERNAL_ERROR", "operator receipt approval was not persisted or delivered");
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
      {
        name: "wait-register",
        summary: "Register one bounded durable wait (deadline mandatory, fail closed)",
        usage: "bb collab wait-register --project PROJECT_ID --request JSON",
      },
      { name: "wait-cancel", summary: "Cancel one active registered wait", usage: "bb collab wait-cancel --project PROJECT_ID --request JSON" },
      { name: "wait-list", summary: "List registered waits (read-only)", usage: "bb collab wait-list --project PROJECT_ID" },
      {
        name: "wait-validator",
        summary: "Run one durable wait-validator cycle (host-supervised seam)",
        usage: "bb collab wait-validator --cycle",
      },
    ],
    run(argv, context) {
      return runCli(db, bb, argv, context, { waitRegistry, waitValidator, watcher });
    },
  });

  bb.log.info(`${PLUGIN_ID} loaded for BB ${BB_VERSION_RANGE}; plugin SDK ${PLUGIN_SDK_VERSION}`);
}
