import { defineRpcContract, type BbPluginApi, type PluginCliContext } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  createContinuationLedger,
  createLaneWatcher,
  createRoleIdleLedger,
  createWaitRegistry,
  readRoleHolderStates,
  roleIdleKey,
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
  databaseIsReady,
  doctor,
  exportFoundation,
  canonicalJson,
  probeV21NewLegacyApplyProvenanceRefusal,
  probeV21ConsumedLegacyReplay,
  parseApplyRequest,
  writingLaneCeilingFromJson,
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
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

type PluginOptions = { checkoutRoot?: string | null };
type WorkItemWait = NonNullable<ApplyRequest["workItemWait"]>;

function githubRepository(remoteUrl: string | null): string | null {
  const match = remoteUrl?.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?$/u);
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : null;
}

function startableQueueDepth(repositories: string[]): number | null {
  try {
    let count = 0;
    for (const repository of repositories) {
      const options: SpawnSyncOptionsWithStringEncoding & { detached: true } = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, killSignal: "SIGKILL", detached: true };
      const result = spawnSync("gh", ["issue", "list", "--repo", repository, "--label", "queue:startable", "--state", "open", "--json", "number", "--limit", "1000"], options);
      if (typeof result.pid === "number" && result.pid > 0) {
        try {
          process.kill(-result.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return null;
        }
      }
      if (result.error || result.status !== 0) return null;
      const issues = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(issues) || !issues.every((issue) => issue && typeof issue === "object" && !Array.isArray(issue) && typeof (issue as { number?: unknown }).number === "number")) return null;
      count += issues.length;
    }
    return count;
  } catch {
    return null;
  }
}

export const FLEET_WATCHDOG_FLOOR_MS = 60 * 60_000;
export const FLEET_WATCHDOG_STALE_WAIT_MS = 24 * 60 * 60_000;
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
    actorReceiptId: z.string().optional(),
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
const registeredWaitInputSchema = z.object({
  waitId: sidebarThreadIdSchema,
  waiterThreadId: sidebarThreadIdSchema,
  sourceThreadId: sidebarThreadIdSchema,
  sourceEvent: z.enum(["terminal", "failure"]),
  deadlineAtMs: z.number().int().nonnegative(),
  wakerSchedule: sidebarThreadIdSchema,
}).strict();
const registeredWaitSchema = registeredWaitInputSchema.extend({
  declaredAtMs: z.number().int().nonnegative(),
}).strict();
const sidebarThreadStateSchema = z.string().trim().min(1).max(64);
const sidebarThreadStateKey = (threadId: string) => `sidebar.thread-state:${threadId}`;
const sidebarReasoningLevelSchema = z.enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]);
const sidebarThreadExecutionSchema = z
  .object({ model: z.string(), reasoning: sidebarReasoningLevelSchema })
  .strict();
const sidebarCollapseKindSchema = z.enum(["project", "thread"]);
const sidebarCollapseKey = (kind: "project" | "thread", id: string) => `sidebar.collapse:${kind}:${id}`;
const roleBriefRoleSchema = z.enum(["director", "orchestrator", "worker"]);
const roleBriefBundleSchema = z.object({
  ponytail: z.string().min(1),
  rules: z.string().min(1),
  roles: z.object({ director: z.string().min(1), orchestrator: z.string().min(1), worker: z.string().min(1) }).strict(),
}).strict();
const roleBriefSchema = z.object({
  role: roleBriefRoleSchema,
  roleContent: z.string().min(1),
  ponytail: z.string().min(1),
  rules: z.string().min(1),
  project: z.object({ id: projectIdSchema, name: z.string(), sourceIds: z.array(z.string()) }).strict(),
  pointers: z.object({ canonicalStoreQuery: z.string(), handoffFile: z.string(), currentSeats: z.array(z.object({ roleId: z.string(), generation: z.number().int().positive(), threadId: z.string() }).strict()) }).strict(),
  prompt: z.string().min(1),
}).strict();
export const rpcContract = defineRpcContract({
  lanes: {
    input: z.object({}).strict(),
    output: laneListSchema,
  },
  registerWait: {
    input: registeredWaitInputSchema,
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
  cachedConsumerRollout: {
    input: applyRequestSchema,
    output: foundationResultSchema,
  },
  roleBrief: {
    input: z.object({ projectId: projectIdSchema, role: roleBriefRoleSchema }).strict(),
    output: roleBriefSchema,
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
  if (parsed.success && parsed.data.workItemWait !== undefined && parsed.data.workItemWait !== null) {
    try {
      if (!await liveWorkItemWaker(bb, db, parsed.data.projectId, parsed.data.workItemWait)) {
        const waker = parsed.data.workItemWait.kind === "schedule" ? `schedule ${parsed.data.workItemWait.schedule}` : `seat ${parsed.data.workItemWait.seat}`;
        return { outcome: "INVALID_INPUT", subject: parsed.data.projectId, expected: 1, attempted: 0, verified: 0, message: `waker ${waker} is not live: declaration refused` };
      }
    } catch {
      return { outcome: "INVALID_INPUT", subject: parsed.data.projectId, expected: 1, attempted: 0, verified: 0, message: `waker ${parsed.data.workItemWait.kind} registry is unreadable: declaration refused` };
    }
  }
  const reader = parsed.success ? await readLiveRoleFactReader(bb.sdk, bb.server.loopbackBaseUrl, parsed.data) : null;
  const result = applyAuthorizedMutation(db, input, null, reader);
  await deliverSucceededSeatBrief(bb, db, input, result);
  return result;
}

async function liveWorkItemWaker(bb: BbPluginApi, db: SqliteDatabase | null, projectId: string, waker: WorkItemWait): Promise<boolean> {
  if (waker.kind === "seat") {
    return db !== null && readRoleHolderStates(db).filter((holder) => holder.project_id === projectId && holder.role_id === waker.seat).length === 1;
  }
  return liveWaker(bb, waker.schedule);
}

async function liveWaker(bb: BbPluginApi, schedule: string): Promise<boolean> {
  const plugins = await bb.sdk.plugins.list();
  return plugins.plugins.some((plugin) => plugin.id === bb.pluginId && plugin.status === "running" && plugin.schedules.some((candidate) => candidate.name === schedule));
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

function roleBriefBundlePath(): string {
  const bundled = fileURLToPath(new URL("./role-briefs.json", import.meta.url));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL("./dist/role-briefs.json", import.meta.url));
}

function roleForThread(db: SqliteDatabase | null, projectId: string, threadId: string): z.infer<typeof roleBriefRoleSchema> {
  const roleId = db ? readRoleHolderStates(db).find((holder) => holder.project_id === projectId && holder.thread_id === threadId)?.role_id : null;
  return roleId === "director" ? "director" : roleId === "project-orchestrator" ? "orchestrator" : "worker";
}

function roleBriefRole(roleId: string): z.infer<typeof roleBriefRoleSchema> {
  return roleId === "director" ? "director" : roleId === "project-orchestrator" ? "orchestrator" : "worker";
}

async function composeRoleBrief(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  input: z.infer<typeof rpcContract["roleBrief"]["input"]>,
): Promise<z.infer<typeof roleBriefSchema>> {
  const bundle = roleBriefBundleSchema.parse(JSON.parse(readFileSync(roleBriefBundlePath(), "utf8")));
  const project = await bb.sdk.projects.get({ projectId: input.projectId });
  const currentSeats = (db ? readRoleHolderStates(db) : [])
    .filter((holder) => holder.project_id === input.projectId)
    .map((holder) => ({ roleId: holder.role_id, generation: holder.role_generation, threadId: holder.thread_id }));
  const pointers = {
    canonicalStoreQuery: "role_generation_heads joined to role_generations",
    handoffFile: "handoff.md in the predecessor seat’s thread storage: resolve the predecessor thread id from role_generation_heads joined to role_generations, then read handoff.md under that thread’s storage directory (~/.bb/thread-storage/<threadId>/)",
    currentSeats,
  };
  const prompt = [
    `# bb-collab ${input.role} brief`,
    "",
    "## Ponytail preamble",
    bundle.ponytail,
    "",
    "## Role brief",
    bundle.roles[input.role],
    "",
    "## Working rules",
    bundle.rules,
    "",
    "## Live pointers",
    `Project: ${project.name} (${project.id})`,
    `Sources: ${project.sources.map((source) => source.id).join(", ") || "none"}`,
    `Canonical store query: ${pointers.canonicalStoreQuery}`,
    `Handoff file: ${pointers.handoffFile}`,
    `Current seats: ${currentSeats.map((seat) => `${seat.roleId}@${seat.generation}:${seat.threadId}`).join(", ") || "none"}`,
  ].join("\n");
  return { role: input.role, roleContent: bundle.roles[input.role], ponytail: bundle.ponytail, rules: bundle.rules, project: { id: project.id, name: project.name, sourceIds: project.sources.map((source) => source.id) }, pointers, prompt };
}

async function sendRoleBrief(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  projectId: string,
  threadId: string,
  role: z.infer<typeof roleBriefRoleSchema>,
  waitForActive = false,
): Promise<void> {
  const brief = await composeRoleBrief(bb, db, { projectId, role });
  if (waitForActive) await bb.sdk.threads.wait({ threadId, status: "active", timeoutMs: 30_000 });
  await bb.sdk.threads.send({
    threadId,
    mode: "queue-if-active",
    input: [{ type: "text", visibility: "agent-only", text: brief.prompt, mentions: [] }],
  });
}

async function deliverSucceededSeatBrief(
  bb: BbPluginApi,
  db: SqliteDatabase | null,
  input: unknown,
  result: FoundationResult,
): Promise<void> {
  const request = applyRequestSchema.safeParse(input);
  if (!request.success || result.outcome !== "OK" || request.data.operationClass !== "role_generation_succession" || !request.data.roleContext || !request.data.roleId) return;
  try {
    await sendRoleBrief(bb, db, request.data.projectId, request.data.roleContext.threadId, roleBriefRole(request.data.roleId));
  } catch (error) {
    bb.log.warn(`role brief seating failed for thread=${request.data.roleContext.threadId}: ${String(error)}`);
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
  fleetWatchdogCycle: (projectId?: string) => Promise<void>;
  resetFleetWatchdog: (projectId: string, invokedBy: string) => Promise<void>;
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
  if (!command || !["doctor", "export", "apply", "archive-sweep", "cached-consumer-rollout", "wait-register", "wait-list", "wait-validator", "stall-guard", "fleet-watchdog"].includes(command)) {
    return invalidCli("expected doctor, export, apply, archive-sweep, cached-consumer-rollout, wait-register, wait-list, wait-validator, stall-guard, or fleet-watchdog");
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
        attempted: summary.attempted,
        verified: summary.verified,
        message: "stall-guard cycle complete",
        evidence: summary,
      });
    } catch (error) {
      return cliResult({ outcome: "INTERNAL_ERROR", subject: "stall-guard", expected: 1, attempted: 0, verified: 0, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (command === "fleet-watchdog") {
    const projectFlag = args.indexOf("--project");
    const projectId = parseFlag(args, "--project");
    const expectedLength = projectFlag < 0 ? 1 : 3;
    const reset = args.includes("--reset");
    const unknown = args.find((arg) => arg !== "--cycle" && arg !== "--reset" && arg !== "--project" && arg !== projectId);
    if (unknown || args.filter((arg) => arg === "--cycle").length + args.filter((arg) => arg === "--reset").length !== 1 || args.filter((arg) => arg === "--project").length > 1 || args.length !== expectedLength) {
      return invalidCli(`unexpected argument ${unknown ?? "duplicate or malformed flag"}`);
    }
    if (!projectId) return invalidCli("--project PROJECT_ID must be supplied once with a value");
    try {
      if (reset) {
        await deps.resetFleetWatchdog(projectId, ctx?.threadId ?? "unknown");
        return cliResult({ outcome: "OK", subject: projectId, expected: 1, attempted: 1, verified: 1, message: "fleet-watchdog history reset" });
      }
      await deps.fleetWatchdogCycle(projectId);
      return cliResult({ outcome: "OK", subject: projectId, expected: 1, attempted: 1, verified: 1, message: "fleet-watchdog cycle complete" });
    } catch (error) {
      return cliResult({ outcome: "INTERNAL_ERROR", subject: projectId, expected: 1, attempted: 0, verified: 0, message: error instanceof Error ? error.message : String(error) });
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

export default async function plugin(bb: BbPluginApi, options: PluginOptions = {}) {
  const fleetWatchdogSettings = bb.settings.define({
    fleetWatchdogFloorMs: {
      type: "string",
      label: "Fleet watchdog floor (ms)",
      description: "Idle time before quiet open work wakes the orchestrator.",
      default: String(FLEET_WATCHDOG_FLOOR_MS),
    },
    fleetWatchdogStaleWaitMs: {
      type: "string",
      label: "Fleet watchdog stale wait (ms)",
      description: "Declared wait age before it wakes the orchestrator.",
      default: String(FLEET_WATCHDOG_STALE_WAIT_MS),
    },
  });
  const readDiagnosticDivergence = () => readCheckoutDivergence(
    options.checkoutRoot === undefined ? findCheckoutRoot(dirname(fileURLToPath(import.meta.url))) : options.checkoutRoot,
  );
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
      return (await bb.sdk.threads.interactions.list({ threadId })).some((interaction) => interaction.status === "pending");
    } catch {
      return true;
    }
  };

  const readPendingOperatorWaitForThread = async (threadId: string): Promise<OperatorWait | null> => {
    const interaction = (await bb.sdk.threads.interactions.list({ threadId })).find((candidate) => candidate.status === "pending");
    if (!interaction) return null;
    return {
      reason: "awaiting_operator",
      createdAtMs: typeof interaction.createdAt === "number" && Number.isFinite(interaction.createdAt) ? Math.max(0, interaction.createdAt) : 0,
    };
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
    write: (state: Record<string, { steerCount: number; failedSteers: number; escalated: boolean; idleSinceMs: number | null; lastSteerAtMs: number | null; awaitingSteerOutcome: boolean; lastFleetWakeAtMs: number | null; lastStaleWaitWakeAtMs: number | null; lastOwedActWakeAtMs: number | null; lastEscalationAtMs: number | null }>) => bb.storage.kv.set("lane-watcher.role-idle", state),
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

  const readRoleScopes = async () => [];

  const steerRole = async (role: import("./src/awareness.js").RoleIdleView) => {
    if (!db) return "error" as const;
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
      return "error" as const;
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
      return "error" as const;
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
    readLanes: () => [],
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
      return {
        projectId: thread.projectId,
        status: thread.status,
        pendingExternalWait: archived ? true : await readPendingExternalWait(threadId),
        archived,
        operatorWait: null,
        operatorWaitKnown: true,
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
  const fleetWatchdogIdle = createRoleIdleLedger({
    read: () => bb.storage.kv.get<unknown>("fleet-watchdog.role-idle"),
    write: (state) => bb.storage.kv.set("fleet-watchdog.role-idle", state),
  });

  const stallGuardCycle = createStallGuardCycle({
    readRoleHolders: () => (db ? readRoleHolderStates(db) : []),
    readArtifact: async (projectId) => {
      if (!db) return null;
      const artifacts = [];
      for (const holder of readRoleHolderStates(db).filter((candidate) => candidate.project_id === projectId)) {
        try {
          const thread = await bb.sdk.threads.get({ threadId: holder.thread_id });
          if (thread.projectId !== projectId || !thread.environmentId) {
            artifacts.push({ id: holder.execution_attempt_id, unavailable: false, value: { environmentId: null, result: { outcome: "absent" } } });
            continue;
          }
          const result = await bb.sdk.environments.pullRequest({ environmentId: thread.environmentId });
          artifacts.push(result.outcome === "unavailable"
            ? { id: holder.execution_attempt_id, unavailable: true, value: null }
            : { id: holder.execution_attempt_id, unavailable: false, value: { environmentId: thread.environmentId, result } });
        } catch {
          artifacts.push({ id: holder.execution_attempt_id, unavailable: true, value: null });
        }
      }
      return artifacts;
    },
    wakeRole: async (role) => {
      const result = await steerRole(role);
      return result === true
        ? { attempted: true, delivered: true }
        : { attempted: false, delivered: false, refusal: result === "error" ? "error" : "policy" };
    },
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
          bb.log.info("wait-validator-liveness healthy cycle");
          return; // another checker already claimed this episode's single alert
        }
        bb.log.error("wait-validator liveness marker is stale: host launchd supervision failed; operator attention required");
        bb.realtime.publish("wait-validator", { liveness: "stale", alert: "operator-once" });
      }
      bb.log.info("wait-validator-liveness healthy cycle");
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
          bb.log.info("stall-guard-liveness healthy cycle");
          return;
        }
        bb.log.error("stall-guard liveness marker is stale: host launchd supervision failed; operator attention required");
        bb.realtime.publish("stall-guard", { liveness: "stale", alert: "operator-once" });
      }
      bb.log.info("stall-guard-liveness healthy cycle");
    } catch (error) {
      bb.log.warn(`stall-guard liveness check failed: ${String(error)}`);
    }
  });

  const wakeInFlight = new Set<string>();
  const fleetWatchdogCycle = async (onlyProjectId?: string) => {
    try {
      if (!db) return;
      const now = Date.now();
      const { fleetWatchdogFloorMs, fleetWatchdogStaleWaitMs } = await fleetWatchdogSettings.get();
      const floorMs = Number(fleetWatchdogFloorMs);
      const staleWaitMs = Number(fleetWatchdogStaleWaitMs);
      if (!Number.isSafeInteger(floorMs) || floorMs <= 0 || !Number.isSafeInteger(staleWaitMs) || staleWaitMs <= 0) {
        throw new Error("watchdog thresholds must be positive integer milliseconds");
      }
      const holdersByProject = new Map<string, RoleHolderState[]>();
      for (const holder of readRoleHolderStates(db)) {
        const holders = holdersByProject.get(holder.project_id) ?? [];
        holders.push(holder);
        holdersByProject.set(holder.project_id, holders);
      }
      const openWorkItemsByProject = new Map<string, Array<{ workItemId: string; waker: string | null; wakerKind: "schedule" | "seat" | null; declaredAtMs: number | null }>>();
      for (const workItem of db.prepare(
        `SELECT work_items.project_id, work_items.work_item_id, work_item_waits.waker, work_item_waits.waker_kind, work_item_waits.declared_at_ms
         FROM work_items LEFT JOIN work_item_waits
           ON work_item_waits.project_id = work_items.project_id AND work_item_waits.work_item_id = work_items.work_item_id
         WHERE work_items.lifecycle_state NOT IN ('succeeded', 'failed', 'cancelled')
         ORDER BY work_items.created_at_ms, work_items.work_item_id`,
      ).all() as Array<{ project_id: string; work_item_id: string; waker: string | null; waker_kind: "schedule" | "seat" | null; declared_at_ms: number | null }>) {
        const workItems = openWorkItemsByProject.get(workItem.project_id) ?? [];
        workItems.push({ workItemId: workItem.work_item_id, waker: workItem.waker, wakerKind: workItem.waker_kind, declaredAtMs: workItem.declared_at_ms });
        openWorkItemsByProject.set(workItem.project_id, workItems);
      }
      const isCurrent = (candidate: RoleHolderState, holder: RoleHolderState) => candidate.role_generation === holder.role_generation && candidate.execution_attempt_id === holder.execution_attempt_id && candidate.thread_id === holder.thread_id;
      const wake = async (projectId: string, holder: RoleHolderState, key: string, text: string, requireIdle: boolean, kind: "fleet" | "startable-queue" | "stale-wait" | "owed-act" | "escalation", beforeSend?: () => Promise<boolean>) => {
        const previous = await fleetWatchdogIdle.get(key);
        const lastNotifiedAtMs = kind === "fleet" ? previous?.lastFleetWakeAtMs
          : kind === "startable-queue" ? previous?.lastStartableQueueWakeAtMs
            : kind === "stale-wait" ? previous?.lastStaleWaitWakeAtMs
              : kind === "owed-act" ? previous?.lastOwedActWakeAtMs
                : previous?.lastEscalationAtMs;
        if (lastNotifiedAtMs !== null && lastNotifiedAtMs !== undefined && now - lastNotifiedAtMs < floorMs) return false;
        if (wakeInFlight.has(key)) return false;
        wakeInFlight.add(key);
        try {
          const current = readRoleHolderStates(db).filter((candidate) => candidate.project_id === projectId && candidate.role_id === holder.role_id);
          if (current.length !== 1 || !isCurrent(current[0]!, holder)) {
            if (current.length > 1) bb.log.warn(`fleet-watchdog refused: project=${projectId} active ${holder.role_id} holders=${current.length}`);
            return false;
          }
          if (await readPendingExternalWait(holder.thread_id)) return false;
          const thread = await bb.sdk.threads.get({ threadId: holder.thread_id });
          if (roleThreadRefusal(holder, thread, requireIdle)) return false;
          if (beforeSend && !await beforeSend()) return false;
          await bb.sdk.threads.send({
            threadId: holder.thread_id,
            mode: "queue-if-active",
            input: [{ type: "text", visibility: "agent-only", text, mentions: [] }],
          });
          if (kind === "fleet") await fleetWatchdogIdle.recordFleetWake(key, Date.now());
          else if (kind === "startable-queue") await fleetWatchdogIdle.recordStartableQueueWake(key, Date.now());
          else if (kind === "stale-wait") await fleetWatchdogIdle.recordStaleWaitWake(key, Date.now());
          else if (kind === "owed-act") await fleetWatchdogIdle.recordOwedActWake(key, Date.now());
          else await fleetWatchdogIdle.recordEscalation(key, Date.now());
          return true;
        } finally {
          wakeInFlight.delete(key);
        }
      };
      for (const [projectId, holders] of holdersByProject) {
        try {
          if (onlyProjectId !== undefined && projectId !== onlyProjectId) continue;
          const directors = holders.filter((holder) => holder.role_id === "director");
          const orchestrators = holders.filter((holder) => holder.role_id === "project-orchestrator");
          if (directors.length !== 1 || orchestrators.length !== 1) {
            if (directors.length > 1) bb.log.warn(`fleet-watchdog refused: project=${projectId} active director holders=${directors.length}`);
            if (orchestrators.length > 1) bb.log.warn(`fleet-watchdog refused: project=${projectId} active project-orchestrator holders=${orchestrators.length}`);
            continue;
          }
          const director = directors[0]!;
          const orchestrator = orchestrators[0]!;
          const workItems = openWorkItemsByProject.get(projectId) ?? [];
          const resetIdle = () => Promise.all(holders.flatMap((holder) => workItems.map((workItem) => fleetWatchdogIdle.resetIdle(roleIdleKey(holder, workItem.workItemId)))));
          const config = db.prepare(
            `SELECT revisions.canonical_config_json
             FROM project_config_heads AS heads
             JOIN project_config_revisions AS revisions
               ON revisions.project_id = heads.project_id AND revisions.config_revision = heads.config_revision
             WHERE heads.project_id = ?`,
          ).get(projectId) as { canonical_config_json: string } | undefined;
          let writingLaneCeiling: number | null = null;
          try {
            writingLaneCeiling = config ? writingLaneCeilingFromJson(config.canonical_config_json) : null;
          } catch {
            writingLaneCeiling = null;
          }
          const activeLaneCount = (db.prepare(
            `SELECT COUNT(*) AS count FROM execution_attempts
             WHERE project_id = ? AND origin = 'assignment' AND assignment_kind = 'write'
               AND state IN ('prepared', 'armed', 'content_delivered', 'running', 'dispatch_unknown')`,
          ).get(projectId) as { count: number }).count;
          const repositories = (db.prepare(
            `SELECT targets.remote_url FROM project_config_heads AS heads
             JOIN repository_targets AS targets
               ON targets.project_id = heads.project_id AND targets.config_revision = heads.config_revision
             WHERE heads.project_id = ? ORDER BY targets.repo_target_id`,
          ).all(projectId) as Array<{ remote_url: string | null }>).map((target) => githubRepository(target.remote_url));
          const startableCount = repositories.length === 0 || repositories.some((repository) => repository === null)
            ? null
            : startableQueueDepth(repositories as string[]);
          if (startableCount !== null && startableCount > 0 && writingLaneCeiling !== null && activeLaneCount < writingLaneCeiling) {
            await wake(projectId, orchestrator, roleIdleKey(orchestrator, "queue:startable"), `startable queue has ${startableCount} issue${startableCount === 1 ? "" : "s"} with ${activeLaneCount}/${writingLaneCeiling} writing lanes active`, false, "startable-queue");
          }
          if (workItems.length === 0) continue;
          const staleWait = workItems.find((workItem) => workItem.declaredAtMs !== null && now - workItem.declaredAtMs >= staleWaitMs);
          if (staleWait) {
            await wake(projectId, orchestrator, roleIdleKey(orchestrator, staleWait.workItemId), staleWait.wakerKind === "seat" ? "owed act went stale" : "wait went stale: chase the external or re-plan", false, "stale-wait");
            continue;
          }
          const seatWait = workItems.find((workItem) => workItem.wakerKind === "seat" && workItem.waker !== null);
          if (seatWait) {
            const owing = holders.find((holder) => holder.role_id === seatWait.waker);
            if (!owing) continue;
            const owingKey = roleIdleKey(owing, seatWait.workItemId);
            const owingThread = await bb.sdk.threads.get({ threadId: owing.thread_id });
            if (roleThreadRefusal(owing, owingThread, true) || await readPendingExternalWait(owing.thread_id)) {
              await fleetWatchdogIdle.resetIdle(owingKey);
              continue;
            }
            const owingRecord = await fleetWatchdogIdle.observeIdle(owingKey, now);
            if (owingRecord.idleSinceMs === null || now - owingRecord.idleSinceMs < floorMs) continue;
            if (owingRecord.lastOwedActWakeAtMs === null || owingRecord.lastOwedActWakeAtMs < owingRecord.idleSinceMs) {
              await wake(projectId, owing, owingKey, `owed act quiet at cycle ${new Date(now).toISOString()} with open work since ${new Date(owingRecord.idleSinceMs).toISOString()}`, true, "owed-act");
              continue;
            }
            if (owing.role_id !== "director" && now - owingRecord.lastOwedActWakeAtMs >= floorMs) {
              await wake(projectId, director, roleIdleKey(director, seatWait.workItemId), `owed act still quiet at cycle ${new Date(now).toISOString()} with open work since ${new Date(owingRecord.idleSinceMs).toISOString()}`, true, "owed-act");
            }
            continue;
          }
          const openWorkItem = workItems.find((workItem) => workItem.declaredAtMs === null);
          if (!openWorkItem) {
            await resetIdle();
            continue;
          }
          const workKey = openWorkItem.workItemId;
          const orchestratorKey = roleIdleKey(orchestrator, workKey);
          const priorOrchestratorRecord = await fleetWatchdogIdle.get(orchestratorKey);
          if (priorOrchestratorRecord?.lastFleetWakeAtMs !== null && priorOrchestratorRecord?.lastFleetWakeAtMs !== undefined && now - priorOrchestratorRecord.lastFleetWakeAtMs >= floorMs) {
            await wake(projectId, director, roleIdleKey(director, workKey), `fleet still quiet at cycle ${new Date(now).toISOString()} with open work since ${new Date(priorOrchestratorRecord.idleSinceMs ?? now).toISOString()}`, false, "escalation", async () => (await Promise.all(holders.map(async (holder) => {
              const thread = await bb.sdk.threads.get({ threadId: holder.thread_id });
              return !roleThreadRefusal(holder, thread, true) && !await readPendingExternalWait(holder.thread_id);
            }))).every(Boolean));
            continue;
          }
          const idle = await Promise.all(holders.map(async (holder) => {
            const thread = await bb.sdk.threads.get({ threadId: holder.thread_id });
            if (roleThreadRefusal(holder, thread, true) || await readPendingExternalWait(holder.thread_id)) {
              await fleetWatchdogIdle.resetIdle(roleIdleKey(holder, workKey));
              return false;
            }
            const record = await fleetWatchdogIdle.observeIdle(roleIdleKey(holder, workKey), now);
            return record.idleSinceMs !== null && now - record.idleSinceMs >= floorMs;
          }));
          if (!idle.every(Boolean)) continue;
          const orchestratorRecord = await fleetWatchdogIdle.get(orchestratorKey);
          if (orchestratorRecord?.lastFleetWakeAtMs === null || orchestratorRecord?.lastFleetWakeAtMs === undefined || orchestratorRecord.lastFleetWakeAtMs < (orchestratorRecord.idleSinceMs ?? now)) {
            await wake(projectId, orchestrator, orchestratorKey, `fleet quiet at cycle ${new Date(now).toISOString()} with open work since ${new Date(orchestratorRecord?.idleSinceMs ?? now).toISOString()}`, true, "fleet");
            continue;
          }
        } catch (error) {
          bb.log.warn(`fleet-watchdog failed: ${String(error)}`);
        }
      }
      bb.log.info("fleet-watchdog healthy cycle");
    } catch (error) {
      bb.log.warn(`fleet-watchdog failed: ${String(error)}`);
    }
  };
  const resetFleetWatchdog = async (projectId: string, invokedBy: string) => {
    await fleetWatchdogIdle.clearWakeHistory(`${projectId}:`);
    bb.log.warn(`fleet-watchdog history reset: project=${projectId} invokedBy=${invokedBy} at=${Date.now()}`);
  };
  bb.background.schedule("fleet-watchdog", "0 * * * *", () => fleetWatchdogCycle());

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
    bb.log.info("thread-archive-sweep healthy cycle");
  });

  const readOpenLaneViews = async () => [];

  // Lifecycle callbacks observe a completed creation; they cannot intercept a
  // spawn. An unseated thread receives its worker brief here at seating;
  // successful canonical succession separately delivers the exact seat brief.
  bb.events.on("thread.created", async ({ thread }) => {
    try {
      await sendRoleBrief(bb, db, thread.projectId, thread.id, roleForThread(db, thread.projectId, thread.id), true);
    } catch (error) {
      bb.log.warn(`role brief seating failed for thread=${thread.id}: ${String(error)}`);
    }
  });

  bb.http.route("GET", "/lanes", async () =>
    new Response(JSON.stringify(await readOpenLaneViews()), {
      headers: { "content-type": "application/json" },
    }),
  );

  // Counts only. A sidebar glyph needs how many are waiting and on which
  // thread; it has no use for the project, candidate head, digest or
  // idempotency key those requests carry, so this surface never carries them.
  const cliDeps: WaitValidatorCliDeps = {
    watcher,
    registerBoundedWaitForCli: (input, ctxThreadId) => registerBoundedWait({
      registry: boundedRegistry,
      readSource: readThreadObservation,
      readWaker: (schedule) => liveWaker(bb, schedule),
      input,
      ctxThreadId,
    }),
    listWaitsForCli: async () => { await waitRegistry.recover(); return waitRegistry.list().map((wait) => ({ ...wait, state: waitRegistry.state(wait.waitId) })); },
    escalationCycle,
    stallGuardCycle: (projectId) => stallGuardCycle.cycle(projectId),
    fleetWatchdogCycle,
    resetFleetWatchdog,
    archiveSweep: (projectId, apply) => runArchiveSweep(bb, db, projectId, apply),
    readCheckoutDivergence: readDiagnosticDivergence,
  };

  bb.rpc.register(rpcContract, {
    lanes() {
      return readOpenLaneViews();
    },
    async registerWait(input) {
      if (!await liveWaker(bb, input.wakerSchedule)) throw new Error(`waker schedule ${input.wakerSchedule} is not live: declaration refused`);
      await waitRegistry.recover();
      const existing = waitRegistry.list().find((wait) => wait.waitId === input.waitId);
      if (existing) {
        if (existing.wakerSchedule === null || existing.declaredAtMs === null) throw new Error("legacy wait has no verified waker: declare a new wait");
        if (existing.waiterThreadId !== input.waiterThreadId || existing.sourceThreadId !== input.sourceThreadId || existing.sourceEvent !== input.sourceEvent || existing.deadlineAtMs !== input.deadlineAtMs || existing.wakerSchedule !== input.wakerSchedule) {
          throw new Error("waitId is already bound to a different wait");
        }
        return { ...existing, wakerSchedule: existing.wakerSchedule, declaredAtMs: existing.declaredAtMs };
      }
      const wait = { ...input, declaredAtMs: Date.now() };
      await watcher.registerWait(wait);
      return wait;
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
    async roleBrief(input) {
      return composeRoleBrief(bb, db, input);
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
        summary: "Explicit foundation apply",
        usage: "bb collab apply --project PROJECT_ID --request JSON",
      },
      {
        name: "cached-consumer-rollout",
        summary: "Persist the live v21 cached-consumer rollout evidence (exact live production evidence required)",
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
        name: "fleet-watchdog",
        summary: "Run one wait-aware fleet-watchdog cycle",
        usage: "bb collab fleet-watchdog --cycle --project PROJECT_ID",
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
