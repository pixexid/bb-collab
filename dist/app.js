// bb-plugin-runtime-shim:react
var runtime = globalThis.__bbPluginRuntime;
if (runtime == null || runtime.react == null) {
  throw new Error('Cannot load "react": this bundle must be loaded by the BB app, which provides the shared plugin runtime (globalThis.__bbPluginRuntime).');
}
var mod = runtime.react;
var {
  Activity,
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  act,
  cache,
  cacheSignal,
  captureOwnerStack,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  unstable_useCacheRefresh,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version
} = mod;

// bb-plugin-runtime-shim:@bb/plugin-sdk/app
var runtime2 = globalThis.__bbPluginRuntime;
if (runtime2 == null || runtime2.pluginSdkApp == null) {
  throw new Error('Cannot load "@bb/plugin-sdk/app": this bundle must be loaded by the BB app, which provides the shared plugin runtime (globalThis.__bbPluginRuntime).');
}
var mod2 = runtime2.pluginSdkApp;
var {
  Markdown,
  ThreadChat,
  definePluginApp,
  experimental_NewThreadComposer,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit,
  experimental_useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useComposer,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings
} = mod2;

// bb-plugin-runtime-shim:react/jsx-runtime
var runtime3 = globalThis.__bbPluginRuntime;
if (runtime3 == null || runtime3.jsxRuntime == null) {
  throw new Error('Cannot load "react/jsx-runtime": this bundle must be loaded by the BB app, which provides the shared plugin runtime (globalThis.__bbPluginRuntime).');
}
var mod3 = runtime3.jsxRuntime;
var {
  Fragment: Fragment2,
  jsx,
  jsxs
} = mod3;

// app.tsx
var MAX_VISIBLE_THREADS = 5;
var RUNNING_INDICATORS = /* @__PURE__ */ new Set([
  "working-draft",
  "workflow",
  "background-agent",
  "background-command",
  "plan-mode",
  "goal",
  "runtime",
  "draft"
]);
var ATTENTION_INDICATORS = /* @__PURE__ */ new Set(["unread-error", "waiting-for-input", "unread-success"]);
function asText(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
function threadTitle(thread) {
  return asText(thread.title) ?? asText(thread.titleFallback) ?? "Untitled thread";
}
function projectAvatar(name) {
  const initials = (asText(name) ?? "").split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return initials || "?";
}
function activeCount(thread) {
  const activity = thread.activity;
  if (!activity || typeof activity !== "object") return 0;
  return Object.values(activity).reduce((total, count) => total + (typeof count === "number" ? count : 0), 0);
}
function threadSignal(thread) {
  if (thread.hasPendingInteraction) return { kind: "pending", label: thread.indicatorLabel ?? "Pending interaction" };
  if (ATTENTION_INDICATORS.has(thread.indicator)) return { kind: "attention", label: thread.indicatorLabel ?? "Needs attention" };
  if (activeCount(thread) > 0 || RUNNING_INDICATORS.has(thread.indicator)) {
    return { kind: "running", label: thread.indicatorLabel ?? "Running" };
  }
  return { kind: "idle", label: thread.indicatorLabel ?? "Idle" };
}
function isError(thread) {
  return thread.indicator === "unread-error";
}
var TRAILING_SLOT = "inline-flex size-4 shrink-0 items-center justify-center max-md:pointer-coarse:size-5";
var NATIVE_DOT = "size-[5px] rounded-full max-md:pointer-coarse:size-1.5";
function signalDotClasses(thread, kind) {
  if (kind === "attention" && isError(thread)) return "bg-destructive";
  if (kind === "pending") return "bg-primary";
  return "bg-muted-foreground/60";
}
function RunningSpinner({ label }) {
  return /* @__PURE__ */ jsxs(
    "svg",
    {
      viewBox: "0 0 24 24",
      className: "size-4 animate-spin text-primary max-md:pointer-coarse:size-5 motion-reduce:animate-none",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.5,
      strokeLinecap: "round",
      role: "img",
      "aria-label": label,
      "data-sidebar-thread-spinner": "",
      children: [
        /* @__PURE__ */ jsx("path", { d: "M12 3V6" }),
        /* @__PURE__ */ jsx("path", { d: "M12 18V21" }),
        /* @__PURE__ */ jsx("path", { d: "M21 12L18 12" }),
        /* @__PURE__ */ jsx("path", { d: "M6 12L3 12" }),
        /* @__PURE__ */ jsx("path", { d: "M18.3635 5.63672L16.2422 7.75804" }),
        /* @__PURE__ */ jsx("path", { d: "M7.75804 16.2422L5.63672 18.3635" }),
        /* @__PURE__ */ jsx("path", { d: "M18.3635 18.3635L16.2422 16.2422" }),
        /* @__PURE__ */ jsx("path", { d: "M7.75804 7.75804L5.63672 5.63672" })
      ]
    }
  );
}
function ThreadTrailingIndicator({ thread }) {
  const signal = threadSignal(thread);
  if (signal.kind === "idle") return null;
  return /* @__PURE__ */ jsx("span", { className: TRAILING_SLOT, "data-sidebar-thread-signal": signal.kind, children: signal.kind === "running" ? /* @__PURE__ */ jsx(RunningSpinner, { label: signal.label }) : /* @__PURE__ */ jsx(
    "span",
    {
      className: `${NATIVE_DOT} ${signalDotClasses(thread, signal.kind)}`,
      role: "img",
      "aria-label": signal.label,
      title: signal.label,
      "data-sidebar-thread-dot": ""
    }
  ) });
}
var PROVIDER_MARKS = {
  codex: "M8 1.8 13.4 5v6L8 14.2 2.6 11V5z",
  openai: "M8 1.8 13.4 5v6L8 14.2 2.6 11V5z",
  claudecode: "M8 2.2v11.6M3 5.1l10 5.8M13 5.1 3 10.9",
  anthropic: "M8 2.2v11.6M3 5.1l10 5.8M13 5.1 3 10.9",
  pi: "M2.8 4.6h10.4M6.2 4.6v7.2M10.4 4.6v5.6a1.6 1.6 0 0 0 2.4 1.4",
  kimi: "M2.8 4.6h10.4M6.2 4.6v7.2M10.4 4.6v5.6a1.6 1.6 0 0 0 2.4 1.4",
  cursor: "M3.2 2.4 12.8 8l-4.4 1.2L6.6 13.6z"
};
var GENERIC_PROVIDER_MARK = "M8 2.6a5.4 5.4 0 1 0 0 10.8 5.4 5.4 0 0 0 0-10.8z";
function providerMarkKey(providerId) {
  return (asText(providerId) ?? "").toLocaleLowerCase().replace(/[^a-z0-9]/gu, "");
}
function providerMarkPath(providerId) {
  return PROVIDER_MARKS[providerMarkKey(providerId)] ?? GENERIC_PROVIDER_MARK;
}
function ProviderMark({ providerId }) {
  const key = providerMarkKey(providerId);
  return /* @__PURE__ */ jsx(
    "svg",
    {
      viewBox: "0 0 16 16",
      className: "size-3 shrink-0",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.4,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
      "data-provider-mark": key,
      children: /* @__PURE__ */ jsx("path", { d: providerMarkPath(providerId) })
    }
  );
}
var MODEL_SHORT_NAMES = [
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
  ["gpt", "GPT"]
];
var UNAVAILABLE_SHORT_NAME = "\u2014";
function shortModelName(model) {
  if (!model) return UNAVAILABLE_SHORT_NAME;
  const key = model.toLocaleLowerCase();
  const known = MODEL_SHORT_NAMES.find(([needle]) => key.includes(needle));
  if (known) return known[1];
  const family = key.split("/").at(-1).split(/[-_.:]/u).find(Boolean);
  return family ? family[0].toUpperCase() + family.slice(1, 8) : UNAVAILABLE_SHORT_NAME;
}
var REASONING_LETTERS = { low: "L", medium: "M", high: "H", xhigh: "X", max: "MAX" };
var UNAVAILABLE_REASONING_LETTER = "\u2013";
function reasoningLetter(reasoning) {
  return REASONING_LETTERS[reasoning ?? ""] ?? UNAVAILABLE_REASONING_LETTER;
}
function executionBadgeLabel(providerId, execution) {
  const provider = asText(providerId) ?? "unavailable";
  return `${provider} \xB7 model ${asText(execution?.model) ?? "unavailable"} \xB7 reasoning ${asText(execution?.reasoning) ?? "unavailable"}`;
}
function ExecutionBadge({ providerId, execution }) {
  const label = executionBadgeLabel(providerId, execution);
  return /* @__PURE__ */ jsxs("span", { className: "flex min-w-0 items-center gap-1", role: "img", "aria-label": label, title: label, "data-thread-execution-badge": "", children: [
    /* @__PURE__ */ jsx(ProviderMark, { providerId }),
    /* @__PURE__ */ jsxs("span", { className: "min-w-0 truncate", children: [
      shortModelName(asText(execution?.model)),
      "\xB7",
      reasoningLetter(asText(execution?.reasoning))
    ] })
  ] });
}
function matchesSearch(thread, project, searchQuery) {
  const query = searchQuery.trim().toLocaleLowerCase();
  if (!query) return true;
  return [threadTitle(thread), asText(thread.providerId), asText(project.name), asText(thread.environment?.branchName)].some((value) => (value ?? "").toLocaleLowerCase().includes(query));
}
function sortRecent(a, b) {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}
function sortSidebarThreads(threads) {
  const inputIndex = new Map(threads.map((thread, index) => [thread.id, index]));
  return threads.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if (a.isPinned) return inputIndex.get(a.id) - inputIndex.get(b.id);
    return sortRecent(a, b);
  });
}
function groupThreads(projects, threads, searchQuery = "") {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const groups = /* @__PURE__ */ new Map();
  for (const thread of threads) {
    const project = projectById.get(thread.projectId) ?? { id: thread.projectId, name: thread.projectId, isPersonal: false };
    if (!matchesSearch(thread, project, searchQuery)) continue;
    const group = groups.get(project.id) ?? { project, threads: [] };
    group.threads.push(thread);
    groups.set(project.id, group);
  }
  return [...groups.values()].map((group) => ({ ...group, threads: sortSidebarThreads(group.threads) }));
}
function buildThreadTree(threads) {
  const nodes = new Map(threads.map((thread) => [thread.id, { thread, children: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.thread.parentThreadId ? nodes.get(node.thread.parentThreadId) : void 0;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (items) => {
    const inputIndex = new Map(items.map((item, index) => [item.thread.id, index]));
    items.sort((a, b) => {
      if (a.thread.isPinned !== b.thread.isPinned) return a.thread.isPinned ? -1 : 1;
      if (a.thread.isPinned) return inputIndex.get(a.thread.id) - inputIndex.get(b.thread.id);
      return sortRecent(a.thread, b.thread);
    });
    items.forEach((item) => sort(item.children));
  };
  sort(roots);
  return roots;
}
function collapseMap(values) {
  return new Set(Object.entries(values).filter(([, collapsed]) => collapsed).map(([id]) => id));
}
var MENU_ITEM = "flex h-7 w-full shrink-0 items-center rounded px-2 text-left text-xs transition-colors duration-150 hover:bg-muted motion-reduce:transition-none";
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
  onNavigate
}) {
  const actions = experimental_useSidebarThreadActions();
  const title = threadTitle(thread);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(title);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);
  useEffect(() => setRenameValue(title), [title]);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutside = (event) => {
      const target = event.target;
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
    void actions.rename(thread.id, nextTitle).catch(() => void 0);
    setRenaming(false);
  };
  const menuAction = (run) => {
    setMenuOpen(false);
    triggerRef.current?.focus();
    run();
  };
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: `group/row relative flex h-7 items-center gap-1.5 rounded-md pr-1 text-left text-sm transition-colors duration-150 select-none hover:bg-muted/50 motion-reduce:transition-none ${active ? "bg-muted" : ""}`,
      style: { paddingLeft: `${8 + depth * 16}px` },
      onPointerDown: (event) => {
        if (thread.isPinned && event.button === 0) onPinnedDragStart(thread.id);
      },
      onPointerEnter: () => onPinnedDragOver(thread.id),
      onPointerUp: () => onPinnedDragEnd(thread.id),
      children: [
        renaming ? /* @__PURE__ */ jsx("input", { autoFocus: true, className: "min-w-0 flex-1 rounded border border-border bg-background px-1 text-sm text-foreground", "aria-label": `Rename ${title}`, value: renameValue, onChange: (event) => setRenameValue(event.target.value), onBlur: finishRename, onKeyDown: (event) => {
          if (event.key === "Enter") finishRename();
          if (event.key === "Escape") setRenaming(false);
        } }) : /* @__PURE__ */ jsxs("span", { className: "flex min-w-0 flex-1 items-center gap-1.5", children: [
          /* @__PURE__ */ jsx(
            "a",
            {
              href: "#",
              className: "min-w-0 truncate rounded-md text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary",
              "aria-current": active ? "page" : void 0,
              "data-sidebar-thread-shortcut-target": "",
              "data-sidebar-thread-id": thread.id,
              draggable: false,
              title: thread.environment?.branchName ? `${title} \u2014 ${thread.environment.branchName}` : title,
              onClick: (event) => {
                event.preventDefault();
                actions.open(thread.id);
                onNavigate();
              },
              children: title
            }
          ),
          hasChildren ? /* @__PURE__ */ jsx("button", { type: "button", className: "inline-flex size-4 shrink-0 items-center justify-center rounded text-xs leading-none text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground motion-reduce:transition-none", "aria-label": `${collapsed ? "Expand" : "Collapse"} ${title} children`, "aria-expanded": !collapsed, onClick: onToggleChildren, children: collapsed ? "\u203A" : "\u2304" }) : null
        ] }),
        /* @__PURE__ */ jsx(ThreadTrailingIndicator, { thread }),
        /* @__PURE__ */ jsxs("span", { className: "relative flex min-w-5 max-w-[45%] shrink items-center justify-end", children: [
          /* @__PURE__ */ jsxs("span", { className: `flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground transition-opacity duration-150 group-focus-within/row:opacity-0 group-hover/row:opacity-0 motion-reduce:transition-none ${menuOpen ? "opacity-0" : ""}`, children: [
            asText(customState) ? /* @__PURE__ */ jsx("span", { className: "min-w-0 truncate rounded bg-muted px-1 leading-4", "data-custom-thread-state": "", children: asText(customState) }) : null,
            /* @__PURE__ */ jsx(ExecutionBadge, { providerId: thread.providerId, execution })
          ] }),
          /* @__PURE__ */ jsx(
            "button",
            {
              ref: triggerRef,
              type: "button",
              className: `absolute right-0 z-10 inline-flex size-5 shrink-0 items-center justify-center rounded text-xs leading-none text-muted-foreground transition-opacity duration-150 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-hover/row:opacity-100 motion-reduce:transition-none ${menuOpen ? "opacity-100" : "opacity-0"}`,
              "aria-label": "Thread actions",
              "aria-haspopup": "menu",
              "aria-expanded": menuOpen,
              onClick: () => setMenuOpen((open) => !open),
              children: "\u22EF"
            }
          )
        ] }),
        menuOpen ? /* @__PURE__ */ jsxs(
          "div",
          {
            ref: menuRef,
            role: "menu",
            "aria-label": `${title} actions`,
            className: "absolute right-1 top-7 z-20 flex w-44 flex-col rounded-md border border-border bg-background p-1 shadow",
            onKeyDown: (event) => {
              if (event.key === "Escape") {
                setMenuOpen(false);
                triggerRef.current?.focus();
              }
            },
            children: [
              /* @__PURE__ */ jsx("button", { autoFocus: true, type: "button", role: "menuitem", className: MENU_ITEM, onClick: () => menuAction(() => actions.open(thread.id, { split: true })), children: "Open in split" }),
              /* @__PURE__ */ jsx("button", { type: "button", role: "menuitem", className: MENU_ITEM, onClick: () => menuAction(() => {
                void actions.setRead(thread.id, thread.isUnread).catch(() => void 0);
              }), children: thread.isUnread ? "Mark read" : "Mark unread" }),
              /* @__PURE__ */ jsx("button", { type: "button", role: "menuitem", className: MENU_ITEM, onClick: () => menuAction(() => {
                void actions.setPinned(thread.id, !thread.isPinned).catch(() => void 0);
              }), children: thread.isPinned ? "Unpin" : "Pin" }),
              /* @__PURE__ */ jsx("button", { type: "button", role: "menuitem", className: MENU_ITEM, onClick: () => menuAction(() => setRenaming(true)), children: "Rename" }),
              /* @__PURE__ */ jsx("button", { type: "button", role: "menuitem", className: MENU_ITEM, onClick: () => menuAction(() => actions.archive(thread.id)), children: "Archive" }),
              /* @__PURE__ */ jsx("span", { role: "separator", className: "my-1 border-t border-border" }),
              /* @__PURE__ */ jsx("button", { type: "button", role: "menuitem", className: `${MENU_ITEM} text-destructive`, onClick: () => menuAction(() => actions.requestDelete(thread.id)), children: "Delete" })
            ]
          }
        ) : null
      ]
    }
  );
}
function SidebarThreadList({ activeThreadId, onNavigate, searchQuery }) {
  const sidebar = experimental_useSidebarThreads();
  const rpc = useRpc();
  const [expandedProjects, setExpandedProjects] = useState(() => /* @__PURE__ */ new Set());
  const [collapsedProjects, setCollapsedProjects] = useState(() => /* @__PURE__ */ new Set());
  const [collapsedThreads, setCollapsedThreads] = useState(() => /* @__PURE__ */ new Set());
  const draggingThreadId = useRef(null);
  const dragTargetId = useRef(null);
  const [customStates, setCustomStates] = useState({});
  const [threadModels, setThreadModels] = useState({});
  const threadIds = useMemo(() => sidebar.threads.map((thread) => thread.id), [sidebar.threads]);
  const threadIdsKey = threadIds.join("\0");
  const projectIds = useMemo(() => sidebar.projects.map((project) => project.id), [sidebar.projects]);
  const projectIdsKey = projectIds.join("\0");
  useEffect(() => {
    let mounted = true;
    void rpc.call("threadStates", { threadIds }).then((states) => {
      if (mounted) setCustomStates(states);
    }).catch(() => {
      if (mounted) setCustomStates({});
    });
    void rpc.call("threadModels", { threadIds }).then((models) => {
      if (mounted) setThreadModels(models);
    }).catch(() => {
      if (mounted) setThreadModels(Object.fromEntries(threadIds.map((threadId) => [threadId, null])));
    });
    return () => {
      mounted = false;
    };
  }, [rpc, threadIdsKey]);
  useEffect(() => {
    let mounted = true;
    void rpc.call("sidebarCollapseState", { projectIds, threadIds }).then((state) => {
      if (!mounted) return;
      setCollapsedProjects(collapseMap(state.projects));
      setCollapsedThreads(collapseMap(state.threads));
    }).catch(() => void 0);
    return () => {
      mounted = false;
    };
  }, [projectIdsKey, rpc, threadIdsKey]);
  const groups = groupThreads(sidebar.projects, sidebar.threads, searchQuery);
  if (sidebar.status === "loading") return /* @__PURE__ */ jsx("p", { className: "p-3 text-sm text-muted-foreground", children: "Loading threads\u2026" });
  if (sidebar.status === "error") return /* @__PURE__ */ jsx("p", { className: "p-3 text-sm text-destructive", children: "Unable to load threads." });
  if (groups.length === 0) return /* @__PURE__ */ jsx("p", { className: "p-3 text-sm text-muted-foreground", children: "No matching threads." });
  const toggleProject = (projectId) => {
    const collapsed = !collapsedProjects.has(projectId);
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (collapsed) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
    void rpc.call("setSidebarCollapse", { kind: "project", id: projectId, collapsed }).catch(() => void 0);
  };
  const toggleThread = (threadId) => {
    const collapsed = !collapsedThreads.has(threadId);
    setCollapsedThreads((current) => {
      const next = new Set(current);
      if (collapsed) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
    void rpc.call("setSidebarCollapse", { kind: "thread", id: threadId, collapsed }).catch(() => void 0);
  };
  const reorderPinned = (draggedId, targetId) => {
    if (!draggedId || !targetId || draggedId === targetId) return;
    const byId = new Map(sidebar.threads.map((thread) => [thread.id, thread]));
    const dragged = byId.get(draggedId);
    const target = byId.get(targetId);
    if (!dragged?.isPinned || !target?.isPinned) return;
    if (dragged.projectId !== target.projectId) return;
    const order = sidebar.threads.filter((thread) => thread.isPinned && thread.projectId === dragged.projectId).map((thread) => thread.id);
    const from = order.indexOf(draggedId);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const remaining = order.filter((id) => id !== draggedId);
    const insertionIndex = remaining.indexOf(targetId) + (from < to ? 1 : 0);
    void rpc.call("reorderPinned", { threadId: draggedId, previousThreadId: remaining[insertionIndex - 1] ?? null, nextThreadId: remaining[insertionIndex] ?? null }).catch(() => void 0);
  };
  const startPinnedDrag = (threadId) => {
    draggingThreadId.current = threadId;
    dragTargetId.current = null;
    const settle = (event) => {
      if (event.type === "pointerup" && draggingThreadId.current) finishPinnedDrag("");
      draggingThreadId.current = null;
      dragTargetId.current = null;
      window.removeEventListener("pointerup", settle);
      window.removeEventListener("pointercancel", settle);
    };
    window.addEventListener("pointerup", settle);
    window.addEventListener("pointercancel", settle);
  };
  const trackPinnedDrag = (threadId) => {
    if (draggingThreadId.current) dragTargetId.current = threadId;
  };
  const finishPinnedDrag = (targetId) => {
    const draggedId = draggingThreadId.current ?? "";
    draggingThreadId.current = null;
    reorderPinned(draggedId, targetId || dragTargetId.current || "");
    dragTargetId.current = null;
  };
  const renderNode = (node, execution, depth) => {
    const childrenCollapsed = collapsedThreads.has(node.thread.id);
    return /* @__PURE__ */ jsxs("div", { className: "space-y-px", children: [
      /* @__PURE__ */ jsx(ThreadRow, { thread: node.thread, execution, active: node.thread.id === activeThreadId, customState: customStates[node.thread.id], depth, collapsed: childrenCollapsed, hasChildren: node.children.length > 0, onToggleChildren: () => toggleThread(node.thread.id), onPinnedDragStart: startPinnedDrag, onPinnedDragOver: trackPinnedDrag, onPinnedDragEnd: finishPinnedDrag, onNavigate }),
      !childrenCollapsed ? node.children.map((child) => renderNode(child, threadModels[child.thread.id] ?? null, depth + 1)) : null
    ] }, node.thread.id);
  };
  return /* @__PURE__ */ jsx("div", { className: "h-full space-y-3 overflow-y-auto p-1", children: groups.map(({ project, threads }) => {
    const tree = buildThreadTree(threads);
    const collapsed = collapsedProjects.has(project.id);
    const expanded = expandedProjects.has(project.id);
    const visibleThreads = expanded ? tree : tree.slice(0, MAX_VISIBLE_THREADS);
    const projectName = asText(project.name) ?? asText(project.id) ?? "Untitled project";
    return /* @__PURE__ */ jsxs("section", { "aria-labelledby": `project-${project.id}`, children: [
      /* @__PURE__ */ jsxs("div", { className: "flex h-6 items-center gap-1.5 rounded-md pl-2 pr-1 text-xs font-normal text-muted-foreground", children: [
        /* @__PURE__ */ jsx("span", { className: "flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] leading-none text-foreground", "aria-hidden": "true", children: projectAvatar(projectName) }),
        /* @__PURE__ */ jsx("span", { id: `project-${project.id}`, className: "min-w-0 truncate", children: projectName }),
        /* @__PURE__ */ jsx("span", { className: "ml-auto shrink-0", "data-project-thread-count": "", children: threads.length }),
        /* @__PURE__ */ jsx("button", { type: "button", className: "inline-flex size-4 shrink-0 items-center justify-center rounded leading-none transition-colors duration-150 hover:bg-muted hover:text-foreground motion-reduce:transition-none", "aria-label": `${collapsed ? "Expand" : "Collapse"} ${projectName} section`, "aria-expanded": !collapsed, onClick: () => toggleProject(project.id), children: collapsed ? "\u203A" : "\u2304" })
      ] }),
      !collapsed ? /* @__PURE__ */ jsxs("div", { className: "mt-0.5 space-y-px", children: [
        visibleThreads.map((node) => renderNode(node, threadModels[node.thread.id] ?? null, 0)),
        tree.length > MAX_VISIBLE_THREADS ? /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            className: "flex h-6 w-full items-center rounded-md pl-2 text-left text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/50 hover:text-foreground motion-reduce:transition-none",
            onClick: () => setExpandedProjects((current) => {
              const updated = new Set(current);
              if (expanded) updated.delete(project.id);
              else updated.add(project.id);
              return updated;
            }),
            children: expanded ? "Show less" : `Show more (${tree.length - MAX_VISIBLE_THREADS})`
          }
        ) : null
      ] }) : null
    ] }, project.id);
  }) });
}
function OperatorReceiptForm({ interaction, submit, cancel }) {
  const payload = interaction.payload;
  const [confirmed, setConfirmed] = useState(false);
  const valid = typeof payload.projectId === "string" && typeof payload.mutationClass === "string" && typeof payload.candidateHead === "string";
  const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
  const mutationClass = typeof payload.mutationClass === "string" ? payload.mutationClass : null;
  const candidateHead = typeof payload.candidateHead === "string" ? payload.candidateHead : null;
  return /* @__PURE__ */ jsxs(
    "form",
    {
      className: "space-y-4 border-t border-border bg-background p-4",
      onSubmit: (event) => {
        event.preventDefault();
        if (!valid || !confirmed) return;
        void submit({
          confirmed: true,
          projectId,
          mutationClass,
          candidateHead
        });
      },
      children: [
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx("h2", { className: "font-semibold", children: "Confirm operator receipt" }),
          /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground", children: "This records an interim confirmation only; it does not authorize a mutation." })
        ] }),
        /* @__PURE__ */ jsxs("dl", { className: "grid gap-2 text-sm", children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("dt", { className: "text-muted-foreground", children: "Project" }),
            /* @__PURE__ */ jsx("dd", { className: "font-mono", children: String(payload.projectId ?? "invalid") })
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("dt", { className: "text-muted-foreground", children: "Mutation" }),
            /* @__PURE__ */ jsx("dd", { className: "font-mono", children: String(payload.mutationClass ?? "invalid") })
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("dt", { className: "text-muted-foreground", children: "Candidate head" }),
            /* @__PURE__ */ jsx("dd", { className: "break-all font-mono", children: String(payload.candidateHead ?? "invalid") })
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("dt", { className: "text-muted-foreground", children: "Retirement condition" }),
            /* @__PURE__ */ jsx("dd", { children: String(payload.retirementCondition ?? "invalid") })
          ] })
        ] }),
        /* @__PURE__ */ jsxs("label", { className: "flex items-start gap-2 text-sm", children: [
          /* @__PURE__ */ jsx("input", { type: "checkbox", checked: confirmed, onChange: (event) => setConfirmed(event.target.checked) }),
          /* @__PURE__ */ jsx("span", { children: "I confirm this exact project, mutation class, and candidate head." })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "flex gap-2", children: [
          /* @__PURE__ */ jsx("button", { className: "rounded border border-border px-3 py-1 text-sm", type: "button", onClick: () => void cancel(), children: "Cancel" }),
          /* @__PURE__ */ jsx("button", { className: "rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50", type: "submit", disabled: !valid || !confirmed, children: "Confirm" })
        ] })
      ]
    }
  );
}
function age(ms) {
  const minutes = Math.floor(ms / 6e4);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}
function LanesPanel() {
  const rpc = useRpc();
  const [lanes, setLanes] = useState([]);
  const [error, setError] = useState(null);
  const refresh = useCallback(() => {
    void rpc.call("lanes", {}).then((next) => {
      setLanes(next);
      setError(null);
    }).catch((reason) => setError(String(reason)));
  }, [rpc]);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5e3);
    return () => window.clearInterval(timer);
  }, [refresh]);
  return /* @__PURE__ */ jsx("main", { className: "h-full overflow-y-auto p-5", children: /* @__PURE__ */ jsxs("div", { className: "mx-auto max-w-4xl", children: [
    /* @__PURE__ */ jsxs("div", { className: "mb-5 flex items-center justify-between", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("h1", { className: "text-lg font-semibold", children: "Lanes" }),
        /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground", children: "Open lanes from bb-collab storage." })
      ] }),
      /* @__PURE__ */ jsx("button", { className: "text-sm text-muted-foreground hover:text-foreground", onClick: refresh, children: "Refresh" })
    ] }),
    error ? /* @__PURE__ */ jsxs("p", { className: "text-sm text-destructive", children: [
      "Unable to read lanes: ",
      error
    ] }) : null,
    lanes.length === 0 ? /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground", children: "No open lanes." }) : null,
    /* @__PURE__ */ jsx("div", { className: "divide-y divide-border border-y border-border", children: lanes.map((lane) => /* @__PURE__ */ jsxs("div", { className: "grid grid-cols-[minmax(0,1fr)_auto_auto] gap-4 py-3 text-sm", children: [
      /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
        /* @__PURE__ */ jsx("div", { className: "truncate font-medium", children: lane.laneId }),
        /* @__PURE__ */ jsxs("div", { className: "truncate text-xs text-muted-foreground", children: [
          lane.assignmentKind,
          " \xB7 ",
          lane.threadId ?? "worker not attached"
        ] })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "text-muted-foreground", children: lane.waitingOn ?? "worker" }),
      /* @__PURE__ */ jsx("time", { className: "text-muted-foreground", title: `${lane.ageMs}ms old`, children: age(lane.ageMs) })
    ] }, lane.executionAttemptId)) })
  ] }) });
}
async function readLanes(signal) {
  const response = await fetch("/api/v1/plugins/bb-collab/http/lanes", { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}
function mountLanePulse({ signal, setStatus }) {
  let previous = /* @__PURE__ */ new Set();
  const refresh = async () => {
    try {
      const lanes = await readLanes(signal);
      const next = /* @__PURE__ */ new Set();
      for (const lane of lanes) {
        if (!lane.threadId) continue;
        next.add(lane.threadId);
        setStatus(lane.threadId, {
          icon: lane.tone === "error" ? "AlertTriangle" : "GitBranch",
          label: lane.waitingOn ? `Lane ${lane.laneId}: waiting on ${lane.waitingOn}` : `Lane ${lane.laneId}: open`,
          tone: lane.tone
        });
      }
      for (const threadId of previous) if (!next.has(threadId)) setStatus(threadId, null);
      previous = next;
    } catch {
    }
  };
  void refresh();
  const timer = window.setInterval(refresh, 5e3);
  return () => window.clearInterval(timer);
}
var app_default = definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "bb-collab-threads",
    title: "bb-collab thread list",
    description: "Group threads by project with durable bb-collab state.",
    component: SidebarThreadList
  });
  app.slots.pendingInteraction({ id: "operator-receipt", component: OperatorReceiptForm });
  app.slots.navPanel({
    id: "lanes",
    title: "Lanes",
    icon: "GitBranch",
    path: "lanes",
    component: LanesPanel
  });
  app.contentScripts.register({
    id: "lane-thread-status",
    mount: ({ signal, experimental_setThreadRowStatus }) => {
      if (!experimental_setThreadRowStatus) return;
      return mountLanePulse({ signal, setStatus: experimental_setThreadRowStatus });
    }
  });
});
export {
  SidebarThreadList,
  buildThreadTree,
  app_default as default,
  executionBadgeLabel,
  groupThreads,
  providerMarkKey,
  providerMarkPath,
  reasoningLetter,
  shortModelName,
  signalDotClasses,
  threadSignal
};
