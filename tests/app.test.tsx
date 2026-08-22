// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installTestPluginRuntime, loadPluginApp } from "@bb/plugin-sdk/testing/app";
import { expect, it } from "vitest";

it("leaves Operator Inbox registrations to its independent plugin", async () => {
  installTestPluginRuntime();
  const app = await loadPluginApp(() => import("../app"));
  expect(app.navPanels).toEqual([]);
  expect(app.contentScripts).toEqual([]);
  expect(app.sidebarFooterActions.map(({ id }) => id)).toEqual(["bb-collab-settings"]);
  expect(readFileSync(resolve("dist/app.js"), "utf8")).not.toContain("Inbox unread indicator");
});
