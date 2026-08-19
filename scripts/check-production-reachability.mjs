import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceExtension = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const candidateExtension = /\.(?:cts|mts|ts|tsx)$/u;
const helperPath = /(?:^|\/)(?:test-support|testing)(?:[./]|$)|(?:^|\/)__fixtures__(?:\/|$)|\.fixture(?:\.[^.]+)?$/u;
const helperName = /test|fixture|mock|fake|stub|deterministic|seed/iu;
const testPath = /^(?:tests?\/|.*\/(?:tests?|__tests__)\/)|(?:^|\/)[^.]+\.test\.[^.]+$/u;
const symbolIds = new WeakMap();
let nextSymbolId = 1;

function slash(path) {
  return path.split("\\").join("/");
}

function relativePath(root, path) {
  return slash(relative(root, path));
}

function sourceFilesFromGit(root) {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\0")
      .filter((path) => path && sourceExtension.test(path) && existsSync(join(root, path)));
  } catch {
    return [];
  }
}

function sourceFilesFromTree(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (sourceExtension.test(entry)) files.push(relativePath(root, path));
    }
  };
  for (const entry of ["src", "tests", "scripts", "server.ts", "app.tsx"]) {
    const path = join(root, entry);
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) visit(path);
    else if (sourceExtension.test(path)) files.push(relativePath(root, path));
  }
  return files;
}

function discoverSourceFiles(root) {
  const files = sourceFilesFromGit(root);
  return files.length > 0 ? files : sourceFilesFromTree(root);
}

function compilerOptions(root) {
  const configPath = join(root, "tsconfig.json");
  if (!existsSync(configPath)) {
    return {
      allowJs: true,
      checkJs: false,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
    };
  }
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
  return {
    ...parsed.options,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
  };
}

function resolveAlias(checker, symbol) {
  let current = symbol;
  const seen = new Set();
  while (current && current.flags & ts.SymbolFlags.Alias && !seen.has(current)) {
    seen.add(current);
    const next = checker.getAliasedSymbol(current);
    if (!next || next === current) break;
    current = next;
  }
  return current ?? symbol;
}

function symbolKey(symbol) {
  if (!symbolIds.has(symbol)) symbolIds.set(symbol, nextSymbolId++);
  return `symbol:${symbolIds.get(symbol)}`;
}

function declarationFor(symbol) {
  return symbol.valueDeclaration ?? symbol.declarations?.[0] ?? null;
}

function valueExport(symbol) {
  return Boolean(symbol.flags & ts.SymbolFlags.Value);
}

function declarationName(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.name === node) {
    if (ts.isVariableDeclaration(parent)
      || ts.isFunctionDeclaration(parent)
      || ts.isClassDeclaration(parent)
      || ts.isInterfaceDeclaration(parent)
      || ts.isTypeAliasDeclaration(parent)
      || ts.isEnumDeclaration(parent)
      || ts.isModuleDeclaration(parent)
      || ts.isMethodDeclaration(parent)
      || ts.isPropertyDeclaration(parent)
      || ts.isGetAccessorDeclaration(parent)
      || ts.isSetAccessorDeclaration(parent)
      || ts.isParameter(parent)
      || ts.isBindingElement(parent)
      || ts.isTypeParameterDeclaration(parent)
      || ts.isEnumMember(parent)
      || ts.isPropertySignature(parent)
      || ts.isMethodSignature(parent)
      || ts.isFunctionExpression(parent)) return true;
  }
  if (ts.isImportSpecifier(parent)) return parent.propertyName === node;
  if (ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent)) return true;
  if (ts.isExportSpecifier(parent) || ts.isNamespaceExport(parent)) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  if (ts.isBreakStatement(parent) && parent.label === node) return true;
  if (ts.isContinueStatement(parent) && parent.label === node) return true;
  if (ts.isJsxAttribute(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  return false;
}

function isTestFile(path) {
  return testPath.test(path);
}

function helperConventionApplies(path, names) {
  return helperPath.test(path) && names.every((name) => helperName.test(name));
}

function manifestExportTargets(root, files) {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) return new Set();
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  const configured = [];
  const collect = (value) => {
    if (typeof value === "string") configured.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(manifest.exports);
  const tracked = new Set(files);
  const targets = new Set();
  for (const configuredPath of configured) {
    const clean = configuredPath.replace(/^\.\//u, "");
    const withoutDist = clean.replace(/^dist\//u, "");
    const stem = withoutDist.replace(/\.(?:cjs|js|mjs)$/u, "");
    const stems = [stem, `src/${stem}`];
    for (const candidate of [clean, withoutDist, ...stems.flatMap((item) => [`${item}.ts`, `${item}.tsx`, `${item}.mts`, `${item}.cts`])]) {
      if (tracked.has(candidate)) targets.add(candidate);
    }
  }
  return targets;
}

function sourceModuleSymbol(checker, importDeclaration) {
  const moduleSpecifier = importDeclaration.moduleSpecifier;
  if (!ts.isStringLiteral(moduleSpecifier)) return null;
  const symbol = checker.getSymbolAtLocation(moduleSpecifier);
  return symbol ? resolveAlias(checker, symbol) : null;
}

function dynamicAnalysis(program, checker, sourceSet, recordsByKey) {
  const dynamicKeys = new Set();
  const reasons = new Set();
  const namespaceSymbols = new Map();
  const registrySymbols = new Map();

  const capturedExports = (expression) => {
    const keys = new Set();
    ts.forEachChild(expression, function collect(node) {
      if (ts.isIdentifier(node) && !declarationName(node)) {
        const symbol = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
        if (symbol) {
          const key = symbolKey(resolveAlias(checker, symbol));
          if (recordsByKey.has(key)) keys.add(key);
        }
      }
      ts.forEachChild(node, collect);
    });
    return keys;
  };

  const symbolMembers = (expression) => {
    if (!ts.isIdentifier(expression)) return null;
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol) return null;
    const key = symbolKey(resolveAlias(checker, symbol));
    return registrySymbols.get(key) ?? namespaceSymbols.get(key) ?? null;
  };

  const markUnknown = (keys, reason) => {
    if (!keys) return false;
    keys.forEach((key) => dynamicKeys.add(key));
    reasons.add(reason);
    return true;
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceSet.has(sourceFile.fileName)) continue;
    ts.forEachChild(sourceFile, function collect(node) {
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) {
        const local = checker.getSymbolAtLocation(node.importClause.namedBindings.name);
        const moduleSymbol = sourceModuleSymbol(checker, node);
        if (local && moduleSymbol) {
          const exports = checker.getExportsOfModule(moduleSymbol);
          namespaceSymbols.set(symbolKey(resolveAlias(checker, local)), exports.map((item) => symbolKey(resolveAlias(checker, item))));
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        const local = checker.getSymbolAtLocation(node.name);
        const members = capturedExports(node.initializer);
        if (local && members.size > 0) registrySymbols.set(symbolKey(resolveAlias(checker, local)), members);
      }
      ts.forEachChild(node, collect);
    });
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceSet.has(sourceFile.fileName)) continue;
    ts.forEachChild(sourceFile, function inspect(node) {
      if (ts.isElementAccessExpression(node)) {
        const memberKeys = symbolMembers(node.expression);
        if (memberKeys) {
          markUnknown(memberKeys, "UNKNOWN: namespace, computed, or string-keyed access cannot prove a specific export");
        } else if (!node.argumentExpression || !ts.isStringLiteral(node.argumentExpression) && !ts.isNumericLiteral(node.argumentExpression)) {
          reasons.add("UNKNOWN: computed property access cannot prove a specific export");
        } else if (ts.isIdentifier(node.expression) && /registry|handler|dispatch|plugin|route|command|adapter/iu.test(node.expression.text)) {
          reasons.add("UNKNOWN: registry or string-keyed lookup is outside static export analysis");
        }
      }
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
          const owner = expression.expression.text;
          if ((owner === "Reflect" && expression.name.text === "get") || (owner === "Object" && /^(?:keys|values|entries)$/u.test(expression.name.text))) {
            const memberKeys = symbolMembers(node.arguments[0]);
            if (!markUnknown(memberKeys, "UNKNOWN: reflection or registry enumeration cannot prove a specific export")) {
              reasons.add("UNKNOWN: reflection or registry enumeration cannot prove a specific export");
            }
          }
        }
        if (expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && !ts.isStringLiteral(node.arguments[0])) {
          reasons.add("UNKNOWN: computed dynamic import cannot prove a specific export");
        }
      }
      ts.forEachChild(node, inspect);
    });
  }

  const dynamicRecords = [];
  for (const key of dynamicKeys) {
    const record = recordsByKey.get(key);
    if (record) dynamicRecords.push(record);
  }
  return { dynamicKeys, dynamicRecords, reasons: [...reasons].sort() };
}

function analyzeRepository(rootDirectory = scriptRoot, explicitFiles = null) {
  const root = resolve(rootDirectory);
  const relativeFiles = explicitFiles ?? discoverSourceFiles(root);
  const rootNames = relativeFiles.map((path) => join(root, path));
  const options = compilerOptions(root);
  const program = ts.createProgram({ rootNames, options });
  const checker = program.getTypeChecker();
  const sourceFiles = program.getSourceFiles().filter((sourceFile) => rootNames.includes(sourceFile.fileName));
  const sourceSet = new Set(sourceFiles.map((sourceFile) => sourceFile.fileName));
  const candidateFiles = sourceFiles.filter((sourceFile) => {
    const path = relativePath(root, sourceFile.fileName);
    return candidateExtension.test(path) && (path === "server.ts" || path.startsWith("src/"));
  });
  const exportRecords = new Map();
  let exportedDeclarations = 0;
  let typeOnlyDeclarations = 0;

  for (const sourceFile of candidateFiles) {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      exportedDeclarations += 1;
      const canonical = resolveAlias(checker, exported);
      const key = symbolKey(canonical);
      const path = relativePath(root, sourceFile.fileName);
      const declaration = declarationFor(canonical) ?? declarationFor(exported);
      let record = exportRecords.get(key);
      if (!record) {
        record = {
          declaration,
          exportNames: [],
          exportedFrom: new Set(),
          key,
          productionReferences: [],
          testReferences: [],
          typeOnly: !valueExport(canonical),
        };
        exportRecords.set(key, record);
      }
      if (!record.exportNames.includes(exported.name)) record.exportNames.push(exported.name);
      record.exportedFrom.add(path);
      if (!record.typeOnly && !valueExport(canonical)) record.typeOnly = true;
      if (!valueExport(canonical)) typeOnlyDeclarations += 1;
    }
  }

  for (const sourceFile of sourceFiles) {
    const path = relativePath(root, sourceFile.fileName);
    ts.forEachChild(sourceFile, function inspect(node) {
      if (ts.isIdentifier(node) && !declarationName(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol) {
          const record = exportRecords.get(symbolKey(resolveAlias(checker, symbol)));
          if (record) {
            const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            const reference = { file: path, line: location.line + 1, name: node.text };
            (isTestFile(path) ? record.testReferences : record.productionReferences).push(reference);
          }
        }
      }
      ts.forEachChild(node, inspect);
    });
  }

  const sourcePaths = new Set(relativeFiles);
  const manifestExports = manifestExportTargets(root, relativeFiles);
  const dynamic = dynamicAnalysis(program, checker, sourceSet, exportRecords);
  const findings = [];
  const unknown = { dynamic: dynamic.reasons, dynamicExports: [], external: [], typeOnly: [] };
  const exemptions = { helperConvention: [], packageEntrypoint: [] };
  const rows = [];

  for (const record of exportRecords.values()) {
    const declaration = record.declaration;
    const exportedFrom = [...record.exportedFrom].sort();
    const file = exportedFrom[0] ?? (declaration ? relativePath(root, declaration.getSourceFile().fileName) : "unknown");
    const position = declaration && sourcePaths.has(relativePath(root, declaration.getSourceFile().fileName))
      ? declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart())
      : { line: 0, character: 0 };
    const base = {
      file,
      line: position.line + 1,
      names: [...record.exportNames].sort(),
      productionReferenceCount: record.productionReferences.length,
      testReferenceCount: record.testReferences.length,
    };
    if (record.typeOnly) {
      unknown.typeOnly.push({ ...base, status: "UNKNOWN_TYPE_ONLY" });
      rows.push({ ...base, status: "UNKNOWN_TYPE_ONLY" });
      continue;
    }
    if (dynamic.dynamicKeys.has(record.key)) {
      unknown.dynamicExports.push({ ...base, status: "UNKNOWN_DYNAMIC" });
      rows.push({ ...base, status: "UNKNOWN_DYNAMIC" });
      continue;
    }
    if (exportedFrom.some((path) => manifestExports.has(path))) {
      unknown.external.push({ ...base, status: "UNKNOWN_EXTERNAL" });
      rows.push({ ...base, status: "UNKNOWN_EXTERNAL" });
      continue;
    }
    if (exportedFrom.includes("server.ts") && record.exportNames.includes("default")) {
      exemptions.packageEntrypoint.push(base);
      rows.push({ ...base, status: "EXEMPT_PACKAGE_ENTRYPOINT" });
      continue;
    }
    if (helperConventionApplies(file, record.exportNames)) {
      exemptions.helperConvention.push(base);
      rows.push({ ...base, status: "EXEMPT_TEST_HELPER_CONVENTION" });
      continue;
    }
    const status = record.productionReferences.length > 0
      ? "STATIC_PRODUCTION_REFERENCE"
      : record.testReferences.length > 0 ? "STATIC_TEST_ONLY" : "STATIC_UNREFERENCED";
    const row = {
      ...base,
      ...(status === "STATIC_TEST_ONLY"
        ? { productionReferences: record.productionReferences, testReferences: record.testReferences }
        : {}),
      status,
    };
    rows.push(row);
    if (status !== "STATIC_PRODUCTION_REFERENCE") findings.push(row);
  }

  return {
    command: "node scripts/check-production-reachability.mjs",
    mode: "report-only",
    unknownIsNotReachable: true,
    root,
    summary: {
      exportedDeclarations,
      findings: findings.length,
      helperConventionExemptions: exemptions.helperConvention.length,
      packageEntrypointExemptions: exemptions.packageEntrypoint.length,
      sourceModules: candidateFiles.length,
      typeOnlyUnknown: typeOnlyDeclarations,
      uniqueExportedSymbols: exportRecords.size,
    },
    findings,
    exemptions,
    unknown,
    rows,
  };
}

function cliRoot(argv) {
  const index = argv.indexOf("--root");
  return index >= 0 && argv[index + 1] ? argv[index + 1] : scriptRoot;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  console.log(JSON.stringify(analyzeRepository(cliRoot(process.argv.slice(2))), null, 2));
}

export { analyzeRepository };
