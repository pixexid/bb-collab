// @vitest-environment jsdom

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";

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
});
