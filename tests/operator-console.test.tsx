// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, mountPluginContentScripts, renderSlot } from "@bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const request = {
  interactionId: "interaction-1",
  threadId: "worker-thread",
  projectId: "project-1",
  mutationClass: "decision_disposition",
  candidateHead: "a".repeat(40),
  idempotencyKey: "request-1",
  requestDigest: "d".repeat(64),
  callerThreadId: "worker-thread",
  requestedFromBackground: true,
  createdAt: 100,
  expiresAt: 3_600_100,
  ageMs: 0,
};

// Issue #61's `LaneView`, exactly as the `lanes` rpc emits it.
const deferredLane = {
  projectId: "project-1",
  laneId: "lane-deferred",
  assignmentId: "assignment-1",
  assignmentKind: "write",
  workItemId: "work-1",
  threadId: "worker-thread",
  executionAttemptId: "attempt-deferred",
  attemptState: "prepared",
  workerStatus: null,
  waitingOn: "awaiting_operator",
  ageMs: 7_200_000,
  tone: "default",
  queueState: "deferred",
  queueBlocked: false,
  nextStartable: false,
  deferredReason: "awaiting_operator",
  deferredAtMs: 1_000,
  deferredAgeMs: 300_000,
} as const satisfies Parameters<typeof import("../app").laneQueueLabel>[0];

describe("universal operator console", () => {
  afterEach(() => cleanup());

  it("renders exact pending binding and routes approval from the navPanel", async () => {
    installTestPluginRuntime();
    const app = await loadPluginApp(() => import("../app"));
    const panel = app.navPanels.find((candidate) => candidate.id === "lanes");
    expect(panel).toBeTruthy();
    const rendered = renderSlot(panel!, { subPath: "" }, {
      context: { threadId: "operator-thread" },
      rpc: {
        lanes: async () => [],
        operatorReceiptRequests: async () => [request],
        operatorPassphraseState: async () => ({ configured: true }),
        operatorReceiptDecision: async () => ({ outcome: "OK" }),
      } as never,
    });

    await waitFor(() => expect(rendered.getByRole("heading", { name: "Awaiting operator" })).toBeTruthy());
    expect(rendered.getByText(request.projectId)).toBeTruthy();
    expect(rendered.getByText(request.candidateHead)).toBeTruthy();
    expect(rendered.getByText(request.requestDigest)).toBeTruthy();
    expect(rendered.getByRole("button", { name: "Approve" })).toBeTruthy();
    const passphrase = rendered.getByPlaceholderText("Approval passphrase");
    fireEvent.change(passphrase, { target: { value: "typed-only" } });
    fireEvent.click(rendered.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(rendered.inspection.rpcCalls).toContainEqual({
      method: "operatorReceiptDecision",
      input: {
        ...request,
        decision: "approve",
        passphrase: "typed-only",
        approverThreadId: "operator-thread",
      },
    }));
    expect(rendered.inspection.rpcCalls.some((call) => JSON.stringify(call.input).includes("operatorPassphrase"))).toBe(false);
  });

  it("keeps the desktop pendingInteraction registration", async () => {
    installTestPluginRuntime();
    const app = await loadPluginApp(() => import("../app"));
    expect(app.pendingInteractions.map((registration) => registration.id)).toContain("operator-receipt");
  });

  it("onboards an unset passphrase and refuses to arm approval until it is set", async () => {
    installTestPluginRuntime();
    const app = await loadPluginApp(() => import("../app"));
    const panel = app.navPanels.find((candidate) => candidate.id === "lanes")!;
    const rendered = renderSlot(panel, { subPath: "" }, {
      context: { threadId: "operator-thread" },
      rpc: {
        lanes: async () => [],
        operatorReceiptRequests: async () => [request],
        operatorPassphraseState: async () => ({ configured: false }),
      } as never,
    });

    await waitFor(() => expect(rendered.getByText("Set your approval passphrase first")).toBeTruthy());
    // The copy has to name the surface that actually opens the field, because
    // the panel cannot navigate there itself.
    const notice = rendered.getByRole("status");
    expect(notice.textContent).toContain("bb-collab settings");
    expect(notice.textContent).toContain("sidebar footer");
    expect(notice.textContent).toContain("Operator approval passphrase");
    expect((rendered.getByPlaceholderText("Approval passphrase") as HTMLInputElement).disabled).toBe(true);
    expect((rendered.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect((rendered.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(true);
    // The console only ever asks whether it is set.
    expect(rendered.inspection.rpcCalls).toContainEqual({ method: "operatorPassphraseState", input: {} });
  });

  // #given the state read fails — either as a rejected call or as the server's
  // own `configured: null` — #then the console says so and stays fail-closed.
  for (const [label, operatorPassphraseState] of [
    ["the rpc rejects", async () => { throw new Error("unavailable"); }],
    ["the server reports unknown", async () => ({ configured: null })],
  ] as const) {
    it(`refuses approval and says it cannot check, not that it is unset, when ${label}`, async () => {
      installTestPluginRuntime();
      const app = await loadPluginApp(() => import("../app"));
      const panel = app.navPanels.find((candidate) => candidate.id === "lanes")!;
      const rendered = renderSlot(panel, { subPath: "" }, {
        context: { threadId: "operator-thread" },
        rpc: { lanes: async () => [], operatorReceiptRequests: async () => [request], operatorPassphraseState } as never,
      });

      await waitFor(() => expect(rendered.getByText("Can't check the approval passphrase")).toBeTruthy());
      // The onboarding accusation is the exact defect: this operator may well
      // have set it, so the copy must not send them to fix a setting.
      expect(rendered.queryByText("Set your approval passphrase first")).toBeNull();
      const notice = rendered.getByRole("status");
      expect(notice.textContent).toContain("the check itself failed");
      expect(notice.textContent).not.toContain("bb-collab settings");
      expect(rendered.getByRole("button", { name: "Try again" })).toBeTruthy();
      const input = rendered.getByPlaceholderText("Approval passphrase") as HTMLInputElement;
      expect(input.disabled).toBe(true);
      expect(input.getAttribute("aria-describedby")).toBe("awaiting-operator-passphrase-unknown");
      expect((rendered.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
      expect((rendered.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(true);
    });
  }

  it("holds approval closed until the passphrase state is actually known", async () => {
    installTestPluginRuntime();
    const app = await loadPluginApp(() => import("../app"));
    const panel = app.navPanels.find((candidate) => candidate.id === "lanes")!;
    let settle = (_: { configured: boolean }) => {};
    const rendered = renderSlot(panel, { subPath: "" }, {
      context: { threadId: "operator-thread" },
      rpc: {
        lanes: async () => [],
        operatorReceiptRequests: async () => [request],
        operatorPassphraseState: () => new Promise((resolve) => { settle = resolve; }),
      } as never,
    });

    // Loading is not unknown and not unset: no notice at all, but nothing armed.
    await waitFor(() => expect(rendered.getByRole("heading", { name: "Awaiting operator" })).toBeTruthy());
    expect(rendered.queryByRole("status")).toBeNull();
    expect((rendered.getByPlaceholderText("Approval passphrase") as HTMLInputElement).disabled).toBe(true);

    settle({ configured: true });
    await waitFor(() => expect((rendered.getByPlaceholderText("Approval passphrase") as HTMLInputElement).disabled).toBe(false));
  });

  it("registers the sanctioned settings affordance the onboarding copy names", async () => {
    installTestPluginRuntime();
    const app = await loadPluginApp(() => import("../app"));
    const action = app.sidebarFooterActions.find((candidate) => candidate.id === "bb-collab-settings");
    expect(action?.title).toBe("bb-collab settings");
    const openSettings = vi.fn();
    await action!.run({ openSettings });
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("pulses the awaiting-operator count on the sanctioned thread-row surface", async () => {
    const waits: Record<string, unknown> = { total: 1, threads: { "worker-thread": 1 } };
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      new Response(JSON.stringify(String(url).endsWith("/lanes") ? [] : waits), { status: 200 })));
    vi.useFakeTimers();
    try {
      installTestPluginRuntime();
      const app = await loadPluginApp(() => import("../app"));
      const mounted = await mountPluginContentScripts(app, { pluginId: "bb-collab" });
      await vi.advanceTimersByTimeAsync(0);
      expect(mounted.inspection.getThreadRowStatus("worker-thread")).toEqual({
        icon: "Bell",
        label: "1 approval awaiting operator",
        tone: "running",
      });

      // The count follows the existing 5s pulse — no extra fetch, no extra store.
      waits.total = 3;
      (waits.threads as Record<string, number>)["worker-thread"] = 2;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mounted.inspection.getThreadRowStatus("worker-thread")?.label)
        .toBe("2 approvals awaiting operator on this thread (3 in all lanes)");

      waits.total = 0;
      waits.threads = {};
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mounted.inspection.getThreadRowStatus("worker-thread")).toBeNull();
      await mounted.lifecycle.dispose();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("drops counts a stale server shape cannot prove", async () => {
    installTestPluginRuntime();
    const { operatorReceiptWaits } = await import("../app");
    expect(operatorReceiptWaits({ total: 2, threads: { a: 1, b: 1 } })).toEqual({ total: 2, byThread: [["a", 1], ["b", 1]] });
    expect(operatorReceiptWaits({ total: "2", threads: { a: 0, b: null, c: { count: 1 } } })).toEqual({ total: 0, byThread: [] });
    expect(operatorReceiptWaits(null)).toEqual({ total: 0, byThread: [] });
  });

  // #given issue #61's deferred lane fields on the `lanes` rpc the panel already
  // polls #then the row states the reason and the deferral's own age.
  it("labels a deferred lane with #61's reason and deferral age, not the lane's age", async () => {
    installTestPluginRuntime();
    const { laneQueueLabel } = await import("../app");
    expect(laneQueueLabel(deferredLane)).toBe("Deferred · awaiting operator · 5m");
    // The lane is 2h old and the deferral 5m: reading `ageMs` here would report
    // a wait that never happened.
    expect(laneQueueLabel(deferredLane)).not.toContain("2h");
    // A deferral with no age of its own says nothing rather than the lane's.
    expect(laneQueueLabel({ ...deferredLane, deferredAgeMs: null })).toBe("Deferred · awaiting operator");
    // #61 sets `queueState` and `deferredReason` together; a stale bundle that
    // sees only one still must not report the lane as merely waiting.
    expect(laneQueueLabel({ ...deferredLane, deferredReason: null })).toBe("Deferred · reason unavailable · 5m");
    expect(laneQueueLabel({ ...deferredLane, queueState: "ready" })).toBe("Deferred · awaiting operator · 5m");
  });

  it("leaves ready lanes labelled by #61's queue position, untouched by deferral copy", async () => {
    installTestPluginRuntime();
    const { laneQueueLabel } = await import("../app");
    const ready = { ...deferredLane, queueState: "ready" as const, deferredReason: null, deferredAtMs: null, deferredAgeMs: null };
    expect(laneQueueLabel({ ...ready, nextStartable: true })).toBe("next startable");
    expect(laneQueueLabel({ ...ready, waitingOn: "terminal receipt" })).toBe("terminal receipt");
    expect(laneQueueLabel({ ...ready, waitingOn: null })).toBe("worker");
  });

  // The deferral is informational: #61 keeps `queueBlocked` false for it, so the
  // console must not hide the lane, reorder it, or gate approval on it either.
  it("shows a deferred lane alongside the others without blocking display or approval", async () => {
    installTestPluginRuntime();
    const app = await loadPluginApp(() => import("../app"));
    const panel = app.navPanels.find((candidate) => candidate.id === "lanes")!;
    const ready = {
      ...deferredLane,
      laneId: "lane-ready",
      executionAttemptId: "attempt-ready",
      queueState: "ready" as const,
      queueBlocked: false,
      nextStartable: true,
      waitingOn: null,
      deferredReason: null,
      deferredAtMs: null,
      deferredAgeMs: null,
    };
    const rendered = renderSlot(panel, { subPath: "" }, {
      context: { threadId: "operator-thread" },
      rpc: {
        lanes: async () => [deferredLane, ready],
        operatorReceiptRequests: async () => [request],
        operatorPassphraseState: async () => ({ configured: true }),
      } as never,
    });

    await waitFor(() => expect(rendered.getByText("Deferred · awaiting operator · 5m")).toBeTruthy());
    // Both lanes render, in the order the rpc returned them.
    expect(rendered.getByText("lane-deferred")).toBeTruthy();
    expect(rendered.getByText("next startable")).toBeTruthy();
    expect(rendered.queryByText("No open lanes.")).toBeNull();
    // ...and a deferral is not an approval gate: the passphrase state alone
    // arms the controls, so typing one still enables Approve.
    const passphrase = rendered.getByPlaceholderText("Approval passphrase") as HTMLInputElement;
    expect(passphrase.disabled).toBe(false);
    fireEvent.change(passphrase, { target: { value: "typed-only" } });
    expect((rendered.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
    // The deferred fields come from `lanes` — no second endpoint or store.
    expect(rendered.inspection.rpcCalls.map((call) => call.method)).not.toContain("deferredLanes");
  });

  it("reads no secret and targets no host chrome", () => {
    const source = readFileSync(join(PROJECT_ROOT, "app.tsx"), "utf8");
    // The frontend knows the setting only as a boolean state method; the value
    // itself never has a name here to read.
    expect(source).not.toMatch(/operatorPassphrase(?!State)/u);
    // Requirement 2 falls back to the SDK's thread-row status precisely so that
    // none of these are needed to reach the sidebar.
    for (const hack of ["querySelector", "getElementById", "localStorage", "data-testid", "plugin-nav-sidebar", "nth-child"]) {
      expect(source, hack).not.toContain(hack);
    }
  });
});
