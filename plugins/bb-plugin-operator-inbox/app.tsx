import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, experimental_useSidebarThreads, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps, PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { INBOX_INDICATOR_BROKEN_TITLE, INBOX_NAV_REGION_SELECTOR, inspectInboxNavGlyph, paintInboxNavUnread } from "./src/inbox-nav-indicator";
import type { rpcContract } from "./contract";

type OperatorMessagesResult = PluginRpcResult<typeof rpcContract["operatorMessages"]>;
type OperatorMessage = OperatorMessagesResult["messages"][number];

function asText(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
const MAX_VISIBLE_INBOX_MESSAGES = 256;
const INBOX_FILTER_STORAGE_KEY = "bb-collab.inbox-filters";
const UNREGISTERED_INBOX_PROJECT = "PROJECT_CONFIG_REQUIRED" satisfies OperatorMessagesResult["outcome"];
function isUnregisteredInboxProject(result: OperatorMessagesResult): boolean { return result.outcome === UNREGISTERED_INBOX_PROJECT; }
type InboxFilters = { projectId: string; recipient: "" | OperatorMessage["recipient"]; showArchived: boolean };
function readInboxFilters(): InboxFilters {
  try { const value = JSON.parse(window.localStorage.getItem(INBOX_FILTER_STORAGE_KEY) ?? "null") as Partial<InboxFilters> | null; return { projectId: typeof value?.projectId === "string" ? value.projectId : "", recipient: value?.recipient === "operator" || value?.recipient === "supervisor" ? value.recipient : "", showArchived: value?.showArchived === true }; }
  catch { return { projectId: "", recipient: "", showArchived: false }; }
}
function writeInboxFilters(filters: InboxFilters): void { try { window.localStorage.setItem(INBOX_FILTER_STORAGE_KEY, JSON.stringify(filters)); } catch {} }
function InboxPanel(_props: PluginNavPanelProps) {
  const sidebar = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [filters, setFilters] = useState<InboxFilters>(readInboxFilters);
  const projectId = filters.projectId && sidebar.projects.some((project) => project.id === filters.projectId) ? filters.projectId : "";
  const { recipient, showArchived } = filters;
  const [messages, setMessages] = useState<readonly OperatorMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replyingMessageKey, setReplyingMessageKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [indicatorBroken, setIndicatorBroken] = useState<string | null>(null);
  const provenUnread = useRef(new Map<string, number>());
  const reportedBreak = useRef<string | null>(null);
  const refreshSequence = useRef(0);
  const projects = useMemo(() => projectId ? sidebar.projects.filter((candidate) => candidate.id === projectId) : sidebar.projects, [projectId, sidebar.projects]);
  const projectNames = useMemo(() => new Map(sidebar.projects.map((candidate) => [candidate.id, candidate.name])), [sidebar.projects]);
  const messageKey = (message: OperatorMessage) => `${message.projectId}:${message.messageId}`;
  const visibleMessages = messages.slice(0, MAX_VISIBLE_INBOX_MESSAGES);

  useEffect(() => {
    if (!document.querySelector(INBOX_NAV_REGION_SELECTOR)) return;
    let cancelled = false;
    const paint = async () => {
      const results = await Promise.allSettled(sidebar.projects.map((project) => rpc.call("operatorMessages", { projectId: project.id })));
      if (cancelled) return;
      const unread = results.reduce((total, result, index) => {
        const projectId = sidebar.projects[index]!.id;
        if (result.status === "fulfilled") { const count = result.value.messages.filter((message) => message.readAtMs === null).length; provenUnread.current.set(projectId, count); return total + count; }
        return total + (provenUnread.current.get(projectId) ?? 0);
      }, 0);
      const painted = paintInboxNavUnread(document, unread);
      const broken = painted.matched === false ? painted : inspectInboxNavGlyph(document);
      if (broken === null || broken.matched) { reportedBreak.current = null; setIndicatorBroken(null); return; }
      if (reportedBreak.current !== broken.reason) { console.error(`[operator-inbox] ${INBOX_INDICATOR_BROKEN_TITLE}: ${broken.reason}`); reportedBreak.current = broken.reason; }
      setIndicatorBroken(broken.reason);
    };
    void paint();
    const timer = window.setInterval(() => void paint(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); paintInboxNavUnread(document, 0); };
  }, [rpc, sidebar.projects]);

  const setFiltersAndPersist = (next: InboxFilters) => {
    setFilters(next);
    writeInboxFilters(next);
  };

  const refresh = useCallback(() => {
    const sequence = ++refreshSequence.current;
    setNotice(null);
    if (projects.length === 0) {
      setMessages([]);
      setErrors([]);
      return;
    }
    void Promise.allSettled(projects.map((project) => rpc.call("operatorMessages", {
      projectId: project.id,
      ...(recipient ? { recipient } : {}),
      withSenderTitles: true,
      ...(showArchived ? { includeArchived: true } : {}),
    })))
      .then((results) => {
        if (sequence !== refreshSequence.current) return;
        const loaded: OperatorMessage[] = [];
        const failed: string[] = [];
        results.forEach((result, index) => {
          const label = `${projects[index]!.name} (${projects[index]!.id})`;
          if (result.status === "rejected") failed.push(`${label}: ${String(result.reason)}`);
          else if (!isUnregisteredInboxProject(result.value)) loaded.push(...result.value.messages);
          else if (projectId !== "") failed.push(`${label}: ${result.value.outcome}`);
        });
        loaded.sort((left, right) => Number(left.readAtMs !== null) - Number(right.readAtMs !== null) || right.createdAtMs - left.createdAtMs || right.messageId - left.messageId);
        setMessages(loaded);
        setErrors(failed);
      });
  }, [projects, projectId, recipient, rpc, showArchived]);

  useEffect(refresh, [refresh]);

  const updateMessage = (next: OperatorMessage) => setMessages((current) => current.map((message) => messageKey(message) === messageKey(next) ? next : message));

  return (
    <main className="h-full overflow-y-auto p-5">
      <div className="mx-auto max-w-4xl">
        {indicatorBroken ? <p role="alert" className="mb-3 text-sm text-destructive">{INBOX_INDICATOR_BROKEN_TITLE} — open Inbox to check for unread messages. Cause: {indicatorBroken}</p> : null}
        <div className="mb-5 flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Project</span>
            <select className="rounded-md border border-border bg-background px-3 py-2" value={projectId} onChange={(event) => setFiltersAndPersist({ projectId: event.target.value, recipient, showArchived })}>
              <option value="">All projects</option>
              {sidebar.projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.id}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Recipient</span>
            <select className="rounded-md border border-border bg-background px-3 py-2" value={recipient} onChange={(event) => setFiltersAndPersist({ projectId, recipient: event.target.value as InboxFilters["recipient"], showArchived })}>
              <option value="">All recipients</option>
              <option value="operator">Operator</option>
              <option value="supervisor">Supervisor</option>
            </select>
          </label>
          <label className="flex items-center gap-2 py-2 text-sm">
            <input type="checkbox" checked={showArchived} onChange={(event) => setFiltersAndPersist({ projectId, recipient, showArchived: event.target.checked })} />
            Show archived
          </label>
          <button type="button" className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={refresh}>Refresh</button>
        </div>
        {sidebar.projects.length === 0 ? <p className="text-sm text-muted-foreground">No registered projects.</p> : null}
        {errors.map((loadError) => <p key={loadError} className="text-sm text-destructive">Unable to read inbox: {loadError}</p>)}
        {notice ? <p role="status" className="text-sm text-primary">{notice}</p> : null}
        {sidebar.projects.length > 0 ? (
          <section aria-labelledby="inbox-project-heading">
            <h2 id="inbox-project-heading" className="mb-2 text-sm font-semibold">{projectId ? projectNames.get(projectId) ?? projectId : "All projects"}</h2>
            {messages.length === 0 ? <p className="text-sm text-muted-foreground">No messages for this project and recipient filter.</p> : null}
            {messages.length > MAX_VISIBLE_INBOX_MESSAGES ? <p className="mb-3 text-sm text-muted-foreground">Showing the first {MAX_VISIBLE_INBOX_MESSAGES} of {messages.length} messages; unread messages are first. Select a project to narrow the list.</p> : null}
            <div className="space-y-3">
              {visibleMessages.map((message) => (
                <article key={messageKey(message)} className={`rounded-lg border p-4 ${message.readAtMs === null ? "border-primary/50" : "border-border"}`}>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{projectNames.get(message.projectId) ?? message.projectId}</span>
                    <span className="font-medium text-foreground">{message.recipient}</span>
                    <span>{message.severity}</span>
                    <span className="inline-grid">
                      {asText(message.senderThreadId) ? (
                        <>
                          <a
                            href="#"
                            className="font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground"
                            aria-label={`Open sender session ${asText(message.senderThreadId)}`}
                            title={`Open sender session ${asText(message.senderThreadId)}`}
                            onClick={(event) => { event.preventDefault(); navigate.toThread(asText(message.senderThreadId)!); }}
                          >
                            {asText(message.senderTitle) ?? asText(message.senderThreadId)}
                          </a>
                          {asText(message.senderTitle) ? (
                            <span>{asText(message.senderLaneId) ? `${asText(message.senderLaneId)} · ` : ""}{asText(message.senderThreadId)}</span>
                          ) : asText(message.senderLaneId) ? <span>{asText(message.senderLaneId)}</span> : null}
                        </>
                      ) : <span>Sender unavailable</span>}
                    </span>
                    <time className="ml-auto" dateTime={new Date(message.createdAtMs).toISOString()}>{new Date(message.createdAtMs).toLocaleString()}</time>
                  </div>
                  <p className="my-3 whitespace-pre-wrap text-sm">{message.text}</p>
                  {message.notificationError ? <p className="mb-2 text-xs text-destructive">Urgent notification failed: {message.notificationError}</p> : null}
                  {message.replyDeliveryError ? <p className="mb-2 text-xs text-destructive">Reply delivery failed: {message.replyDeliveryError}</p> : null}
                  {message.repliedAtMs === null ? (
                    <div className="grid gap-2">
                      <label className="text-xs text-muted-foreground" htmlFor={`operator-reply-${messageKey(message)}`}>Reply</label>
                      <textarea
                        id={`operator-reply-${messageKey(message)}`}
                        className="min-h-20 rounded-md border border-border bg-background p-2 text-sm"
                        value={drafts[messageKey(message)] ?? message.replyText ?? ""}
                        onChange={(event) => setDrafts((current) => ({ ...current, [messageKey(message)]: event.target.value }))}
                      />
                      <div className="flex gap-2">
                        <button type="button" disabled={replyingMessageKey !== null} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" onClick={() => {
                          const text = (drafts[messageKey(message)] ?? message.replyText ?? "").trim();
                          if (!text) return;
                          setErrors([]);
                          setNotice(null);
                          setReplyingMessageKey(messageKey(message));
                          void rpc.call("replyToOperatorMessage", { projectId: message.projectId, messageId: message.messageId, text })
                            .then((replied) => { updateMessage(replied); setNotice("Reply delivered."); })
                            .catch((reason: unknown) => setErrors([String(reason)]))
                            .finally(() => setReplyingMessageKey(null));
                        }}>{replyingMessageKey === messageKey(message) ? "Delivering…" : "Reply"}</button>
                        {message.readAtMs === null ? <button type="button" className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted" onClick={() => {
                          setErrors([]);
                          setNotice(null);
                          void rpc.call("markOperatorMessageRead", { projectId: message.projectId, messageId: message.messageId })
                            .then((read) => { updateMessage(read); setNotice("Marked read."); })
                            .catch((reason: unknown) => setErrors([String(reason)]));
                        }}>Mark read</button> : null}
                        {message.archivedAtMs === null ? <button type="button" className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted" onClick={() => {
                          setErrors([]);
                          setNotice(null);
                          void rpc.call("archiveOperatorMessage", { projectId: message.projectId, messageId: message.messageId })
                            .then((archived) => {
                              setMessages((current) => showArchived
                                ? current.map((item) => messageKey(item) === messageKey(archived) ? archived : item)
                                : current.filter((item) => messageKey(item) !== messageKey(archived)));
                              setNotice("Archived.");
                            })
                            .catch((reason: unknown) => setErrors([String(reason)]));
                        }}>Archive</button> : null}
                      </div>
                    </div>
                  ) : <p className="text-sm text-muted-foreground">Reply delivered: {message.replyText}</p>}
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "inbox",
    title: "Inbox",
    icon: "Mail",
    path: "inbox",
    component: InboxPanel,
  });
});
