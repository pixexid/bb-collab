import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, experimental_useSidebarThreads, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps, PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { INBOX_INDICATOR_BROKEN_TITLE, INBOX_NAV_REGION_SELECTOR, inspectInboxNavGlyph, paintInboxNavUnread } from "./src/inbox-nav-indicator";
import type { rpcContract } from "./contract";

type OperatorMessagesResult = PluginRpcResult<typeof rpcContract["operatorMessages"]>;
type OperatorMessage = OperatorMessagesResult["messages"][number];
type InboxFilters = { projectId: string; showArchived: boolean };
function asText(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
const MAX_VISIBLE_INBOX_MESSAGES = 256;
const INBOX_FILTER_STORAGE_KEY = "bb-collab.inbox-filters";
const UNREGISTERED_INBOX_PROJECT = "PROJECT_CONFIG_REQUIRED" satisfies OperatorMessagesResult["outcome"];
const NON_OPERATOR_MESSAGE_ERROR = "operator inbox response included a non-operator message";
function isUnregisteredInboxProject(result: OperatorMessagesResult): boolean { return result.outcome === UNREGISTERED_INBOX_PROJECT; }
function operatorOnlyMessages(result: OperatorMessagesResult): readonly OperatorMessage[] {
  if (result.messages.some((message) => message.recipient !== "operator")) {
    throw new Error(NON_OPERATOR_MESSAGE_ERROR);
  }
  return result.messages;
}
function readInboxFilters(): InboxFilters {
  try { const value = JSON.parse(window.localStorage.getItem(INBOX_FILTER_STORAGE_KEY) ?? "null") as Partial<InboxFilters> | null; return { projectId: typeof value?.projectId === "string" ? value.projectId : "", showArchived: value?.showArchived === true }; }
  catch { return { projectId: "", showArchived: false }; }
}
function writeInboxFilters(filters: InboxFilters): void { try { window.localStorage.setItem(INBOX_FILTER_STORAGE_KEY, JSON.stringify(filters)); } catch {} }

function InboxPanel(_props: PluginNavPanelProps) {
  const sidebar = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [filters, setFilters] = useState<InboxFilters>(readInboxFilters);
  const projectId = filters.projectId && sidebar.projects.some((project) => project.id === filters.projectId) ? filters.projectId : "";
  const { showArchived } = filters;
  const [messages, setMessages] = useState<readonly OperatorMessage[]>([]);
  const [expandedMessageKey, setExpandedMessageKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replyingMessageKey, setReplyingMessageKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [indicatorBroken, setIndicatorBroken] = useState<string | null>(null);
  const provenUnread = useRef(new Map<string, number>());
  const reportedBreak = useRef<string | null>(null);
  const refreshSequence = useRef(0);
  const showArchivedRef = useRef(showArchived);
  showArchivedRef.current = showArchived;
  const projects = useMemo(() => projectId ? sidebar.projects.filter((candidate) => candidate.id === projectId) : sidebar.projects, [projectId, sidebar.projects]);
  const projectNames = useMemo(() => new Map(sidebar.projects.map((candidate) => [candidate.id, candidate.name])), [sidebar.projects]);
  const messageKey = (message: OperatorMessage) => `${message.projectId}:${message.messageId}`;
  const visibleMessages = messages.slice(0, MAX_VISIBLE_INBOX_MESSAGES);
  const openKey = expandedMessageKey === null
    ? visibleMessages[0] ? messageKey(visibleMessages[0]) : null
    : visibleMessages.some((message) => messageKey(message) === expandedMessageKey) ? expandedMessageKey : null;

  useEffect(() => {
    if (!document.querySelector(INBOX_NAV_REGION_SELECTOR)) return;
    let cancelled = false;
    const paint = async () => {
      const results = await Promise.allSettled(sidebar.projects.map((project) => rpc.call("operatorMessages", { projectId: project.id, recipient: "operator" })));
      if (cancelled) return;
      const unread = results.reduce((total, result, index) => {
        const projectId = sidebar.projects[index]!.id;
        if (result.status === "fulfilled") {
          try { const count = operatorOnlyMessages(result.value).filter((message) => message.readAtMs === null).length; provenUnread.current.set(projectId, count); return total + count; }
          catch { return total + (provenUnread.current.get(projectId) ?? 0); }
        }
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

  const setFiltersAndPersist = (next: InboxFilters) => { setFilters(next); writeInboxFilters(next); };
  const refresh = useCallback(() => {
    const sequence = ++refreshSequence.current;
    setNotice(null);
    setLoading(true);
    if (projects.length === 0) { setMessages([]); setErrors([]); setLoading(false); return; }
    void Promise.allSettled(projects.map((project) => rpc.call("operatorMessages", { projectId: project.id, recipient: "operator", withSenderTitles: true, ...(showArchived ? { includeArchived: true } : {}) })))
      .then((results) => {
        if (sequence !== refreshSequence.current) return;
        const loaded: OperatorMessage[] = [];
        const failed: string[] = [];
        results.forEach((result, index) => {
          const label = `${projects[index]!.name} (${projects[index]!.id})`;
          if (result.status === "rejected") failed.push(`${label}: ${String(result.reason)}`);
          else if (!isUnregisteredInboxProject(result.value)) {
            try { loaded.push(...operatorOnlyMessages(result.value)); }
            catch (reason) { failed.push(`${label}: ${String(reason)}`); }
          }
          else if (projectId !== "") failed.push(`${label}: ${result.value.outcome}`);
        });
        loaded.sort((left, right) => Number(left.readAtMs !== null) - Number(right.readAtMs !== null) || right.createdAtMs - left.createdAtMs || right.messageId - left.messageId);
        setMessages(loaded);
        setErrors(failed);
      })
      .finally(() => { if (sequence === refreshSequence.current) setLoading(false); });
  }, [projects, projectId, rpc, showArchived]);
  useEffect(refresh, [refresh]);
  const updateMessage = (next: OperatorMessage) => setMessages((current) => current.map((message) => messageKey(message) === messageKey(next) ? next : message));

  return <main className="h-full overflow-y-auto p-4 md:p-5"><div className="mx-auto grid max-w-4xl gap-3" style={{ minWidth: 0, width: "100%" }}>
    {indicatorBroken ? <p role="alert" className="text-sm text-destructive">{INBOX_INDICATOR_BROKEN_TITLE} — open Inbox to check for unread messages. Cause: {indicatorBroken}</p> : null}
    <section aria-label="Inbox filters" className="items-end gap-3 border-b border-border pb-3" style={{ display: "flex", flexWrap: "wrap", minWidth: 0, width: "100%" }}>
      <label className="grid min-w-0 gap-1 text-sm" style={{ flex: "1 0 20rem" }}><span className="text-xs text-muted-foreground">Project</span><select className="w-full min-w-0 rounded-md border border-border bg-background px-3 py-1.5" value={projectId} onChange={(event) => setFiltersAndPersist({ projectId: event.target.value, showArchived })}><option value="">All projects</option>{sidebar.projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.id}</option>)}</select></label>
      <label className="items-center gap-2 py-1.5 text-sm" style={{ display: "flex", flex: "0 0 8rem", whiteSpace: "nowrap" }}><input type="checkbox" checked={showArchived} onChange={(event) => setFiltersAndPersist({ projectId, showArchived: event.target.checked })} />Show archived</label>
      <button type="button" aria-label="Refresh inbox" title="Refresh inbox" style={{ flex: "0 0 2rem" }} className="rounded-md bg-transparent px-2 py-1.5 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none" onClick={refresh}><span aria-hidden="true">↻</span></button>
    </section>
    {errors.map((loadError) => <p role="alert" key={loadError} className="text-sm text-destructive">Unable to read inbox: {loadError}</p>)}
    {notice ? <p role="status" className="text-sm text-primary">{notice}</p> : null}
    {sidebar.projects.length === 0 ? <p className="text-sm text-muted-foreground">No registered projects.</p> : <section aria-labelledby="inbox-project-heading" className="overflow-hidden rounded-md border border-border" style={{ minWidth: 0, width: "100%" }}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2"><h2 id="inbox-project-heading" className="text-sm font-semibold">{projectId ? projectNames.get(projectId) ?? projectId : "All projects"}</h2><span className="text-xs text-muted-foreground">{messages.length} {messages.length === 1 ? "message" : "messages"}</span></div>
      {loading ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading messages…</p> : null}
      {!loading && messages.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No operator messages for this project filter.</p> : null}
      {messages.length > MAX_VISIBLE_INBOX_MESSAGES ? <p className="border-b border-border p-3 text-xs text-muted-foreground">Showing the first {MAX_VISIBLE_INBOX_MESSAGES} of {messages.length} messages; unread messages are first. Select a project to narrow the list.</p> : null}
      <div role="list" aria-label="Operator messages">{visibleMessages.map((message) => {
        const key = messageKey(message);
        const expanded = key === openKey;
        return <article key={key} role="listitem" className="border-b border-border last:border-b-0">
          <button type="button" aria-expanded={expanded} style={{ textAlign: "left", width: "100%" }} onClick={() => setExpandedMessageKey(expanded ? "" : key)} className={`grid min-w-0 gap-1 px-3 py-2.5 transition-colors duration-150 hover:bg-muted/60 active:bg-muted/80 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none ${expanded ? "bg-muted/40" : "bg-transparent"}`}>
            <span className="flex min-w-0 items-center gap-2">{message.readAtMs === null ? <span aria-label="Unread" className="h-2 w-2 shrink-0 rounded-full bg-primary" /> : null}<span className={`min-w-0 truncate text-sm ${message.readAtMs === null ? "font-semibold" : "font-medium"}`}>{asText(message.senderTitle) ?? asText(message.senderThreadId) ?? "Sender unavailable"}</span><span aria-hidden="true" className={`text-xs text-muted-foreground transition-transform duration-150 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}>›</span><time className="ml-auto shrink-0 text-xs text-muted-foreground" dateTime={new Date(message.createdAtMs).toISOString()}>{new Date(message.createdAtMs).toLocaleDateString()}</time></span>
            <span className="truncate text-xs text-muted-foreground">{message.text.slice(0, 90)}…</span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{projectNames.get(message.projectId) ?? message.projectId}</span><span aria-hidden="true">·</span><span>{message.severity}</span>{message.repliedAtMs !== null ? <><span aria-hidden="true">·</span><span>Delivered</span></> : message.replyInProgress ? <><span aria-hidden="true">·</span><span>Delivery pending</span></> : message.replyDeliveryError ? <><span aria-hidden="true">·</span><span className="text-destructive">Delivery failed</span></> : null}</span>
          </button>
          {expanded ? <div className="grid gap-3 border-t border-border bg-muted/10 p-3 md:p-4" style={{ minWidth: 0 }}>
            <p className="text-xs text-muted-foreground">{message.readAtMs === null ? "Unread" : "Read"} · {message.severity} · <time dateTime={new Date(message.createdAtMs).toISOString()}>{new Date(message.createdAtMs).toLocaleString()}</time></p>
            <div className="min-w-0">{asText(message.senderThreadId) ? <a href="#" className="font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2" aria-label={`Open sender session ${asText(message.senderThreadId)}`} title={`Open sender session ${asText(message.senderThreadId)}`} onClick={(event) => { event.preventDefault(); navigate.toThread(asText(message.senderThreadId)!); }}>{asText(message.senderTitle) ?? asText(message.senderThreadId)}</a> : <span className="font-medium">Sender unavailable</span>}<p className="break-words text-xs text-muted-foreground">{asText(message.senderLaneId) ? `${asText(message.senderLaneId)} · ` : ""}{asText(message.senderThreadId)}</p></div>
            <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.text}</p>
            {message.notificationError ? <p className="text-xs text-destructive">Urgent notification failed: {message.notificationError}</p> : null}
            {message.repliedAtMs !== null ? <div className="border-l-2 border-border pl-3"><p className="text-xs font-medium text-muted-foreground">Reply delivered</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{message.replyText}</p></div> : <div className="grid gap-2 border-t border-border pt-3">
              {message.replyInProgress ? <p className="text-xs text-primary">Reply delivery is still in progress; outcome is not yet known.</p> : null}{message.replyDeliveryError ? <p role="alert" className="text-xs text-destructive">Reply delivery failed: {message.replyDeliveryError}</p> : null}
              <label className="text-xs font-medium text-muted-foreground" htmlFor={`operator-reply-${key}`}>Reply</label><textarea id={`operator-reply-${key}`} className="min-h-24 w-full rounded-md border border-border bg-background p-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" value={drafts[key] ?? message.replyText ?? ""} onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))} />
              <div className="flex flex-wrap gap-2"><button type="button" disabled={replyingMessageKey !== null} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-opacity duration-150 hover:opacity-90 active:opacity-80 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none" onClick={() => { const text = (drafts[key] ?? message.replyText ?? "").trim(); if (!text) return; setErrors([]); setNotice(null); setReplyingMessageKey(key); void rpc.call("replyToOperatorMessage", { projectId: message.projectId, messageId: message.messageId, text }).then((replied) => { updateMessage(replied); setNotice(replied.repliedAtMs !== null ? "Reply delivered." : replied.replyInProgress ? "Reply delivery is still in progress; outcome is not yet known." : replied.replyDeliveryError ? "Reply delivery failed." : "Reply delivery is not confirmed."); }).catch((reason: unknown) => setErrors([String(reason)])).finally(() => setReplyingMessageKey(null)); }}>{replyingMessageKey === key ? "Delivering…" : message.replyDeliveryError ? "Retry reply" : "Reply"}</button>{message.readAtMs === null ? <button type="button" className="rounded-md bg-transparent px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none" onClick={() => { setErrors([]); setNotice(null); void rpc.call("markOperatorMessageRead", { projectId: message.projectId, messageId: message.messageId }).then((read) => { updateMessage(read); setNotice("Marked read."); }).catch((reason: unknown) => setErrors([String(reason)])); }}>Mark read</button> : null}{message.archivedAtMs === null ? <button type="button" className="rounded-md bg-transparent px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none" onClick={() => { const sequence = refreshSequence.current; setErrors([]); setNotice(null); void rpc.call("archiveOperatorMessage", { projectId: message.projectId, messageId: message.messageId }).then((archived) => { if (sequence === refreshSequence.current) setMessages((current) => showArchivedRef.current ? current.map((item) => messageKey(item) === key ? archived : item) : current.filter((item) => messageKey(item) !== key)); setNotice("Archived."); }).catch((reason: unknown) => setErrors([String(reason)])); }}>Archive</button> : null}</div>
            </div>}
          </div> : null}
        </article>;
      })}</div>
    </section>}
  </div></main>;
}

export default definePluginApp((app) => { app.slots.navPanel({ id: "inbox", title: "Inbox", icon: "Mail", path: "inbox", component: InboxPanel }); });
