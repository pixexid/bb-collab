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

// src/provider-marks.ts
var MARKS = {
  "codex": {
    title: "OpenAI",
    viewBox: "0 0 24 24",
    fillRule: "evenodd",
    paths: [
      "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
    ]
  },
  "claude-code": {
    title: "Claude",
    viewBox: "0 0 149 149",
    paths: [
      "M29.05 98.54L58.19 82.19L58.68 80.77L58.19 79.98H56.77L51.9 79.68L35.25 79.23L20.81 78.63L6.82 77.88L3.3 77.13L0 72.78L0.340004 70.61L3.3 68.62L7.54 68.99L16.91 69.63L30.97 70.6L41.17 71.2L56.28 72.77H58.68L59.02 71.8L58.2 71.2L57.56 70.6L43.01 60.74L27.26 50.32L19.01 44.32L14.55 41.28L12.3 38.43L11.33 32.21L15.38 27.75L20.82 28.12L22.21 28.49L27.72 32.73L39.49 41.84L54.86 53.16L57.11 55.03L58.01 54.39L58.12 53.94L57.11 52.25L48.75 37.14L39.83 21.77L35.86 15.4L34.81 11.58C34.44 10.01 34.17 8.69 34.17 7.08L38.78 0.820007L41.33 0L47.48 0.820007L50.07 3.07001L53.89 11.81L60.08 25.57L69.68 44.28L72.49 49.83L73.99 54.97L74.55 56.54H75.52V55.64L76.31 45.1L77.77 32.16L79.19 15.51L79.68 10.82L82 5.2L86.61 2.16L90.21 3.88L93.17 8.12L92.76 10.86L91 22.3L87.55 40.22L85.3 52.22H86.61L88.11 50.72L94.18 42.66L104.38 29.91L108.88 24.85L114.13 19.26L117.5 16.6H123.87L128.56 23.57L126.46 30.77L119.9 39.09L114.46 46.14L106.66 56.64L101.79 65.04L102.24 65.71L103.4 65.6L121.02 61.85L130.54 60.13L141.9 58.18L147.04 60.58L147.6 63.02L145.58 68.01L133.43 71.01L119.18 73.86L97.96 78.88L97.7 79.07L98 79.44L107.56 80.34L111.65 80.56H121.66L140.3 81.95L145.17 85.17L148.09 89.11L147.6 92.11L140.1 95.93L129.98 93.53L106.36 87.91L98.26 85.89H97.14V86.56L103.89 93.16L116.26 104.33L131.75 118.73L132.54 122.29L130.55 125.1L128.45 124.8L114.84 114.56L109.59 109.95L97.7 99.94H96.91V100.99L99.65 105L114.12 126.75L114.87 133.42L113.82 135.59L110.07 136.9L105.95 136.15L97.48 124.26L88.74 110.87L81.69 98.87L80.83 99.36L76.67 144.17L74.72 146.46L70.22 148.18L66.47 145.33L64.48 140.72L66.47 131.61L68.87 119.72L70.82 110.27L72.58 98.53L73.63 94.63L73.56 94.37L72.7 94.48L63.85 106.63L50.39 124.82L39.74 136.22L37.19 137.23L32.77 134.94L33.18 130.85L35.65 127.21L50.39 108.46L59.28 96.84L65.02 90.13L64.98 89.16H64.64L25.49 114.58L18.52 115.48L15.52 112.67L15.89 108.06L17.31 106.56L29.08 98.46L29.04 98.5L29.05 98.54Z"
    ]
  },
  "pi": {
    title: "Pi",
    viewBox: "100 100 600 600",
    fillRule: "evenodd",
    paths: [
      "\n        M165.29 165.29\n        H517.36\n        V400\n        H400\n        V517.36\n        H282.65\n        V634.72\n        H165.29\n        Z\n        M282.65 282.65\n        V400\n        H400\n        V282.65\n        Z\n      ",
      "M517.36 400 H634.72 V634.72 H517.36 Z"
    ]
  }
};
var ALIASES = {
  openai: "codex",
  anthropic: "claude-code",
  claudecode: "claude-code",
  kimi: "pi"
};
function providerMarkKey(providerId) {
  return typeof providerId === "string" ? providerId.toLocaleLowerCase().replace(/[^a-z0-9]/gu, "") : "";
}
function providerMark(providerId) {
  const raw = typeof providerId === "string" ? providerId.toLocaleLowerCase() : "";
  if (MARKS[raw]) return MARKS[raw];
  const alias = ALIASES[raw] ?? ALIASES[providerMarkKey(providerId)];
  return alias ? MARKS[alias] ?? null : null;
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
var SETTINGS_ACTION_TITLE = "bb-collab settings";
function age(ms) {
  const minutes = Math.floor(ms / 6e4);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}
var MAX_VISIBLE_THREADS = 5;
var MAX_VISIBLE_INBOX_MESSAGES = 256;
var SIDEBAR_RPC_BATCH_SIZE = 256;
var INBOX_FILTER_STORAGE_KEY = "bb-collab.inbox-filters";
var UNREGISTERED_INBOX_PROJECT = "operator inbox project is not registered";
function isUnregisteredInboxProject(reason) {
  return reason instanceof Error && reason.message === UNREGISTERED_INBOX_PROJECT;
}
var INBOX_UNREAD_POLL_MS = 3e4;
function readInboxFilters() {
  try {
    const value = JSON.parse(window.localStorage.getItem(INBOX_FILTER_STORAGE_KEY) ?? "null");
    return {
      projectId: typeof value?.projectId === "string" ? value.projectId : "",
      recipient: value?.recipient === "operator" || value?.recipient === "supervisor" ? value.recipient : ""
    };
  } catch {
    return { projectId: "", recipient: "" };
  }
}
function writeInboxFilters(filters) {
  try {
    window.localStorage.setItem(INBOX_FILTER_STORAGE_KEY, JSON.stringify(filters));
  } catch {
  }
}
function sidebarRpcBatches(ids) {
  const batches = [];
  for (let index = 0; index < ids.length; index += SIDEBAR_RPC_BATCH_SIZE) batches.push(ids.slice(index, index + SIDEBAR_RPC_BATCH_SIZE));
  return batches;
}
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
var LEADING_SLOT = "inline-flex size-3.5 shrink-0 items-center justify-center";
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
function ThreadRunningSpinner({ thread }) {
  const signal = threadSignal(thread);
  if (signal.kind !== "running") return null;
  return /* @__PURE__ */ jsx("span", { className: LEADING_SLOT, "data-sidebar-thread-signal": "running", children: /* @__PURE__ */ jsx(RunningSpinner, { label: signal.label }) });
}
function ThreadStateDot({ thread }) {
  const signal = threadSignal(thread);
  if (signal.kind === "idle" || signal.kind === "running") return null;
  return /* @__PURE__ */ jsx("span", { className: TRAILING_SLOT, "data-sidebar-thread-signal": signal.kind, children: /* @__PURE__ */ jsx(
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
function ProviderMark({ providerId }) {
  const mark = providerMark(providerId);
  if (!mark) return null;
  return /* @__PURE__ */ jsx(
    "svg",
    {
      viewBox: mark.viewBox,
      className: "size-3 shrink-0",
      fill: "currentColor",
      fillRule: mark.fillRule,
      "aria-hidden": "true",
      focusable: "false",
      "data-provider-mark": providerMarkKey(providerId),
      children: mark.paths.map((path) => /* @__PURE__ */ jsx("path", { d: path }, path))
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
          /* @__PURE__ */ jsx(ThreadRunningSpinner, { thread }),
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
        /* @__PURE__ */ jsx(ThreadStateDot, { thread }),
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
  const provenUnread = useRef(/* @__PURE__ */ new Map());
  const reportedBreak = useRef(null);
  const dragTargetId = useRef(null);
  const [customStates, setCustomStates] = useState({});
  const [indicatorBroken, setIndicatorBroken] = useState(null);
  const [threadModels, setThreadModels] = useState({});
  const threadIds = useMemo(() => sidebar.threads.map((thread) => thread.id), [sidebar.threads]);
  const threadIdsKey = threadIds.join("\0");
  const projectIds = useMemo(() => sidebar.projects.map((project) => project.id), [sidebar.projects]);
  const projectIdsKey = projectIds.join("\0");
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
      threadIds: threadBatches[index] ?? []
    }))).then((states) => {
      const state = {
        projects: Object.assign({}, ...states.map((result) => result.projects)),
        threads: Object.assign({}, ...states.map((result) => result.threads))
      };
      if (!mounted) return;
      setCollapsedProjects(collapseMap(state.projects));
      setCollapsedThreads(collapseMap(state.threads));
    }).catch(() => void 0);
    return () => {
      mounted = false;
    };
  }, [projectIdsKey, rpc, threadIdsKey]);
  useEffect(() => {
    let cancelled = false;
    const paint = async () => {
      const results = await Promise.allSettled(projectIds.map((projectId) => rpc.call("operatorMessages", { projectId })));
      if (cancelled) return;
      const unread = results.reduce((total, result, index) => {
        const projectId = projectIds[index];
        if (result.status === "fulfilled") {
          const count = result.value.filter((message) => message.readAtMs === null).length;
          provenUnread.current.set(projectId, count);
          return total + count;
        }
        if (isUnregisteredInboxProject(result.reason)) {
          provenUnread.current.set(projectId, 0);
          return total;
        }
        return total + (provenUnread.current.get(projectId) ?? 0);
      }, 0);
      const painted = paintInboxNavUnread(document, unread);
      const broken = painted.matched === false ? painted : inspectInboxNavGlyph(document);
      if (broken === null || broken.matched) {
        reportedBreak.current = null;
        setIndicatorBroken(null);
        return;
      }
      if (reportedBreak.current !== broken.reason) {
        console.error(`[bb-collab] ${INBOX_INDICATOR_BROKEN_TITLE}: ${broken.reason}`);
        reportedBreak.current = broken.reason;
      }
      setIndicatorBroken(broken.reason);
    };
    void paint();
    const timer = window.setInterval(() => {
      void paint();
    }, INBOX_UNREAD_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      paintInboxNavUnread(document, 0);
    };
  }, [projectIdsKey, rpc]);
  const indicatorAlert = indicatorBroken === null ? null : /* @__PURE__ */ jsxs("p", { role: "alert", className: "p-3 text-sm text-destructive", children: [
    INBOX_INDICATOR_BROKEN_TITLE,
    " \u2014 open Inbox to check for unread messages. Cause: ",
    indicatorBroken
  ] });
  const groups = groupThreads(sidebar.projects, sidebar.threads, searchQuery);
  if (sidebar.status === "loading") return /* @__PURE__ */ jsxs(Fragment2, { children: [
    indicatorAlert,
    /* @__PURE__ */ jsx("p", { className: "p-3 text-sm text-muted-foreground", children: "Loading threads\u2026" })
  ] });
  if (sidebar.status === "error") return /* @__PURE__ */ jsxs(Fragment2, { children: [
    indicatorAlert,
    /* @__PURE__ */ jsx("p", { className: "p-3 text-sm text-destructive", children: "Unable to load threads." })
  ] });
  if (groups.length === 0) return /* @__PURE__ */ jsxs(Fragment2, { children: [
    indicatorAlert,
    /* @__PURE__ */ jsx("p", { className: "p-3 text-sm text-muted-foreground", children: "No matching threads." })
  ] });
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
  return /* @__PURE__ */ jsxs("div", { className: "h-full space-y-3 overflow-y-auto p-1", children: [
    indicatorAlert,
    groups.map(({ project, threads }) => {
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
    })
  ] });
}
function laneQueueLabel(lane) {
  if (lane.queueState !== "deferred" && !lane.deferredReason) {
    return lane.nextStartable ? "next startable" : lane.waitingOn ?? "worker";
  }
  const reason = lane.deferredReason?.replace(/_/gu, " ") ?? "reason unavailable";
  const since = typeof lane.deferredAgeMs === "number" ? ` \xB7 ${age(lane.deferredAgeMs)}` : "";
  return `Deferred \xB7 ${reason}${since}`;
}
function LanesPanel(_props) {
  const rpc = useRpc();
  const [lanes, setLanes] = useState([]);
  const [error, setError] = useState(null);
  const refresh = useCallback(() => {
    void rpc.call("lanes", {}).then((next) => setLanes(next)).catch((reason) => setError(String(reason)));
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
        /* @__PURE__ */ jsx("div", { className: "truncate text-xs text-muted-foreground", children: lane.threadId ?? "worker not attached" })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "text-muted-foreground", children: laneQueueLabel(lane) }),
      /* @__PURE__ */ jsx("time", { className: "text-muted-foreground", title: `${lane.ageMs}ms old`, children: age(lane.ageMs) })
    ] }, lane.executionAttemptId)) })
  ] }) });
}
function InboxPanel(_props) {
  const sidebar = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const rpc = useRpc();
  const [filters, setFilters] = useState(readInboxFilters);
  const projectId = filters.projectId && sidebar.projects.some((project) => project.id === filters.projectId) ? filters.projectId : "";
  const { recipient } = filters;
  const [messages, setMessages] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [replyingMessageKey, setReplyingMessageKey] = useState(null);
  const [errors, setErrors] = useState([]);
  const [notice, setNotice] = useState(null);
  const refreshSequence = useRef(0);
  const projects = useMemo(() => projectId ? sidebar.projects.filter((candidate) => candidate.id === projectId) : sidebar.projects, [projectId, sidebar.projects]);
  const projectNames = useMemo(() => new Map(sidebar.projects.map((candidate) => [candidate.id, candidate.name])), [sidebar.projects]);
  const messageKey = (message) => `${message.projectId}:${message.messageId}`;
  const visibleMessages = messages.slice(0, MAX_VISIBLE_INBOX_MESSAGES);
  const setFiltersAndPersist = (next) => {
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
    void Promise.allSettled(projects.map((project) => rpc.call("operatorMessages", { projectId: project.id, ...recipient ? { recipient } : {} }))).then((results) => {
      if (sequence !== refreshSequence.current) return;
      const loaded = [];
      const failed = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") loaded.push(...result.value);
        else if (projectId !== "" || !isUnregisteredInboxProject(result.reason)) failed.push(`${projects[index].name} (${projects[index].id}): ${String(result.reason)}`);
      });
      loaded.sort((left, right) => Number(left.readAtMs !== null) - Number(right.readAtMs !== null) || right.createdAtMs - left.createdAtMs || right.messageId - left.messageId);
      setMessages(loaded);
      setErrors(failed);
    });
  }, [projects, projectId, recipient, rpc]);
  useEffect(refresh, [refresh]);
  const updateMessage = (next) => setMessages((current) => current.map((message) => messageKey(message) === messageKey(next) ? next : message));
  return /* @__PURE__ */ jsx("main", { className: "h-full overflow-y-auto p-5", children: /* @__PURE__ */ jsxs("div", { className: "mx-auto max-w-4xl", children: [
    /* @__PURE__ */ jsxs("div", { className: "mb-5 flex flex-wrap items-end gap-3", children: [
      /* @__PURE__ */ jsxs("label", { className: "grid gap-1 text-sm", children: [
        /* @__PURE__ */ jsx("span", { className: "text-muted-foreground", children: "Project" }),
        /* @__PURE__ */ jsxs("select", { className: "rounded-md border border-border bg-background px-3 py-2", value: projectId, onChange: (event) => setFiltersAndPersist({ projectId: event.target.value, recipient }), children: [
          /* @__PURE__ */ jsx("option", { value: "", children: "All projects" }),
          sidebar.projects.map((candidate) => /* @__PURE__ */ jsxs("option", { value: candidate.id, children: [
            candidate.name,
            " \xB7 ",
            candidate.id
          ] }, candidate.id))
        ] })
      ] }),
      /* @__PURE__ */ jsxs("label", { className: "grid gap-1 text-sm", children: [
        /* @__PURE__ */ jsx("span", { className: "text-muted-foreground", children: "Recipient" }),
        /* @__PURE__ */ jsxs("select", { className: "rounded-md border border-border bg-background px-3 py-2", value: recipient, onChange: (event) => setFiltersAndPersist({ projectId, recipient: event.target.value }), children: [
          /* @__PURE__ */ jsx("option", { value: "", children: "All recipients" }),
          /* @__PURE__ */ jsx("option", { value: "operator", children: "Operator" }),
          /* @__PURE__ */ jsx("option", { value: "supervisor", children: "Supervisor" })
        ] })
      ] }),
      /* @__PURE__ */ jsx("button", { type: "button", className: "rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground", onClick: refresh, children: "Refresh" })
    ] }),
    sidebar.projects.length === 0 ? /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground", children: "No registered projects." }) : null,
    errors.map((loadError) => /* @__PURE__ */ jsxs("p", { className: "text-sm text-destructive", children: [
      "Unable to read inbox: ",
      loadError
    ] }, loadError)),
    notice ? /* @__PURE__ */ jsx("p", { role: "status", className: "text-sm text-primary", children: notice }) : null,
    sidebar.projects.length > 0 ? /* @__PURE__ */ jsxs("section", { "aria-labelledby": "inbox-project-heading", children: [
      /* @__PURE__ */ jsx("h2", { id: "inbox-project-heading", className: "mb-2 text-sm font-semibold", children: projectId ? projectNames.get(projectId) ?? projectId : "All projects" }),
      messages.length === 0 ? /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground", children: "No messages for this project and recipient filter." }) : null,
      messages.length > MAX_VISIBLE_INBOX_MESSAGES ? /* @__PURE__ */ jsxs("p", { className: "mb-3 text-sm text-muted-foreground", children: [
        "Showing the first ",
        MAX_VISIBLE_INBOX_MESSAGES,
        " of ",
        messages.length,
        " messages; unread messages are first. Select a project to narrow the list."
      ] }) : null,
      /* @__PURE__ */ jsx("div", { className: "space-y-3", children: visibleMessages.map((message) => /* @__PURE__ */ jsxs("article", { className: `rounded-lg border p-4 ${message.readAtMs === null ? "border-primary/50" : "border-border"}`, children: [
        /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-2 text-xs text-muted-foreground", children: [
          /* @__PURE__ */ jsx("span", { className: "font-medium text-foreground", children: projectNames.get(message.projectId) ?? message.projectId }),
          /* @__PURE__ */ jsx("span", { className: "font-medium text-foreground", children: message.recipient }),
          /* @__PURE__ */ jsx("span", { children: message.severity }),
          /* @__PURE__ */ jsx("span", { className: "inline-grid", children: asText(message.senderThreadId) ? /* @__PURE__ */ jsxs(Fragment2, { children: [
            /* @__PURE__ */ jsx(
              "a",
              {
                href: "#",
                className: "font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground",
                "aria-label": `Open sender session ${asText(message.senderThreadId)}`,
                title: `Open sender session ${asText(message.senderThreadId)}`,
                onClick: (event) => {
                  event.preventDefault();
                  navigate.toThread(asText(message.senderThreadId));
                },
                children: asText(message.senderTitle) ?? asText(message.senderThreadId)
              }
            ),
            asText(message.senderTitle) ? /* @__PURE__ */ jsxs("span", { children: [
              asText(message.senderLaneId) ? `${asText(message.senderLaneId)} \xB7 ` : "",
              asText(message.senderThreadId)
            ] }) : asText(message.senderLaneId) ? /* @__PURE__ */ jsx("span", { children: asText(message.senderLaneId) }) : null
          ] }) : /* @__PURE__ */ jsx("span", { children: "Sender unavailable" }) }),
          /* @__PURE__ */ jsx("time", { className: "ml-auto", dateTime: new Date(message.createdAtMs).toISOString(), children: new Date(message.createdAtMs).toLocaleString() })
        ] }),
        /* @__PURE__ */ jsx("p", { className: "my-3 whitespace-pre-wrap text-sm", children: message.text }),
        message.notificationError ? /* @__PURE__ */ jsxs("p", { className: "mb-2 text-xs text-destructive", children: [
          "Urgent notification failed: ",
          message.notificationError
        ] }) : null,
        message.replyDeliveryError ? /* @__PURE__ */ jsxs("p", { className: "mb-2 text-xs text-destructive", children: [
          "Reply delivery failed: ",
          message.replyDeliveryError
        ] }) : null,
        message.repliedAtMs === null ? /* @__PURE__ */ jsxs("div", { className: "grid gap-2", children: [
          /* @__PURE__ */ jsx("label", { className: "text-xs text-muted-foreground", htmlFor: `operator-reply-${messageKey(message)}`, children: "Reply" }),
          /* @__PURE__ */ jsx(
            "textarea",
            {
              id: `operator-reply-${messageKey(message)}`,
              className: "min-h-20 rounded-md border border-border bg-background p-2 text-sm",
              value: drafts[messageKey(message)] ?? message.replyText ?? "",
              onChange: (event) => setDrafts((current) => ({ ...current, [messageKey(message)]: event.target.value }))
            }
          ),
          /* @__PURE__ */ jsxs("div", { className: "flex gap-2", children: [
            /* @__PURE__ */ jsx("button", { type: "button", disabled: replyingMessageKey !== null, className: "rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50", onClick: () => {
              const text = (drafts[messageKey(message)] ?? message.replyText ?? "").trim();
              if (!text) return;
              setErrors([]);
              setNotice(null);
              setReplyingMessageKey(messageKey(message));
              void rpc.call("replyToOperatorMessage", { projectId: message.projectId, messageId: message.messageId, text }).then((replied) => {
                updateMessage(replied);
                setNotice("Reply delivered.");
              }).catch((reason) => setErrors([String(reason)])).finally(() => setReplyingMessageKey(null));
            }, children: replyingMessageKey === messageKey(message) ? "Delivering\u2026" : "Reply" }),
            message.readAtMs === null ? /* @__PURE__ */ jsx("button", { type: "button", className: "rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted", onClick: () => {
              setErrors([]);
              setNotice(null);
              void rpc.call("markOperatorMessageRead", { projectId: message.projectId, messageId: message.messageId }).then((read) => {
                updateMessage(read);
                setNotice("Marked read.");
              }).catch((reason) => setErrors([String(reason)]));
            }, children: "Mark read" }) : null
          ] })
        ] }) : /* @__PURE__ */ jsxs("p", { className: "text-sm text-muted-foreground", children: [
          "Reply delivered: ",
          message.replyText
        ] })
      ] }, messageKey(message))) })
    ] }) : null
  ] }) });
}
async function readPluginHttp(path, signal) {
  const response = await fetch(`/api/v1/plugins/bb-collab/http/${path}`, { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}
function mountLanePulse({ signal, setStatus }) {
  let previous = /* @__PURE__ */ new Set();
  const refresh = async () => {
    try {
      const lanes = await readPluginHttp("lanes", signal);
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
  app.slots.sidebarFooterAction({
    id: "bb-collab-settings",
    title: SETTINGS_ACTION_TITLE,
    icon: "Settings",
    run: ({ openSettings }) => openSettings()
  });
  app.slots.navPanel({
    id: "lanes",
    title: "Lanes",
    icon: "GitBranch",
    path: "lanes",
    component: LanesPanel
  });
  app.slots.navPanel({
    id: "inbox",
    title: "Inbox",
    icon: "Mail",
    path: "inbox",
    component: InboxPanel
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
  laneQueueLabel,
  reasoningLetter,
  shortModelName,
  sidebarRpcBatches,
  signalDotClasses,
  threadSignal
};
