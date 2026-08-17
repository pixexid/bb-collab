import { defineRpcContract, type BbPluginApi, type PluginCliContext } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  OPEN_ATTEMPT_STATES,
  createContinuationLedger,
  createLaneWatcher,
  createWaitRegistry,
  openLaneViews,
  readLaneStates,
  readRoleHolderStates,
  roleQueueScopes,
  subscribeToThreadChanges,
  threadEventStatus,
  type OperatorWait,
  type RoleHolderState,
} from "./src/awareness.js";
import {
  BB_VERSION_RANGE,
  MIGRATIONS,
  MAX_ROLE_CONTEXT_EVENTS,
  PLUGIN_ID,
  PLUGIN_SDK_VERSION,
  assembleV21CachedConsumerRolloutEvidence,
  applyAuthorizedMutation,
  applyRequestSchema,
  approverAttestationRequestSchema,
  authorizedApproverAttestation,
  databaseIsReady,
  doctor,
  exportFoundation,
  canonicalJson,
  operatorReceiptConfirmationSchema,
  operatorReceiptRequestSchema,
  isDerivedActorMutationClass,
  OPERATOR_RECEIPT_RETIREMENT_CONDITION,
  persistBootstrapOperatorReceipt,
  persistInterimOperatorReceipt,
  persistOperatorReceiptWithSessionEvidence,
  probeV21NewLegacyApplyProvenanceRefusal,
  probeV21ConsumedLegacyReplay,
  readOperatorReceiptWithSessionEvidence,
  parseApplyRequest,
  type ApplyRequest,
  type FoundationResult,
  type RoleFactReader,
  type SqliteDatabase,
} from "./src/foundation.js";
import {
  createStallGuardCycle,
  STALL_GUARD_KV_KEY,
  STALL_GUARD_LIVENESS_ALERT_FLAG_FILENAME,
  STALL_GUARD_LIVENESS_MARKER_FILENAME,
  stallGuardStateDir,
} from "./src/stall-guard.js";
import {
  LIVENESS_ALERT_FLAG_FILENAME,
  LIVENESS_MARKER_FILENAME,
  WAIT_ESCALATION_KV_KEY,
  createWaitEscalationCycle,
  LIVENESS_STALE_MS,
  livenessDecision,
  livenessState,
  registerBoundedWait,
  waitValidatorStateDir,
  type SourceObservation,
} from "./src/registered-waits.js";
import { runArchiveSweep } from "./src/archive-sweep.js";
import { findCheckoutRoot, readCheckoutDivergence, type CheckoutDivergence } from "./src/checkout-divergence.js";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

type PluginOptions = { checkoutRoot?: string | null };

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
        issuanceProvenance: z.enum(["console", "attestation"]),
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
const registeredWaitSchema = z.object({
  waitId: sidebarThreadIdSchema,
  waiterThreadId: sidebarThreadIdSchema,
  sourceThreadId: sidebarThreadIdSchema,
  sourceEvent: z.enum(["terminal", "failure"]),
  deadlineAtMs: z.number().int().nonnegative(),
}).strict();
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
  registerWait: {
    input: registeredWaitSchema,
    output: registeredWaitSchema,
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
  cachedConsumerRollout: {
    input: applyRequestSchema,
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
    event: unavailable,
    eventsAfter: unavailable,
    environment: unavailable,
    project: unavailable,
    host: unavailable,
    version: unavailable,
  };
}

export async function readLiveRoleFactReader(
  sdk: BbPluginApi["sdk"],
  serverId: string,
  request: ApplyRequest,
): Promise<RoleFactReader | null> {
  if (!isRoleMutation(request) || !request.roleContext) return null;
  try {
    const exactEvent = async (eventId: string, eventSeq: number) => {
      const events = await sdk.threads.events.list({ threadId: request.roleContext!.threadId, afterSeq: String(eventSeq - 1), limit: "1" });
      if (events.length !== 1) throw new Error("exact role event is unavailable");
      const event = events[0]!;
      if (event.id !== eventId || event.seq !== eventSeq) throw new Error("exact role event identity does not match");
      return { id: event.id, seq: event.seq, type: event.type, data: event.data as Record<string, unknown> };
    };
    const [thread, requestEvent, completionEvent] = await Promise.all([
      sdk.threads.get({ threadId: request.roleContext.threadId }),
      exactEvent(request.roleContext.requestEventId, request.roleContext.requestEventSeq),
      exactEvent(request.roleContext.completionEventId, request.roleContext.completionEventSeq),
    ]);
    const correlationEvents = await sdk.threads.events.list({
      threadId: request.roleContext.threadId,
      afterSeq: String(request.roleContext.requestEventSeq),
      limit: String(MAX_ROLE_CONTEXT_EVENTS + 1),
    });
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
        title: thread.title,
        titleFallback: thread.titleFallback,
        status: thread.status,
        visibility: thread.visibility,
      },
      requestEvent,
      completionEvent,
      correlationEvents: correlationEvents.map((event) => ({ id: event.id, seq: event.seq, type: event.type, data: event.data as Record<string, unknown> })),
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
      event: (threadId, eventId, eventSeq) => {
        if (threadId !== facts.thread.id) return unavailableRoleFactReader(serverId).event(threadId, eventId, eventSeq);
        if (eventId === request.roleContext!.requestEventId && eventSeq === request.roleContext!.requestEventSeq) return structuredClone(facts.requestEvent);
        if (eventId === request.roleContext!.completionEventId && eventSeq === request.roleContext!.completionEventSeq) return structuredClone(facts.completionEvent);
        return unavailableRoleFactReader(serverId).event(threadId, eventId, eventSeq);
      },
      eventsAfter: (threadId, afterSeq, limit) => threadId === facts.thread.id && afterSeq === request.roleContext!.requestEventSeq && limit === MAX_ROLE_CONTEXT_EVENTS + 1
        ? structuredClone(facts.correlationEvents)
        : unavailableRoleFactReader(serverId).eventsAfter(threadId, afterSeq, limit),
      environment: (environmentId) => environmentId === facts.environment.id ? structuredClone(facts.environment) : unavailableRoleFactReader(serverId).environment(environmentId),
      project: (projectId) => projectId === facts.project.id ? structuredClone(facts.project) : unavailableRoleFactReader(serverId).project(projectId),
      host: (hostId) => hostId === facts.host.id ? structuredClone(facts.host) : unavailableRoleFactReader(serverId).host(hostId),
      version: () => facts.version,
    };
  } catch {
    return unavailableRoleFactReader(serverId);
  }
}

async function applyLiveAuthorizedMutation(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  input: unknown,
  allowCachedConsumerRollout = false,
): Promise<FoundationResult> {
  const parsed = applyRequestSchema.safeParse(input);
  if (!allowCachedConsumerRollout && parsed.success && parsed.data.decisionEvidence?.some((evidence) => evidence.evidenceId === "cached-consumer-v21-rollout-receipt")) {
    return cachedConsumerRolloutRefusal(parsed.data.projectId, "cached-consumer rollout evidence is accepted only through the live rollout caller");
  }
  const reader = parsed.success ? await readLiveRoleFactReader(bb.sdk, bb.server.loopbackBaseUrl, parsed.data) : null;
  return applyAuthorizedMutation(db, input, null, reader);
}

function cachedConsumerRolloutRefusal(projectId: string, message: string): FoundationResult {
  return { outcome: "INVALID_INPUT", subject: projectId, expected: 1, attempted: 0, verified: 0, message };
}

type PluginSource = Awaited<ReturnType<BbPluginApi["sdk"]["plugins"]["getSource"]>>;

function resolvedPluginRoot(source: PluginSource): string | null {
  if (!source.resolved.startsWith("path:")) return null;
  const root = source.resolved.slice("path:".length);
  return root.length > 0 ? root : null;
}

export async function isLiveCachedConsumerRolloutArtifact(moduleUrl: string, bb: BbPluginApi): Promise<boolean> {
  try {
    const artifactPath = fileURLToPath(new URL(moduleUrl));
    const pluginRoot = resolvedPluginRoot(await bb.sdk.plugins.getSource({ pluginId: bb.pluginId }));
    if (!pluginRoot || !isAbsolute(pluginRoot)) return false;
    const relativeArtifactPath = relative(pluginRoot, artifactPath);
    if (
      relativeArtifactPath.length === 0
      || relativeArtifactPath === ".."
      || relativeArtifactPath.startsWith(`..${sep}`)
      || isAbsolute(relativeArtifactPath)
    ) return false;
    return basename(artifactPath) === "server.js" && basename(dirname(artifactPath)) === "dist";
  } catch {
    return false;
  }
}

function liveCachedConsumerReread(name: string, result: FoundationResult) {
  const cachedConsumers = (result.evidence as { cachedConsumers?: { newSchemaVersion?: unknown; newContractVersion?: unknown } } | undefined)?.cachedConsumers;
  if (result.outcome !== "OK" || typeof cachedConsumers?.newSchemaVersion !== "number" || typeof cachedConsumers.newContractVersion !== "number") {
    throw new Error(`${name} did not return cached-consumer evidence from the live project`);
  }
  return { observedSchemaVersion: cachedConsumers.newSchemaVersion, observedContractVersion: cachedConsumers.newContractVersion };
}

async function applyLiveCachedConsumerRollout(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  input: unknown,
  cliDeps: WaitValidatorCliDeps,
  cliContext?: PluginCliContext,
): Promise<FoundationResult> {
  const parsed = applyRequestSchema.safeParse(input);
  if (!parsed.success) return cachedConsumerRolloutRefusal("cached-consumer-rollout", parsed.error.message);
  const request = parseApplyRequest(parsed.data);
  if (request.operationClass !== "decision_disposition") {
    return cachedConsumerRolloutRefusal(request.projectId, "cached-consumer rollout requires a governed decision_disposition request");
  }
  if (!(await isLiveCachedConsumerRolloutArtifact(import.meta.url, bb))) {
    return cachedConsumerRolloutRefusal(request.projectId, "cached-consumer rollout requires the running dist/server.js plugin artifact");
  }
  if (!db) return { outcome: "CANONICAL_STORE_UNAVAILABLE", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "canonical SQLite store is unavailable" };
  try {
    const project = await bb.sdk.projects.get({ projectId: request.projectId });
    if (project.id !== request.projectId) return { outcome: "PROJECT_UNKNOWN", subject: request.projectId, expected: 1, attempted: 0, verified: 0, message: "live project identity does not match the rollout request" };
    const evidence = await assembleV21CachedConsumerRolloutEvidence({
      rpcContract: async () => liveCachedConsumerReread("server.rpcContract", await bb.sdk.plugins.callRpc({
        pluginId: bb.pluginId,
        method: "doctor",
        input: { projectId: request.projectId },
        outputSchema: rpcContract.doctor.output,
      }) as FoundationResult),
      collabCli: async () => liveCachedConsumerReread("server.collabCli", foundationResultSchema.parse(JSON.parse(
        (await runCli(db, bb, ["doctor", "--project", request.projectId], cliContext, cliDeps)).stdout,
      )) as FoundationResult),
      consumedLegacyReplay: async () => probeV21ConsumedLegacyReplay(db, request.projectId),
      newLegacyApplyProvenance: async () => probeV21NewLegacyApplyProvenanceRefusal(),
    });
    const supplied = (request.decisionEvidence ?? []).filter((item) => item.evidenceId === evidence.evidenceId);
    if (supplied.length !== 1 || canonicalJson(supplied[0]) !== canonicalJson(evidence)) {
      return cachedConsumerRolloutRefusal(request.projectId, "cached-consumer rollout request must carry the exact live production evidence");
    }
    return applyLiveAuthorizedMutation(bb, db, request, true);
  } catch (error) {
    return cachedConsumerRolloutRefusal(request.projectId, error instanceof Error ? error.message : String(error));
  }
}

interface WaitValidatorCliDeps {
  watcher: import("./src/awareness.js").LaneWatcher;
  registerBoundedWaitForCli: (input: unknown, ctxThreadId?: string) => Promise<import("./src/registered-waits.js").RegisterWaitResult>;
  listWaitsForCli: () => Promise<Array<Record<string, unknown>>>;
  escalationCycle: import("./src/registered-waits.js").WaitEscalationCycle;
  stallGuardCycle: (projectId?: string) => Promise<import("./src/stall-guard.js").StallGuardCycleSummary>;
  archiveSweep: (projectId: string, apply: boolean) => Promise<import("./src/archive-sweep.js").ArchiveSweepResult>;
  readCheckoutDivergence: () => CheckoutDivergence;
}

async function runCli(
  db: SqliteDatabase | null,
  bb: BbPluginApi,
  argv: string[],
  ctx: PluginCliContext | undefined,
  deps: WaitValidatorCliDeps,
) {
  const command = argv[0];
  const args = argv.slice(1);
  if (!command || !["doctor", "export", "apply", "archive-sweep", "cached-consumer-rollout", "wait-register", "wait-list", "wait-validator", "stall-guard"].includes(command)) {
    return invalidCli("expected doctor, export, apply, archive-sweep, cached-consumer-rollout, wait-register, wait-list, wait-validator, or stall-guard");
  }
  if (command === "wait-validator") {
    const unknown = args.find((arg) => arg !== "--cycle");
    if (unknown) return invalidCli(`unexpected argument ${unknown}`);
    if (!args.includes("--cycle")) return invalidCli("--cycle is required: the validator runs exactly one durable cycle per invocation");
    try {
      // One cycle = the watcher's own wait firing/validation pass plus the
      // bounded escalation pass over fired waits. Both are read-only on
      // canonical state and act only through sanctioned seams.
      await deps.watcher.poll();
      const summary = await deps.escalationCycle.cycle();
      return cliResult({
        outcome: "OK",
        subject: "wait-validator",
        expected: 1,
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
  if (command === "stall-guard") {
    const projectFlag = args.indexOf("--project");
    const projectId = parseFlag(args, "--project");
    const expectedLength = projectFlag < 0 ? 1 : 3;
    const unknown = args.find((arg) => arg !== "--cycle" && arg !== "--project" && arg !== projectId);
    if (unknown || args.filter((arg) => arg === "--cycle").length !== 1 || args.filter((arg) => arg === "--project").length > 1 || args.length !== expectedLength) {
      return invalidCli(`unexpected argument ${unknown ?? "duplicate or malformed flag"}`);
    }
    if (!args.includes("--cycle")) return invalidCli("--cycle is required: the stall guard runs exactly one durable cycle per invocation");
    if (projectId === "") return invalidCli("--project PROJECT_ID must be supplied once with a value");
    try {
      await deps.watcher.poll();
      const summary = await deps.stallGuardCycle(projectId ?? undefined);
      return cliResult({
        outcome: "OK",
        subject: "stall-guard",
        expected: summary.observed,
        attempted: summary.steered,
        verified: summary.steered,
        message: "stall-guard cycle complete",
        evidence: summary,
      });
    } catch (error) {
      return cliResult({
        outcome: "INTERNAL_ERROR",
        subject: "stall-guard",
        expected: 1,
        attempted: 0,
        verified: 0,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const projectId = parseFlag(args, "--project");
  if (!projectId) return invalidCli("--project PROJECT_ID is required; CLI context is never used as a fallback");
  if (command === "archive-sweep") {
    if (args.filter((arg) => !["--project", projectId, "--apply"].includes(arg)).length > 0 || args.filter((arg) => arg === "--apply").length > 1) return invalidCli("unexpected archive-sweep argument");
    const result = await deps.archiveSweep(projectId, args.includes("--apply"));
    return cliResult({
      outcome: result.outcome === "refused" ? "INTERNAL_ERROR" : "OK",
      subject: projectId,
      expected: result.archivableThreadIds.length,
      attempted: result.archivedThreadIds.length,
      verified: result.outcome === "refused" ? 0 : result.archivableThreadIds.length,
      message: result.message,
      evidence: result,
    });
  }
  if (command === "wait-register") {
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
    let result: import("./src/registered-waits.js").RegisterWaitResult;
    try {
      result = await deps.registerBoundedWaitForCli(request, ctx?.threadId);
    } catch {
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
      message: result.replay ? "registered wait replayed idempotently" : "registered wait persisted",
      evidence: { wait: result.wait },
    });
  }
  if (command === "wait-list") {
    const unknown = unexpectedFlags(args, ["--project"]);
    if (unknown) return invalidCli(`unexpected flag ${unknown}`);
    let waits: Array<Record<string, unknown>>;
    try {
      waits = await deps.listWaitsForCli();
    } catch {
      return cliResult({ outcome: "INTERNAL_ERROR", subject: projectId, expected: 0, attempted: 0, verified: 0, message: "wait registry state is unreadable; refusing fail closed" });
    }
    return cliResult({
      outcome: "OK",
      subject: projectId,
      expected: waits.length,
      attempted: waits.length,
      verified: waits.length,
      message: `${waits.length} registered waits`,
      evidence: waits,
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
  if (command === "cached-consumer-rollout") {
    const unknown = unexpectedFlags(args, ["--project", "--request"]);
    if (unknown) return invalidCli(`unexpected flag ${unknown}`);
    const requestJson = parseFlag(args, "--request");
    if (!requestJson) return invalidCli("--request JSON is required");
    try {
      const request = JSON.parse(requestJson);
      if (parseApplyRequest(request).projectId !== projectId) return invalidCli("--project does not match request.projectId");
      return cliResult(await applyLiveCachedConsumerRollout(bb, db, request, deps, ctx));
    } catch (error) {
      return invalidCli(error instanceof Error ? error.message : String(error));
    }
  }
  const unknown = unexpectedFlags(args, ["--project"]);
  if (unknown) return invalidCli(`unexpected flag ${unknown}`);
  if (command === "doctor") return cliResult(await doctor(db, bb.sdk, projectId, deps.readCheckoutDivergence()));
  return cliResult(exportFoundation(db, projectId));
}

type OperatorPassphraseRead = { configured: true; secret: string } | { configured: false } | { configured: null };

export default async function plugin(bb: BbPluginApi, options: PluginOptions = {}) {
  const readDiagnosticDivergence = () => readCheckoutDivergence(
    options.checkoutRoot === undefined ? findCheckoutRoot(dirname(fileURLToPath(import.meta.url))) : options.checkoutRoot,
  );
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

  const waitRegistry = createWaitRegistry({
    read: () => bb.storage.kv.get<unknown>("lane-watcher.registered-waits"),
    write: (state) => bb.storage.kv.set("lane-watcher.registered-waits", state),
  });

  // #93 durable wait-validator layer over the one wait registry: the
  // bounded escalation ladder for fired waits and the host-supervised
  // liveness rule. Escalation state lives in the plugin KV seam; canonical
  // SQLite, the resolver, and receipts are never touched.
  const readThreadObservation = async (threadId: string): Promise<SourceObservation> => {
    const thread = await bb.sdk.threads.get({ threadId });
    return thread.archivedAt !== null || thread.deletedAt !== null
      ? { status: thread.status, archived: true }
      : { status: thread.status, archived: false };
  };

  const boundedRegistry = {
    register: (wait: Parameters<typeof waitRegistry.register>[0]) => waitRegistry.register(wait),
    // The store loads lazily; every read recovers first so a cold host never
    // answers an empty list from a populated registry (round-2 finding #4).
    list: async () => { await waitRegistry.recover(); return waitRegistry.list(); },
    firedWaitIds: async () => { await waitRegistry.recover(); return waitRegistry.firedList() as Array<{ waitId: string; reason: string; waiterThreadId: string }>; },
  };
  const escalationCycle = createWaitEscalationCycle({
    registry: boundedRegistry,
    escalationPersistence: {
      read: () => bb.storage.kv.get<unknown>(WAIT_ESCALATION_KV_KEY),
      write: (state) => bb.storage.kv.set(WAIT_ESCALATION_KV_KEY, state),
    },
    readWaiter: readThreadObservation,
    steerWaiter: async (target) => {
      await bb.sdk.threads.send({
        threadId: target.waiterThreadId,
        mode: "steer",
        input: [
          {
            type: "text",
            visibility: "agent-only",
            text: `Registered wait ${target.waitId} fired (${target.reason}). Wake: inspect what you were waiting on, act on it, and record the next step or blocker.`,
            mentions: [],
          },
        ],
      });
    },
    onFire: (record) => {
      bb.log.warn(`registered wait fired: ${record.waitId} (${record.reason})`);
      bb.realtime.publish("wait-validator", { fired: record.waitId, reason: record.reason });
    },
    onEscalate: (record) => {
      bb.log.error(`registered wait escalation: waiter ${record.waiterThreadId} ignored ${record.steers} steers for ${record.waitId}; succession trigger`);
      bb.realtime.publish("wait-validator", { escalated: record.waitId, waiterThreadId: record.waiterThreadId, successionTrigger: true });
    },
  });
  await escalationCycle.recover().catch((error) => bb.log.error(`wait escalation state is unreadable: ${String(error)}`));

  const operatorWaitAlertPersistence = {
    read: () => bb.storage.kv.get<unknown>("lane-watcher.operator-wait-fyi"),
    write: (state: Record<string, true>) => bb.storage.kv.set("lane-watcher.operator-wait-fyi", state),
  };

  const roleIdlePersistence = {
    read: () => bb.storage.kv.get<unknown>("lane-watcher.role-idle"),
    write: (state: Record<string, { steerCount: number; failedSteers: number; escalated: boolean; idleSinceMs: number | null; awaitingSteerOutcome: boolean }>) => bb.storage.kv.set("lane-watcher.role-idle", state),
  };

  const roleLivenessWarnings = new Map<string, string>();
  const roleLivenessKey = (holder: RoleHolderState) => `${holder.project_id}:${holder.role_id}:${holder.role_generation}:${holder.execution_attempt_id}:${holder.thread_id}`;
  const warnRoleLiveness = (holder: RoleHolderState, evidence: string) => {
    const key = roleLivenessKey(holder);
    if (roleLivenessWarnings.get(key) === evidence) return;
    roleLivenessWarnings.set(key, evidence);
    bb.log.warn(`role steer refused: project=${holder.project_id} role=${holder.role_id}@${holder.role_generation} holder=${holder.execution_attempt_id} thread=${holder.thread_id} ${evidence}`);
  };
  const roleThreadRefusal = (
    holder: RoleHolderState,
    thread: Awaited<ReturnType<typeof bb.sdk.threads.get>>,
    requireIdle: boolean,
  ) => {
    const witness = /\bwitness\b/iu.test(`${thread.title ?? ""}\n${thread.titleFallback ?? ""}`);
    const usableStatus = requireIdle ? thread.status === "idle" : thread.status === "idle" || thread.status === "active";
    return thread.projectId === holder.project_id && thread.archivedAt === null && thread.deletedAt === null && !witness && usableStatus
      ? null
      : `observedProject=${thread.projectId} archivedAt=${thread.archivedAt ?? "null"} deletedAt=${thread.deletedAt ?? "null"} status=${thread.status} witness=${witness}`;
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

  const steerRole = async (role: import("./src/awareness.js").RoleIdleView) => {
    if (!db) return false;
    const expectedHolder: RoleHolderState = {
      project_id: role.projectId,
      role_id: role.roleId,
      role_generation: role.roleGeneration,
      execution_attempt_id: role.executionAttemptId,
      thread_id: role.threadId,
    };
    let holders: RoleHolderState[];
    try {
      holders = readRoleHolderStates(db).filter((holder) =>
        holder.project_id === role.projectId &&
        holder.role_id === role.roleId &&
        holder.role_generation === role.roleGeneration &&
        holder.execution_attempt_id === role.executionAttemptId,
      );
    } catch (error) {
      warnRoleLiveness(expectedHolder, `holder=unknown error=${String(error)}`);
      return false;
    }
    if (holders.length !== 1 || holders[0]?.thread_id !== role.threadId) {
      warnRoleLiveness(expectedHolder, `holderMatches=${holders.length} observedThread=${holders[0]?.thread_id ?? "null"}`);
      return false;
    }
    let thread;
    try {
      thread = await bb.sdk.threads.get({ threadId: holders[0].thread_id });
    } catch (error) {
      warnRoleLiveness(holders[0], `liveness=unknown error=${String(error)}`);
      return false;
    }
    const refusal = roleThreadRefusal(holders[0], thread, true);
    if (refusal) {
      warnRoleLiveness(holders[0], refusal);
      return false;
    }
    roleLivenessWarnings.delete(roleLivenessKey(holders[0]));
    await bb.sdk.threads.send({
      threadId: holders[0].thread_id,
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
    return true;
  };

  const watcher = createLaneWatcher({
    readLanes: () => (db ? readLaneStates(db) : []),
    readRoleHolders: () => (db ? readRoleHolderStates(db) : []),
    readRoleScopes,
    roleIdlePersistence,
    continuationLedger,
    waitRegistry,
    operatorWaitAlertPersistence,
    onAlert: (alert) => alert.lane
      ? bb.log.warn(`lane awareness ${alert.kind}: ${alert.lane.laneId} (${alert.count}/${alert.max})`)
      : bb.log.warn(`role awareness ${alert.kind}: ${alert.role.roleId}@${alert.role.roleGeneration} queue ${alert.role.queueHeadId}`),
    onRoleSuccessionRequired: (role) => bb.log.warn(`role succession required: ${role.roleId}@${role.roleGeneration}`),
    isExternallyWaiting: readPendingExternalWait,
    readOperatorWait: readPendingOperatorWaitForThread,
    readWorker: async (threadId) => {
      const roleHolders = db ? readRoleHolderStates(db).filter((holder) => holder.thread_id === threadId) : [];
      let thread;
      try {
        thread = await bb.sdk.threads.get({ threadId });
      } catch (error) {
        for (const holder of roleHolders) warnRoleLiveness(holder, `liveness=unknown error=${String(error)}`);
        throw error;
      }
      let roleThreadRefused = false;
      for (const holder of roleHolders) {
        const refusal = roleThreadRefusal(holder, thread, false);
        if (refusal) {
          roleThreadRefused = true;
          warnRoleLiveness(holder, refusal);
        } else {
          roleLivenessWarnings.delete(roleLivenessKey(holder));
        }
      }
      const archived = thread.archivedAt !== null || thread.deletedAt !== null || roleThreadRefused;
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
        projectId: thread.projectId,
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
      if (!lane.threadId) return;
      if (db && readRoleHolderStates(db).some((holder) => holder.project_id === lane.projectId && holder.thread_id === lane.threadId)) return;
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
    steerRole,
  });
  await watcher.recover().catch((error) => bb.log.error(`lane continuation recovery failed: ${String(error)}`));

  const stallGuardCycle = createStallGuardCycle({
    readRoleHolders: () => (db ? readRoleHolderStates(db) : []),
    readRoleScopes,
    readArtifact: async (holder) => {
      const thread = await bb.sdk.threads.get({ threadId: holder.thread_id });
      if (thread.projectId !== holder.project_id || !thread.environmentId) return { outcome: "absent" };
      const result = await bb.sdk.environments.pullRequest({ environmentId: thread.environmentId });
      return result.outcome === "unavailable" ? null : result;
    },
    steerRole,
    persistence: {
      read: () => bb.storage.kv.get<unknown>(STALL_GUARD_KV_KEY),
      write: (state) => bb.storage.kv.set(STALL_GUARD_KV_KEY, state),
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
        await escalationCycle.cycle().catch((error) => bb.log.warn(`wait escalation failed: ${String(error)}`));
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

  // The self-watch, once: launchd KeepAlive restarts the host-supervised
  // validator loop on death; this schedule is the trivial second check. It
  // alerts the operator exactly once when the liveness marker that loop
  // refreshes every cycle goes stale — meaning launchd itself failed, which
  // is operator territory. A missing marker is never launchd-failure
  // evidence (the agent may not be deployed), so it stays silent.
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
      const configuredStaleMs = Number(process.env.BB_COLLAB_LIVENESS_STALE_MS);
      const staleMs = Number.isFinite(configuredStaleMs) && configuredStaleMs > 0 ? configuredStaleMs : LIVENESS_STALE_MS;
      const decision = livenessDecision(livenessState(markerAtMs, Date.now(), staleMs), existsSync(flagPath));
      if (decision === "clear-alert-flag") rmSync(flagPath, { force: true });
      if (decision === "alert-once") {
        mkdirSync(stateDir, { recursive: true });
        // O_EXCL claim: concurrent checkers cannot both win the one alert.
        try {
          writeFileSync(flagPath, String(Date.now()), { flag: "wx" });
        } catch {
          return; // another checker already claimed this episode's single alert
        }
        bb.log.error("wait-validator liveness marker is stale: host launchd supervision failed; operator attention required");
        bb.realtime.publish("wait-validator", { liveness: "stale", alert: "operator-once" });
      }
    } catch (error) {
      bb.log.warn(`wait-validator liveness check failed: ${String(error)}`);
    }
  });

  bb.background.schedule("stall-guard-liveness", "*/5 * * * *", async () => {
    try {
      const stateDir = stallGuardStateDir();
      const markerPath = join(stateDir, STALL_GUARD_LIVENESS_MARKER_FILENAME);
      const flagPath = join(stateDir, STALL_GUARD_LIVENESS_ALERT_FLAG_FILENAME);
      let markerAtMs: number | null = null;
      try {
        const parsed = Number(readFileSync(markerPath, "utf8").trim());
        markerAtMs = Number.isFinite(parsed) && parsed > 0 ? parsed : statSync(markerPath).mtimeMs;
      } catch {
        markerAtMs = null;
      }
      const configuredStaleMs = Number(process.env.BB_COLLAB_STALL_GUARD_LIVENESS_STALE_MS);
      const staleMs = Number.isFinite(configuredStaleMs) && configuredStaleMs > 0 ? configuredStaleMs : LIVENESS_STALE_MS;
      const decision = livenessDecision(livenessState(markerAtMs, Date.now(), staleMs), existsSync(flagPath));
      if (decision === "clear-alert-flag") rmSync(flagPath, { force: true });
      if (decision === "alert-once") {
        mkdirSync(stateDir, { recursive: true });
        try {
          writeFileSync(flagPath, String(Date.now()), { flag: "wx" });
        } catch {
          return;
        }
        bb.log.error("stall-guard liveness marker is stale: host launchd supervision failed; operator attention required");
        bb.realtime.publish("stall-guard", { liveness: "stale", alert: "operator-once" });
      }
    } catch (error) {
      bb.log.warn(`stall-guard liveness check failed: ${String(error)}`);
    }
  });

  bb.background.schedule("sentinel-wake-floor", "0 * * * *", async () => {
    try {
      await bb.sdk.threads.send({
        threadId: "thr_bpzjyqg7ys",
        mode: "queue-if-active",
        input: [{ type: "text", visibility: "agent-only", text: "Hourly Sentinel health check: verify the fleet against canonical surfaces and report any drift or blocker.", mentions: [] }],
      });
    } catch (error) {
      bb.log.warn(`sentinel-wake-floor failed: ${String(error)}`);
    }
  });

  // This is deliberately a report-only schedule. Archive is available only
  // through the explicit collab archive-sweep --apply command below.
  bb.background.schedule("thread-archive-sweep", "0 * * * *", async () => {
    let projects: Awaited<ReturnType<typeof bb.sdk.projects.list>>;
    try {
      projects = await bb.sdk.projects.list({ includePersonal: true });
    } catch (error) {
      const result = { outcome: "refused" as const, message: `project inventory unavailable: ${String(error)}` };
      bb.log.warn(`thread archive sweep refused: ${result.message}`);
      bb.realtime.publish("thread-archive-sweep", result);
      return;
    }
    for (const project of projects) {
      const result = await runArchiveSweep(bb, db, project.id);
      if (result.outcome === "refused") bb.log.warn(`thread archive sweep refused for project=${project.id}: ${result.message ?? "unknown read failure"}`);
      else bb.log.info(`thread archive sweep reported ${result.archivableThreadIds.length} archivable threads for project=${project.id}`);
      bb.realtime.publish("thread-archive-sweep", { projectId: project.id, ...result });
    }
  });

  const readOpenLaneViews = async () => {
    if (!db) return [];
    const requests = await readOperatorReceiptRequests(bb);
    return openLaneViews(
      db,
      Date.now(),
      new Map(requests.map((request) => [request.callerThreadId, { reason: "awaiting_operator", createdAtMs: request.createdAt } satisfies OperatorWait])),
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

  const cliDeps: WaitValidatorCliDeps = {
    watcher,
    registerBoundedWaitForCli: (input, ctxThreadId) => registerBoundedWait({
      registry: boundedRegistry,
      readSource: readThreadObservation,
      input,
      ctxThreadId,
    }),
    listWaitsForCli: async () => { await waitRegistry.recover(); return waitRegistry.list().map((wait) => ({ ...wait, state: waitRegistry.state(wait.waitId) })); },
    escalationCycle,
    stallGuardCycle: (projectId) => stallGuardCycle.cycle(projectId),
    archiveSweep: (projectId, apply) => runArchiveSweep(bb, db, projectId, apply),
    readCheckoutDivergence: readDiagnosticDivergence,
  };

  bb.rpc.register(rpcContract, {
    lanes() {
      return readOpenLaneViews();
    },
    async registerWait(input) {
      await watcher.registerWait(input);
      return input;
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
      return doctor(db, bb.sdk, input.projectId, readDiagnosticDivergence());
    },
    async export(input) {
      return exportFoundation(db, input.projectId);
    },
    async apply(input) {
      return applyLiveAuthorizedMutation(bb, db, input);
    },
    async cachedConsumerRollout(input) {
      return applyLiveCachedConsumerRollout(bb, db, input, cliDeps);
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
        const receipt = persistInterimOperatorReceipt(db, { ...input, callerPluginId: bb.pluginId, issuanceProvenance: "console" });
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
        name: "cached-consumer-rollout",
        summary: "Persist the live v21 cached-consumer rollout receipt (exact one-request receipt required)",
        usage: "bb collab cached-consumer-rollout --project PROJECT_ID --request JSON",
      },
      {
        name: "wait-register",
        summary: "Register one bounded durable wait (deadline mandatory, fail closed)",
        usage: "bb collab wait-register --project PROJECT_ID --request JSON",
      },
      { name: "wait-list", summary: "List registered waits (read-only)", usage: "bb collab wait-list --project PROJECT_ID" },
      {
        name: "wait-validator",
        summary: "Run one durable wait-validator cycle (host-supervised seam)",
        usage: "bb collab wait-validator --cycle",
      },
      {
        name: "stall-guard",
        summary: "Run one succession-safe stall-guard cycle (host-supervised seam)",
        usage: "bb collab stall-guard --cycle --project PROJECT_ID",
      },
      {
        name: "archive-sweep",
        summary: "Report archivable threads; --apply is explicit and opt-in",
        usage: "bb collab archive-sweep --project PROJECT_ID [--apply]",
      },
    ],
    run(argv, context) {
      return runCli(db, bb, argv, context, cliDeps);
    },
  });

  bb.log.info(`${PLUGIN_ID} loaded for BB ${BB_VERSION_RANGE}; plugin SDK ${PLUGIN_SDK_VERSION}`);
}
