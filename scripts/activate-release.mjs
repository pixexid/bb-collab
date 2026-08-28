import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync,
  unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, verifyRelease, verifyRuntimeClosure } from "./release-artifact.mjs";

const RECEIPT_VERSION = 1;
const SETTLE_MS = 15_000;
const STAGING_CONTRACT_VERSION = 2;
const SOURCE_EPOCH_MS = Date.UTC(2000, 0, 1);
const APP_EPOCH_MS = SOURCE_EPOCH_MS + 60_000;
const MTIME_MARGIN_MS = APP_EPOCH_MS - SOURCE_EPOCH_MS;
const HOST_IGNORED_SEGMENTS = new Set(["dist", "node_modules", ".git"]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const slash = (value) => value.split(sep).join("/");
const pluginId = (name) => name.replace(/^@[^/]+\//u, "").replace(/^bb-plugin-/u, "");
const sourceKind = (source) => /^(path|git|npm):/u.exec(source)?.[1] ?? "unknown";
const identityCommand = (id) => id === "bb-collab" ? "collab" : id === "exec-tracking" ? "silent-wake" : id;
const defaultStateDirectory = (dataDir) => join(resolve(dataDir), "deployments", "bb-collab");

function jsonCommand(command, args, options = {}) {
  return JSON.parse(execFileSync(command, args, { encoding: "utf8", ...options }));
}

function atomicWrite(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${canonicalJson(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readReceipt(path) {
  if (!existsSync(path)) return { bytes: null, value: null };
  const bytes = readFileSync(path);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function assertAbsoluteDirectory(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  if (existsSync(path) && !lstatSync(path).isDirectory()) throw new Error(`${label} is not a directory`);
}

function sourceManifest(sourceRoot, packageRoot) {
  const path = join(sourceRoot, packageRoot, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (typeof manifest.name !== "string" || typeof manifest.bb !== "object" || manifest.bb === null) {
    throw new Error(`invalid plugin package manifest: ${slash(relative(sourceRoot, path))}`);
  }
  return manifest;
}

function expectedFiles(manifest, packageRoot) {
  const prefix = packageRoot === "." ? "" : `${packageRoot}/`;
  return manifest.files
    .filter(({ path }) => path.startsWith(`${prefix}dist/`))
    .map(({ path, sha256: digest }) => ({ path: path.slice(prefix.length), sha256: digest }));
}

function wrapperManifest(manifest, files) {
  const bb = { ...manifest.bb, skills: [] };
  if (files.some(({ path }) => path === "dist/server.js")) bb.server = "./dist/server.js";
  else delete bb.server;
  if (files.some(({ path }) => path === "dist/app.js")) bb.app = "./dist/app.js";
  else delete bb.app;
  if (files.some(({ path }) => path === "dist/host.js")) bb.host = "./dist/host.js";
  else delete bb.host;
  return {
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    type: "module",
    ...(manifest.engines === undefined ? {} : { engines: manifest.engines }),
    bb,
  };
}

function copyBrandingAssets(sourceRoot, packageRoot, wrapperRoot, branding) {
  for (const value of Object.values(branding ?? {}).flatMap((value) => typeof value === "object" && value !== null ? Object.values(value) : [value])) {
    if (typeof value !== "string" || !value.startsWith("./")) continue;
    const source = resolve(sourceRoot, packageRoot, value);
    const relativeAsset = value.slice(2);
    const target = resolve(wrapperRoot, relativeAsset);
    if (!source.startsWith(`${resolve(sourceRoot, packageRoot)}${sep}`) || !target.startsWith(`${resolve(wrapperRoot)}${sep}`)) throw new Error("branding asset escapes its package root");
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
  }
}

function makeReadOnly(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) makeReadOnly(child);
    else chmodSync(child, 0o444);
  }
  chmodSync(path, 0o555);
}

function makeWritable(path) {
  if (!existsSync(path)) return;
  chmodSync(path, lstatSync(path).isDirectory() ? 0o700 : 0o600);
  if (lstatSync(path).isDirectory()) for (const entry of readdirSync(path)) makeWritable(join(path, entry));
}

function treeEntries(path, base = path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`staged release contains a mutable or unsupported entry: ${slash(relative(base, child))}`);
    return entry.isDirectory() ? [...treeEntries(child, base), child] : [child];
  });
}

function normalizeStageMtimes(root, artifactRoots) {
  for (const path of [...treeEntries(root), root]) utimesSync(path, SOURCE_EPOCH_MS / 1000, SOURCE_EPOCH_MS / 1000);
  for (const distRoot of artifactRoots) {
    const app = join(root, distRoot, "app.js");
    if (existsSync(app)) utimesSync(app, APP_EPOCH_MS / 1000, APP_EPOCH_MS / 1000);
  }
}

function latestHostInspectedMtime(root) {
  let latest = statSync(root).mtimeMs;
  const pending = [""];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const relativePath = join(directory, entry.name);
      if (relativePath.split(sep).some((segment) => HOST_IGNORED_SEGMENTS.has(segment))) continue;
      const path = join(root, relativePath);
      latest = Math.max(latest, statSync(path).mtimeMs);
      if (entry.isDirectory()) pending.push(relativePath);
    }
  }
  return latest;
}

function verifyStageMtimes(root, artifactRoots, deterministic = true) {
  for (const distRoot of artifactRoots) {
    const packageRoot = dirname(distRoot) === "." ? root : join(root, dirname(distRoot));
    const app = join(root, distRoot, "app.js");
    if (!existsSync(app)) continue;
    const appMtime = statSync(app).mtimeMs;
    const sourceMtime = latestHostInspectedMtime(packageRoot);
    if (appMtime < sourceMtime + MTIME_MARGIN_MS || (deterministic && (appMtime !== APP_EPOCH_MS || sourceMtime !== SOURCE_EPOCH_MS))) {
      throw new Error(`staged app mtime contract failed: ${slash(relative(root, packageRoot) || ".")}`);
    }
  }
}

function verifyReadOnlyTree(root) {
  for (const path of [...treeEntries(root), root]) if ((lstatSync(path).mode & 0o222) !== 0) throw new Error(`staged release is mutable: ${slash(relative(root, path) || ".")}`);
}

function verifyBindingFiles(binding) {
  for (const file of binding.expectedFiles) {
    const path = join(binding.resolvedRoot, file.path);
    if (!existsSync(path) || sha256(readFileSync(path)) !== file.sha256) throw new Error(`deployed artifact digest mismatch: ${binding.pluginId}/${file.path}`);
  }
}

async function stageRelease({ releaseDirectory, sourceRoot, stateDirectory, manifest }) {
  const releases = join(stateDirectory, "releases", `path-load-v${STAGING_CONTRACT_VERSION}`);
  const artifactRoot = join(releases, manifest.releaseDigest);
  const temporary = `${artifactRoot}.tmp-${process.pid}`;
  if (existsSync(artifactRoot)) {
    verifyRuntimeClosure(artifactRoot, manifest, true);
    verifyStageMtimes(artifactRoot, manifest.artifactRoots);
    verifyReadOnlyTree(artifactRoot);
    return artifactRoot;
  }
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  mkdirSync(temporary, { recursive: false, mode: 0o700 });
  try {
    for (const distRoot of manifest.artifactRoots) {
      const packageRoot = dirname(distRoot) === "." ? "." : dirname(distRoot);
      const source = sourceManifest(sourceRoot, packageRoot);
      const files = expectedFiles(manifest, packageRoot);
      const wrapper = join(temporary, packageRoot);
      mkdirSync(wrapper, { recursive: true });
      cpSync(join(releaseDirectory, distRoot), join(wrapper, "dist"), { recursive: true });
      const stagedManifest = wrapperManifest(source, files);
      copyBrandingAssets(sourceRoot, packageRoot, wrapper, stagedManifest.bb.branding);
      writeFileSync(join(wrapper, "package.json"), `${canonicalJson(stagedManifest)}\n`);
    }
    cpSync(join(releaseDirectory, "node_modules"), join(temporary, "node_modules"), { recursive: true });
    normalizeStageMtimes(temporary, manifest.artifactRoots);
    verifyStageMtimes(temporary, manifest.artifactRoots);
    makeReadOnly(temporary);
    verifyRuntimeClosure(temporary, manifest, true);
    verifyReadOnlyTree(temporary);
    renameSync(temporary, artifactRoot);
    verifyStageMtimes(artifactRoot, manifest.artifactRoots);
  } catch (error) {
    makeWritable(temporary);
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return artifactRoot;
}

function systemAdapter(projectId, stateDirectory, runner = jsonCommand) {
  const run = (args) => runner("bb", args, { cwd: stateDirectory });
  const status = () => run(["status", "--json"]);
  const list = () => run(["plugin", "list", "--json"]).plugins;
  const source = (id) => run(["plugin", "source", id, "--json"]);
  const doctor = () => run(["collab", "doctor", "--project", projectId]);
  const reload = (binding) => run(["plugin", "reload", binding.pluginId, "--json"]);
  const resident = (binding) => run([binding.identityCommand, "activation-identity", "--json"]);
  return {
    status, list, source, doctor, resident, reload,
    version: () => execFileSync("bb", ["--version"], { cwd: stateDirectory, encoding: "utf8" }).trim(),
    settle: () => new Promise((resolvePromise) => setTimeout(resolvePromise, SETTLE_MS)),
  };
}

function appMeta(root) {
  const path = join(root, "dist", "app.meta.json");
  if (!existsSync(path)) return null;
  const meta = JSON.parse(readFileSync(path, "utf8"));
  if (typeof meta.sdkVersion !== "string" || typeof meta.builtWith?.bbVersion !== "string" || meta.builtWith.pluginSdkVersion !== meta.sdkVersion) {
    throw new Error(`invalid app metadata: ${path}`);
  }
  return meta;
}

function appHash(root) {
  const app = join(root, "dist", "app.js");
  if (!existsSync(app)) return null;
  const hash = createHash("sha256").update(readFileSync(app));
  const css = join(root, "dist", "app.css");
  if (existsSync(css)) hash.update(readFileSync(css));
  hash.update(readFileSync(join(root, "dist", "app.meta.json")));
  return hash.digest("hex").slice(0, 16);
}

function authoritativeFiles(root) {
  const paths = [join(root, "package.json")];
  const dist = join(root, "dist");
  if (existsSync(dist)) paths.push(...treeEntries(dist).filter((path) => lstatSync(path).isFile()));
  return paths.map((path) => ({ path: slash(relative(root, path)), sha256: sha256(readFileSync(path)) })).sort((a, b) => a.path.localeCompare(b.path));
}

function hashObservedFiles(root, files) {
  try {
    return files.map(({ path }) => ({ path, sha256: sha256(readFileSync(join(root, path))) }));
  } catch {
    return null;
  }
}

function exactBuffer(current, prior) {
  return current === null ? prior === null : prior !== null && current.equals(prior);
}

function pathWithin(parent, child) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function assertNonOverlappingRoots(bindings) {
  for (let index = 0; index < bindings.length; index += 1) for (let other = index + 1; other < bindings.length; other += 1) {
    const left = resolve(bindings[index].registeredRoot);
    const right = resolve(bindings[other].registeredRoot);
    if (pathWithin(left, right) || pathWithin(right, left)) throw new Error(`overlapping registered roots are not supported: ${bindings[index].pluginId}/${bindings[other].pluginId}`);
  }
}

function requireAppBaseline(root, toolchain, label, deterministic = false) {
  const meta = appMeta(root);
  if (meta === null) return null;
  if (meta.sdkVersion !== toolchain.pluginSdkVersion || meta.builtWith.pluginSdkVersion !== toolchain.pluginSdkVersion) throw new Error(`${label} SDK does not match the exact activation host baseline`);
  if (meta.builtWith.bbVersion !== toolchain.bbVersion) throw new Error(`${label} BB version does not match the exact activation host baseline`);
  const appMtime = statSync(join(root, "dist", "app.js")).mtimeMs;
  const sourceMtime = latestHostInspectedMtime(root);
  if (appMtime < sourceMtime + MTIME_MARGIN_MS || (deterministic && (appMtime !== APP_EPOCH_MS || sourceMtime !== SOURCE_EPOCH_MS))) throw new Error(`${label} app mtime is not build-free`);
  return meta;
}

function createPlan(binding, transactionId, stateDirectory, dataDir, priorReceipt) {
  const registeredRoot = resolve(binding.registeredRoot);
  if (binding.sourceKind !== "path" && !pathWithin(resolve(dataDir), registeredRoot)) throw new Error(`${binding.pluginId} managed root is outside the BB data directory`);
  if (pathWithin(registeredRoot, binding.resolvedRoot) || pathWithin(binding.resolvedRoot, registeredRoot)) throw new Error(`${binding.pluginId} candidate and registered roots overlap`);
  const retainedRoot = join(stateDirectory, "rollback", transactionId, binding.pluginId, "prior-root");
  if (existsSync(retainedRoot)) throw new Error(`${binding.pluginId} rollback root already exists`);
  const slot = lstatSync(registeredRoot);
  if (slot.isDirectory() && !slot.isSymbolicLink()) return {
    adapter: "root-overlay-v2", pluginId: binding.pluginId, registeredRoot, candidateRoot: binding.resolvedRoot,
    retainedRoot, priorSlotKind: "directory", priorSymlinkTarget: null,
  };
  if (!slot.isSymbolicLink()) throw new Error(`${binding.pluginId} registered root is not safely bindable`);
  const priorBinding = priorReceipt.value?.state === "active" ? priorReceipt.value.bindings?.find(({ pluginId: id }) => id === binding.pluginId) : null;
  const priorTarget = readlinkSync(registeredRoot);
  if (priorBinding?.plan?.adapter !== "root-overlay-v2" || resolve(priorBinding.plan.registeredRoot) !== registeredRoot
    || realpathSync(registeredRoot) !== binding.priorRoot || resolve(priorBinding.resolvedRoot) !== binding.priorRoot) {
    throw new Error(`${binding.pluginId} registered root is an arbitrary or unreceipted symlink`);
  }
  return {
    adapter: "root-overlay-v2", pluginId: binding.pluginId, registeredRoot, candidateRoot: binding.resolvedRoot,
    retainedRoot, priorSlotKind: "owned-symlink", priorSymlinkTarget: priorTarget,
  };
}

function prepareBindings({ bindings, adapter, manifest, priorReceipt, stateDirectory, dataDir, transactionId }) {
  assertNonOverlappingRoots(bindings);
  return bindings.map((binding) => {
    const stagedManifest = JSON.parse(readFileSync(join(binding.resolvedRoot, "package.json"), "utf8"));
    if (binding.sourceKind === "path" && stagedManifest.bb?.host) throw new Error(`${binding.pluginId} path host artifacts are not immutable-loadable`);
    requireAppBaseline(binding.resolvedRoot, manifest.toolchain, `${binding.pluginId} candidate`, true);
    const current = binding.priorStatus;
    const resident = adapter.resident(binding);
    const priorManifest = JSON.parse(readFileSync(join(binding.priorRoot, "package.json"), "utf8"));
    if (binding.sourceKind === "path" && priorManifest.bb?.host) throw new Error(`${binding.pluginId} prior path host artifact is not rollback-safe`);
    requireAppBaseline(binding.priorRoot, manifest.toolchain, `${binding.pluginId} prior`);
    const priorFiles = authoritativeFiles(binding.priorRoot);
    const residentServer = resident?.serverEntry ? realpathSync(resident.serverEntry) : null;
    const residentDigest = residentServer && pathWithin(binding.priorRoot, residentServer) ? sha256(readFileSync(residentServer)) : null;
    if (!resident || resident.pluginId !== binding.pluginId || residentServer === null || resident.serverSha256 !== residentDigest) throw new Error(`${binding.pluginId} prior resident does not match prior authoritative bytes`);
    const priorAppHash = appHash(binding.priorRoot);
    if (Boolean(current.app?.hasApp) !== (priorAppHash !== null) || (priorAppHash !== null && current.app?.bundle?.hash !== priorAppHash)) throw new Error(`${binding.pluginId} prior frontend resident does not match prior bytes`);
    const serviceNames = (current.services ?? []).map(({ name }) => name).sort();
    const residentServices = (resident.services ?? []).map(({ name, serverSha256 }) => ({ name, serverSha256 }));
    if (residentServices.length !== serviceNames.length || residentServices.some(({ name, serverSha256 }, index) => name !== serviceNames[index] || serverSha256 !== residentDigest)) throw new Error(`${binding.pluginId} prior services do not match prior resident`);
    const priorSnapshot = {
      source: binding.priorSource, registeredRoot: binding.registeredRoot, resolvedRoot: binding.priorRoot,
      status: current.status, services: current.services ?? [], app: current.app ?? { hasApp: false, bundle: null }, resident,
      authoritativeFiles: priorFiles, receiptDigest: priorReceipt.bytes ? sha256(priorReceipt.bytes) : null,
      rollbackReloadSafe: true,
    };
    return { ...binding, priorSnapshot, plan: createPlan(binding, transactionId, stateDirectory, dataDir, priorReceipt) };
  });
}

function applyOverlay(plan, adapter) {
  adapter.beforeOverlay?.(plan);
  mkdirSync(dirname(plan.retainedRoot), { recursive: true, mode: 0o700 });
  if (plan.priorSlotKind === "directory") renameSync(plan.registeredRoot, plan.retainedRoot);
  else unlinkSync(plan.registeredRoot);
  adapter.afterRename?.(plan);
  symlinkSync(plan.candidateRoot, plan.registeredRoot);
  adapter.afterSymlink?.(plan);
}

function slotObservation(plan) {
  const retained = existsSync(plan.retainedRoot);
  if (!existsSync(plan.registeredRoot)) return { kind: retained ? "rename-only" : "missing", retained };
  const slot = lstatSync(plan.registeredRoot);
  if (slot.isSymbolicLink()) {
    const target = readlinkSync(plan.registeredRoot);
    if (realpathSync(plan.registeredRoot) === realpathSync(plan.candidateRoot) && retained === (plan.priorSlotKind === "directory")) return { kind: "candidate", retained, target };
    if (plan.priorSlotKind === "owned-symlink" && target === plan.priorSymlinkTarget && !retained) return { kind: "prior", retained, target };
    return { kind: "unknown", retained, target };
  }
  if (slot.isDirectory() && plan.priorSlotKind === "directory" && !retained) return { kind: "prior", retained };
  return { kind: "unknown", retained };
}

function priorBackingRoot(binding, slot) {
  if (binding.plan.priorSlotKind === "owned-symlink") return binding.priorSnapshot.resolvedRoot;
  return slot.retained ? binding.plan.retainedRoot : binding.plan.registeredRoot;
}

function observeChange(binding, adapter, receiptPath) {
  const slot = slotObservation(binding.plan);
  const current = adapter.list().find(({ id }) => id === binding.pluginId) ?? null;
  let resident = null;
  try { resident = adapter.resident(binding); } catch {}
  return {
    slot, current, resident, source: adapter.source(binding.pluginId), receipt: readReceipt(receiptPath).bytes,
    priorFiles: hashObservedFiles(priorBackingRoot(binding, slot), binding.priorSnapshot.authoritativeFiles),
  };
}

function residentIsPrior(observation, snapshot) {
  return canonicalJson(observation.resident) === canonicalJson(snapshot.resident)
    && observation.current?.status === snapshot.status
    && canonicalJson(observation.current?.services ?? []) === canonicalJson(snapshot.services)
    && canonicalJson(observation.current?.app ?? { hasApp: false, bundle: null }) === canonicalJson(snapshot.app);
}

function assertExactPrior(observation, binding, priorReceiptBytes) {
  const snapshot = binding.priorSnapshot;
  if (observation.slot.kind !== "prior" || canonicalJson(observation.source) !== canonicalJson(snapshot.source)
    || !residentIsPrior(observation, snapshot) || canonicalJson(observation.priorFiles) !== canonicalJson(snapshot.authoritativeFiles)
    || !exactBuffer(observation.receipt, priorReceiptBytes)) throw new Error(`prior exact deployment was not restored: ${binding.pluginId}`);
}

function restorePriorSlot(plan, observation) {
  if (observation.slot.kind === "prior") return;
  if (observation.slot.kind === "candidate") unlinkSync(plan.registeredRoot);
  else if (observation.slot.kind !== "rename-only") throw new Error("rollback filesystem topology is unowned or ambiguous");
  if (plan.priorSlotKind === "directory") renameSync(plan.retainedRoot, plan.registeredRoot);
  else symlinkSync(plan.priorSymlinkTarget, plan.registeredRoot);
}

function recoverChange(binding, adapter, receiptPath, priorReceiptBytes) {
  let observation = observeChange(binding, adapter, receiptPath);
  try { assertExactPrior(observation, binding, priorReceiptBytes); return { action: "no-op" }; } catch {}
  if (canonicalJson(observation.source) !== canonicalJson(binding.priorSnapshot.source)) {
    if (new Set(["candidate", "rename-only"]).has(observation.slot.kind)) restorePriorSlot(binding.plan, observation);
    throw new Error("registration drift is not exactly recoverable without path install");
  }
  if (!exactBuffer(observation.receipt, priorReceiptBytes)) throw new Error("deployment receipt changed during activation");
  if (canonicalJson(observation.priorFiles) !== canonicalJson(binding.priorSnapshot.authoritativeFiles)) throw new Error("prior authoritative bytes changed during activation");
  restorePriorSlot(binding.plan, observation);
  observation = observeChange(binding, adapter, receiptPath);
  if (residentIsPrior(observation, binding.priorSnapshot)) {
    assertExactPrior(observation, binding, priorReceiptBytes);
    return { action: "filesystem-only" };
  }
  if (!binding.priorSnapshot.rollbackReloadSafe) throw new Error("prior generation was not proven reloadable without rebuild");
  adapter.reload(binding);
  observation = observeChange(binding, adapter, receiptPath);
  assertExactPrior(observation, binding, priorReceiptBytes);
  return { action: "reload-prior" };
}

function schemaCutoverEvidence(doctor, migrationId, projectId, prior, candidate, liveSchema = prior) {
  if (!migrationId || !/^[a-z0-9][a-z0-9-]{2,127}$/u.test(migrationId)) throw new Error("schema-changing activation requires one canonical migration id");
  const evidence = doctor?.evidence;
  const governor = evidence?.governorshipHead;
  const migration = evidence?.activeMigrationRun;
  if (doctor.outcome !== "OK" || evidence?.project?.id !== projectId || evidence?.schema?.digest !== liveSchema
    || governor?.project_id !== projectId || governor.state !== "frozen" || !/^[0-9a-f]{48}$/u.test(governor.fence_token ?? "")
    || migration?.migration_id !== migrationId || migration.state !== "exported" || migration.target_runtime_id !== "bb-collab"
    || migration.retentionExpired !== false || migration.unresolvedProof?.length !== 0
    || !/^[0-9a-f]{64}$/u.test(migration.quiescence_digest ?? "") || !/^[0-9a-f]{64}$/u.test(migration.source_export_digest ?? "")
    || evidence.capacity?.activeWriterCount !== 0 || evidence.capacity?.blindWriterLaneIds?.length !== 0) {
    throw new Error("canonical schema-cutover evidence is unavailable or stale");
  }
  const bound = { projectId, priorSchemaFingerprint: prior, candidateSchemaFingerprint: candidate, governor, migration };
  return { digest: sha256(canonicalJson(bound)), fence: canonicalJson({ governor, migration }) };
}

async function candidateSchemaFingerprint(artifactRoot) {
  const module = await import(`${pathToFileURL(join(artifactRoot, "dist/server.js")).href}?schema=${Date.now()}`);
  if (!/^[0-9a-f]{64}$/u.test(module.schemaDigest ?? "")) throw new Error("candidate server does not export its canonical schema fingerprint");
  return module.schemaDigest;
}

function classifyBindings({ manifest, sourceRoot, artifactRoot, installed, sources }) {
  const installedById = new Map(installed.map((entry) => [entry.id, entry]));
  return manifest.artifactRoots.map((distRoot) => {
    const packageRoot = dirname(distRoot) === "." ? "." : dirname(distRoot);
    const packageManifest = sourceManifest(sourceRoot, packageRoot);
    const id = pluginId(packageManifest.name);
    const current = installedById.get(id);
    const currentSource = sources.get(id);
    if (!current || !currentSource) throw new Error(`release target is not installed: ${id}`);
    const kind = sourceKind(currentSource.requested);
    if (!new Set(["path", "git", "npm"]).has(kind)) throw new Error(`unclassified plugin source: ${id}`);
    const priorRoot = realpathSync(current.rootDir);
    const resolvedRoot = resolve(artifactRoot, packageRoot);
    const files = expectedFiles(manifest, packageRoot);
    const stagedManifest = JSON.parse(readFileSync(join(resolvedRoot, "package.json"), "utf8"));
    if (canonicalJson(stagedManifest) !== canonicalJson(wrapperManifest(packageManifest, files))) throw new Error(`staged binding manifest mismatch: ${id}`);
    const serverEntry = files.some(({ path }) => path === "dist/server.js") ? realpathSync(join(resolvedRoot, "dist/server.js")) : null;
    return {
      pluginId: id, packageRoot, sourceKind: kind, identityCommand: identityCommand(id), registeredRoot: resolve(current.rootDir), priorRoot, resolvedRoot,
      serverEntry, frontendArtifacts: files.filter(({ path }) => path === "dist/app.js" || path === "dist/app.css").map(({ path }) => realpathSync(join(resolvedRoot, path))),
      expectedFiles: files, priorSource: currentSource, priorStatus: current,
    };
  }).sort((a, b) => (a.pluginId === "bb-collab" ? 1 : b.pluginId === "bb-collab" ? -1 : a.pluginId.localeCompare(b.pluginId)));
}

function expectedAppHash(binding) {
  return appHash(binding.resolvedRoot);
}

function proveLoaded(bindings, installed, sources, residents) {
  const installedById = new Map(installed.map((entry) => [entry.id, entry]));
  for (const binding of bindings) {
    const current = installedById.get(binding.pluginId);
    const currentSource = sources.get(binding.pluginId);
    if (!current || current.status !== "running" || current.services?.some(({ state }) => state !== "running")) throw new Error(`plugin health failed: ${binding.pluginId}`);
    const expectsApp = binding.frontendArtifacts.some((path) => path.endsWith("/app.js"));
    if (resolve(current.rootDir) !== resolve(binding.registeredRoot) || realpathSync(current.rootDir) !== realpathSync(binding.resolvedRoot)) throw new Error(`loaded generation is not bound to candidate: ${binding.pluginId}`);
    if (Boolean(current.app?.hasApp) !== expectsApp || (expectsApp && (current.app?.bundle?.compatible !== true || current.app.bundle.hash !== expectedAppHash(binding)))) throw new Error(`resident frontend generation mismatch: ${binding.pluginId}`);
    if (canonicalJson(currentSource) !== canonicalJson(binding.priorSource)) throw new Error(`registered source changed during activation: ${binding.pluginId}`);
    const packageManifest = JSON.parse(readFileSync(join(current.rootDir, "package.json"), "utf8"));
    const actualServer = packageManifest.bb?.server ? realpathSync(join(current.rootDir, packageManifest.bb.server)) : null;
    if (actualServer !== binding.serverEntry || actualServer?.endsWith("server.ts")) throw new Error(`server entry is not candidate dist/server.js: ${binding.pluginId}`);
    const resident = residents.get(binding.pluginId);
    const expectedServer = binding.expectedFiles.find(({ path }) => path === "dist/server.js")?.sha256 ?? null;
    if (!resident || resident.pluginId !== binding.pluginId || resident.serverEntry !== binding.serverEntry || resident.serverSha256 !== expectedServer) throw new Error(`resident server generation mismatch: ${binding.pluginId}`);
    const expectedServices = (current.services ?? []).map(({ name }) => name).sort();
    const residentServices = (resident.services ?? []).map(({ name, serverSha256 }) => ({ name, serverSha256 }));
    if (residentServices.length !== expectedServices.length || residentServices.some(({ name, serverSha256 }, index) => name !== expectedServices[index] || serverSha256 !== expectedServer)) throw new Error(`old or orphaned service generation remains authoritative: ${binding.pluginId}`);
    verifyBindingFiles(binding);
  }
}

function proveRollback(changes, adapter, receiptPath, priorReceiptBytes) {
  for (const { binding } of changes) assertExactPrior(observeChange(binding, adapter, receiptPath), binding, priorReceiptBytes);
}

function verifyActiveReceipt({ stateDirectory, adapter }) {
  const receipt = readReceipt(join(stateDirectory, "deployment.json")).value;
  if (receipt?.version !== RECEIPT_VERSION || receipt.state !== "active" || !/^proj_[a-z0-9]+$/u.test(receipt.projectId ?? "")) throw new Error("active deployment receipt is unavailable");
  const runtime = adapter ?? systemAdapter(receipt.projectId, stateDirectory);
  const ids = receipt.bindings.map(({ pluginId: id }) => id);
  proveLoaded(receipt.bindings, runtime.list(), new Map(ids.map((id) => [id, runtime.source(id)])), new Map(receipt.bindings.map((binding) => [binding.pluginId, runtime.resident(binding)])));
  const doctor = runtime.doctor();
  if (doctor.outcome !== "OK" || doctor.evidence?.schema?.digest !== receipt.schemaFingerprint) throw new Error("active receipt schema fingerprint is not loaded");
  return receipt;
}

async function activateRelease(options) {
  const { releaseDirectory, sourceRoot, stateDirectory, projectId } = options;
  assertAbsoluteDirectory(releaseDirectory, "release directory");
  assertAbsoluteDirectory(sourceRoot, "source root");
  assertAbsoluteDirectory(stateDirectory, "state directory");
  if (!/^proj_[a-z0-9]+$/u.test(projectId)) throw new Error("project id is invalid");
  const adapter = options.adapter ?? systemAdapter(projectId, stateDirectory);
  const initialHostStatus = adapter.status();
  if (!options.adapter && resolve(stateDirectory) !== defaultStateDirectory(initialHostStatus.dataDir)) throw new Error("deployment state directory is not the canonical BB host-local root");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(stateDirectory, "activation.lock");
  let lock;
  try { lock = openSync(lockPath, "wx", 0o600); } catch { throw new Error("another activation writer holds the host-local lock"); }
  const receiptPath = join(stateDirectory, "deployment.json");
  const pendingPath = join(stateDirectory, "deployment.pending.json");
  const priorReceipt = readReceipt(receiptPath);
  const transactionId = `${Date.now()}-${process.pid}`;
  const changed = [];
  let ownsPending = false;
  let pending = null;
  try {
    const manifest = verifyRelease(releaseDirectory, join(releaseDirectory, "release-manifest.json"), sourceRoot);
    if (manifest.loadAuthority !== "inactive") throw new Error("activation requires an inactive v2 release candidate");
    const hostStatus = initialHostStatus;
    if (hostStatus.project?.id !== projectId && hostStatus.projectId !== projectId) throw new Error("activation project does not match the current BB project");
    const hostVersion = adapter.version();
    if (hostVersion !== manifest.toolchain.bbVersion) throw new Error(`activation BB version ${hostVersion} does not match pinned ${manifest.toolchain.bbVersion}`);
    const artifactRoot = await stageRelease({ releaseDirectory, sourceRoot, stateDirectory, manifest });
    const candidateSchema = await candidateSchemaFingerprint(artifactRoot);
    verifyRuntimeClosure(artifactRoot, manifest, true);
    const doctorBefore = adapter.doctor();
    if (doctorBefore.outcome !== "OK" || !/^[0-9a-f]{64}$/u.test(doctorBefore.evidence?.schema?.digest ?? "")) throw new Error("current canonical schema fingerprint is unavailable");
    const priorSchema = doctorBefore.evidence.schema.digest;
    if (priorReceipt.value?.state === "active" && priorReceipt.value.releaseDigest === manifest.releaseDigest) {
      const bindings = priorReceipt.value.bindings;
      const ids = bindings.map(({ pluginId }) => pluginId);
      proveLoaded(bindings, adapter.list(), new Map(ids.map((id) => [id, adapter.source(id)])), new Map(bindings.map((binding) => [binding.pluginId, adapter.resident(binding)])));
      if (doctorBefore.evidence.schema.digest !== priorReceipt.value.schemaFingerprint) throw new Error("active receipt schema fingerprint is not loaded");
      return { outcome: "already_active", receipt: priorReceipt.value };
    }
    const schemaCutover = priorSchema === candidateSchema ? null : schemaCutoverEvidence(doctorBefore, options.schemaCutoverId, projectId, priorSchema, candidateSchema);
    const schemaEvidenceDigest = schemaCutover?.digest ?? null;
    const installed = adapter.list();
    const ids = manifest.artifactRoots.map((distRoot) => pluginId(sourceManifest(sourceRoot, dirname(distRoot) === "." ? "." : dirname(distRoot)).name));
    if (new Set(ids).size !== ids.length) throw new Error("release artifact roots do not map to unique installed plugin ids");
    const sources = new Map(ids.map((id) => [id, adapter.source(id)]));
    const bindings = prepareBindings({
      bindings: classifyBindings({ manifest, sourceRoot, artifactRoot, installed, sources }), adapter, manifest, priorReceipt,
      stateDirectory, dataDir: hostStatus.dataDir ?? stateDirectory, transactionId,
    });
    for (const binding of bindings) verifyBindingFiles(binding);
    pending = {
      version: RECEIPT_VERSION, state: "activating", transactionId, projectId, sourceCommit: manifest.sourceCommit,
      releaseDigest: manifest.releaseDigest, artifactRoot, schemaFingerprint: candidateSchema, priorSchemaFingerprint: priorSchema,
      stagingContractVersion: STAGING_CONTRACT_VERSION, sourceEpochMs: SOURCE_EPOCH_MS, appEpochMs: APP_EPOCH_MS,
      schemaEvidenceDigest, previousReceiptDigest: priorReceipt.bytes ? sha256(priorReceipt.bytes) : null,
      bindings: bindings.map(({ priorStatus, ...binding }) => ({ ...binding, priorStatus: { rootDir: priorStatus.rootDir, status: priorStatus.status, services: priorStatus.services, app: priorStatus.app } })),
    };
    atomicWrite(pendingPath, pending);
    ownsPending = true;
    for (const binding of bindings) {
      const currentSource = adapter.source(binding.pluginId);
      const current = adapter.list().find(({ id }) => id === binding.pluginId);
      if (canonicalJson(currentSource) !== canonicalJson(binding.priorSource) || !current || resolve(current.rootDir) !== binding.registeredRoot || realpathSync(current.rootDir) !== binding.priorRoot) throw new Error(`activation fence moved before binding: ${binding.pluginId}`);
      if (schemaCutover && schemaCutoverEvidence(adapter.doctor(), options.schemaCutoverId, projectId, priorSchema, candidateSchema).fence !== schemaCutover.fence) throw new Error("schema-cutover fence moved before binding");
      const change = { binding };
      changed.push(change);
      applyOverlay(binding.plan, adapter);
      adapter.reload(binding);
    }
    await adapter.settle();
    const afterSources = new Map(ids.map((id) => [id, adapter.source(id)]));
    proveLoaded(bindings, adapter.list(), afterSources, new Map(bindings.map((binding) => [binding.pluginId, adapter.resident(binding)])));
    const doctorAfter = adapter.doctor();
    if (doctorAfter.outcome !== "OK" || doctorAfter.evidence?.schema?.digest !== candidateSchema) throw new Error("loaded canonical schema fingerprint does not identify the candidate generation");
    if (schemaCutover && schemaCutoverEvidence(doctorAfter, options.schemaCutoverId, projectId, priorSchema, candidateSchema, candidateSchema).fence !== schemaCutover.fence) throw new Error("schema-cutover fence moved after binding");
    if (priorReceipt.bytes === null ? existsSync(receiptPath) : !readReceipt(receiptPath).bytes?.equals(priorReceipt.bytes)) throw new Error("deployment receipt changed concurrently");
    const receipt = { ...pending, state: "active", activatedAt: Date.now() };
    atomicWrite(receiptPath, receipt);
    rmSync(pendingPath, { force: true });
    return { outcome: "activated", receipt };
  } catch (error) {
    const rollbackErrors = [];
    const rollbackOrder = [...changed].reverse();
    for (const change of rollbackOrder) {
      try { recoverChange(change.binding, adapter, receiptPath, priorReceipt.bytes); } catch (rollbackError) { rollbackErrors.push(`${change.binding.pluginId}: ${rollbackError.message}`); }
    }
    if (changed.length && rollbackErrors.length === 0) {
      try { proveRollback(changed, adapter, receiptPath, priorReceipt.bytes); } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
    }
    if (rollbackErrors.length) {
      if (ownsPending) atomicWrite(pendingPath, { ...pending, state: "rollback_failed", failedAt: Date.now(), activationError: error.message, rollbackErrors });
      throw new Error(`${error.message}; rollback failed: ${rollbackErrors.join("; ")}`);
    }
    if (ownsPending) rmSync(pendingPath, { force: true });
    throw error;
  } finally {
    if (lock !== undefined) closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

function parseArgs(argv) {
  const value = (name) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
  if (argv[0] !== "activate") throw new Error("usage: activate-release.mjs activate --release <absolute-directory> --project <project-id> [--schema-cutover <canonical-migration-id>]");
  const projectId = value("--project");
  const status = jsonCommand("bb", ["status", "--json"]);
  return {
    releaseDirectory: resolve(value("--release") ?? ""), sourceRoot: process.cwd(), stateDirectory: defaultStateDirectory(status.dataDir),
    projectId, schemaCutoverId: value("--schema-cutover"),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  activateRelease(parseArgs(process.argv.slice(2))).then((result) => console.log(canonicalJson(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

export { activateRelease, assertNonOverlappingRoots, classifyBindings, defaultStateDirectory, proveLoaded, proveRollback, systemAdapter, verifyActiveReceipt };
