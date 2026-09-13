import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAst } from "rolldown/parseAst";

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}

function dependencies(program, filename) {
  const result = [];
  const add = (source) => {
    assert(source?.type === "Literal" && typeof source.value === "string",
      `${filename}: shared dependencies must be string literals`);
    result.push(source.value);
  };
  walk(program, (node) => {
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)) {
      if (node.source) add(node.source);
    } else if (["ImportExpression", "TSImportType"].includes(node.type)) {
      add(node.source);
    } else if (node.type === "TSExternalModuleReference") {
      add(node.expression);
    } else if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require") {
      add(node.arguments[0]);
    }
  });
  return result;
}

async function sourceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = resolve(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Shared code cannot use a symlink: ${filename}`);
    if (entry.isDirectory()) result.push(...await sourceFiles(filename));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)) result.push(filename);
  }
  return result.sort();
}

export async function verifySharedBoundary(root = fileURLToPath(new URL("../", import.meta.url))) {
  const shared = resolve(root, "shared");
  const files = await sourceFiles(shared);
  const knownFiles = new Set(files);
  const location = (filename) => relative(shared, filename).split(sep);
  const canonical = (filename) => ["contracts", "domain"].includes(location(filename)[0]);
  assert(files.length > 0, "No shared source files were found");
  for (const filename of files) {
    const label = relative(root, filename);
    assert(filename.endsWith(".ts"), `${label}: shared production code must be TypeScript without JSX`);
    const source = await readFile(filename, "utf8");
    assert(!/^\s*\/\/\/\s*<reference\b/m.test(source), `${label}: shared code cannot add ambient reference directives`);
    const program = parseAst(source, { lang: "ts" }, filename);
    const parts = location(filename);
    if (!canonical(filename)) {
      assert(parts.length === 1 && program.body.length === 1 && program.body[0].type === "ExportAllDeclaration",
        `${label}: code outside canonical directories must be a compatibility re-export`);
    }
    for (const specifier of dependencies(program, label)) {
      assert(specifier.startsWith("."), `${label}: external shared dependency is forbidden: ${specifier}`);
      const target = resolve(dirname(filename), `${specifier}${extname(specifier) ? "" : ".ts"}`);
      assert(knownFiles.has(target) && canonical(target), `${label}: dependency must stay in shared/contracts or shared/domain: ${specifier}`);
      assert(parts[0] !== "domain" || location(target)[0] === "domain",
        `${label}: domain cannot depend on contracts: ${specifier}`);
    }
  }
  return files.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`Verified dependency ownership for ${await verifySharedBoundary()} shared source files`);
}
