import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../server.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function fixture(settings: Record<string, string> = {}) {
  const host = createFakePluginHost({
    pluginId: "exec-tracking",
    settings,
    sdk: {
      threads: {
        list: async () => [],
        send: async () => ({ ok: true }),
      },
    },
  });
  plugin(host.bb);
  return host;
}

async function waitFor(path: string): Promise<void> {
  for (let attempts = 0; attempts < 100 && !existsSync(path); attempts += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(existsSync(path)).toBe(true);
}

describe("exec-tracking package", () => {
  it("is a listed server-only current-SDK package with tracked dist", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));
    const collection = JSON.parse(readFileSync(resolve(root, ".bb/plugins.json"), "utf8"));
    const marketplace = JSON.parse(readFileSync(resolve(root, "marketplace.json"), "utf8"));
    expect(manifest.engines).toEqual({ bb: ">=0.37.0", bbPluginSdk: ">=0.4.8" });
    expect(manifest.devDependencies["@get-bb/plugin-sdk"]).toBe("0.4.8");
    expect(manifest.bb).not.toHaveProperty("app");
    expect(collection.plugins).toContainEqual({ name: "exec-tracking", source: "./plugins/bb-plugin-exec-tracking" });
    expect(marketplace.plugins).toContainEqual(expect.objectContaining({ id: "exec-tracking" }));
    for (const file of ["server.js", "server.meta.json"]) {
      expect(existsSync(resolve(import.meta.dirname, "../dist", file)), file).toBe(true);
    }
    expect(existsSync(resolve(import.meta.dirname, "../dist/app.js"))).toBe(false);
  });

  it("registers the same settings, lifecycle events, CLI, and database schema", () => {
    const host = fixture();
    expect(host.harness.registrations.settingsDescriptors).toEqual({
      checkoutPath: {
        type: "string",
        label: "Absolute path to the llm-collab checkout (where bin/, projects.json, and collab.config.json live)",
      },
      pythonPath: {
        type: "string",
        label: "Absolute path to python3.11 (server PATH is narrow; bare python3.11 gave ENOENT)",
      },
    });
    expect(host.harness.registrations.threadEventHandlers).toEqual({
      "thread.created": 1,
      "thread.active": 0,
      "thread.failed": 1,
      "thread.archived": 1,
      "thread.deleted": 1,
      "thread.idle": 1,
    });
    expect(host.harness.registrations.cli).toMatchObject({
      name: "silent-wake",
      summary: "Queue one silent orchestrator pointer from a residual watcher",
    });
    const schema = host.bb.storage.database().prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'role_wake_dedupe'",
    ).get() as { sql: string };
    expect(schema.sql).toContain("PRIMARY KEY (project_id, role_thread_id)");
    expect(schema.sql).toContain("CHECK (pending IN (0, 1))");
  });

  it("hands SDK-resolved primitive executed evidence to the external recorder", async () => {
    const directory = mkdtempSync(join(tmpdir(), "exec-tracking-sdk-"));
    temporaryDirectories.push(directory);
    mkdirSync(join(directory, "bin"));
    const capture = join(directory, "capture.json");
    writeFileSync(join(directory, "bin", "record_executed_triples.py"),
      `require("node:fs").writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)))`);
    const host = createFakePluginHost({
      pluginId: "exec-tracking",
      settings: { checkoutPath: directory, pythonPath: process.execPath },
      sdk: {
        threads: {
          defaultExecutionOptions: async () => ({
            model: "model-executed",
            reasoningLevel: "high",
            source: "client/turn/requested",
          }),
          list: async () => [],
          send: async () => ({ ok: true }),
        },
      },
    });
    plugin(host.bb);
    await host.harness.emitThreadEvent("thread.created", {
      thread: makeThreadResponse({ id: "thread-evidence", projectId: "native-project", providerId: "provider-executed" }),
    });
    await waitFor(capture);
    expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual([
      "--thread-id", "thread-evidence",
      "--thread-project", "native-project",
      "--provider", "provider-executed",
      "--model", "model-executed",
      "--reasoning-level", "high",
      "--source", "client/turn/requested",
    ]);
  });

  it("is inert during the same-id install gap when settings are absent", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({ ok: true }));
    const host = createFakePluginHost({
      pluginId: "exec-tracking",
      sdk: {
        threads: {
          list: async () => [makeThreadResponse({ status: "error" })],
          send,
        },
      },
    });
    plugin(host.bb);
    await vi.runOnlyPendingTimersAsync();
    expect(send).not.toHaveBeenCalled();
    expect(host.harness.logEntries.some(({ message }) => message.includes("must be configured"))).toBe(true);
  });
});
