import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDirectory = join(root, "release");
const manifestName = "release-manifest.json";
const pinnedToolchain = Object.freeze({
  bbPackage: "bb-app@0.39.0",
  bbVersion: "0.39.0",
  nodeVersion: "v22.23.1",
  pluginSdkVersion: "0.4.8",
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function workspacePatterns(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? [];
  return workspaces.map((pattern) => {
    if (pattern !== "plugins/*" && pattern !== "packages/*") throw new Error(`unsupported artifact workspace: ${pattern}`);
    return pattern.slice(0, -2);
  });
}

function packageRoots(directory = root) {
  return [directory, ...workspacePatterns(directory).flatMap((parent) => {
    const parentPath = join(directory, parent);
    if (!existsSync(parentPath)) return [];
    return readdirSync(parentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(parentPath, entry.name, "package.json")))
      .map((entry) => join(parentPath, entry.name));
  })].filter((packageRoot) => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    return Boolean(manifest.scripts?.build);
  }).sort();
}

function declaredArtifactRoots(directory = root) {
  return packageRoots(directory).map((packageRoot) => relative(directory, join(packageRoot, "dist")).split(sep).join("/"));
}

function observedArtifactRoots(directory) {
  const roots = [];
  const add = (path, relativePath) => {
    if (!existsSync(path)) return;
    if (!lstatSync(path).isDirectory()) throw new Error(`artifact root is not a directory: ${relativePath}`);
    roots.push(relativePath);
  };
  add(join(directory, "dist"), "dist");
  for (const parent of ["plugins", "packages"]) {
    const parentPath = join(directory, parent);
    if (!existsSync(parentPath)) continue;
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (entry.isDirectory()) add(join(parentPath, entry.name, "dist"), `${parent}/${entry.name}/dist`);
    }
  }
  return roots.sort();
}

function assertArtifactRoots(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const extra = actual.find((path) => !expectedSet.has(path));
  if (extra) throw new Error(`undeclared artifact root: ${extra}`);
  const missing = expected.find((path) => !actualSet.has(path));
  if (missing) throw new Error(`missing artifact root: ${missing}`);
}

function filesBelow(directory, base = directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path, base) : [relative(base, path).split(sep).join("/")];
  });
}

function artifactFiles(directory, artifactRoots) {
  return artifactRoots.flatMap((dist) => filesBelow(join(directory, dist)).map((path) => `${dist}/${path}`)).sort();
}

function releasableFiles(directory, artifactRoots) {
  return artifactFiles(directory, artifactRoots).filter((path) => !path.endsWith(".map"));
}

function sourceCommit(directory = root) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
}

function manifestFor(directory, commit = sourceCommit(root), sourceDirectory = root) {
  const artifactRoots = declaredArtifactRoots(sourceDirectory);
  assertArtifactRoots(artifactRoots, observedArtifactRoots(directory));
  const paths = artifactFiles(directory, artifactRoots);
  const unmanifested = paths.find((path) => path.endsWith(".map"));
  if (unmanifested) throw new Error(`unmanifested release file: ${unmanifested}`);
  for (const artifactRoot of artifactRoots) {
    if (!paths.some((path) => path.startsWith(`${artifactRoot}/`))) throw new Error(`empty artifact root: ${artifactRoot}`);
  }
  const files = paths.map((path) => ({ path, sha256: sha256(readFileSync(join(directory, path))) }));
  const payload = { version: 2, sourceCommit: commit, toolchain: pinnedToolchain, loadAuthority: "inactive", artifactRoots, files };
  return { ...payload, releaseDigest: sha256(canonicalJson(payload)) };
}

function assertManifestShape(manifest) {
  if (!manifest || typeof manifest !== "object" || canonicalJson(Object.keys(manifest).sort()) !== canonicalJson(["artifactRoots", "files", "loadAuthority", "releaseDigest", "sourceCommit", "toolchain", "version"])) {
    throw new Error("invalid release manifest fields");
  }
  const artifactRoots = Array.isArray(manifest.artifactRoots) ? manifest.artifactRoots : [];
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (manifest.version !== 2 || !/^[0-9a-f]{40}$/u.test(manifest.sourceCommit ?? "")) throw new Error("invalid release manifest identity");
  if (canonicalJson(manifest.toolchain) !== canonicalJson(pinnedToolchain)) throw new Error("release manifest does not name the pinned toolchain");
  if (manifest.loadAuthority !== "inactive") throw new Error("release manifest loadAuthority must be inactive");
  if (artifactRoots.length === 0 || artifactRoots.some((path) => typeof path !== "string" || !/^(?:dist|(?:plugins|packages)\/[^/.][^/]*\/dist)$/u.test(path) || path.includes("..") || path.includes("\\"))) {
    throw new Error("invalid release manifest artifact roots");
  }
  if (new Set(artifactRoots).size !== artifactRoots.length || artifactRoots.some((path, index) => index > 0 && artifactRoots[index - 1] > path)) {
    throw new Error("release manifest artifact roots must be unique and sorted");
  }
  if (files.length === 0 || files.some(({ path, sha256: digest }) => typeof path !== "string" || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || !artifactRoots.some((artifactRoot) => path.startsWith(`${artifactRoot}/`)) || path.endsWith(".map") || !/^[0-9a-f]{64}$/u.test(digest ?? ""))) {
    throw new Error("invalid release manifest files");
  }
  const paths = files.map(({ path }) => path);
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1] > path)) throw new Error("release manifest files must be unique and sorted");
  if (artifactRoots.some((artifactRoot) => !paths.some((path) => path.startsWith(`${artifactRoot}/`)))) throw new Error("release manifest contains an empty artifact root");
  const { releaseDigest, ...payload } = manifest;
  const expectedDigest = sha256(canonicalJson(payload));
  if (releaseDigest !== expectedDigest) throw new Error("release manifest digest does not match its contents");
}

function verifyRelease(directory, manifestPath, sourceDirectory = root) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assertManifestShape(manifest);
  const commit = sourceCommit(sourceDirectory);
  if (manifest.sourceCommit !== commit) throw new Error(`release source ${manifest.sourceCommit} does not match source commit ${commit}`);
  const declared = declaredArtifactRoots(sourceDirectory);
  if (canonicalJson(manifest.artifactRoots) !== canonicalJson(declared)) throw new Error("release artifact roots do not match source package topology");
  assertArtifactRoots(manifest.artifactRoots, observedArtifactRoots(directory));
  const expected = manifest.files.map(({ path }) => path);
  const actual = artifactFiles(directory, manifest.artifactRoots);
  const unmanifested = actual.find((path) => path.endsWith(".map"));
  if (unmanifested) throw new Error(`unmanifested release file: ${unmanifested}`);
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("release artifact file set does not match its manifest");
  for (const { path, sha256: digest } of manifest.files) {
    if (sha256(readFileSync(join(directory, path))) !== digest) throw new Error(`release artifact digest mismatch: ${path}`);
  }
  return manifest;
}

function assertPinnedToolchain() {
  let actualBb = "unavailable";
  try {
    actualBb = execFileSync("bb", ["--version"], { encoding: "utf8" }).trim();
  } catch {}
  if (process.version !== pinnedToolchain.nodeVersion || actualBb !== pinnedToolchain.bbVersion) {
    throw new Error(`release build requires Node ${pinnedToolchain.nodeVersion} and bb ${pinnedToolchain.bbVersion}; got Node ${process.version} and bb ${actualBb}`);
  }
}

function buildRelease() {
  assertPinnedToolchain();
  const artifactRoots = declaredArtifactRoots();
  const observedBeforeBuild = observedArtifactRoots(root);
  const undeclared = observedBeforeBuild.find((path) => !artifactRoots.includes(path));
  if (undeclared) throw new Error(`undeclared artifact root: ${undeclared}`);
  for (const artifactRoot of artifactRoots) rmSync(join(root, artifactRoot), { recursive: true, force: true });
  for (const packageRoot of packageRoots()) execFileSync("npm", ["run", "build", "--silent"], { cwd: packageRoot, stdio: "inherit" });
  assertArtifactRoots(artifactRoots, observedArtifactRoots(root));
  for (const path of releasableFiles(root, artifactRoots).filter((path) => path.endsWith(".meta.json"))) {
    const metadata = JSON.parse(readFileSync(join(root, path), "utf8"));
    if (metadata.sdkVersion !== pinnedToolchain.pluginSdkVersion
      || metadata.builtWith?.pluginSdkVersion !== pinnedToolchain.pluginSdkVersion
      || metadata.builtWith?.bbVersion !== pinnedToolchain.bbVersion) {
      throw new Error(`${path} does not carry the pinned bb/plugin SDK metadata`);
    }
  }
  execFileSync(process.execPath, [join(root, "scripts", "check-css-bundle.mjs")], { cwd: root, stdio: "inherit" });
  execFileSync(process.execPath, [join(root, "scripts", "role-brief-bundle.mjs")], { cwd: root, stdio: "inherit" });
  rmSync(releaseDirectory, { recursive: true, force: true });
  for (const path of releasableFiles(root, artifactRoots)) {
    const target = join(releaseDirectory, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, path), target);
  }
  const manifest = manifestFor(releaseDirectory);
  writeFileSync(join(releaseDirectory, manifestName), `${canonicalJson(manifest)}\n`);
  verifyRelease(releaseDirectory, join(releaseDirectory, manifestName));
  console.log(`release ${manifest.releaseDigest}`);
}

function invokePinnedBuild() {
  const env = { ...process.env, BB_COLLAB_RELEASE_PINNED: "1" };
  delete env.BB_CLI;
  execFileSync("npm", ["exec", "--yes", `--package=${pinnedToolchain.bbPackage}`, "--", process.execPath, fileURLToPath(import.meta.url), "build"], {
    cwd: root,
    env,
    stdio: "inherit",
  });
}

function main(argv) {
  const [command = "build", argument] = argv;
  if (command === "build") {
    if (process.env.BB_COLLAB_RELEASE_PINNED === "1") buildRelease();
    else invokePinnedBuild();
    return;
  }
  if (command === "verify" && argument) {
    verifyRelease(resolve(argument), join(resolve(argument), manifestName));
    return;
  }
  throw new Error("usage: release-artifact.mjs [build | verify <release-directory>]");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main(process.argv.slice(2));

export { canonicalJson, manifestFor, pinnedToolchain, verifyRelease };
