import type { RoleHolderState, RoleIdleView, RoleQueueScope } from "./awareness.js";
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

export interface StallGuardCycleOptions {
  readRoleHolders: () => RoleHolderState[];
  readArtifact: (holder: RoleHolderState) => Promise<unknown | null>;
  readRoleScopes: () => Promise<RoleQueueScope[]> | RoleQueueScope[];
  wakeRole: (role: RoleIdleView) => Promise<boolean>;
  persistence: StallGuardPersistence;
}

export interface StallGuardCycleSummary {
  outcome: "OK";
  subject: "stall-guard";
  observed: number;
  changed: number;
  steered: number;
}

function stateFromUnknown(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function snapshot(value: unknown): string {
  return JSON.stringify(value);
}

export function createStallGuardCycle(options: StallGuardCycleOptions) {
  let state: Record<string, string> | null = null;

  return {
    async cycle(projectId?: string): Promise<StallGuardCycleSummary> {
      state ??= stateFromUnknown(await options.persistence.read());
      const holders = options.readRoleHolders().filter((holder) => projectId === undefined || holder.project_id === projectId);
      const scopes = await options.readRoleScopes();
      const nextState = structuredClone(state);
      let changed = 0;
      let steered = 0;

      for (const holder of holders) {
        const key = `${holder.project_id}:${holder.role_id}`;
        const current = await options.readArtifact(holder).catch(() => null);
        if (current === null) continue;
        const next = snapshot(current);
        if (nextState[key] === undefined) {
          nextState[key] = next;
          changed += 1;
          continue;
        }
        if (nextState[key] === next) continue;

        const scope = scopes.find((candidate) => candidate.projectId === holder.project_id);
        if (!scope?.nextStartable || !scope.queueHeadId || scope.deferredReason) continue;
        const role: RoleIdleView = {
          projectId: holder.project_id,
          roleId: holder.role_id,
          roleGeneration: holder.role_generation,
          executionAttemptId: holder.execution_attempt_id,
          threadId: holder.thread_id,
          queueHeadId: scope.queueHeadId,
          idleAgeMs: 0,
        };
        let delivered: boolean | void;
        try {
          delivered = await options.wakeRole(role);
        } catch {
          continue;
        }
        if (delivered === false) continue;
        nextState[key] = next;
        changed += 1;
        steered += 1;
      }

      if (changed > 0) {
        await options.persistence.write(nextState);
        state = nextState;
      }
      return { outcome: "OK", subject: "stall-guard", observed: holders.length, changed, steered };
    },
  };
}
