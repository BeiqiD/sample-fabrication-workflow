import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAst } from "rolldown/parseAst";

const runtimeMarker = /react-flow__|xyflow|ReactFlow/;

export function staticImports(source) {
  return parseAst(source).body.flatMap((node) => (
    ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source
      ? [node.source.value] : []
  ));
}

function localFile(clientDirectory, importer, specifier) {
  assert(specifier.startsWith(".") || specifier.startsWith("/"), `Unexpected external static import: ${specifier}`);
  const pathname = specifier.split(/[?#]/)[0];
  const filename = pathname.startsWith("/")
    ? resolve(clientDirectory, `.${pathname}`)
    : resolve(dirname(importer), pathname);
  const within = relative(clientDirectory, filename);
  assert(!within.startsWith("..") && !isAbsolute(within), `Import escapes client assets: ${specifier}`);
  return filename;
}

export async function staticClosure(entries, readSource, resolveImport) {
  const visited = new Map();
  async function visit(filename) {
    if (visited.has(filename)) return;
    const source = await readSource(filename);
    visited.set(filename, source);
    for (const specifier of staticImports(source)) await visit(resolveImport(filename, specifier));
  }
  for (const filename of entries) await visit(filename);
  return visited;
}

export async function verifyProjectMapBundle(clientDirectory) {
  const assetsDirectory = resolve(clientDirectory, "assets");
  const filenames = await readdir(assetsDirectory);
  const mapChunks = filenames.filter((filename) => /^ProjectMapSurface-.*\.js$/.test(filename));
  assert.equal(mapChunks.length, 1, `Expected one lazy ProjectMapSurface chunk, found ${mapChunks.length}`);
  const html = await readFile(resolve(clientDirectory, "index.html"), "utf8");
  const entries = [];
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) ?? []) {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map((match) => [match[1], match[2]]));
    if (attributes.type === "module" && attributes.src) entries.push(attributes.src);
    if (attributes.rel === "modulepreload" && attributes.href) entries.push(attributes.href);
  }
  assert(entries.length > 0, "Client HTML has no module entry");
  const htmlPath = resolve(clientDirectory, "index.html");
  const load = (filename) => readFile(filename, "utf8");
  const importedFile = (importer, specifier) => localFile(clientDirectory, importer, specifier);
  const initial = await staticClosure(entries.map((entry) => importedFile(htmlPath, entry)), load, importedFile);
  const mapPath = resolve(assetsDirectory, mapChunks[0]);
  assert(!initial.has(mapPath), "ProjectMapSurface is statically reachable from the initial client entry");
  for (const [filename, source] of initial) {
    assert(!runtimeMarker.test(source), `React Flow leaked into the initial static dependency graph: ${relative(clientDirectory, filename)}`);
  }
  const map = await staticClosure([mapPath], load, importedFile);
  assert([...map.values()].some((source) => runtimeMarker.test(source)), "The lazy Map dependency graph does not contain React Flow");
  console.log(`Verified lazy React Flow ownership across ${initial.size} initial and ${map.size} Map chunks`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyProjectMapBundle(fileURLToPath(new URL("../dist/client/", import.meta.url)));
}
