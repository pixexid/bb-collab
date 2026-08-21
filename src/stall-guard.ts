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

export interface StallGuardCycleOptions {
  readRoleHolders: () => RoleHolderState[];
  readArtifact: (projectId: string) => Promise<StallGuardArtifact[] | null>;
  readQueueHead?: (projectId: string) => { workItemId: string; resourceRevision: number } | null;
  wakeRole: (role: RoleIdleView) => Promise<RoleWakeResult>;
  persistence: StallGuardPersistence;
}

export interface StallGuardCycleSummary {
  outcome: "OK";
  subject: "stall-guard";
  observed: number;
  changed: number;
  attempted: number;
  verified: number;
  steered: number;
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

type StallGuardObservation = { artifacts: StallGuardArtifact[]; queueHead: { workItemId: string; resourceRevision: number } | null; woken: boolean };

function observation(value: string): StallGuardObservation | null {
  try {
    const parsed = JSON.parse(value) as Partial<StallGuardObservation>;
    return Array.isArray(parsed.artifacts) ? { artifacts: parsed.artifacts, queueHead: parsed.queueHead ?? null, woken: parsed.woken === true } : null;
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

export function createStallGuardCycle(options: StallGuardCycleOptions) {
  let state: Record<string, string> | null = null;

  return {
    async cycle(projectId?: string): Promise<StallGuardCycleSummary> {
      state ??= stateFromUnknown(await options.persistence.read());
      const holders = options.readRoleHolders().filter((holder) => projectId === undefined || holder.project_id === projectId);
      const nextState = structuredClone(state);
      const artifacts = new Map<string, Promise<StallGuardArtifact[] | null>>();
      const readArtifacts = (id: string) => {
        let current = artifacts.get(id);
        if (!current) {
          current = options.readArtifact(id).catch(() => null);
          artifacts.set(id, current);
        }
        return current;
      };
      let changed = 0;
      let attempted = 0;
      let verified = 0;
      let steered = 0;

      for (const holder of holders) {
        const key = `${holder.project_id}:${holder.role_id}`;
        const current = await readArtifacts(holder.project_id);
        if (current === null) continue;
        const queueHead = options.readQueueHead ? options.readQueueHead(holder.project_id) : undefined;
        const prior = nextState[key] === undefined ? null : observation(nextState[key]);
        const queueChanged = queueHead !== undefined && (prior?.queueHead?.workItemId !== queueHead?.workItemId
          || prior?.queueHead?.resourceRevision !== queueHead?.resourceRevision);
        const queueSuppressionKey = queueHead === undefined || queueHead === null ? undefined : roleIdleKey(holder, queueHead.workItemId);
        const queueAlreadyWoken = queueSuppressionKey !== undefined && (() => {
          const record = observation(nextState[queueSuppressionKey] ?? "");
          return record?.woken === true && record.queueHead?.resourceRevision === queueHead!.resourceRevision;
        })();
        const next = queueHead === undefined ? snapshot(current) : JSON.stringify({ artifacts: current, queueHead, woken: prior?.woken === true && !queueChanged });
        if (nextState[key] === undefined) {
          nextState[key] = next;
          changed += 1;
          continue;
        }
        if (nextState[key] === next) continue;
        if (queueAlreadyWoken || !hasArtifactDelta(nextState[key], current)) {
          nextState[key] = next;
          changed += 1;
          continue;
        }

        const role: RoleIdleView = {
          projectId: holder.project_id,
          roleId: holder.role_id,
          roleGeneration: holder.role_generation,
          executionAttemptId: holder.execution_attempt_id,
          threadId: holder.thread_id,
          queueHeadId: holder.execution_attempt_id,
          idleAgeMs: 0,
        };
        let result: RoleWakeResult;
        try {
          result = await options.wakeRole(role);
        } catch {
          continue;
        }
        if (!result.attempted) {
          if (result.refusal !== "policy") continue;
          nextState[key] = next;
          changed += 1;
          continue;
        }
        attempted += 1;
        if (!result.delivered) continue;
        nextState[key] = next;
        if (queueSuppressionKey !== undefined) nextState[queueSuppressionKey] = JSON.stringify({ artifacts: current, queueHead, woken: true });
        changed += 1;
        verified += 1;
        steered += 1;
      }

      if (changed > 0) {
        await options.persistence.write(nextState);
        state = nextState;
      }
      return { outcome: "OK", subject: "stall-guard", observed: holders.length, changed, attempted, verified, steered };
    },
  };
}
