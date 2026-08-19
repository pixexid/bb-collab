import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { definePluginApp, experimental_useSidebarThreadActions, experimental_useSidebarThreads, useBbContext, useBbNavigate, useRpc } from "@bb/plugin-sdk/app";
import type {
  PluginComposerThreadRowStatus,
  PluginNavPanelProps,
  PluginRpcResult,
  PluginSidebarProject,
  PluginSidebarThread,
  PluginThreadListProps,
} from "@bb/plugin-sdk/app";
import { INBOX_INDICATOR_BROKEN_TITLE, paintInboxNavUnread } from "./src/inbox-nav-indicator";
import { providerMark, providerMarkKey } from "./src/provider-marks";
import type { rpcContract } from "./server";

type Lane = PluginRpcResult<typeof rpcContract["lanes"]>[number];
type ThreadStates = PluginRpcResult<typeof rpcContract["threadStates"]>;
type ThreadModels = PluginRpcResult<typeof rpcContract["threadModels"]>;
type ThreadExecution = NonNullable<ThreadModels[string]>;
type SidebarCollapseState = PluginRpcResult<typeof rpcContract["sidebarCollapseState"]>;
type OperatorMessage = PluginRpcResult<typeof rpcContract["operatorMessages"]>[number];

const SETTINGS_ACTION_TITLE = "bb-collab settings";

function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

const MAX_VISIBLE_THREADS = 5;
// The exact project reader returns at most 256 rows; keep the aggregate panel
// at that measured display budget and disclose the spill instead of hiding it.
const MAX_VISIBLE_INBOX_MESSAGES = 256;
const SIDEBAR_RPC_BATCH_SIZE = 256;
const INBOX_FILTER_STORAGE_KEY = "bb-collab.inbox-filters";
// The host lists every BB project while inbox registration lives in
// `project_config_heads`, so the aggregate fan-out necessarily reads projects
// that have no inbox. That rejection is the normal case there and is skipped.
// It is skipped ONLY there: picking one project by name is a question about
// that project, and it is owed the answer. There is no typed error on this
// path yet, so the match is exact-message equality against the sentence
// server.ts throws — a wrapped or quoted failure stays visible.
const UNREGISTERED_INBOX_PROJECT = "operator inbox project is not registered";

function isUnregisteredInboxProject(reason: unknown): boolean {
  return reason instanceof Error && reason.message === UNREGISTERED_INBOX_PROJECT;
}

const INBOX_UNREAD_POLL_MS = 30_000;

type InboxFilters = { projectId: string; recipient: "" | OperatorMessage["recipient"] };

function readInboxFilters(): InboxFilters {
  try {
    const value = JSON.parse(window.localStorage.getItem(INBOX_FILTER_STORAGE_KEY) ?? "null") as Partial<InboxFilters> | null;
    return {
      projectId: typeof value?.projectId === "string" ? value.projectId : "",
      recipient: value?.recipient === "operator" || value?.recipient === "supervisor" ? value.recipient : "",
    };
  } catch {
    return { projectId: "", recipient: "" };
  }
}

function writeInboxFilters(filters: InboxFilters): void {
  try {
    window.localStorage.setItem(INBOX_FILTER_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // Browser storage can be disabled; the panel remains usable for this mount.
  }
}

export function sidebarRpcBatches(ids: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += SIDEBAR_RPC_BATCH_SIZE) batches.push(ids.slice(index, index + SIDEBAR_RPC_BATCH_SIZE));
  return batches;
}

const RUNNING_INDICATORS = new Set<PluginSidebarThread["indicator"]>([
  "working-draft",
  "workflow",
  "background-agent",
  "background-command",
  "plan-mode",
  "goal",
  "runtime",
  "draft",
]);
const ATTENTION_INDICATORS = new Set<PluginSidebarThread["indicator"]>(["unread-error", "waiting-for-input", "unread-success"]);

// Values arriving from the host DTO and from this plugin's own RPC are typed,
// not proven. A frontend bundle can outlive the server build it was compiled
// against — a stale bundle rendering a newer server's `{ model, reasoning }`
// object as a React child is what took the sidebar down — so anything that
// reaches JSX or a string method passes through here first.
function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function threadTitle(thread: PluginSidebarThread): string {
  return asText(thread.title) ?? asText(thread.titleFallback) ?? "Untitled thread";
}

function projectAvatar(name: unknown): string {
  const initials = (asText(name) ?? "")
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return initials || "?";
}

export type SidebarThreadSignal = "pending" | "attention" | "running" | "idle";

function activeCount(thread: PluginSidebarThread): number {
  const activity: unknown = thread.activity;
  if (!activity || typeof activity !== "object") return 0;
  return Object.values(activity).reduce<number>((total, count) => total + (typeof count === "number" ? count : 0), 0);
}

export function threadSignal(thread: PluginSidebarThread): { kind: SidebarThreadSignal; label: string } {
  if (thread.hasPendingInteraction) return { kind: "pending", label: thread.indicatorLabel ?? "Pending interaction" };
  if (ATTENTION_INDICATORS.has(thread.indicator)) return { kind: "attention", label: thread.indicatorLabel ?? "Needs attention" };
  if (activeCount(thread) > 0 || RUNNING_INDICATORS.has(thread.indicator)) {
    return { kind: "running", label: thread.indicatorLabel ?? "Running" };
  }
  return { kind: "idle", label: thread.indicatorLabel ?? "Idle" };
}

function isError(thread: PluginSidebarThread): boolean {
  return thread.indicator === "unread-error";
}

// The native list gives status one 16px box at the row's trailing edge holding
// exactly one glyph. Measured off the built-in list in the running app: the
// wrapper is `size-4` (`size-5` on coarse pointers) and the dot inside it is
// 5px. Matching those numbers is the whole point — a different size or slot
// reads as a different control.
const TRAILING_SLOT = "inline-flex size-4 shrink-0 items-center justify-center max-md:pointer-coarse:size-5";
const LEADING_SLOT = "inline-flex size-3.5 shrink-0 items-center justify-center";
const NATIVE_DOT = "size-[5px] rounded-full max-md:pointer-coarse:size-1.5";

export function signalDotClasses(thread: PluginSidebarThread, kind: SidebarThreadSignal): string {
  if (kind === "attention" && isError(thread)) return "bg-destructive";
  if (kind === "pending") return "bg-primary";
  return "bg-muted-foreground/60";
}

// Native's spinner tick ring, so the working state reads as BB's own rather
// than a second dialect. Unlike native it takes a theme accent instead of a
// muted grey: this list is denser, and a muted spinner stops being scannable.
function RunningSpinner({ label }: { label: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4 animate-spin text-primary max-md:pointer-coarse:size-5 motion-reduce:animate-none"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      role="img"
      aria-label={label}
      data-sidebar-thread-spinner=""
    >
      <path d="M12 3V6" />
      <path d="M12 18V21" />
      <path d="M21 12L18 12" />
      <path d="M6 12L3 12" />
      <path d="M18.3635 5.63672L16.2422 7.75804" />
      <path d="M7.75804 16.2422L5.63672 18.3635" />
      <path d="M18.3635 18.3635L16.2422 16.2422" />
      <path d="M7.75804 7.75804L5.63672 5.63672" />
    </svg>
  );
}

// Working state leads the row, ahead of the session name, so a scan down the
// left edge answers "what is running" without reading across. Nothing is
// reserved when idle: the spinner is absent, not invisible, so a still row
// never carries a blank gutter.
function ThreadRunningSpinner({ thread }: { thread: PluginSidebarThread }) {
  const signal = threadSignal(thread);
  if (signal.kind !== "running") return null;
  return (
    <span className={LEADING_SLOT} data-sidebar-thread-signal="running">
      <RunningSpinner label={signal.label} />
    </span>
  );
}

// State stays a small colour-only dot in the native trailing slot, the way the
// built-in list does it. Working rows are the spinner's job, so the dot never
// doubles as one; an idle read row draws nothing.
function ThreadStateDot({ thread }: { thread: PluginSidebarThread }) {
  const signal = threadSignal(thread);
  if (signal.kind === "idle" || signal.kind === "running") return null;
  return (
    <span className={TRAILING_SLOT} data-sidebar-thread-signal={signal.kind}>
      <span
        className={`${NATIVE_DOT} ${signalDotClasses(thread, signal.kind)}`}
        role="img"
        aria-label={signal.label}
        title={signal.label}
        data-sidebar-thread-dot=""
      />
    </span>
  );
}

// BB's own official marks, vendored verbatim from the host bundle (see
// src/provider-marks.ts). Monochrome `currentColor` so the glyph inherits the
// row's theme token, bundled so nothing is fetched. A provider BB ships no
// mark for renders no glyph rather than an invented one.
function ProviderMark({ providerId }: { providerId: string }) {
  const mark = providerMark(providerId);
  if (!mark) return null;
  return (
    <svg
      viewBox={mark.viewBox}
      className="size-3 shrink-0"
      fill="currentColor"
      fillRule={mark.fillRule}
      aria-hidden="true"
      focusable="false"
      data-provider-mark={providerMarkKey(providerId)}
    >
      {mark.paths.map((path) => <path key={path} d={path} />)}
    </svg>
  );
}

// Ordered: the family word is a suffix as often as a prefix, so the first hit
// wins and the prefix entries stay last.
const MODEL_SHORT_NAMES: readonly (readonly [string, string])[] = [
  ["luna", "Luna"],
  ["sol", "Sol"],
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
  ["fable", "Fable"],
  ["kimi", "Kimi"],
  ["gemini", "Gemini"],
  ["grok", "Grok"],
  ["claude", "Claude"],
  ["gpt", "GPT"],
];
const UNAVAILABLE_SHORT_NAME = "—";

export function shortModelName(model: string | null): string {
  if (!model) return UNAVAILABLE_SHORT_NAME;
  const key = model.toLocaleLowerCase();
  const known = MODEL_SHORT_NAMES.find(([needle]) => key.includes(needle));
  if (known) return known[1];
  // Fallback still names what the host reported — the id's own first word, never
  // an invented family.
  const family = key.split("/").at(-1)!.split(/[-_.:]/u).find(Boolean);
  return family ? family[0].toUpperCase() + family.slice(1, 8) : UNAVAILABLE_SHORT_NAME;
}

const REASONING_LETTERS: Record<string, string> = { low: "L", medium: "M", high: "H", xhigh: "X", max: "MAX" };
const UNAVAILABLE_REASONING_LETTER = "–";

// Levels outside the operator's letter set keep the neutral mark; the exact SDK
// level still reaches the badge's accessible name.
export function reasoningLetter(reasoning: string | null): string {
  return REASONING_LETTERS[reasoning ?? ""] ?? UNAVAILABLE_REASONING_LETTER;
}

export function executionBadgeLabel(providerId: string, execution: ThreadExecution | null): string {
  const provider = asText(providerId) ?? "unavailable";
  return `${provider} · model ${asText(execution?.model) ?? "unavailable"} · reasoning ${asText(execution?.reasoning) ?? "unavailable"}`;
}

function ExecutionBadge({ providerId, execution }: { providerId: string; execution: ThreadExecution | null }) {
  const label = executionBadgeLabel(providerId, execution);
  return (
    <span className="flex min-w-0 items-center gap-1" role="img" aria-label={label} title={label} data-thread-execution-badge="">
      <ProviderMark providerId={providerId} />
      <span className="min-w-0 truncate">{shortModelName(asText(execution?.model))}·{reasoningLetter(asText(execution?.reasoning))}</span>
    </span>
  );
}

function matchesSearch(thread: PluginSidebarThread, project: PluginSidebarProject, searchQuery: string): boolean {
  const query = searchQuery.trim().toLocaleLowerCase();
  if (!query) return true;
  return [threadTitle(thread), asText(thread.providerId), asText(project.name), asText(thread.environment?.branchName)]
    .some((value) => (value ?? "").toLocaleLowerCase().includes(query));
}

function sortRecent(a: PluginSidebarThread, b: PluginSidebarThread): number {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

function sortSidebarThreads(threads: PluginSidebarThread[]): PluginSidebarThread[] {
  const inputIndex = new Map(threads.map((thread, index) => [thread.id, index]));
  return threads.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if (a.isPinned) return inputIndex.get(a.id)! - inputIndex.get(b.id)!;
    return sortRecent(a, b);
  });
}

export function groupThreads(
  projects: readonly PluginSidebarProject[],
  threads: readonly PluginSidebarThread[],
  searchQuery = "",
) {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const groups = new Map<string, { project: PluginSidebarProject; threads: PluginSidebarThread[] }>();
  for (const thread of threads) {
    const project = projectById.get(thread.projectId) ?? { id: thread.projectId, name: thread.projectId, isPersonal: false };
    if (!matchesSearch(thread, project, searchQuery)) continue;
    const group = groups.get(project.id) ?? { project, threads: [] };
    group.threads.push(thread);
    groups.set(project.id, group);
  }
  return [...groups.values()].map((group) => ({ ...group, threads: sortSidebarThreads(group.threads) }));
}

type ThreadTreeNode = { thread: PluginSidebarThread; children: ThreadTreeNode[] };

export function buildThreadTree(threads: readonly PluginSidebarThread[]): ThreadTreeNode[] {
  const nodes = new Map(threads.map((thread) => [thread.id, { thread, children: [] as ThreadTreeNode[] }]));
  const roots: ThreadTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.thread.parentThreadId ? nodes.get(node.thread.parentThreadId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (items: ThreadTreeNode[]) => {
    const inputIndex = new Map(items.map((item, index) => [item.thread.id, index]));
    items.sort((a, b) => {
      if (a.thread.isPinned !== b.thread.isPinned) return a.thread.isPinned ? -1 : 1;
      if (a.thread.isPinned) return inputIndex.get(a.thread.id)! - inputIndex.get(b.thread.id)!;
      return sortRecent(a.thread, b.thread);
    });
    items.forEach((item) => sort(item.children));
  };
  sort(roots);
  return roots;
}

function collapseMap(values: Record<string, boolean>): Set<string> {
  return new Set(Object.entries(values).filter(([, collapsed]) => collapsed).map(([id]) => id));
}

const MENU_ITEM = "flex h-7 w-full shrink-0 items-center rounded px-2 text-left text-xs transition-colors duration-150 hover:bg-muted motion-reduce:transition-none";

function ThreadRow({
  thread,
  execution,
  active,
  customState,
  depth,
  collapsed,
  hasChildren,
  onToggleChildren,
  onPinnedDragStart,
  onPinnedDragOver,
  onPinnedDragEnd,
  onNavigate,
}: {
  thread: PluginSidebarThread;
  execution: ThreadExecution | null;
  active: boolean;
  customState: string | undefined;
  depth: number;
  collapsed: boolean;
  hasChildren: boolean;
  onToggleChildren: () => void;
  onPinnedDragStart: (threadId: string) => void;
  onPinnedDragOver: (threadId: string) => void;
  onPinnedDragEnd: (threadId: string) => void;
  onNavigate: () => void;
}) {
  const actions = experimental_useSidebarThreadActions();
  const title = threadTitle(thread);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(title);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => setRenameValue(title), [title]);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [menuOpen]);
  const finishRename = () => {
    const nextTitle = renameValue.trim();
    if (!nextTitle || nextTitle === title) {
      setRenaming(false);
      return;
    }
    void actions.rename(thread.id, nextTitle).catch(() => undefined);
    setRenaming(false);
  };
  const menuAction = (run: () => void) => {
    setMenuOpen(false);
    triggerRef.current?.focus();
    run();
  };
  return (
    <div
      className={`group/row relative flex h-7 items-center gap-1.5 rounded-md pr-1 text-left text-sm transition-colors duration-150 select-none hover:bg-muted/50 motion-reduce:transition-none ${active ? "bg-muted" : ""}`}
      style={{ paddingLeft: `${8 + depth * 16}px` }}
      onPointerDown={(event) => { if (thread.isPinned && event.button === 0) onPinnedDragStart(thread.id); }}
      onPointerEnter={() => onPinnedDragOver(thread.id)}
      onPointerUp={() => onPinnedDragEnd(thread.id)}
    >
      {renaming ? (
        <input autoFocus className="min-w-0 flex-1 rounded border border-border bg-background px-1 text-sm text-foreground" aria-label={`Rename ${title}`} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onBlur={finishRename} onKeyDown={(event) => { if (event.key === "Enter") finishRename(); if (event.key === "Escape") setRenaming(false); }} />
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <ThreadRunningSpinner thread={thread} />
          <a
            href="#"
            className="min-w-0 truncate rounded-md text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-current={active ? "page" : undefined}
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            draggable={false}
            title={thread.environment?.branchName ? `${title} — ${thread.environment.branchName}` : title}
            onClick={(event) => { event.preventDefault(); actions.open(thread.id); onNavigate(); }}
          >
            {title}
          </a>
          {hasChildren ? <button type="button" className="inline-flex size-4 shrink-0 items-center justify-center rounded text-xs leading-none text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground motion-reduce:transition-none" aria-label={`${collapsed ? "Expand" : "Collapse"} ${title} children`} aria-expanded={!collapsed} onClick={onToggleChildren}>{collapsed ? "›" : "⌄"}</button> : null}
        </span>
      )}
      {/* Status sits outside the cross-fading cluster below. Native lets its
          indicator fade under the hover actions; here the row is denser and a
          working thread you are pointing at is exactly the one whose state you
          still want to read, so it stays put. */}
      <ThreadStateDot thread={thread} />
      {/* Meta and actions share one slot and only cross-fade: hovering a row
          must not reflow it, or whatever you were aiming at moves. Capped so
          the title keeps the majority of the row. */}
      <span className="relative flex min-w-5 max-w-[45%] shrink items-center justify-end">
        <span className={`flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground transition-opacity duration-150 group-focus-within/row:opacity-0 group-hover/row:opacity-0 motion-reduce:transition-none ${menuOpen ? "opacity-0" : ""}`}>
          {asText(customState) ? <span className="min-w-0 truncate rounded bg-muted px-1 leading-4" data-custom-thread-state="">{asText(customState)}</span> : null}
          <ExecutionBadge providerId={thread.providerId} execution={execution} />
        </span>
        <button
          ref={triggerRef}
          type="button"
          className={`absolute right-0 z-10 inline-flex size-5 shrink-0 items-center justify-center rounded text-xs leading-none text-muted-foreground transition-opacity duration-150 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-hover/row:opacity-100 motion-reduce:transition-none ${menuOpen ? "opacity-100" : "opacity-0"}`}
          aria-label="Thread actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          ⋯
        </button>
      </span>
      {menuOpen ? <div
        ref={menuRef}
        role="menu"
        aria-label={`${title} actions`}
        className="absolute right-1 top-7 z-20 flex w-44 flex-col rounded-md border border-border bg-background p-1 shadow"
        onKeyDown={(event) => { if (event.key === "Escape") { setMenuOpen(false); triggerRef.current?.focus(); } }}
      >
        <button autoFocus type="button" role="menuitem" className={MENU_ITEM} onClick={() => menuAction(() => actions.open(thread.id, { split: true }))}>Open in split</button>
        <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => menuAction(() => { void actions.setRead(thread.id, thread.isUnread).catch(() => undefined); })}>{thread.isUnread ? "Mark read" : "Mark unread"}</button>
        <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => menuAction(() => { void actions.setPinned(thread.id, !thread.isPinned).catch(() => undefined); })}>{thread.isPinned ? "Unpin" : "Pin"}</button>
        <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => menuAction(() => setRenaming(true))}>Rename</button>
        <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => menuAction(() => actions.archive(thread.id))}>Archive</button>
        <span role="separator" className="my-1 border-t border-border" />
        <button type="button" role="menuitem" className={`${MENU_ITEM} text-destructive`} onClick={() => menuAction(() => actions.requestDelete(thread.id))}>Delete</button>
      </div> : null}
    </div>
  );
}

export function SidebarThreadList({ activeThreadId, onNavigate, searchQuery }: PluginThreadListProps) {
  const sidebar = experimental_useSidebarThreads();
  const rpc = useRpc<typeof rpcContract>();
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [collapsedThreads, setCollapsedThreads] = useState<Set<string>>(() => new Set());
  const draggingThreadId = useRef<string | null>(null);
  const dragTargetId = useRef<string | null>(null);
  const [customStates, setCustomStates] = useState<ThreadStates>({});
  const [indicatorBroken, setIndicatorBroken] = useState<string | null>(null);
  const [threadModels, setThreadModels] = useState<ThreadModels>({});
  const threadIds = useMemo(() => sidebar.threads.map((thread) => thread.id), [sidebar.threads]);
  const threadIdsKey = threadIds.join("\u0000");
  const projectIds = useMemo(() => sidebar.projects.map((project) => project.id), [sidebar.projects]);
  const projectIdsKey = projectIds.join("\u0000");

  useEffect(() => {
    let mounted = true;
    void Promise.all(sidebarRpcBatches(threadIds).map((batch) => rpc.call("threadStates", { threadIds: batch }))).then((states) => {
      const merged = Object.assign({}, ...states);
      if (mounted) setCustomStates(merged);
    }).catch(() => {
      if (mounted) setCustomStates({});
    });
    void Promise.all(sidebarRpcBatches(threadIds).map((batch) => rpc.call("threadModels", { threadIds: batch }))).then((models) => {
      const merged = Object.assign({}, ...models);
      if (mounted) setThreadModels(merged);
    }).catch(() => {
      if (mounted) setThreadModels(Object.fromEntries(threadIds.map((threadId) => [threadId, null])));
    });
    return () => {
      mounted = false;
    };
  }, [rpc, threadIdsKey]);

  useEffect(() => {
    let mounted = true;
    const projectBatches = sidebarRpcBatches(projectIds);
    const threadBatches = sidebarRpcBatches(threadIds);
    void Promise.all(Array.from({ length: Math.max(projectBatches.length, threadBatches.length) }, (_, index) => rpc.call("sidebarCollapseState", {
      projectIds: projectBatches[index] ?? [],
      threadIds: threadBatches[index] ?? [],
    }))).then((states) => {
      const state: SidebarCollapseState = {
        projects: Object.assign({}, ...states.map((result) => result.projects)),
        threads: Object.assign({}, ...states.map((result) => result.threads)),
      };
      if (!mounted) return;
      setCollapsedProjects(collapseMap(state.projects));
      setCollapsedThreads(collapseMap(state.threads));
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, [projectIdsKey, rpc, threadIdsKey]);

  // The nav row is host-rendered and carries no plugin-facing badge surface
  // (get-bb/bb#1852), so the count is painted onto it directly under the narrow
  // exception in docs/sidebar-plugin-nav-collapse.md. A zero-match is the
  // coupling breaking, and it is reported rather than swallowed.
  useEffect(() => {
    let cancelled = false;
    const paint = async () => {
      const results = await Promise.allSettled(projectIds.map((projectId) => rpc.call("operatorMessages", { projectId })));
      if (cancelled) return;
      const unread = results.reduce((total, result) => result.status === "fulfilled"
        ? total + result.value.filter((message) => message.readAtMs === null).length
        : total, 0);
      const painted = paintInboxNavUnread(document, unread);
      if (painted.matched) {
        setIndicatorBroken(null);
        return;
      }
      console.error(`[bb-collab] ${INBOX_INDICATOR_BROKEN_TITLE}: ${painted.reason}`);
      setIndicatorBroken(painted.reason);
    };
    void paint();
    const timer = window.setInterval(() => { void paint(); }, INBOX_UNREAD_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      paintInboxNavUnread(document, 0);
    };
  }, [projectIdsKey, rpc]);

  const indicatorAlert = indicatorBroken === null ? null : (
    <p role="alert" className="p-3 text-sm text-destructive">
      {INBOX_INDICATOR_BROKEN_TITLE} — open Inbox to check for unread messages. Cause: {indicatorBroken}
    </p>
  );

  const groups = groupThreads(sidebar.projects, sidebar.threads, searchQuery);
  if (sidebar.status === "loading") return <>{indicatorAlert}<p className="p-3 text-sm text-muted-foreground">Loading threads…</p></>;
  if (sidebar.status === "error") return <>{indicatorAlert}<p className="p-3 text-sm text-destructive">Unable to load threads.</p></>;
  if (groups.length === 0) return <>{indicatorAlert}<p className="p-3 text-sm text-muted-foreground">No matching threads.</p></>;

  const toggleProject = (projectId: string) => {
    const collapsed = !collapsedProjects.has(projectId);
    setCollapsedProjects((current) => { const next = new Set(current); if (collapsed) next.add(projectId); else next.delete(projectId); return next; });
    void rpc.call("setSidebarCollapse", { kind: "project", id: projectId, collapsed }).catch(() => undefined);
  };
  const toggleThread = (threadId: string) => {
    const collapsed = !collapsedThreads.has(threadId);
    setCollapsedThreads((current) => { const next = new Set(current); if (collapsed) next.add(threadId); else next.delete(threadId); return next; });
    void rpc.call("setSidebarCollapse", { kind: "thread", id: threadId, collapsed }).catch(() => undefined);
  };
  // Placement mirrors a sortable list: dragging down lands after the target,
  // dragging up lands before it. Anchoring on the target alone made every
  // downward drag a no-op.
  const reorderPinned = (draggedId: string, targetId: string) => {
    if (!draggedId || !targetId || draggedId === targetId) return;
    const byId = new Map(sidebar.threads.map((thread) => [thread.id, thread]));
    const dragged = byId.get(draggedId);
    const target = byId.get(targetId);
    if (!dragged?.isPinned || !target?.isPinned) return;
    // Pinned rows are only ever adjacent inside one project group, so the
    // neighbours handed to the host come from that group. A global pinned list
    // names neighbours the user never saw next to the row.
    if (dragged.projectId !== target.projectId) return;
    const order = sidebar.threads.filter((thread) => thread.isPinned && thread.projectId === dragged.projectId).map((thread) => thread.id);
    const from = order.indexOf(draggedId);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const remaining = order.filter((id) => id !== draggedId);
    const insertionIndex = remaining.indexOf(targetId) + (from < to ? 1 : 0);
    void rpc.call("reorderPinned", { threadId: draggedId, previousThreadId: remaining[insertionIndex - 1] ?? null, nextThreadId: remaining[insertionIndex] ?? null }).catch(() => undefined);
  };
  const startPinnedDrag = (threadId: string) => {
    draggingThreadId.current = threadId;
    dragTargetId.current = null;
    // The row's own handler runs first. Reaching here with a source still armed
    // means the release missed every row: commit to the last row crossed on a
    // real release, discard on cancel, and never leave a stale source behind.
    const settle = (event: Event) => {
      if (event.type === "pointerup" && draggingThreadId.current) finishPinnedDrag("");
      draggingThreadId.current = null;
      dragTargetId.current = null;
      window.removeEventListener("pointerup", settle);
      window.removeEventListener("pointercancel", settle);
    };
    window.addEventListener("pointerup", settle);
    window.addEventListener("pointercancel", settle);
  };
  const trackPinnedDrag = (threadId: string) => { if (draggingThreadId.current) dragTargetId.current = threadId; };
  const finishPinnedDrag = (targetId: string) => {
    const draggedId = draggingThreadId.current ?? "";
    draggingThreadId.current = null;
    reorderPinned(draggedId, targetId || dragTargetId.current || "");
    dragTargetId.current = null;
  };

  const renderNode = (node: ThreadTreeNode, execution: ThreadExecution | null, depth: number): ReactNode => {
    const childrenCollapsed = collapsedThreads.has(node.thread.id);
    return <div key={node.thread.id} className="space-y-px">
      <ThreadRow thread={node.thread} execution={execution} active={node.thread.id === activeThreadId} customState={customStates[node.thread.id]} depth={depth} collapsed={childrenCollapsed} hasChildren={node.children.length > 0} onToggleChildren={() => toggleThread(node.thread.id)} onPinnedDragStart={startPinnedDrag} onPinnedDragOver={trackPinnedDrag} onPinnedDragEnd={finishPinnedDrag} onNavigate={onNavigate} />
      {!childrenCollapsed ? node.children.map((child) => renderNode(child, threadModels[child.thread.id] ?? null, depth + 1)) : null}
    </div>;
  };

  return (
    <div className="h-full space-y-3 overflow-y-auto p-1">
      {indicatorAlert}
      {groups.map(({ project, threads }) => {
        const tree = buildThreadTree(threads);
        const collapsed = collapsedProjects.has(project.id);
        const expanded = expandedProjects.has(project.id);
        const visibleThreads = expanded ? tree : tree.slice(0, MAX_VISIBLE_THREADS);
        const projectName = asText(project.name) ?? asText(project.id) ?? "Untitled project";
        return (
          <section key={project.id} aria-labelledby={`project-${project.id}`}>
            <div className="flex h-6 items-center gap-1.5 rounded-md pl-2 pr-1 text-xs font-normal text-muted-foreground">
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] leading-none text-foreground" aria-hidden="true">{projectAvatar(projectName)}</span>
              <span id={`project-${project.id}`} className="min-w-0 truncate">{projectName}</span>
              {/* No type utilities of its own: the counter inherits the header's
                  size, weight, colour and baseline so it never outweighs the name. */}
              <span className="ml-auto shrink-0" data-project-thread-count="">{threads.length}</span>
              <button type="button" className="inline-flex size-4 shrink-0 items-center justify-center rounded leading-none transition-colors duration-150 hover:bg-muted hover:text-foreground motion-reduce:transition-none" aria-label={`${collapsed ? "Expand" : "Collapse"} ${projectName} section`} aria-expanded={!collapsed} onClick={() => toggleProject(project.id)}>{collapsed ? "›" : "⌄"}</button>
            </div>
            {!collapsed ? <div className="mt-0.5 space-y-px">
              {visibleThreads.map((node) => renderNode(node, threadModels[node.thread.id] ?? null, 0))}
              {tree.length > MAX_VISIBLE_THREADS ? (
                <button
                  type="button"
                  className="flex h-6 w-full items-center rounded-md pl-2 text-left text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/50 hover:text-foreground motion-reduce:transition-none"
                  onClick={() => setExpandedProjects((current) => {
                    const updated = new Set(current);
                    if (expanded) updated.delete(project.id);
                    else updated.add(project.id);
                    return updated;
                  })}
                >
                  {expanded ? "Show less" : `Show more (${tree.length - MAX_VISIBLE_THREADS})`}
                </button>
              ) : null}
            </div> : null}
          </section>
        );
      })}
    </div>
  );
}

// Issue #61's deferral is a state of the lane, not a gate on it: it leaves
// `queueBlocked` false and keeps the lane in the same list in the same order,
// so this only ever changes the status text. Every field comes from the `lanes`
// rpc the panel already polls — a deferral has no second source.
export function laneQueueLabel(lane: Lane): string {
  if (lane.queueState !== "deferred" && !lane.deferredReason) {
    return lane.nextStartable ? "next startable" : lane.waitingOn ?? "worker";
  }
  const reason = lane.deferredReason?.replace(/_/gu, " ") ?? "reason unavailable";
  // A deferral has its own clock; `ageMs` is the lane's and would be the wrong
  // duration, so an unknown deferral age states nothing rather than that.
  const since = typeof lane.deferredAgeMs === "number" ? ` · ${age(lane.deferredAgeMs)}` : "";
  return `Deferred · ${reason}${since}`;
}

function LanesPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [lanes, setLanes] = useState<readonly Lane[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void rpc.call("lanes", {}).then((next) => setLanes(next)).catch((reason: unknown) => setError(String(reason)));
  }, [rpc]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <main className="h-full overflow-y-auto p-5">
      <div className="mx-auto max-w-4xl">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Lanes</h1>
            <p className="text-sm text-muted-foreground">Open lanes from bb-collab storage.</p>
          </div>
          <button className="text-sm text-muted-foreground hover:text-foreground" onClick={refresh}>Refresh</button>
        </div>
        {error ? <p className="text-sm text-destructive">Unable to read lanes: {error}</p> : null}
        {lanes.length === 0 ? <p className="text-sm text-muted-foreground">No open lanes.</p> : null}
        <div className="divide-y divide-border border-y border-border">
          {lanes.map((lane) => (
            <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-4 py-3 text-sm" key={lane.executionAttemptId}>
              <div className="min-w-0">
                <div className="truncate font-medium">{lane.laneId}</div>
                <div className="truncate text-xs text-muted-foreground">{lane.threadId ?? "worker not attached"}</div>
              </div>
              <div className="text-muted-foreground">{laneQueueLabel(lane)}</div>
              <time className="text-muted-foreground" title={`${lane.ageMs}ms old`}>{age(lane.ageMs)}</time>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

function InboxPanel(_props: PluginNavPanelProps) {
  const sidebar = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [filters, setFilters] = useState<InboxFilters>(readInboxFilters);
  const projectId = filters.projectId && sidebar.projects.some((project) => project.id === filters.projectId) ? filters.projectId : "";
  const { recipient } = filters;
  const [messages, setMessages] = useState<readonly OperatorMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replyingMessageKey, setReplyingMessageKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshSequence = useRef(0);
  const projects = useMemo(() => projectId ? sidebar.projects.filter((candidate) => candidate.id === projectId) : sidebar.projects, [projectId, sidebar.projects]);
  const projectNames = useMemo(() => new Map(sidebar.projects.map((candidate) => [candidate.id, candidate.name])), [sidebar.projects]);
  const messageKey = (message: OperatorMessage) => `${message.projectId}:${message.messageId}`;
  const visibleMessages = messages.slice(0, MAX_VISIBLE_INBOX_MESSAGES);

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
    void Promise.allSettled(projects.map((project) => rpc.call("operatorMessages", { projectId: project.id, ...(recipient ? { recipient } : {}) })))
      .then((results) => {
        if (sequence !== refreshSequence.current) return;
        const loaded: OperatorMessage[] = [];
        const failed: string[] = [];
        results.forEach((result, index) => {
          if (result.status === "fulfilled") loaded.push(...result.value);
          else if (projectId !== "" || !isUnregisteredInboxProject(result.reason)) failed.push(`${projects[index]!.name} (${projects[index]!.id}): ${String(result.reason)}`);
        });
        loaded.sort((left, right) => Number(left.readAtMs !== null) - Number(right.readAtMs !== null) || right.createdAtMs - left.createdAtMs || right.messageId - left.messageId);
        setMessages(loaded);
        setErrors(failed);
      });
  }, [projects, projectId, recipient, rpc]);

  useEffect(refresh, [refresh]);

  const updateMessage = (next: OperatorMessage) => setMessages((current) => current.map((message) => messageKey(message) === messageKey(next) ? next : message));

  return (
    <main className="h-full overflow-y-auto p-5">
      <div className="mx-auto max-w-4xl">
        <div className="mb-5 flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Project</span>
            <select className="rounded-md border border-border bg-background px-3 py-2" value={projectId} onChange={(event) => setFiltersAndPersist({ projectId: event.target.value, recipient })}>
              <option value="">All projects</option>
              {sidebar.projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.id}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Recipient</span>
            <select className="rounded-md border border-border bg-background px-3 py-2" value={recipient} onChange={(event) => setFiltersAndPersist({ projectId, recipient: event.target.value as InboxFilters["recipient"] })}>
              <option value="">All recipients</option>
              <option value="operator">Operator</option>
              <option value="supervisor">Supervisor</option>
            </select>
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
                    <span>
                      {asText(message.senderLaneId) ? `${asText(message.senderLaneId)} · ` : ""}
                      {asText(message.senderThreadId) ? (
                        <a
                          href="#"
                          className="underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground"
                          aria-label={`Open sender session ${asText(message.senderThreadId)}`}
                          title={`Open sender session ${asText(message.senderThreadId)}`}
                          onClick={(event) => { event.preventDefault(); navigate.toThread(asText(message.senderThreadId)!); }}
                        >
                          {asText(message.senderThreadId)}
                        </a>
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

async function readPluginHttp(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/v1/plugins/bb-collab/http/${path}`, { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

function mountLanePulse({ signal, setStatus }: { signal: AbortSignal; setStatus: (threadId: string, status: PluginComposerThreadRowStatus | null) => void }): () => void {
  let previous = new Set<string>();
  const refresh = async () => {
    try {
      const lanes = await readPluginHttp("lanes", signal) as Lane[];
      const next = new Set<string>();
      for (const lane of lanes) {
        if (!lane.threadId) continue;
        next.add(lane.threadId);
        setStatus(lane.threadId, {
          icon: lane.tone === "error" ? "AlertTriangle" : "GitBranch",
          label: lane.waitingOn ? `Lane ${lane.laneId}: waiting on ${lane.waitingOn}` : `Lane ${lane.laneId}: open`,
          tone: lane.tone,
        });
      }
      for (const threadId of previous) if (!next.has(threadId)) setStatus(threadId, null);
      previous = next;
    } catch {
      // A transient server/read failure must not clear the last known pulse.
    }
  };
  void refresh();
  const timer = window.setInterval(refresh, 5_000);
  return () => window.clearInterval(timer);
}

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "bb-collab-threads",
    title: "bb-collab thread list",
    description: "Group threads by project with durable bb-collab state.",
    component: SidebarThreadList,
  });
  app.slots.sidebarFooterAction({
    id: "bb-collab-settings",
    title: SETTINGS_ACTION_TITLE,
    icon: "Settings",
    run: ({ openSettings }) => openSettings(),
  });
  app.slots.navPanel({
    id: "lanes",
    title: "Lanes",
    icon: "GitBranch",
    path: "lanes",
    component: LanesPanel,
  });
  app.slots.navPanel({
    id: "inbox",
    title: "Inbox",
    icon: "Mail",
    path: "inbox",
    component: InboxPanel,
  });
  app.contentScripts.register({
    id: "lane-thread-status",
    mount: ({ signal, experimental_setThreadRowStatus }) => {
      if (!experimental_setThreadRowStatus) return;
      return mountLanePulse({ signal, setStatus: experimental_setThreadRowStatus });
    },
  });
});
