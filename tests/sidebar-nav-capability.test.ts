import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Tripwire for docs/sidebar-plugin-nav-collapse.md. The sidebar's
// plugin-navigation region is host-rendered with no plugin-facing hook, so the
// collapse feature is blocked. These assertions fail the moment BB ships one —
// that failure is the signal to reopen the feature, not a regression.
describe("host plugin-nav region capability", () => {
  const appTypes = readFileSync(join(PROJECT_ROOT, "types/bb-plugin-sdk-app.d.ts"), "utf8");
  const serverTypes = readFileSync(join(PROJECT_ROOT, "types/bb-plugin-sdk.d.ts"), "utf8");

  it("declares no nav-region slot, hook, or collapse state", () => {
    for (const symbol of ["navRegion", "NavRegion", "navRows", "PluginNavRegion", "pluginPanelOrder", "hiddenPluginPanels"]) {
      expect(appTypes, `app SDK gained ${symbol}`).not.toContain(symbol);
    }
  });

  it("keeps the nav rows outside every registrable slot", () => {
    // The threadList contract is where the host states the exclusion.
    expect(appTypes).toContain("the plugin nav rows, and the footer stay host-rendered");
  });

  it("exposes no server-side sidebar nav setting", () => {
    for (const symbol of ["pluginPanelOrder", "hiddenPluginPanels", "pluginPanelVisibleLimit"]) {
      expect(serverTypes, `server SDK gained ${symbol}`).not.toContain(symbol);
    }
  });

  it("gives a content script no nav-region handle", () => {
    const context = /interface PluginContentScriptContext \{[\s\S]*?\n\}/u.exec(appTypes)?.[0] ?? "";
    expect(context).not.toBe("");
    expect(context).not.toMatch(/nav/iu);
  });
});
