import { useSyncExternalStore } from "react";
import type { PluginRpcClient, PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract";

export type OperatorMessagesResult = PluginRpcResult<typeof rpcContract["operatorMessages"]>;
export type OperatorMessage = OperatorMessagesResult["messages"][number];
type Rpc = Pick<PluginRpcClient<typeof rpcContract>, "call">;
type InboxProject = { id: string };
export type ReadEpoch = { lifecycle: number; rpcGeneration: number; project: number; read: number; mutation: number; projectId: string };
export type ReadRequest = { epoch: ReadEpoch; promise: Promise<OperatorMessagesResult> };

const READ_INPUT = { recipient: "operator", withSenderTitles: true } as const;
const UNREGISTERED_INBOX_PROJECT = "PROJECT_CONFIG_REQUIRED" satisfies OperatorMessagesResult["outcome"];
const NON_OPERATOR_MESSAGE_ERROR = "operator inbox response included a non-operator message";
const FOREIGN_PROJECT_MESSAGE_ERROR = "operator inbox response included a foreign-project message";
const MALFORMED_MESSAGE_ERROR = "operator inbox response was malformed";

const reads = new Map<string, ReadRequest>();
const provenUnread = new Map<string, Set<string>>();
const projectEpochs = new Map<string, number>();
const readEpochs = new Map<string, number>();
const mutationEpochs = new Map<string, number>();
const listeners = new Set<() => void>();
let activeProjects = new Set<string>();
let snapshot = 0;
let lifecycleEpoch = 0;
let rpcClient: Rpc | null = null;
let rpcGeneration = 0;

function emit(): void {
  snapshot = [...provenUnread.values()].reduce((total, messages) => total + messages.size, 0);
  for (const listener of listeners) listener();
}

function messageKey(message: Pick<OperatorMessage, "projectId" | "messageId">): string {
  return `${message.projectId}:${message.messageId}`;
}

export function isUnregisteredInboxProject(result: OperatorMessagesResult): boolean {
  return result.outcome === UNREGISTERED_INBOX_PROJECT;
}

export function operatorOnlyMessages(result: OperatorMessagesResult, requestedProjectId: string): readonly OperatorMessage[] {
  const candidate = result as unknown as { outcome?: unknown; messages?: unknown };
  if ((candidate.outcome !== "OK" && candidate.outcome !== UNREGISTERED_INBOX_PROJECT) || !Array.isArray(candidate.messages)) throw new Error(MALFORMED_MESSAGE_ERROR);
  if (candidate.outcome === UNREGISTERED_INBOX_PROJECT) return [];
  if (candidate.messages.some((message) => !message || typeof message !== "object" || (message as { recipient?: unknown }).recipient !== "operator")) throw new Error(NON_OPERATOR_MESSAGE_ERROR);
  if (candidate.messages.some((message) => {
    const value = message as { projectId?: unknown; messageId?: unknown; readAtMs?: unknown; archivedAtMs?: unknown };
    const validTimestamp = (timestamp: unknown): timestamp is number | null => timestamp === null || typeof timestamp === "number" && Number.isFinite(timestamp);
    return typeof value.projectId !== "string" || !Number.isInteger(value.messageId) || !validTimestamp(value.readAtMs) || !validTimestamp(value.archivedAtMs);
  })) throw new Error(MALFORMED_MESSAGE_ERROR);
  if (candidate.messages.some((message) => (message as { projectId: string }).projectId !== requestedProjectId)) throw new Error(FOREIGN_PROJECT_MESSAGE_ERROR);
  return candidate.messages as OperatorMessage[];
}

function projectIdFromInput(input: Parameters<Rpc["call"]>[1]): string {
  return typeof (input as { projectId?: unknown }).projectId === "string" ? (input as { projectId: string }).projectId : "";
}

function bumpEpoch(epochs: Map<string, number>, projectId: string): number {
  const next = (epochs.get(projectId) ?? 0) + 1;
  epochs.set(projectId, next);
  return next;
}

function ensureRpcGeneration(rpc: Rpc): number {
  if (rpcClient !== rpc) {
    rpcClient = rpc;
    rpcGeneration += 1;
  }
  return rpcGeneration;
}

function currentReadEpoch(rpc: Rpc, projectId: string): ReadEpoch {
  return { lifecycle: lifecycleEpoch, rpcGeneration: ensureRpcGeneration(rpc), project: projectEpochs.get(projectId) ?? 0, read: readEpochs.get(projectId) ?? 0, mutation: mutationEpochs.get(projectId) ?? 0, projectId };
}

function readKey(input: Parameters<Rpc["call"]>[1], epoch: ReadEpoch): string {
  return JSON.stringify([epoch.lifecycle, epoch.rpcGeneration, epoch.projectId, epoch.project, epoch.read, epoch.mutation, input]);
}

export function isReadEpochCurrent(epoch: ReadEpoch): boolean {
  return epoch.lifecycle === lifecycleEpoch && epoch.rpcGeneration === rpcGeneration && epoch.project === (projectEpochs.get(epoch.projectId) ?? 0) && epoch.read === (readEpochs.get(epoch.projectId) ?? 0) && epoch.mutation === (mutationEpochs.get(epoch.projectId) ?? 0);
}

export function readOperatorMessagesWithEpoch(rpc: Rpc, input: Parameters<Rpc["call"]>[1]): ReadRequest {
  const projectId = projectIdFromInput(input);
  const baseEpoch = currentReadEpoch(rpc, projectId);
  const existing = reads.get(readKey(input, baseEpoch));
  if (existing) return existing;
  const epoch = { ...baseEpoch, read: bumpEpoch(readEpochs, projectId) };
  const key = readKey(input, epoch);
  const request = {} as ReadRequest;
  request.promise = Promise.resolve().then(() => rpc.call("operatorMessages", input)).finally(() => { if (reads.get(key) === request) reads.delete(key); });
  request.epoch = epoch;
  reads.set(key, request);
  return request;
}

export function readOperatorMessages(rpc: Rpc, input: Parameters<Rpc["call"]>[1]): Promise<OperatorMessagesResult> {
  return readOperatorMessagesWithEpoch(rpc, input).promise;
}

function applyRead(projectId: string, result: OperatorMessagesResult, epoch: ReadEpoch): void {
  if (!activeProjects.has(projectId) || !isReadEpochCurrent(epoch)) return;
  if (isUnregisteredInboxProject(result)) {
    if (provenUnread.delete(projectId)) emit();
    return;
  }
  const messages = operatorOnlyMessages(result, projectId);
  provenUnread.set(projectId, new Set(messages.filter((message) => message.readAtMs === null && message.archivedAtMs === null).map(messageKey)));
  emit();
}

export function refreshUnread(rpc: Rpc, projects: readonly InboxProject[]): void {
  const nextProjects = new Set(projects.map((project) => project.id));
  const previousProjects = activeProjects;
  for (const projectId of previousProjects) if (!nextProjects.has(projectId)) {
    bumpEpoch(projectEpochs, projectId);
    bumpEpoch(readEpochs, projectId);
  }
  for (const projectId of nextProjects) if (!previousProjects.has(projectId)) bumpEpoch(projectEpochs, projectId);
  activeProjects = nextProjects;
  let changed = false;
  for (const projectId of provenUnread.keys()) {
    if (!nextProjects.has(projectId)) {
      provenUnread.delete(projectId);
      changed = true;
    }
  }
  if (changed) emit();
  for (const project of projects) {
    const request = readOperatorMessagesWithEpoch(rpc, { projectId: project.id, ...READ_INPUT });
    void request.promise.then((result) => {
      try { applyRead(project.id, result, request.epoch); } catch { /* retain the last proven count */ }
    }, () => undefined);
  }
}

export function applyUnreadReadResult(projectId: string, result: OperatorMessagesResult, epoch: ReadEpoch): void {
  applyRead(projectId, result, epoch);
}

export function applyUnreadMutation(message: OperatorMessage): void {
  if (message.readAtMs === null && message.archivedAtMs === null) return;
  bumpEpoch(mutationEpochs, message.projectId);
  bumpEpoch(readEpochs, message.projectId);
  const unread = provenUnread.get(message.projectId);
  if (!activeProjects.has(message.projectId) || !unread) return;
  if (unread.delete(messageKey(message))) emit();
}

export function useInboxUnreadCount(): number {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => snapshot, () => snapshot);
}

export function clearUnreadObserver(): void {
  lifecycleEpoch += 1;
  activeProjects = new Set();
  if (provenUnread.size > 0 || snapshot !== 0) {
    provenUnread.clear();
    emit();
  }
}
