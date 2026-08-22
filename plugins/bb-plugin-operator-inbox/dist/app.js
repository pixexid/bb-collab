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

// bb-plugin-runtime-shim:@get-bb/plugin-sdk/app
var runtime2 = globalThis.__bbPluginRuntime;
if (runtime2 == null || runtime2.pluginSdkApp == null) {
  throw new Error('Cannot load "@get-bb/plugin-sdk/app": this bundle must be loaded by the BB app, which provides the shared plugin runtime (globalThis.__bbPluginRuntime).');
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

// src/inbox-nav-indicator.ts
var INBOX_NAV_REGION_SELECTOR = '[data-testid="plugin-nav-sidebar-items"]';
var INBOX_NAV_ROW_TITLE = "Inbox";
var LANES_NAV_ROW_TITLE = "Lanes";
var INBOX_UNREAD_MARKER = "data-bb-collab-inbox-unread";
var INBOX_INDICATOR_BROKEN_TITLE = "Inbox unread indicator broken";
var DOT_STYLE = "margin-left:auto;flex:0 0 auto;width:0.5rem;height:0.5rem;border-radius:9999px;background-color:currentColor";
var RENDERING_ATTRIBUTES = [
  "d",
  "points",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "width",
  "height",
  "transform",
  "transform-origin",
  "style",
  "viewBox",
  "preserveAspectRatio",
  "href",
  "xlink:href",
  "offset"
];
function navRows(root) {
  const region = root.querySelector(INBOX_NAV_REGION_SELECTOR);
  return region === null ? null : Array.from(region.querySelectorAll("button"));
}
function rowsTitled(rows, title) {
  return rows.filter((row) => row.textContent?.trim() === title);
}
function paintInboxNavUnread(root, unread) {
  const rows = navRows(root);
  if (rows === null) {
    return { matched: false, reason: `no element matches ${INBOX_NAV_REGION_SELECTOR}` };
  }
  const matches = rowsTitled(rows, INBOX_NAV_ROW_TITLE);
  if (matches.length !== 1) {
    return { matched: false, reason: `${matches.length} of the ${rows.length} rows in ${INBOX_NAV_REGION_SELECTOR} are titled ${JSON.stringify(INBOX_NAV_ROW_TITLE)}, expected exactly 1` };
  }
  const row = matches[0];
  const existing = row.querySelector(`[${INBOX_UNREAD_MARKER}]`);
  if (unread < 1) {
    existing?.remove();
    return { matched: true };
  }
  const dot = existing ?? row.appendChild(row.ownerDocument.createElement("span"));
  dot.setAttribute(INBOX_UNREAD_MARKER, String(unread));
  dot.setAttribute("aria-hidden", "true");
  dot.setAttribute("title", `${unread} unread operator ${unread === 1 ? "message" : "messages"}`);
  dot.setAttribute("style", DOT_STYLE);
  return { matched: true };
}
function glyphFingerprint(row) {
  const asset = row.querySelector("[data-plugin-icon-asset]");
  if (asset !== null) return `asset:${asset.getAttribute("data-plugin-icon-asset") ?? ""}`;
  const shapes = Array.from(row.querySelectorAll("svg, svg *")).map((node) => {
    const geometry = RENDERING_ATTRIBUTES.flatMap((name) => {
      const value = node.getAttribute(name);
      return value === null ? [] : [`${name}=${value}`];
    });
    return geometry.length === 0 ? "" : `${node.tagName}[${geometry.join(",")}]`;
  }).filter((shape) => shape !== "");
  return shapes.length === 0 ? null : shapes.join("|");
}
function inspectInboxNavGlyph(root) {
  const rows = navRows(root);
  if (rows === null) return null;
  const inbox = rowsTitled(rows, INBOX_NAV_ROW_TITLE);
  const lanes = rowsTitled(rows, LANES_NAV_ROW_TITLE);
  if (inbox.length !== 1 || lanes.length !== 1) return null;
  const inboxGlyph = glyphFingerprint(inbox[0]);
  const lanesGlyph = glyphFingerprint(lanes[0]);
  if (inboxGlyph === null || lanesGlyph === null) return null;
  if (inboxGlyph !== lanesGlyph) return { matched: true };
  return { matched: false, reason: `the ${INBOX_NAV_ROW_TITLE} and ${LANES_NAV_ROW_TITLE} rows draw the same glyph (${inboxGlyph}) though they declare different icons` };
}

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
function asText(value) {
  return typeof value === "string" && value.trim() ? value : null;
}
var MAX_VISIBLE_INBOX_MESSAGES = 256;
var INBOX_FILTER_STORAGE_KEY = "bb-collab.inbox-filters";
var UNREGISTERED_INBOX_PROJECT = "PROJECT_CONFIG_REQUIRED";
function isUnregisteredInboxProject(result) {
  return result.outcome === UNREGISTERED_INBOX_PROJECT;
}
function readInboxFilters() {
  try {
    const value = JSON.parse(window.localStorage.getItem(INBOX_FILTER_STORAGE_KEY) ?? "null");
    return { projectId: typeof value?.projectId === "string" ? value.projectId : "", showArchived: value?.showArchived === true };
  } catch {
    return { projectId: "", showArchived: false };
  }
}
function writeInboxFilters(filters) {
  try {
    window.localStorage.setItem(INBOX_FILTER_STORAGE_KEY, JSON.stringify(filters));
  } catch {
  }
}
function InboxPanel(_props) {
  const sidebar = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const rpc = useRpc();
  const [filters, setFilters] = useState(readInboxFilters);
  const projectId = filters.projectId && sidebar.projects.some((project) => project.id === filters.projectId) ? filters.projectId : "";
  const { showArchived } = filters;
  const [messages, setMessages] = useState([]);
  const [expandedMessageKey, setExpandedMessageKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState({});
  const [replyingMessageKey, setReplyingMessageKey] = useState(null);
  const [errors, setErrors] = useState([]);
  const [notice, setNotice] = useState(null);
  const [indicatorBroken, setIndicatorBroken] = useState(null);
  const provenUnread = useRef(/* @__PURE__ */ new Map());
  const reportedBreak = useRef(null);
  const refreshSequence = useRef(0);
  const projects = useMemo(() => projectId ? sidebar.projects.filter((candidate) => candidate.id === projectId) : sidebar.projects, [projectId, sidebar.projects]);
  const projectNames = useMemo(() => new Map(sidebar.projects.map((candidate) => [candidate.id, candidate.name])), [sidebar.projects]);
  const messageKey = (message) => `${message.projectId}:${message.messageId}`;
  const visibleMessages = messages.slice(0, MAX_VISIBLE_INBOX_MESSAGES);
  const openKey = expandedMessageKey === null ? visibleMessages[0] ? messageKey(visibleMessages[0]) : null : visibleMessages.some((message) => messageKey(message) === expandedMessageKey) ? expandedMessageKey : null;
  useEffect(() => {
    if (!document.querySelector(INBOX_NAV_REGION_SELECTOR)) return;
    let cancelled = false;
    const paint = async () => {
      const results = await Promise.allSettled(sidebar.projects.map((project) => rpc.call("operatorMessages", { projectId: project.id, recipient: "operator" })));
      if (cancelled) return;
      const unread = results.reduce((total, result, index) => {
        const projectId2 = sidebar.projects[index].id;
        if (result.status === "fulfilled") {
          const count = result.value.messages.filter((message) => message.readAtMs === null).length;
          provenUnread.current.set(projectId2, count);
          return total + count;
        }
        return total + (provenUnread.current.get(projectId2) ?? 0);
      }, 0);
      const painted = paintInboxNavUnread(document, unread);
      const broken = painted.matched === false ? painted : inspectInboxNavGlyph(document);
      if (broken === null || broken.matched) {
        reportedBreak.current = null;
        setIndicatorBroken(null);
        return;
      }
      if (reportedBreak.current !== broken.reason) {
        console.error(`[operator-inbox] ${INBOX_INDICATOR_BROKEN_TITLE}: ${broken.reason}`);
        reportedBreak.current = broken.reason;
      }
      setIndicatorBroken(broken.reason);
    };
    void paint();
    const timer = window.setInterval(() => void paint(), 3e4);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      paintInboxNavUnread(document, 0);
    };
  }, [rpc, sidebar.projects]);
  const setFiltersAndPersist = (next) => {
    setFilters(next);
    writeInboxFilters(next);
  };
  const refresh = useCallback(() => {
    const sequence = ++refreshSequence.current;
    setNotice(null);
    setLoading(true);
    if (projects.length === 0) {
      setMessages([]);
      setErrors([]);
      setLoading(false);
      return;
    }
    void Promise.allSettled(projects.map((project) => rpc.call("operatorMessages", { projectId: project.id, recipient: "operator", withSenderTitles: true, ...showArchived ? { includeArchived: true } : {} }))).then((results) => {
      if (sequence !== refreshSequence.current) return;
      const loaded = [];
      const failed = [];
      results.forEach((result, index) => {
        const label = `${projects[index].name} (${projects[index].id})`;
        if (result.status === "rejected") failed.push(`${label}: ${String(result.reason)}`);
        else if (!isUnregisteredInboxProject(result.value)) loaded.push(...result.value.messages);
        else if (projectId !== "") failed.push(`${label}: ${result.value.outcome}`);
      });
      loaded.sort((left, right) => Number(left.readAtMs !== null) - Number(right.readAtMs !== null) || right.createdAtMs - left.createdAtMs || right.messageId - left.messageId);
      setMessages(loaded);
      setErrors(failed);
    }).finally(() => {
      if (sequence === refreshSequence.current) setLoading(false);
    });
  }, [projects, projectId, rpc, showArchived]);
  useEffect(refresh, [refresh]);
  const updateMessage = (next) => setMessages((current) => current.map((message) => messageKey(message) === messageKey(next) ? next : message));
  return /* @__PURE__ */ jsx("main", { className: "h-full overflow-y-auto p-4 md:p-5", children: /* @__PURE__ */ jsxs("div", { className: "mx-auto grid max-w-4xl gap-3", style: { minWidth: 0, width: "100%" }, children: [
    indicatorBroken ? /* @__PURE__ */ jsxs("p", { role: "alert", className: "text-sm text-destructive", children: [
      INBOX_INDICATOR_BROKEN_TITLE,
      " \u2014 open Inbox to check for unread messages. Cause: ",
      indicatorBroken
    ] }) : null,
    /* @__PURE__ */ jsxs("section", { "aria-label": "Inbox filters", className: "items-end gap-3 border-b border-border pb-3", style: { display: "flex", flexWrap: "wrap", minWidth: 0, width: "100%" }, children: [
      /* @__PURE__ */ jsxs("label", { className: "grid min-w-0 gap-1 text-sm", style: { flex: "1 0 20rem" }, children: [
        /* @__PURE__ */ jsx("span", { className: "text-xs text-muted-foreground", children: "Project" }),
        /* @__PURE__ */ jsxs("select", { className: "w-full min-w-0 rounded-md border border-border bg-background px-3 py-1.5", value: projectId, onChange: (event) => setFiltersAndPersist({ projectId: event.target.value, showArchived }), children: [
          /* @__PURE__ */ jsx("option", { value: "", children: "All projects" }),
          sidebar.projects.map((candidate) => /* @__PURE__ */ jsxs("option", { value: candidate.id, children: [
            candidate.name,
            " \xB7 ",
            candidate.id
          ] }, candidate.id))
        ] })
      ] }),
      /* @__PURE__ */ jsxs("label", { className: "items-center gap-2 py-1.5 text-sm", style: { display: "flex", flex: "0 0 8rem", whiteSpace: "nowrap" }, children: [
        /* @__PURE__ */ jsx("input", { type: "checkbox", checked: showArchived, onChange: (event) => setFiltersAndPersist({ projectId, showArchived: event.target.checked }) }),
        "Show archived"
      ] }),
      /* @__PURE__ */ jsx("button", { type: "button", "aria-label": "Refresh inbox", title: "Refresh inbox", style: { flex: "0 0 2rem" }, className: "rounded-md bg-transparent px-2 py-1.5 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none", onClick: refresh, children: /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\u21BB" }) })
    ] }),
    errors.map((loadError) => /* @__PURE__ */ jsxs("p", { role: "alert", className: "text-sm text-destructive", children: [
      "Unable to read inbox: ",
      loadError
    ] }, loadError)),
    notice ? /* @__PURE__ */ jsx("p", { role: "status", className: "text-sm text-primary", children: notice }) : null,
    sidebar.projects.length === 0 ? /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground", children: "No registered projects." }) : /* @__PURE__ */ jsxs("section", { "aria-labelledby": "inbox-project-heading", className: "overflow-hidden rounded-md border border-border", style: { minWidth: 0, width: "100%" }, children: [
      /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between gap-2 border-b border-border px-3 py-2", children: [
        /* @__PURE__ */ jsx("h2", { id: "inbox-project-heading", className: "text-sm font-semibold", children: projectId ? projectNames.get(projectId) ?? projectId : "All projects" }),
        /* @__PURE__ */ jsxs("span", { className: "text-xs text-muted-foreground", children: [
          messages.length,
          " ",
          messages.length === 1 ? "message" : "messages"
        ] })
      ] }),
      loading ? /* @__PURE__ */ jsx("p", { role: "status", className: "p-4 text-sm text-muted-foreground", children: "Loading messages\u2026" }) : null,
      !loading && messages.length === 0 ? /* @__PURE__ */ jsx("p", { className: "p-4 text-sm text-muted-foreground", children: "No operator messages for this project filter." }) : null,
      messages.length > MAX_VISIBLE_INBOX_MESSAGES ? /* @__PURE__ */ jsxs("p", { className: "border-b border-border p-3 text-xs text-muted-foreground", children: [
        "Showing the first ",
        MAX_VISIBLE_INBOX_MESSAGES,
        " of ",
        messages.length,
        " messages; unread messages are first. Select a project to narrow the list."
      ] }) : null,
      /* @__PURE__ */ jsx("div", { role: "list", "aria-label": "Operator messages", children: visibleMessages.map((message) => {
        const key = messageKey(message);
        const expanded = key === openKey;
        return /* @__PURE__ */ jsxs("article", { role: "listitem", className: "border-b border-border last:border-b-0", children: [
          /* @__PURE__ */ jsxs("button", { type: "button", "aria-expanded": expanded, style: { textAlign: "left", width: "100%" }, onClick: () => setExpandedMessageKey(expanded ? "" : key), className: `grid min-w-0 gap-1 px-3 py-2.5 transition-colors duration-150 hover:bg-muted/60 active:bg-muted/80 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none ${expanded ? "bg-muted/40" : "bg-transparent"}`, children: [
            /* @__PURE__ */ jsxs("span", { className: "flex min-w-0 items-center gap-2", children: [
              message.readAtMs === null ? /* @__PURE__ */ jsx("span", { "aria-label": "Unread", className: "h-2 w-2 shrink-0 rounded-full bg-primary" }) : null,
              /* @__PURE__ */ jsx("span", { className: `min-w-0 truncate text-sm ${message.readAtMs === null ? "font-semibold" : "font-medium"}`, children: asText(message.senderTitle) ?? asText(message.senderThreadId) ?? "Sender unavailable" }),
              /* @__PURE__ */ jsx("span", { "aria-hidden": "true", className: `text-xs text-muted-foreground transition-transform duration-150 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`, children: "\u203A" }),
              /* @__PURE__ */ jsx("time", { className: "ml-auto shrink-0 text-xs text-muted-foreground", dateTime: new Date(message.createdAtMs).toISOString(), children: new Date(message.createdAtMs).toLocaleDateString() })
            ] }),
            /* @__PURE__ */ jsxs("span", { className: "truncate text-xs text-muted-foreground", children: [
              message.text.slice(0, 90),
              "\u2026"
            ] }),
            /* @__PURE__ */ jsxs("span", { className: "flex flex-wrap items-center gap-2 text-xs text-muted-foreground", children: [
              /* @__PURE__ */ jsx("span", { children: projectNames.get(message.projectId) ?? message.projectId }),
              /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\xB7" }),
              /* @__PURE__ */ jsx("span", { children: message.severity }),
              message.repliedAtMs !== null ? /* @__PURE__ */ jsxs(Fragment2, { children: [
                /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\xB7" }),
                /* @__PURE__ */ jsx("span", { children: "Delivered" })
              ] }) : message.replyInProgress ? /* @__PURE__ */ jsxs(Fragment2, { children: [
                /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\xB7" }),
                /* @__PURE__ */ jsx("span", { children: "Delivery pending" })
              ] }) : message.replyDeliveryError ? /* @__PURE__ */ jsxs(Fragment2, { children: [
                /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\xB7" }),
                /* @__PURE__ */ jsx("span", { className: "text-destructive", children: "Delivery failed" })
              ] }) : null
            ] })
          ] }),
          expanded ? /* @__PURE__ */ jsxs("div", { className: "grid gap-3 border-t border-border bg-muted/10 p-3 md:p-4", style: { minWidth: 0 }, children: [
            /* @__PURE__ */ jsxs("p", { className: "text-xs text-muted-foreground", children: [
              message.readAtMs === null ? "Unread" : "Read",
              " \xB7 ",
              message.severity,
              " \xB7 ",
              /* @__PURE__ */ jsx("time", { dateTime: new Date(message.createdAtMs).toISOString(), children: new Date(message.createdAtMs).toLocaleString() })
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
              asText(message.senderThreadId) ? /* @__PURE__ */ jsx("a", { href: "#", className: "font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2", "aria-label": `Open sender session ${asText(message.senderThreadId)}`, title: `Open sender session ${asText(message.senderThreadId)}`, onClick: (event) => {
                event.preventDefault();
                navigate.toThread(asText(message.senderThreadId));
              }, children: asText(message.senderTitle) ?? asText(message.senderThreadId) }) : /* @__PURE__ */ jsx("span", { className: "font-medium", children: "Sender unavailable" }),
              /* @__PURE__ */ jsxs("p", { className: "break-words text-xs text-muted-foreground", children: [
                asText(message.senderLaneId) ? `${asText(message.senderLaneId)} \xB7 ` : "",
                asText(message.senderThreadId)
              ] })
            ] }),
            /* @__PURE__ */ jsx("p", { className: "whitespace-pre-wrap break-words text-sm leading-6", children: message.text }),
            message.notificationError ? /* @__PURE__ */ jsxs("p", { className: "text-xs text-destructive", children: [
              "Urgent notification failed: ",
              message.notificationError
            ] }) : null,
            message.repliedAtMs !== null ? /* @__PURE__ */ jsxs("div", { className: "border-l-2 border-border pl-3", children: [
              /* @__PURE__ */ jsx("p", { className: "text-xs font-medium text-muted-foreground", children: "Reply delivered" }),
              /* @__PURE__ */ jsx("p", { className: "mt-1 whitespace-pre-wrap break-words text-sm", children: message.replyText })
            ] }) : /* @__PURE__ */ jsxs("div", { className: "grid gap-2 border-t border-border pt-3", children: [
              message.replyInProgress ? /* @__PURE__ */ jsx("p", { className: "text-xs text-primary", children: "Reply delivery is still in progress; outcome is not yet known." }) : null,
              message.replyDeliveryError ? /* @__PURE__ */ jsxs("p", { role: "alert", className: "text-xs text-destructive", children: [
                "Reply delivery failed: ",
                message.replyDeliveryError
              ] }) : null,
              /* @__PURE__ */ jsx("label", { className: "text-xs font-medium text-muted-foreground", htmlFor: `operator-reply-${key}`, children: "Reply" }),
              /* @__PURE__ */ jsx("textarea", { id: `operator-reply-${key}`, className: "min-h-24 w-full rounded-md border border-border bg-background p-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary", value: drafts[key] ?? message.replyText ?? "", onChange: (event) => setDrafts((current) => ({ ...current, [key]: event.target.value })) }),
              /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-2", children: [
                /* @__PURE__ */ jsx("button", { type: "button", disabled: replyingMessageKey !== null, className: "rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-opacity duration-150 hover:opacity-90 active:opacity-80 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none", onClick: () => {
                  const text = (drafts[key] ?? message.replyText ?? "").trim();
                  if (!text) return;
                  setErrors([]);
                  setNotice(null);
                  setReplyingMessageKey(key);
                  void rpc.call("replyToOperatorMessage", { projectId: message.projectId, messageId: message.messageId, text }).then((replied) => {
                    updateMessage(replied);
                    setNotice(replied.repliedAtMs !== null ? "Reply delivered." : replied.replyInProgress ? "Reply delivery is still in progress; outcome is not yet known." : replied.replyDeliveryError ? "Reply delivery failed." : "Reply delivery is not confirmed.");
                  }).catch((reason) => setErrors([String(reason)])).finally(() => setReplyingMessageKey(null));
                }, children: replyingMessageKey === key ? "Delivering\u2026" : message.replyDeliveryError ? "Retry reply" : "Reply" }),
                message.readAtMs === null ? /* @__PURE__ */ jsx("button", { type: "button", className: "rounded-md bg-transparent px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none", onClick: () => {
                  setErrors([]);
                  setNotice(null);
                  void rpc.call("markOperatorMessageRead", { projectId: message.projectId, messageId: message.messageId }).then((read) => {
                    updateMessage(read);
                    setNotice("Marked read.");
                  }).catch((reason) => setErrors([String(reason)]));
                }, children: "Mark read" }) : null,
                message.archivedAtMs === null ? /* @__PURE__ */ jsx("button", { type: "button", className: "rounded-md bg-transparent px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none", onClick: () => {
                  setErrors([]);
                  setNotice(null);
                  void rpc.call("archiveOperatorMessage", { projectId: message.projectId, messageId: message.messageId }).then((archived) => {
                    setMessages((current) => showArchived ? current.map((item) => messageKey(item) === key ? archived : item) : current.filter((item) => messageKey(item) !== key));
                    setNotice("Archived.");
                  }).catch((reason) => setErrors([String(reason)]));
                }, children: "Archive" }) : null
              ] })
            ] })
          ] }) : null
        ] }, key);
      }) })
    ] })
  ] }) });
}
var app_default = definePluginApp((app) => {
  app.slots.navPanel({ id: "inbox", title: "Inbox", icon: "Mail", path: "inbox", component: InboxPanel });
});
export {
  app_default as default
};
