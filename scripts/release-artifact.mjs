import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDirectory = join(root, "release");
const manifestName = "release-manifest.json";
const deployedManifestName = ".bb-collab-release.json";
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

function packageRoots(directory = root) {
  return [directory, ...["plugins", "packages"].flatMap((parent) => {
    const parentPath = join(directory, parent);
    if (!existsSync(parentPath)) return [];
    return readdirSync(parentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(parentPath, entry.name, "package.json")))
      .map((entry) => join(parentPath, entry.name));
  })].filter((packageRoot) => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    return Boolean(manifest.scripts?.build);
  });
}

function artifactDirectories(directory = root) {
  return packageRoots(directory).map((packageRoot) => join(packageRoot, "dist"));
}

function artifactRelativeDirectories(sourceDirectory = root) {
  return artifactDirectories(sourceDirectory).map((dist) => relative(sourceDirectory, dist).split(sep).join("/"));
}

function filesBelow(directory, base = directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path, base) : [relative(base, path).split(sep).join("/")];
  });
}

function releaseFiles(directory, sourceDirectory = root) {
  return artifactRelativeDirectories(sourceDirectory).flatMap((dist) => filesBelow(join(directory, dist)).map((path) => `${dist}/${path}`))
    .filter((path) => !path.endsWith(".map") && path !== manifestName && !path.endsWith(`/${manifestName}`))
    .sort();
}

function sourceCommit(directory = root) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
}

function manifestFor(directory, commit = sourceCommit(root)) {
  const files = releaseFiles(directory).map((path) => ({ path, sha256: sha256(readFileSync(join(directory, path))) }));
  const releaseDigest = sha256(canonicalJson({ files, sourceCommit: commit, toolchain: pinnedToolchain, version: 1 }));
  return { version: 1, sourceCommit: commit, toolchain: pinnedToolchain, files, releaseDigest };
}

function assertManifestShape(manifest) {
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (manifest.version !== 1 || !/^[0-9a-f]{40}$/u.test(manifest.sourceCommit ?? "")) throw new Error("invalid release manifest identity");
  if (canonicalJson(manifest.toolchain) !== canonicalJson(pinnedToolchain)) throw new Error("release manifest does not name the pinned toolchain");
  if (files.length === 0 || files.some(({ path, sha256: digest }) => typeof path !== "string" || path.startsWith("/") || path.includes("..") || !/^[0-9a-f]{64}$/u.test(digest ?? ""))) {
    throw new Error("invalid release manifest files");
  }
  const paths = files.map(({ path }) => path);
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1] > path)) throw new Error("release manifest files must be unique and sorted");
  const expectedDigest = sha256(canonicalJson({ files, sourceCommit: manifest.sourceCommit, toolchain: manifest.toolchain, version: manifest.version }));
  if (manifest.releaseDigest !== expectedDigest) throw new Error("release manifest digest does not match its contents");
}

function verifyRelease(directory, manifestPath, sourceDirectory = root) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assertManifestShape(manifest);
  const commit = sourceCommit(sourceDirectory);
  if (manifest.sourceCommit !== commit) throw new Error(`release source ${manifest.sourceCommit} does not match deployed commit ${commit}`);
  const expected = manifest.files.map(({ path }) => path);
  const actual = releaseFiles(directory, sourceDirectory);
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
  for (const packageRoot of packageRoots()) execFileSync("npm", ["run", "build", "--silent"], { cwd: packageRoot, stdio: "inherit" });
  for (const path of releaseFiles(root).filter((path) => path.endsWith(".meta.json"))) {
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
  for (const path of releaseFiles(root)) {
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

function installRelease(directory) {
  const source = resolve(directory);
  const manifestPath = join(source, manifestName);
  verifyRelease(source, manifestPath);
  for (const dist of artifactDirectories()) {
    const path = relative(root, dist);
    rmSync(dist, { recursive: true, force: true });
    cpSync(join(source, path), dist, { recursive: true });
  }
  cpSync(manifestPath, join(root, deployedManifestName));
  const manifest = verifyRelease(root, join(root, deployedManifestName));
  console.log(`installed release ${manifest.releaseDigest}`);
}

function main(argv) {
  const [command = "build", argument] = argv;
  if (command === "build") {
    if (process.env.BB_COLLAB_RELEASE_PINNED === "1") buildRelease();
    else invokePinnedBuild();
    return;
  }
  if ((command === "verify" || command === "install") && argument) {
    if (command === "verify") verifyRelease(resolve(argument), join(resolve(argument), manifestName));
    else installRelease(argument);
    return;
  }
  throw new Error("usage: release-artifact.mjs [build | verify <release-directory> | install <release-directory>]");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main(process.argv.slice(2));

export { canonicalJson, manifestFor, pinnedToolchain, verifyRelease };
