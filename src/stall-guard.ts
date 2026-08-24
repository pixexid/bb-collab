import { roleIdleKey, type RoleHolderState, type RoleIdleView, type RoleWakeResult } from "./awareness.js";
import { homedir } from "node:os";
import { join } from "node:path";

export const STALL_GUARD_KV_KEY = "stall-guard.artifacts";
export const STALL_GUARD_LIVENESS_MARKER_FILENAME = "stall-guard.liveness";
export const STALL_GUARD_LIVENESS_ALERT_FLAG_FILENAME = "stall-guard.alerted";

export function stallGuardStateDir(): string {
  return process.env.BB_COLLAB_STALL_GUARD_STATE_DIR ?? join(homedir(), ".bb", "bb-collab");
}

export interface StallGuardPersistence {
  read(): Promise<unknown>;
  write(state: Record<string, string>): Promise<void>;
}

export interface StallGuardArtifact {
  id: string;
  unavailable: boolean;
  value: unknown;
}

export type StallGuardTrust = "probationary" | "graduated";

export interface StallGuardAlert {
  projectId: string;
  roleId: string;
  roleGeneration: number;
  executionAttemptId: string;
  threadId: string;
  severity: "low" | "routine";
  probationary: boolean;
}

export interface StallGuardCycleOptions {
  readRoleHolders: () => RoleHolderState[];
  /** Canonical tenant inventory; role holders are not a tenant population. */
  readProjectIds?: () => readonly string[];
  readArtifact: (projectId: string) => Promise<StallGuardArtifact[] | null>;
  readQueueHead?: (projectId: string) => { workItemId: string; resourceRevision: number } | null;
  wakeRole: (role: RoleIdleView) => Promise<RoleWakeResult>;
  /** Missing graduation evidence is deliberately probationary, never silent. */
  readTenantTrust?: (projectId: string) => StallGuardTrust;
  onAlert?: (alert: StallGuardAlert) => void;
  persistence: StallGuardPersistence;
  onAmbiguous?: (message: string) => void;
}

export interface StallGuardCycleSummary {
  outcome: "OK";
  subject: "stall-guard";
  observed: number;
  changed: number;
  attempted: number;
  verified: number;
  steered: number;
  ambiguous: number;
}

function stateFromUnknown(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function snapshot(value: unknown): string {
  return JSON.stringify(value);
}

function priorArtifacts(value: string): StallGuardArtifact[] | null {
  try {
    const artifacts = JSON.parse(value);
    return Array.isArray(artifacts) && artifacts.every((artifact) => artifact
      && typeof artifact === "object"
      && typeof artifact.id === "string"
      && typeof artifact.unavailable === "boolean") ? artifacts as StallGuardArtifact[] : null;
  } catch {
    return null;
  }
}

type StallGuardObservation = { artifacts: StallGuardArtifact[]; queueHead?: { workItemId: string; resourceRevision: number } | null; woken?: boolean };

function observation(value: string): StallGuardObservation | null {
  try {
    const parsed = JSON.parse(value) as Partial<StallGuardObservation>;
    return Array.isArray(parsed.artifacts) ? { artifacts: parsed.artifacts, queueHead: parsed.queueHead, woken: parsed.woken } : null;
  } catch {
    return null;
  }
}

function hasArtifactDelta(previous: string, current: readonly StallGuardArtifact[]): boolean {
  const prior = observation(previous)?.artifacts ?? priorArtifacts(previous);
  if (!prior) return true;
  const byId = new Map(prior.map((artifact) => [artifact.id, artifact]));
  if (byId.size !== current.length || current.some((artifact) => !byId.has(artifact.id))) return true;
  return current.some((artifact) => {
    const before = byId.get(artifact.id);
    return before !== undefined && !artifact.unavailable && !before.unavailable && snapshot(before.value) !== snapshot(artifact.value);
  });
}

function validArtifactSnapshot(value: StallGuardArtifact[] | null): StallGuardArtifact[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = new Set<string>();
  for (const artifact of value) {
    if (!artifact || typeof artifact.id !== "string" || artifact.id.length === 0 || ids.has(artifact.id) || typeof artifact.unavailable !== "boolean") return null;
    if (artifact.unavailable) return null;
    ids.add(artifact.id);
  }
  return value;
}

function keyBelongsToProject(key: string, projectId: string): boolean {
  if (key.startsWith(`${projectId}:`)) return true;
  try {
    const parsed = JSON.parse(key) as unknown;
    return Array.isArray(parsed) && parsed[0] === projectId;
  } catch {
    return false;
  }
}

function emptySummary(observed = 0): StallGuardCycleSummary {
  return { outcome: "OK", subject: "stall-guard", observed, changed: 0, attempted: 0, verified: 0, steered: 0, ambiguous: 0 };
}

export function createStallGuardCycle(options: StallGuardCycleOptions) {
  let state: Record<string, string> | null = null;
  let stateLoad: Promise<Record<string, string>> | null = null;
  let commitQueue = Promise.resolve();
  const projectCycles = new Map<string, Promise<StallGuardCycleSummary>>();
  const artifactReads = new Map<string, Promise<StallGuardArtifact[] | null>>();

  const readState = async () => {
    if (state !== null) return state;
    const load = stateLoad ??= options.persistence.read().then(stateFromUnknown);
    try {
      state = await load;
    } catch (error) {
      if (stateLoad === load) stateLoad = null;
      throw error;
    }
    return state;
  };

  const pendingProjectChanges = new Map<string, Map<string, string | undefined>>();
  const applyChanges = (base: Record<string, string>, changes: ReadonlyMap<string, string | undefined>) => {
    const merged = structuredClone(base);
    for (const [key, value] of changes) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    return merged;
  };
  const flushPendingProject = async (projectId: string) => {
    const pending = pendingProjectChanges.get(projectId);
    if (!pending || pending.size === 0) return;
    const commit = commitQueue.then(async () => {
      const merged = applyChanges(state ?? {}, pending);
      state = merged;
      await options.persistence.write(merged);
      pendingProjectChanges.clear();
    });
    commitQueue = commit.then(() => undefined, () => undefined);
    await commit;
  };
  const commitProjectState = async (projectId: string, before: Record<string, string>, after: Record<string, string>) => {
    const changes = new Map<string, string | undefined>();
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!keyBelongsToProject(key, projectId) || before[key] === after[key]) continue;
      changes.set(key, after[key]);
    }
    if (changes.size === 0) return;
    const commit = commitQueue.then(async () => {
      const merged = applyChanges(state ?? {}, changes);
      state = merged;
      try {
        await options.persistence.write(merged);
        pendingProjectChanges.clear();
      } catch (error) {
        const pending = pendingProjectChanges.get(projectId) ?? new Map<string, string | undefined>();
        for (const [key, value] of changes) pending.set(key, value);
        pendingProjectChanges.set(projectId, pending);
        throw error;
      }
    });
    commitQueue = commit.then(() => undefined, () => undefined);
    await commit;
  };

  return {
    async cycle(projectId?: string): Promise<StallGuardCycleSummary> {
      const holdersInStore = options.readRoleHolders();
      const inventory = [...new Set(options.readProjectIds?.() ?? holdersInStore.map((holder) => holder.project_id))];
      const projectIds = projectId === undefined ? inventory : inventory.filter((id) => id === projectId);
      const runProject = async (currentProjectId: string): Promise<StallGuardCycleSummary> => {
        await readState();
        await flushPendingProject(currentProjectId);
        const currentHolders = options.readRoleHolders();
        const currentInventory = options.readProjectIds?.();
        if (currentInventory !== undefined && !currentInventory.includes(currentProjectId)) return emptySummary();
        const holders = currentHolders.filter((holder) => holder.project_id === currentProjectId);
        const before = structuredClone(state ?? {});
        const nextState = structuredClone(before);
        const readArtifacts = (id: string) => {
          let current = artifactReads.get(id);
          if (!current) {
            current = options.readArtifact(id).then(validArtifactSnapshot).catch(() => null);
            artifactReads.set(id, current);
            void current.then(() => {
              if (artifactReads.get(id) === current) artifactReads.delete(id);
            });
          }
          return current;
        };
        let changed = 0;
        let attempted = 0;
        let verified = 0;
        let steered = 0;
        let ambiguous = 0;

        await Promise.all(holders.map(async (holder) => {
          const key = JSON.stringify([holder.project_id, holder.role_id]);
          const legacyKey = `${holder.project_id}:${holder.role_id}`;
          if (nextState[legacyKey] !== undefined) {
            if (nextState[key] !== undefined) {
              ambiguous += 1;
              options.onAmbiguous?.(`stall-guard ambiguous migration: ${key}`);
              return;
            }
            nextState[key] = nextState[legacyKey]!;
            delete nextState[legacyKey];
            changed += 1;
          }
          const current = await readArtifacts(holder.project_id);
          if (current === null) return;
          // Queue-head detection belongs to fleet-watchdog; this read only preserves #533 suppression.
          const queueHead = options.readQueueHead?.(holder.project_id);
          const queueSuppressionKey = queueHead ? roleIdleKey(holder, queueHead.workItemId) : undefined;
          const queueAlreadyWoken = queueSuppressionKey !== undefined && (() => {
            const record = observation(nextState[queueSuppressionKey] ?? "");
            return record?.woken === true && record.queueHead?.resourceRevision === queueHead!.resourceRevision;
          })();
          const next = snapshot(current);
          if (nextState[key] === undefined) {
            nextState[key] = next;
            changed += 1;
            return;
          }
          if (nextState[key] === next) return;
          if (queueAlreadyWoken || !hasArtifactDelta(nextState[key], current)) {
            nextState[key] = next;
            changed += 1;
            return;
          }

          const role: RoleIdleView = {
            projectId: holder.project_id,
            roleId: holder.role_id,
            domainId: holder.domain_id ?? "default",
            roleGeneration: holder.role_generation,
            executionAttemptId: holder.execution_attempt_id,
            threadId: holder.thread_id,
            queueHeadId: queueHead?.workItemId ?? holder.execution_attempt_id,
            idleAgeMs: 0,
          };
          const trust = options.readTenantTrust?.(currentProjectId) ?? "probationary";
          const alert: StallGuardAlert = {
            projectId: currentProjectId,
            roleId: holder.role_id,
            roleGeneration: holder.role_generation,
            executionAttemptId: holder.execution_attempt_id,
            threadId: holder.thread_id,
            severity: trust === "graduated" ? "routine" : "low",
            probationary: trust !== "graduated",
          };
          try { options.onAlert?.(alert); } catch { /* alert reporting cannot suppress the wake attempt */ }
          let result: RoleWakeResult;
          try {
            result = await options.wakeRole(role);
          } catch {
            return;
          }
          if (!result.attempted) {
            if (result.refusal !== "policy") return;
            nextState[key] = next;
            changed += 1;
            return;
          }
          attempted += 1;
          if (!result.delivered) return;
          nextState[key] = next;
          if (queueHead) nextState[queueSuppressionKey!] = JSON.stringify({ artifacts: current, queueHead, woken: true });
          changed += 1;
          verified += 1;
          steered += 1;
        }));

        if (changed > 0) {
          const latestInventory = options.readProjectIds?.();
          if (latestInventory !== undefined && !latestInventory.includes(currentProjectId)) return emptySummary(holders.length);
          await commitProjectState(currentProjectId, before, nextState);
        }
        return { outcome: "OK", subject: "stall-guard", observed: holders.length, changed, attempted, verified, steered, ambiguous };
      };
      const enqueue = (currentProjectId: string) => {
        const previous = projectCycles.get(currentProjectId) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(() => runProject(currentProjectId));
        projectCycles.set(currentProjectId, current);
        void current.then(() => {
          if (projectCycles.get(currentProjectId) === current) projectCycles.delete(currentProjectId);
        }, () => {
          if (projectCycles.get(currentProjectId) === current) projectCycles.delete(currentProjectId);
        });
        return current;
      };
      if (projectId !== undefined) return enqueue(projectId);
      const summaries = await Promise.all(projectIds.map((currentProjectId) => enqueue(currentProjectId)));
      return summaries.reduce((total, summary) => ({
        outcome: "OK",
        subject: "stall-guard",
        observed: total.observed + summary.observed,
        changed: total.changed + summary.changed,
        attempted: total.attempted + summary.attempted,
        verified: total.verified + summary.verified,
        steered: total.steered + summary.steered,
        ambiguous: total.ambiguous + summary.ambiguous,
      }), emptySummary());
    },
  };
}
