import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activateRelease } from "../scripts/activate-release.mjs";
import { canonicalJson, manifestFor } from "../scripts/release-artifact.mjs";

const PROJECT_ID = "proj_activationfixture";
const PRIOR_SCHEMA = "1".repeat(64);
const CANDIDATE_SCHEMA = "2".repeat(64);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bb-collab-activation-"));
  const sourceRoot = join(root, "source");
  const releaseDirectory = join(root, "release");
  const priorRoot = join(root, "prior");
  const stateDirectory = join(root, "state");
  for (const directory of [sourceRoot, releaseDirectory, priorRoot]) mkdirSync(join(directory, "dist"), { recursive: true });
  const sourceManifest = {
    name: "bb-plugin-bb-collab",
    version: "0.1.0",
    type: "module",
    scripts: { build: "node -e 0" },
    bb: { name: "bb-collab", description: "fixture", branding: { icon: "Box" }, server: "./dist/server.js", app: "./app.tsx", skills: [] },
  };
  writeFileSync(join(sourceRoot, "package.json"), JSON.stringify(sourceManifest));
  writeFileSync(join(sourceRoot, "dist/server.js"), "export const schemaDigest = 'unused';\nexport default () => {};\n");
  writeFileSync(join(sourceRoot, "dist/app.js"), "candidate app\n");
  writeFileSync(join(releaseDirectory, "dist/server.js"), "export const schemaDigest = 'unused';\nexport default () => {};\n");
  writeFileSync(join(releaseDirectory, "dist/app.js"), "candidate app\n");
  writeFileSync(join(priorRoot, "package.json"), JSON.stringify(sourceManifest));
  writeFileSync(join(priorRoot, "dist/server.js"), "prior server\n");
  writeFileSync(join(priorRoot, "dist/app.js"), "prior app\n");
  execFileSync("git", ["init", "--quiet"], { cwd: sourceRoot });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: sourceRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: sourceRoot });
  execFileSync("git", ["add", "."], { cwd: sourceRoot });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: sourceRoot });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
  const manifest = manifestFor(releaseDirectory, commit, sourceRoot);
  writeFileSync(join(releaseDirectory, "release-manifest.json"), `${canonicalJson(manifest)}\n`);
  return { root, sourceRoot, releaseDirectory, priorRoot, stateDirectory };
}

function fakeAdapter(priorRoot: string, options: {
  priorSchema?: string;
  bind?: (state: AdapterState, binding: any) => void;
  settle?: (state: AdapterState) => void;
  rollback?: (state: AdapterState) => void;
} = {}) {
  const priorSource = { requested: `path:${priorRoot}`, resolved: `path:${priorRoot}`, engines: {}, installedAt: 1, history: [] };
  const state: AdapterState = { root: priorRoot, source: priorSource, status: "running", services: [], bound: false, rollbackCalls: 0 };
  const adapter = {
    status: () => ({ project: { id: PROJECT_ID } }),
    list: () => [{ id: "bb-collab", rootDir: state.root, status: state.status, services: state.services, app: { hasApp: true, bundle: { compatible: true } } }],
    source: () => state.source,
    doctor: () => ({ outcome: "OK", evidence: { schema: { digest: state.bound ? CANDIDATE_SCHEMA : (options.priorSchema ?? CANDIDATE_SCHEMA) } } }),
    bind(binding: any) {
      state.bound = true;
      state.root = binding.resolvedRoot;
      state.source = { requested: `path:${binding.resolvedRoot}`, resolved: `path:${binding.resolvedRoot}`, engines: {}, installedAt: 2, history: [] };
      options.bind?.(state, binding);
      return { adapter: "fixture" };
    },
    settle: async () => { options.settle?.(state); },
    rollback() {
      state.rollbackCalls += 1;
      if (options.rollback) options.rollback(state);
      else {
        state.bound = false;
        state.root = priorRoot;
        state.source = priorSource;
        state.status = "running";
      }
    },
  };
  return { adapter, state };
}

interface AdapterState {
  root: string;
  source: Record<string, unknown>;
  status: string;
  services: Array<{ name: string; state: string }>;
  bound: boolean;
  rollbackCalls: number;
}

function cleanup(path: string) {
  if (!lstatSync(path).isDirectory()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    if (lstatSync(child).isDirectory()) cleanup(child);
    else chmodSync(child, 0o600);
  }
  rmSync(path, { recursive: true, force: true });
}

async function runFixture(created: ReturnType<typeof fixture>, adapter: ReturnType<typeof fakeAdapter>["adapter"], extra = {}) {
  return activateRelease({
    releaseDirectory: created.releaseDirectory,
    sourceRoot: created.sourceRoot,
    stateDirectory: created.stateDirectory,
    projectId: PROJECT_ID,
    adapter,
    candidateSchemaFingerprint: async () => CANDIDATE_SCHEMA,
    ...extra,
  });
}

describe("inactive release activation", () => {
  it("activates an unchanged schema without backup or quiescence ceremony", async () => {
    const created = fixture();
    const { adapter } = fakeAdapter(created.priorRoot);
    try {
      const result = await runFixture(created, adapter);
      expect(result.outcome).toBe("activated");
      expect(result.receipt).toMatchObject({ state: "active", projectId: PROJECT_ID, schemaFingerprint: CANDIDATE_SCHEMA, schemaEvidenceDigest: null });
      expect(JSON.parse(readFileSync(join(created.stateDirectory, "deployment.json"), "utf8"))).toMatchObject({ state: "active" });
    } finally { cleanup(created.root); }
  });

  it("rejects candidate bytes staged elsewhere while registration remains prior", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { bind: (current) => { current.root = created.priorRoot; } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("loaded generation is not bound to candidate");
      expect(state.root).toBe(created.priorRoot);
      expect(state.rollbackCalls).toBe(1);
    } finally { cleanup(created.root); }
  });

  it("rejects a path binding whose actual server entry resolves to server.ts", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { bind: (_current, binding) => {
      chmodSync(binding.resolvedRoot, 0o755);
      chmodSync(join(binding.resolvedRoot, "package.json"), 0o644);
      const manifest = JSON.parse(readFileSync(join(binding.resolvedRoot, "package.json"), "utf8"));
      manifest.bb.server = "./server.ts";
      writeFileSync(join(binding.resolvedRoot, "package.json"), JSON.stringify(manifest));
      writeFileSync(join(binding.resolvedRoot, "server.ts"), "export default () => {};\n");
    } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("server entry is not candidate dist/server.js");
      expect(state.root).toBe(created.priorRoot);
    } finally { cleanup(created.root); }
  });

  it("detects a post-settle frontend rewrite and rolls back", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { settle: (current) => {
      chmodSync(join(current.root, "dist"), 0o755);
      chmodSync(join(current.root, "dist/app.js"), 0o644);
      writeFileSync(join(current.root, "dist/app.js"), "ambient rebuild\n");
    } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("deployed artifact digest mismatch: bb-collab/dist/app.js");
      expect(state.root).toBe(created.priorRoot);
    } finally { cleanup(created.root); }
  });

  it("rejects reload success while the prior generation remains resident", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { bind: (current) => { current.root = created.priorRoot; } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("loaded generation is not bound to candidate");
      expect(state.rollbackCalls).toBe(1);
    } finally { cleanup(created.root); }
  });

  it("fails loudly when rollback is skipped after failed health", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, {
      bind: (current) => { current.status = "degraded"; },
      rollback: () => {},
    });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("rollback failed: prior loaded generation was not restored");
      expect(state.root).not.toBe(created.priorRoot);
    } finally { cleanup(created.root); }
  });

  it("refuses a schema-changing candidate without backup and quiescence evidence", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { priorSchema: PRIOR_SCHEMA });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("schema-changing activation requires backup and quiescence evidence");
      expect(state.rollbackCalls).toBe(0);
    } finally { cleanup(created.root); }
  });
});
