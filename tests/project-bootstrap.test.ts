import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const bootstrap = readFileSync(new URL("../docs/project-bootstrap.md", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
const companion = readFileSync(new URL("../plugins/bb-plugin-companion-watcher/README.md", import.meta.url), "utf8");

describe("GH-641 bootstrap defaults", () => {
  it("requires all watcher bindings, blind queue disposition, and rollback verification", () => {
    expect(bootstrap).toContain("Watcher binding and verification default");
    expect(bootstrap).toContain("Companion, fleet-watchdog, and Stall Guard");
    expect(bootstrap).toContain("startable-queue-unreadable");
    expect(bootstrap).toContain("not a healthy cycle");
    expect(bootstrap).toContain("rollback only the target's exact canonical");
    expect(bootstrap).toContain("Rerun Doctor/export after rollback");
  });

  it("keeps domain planning descriptive until GH-637", () => {
    expect(bootstrap).toContain("Name the project's domains and the task classes each domain owns.");
    expect(bootstrap).toContain("more than one domain");
    expect(bootstrap).toContain("does not authorize concurrent duplicate orchestrator-class seats");
    expect(bootstrap).toContain("Until GH-637 lands");
  });

  it("points watcher population at canonical inventory instead of a copied tenant list", () => {
    expect(bootstrap).toContain("query the canonical `project_config_heads` inventory");
    expect(server).toContain("SELECT project_id FROM project_config_heads ORDER BY project_id");
    expect(companion).toContain("native project inventory (`bb.sdk.projects.list()`)");
    expect(server).not.toContain("proj_7iaaqem8z3");
    expect(server).not.toContain("proj_eber9t9n2f");
  });
});
