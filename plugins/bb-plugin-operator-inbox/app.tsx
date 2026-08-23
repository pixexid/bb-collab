import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArchiveIcon, ArrowClockwiseIcon, EnvelopeOpenIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { definePluginApp, experimental_useSidebarThreads, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps, PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { INBOX_INDICATOR_BROKEN_TITLE, INBOX_NAV_REGION_SELECTOR, inspectInboxNavGlyph, paintInboxNavUnread } from "./src/inbox-nav-indicator";
import type { rpcContract } from "./contract";

type OperatorMessagesResult = PluginRpcResult<typeof rpcContract["operatorMessages"]>;
type OperatorMessage = OperatorMessagesResult["messages"][number];
type InboxFilters = { projectId: string; showArchived: boolean };
type PendingInboxAction = { key: string; action: "mark-read" | "archive" };
function asText(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
const MAX_VISIBLE_INBOX_MESSAGES = 256;
const INBOX_FILTER_STORAGE_KEY = "bb-collab.inbox-filters";
const UNREGISTERED_INBOX_PROJECT = "PROJECT_CONFIG_REQUIRED" satisfies OperatorMessagesResult["outcome"];
const NON_OPERATOR_MESSAGE_ERROR = "operator inbox response included a non-operator message";
function isUnregisteredInboxProject(result: OperatorMessagesResult): boolean { return result.outcome === UNREGISTERED_INBOX_PROJECT; }
function operatorOnlyMessages(result: OperatorMessagesResult): readonly OperatorMessage[] {
  if (result.messages.some((message) => message.recipient !== "operator")) throw new Error(NON_OPERATOR_MESSAGE_ERROR);
  return result.messages;
}
function readInboxFilters(): InboxFilters {
  try { const value = JSON.parse(window.localStorage.getItem(INBOX_FILTER_STORAGE_KEY) ?? "null") as Partial<InboxFilters> | null; return { projectId: typeof value?.projectId === "string" ? value.projectId : "", showArchived: value?.showArchived === true }; }
  catch { return { projectId: "", showArchived: false }; }
}
function writeInboxFilters(filters: InboxFilters): void { try { window.localStorage.setItem(INBOX_FILTER_STORAGE_KEY, JSON.stringify(filters)); } catch {} }
function messageKey(message: Pick<OperatorMessage, "projectId" | "messageId">): string { return `${message.projectId}:${message.messageId}`; }
function formatExactTime(timestamp: number): string {
  const date = new Date(timestamp);
  try { return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "shortOffset" }).format(date); }
  catch { return `${date.toISOString().replace("T", " ").replace(".000Z", "")} UTC`; }
}
function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
function severityLabel(severity: OperatorMessage["severity"]): string { return severity === "needs-decision" ? "Needs decision" : severity[0]!.toUpperCase() + severity.slice(1); }
function senderLabel(message: OperatorMessage): string { return asText(message.senderTitle) ?? "Sender unavailable"; }
function deliveryLabel(message: OperatorMessage): string | null {
  if (message.repliedAtMs != null) return "Delivered";
  if (message.replyInProgress) return "Delivery pending";
  if (message.replyDeliveryError) return "Delivery failed";
  return null;
}
function stateLabel(message: OperatorMessage): string {
  if (message.archivedAtMs != null) return "Archived";
  return deliveryLabel(message) ?? (message.readAtMs === null ? "Unread" : "Read");
}

function InboxPanel(_props: PluginNavPanelProps) {
  const sidebar = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [filters, setFilters] = useState<InboxFilters>(readInboxFilters);
  const projectId = filters.projectId && sidebar.projects.some((project) => project.id === filters.projectId) ? filters.projectId : "";
  const { showArchived } = filters;
  const [messages, setMessages] = useState<readonly OperatorMessage[]>([]);
  const [selectedMessageKey, setSelectedMessageKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replyingMessageKey, setReplyingMessageKey] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingInboxAction | null>(null);
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
  const visibleMessages = messages.slice(0, MAX_VISIBLE_INBOX_MESSAGES);
  const selectedKey = selectedMessageKey && visibleMessages.some((message) => messageKey(message) === selectedMessageKey) ? selectedMessageKey : visibleMessages[0] ? messageKey(visibleMessages[0]) : null;
  const selectedMessage = selectedKey === null ? undefined : visibleMessages.find((message) => messageKey(message) === selectedKey);
  const unreadCount = messages.filter((message) => message.readAtMs === null).length;

  useEffect(() => {
    if (!document.querySelector(INBOX_NAV_REGION_SELECTOR)) return;
    let cancelled = false;
    const paint = async () => {
      const results = await Promise.allSettled(sidebar.projects.map((project) => rpc.call("operatorMessages", { projectId: project.id, recipient: "operator" })));
      if (cancelled) return;
      const unread = results.reduce((total, result, index) => {
        const currentProjectId = sidebar.projects[index]!.id;
        if (result.status === "fulfilled") {
          try { const count = operatorOnlyMessages(result.value).filter((message) => message.readAtMs === null).length; provenUnread.current.set(currentProjectId, count); return total + count; }
          catch { return total + (provenUnread.current.get(currentProjectId) ?? 0); }
        }
        return total + (provenUnread.current.get(currentProjectId) ?? 0);
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
  const currentProjectLabel = projectId ? projectNames.get(projectId) ?? projectId : "All projects";
  const selectedProjectLabel = selectedMessage ? projectNames.get(selectedMessage.projectId) ?? selectedMessage.projectId : null;
  const replyKey = selectedMessage ? messageKey(selectedMessage) : null;
  const replyText = selectedMessage && replyKey ? drafts[replyKey] ?? selectedMessage.replyText ?? "" : "";
  const selectedSenderId = selectedMessage ? asText(selectedMessage.senderThreadId) : null;
  const pendingSelectedAction = pendingAction?.key === replyKey ? pendingAction.action : null;
  const markReadPending = pendingSelectedAction === "mark-read";
  const archivePending = pendingSelectedAction === "archive";
  const markSelectedMessageRead = () => {
    if (!selectedMessage || !replyKey || pendingAction !== null) return;
    const action: PendingInboxAction = { key: replyKey, action: "mark-read" };
    setPendingAction(action);
    setErrors([]);
    setNotice(null);
    void rpc.call("markOperatorMessageRead", { projectId: selectedMessage.projectId, messageId: selectedMessage.messageId }).then((read) => {
      updateMessage(read);
      setNotice("Marked read. This message is no longer counted as unread.");
    }).catch((reason: unknown) => setErrors([String(reason)])).finally(() => setPendingAction((current) => current === action ? null : current));
  };
  const archiveSelectedMessage = () => {
    if (!selectedMessage || !replyKey) return;
    void archiveMessage(selectedMessage).catch(() => undefined);
  };
  const archiveOperations = useRef(new Map<string, Promise<OperatorMessage>>());
  const archiveMessage = (message: OperatorMessage) => {
    const key = messageKey(message);
    const existing = archiveOperations.current.get(key);
    if (existing) return existing;
    const action: PendingInboxAction = { key, action: "archive" };
    const sequence = refreshSequence.current;
    setPendingAction(action);
    setErrors([]);
    setNotice(null);
    const operation = rpc.call("archiveOperatorMessage", { projectId: message.projectId, messageId: message.messageId }).then((archived) => {
      if (sequence === refreshSequence.current) setMessages((current) => showArchivedRef.current ? current.map((item) => messageKey(item) === key ? archived : item) : current.filter((item) => messageKey(item) !== key));
      setNotice("Archived. Turn on Show archived to include it again.");
      return archived;
    }).catch((reason: unknown) => {
      setErrors([String(reason)]);
      throw reason;
    }).finally(() => {
      archiveOperations.current.delete(key);
      setPendingAction((current) => current === action ? null : current);
    });
    archiveOperations.current.set(key, operation);
    return operation;
  };

  return <main className="h-full overflow-y-auto p-4 md:p-5"><div className="mx-auto grid max-w-5xl gap-4" style={{ minWidth: 0, width: "100%" }}>
    {indicatorBroken ? <p role="alert" className="text-sm text-destructive">{INBOX_INDICATOR_BROKEN_TITLE} — open Inbox to check for unread messages. Cause: {indicatorBroken}</p> : null}
    <header className="grid gap-1"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Operator workspace</p><h1 className="text-xl font-semibold tracking-tight">Inbox</h1></div><p className="text-sm text-muted-foreground" aria-live="polite">{unreadCount ? `${unreadCount} unread` : "All caught up"}</p></div><p className="max-w-2xl text-sm text-muted-foreground">Review messages from your project agents, then reply, mark read, or archive from one place.</p></header>
    <section aria-label="Inbox toolbar" className="grid gap-3 rounded-lg border border-border bg-muted/10 p-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end"><label className="grid min-w-0 gap-1 text-sm"><span className="text-xs font-medium text-muted-foreground">Project</span><select className="w-full min-w-0 rounded-md border border-border bg-background px-3 py-2" value={projectId} onChange={(event) => setFiltersAndPersist({ projectId: event.target.value, showArchived })}><option value="">All projects</option>{sidebar.projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label><label className="flex min-h-10 items-center gap-2 px-1 text-sm"><input type="checkbox" checked={showArchived} onChange={(event) => setFiltersAndPersist({ projectId, showArchived: event.target.checked })} />Show archived</label><button type="button" aria-label="Refresh inbox" title="Refresh inbox" className="min-h-10 min-w-10 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none" onClick={refresh} disabled={loading}><ArrowClockwiseIcon aria-hidden="true" focusable="false" color="currentColor" weight="duotone" size={18} /></button></section>
    {errors.map((loadError) => <p role="alert" key={loadError} className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">Refresh failed: {loadError}</p>)}
    {notice ? <p role="status" className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">{notice}</p> : null}
    {sidebar.projects.length === 0 ? <section className="rounded-lg border border-dashed border-border p-6 text-center"><h2 className="font-medium">No projects available</h2><p className="mt-1 text-sm text-muted-foreground">A registered project is required before operator messages can appear here.</p></section> : <section aria-labelledby="inbox-list-heading" className="grid min-w-0 gap-3 md:grid-cols-[minmax(16rem,0.42fr)_minmax(0,1fr)]">
      <div className="min-w-0 overflow-hidden rounded-lg border border-border"><div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border bg-muted/10 px-3 py-3"><div><h2 id="inbox-list-heading" className="font-semibold">Messages</h2><p className="text-xs text-muted-foreground">{currentProjectLabel}</p></div><span className="text-xs text-muted-foreground">{messages.length} {messages.length === 1 ? "message" : "messages"}</span></div>
        {loading ? <p role="status" className="p-5 text-sm text-muted-foreground">Loading messages…</p> : null}
        {!loading && messages.length === 0 ? <div className="p-5"><p className="font-medium">No messages in this view</p><p className="mt-1 text-sm text-muted-foreground">Try another project or show archived messages.</p></div> : null}
        {messages.length > MAX_VISIBLE_INBOX_MESSAGES ? <p className="border-b border-border bg-muted/10 p-3 text-xs text-muted-foreground">Showing the first {MAX_VISIBLE_INBOX_MESSAGES} of {messages.length} messages. Unread messages appear first.</p> : null}
        <div role="list" aria-label="Operator messages">{visibleMessages.map((message) => {
          const key = messageKey(message);
          const selected = key === selectedKey;
          const sender = senderLabel(message);
          const delivery = deliveryLabel(message);
          return <article key={key} role="listitem" className={`border-b border-border last:border-b-0 ${selected ? "bg-primary/5 ring-2 ring-inset ring-primary" : message.readAtMs === null ? "bg-primary/10" : "bg-transparent"}`}>
            <button type="button" aria-pressed={selected} aria-label={`${selected ? "Selected. " : "Select "}message from ${sender}. ${projectNames.get(message.projectId) ?? message.projectId}. ${severityLabel(message.severity)}. ${stateLabel(message)}. ${formatExactTime(message.createdAtMs)}`} style={{ textAlign: "left", width: "100%" }} onClick={() => setSelectedMessageKey(key)} className="grid min-w-0 gap-2 px-3 py-3 transition-colors duration-150 hover:bg-muted/60 active:bg-muted/80 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none">
              <span className="sr-only">{message.readAtMs === null ? "Unread message. " : ""}</span><span className="flex min-w-0 items-start gap-2"><span className={`min-w-0 flex-1 break-words text-sm ${message.readAtMs === null ? "font-semibold" : "font-medium"}`}>{sender}</span><time className="shrink-0 text-xs text-muted-foreground" dateTime={new Date(message.createdAtMs).toISOString()} title={formatExactTime(message.createdAtMs)} aria-label={`Received ${formatExactTime(message.createdAtMs)}`}>{formatRelativeTime(message.createdAtMs)}</time></span>
              <span className="break-words text-sm leading-5 text-muted-foreground">{selected ? "Selected — details shown here" : message.text.length > 96 ? `${message.text.slice(0, 96).trimEnd()}…` : message.text}</span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"><span>{projectNames.get(message.projectId) ?? message.projectId}</span><span aria-hidden="true">·</span><span>{severityLabel(message.severity)}</span>{delivery ? <><span aria-hidden="true">·</span><span className={delivery === "Delivery failed" ? "text-destructive" : ""}>{delivery}</span></> : null}{message.archivedAtMs != null ? <><span aria-hidden="true">·</span><span>Archived</span></> : null}</span>
            </button>
            {message.archivedAtMs === null ? <div className="flex justify-end px-3 pb-2"><button type="button" aria-busy={pendingAction?.key === key && pendingAction.action === "archive"} aria-label={pendingAction?.key === key && pendingAction.action === "archive" ? "Archiving message" : "Archive message"} title={pendingAction?.key === key && pendingAction.action === "archive" ? "Archiving message" : "Archive message"} disabled={pendingAction !== null} className="min-h-8 min-w-8 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none" onClick={() => { void archiveMessage(message).catch(() => undefined); }}><ArchiveIcon aria-hidden="true" focusable="false" color="currentColor" weight="duotone" size={16} /></button></div> : null}
          </article>;
        })}</div>
      </div>
      {selectedMessage ? <article aria-labelledby="selected-message-heading" className="min-w-0 rounded-lg border border-border bg-background"><header className="grid gap-3 border-b border-border bg-muted/10 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Selected message</p><h2 id="selected-message-heading" className="mt-1 text-lg font-semibold">Message</h2><p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground"><span>From</span>{selectedSenderId && asText(selectedMessage.senderTitle) ? <a href="#" className="min-w-0 break-words font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-label={`Open sender session ${selectedMessage.senderTitle}`} onClick={(event) => { event.preventDefault(); navigate.toThread(selectedSenderId); }}>{selectedMessage.senderTitle}</a> : <span>Sender unavailable</span>}<span aria-hidden="true">·</span><span>{selectedProjectLabel}</span><span aria-hidden="true">·</span><span>{severityLabel(selectedMessage.severity)}</span><span aria-hidden="true">·</span><time dateTime={new Date(selectedMessage.createdAtMs).toISOString()} title={formatExactTime(selectedMessage.createdAtMs)} aria-label={`Received ${formatExactTime(selectedMessage.createdAtMs)}`}>{formatRelativeTime(selectedMessage.createdAtMs)}</time></p></div><div className="flex flex-wrap gap-2 text-xs"><span className={`rounded-full px-2.5 py-1 font-medium ${selectedMessage.readAtMs === null ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>{selectedMessage.readAtMs === null ? "Unread" : "Read"}</span>{selectedMessage.archivedAtMs != null ? <span className="rounded-full bg-muted px-2.5 py-1 font-medium text-muted-foreground">Archived</span> : null}{deliveryLabel(selectedMessage) ? <span className={`rounded-full px-2.5 py-1 font-medium ${deliveryLabel(selectedMessage) === "Delivery failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>{deliveryLabel(selectedMessage)}</span> : null}</div></div></header>
        <div className="grid gap-5 p-4"><section aria-labelledby="message-body-heading" className="grid gap-2"><h3 id="message-body-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Message</h3><p className="whitespace-pre-wrap break-words text-sm leading-6">{selectedMessage.text}</p>{selectedMessage.notificationError ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">Urgent notification could not be sent: {selectedMessage.notificationError}</p> : null}</section>
          {selectedMessage.repliedAtMs != null ? <section aria-label="Reply delivered" className="grid gap-2 rounded-md border border-border bg-muted/10 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Reply delivered</h3><time className="text-xs text-muted-foreground" dateTime={new Date(selectedMessage.repliedAtMs).toISOString()} title={formatExactTime(selectedMessage.repliedAtMs)} aria-label={`Delivered ${formatExactTime(selectedMessage.repliedAtMs)}`}>{formatRelativeTime(selectedMessage.repliedAtMs)}</time></div><p className="whitespace-pre-wrap break-words text-sm leading-6">{selectedMessage.replyText}</p><p className="text-xs text-muted-foreground">BB confirmed the matching input in the sender thread.</p></section> : <section aria-labelledby="reply-heading" className="grid gap-3 border-t border-border pt-4"><div><h3 id="reply-heading" className="text-sm font-semibold">Reply to sender</h3><p className="mt-1 text-xs text-muted-foreground">Your reply is delivered only after BB confirms the matching input in the sender thread.</p></div>{selectedMessage.replyInProgress ? <p role="status" className="rounded-md border border-border bg-muted/10 px-3 py-2 text-sm text-primary">Delivery pending. Keep this message open; the outcome is not yet known.</p> : null}{selectedMessage.replyDeliveryError ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">Delivery failed: {selectedMessage.replyDeliveryError} You can retry without losing this message.</p> : null}<label className="grid gap-1 text-sm" htmlFor={`operator-reply-${replyKey}`}><span className="text-xs font-medium text-muted-foreground">Reply text</span><textarea id={`operator-reply-${replyKey}`} className="min-h-24 w-full rounded-md border border-border bg-background p-2.5 text-sm leading-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" value={replyText} onChange={(event) => setDrafts((current) => ({ ...current, [replyKey!]: event.target.value }))} /></label></section>}
          <div className="flex flex-wrap gap-2 border-t border-border pt-4"><button type="button" aria-label={replyingMessageKey === replyKey ? "Delivering reply" : selectedMessage.repliedAtMs != null ? "Reply delivered" : selectedMessage.replyDeliveryError ? "Retry reply" : "Send reply"} title={replyingMessageKey === replyKey ? "Delivering reply" : selectedMessage.repliedAtMs != null ? "Reply delivered" : selectedMessage.replyDeliveryError ? "Retry reply" : "Send reply"} disabled={replyingMessageKey !== null || pendingAction !== null || selectedMessage.repliedAtMs != null || !replyText.trim()} className="min-h-10 min-w-10 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity duration-150 hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none" onClick={() => { const text = replyText.trim(); if (!text || !replyKey) return; setErrors([]); setNotice(null); setReplyingMessageKey(replyKey); void rpc.call("replyToOperatorMessage", { projectId: selectedMessage.projectId, messageId: selectedMessage.messageId, text }).then((replied) => { updateMessage(replied); setNotice(replied.repliedAtMs != null ? "Reply delivered. BB confirmed the matching input." : replied.replyInProgress ? "Delivery pending. The outcome is not yet known." : replied.replyDeliveryError ? "Delivery failed. The message remains retryable." : "Reply delivery is not confirmed."); }).catch((reason: unknown) => setErrors([String(reason)])).finally(() => setReplyingMessageKey(null)); }}><PaperPlaneTiltIcon aria-hidden="true" focusable="false" color="currentColor" weight="duotone" size={18} /></button>{selectedMessage.readAtMs === null ? <button type="button" aria-busy={markReadPending} aria-label={markReadPending ? "Marking message read" : "Mark message read"} title={markReadPending ? "Marking message read" : "Mark message read"} disabled={pendingAction !== null} className="min-h-10 min-w-10 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none" onClick={markSelectedMessageRead}><EnvelopeOpenIcon aria-hidden="true" focusable="false" color="currentColor" weight="duotone" size={18} /></button> : null}{selectedMessage.archivedAtMs === null ? <button type="button" aria-busy={archivePending} aria-label={archivePending ? "Archiving message" : "Archive message"} title={archivePending ? "Archiving message" : "Archive message"} disabled={pendingAction !== null} className="min-h-10 min-w-10 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none" onClick={archiveSelectedMessage}><ArchiveIcon aria-hidden="true" focusable="false" color="currentColor" weight="duotone" size={18} /></button> : null}</div>
        </div>
      </article> : <section className="min-w-0 rounded-lg border border-dashed border-border p-6 text-center"><h2 className="font-medium">Select a message</h2><p className="mt-1 text-sm text-muted-foreground">Choose a message from the list to read it and see available actions.</p></section>}
    </section>}
  </div></main>;
}

export default definePluginApp((app) => { app.slots.navPanel({ id: "inbox", title: "Inbox", icon: "./assets/envelope-simple-duotone.svg", path: "inbox", component: InboxPanel }); });
