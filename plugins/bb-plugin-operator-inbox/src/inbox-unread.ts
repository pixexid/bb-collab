import { useSyncExternalStore } from "react";
import type { PluginRpcClient, PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract";

export type OperatorMessagesResult = PluginRpcResult<typeof rpcContract["operatorMessages"]>;
export type OperatorMessage = OperatorMessagesResult["messages"][number];
type Rpc = Pick<PluginRpcClient<typeof rpcContract>, "call">;
type InboxProject = { id: string };

const READ_INPUT = { recipient: "operator", withSenderTitles: true } as const;
const UNREGISTERED_INBOX_PROJECT = "PROJECT_CONFIG_REQUIRED" satisfies OperatorMessagesResult["outcome"];
const NON_OPERATOR_MESSAGE_ERROR = "operator inbox response included a non-operator message";
const MALFORMED_MESSAGE_ERROR = "operator inbox response was malformed";

const reads = new Map<string, Promise<OperatorMessagesResult>>();
const provenUnread = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
let activeProjects = new Set<string>();
let snapshot = 0;

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

export function operatorOnlyMessages(result: OperatorMessagesResult): readonly OperatorMessage[] {
  const candidate = result as unknown as { outcome?: unknown; messages?: unknown };
  if ((candidate.outcome !== "OK" && candidate.outcome !== UNREGISTERED_INBOX_PROJECT) || !Array.isArray(candidate.messages)) throw new Error(MALFORMED_MESSAGE_ERROR);
  if (candidate.outcome === UNREGISTERED_INBOX_PROJECT) return [];
  if (candidate.messages.some((message) => !message || typeof message !== "object" || (message as { recipient?: unknown }).recipient !== "operator")) throw new Error(NON_OPERATOR_MESSAGE_ERROR);
  if (candidate.messages.some((message) => {
    const value = message as { projectId?: unknown; messageId?: unknown; readAtMs?: unknown; archivedAtMs?: unknown };
    const validTimestamp = (timestamp: unknown): timestamp is number | null => timestamp === null || typeof timestamp === "number" && Number.isFinite(timestamp);
    return typeof value.projectId !== "string" || !Number.isInteger(value.messageId) || !validTimestamp(value.readAtMs) || !validTimestamp(value.archivedAtMs);
  })) throw new Error(MALFORMED_MESSAGE_ERROR);
  return candidate.messages as OperatorMessage[];
}

export function readOperatorMessages(rpc: Rpc, input: Parameters<Rpc["call"]>[1]): Promise<OperatorMessagesResult> {
  const key = JSON.stringify(input);
  let read = reads.get(key);
  if (!read) {
    read = Promise.resolve().then(() => rpc.call("operatorMessages", input)).finally(() => reads.delete(key));
    reads.set(key, read);
  }
  return read;
}

function applyRead(projectId: string, result: OperatorMessagesResult): void {
  if (!activeProjects.has(projectId)) return;
  if (isUnregisteredInboxProject(result)) {
    if (provenUnread.delete(projectId)) emit();
    return;
  }
  const messages = operatorOnlyMessages(result);
  provenUnread.set(projectId, new Set(messages.filter((message) => message.readAtMs === null && message.archivedAtMs === null).map(messageKey)));
  emit();
}

export function refreshUnread(rpc: Rpc, projects: readonly InboxProject[]): void {
  const nextProjects = new Set(projects.map((project) => project.id));
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
    void readOperatorMessages(rpc, { projectId: project.id, ...READ_INPUT }).then((result) => {
      try { applyRead(project.id, result); } catch { /* retain the last proven count */ }
    }, () => undefined);
  }
}

export function applyUnreadReadResult(projectId: string, result: OperatorMessagesResult): void {
  applyRead(projectId, result);
}

export function applyUnreadMutation(message: OperatorMessage): void {
  const unread = provenUnread.get(message.projectId);
  if (!activeProjects.has(message.projectId) || !unread) return;
  if ((message.readAtMs !== null || message.archivedAtMs !== null) && unread.delete(messageKey(message))) emit();
}

export function useInboxUnreadCount(): number {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => snapshot, () => snapshot);
}

export function clearUnreadObserver(): void {
  activeProjects = new Set();
  if (provenUnread.size > 0 || snapshot !== 0) {
    provenUnread.clear();
    emit();
  }
}
